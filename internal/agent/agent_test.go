package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceName(t *testing.T) {
	tests := []struct {
		repoSlug string
		worktree string
		want     string
	}{
		{"garden", "/path/to/ticket-47", "garden-47"},
		{"drum-trainer", "/some/dir/ticket-23", "drum-trainer-23"},
		{"myapp", "/ticket-1", "myapp-1"},
		{"proj", "/worktrees/ticket-abc", "proj-abc"},
	}
	for _, tc := range tests {
		got := WorkspaceName(tc.repoSlug, tc.worktree)
		if got != tc.want {
			t.Errorf("WorkspaceName(%q, %q) = %q, want %q", tc.repoSlug, tc.worktree, got, tc.want)
		}
	}
}

func TestExtractClosesRef(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "TICKET.md")

	t.Run("with github issue link", func(t *testing.T) {
		content := "# Ticket\nGitHub Issue: #42\nSome content"
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		got := ExtractClosesRef(path)
		if got != "Closes #42" {
			t.Errorf("got %q, want %q", got, "Closes #42")
		}
	})

	t.Run("without github issue link", func(t *testing.T) {
		content := "# Ticket\nNo issue link here."
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		got := ExtractClosesRef(path)
		if got != "" {
			t.Errorf("got %q, want empty string", got)
		}
	})

	t.Run("missing file", func(t *testing.T) {
		got := ExtractClosesRef("/nonexistent/TICKET.md")
		if got != "" {
			t.Errorf("got %q, want empty string", got)
		}
	})
}
