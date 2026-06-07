package cmd

import "testing"

func TestResolveWorkspaceName(t *testing.T) {
	tests := []struct {
		repoPath   string
		repoSlug   string
		ticketID   string
		want       string
	}{
		{"/Users/kyle/garden", "garden", "47", "garden-47"},
		{"/Users/kyle/drum-trainer", "", "23", "drum-trainer-23"},
		{"/Users/kyle/myapp", "custom-slug", "5", "custom-slug-5"},
		{"/projects/foo-bar", "", "99", "foo-bar-99"},
	}
	for _, tc := range tests {
		got := resolveWorkspaceName(tc.repoPath, tc.repoSlug, tc.ticketID)
		if got != tc.want {
			t.Errorf("resolveWorkspaceName(%q, %q, %q) = %q, want %q",
				tc.repoPath, tc.repoSlug, tc.ticketID, got, tc.want)
		}
	}
}

func TestFindFreePort(t *testing.T) {
	t.Run("picks first available port when none in use", func(t *testing.T) {
		sessions := devSessions{}
		// Port 0 is always available for binding on most systems.
		// Use a high port range unlikely to be in use.
		port, err := findFreePort(sessions, 19000)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if port < 19000 {
			t.Errorf("port %d is below range min 19000", port)
		}
	})

	t.Run("skips ports already in state file", func(t *testing.T) {
		sessions := devSessions{
			"ws-1": {PID: 1, Port: 19000, TicketID: "1"},
			"ws-2": {PID: 2, Port: 19001, TicketID: "2"},
		}
		port, err := findFreePort(sessions, 19000)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if port == 19000 || port == 19001 {
			t.Errorf("port %d should have been skipped (already in state file)", port)
		}
		if port < 19000 {
			t.Errorf("port %d is below range min 19000", port)
		}
	})
}
