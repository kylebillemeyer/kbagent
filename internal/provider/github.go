package provider

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/kylebillemeyer/kbagent/internal/config"
)

type githubProvider struct {
	cfg   *config.Config
	repo  string
	token string
}

func newGitHub(cfg *config.Config) *githubProvider {
	return &githubProvider{cfg: cfg}
}

func (p *githubProvider) CheckDeps() error {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		var err error
		token, err = keychainGet(p.cfg.Daemon.KeychainService, "GITHUB_TOKEN")
		if err != nil || token == "" {
			return fmt.Errorf("GITHUB_TOKEN not found in environment or Keychain (service=%s)\nStore it with: security add-generic-password -a GITHUB_TOKEN -s %s -w <token>",
				p.cfg.Daemon.KeychainService, p.cfg.Daemon.KeychainService)
		}
	}
	p.token = token

	repo := p.cfg.Provider.GitHub.Repo
	if repo == "" {
		out, err := exec.Command("gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").Output()
		if err != nil {
			return fmt.Errorf("detect GitHub repo (run from inside the repo or set provider.github.repo in config): %w", err)
		}
		repo = strings.TrimSpace(string(out))
	}
	p.repo = repo
	return nil
}

func (p *githubProvider) FindNext(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "gh", "issue", "list",
		"--repo", p.repo,
		"--label", "spec-approved",
		"--state", "open",
		"--json", "number,createdAt,labels",
		"--jq", `
[ .[] |
  . as $i | ($i.labels | map(.name)) as $l |
  if ($l | contains(["p4"])) then empty
  else . + { score: (
    if   ($l | contains(["p0"])) then 0
    elif ($l | contains(["p1"])) then 1
    elif ($l | contains(["p3"])) then 3
    else 2 end
  )} end
] | sort_by([.score, .createdAt]) | first | .number // empty
`,
	).Output()
	if err != nil {
		return "", nil
	}
	return strings.TrimSpace(string(out)), nil
}

func (p *githubProvider) FindResumable(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "gh", "issue", "list",
		"--repo", p.repo,
		"--label", "needs-input",
		"--state", "open",
		"--json", "number",
		"-q", ".[].number",
	).Output()
	if err != nil {
		return "", nil
	}

	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		num := strings.TrimSpace(scanner.Text())
		if num == "" {
			continue
		}
		countOut, err := exec.CommandContext(ctx, "gh", "api",
			fmt.Sprintf("repos/%s/issues/%s/comments", p.repo, num),
			"--jq", "length",
		).Output()
		if err != nil {
			continue
		}
		count, err := strconv.Atoi(strings.TrimSpace(string(countOut)))
		if err != nil {
			continue
		}
		if count >= 2 {
			return num, nil
		}
	}
	return "", nil
}

func (p *githubProvider) FetchTicket(ctx context.Context, id, worktree, mode string) error {
	out, err := exec.CommandContext(ctx, "gh", "issue", "view", id,
		"--repo", p.repo,
		"--json", "title,body,number,labels",
		"--jq", `"# " + .title + "\nGitHub Issue: #" + (.number|tostring) + "\nLabels: " + (.labels | map(.name) | join(", ")) + "\n\n" + .body`,
	).Output()
	if err != nil {
		return fmt.Errorf("gh issue view %s: %w", id, err)
	}

	content := string(out)

	if mode == "needs-input" {
		commentsOut, err := exec.CommandContext(ctx, "gh", "api",
			fmt.Sprintf("repos/%s/issues/%s/comments", p.repo, id),
			"--jq", `.[] | "**@" + .user.login + ":** " + .body + "\n"`,
		).Output()
		if err == nil {
			content += "\n\n---\n## Human replies\n" + string(commentsOut)
		}
	}

	return os.WriteFile(worktree+"/TICKET.md", []byte(content), 0644)
}

func (p *githubProvider) MarkInProgress(ctx context.Context, id string) error {
	return exec.CommandContext(ctx, "gh", "issue", "edit", id,
		"--repo", p.repo,
		"--add-label", "in-progress",
		"--remove-label", "spec-approved",
		"--remove-label", "needs-input",
	).Run()
}

func (p *githubProvider) MarkNeedsInput(ctx context.Context, id, comment string) error {
	if comment != "" {
		_ = exec.CommandContext(ctx, "gh", "issue", "comment", id,
			"--repo", p.repo,
			"--body", comment,
		).Run()
	}
	return exec.CommandContext(ctx, "gh", "issue", "edit", id,
		"--repo", p.repo,
		"--add-label", "needs-input",
		"--remove-label", "in-progress",
	).Run()
}

func (p *githubProvider) MarkNeedsReview(ctx context.Context, id string) error {
	return exec.CommandContext(ctx, "gh", "issue", "edit", id,
		"--repo", p.repo,
		"--add-label", "needs-review",
		"--remove-label", "in-progress",
	).Run()
}

func (p *githubProvider) MarkSpecApproved(ctx context.Context, id string) error {
	return exec.CommandContext(ctx, "gh", "issue", "edit", id,
		"--repo", p.repo,
		"--add-label", "spec-approved",
		"--remove-label", "in-progress",
		"--remove-label", "needs-input",
	).Run()
}

func (p *githubProvider) IsComplete(ctx context.Context, id string) (bool, error) {
	out, err := exec.CommandContext(ctx, "gh", "issue", "view", id,
		"--repo", p.repo,
		"--json", "labels",
		"--jq", `.labels | map(.name) | contains(["needs-review"])`,
	).Output()
	if err != nil {
		return false, nil
	}
	return strings.TrimSpace(string(out)) == "true", nil
}

func (p *githubProvider) WorktreeName(_ context.Context, id string) (string, error) {
	return id, nil
}

// Repo returns the detected owner/repo string (used by daemon for logging).
func (p *githubProvider) Repo() string { return p.repo }
