package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/kylebillemeyer/kbagent/internal/config"
	"github.com/spf13/cobra"
)

type devSession struct {
	PID      int    `json:"pid"`
	Port     int    `json:"port"`
	TicketID string `json:"ticket_id"`
}

// devSessions maps workspace name → session info.
type devSessions map[string]devSession

func stateFilePath() string {
	return filepath.Join(os.Getenv("HOME"), ".kbagent", "dev-sessions.json")
}

// withLockedStateFile takes an exclusive lock on the state file, decodes the
// current sessions, calls fn with the decoded map, then writes the result back.
func withLockedStateFile(fn func(devSessions) (devSessions, error)) error {
	path := stateFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock state file: %w", err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:errcheck

	var sessions devSessions
	if decErr := json.NewDecoder(f).Decode(&sessions); decErr != nil && !errors.Is(decErr, io.EOF) {
		return fmt.Errorf("decode state file: %w", decErr)
	}
	if sessions == nil {
		sessions = make(devSessions)
	}

	updated, err := fn(sessions)
	if err != nil {
		return err
	}

	if err := f.Truncate(0); err != nil {
		return err
	}
	if _, err := f.Seek(0, 0); err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(updated)
}

// readSessions reads the state file without locking (display-only).
func readSessions() (devSessions, error) {
	data, err := os.ReadFile(stateFilePath())
	if os.IsNotExist(err) {
		return make(devSessions), nil
	}
	if err != nil {
		return nil, err
	}
	var sessions devSessions
	if err := json.Unmarshal(data, &sessions); err != nil {
		return nil, err
	}
	if sessions == nil {
		return make(devSessions), nil
	}
	return sessions, nil
}

// isPortAvailable reports whether a TCP port is free on the host.
func isPortAvailable(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// findFreePort returns the lowest port >= portRangeMin that is neither
// recorded in the state file nor already bound on the host.
func findFreePort(sessions devSessions, portRangeMin int) (int, error) {
	used := make(map[int]bool)
	for _, s := range sessions {
		used[s.Port] = true
	}
	for port := portRangeMin; port < portRangeMin+1000; port++ {
		if !used[port] && isPortAvailable(port) {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free port found in range starting at %d", portRangeMin)
}

// devpodWorkspaceExists checks whether a workspace is known to devpod.
func devpodWorkspaceExists(name string) bool {
	out, err := exec.Command("devpod", "list", "--output", "plain").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, name) {
			return true
		}
	}
	return false
}

// killPID sends SIGTERM to pid and waits up to 2 seconds; then sends SIGKILL.
// Errors (process already dead, no permission) are silently ignored.
func killPID(pid int) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return
	}
	for i := 0; i < 20; i++ {
		time.Sleep(100 * time.Millisecond)
		if proc.Signal(syscall.Signal(0)) != nil {
			return // process exited
		}
	}
	proc.Kill() //nolint:errcheck
}

// resolveWorkspaceName returns the DevPod workspace name given repo config and a ticket ID.
func resolveWorkspaceName(repoPath, repoSlug, ticketID string) string {
	slug := repoSlug
	if slug == "" {
		slug = filepath.Base(repoPath)
	}
	return slug + "-" + ticketID
}

var devCmd = &cobra.Command{
	Use:          "dev <ticket-id>",
	Short:        "Start an SSH tunnel to a ticket's DevPod workspace",
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) < 1 {
			return cmd.Help()
		}
		ticketID := args[0]

		cfg, err := config.Load(cfgFile)
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}

		wsName := resolveWorkspaceName(cfg.Daemon.RepoPath, cfg.Daemon.RepoSlug, ticketID)
		worktreePath := filepath.Join(cfg.Daemon.WorktreesDir, "ticket-"+ticketID)

		if !devpodWorkspaceExists(wsName) {
			fmt.Printf("Provisioning workspace %s...\n", wsName)
			up := exec.Command("devpod", "up", worktreePath, "--id", wsName, "--provider", "docker")
			up.Stdout = os.Stdout
			up.Stderr = os.Stderr
			if err := up.Run(); err != nil {
				return fmt.Errorf("devpod up: %w", err)
			}
		}

		var port int
		err = withLockedStateFile(func(sessions devSessions) (devSessions, error) {
			p, err := findFreePort(sessions, cfg.Dev.PortRangeMin)
			if err != nil {
				return nil, err
			}
			port = p

			tunnel := exec.Command("devpod", "ssh",
				"--forward", fmt.Sprintf("%d:%d", port, cfg.Dev.AppPort),
				wsName,
			)
			tunnel.Stdout = io.Discard
			tunnel.Stderr = io.Discard
			if err := tunnel.Start(); err != nil {
				return nil, fmt.Errorf("start SSH tunnel: %w", err)
			}

			sessions[wsName] = devSession{
				PID:      tunnel.Process.Pid,
				Port:     port,
				TicketID: ticketID,
			}
			return sessions, nil
		})
		if err != nil {
			return err
		}

		fmt.Printf("%s  →  http://localhost:%d\n", wsName, port)
		fmt.Printf("Stop:  kbagent dev stop %s\n", ticketID)
		return nil
	},
}

var devStopCmd = &cobra.Command{
	Use:          "stop <ticket-id>",
	Short:        "Stop a dev session SSH tunnel",
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) < 1 {
			return fmt.Errorf("ticket-id required")
		}
		ticketID := args[0]

		cfg, err := config.Load(cfgFile)
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}

		wsName := resolveWorkspaceName(cfg.Daemon.RepoPath, cfg.Daemon.RepoSlug, ticketID)

		return withLockedStateFile(func(sessions devSessions) (devSessions, error) {
			s, ok := sessions[wsName]
			if !ok {
				fmt.Fprintf(os.Stderr, "no active dev session for %s\n", wsName)
				return sessions, nil
			}

			killPID(s.PID)

			stop := exec.Command("devpod", "stop", wsName)
			stop.Stdout = os.Stdout
			stop.Stderr = os.Stderr
			if err := stop.Run(); err != nil {
				fmt.Fprintf(os.Stderr, "WARN: devpod stop %s: %v\n", wsName, err)
			}

			delete(sessions, wsName)
			return sessions, nil
		})
	},
}

var devListCmd = &cobra.Command{
	Use:          "list",
	Short:        "List active dev sessions",
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		sessions, err := readSessions()
		if err != nil {
			return err
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "TICKET\tWORKSPACE\tPORT\tURL\tSTATUS")
		for wsName, s := range sessions {
			status := "running"
			proc, _ := os.FindProcess(s.PID)
			if proc == nil || proc.Signal(syscall.Signal(0)) != nil {
				status = "stale"
			}
			fmt.Fprintf(w, "%s\t%s\t%d\thttp://localhost:%d\t%s\n",
				s.TicketID, wsName, s.Port, s.Port, status)
		}
		return w.Flush()
	},
}

func init() {
	devCmd.AddCommand(devStopCmd)
	devCmd.AddCommand(devListCmd)
	rootCmd.AddCommand(devCmd)
}
