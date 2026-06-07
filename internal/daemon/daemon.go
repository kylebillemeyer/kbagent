package daemon

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/kylebillemeyer/kbagent/internal/agent"
	"github.com/kylebillemeyer/kbagent/internal/config"
	"github.com/kylebillemeyer/kbagent/internal/provider"
)

type logger struct {
	w io.Writer
}

func (l *logger) logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	line := "[" + time.Now().Format("2006-01-02 15:04:05") + "] " + msg + "\n"
	fmt.Fprint(l.w, line)
}

func Run(ctx context.Context, cfg *config.Config, p provider.Provider) error {
	logFile, err := openLog(cfg.Daemon.LogFile)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer logFile.Close()

	log := &logger{w: io.MultiWriter(os.Stdout, logFile)}

	githubToken, err := resolveSecret(cfg, "GITHUB_TOKEN")
	if err != nil {
		return err
	}
	claudeToken, err := resolveSecret(cfg, "CLAUDE_CODE_OAUTH_TOKEN")
	if err != nil {
		return err
	}

	log.logf("daemon started — provider: %s", cfg.Daemon.TicketProvider)

	inv := &agent.Invoker{
		RepoSlug:         resolveRepoSlug(cfg.Daemon.RepoPath, cfg.Daemon.RepoSlug),
		GitHubToken:      githubToken,
		ClaudeOAuthToken: claudeToken,
		MaxTurns:         cfg.Daemon.MaxTurns,
		ValidateCmd:      cfg.Daemon.ValidateCmd,
		Log:              logFile,
	}

	for {
		ticketID, needsInput, err := pickTicket(ctx, p)
		if err != nil {
			log.logf("ERROR: pick ticket: %v", err)
			time.Sleep(time.Duration(cfg.Daemon.SleepError) * time.Second)
			continue
		}
		if ticketID == "" {
			log.logf("queue empty — sleeping %ds", cfg.Daemon.SleepNoWork)
			time.Sleep(time.Duration(cfg.Daemon.SleepNoWork) * time.Second)
			continue
		}

		if needsInput {
			log.logf("resuming ticket %s (human replied to needs-input)", ticketID)
		} else {
			log.logf("picked up ticket %s", ticketID)
		}

		processTicket(ctx, cfg, p, inv, log, ticketID, needsInput)
	}
}

func processTicket(ctx context.Context, cfg *config.Config, p provider.Provider, inv *agent.Invoker, log *logger, ticketID string, needsInput bool) {
	worktree, err := setupWorktree(ctx, cfg, log, p, ticketID)
	if err != nil {
		log.logf("ERROR: setup worktree for %s: %v", ticketID, err)
		time.Sleep(time.Duration(cfg.Daemon.SleepError) * time.Second)
		return
	}
	defer cleanupWorktree(ctx, cfg, log, p, ticketID, worktree)

	mode := "fresh"
	if needsInput {
		mode = "needs-input"
	} else if fileExists(worktree + "/AGENT_PLAN.md") {
		mode = "continuing"
	}

	if err := p.MarkInProgress(ctx, ticketID); err != nil {
		log.logf("WARN: mark in-progress %s: %v", ticketID, err)
	}
	if err := p.FetchTicket(ctx, ticketID, worktree, mode); err != nil {
		log.logf("ERROR: fetch ticket %s: %v", ticketID, err)
		time.Sleep(time.Duration(cfg.Daemon.SleepError) * time.Second)
		return
	}
	_ = os.Remove(worktree + "/AGENT_STATUS.md")

	closesRef := agent.ExtractClosesRef(worktree + "/TICKET.md")
	log.logf("invoking agent — ticket: %s, mode: %s", ticketID, mode)

	output, runErr := inv.InvokeClaude(worktree, mode, closesRef)

	switch {
	case strings.Contains(strings.ToLower(output), "session limit"):
		d := parseRateLimitSleep(output)
		log.logf("rate limit hit — sleeping %.0fs", d.Seconds())
		time.Sleep(d)

	case strings.Contains(strings.ToLower(output), "reached max turns"):
		log.logf("turn limit hit for %s — spawning assessor", ticketID)
		_, _ = inv.InvokeAssessor(worktree)
		applyStatus(ctx, ticketID, worktree, p, log)

	case runErr == nil:
		applyStatus(ctx, ticketID, worktree, p, log)
		log.logf("session complete — checking for more work")

	default:
		log.logf("ERROR: agent exited with error for %s: %v", ticketID, runErr)
		time.Sleep(time.Duration(cfg.Daemon.SleepError) * time.Second)
	}
}

func pickTicket(ctx context.Context, p provider.Provider) (id string, needsInput bool, err error) {
	id, err = p.FindResumable(ctx)
	if err != nil {
		return "", false, err
	}
	if id != "" {
		return id, true, nil
	}
	id, err = p.FindNext(ctx)
	return id, false, err
}

func setupWorktree(ctx context.Context, cfg *config.Config, log *logger, p provider.Provider, ticketID string) (string, error) {
	name, err := p.WorktreeName(ctx, ticketID)
	if err != nil {
		return "", err
	}
	path := filepath.Join(cfg.Daemon.WorktreesDir, "ticket-"+name)

	if err := os.MkdirAll(cfg.Daemon.WorktreesDir, 0755); err != nil {
		return "", err
	}

	if _, err := os.Stat(path); os.IsNotExist(err) {
		cmd := exec.CommandContext(ctx, "git", "-C", cfg.Daemon.RepoPath,
			"worktree", "add", path, "-B", "feat/ticket-"+name)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("git worktree add: %w\n%s", err, out)
		}
		log.logf("created worktree: %s", path)
	} else {
		log.logf("reusing worktree: %s", path)
	}
	return path, nil
}

func cleanupWorktree(ctx context.Context, cfg *config.Config, log *logger, p provider.Provider, ticketID, worktree string) {
	if _, err := os.Stat(worktree); os.IsNotExist(err) {
		return
	}
	done, err := p.IsComplete(ctx, ticketID)
	if err != nil {
		log.logf("WARN: IsComplete check failed for %s: %v", ticketID, err)
		return
	}
	if done {
		wsName := agent.WorkspaceName(resolveRepoSlug(cfg.Daemon.RepoPath, cfg.Daemon.RepoSlug), worktree)
		deleteCmd := exec.CommandContext(ctx, "devpod", "delete", wsName, "--force")
		if err := deleteCmd.Run(); err != nil {
			// Workspace may not exist if devpod up never ran — ignore.
			log.logf("WARN: devpod delete %s: %v (ignoring)", wsName, err)
		}

		cmd := exec.CommandContext(ctx, "git", "-C", cfg.Daemon.RepoPath, "worktree", "remove", worktree, "--force")
		if err := cmd.Run(); err != nil {
			log.logf("WARN: worktree remove failed: %v", err)
		} else {
			log.logf("removed worktree: %s", worktree)
		}
	} else {
		log.logf("leaving worktree: %s (session did not complete)", worktree)
	}
}

func applyStatus(ctx context.Context, ticketID, worktree string, p provider.Provider, log *logger) {
	data, err := os.ReadFile(worktree + "/AGENT_STATUS.md")
	if err != nil {
		log.logf("WARN: no AGENT_STATUS.md for %s — leaving ticket state unchanged", ticketID)
		return
	}

	parts := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)
	status := strings.TrimSpace(parts[0])
	comment := ""
	if len(parts) > 1 {
		comment = strings.TrimSpace(parts[1])
	}

	switch status {
	case "needs-review":
		log.logf("agent completed — marking needs-review for %s", ticketID)
		_ = p.MarkNeedsReview(ctx, ticketID)
	case "needs-input":
		log.logf("agent blocked — marking needs-input for %s", ticketID)
		_ = p.MarkNeedsInput(ctx, ticketID, comment)
	case "spec-approved":
		log.logf("assessor: progress — resetting %s to spec-approved", ticketID)
		_ = p.MarkSpecApproved(ctx, ticketID)
	default:
		log.logf("WARN: unrecognized AGENT_STATUS.md status %q for %s — leaving ticket state unchanged", status, ticketID)
	}
}

func parseRateLimitSleep(output string) time.Duration {
	re := regexp.MustCompile(`(?i)resets (\d+:\d+ [ap]m)`)
	m := re.FindStringSubmatch(output)
	if m == nil {
		return time.Hour
	}
	t, err := time.ParseInLocation("3:04 PM", strings.ToUpper(m[1]), time.Local)
	if err != nil {
		return time.Hour
	}
	now := time.Now()
	reset := time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, time.Local)
	if reset.Before(now) {
		reset = reset.Add(24 * time.Hour)
	}
	return reset.Sub(now)
}

func resolveRepoSlug(repoPath, configuredSlug string) string {
	if configuredSlug != "" {
		return configuredSlug
	}
	return filepath.Base(repoPath)
}

func resolveSecret(cfg *config.Config, name string) (string, error) {
	val := os.Getenv(name)
	if val != "" {
		return val, nil
	}
	val, err := keychainGet(name, cfg.Daemon.KeychainService)
	if err != nil || val == "" {
		return "", fmt.Errorf("%s not found in environment or Keychain\nStore it with: security add-generic-password -a %s -s %s -w <value>",
			name, cfg.Daemon.KeychainService, name)
	}
	return val, nil
}

func keychainGet(service, account string) (string, error) {
	out, err := exec.Command("security", "find-generic-password",
		"-a", account, "-s", service, "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func openLog(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
