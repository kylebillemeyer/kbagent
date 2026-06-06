package provider

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/kylebillemeyer/kbagent/internal/config"
)

// Provider abstracts the ticket system (GitHub Issues or Plane).
// The daemon calls these methods; the agent never touches the ticket system directly.
type Provider interface {
	// CheckDeps resolves credentials and validates connectivity.
	CheckDeps() error
	// FindNext returns the highest-priority spec-approved ticket ID, or "" if none.
	FindNext(ctx context.Context) (string, error)
	// FindResumable returns a needs-input ticket that has a human reply, or "".
	FindResumable(ctx context.Context) (string, error)
	// FetchTicket writes TICKET.md into the worktree. mode is "fresh" or "needs-input".
	FetchTicket(ctx context.Context, id, worktree, mode string) error
	// MarkInProgress transitions the ticket to in-progress, removing spec-approved/needs-input.
	MarkInProgress(ctx context.Context, id string) error
	// MarkNeedsInput blocks the ticket and posts comment as the blocker explanation.
	MarkNeedsInput(ctx context.Context, id, comment string) error
	// MarkNeedsReview transitions the ticket to the review state.
	MarkNeedsReview(ctx context.Context, id string) error
	// MarkSpecApproved resets the ticket to the spec-approved/backlog state for a new session.
	MarkSpecApproved(ctx context.Context, id string) error
	// IsComplete reports whether the ticket is in the final done/review state.
	IsComplete(ctx context.Context, id string) (bool, error)
	// WorktreeName returns the string used for the worktree directory name (e.g. issue number or sequence id).
	WorktreeName(ctx context.Context, id string) (string, error)
}

func New(cfg *config.Config) (Provider, error) {
	switch cfg.Daemon.TicketProvider {
	case "github":
		return newGitHub(cfg), nil
	case "plane":
		return newPlane(cfg), nil
	default:
		return nil, fmt.Errorf("unknown ticket provider %q", cfg.Daemon.TicketProvider)
	}
}

// keychainGet reads a password from the macOS Keychain.
func keychainGet(service, account string) (string, error) {
	out, err := exec.Command("security", "find-generic-password",
		"-a", account, "-s", service, "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

func removeAll(slice []string, targets ...string) []string {
	rm := make(map[string]bool, len(targets))
	for _, t := range targets {
		rm[t] = true
	}
	out := slice[:0:0]
	for _, v := range slice {
		if !rm[v] {
			out = append(out, v)
		}
	}
	return out
}

func appendIfMissing(slice []string, s string) []string {
	if contains(slice, s) {
		return slice
	}
	return append(slice, s)
}
