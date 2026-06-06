package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/kylebillemeyer/kbagent/internal/config"
)

type planeProvider struct {
	cfg    *config.Config
	apiKey string
	client *http.Client
}

func newPlane(cfg *config.Config) *planeProvider {
	return &planeProvider{cfg: cfg, client: &http.Client{}}
}

func (p *planeProvider) CheckDeps() error {
	apiKey := os.Getenv("PLANE_API_KEY")
	if apiKey == "" {
		var err error
		apiKey, err = keychainGet(p.cfg.Daemon.KeychainService, "PLANE_API_KEY")
		if err != nil || apiKey == "" {
			return fmt.Errorf("PLANE_API_KEY not found in environment or Keychain (service=%s)\nStore it with: security add-generic-password -a PLANE_API_KEY -s %s -w <key>",
				p.cfg.Daemon.KeychainService, p.cfg.Daemon.KeychainService)
		}
	}
	p.apiKey = apiKey
	return nil
}

type planeIssue struct {
	ID          string   `json:"id"`
	SequenceID  int      `json:"sequence_id"`
	Name        string   `json:"name"`
	Description string   `json:"description_stripped"`
	Priority    string   `json:"priority"`
	State       string   `json:"state"`
	LabelIDs    []string `json:"label_ids"`
	CreatedAt   string   `json:"created_at"`
	ExternalID  string   `json:"external_id"`
}

type planeListResponse struct {
	Results []planeIssue `json:"results"`
}

func (p *planeProvider) apiRequest(ctx context.Context, method, path string, body any) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(data)
	}

	pc := p.cfg.Provider.Plane
	url := fmt.Sprintf("%s/api/v1/workspaces/%s%s", pc.BaseURL, pc.WorkspaceSlug, path)
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", p.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (p *planeProvider) getIssue(ctx context.Context, id string) (*planeIssue, error) {
	data, err := p.apiRequest(ctx, "GET", fmt.Sprintf("/projects/%s/issues/%s/", p.cfg.Provider.Plane.ProjectID, id), nil)
	if err != nil {
		return nil, err
	}
	var issue planeIssue
	if err := json.Unmarshal(data, &issue); err != nil {
		return nil, err
	}
	return &issue, nil
}

func (p *planeProvider) listIssues(ctx context.Context) ([]planeIssue, error) {
	data, err := p.apiRequest(ctx, "GET", fmt.Sprintf("/projects/%s/issues/?per_page=100", p.cfg.Provider.Plane.ProjectID), nil)
	if err != nil {
		return nil, err
	}
	var resp planeListResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, err
	}
	return resp.Results, nil
}

func (p *planeProvider) patchIssue(ctx context.Context, id string, patch map[string]any) error {
	_, err := p.apiRequest(ctx, "PATCH", fmt.Sprintf("/projects/%s/issues/%s/", p.cfg.Provider.Plane.ProjectID, id), patch)
	return err
}

func (p *planeProvider) currentLabels(ctx context.Context, id string) ([]string, error) {
	issue, err := p.getIssue(ctx, id)
	if err != nil {
		return nil, err
	}
	return issue.LabelIDs, nil
}

func (p *planeProvider) FindNext(ctx context.Context) (string, error) {
	issues, err := p.listIssues(ctx)
	if err != nil {
		return "", err
	}

	priorityOrder := map[string]int{"urgent": 0, "high": 1, "medium": 2, "low": 3}
	specApproved := p.cfg.Provider.Plane.LabelSpecApproved

	var eligible []planeIssue
	for _, issue := range issues {
		if contains(issue.LabelIDs, specApproved) {
			if _, ok := priorityOrder[issue.Priority]; ok {
				eligible = append(eligible, issue)
			}
		}
	}
	if len(eligible) == 0 {
		return "", nil
	}

	sort.Slice(eligible, func(i, j int) bool {
		pi := priorityOrder[eligible[i].Priority]
		pj := priorityOrder[eligible[j].Priority]
		if pi != pj {
			return pi < pj
		}
		return eligible[i].CreatedAt < eligible[j].CreatedAt
	})

	return eligible[0].ID, nil
}

func (p *planeProvider) FindResumable(ctx context.Context) (string, error) {
	issues, err := p.listIssues(ctx)
	if err != nil {
		return "", err
	}

	needsInput := p.cfg.Provider.Plane.LabelNeedsInput
	for _, issue := range issues {
		if !contains(issue.LabelIDs, needsInput) {
			continue
		}
		data, err := p.apiRequest(ctx, "GET",
			fmt.Sprintf("/projects/%s/issues/%s/comments/?per_page=50", p.cfg.Provider.Plane.ProjectID, issue.ID), nil)
		if err != nil {
			continue
		}
		var resp struct {
			Results []json.RawMessage `json:"results"`
		}
		if err := json.Unmarshal(data, &resp); err != nil {
			continue
		}
		if len(resp.Results) >= 2 {
			return issue.ID, nil
		}
	}
	return "", nil
}

func (p *planeProvider) FetchTicket(ctx context.Context, id, worktree, mode string) error {
	issue, err := p.getIssue(ctx, id)
	if err != nil {
		return err
	}

	var sb strings.Builder
	sb.WriteString("# " + issue.Name + "\n")
	sb.WriteString(fmt.Sprintf("Ticket ID: %s\n", issue.ID))
	sb.WriteString(fmt.Sprintf("Sequence: #%d\n", issue.SequenceID))
	if issue.ExternalID != "" {
		sb.WriteString(fmt.Sprintf("GitHub Issue: #%s\n", issue.ExternalID))
	}
	sb.WriteString("Priority: " + issue.Priority + "\n\n")
	if issue.Description != "" {
		sb.WriteString(issue.Description)
	} else {
		sb.WriteString("(no description)")
	}

	if mode == "needs-input" {
		sb.WriteString("\n\n---\n## Human replies\n")
		data, err := p.apiRequest(ctx, "GET",
			fmt.Sprintf("/projects/%s/issues/%s/comments/?per_page=50", p.cfg.Provider.Plane.ProjectID, id), nil)
		if err == nil {
			var resp struct {
				Results []struct {
					CommentStripped string `json:"comment_stripped"`
				} `json:"results"`
			}
			if json.Unmarshal(data, &resp) == nil {
				for _, c := range resp.Results {
					sb.WriteString(c.CommentStripped + "\n\n")
				}
			}
		}
	}

	return os.WriteFile(worktree+"/TICKET.md", []byte(sb.String()), 0644)
}

func (p *planeProvider) MarkInProgress(ctx context.Context, id string) error {
	labels, err := p.currentLabels(ctx, id)
	if err != nil {
		return err
	}
	pc := p.cfg.Provider.Plane
	labels = removeAll(labels, pc.LabelSpecApproved, pc.LabelNeedsInput)
	return p.patchIssue(ctx, id, map[string]any{
		"state":     pc.StateInProgress,
		"label_ids": labels,
	})
}

func (p *planeProvider) MarkNeedsInput(ctx context.Context, id, comment string) error {
	if comment != "" {
		_, _ = p.apiRequest(ctx, "POST",
			fmt.Sprintf("/projects/%s/issues/%s/comments/", p.cfg.Provider.Plane.ProjectID, id),
			map[string]any{"comment_html": "<p>" + comment + "</p>"})
	}
	labels, err := p.currentLabels(ctx, id)
	if err != nil {
		return err
	}
	pc := p.cfg.Provider.Plane
	labels = appendIfMissing(labels, pc.LabelNeedsInput)
	return p.patchIssue(ctx, id, map[string]any{
		"state":     pc.StateBacklog,
		"label_ids": labels,
	})
}

func (p *planeProvider) MarkNeedsReview(ctx context.Context, id string) error {
	labels, err := p.currentLabels(ctx, id)
	if err != nil {
		return err
	}
	return p.patchIssue(ctx, id, map[string]any{
		"state":     p.cfg.Provider.Plane.StateInReview,
		"label_ids": labels,
	})
}

func (p *planeProvider) MarkSpecApproved(ctx context.Context, id string) error {
	labels, err := p.currentLabels(ctx, id)
	if err != nil {
		return err
	}
	pc := p.cfg.Provider.Plane
	labels = removeAll(labels, pc.LabelNeedsInput)
	labels = appendIfMissing(labels, pc.LabelSpecApproved)
	return p.patchIssue(ctx, id, map[string]any{
		"state":     pc.StateBacklog,
		"label_ids": labels,
	})
}

func (p *planeProvider) IsComplete(ctx context.Context, id string) (bool, error) {
	issue, err := p.getIssue(ctx, id)
	if err != nil {
		return false, err
	}
	return issue.State == p.cfg.Provider.Plane.StateInReview, nil
}

func (p *planeProvider) WorktreeName(ctx context.Context, id string) (string, error) {
	issue, err := p.getIssue(ctx, id)
	if err != nil {
		return id, nil
	}
	if issue.SequenceID > 0 {
		return fmt.Sprintf("%d", issue.SequenceID), nil
	}
	return id, nil
}
