package agent

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Invoker runs the agent Docker container and builds prompts.
type Invoker struct {
	DockerImage      string
	RepoParentDir    string
	GitHubToken      string
	ClaudeOAuthToken string
	MaxTurns         int
	ValidateCmd      string
	Log              io.Writer
}

// InvokeClaude runs a claude session inside Docker for the given worktree and mode.
// closesRef is the "Closes #NNN" string extracted from TICKET.md (empty if not a GitHub-linked ticket).
// Returns combined stdout+stderr output and the run error.
func (inv *Invoker) InvokeClaude(worktree, mode, closesRef string) (string, error) {
	prompt := inv.buildAgentPrompt(worktree, mode, closesRef)
	return inv.runDocker(worktree,
		"claude", "-p", prompt,
		"--permission-mode", "bypassPermissions",
		"--max-turns", strconv.Itoa(inv.MaxTurns),
	)
}

// InvokeAssessor runs a lightweight assessor session after a turn-limit exit.
func (inv *Invoker) InvokeAssessor(worktree string) (string, error) {
	prompt := inv.buildAssessorPrompt(worktree)
	return inv.runDocker(worktree,
		"claude", "-p", prompt,
		"--permission-mode", "bypassPermissions",
		"--max-turns", "10",
	)
}

func (inv *Invoker) runDocker(worktree string, args ...string) (string, error) {
	cmdArgs := []string{
		"run", "--rm", "-t",
		"--volume", inv.RepoParentDir + ":" + inv.RepoParentDir,
		"--env", "GITHUB_TOKEN=" + inv.GitHubToken,
		"--env", "CLAUDE_CODE_OAUTH_TOKEN=" + inv.ClaudeOAuthToken,
		"--workdir", worktree,
		inv.DockerImage,
	}
	cmdArgs = append(cmdArgs, args...)

	// We want to stream output in real time AND capture it for analysis.
	// os/exec.Cmd.Start + manual copy lets us do both without a goroutine leak.
	pr, pw, err := os.Pipe()
	if err != nil {
		return "", fmt.Errorf("pipe: %w", err)
	}

	var writers []io.Writer
	writers = append(writers, os.Stdout, pw)
	if inv.Log != nil {
		writers = append(writers, inv.Log)
	}
	mw := io.MultiWriter(writers...)

	cmd := exec.Command("docker", cmdArgs...)
	cmd.Stdout = mw
	cmd.Stderr = mw

	if err := cmd.Start(); err != nil {
		pw.Close()
		pr.Close()
		return "", fmt.Errorf("docker start: %w", err)
	}

	// Read captured output into buf while the process runs.
	var buf bytes.Buffer
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		scanner := bufio.NewScanner(pr)
		for scanner.Scan() {
			buf.WriteString(scanner.Text() + "\n")
		}
	}()

	runErr := cmd.Wait()
	pw.Close()
	<-doneCh
	pr.Close()

	return buf.String(), runErr
}

func (inv *Invoker) buildAgentPrompt(worktree, mode, closesRef string) string {
	var preamble, planInstructions string

	switch mode {
	case "needs-input":
		preamble = "A ticket was blocked waiting for human input. The human has replied — read TICKET.md (which includes the replies at the bottom) and continue implementing."
		planInstructions = "Read AGENT_PLAN.md to see what was completed before the block. Check off tasks as you complete them."
	case "continuing":
		preamble = "A ticket hit its turn limit. The assessor determined work was progressing. Read AGENT_PLAN.md — it has a continuation note. Pick up from the first unchecked task."
		planInstructions = "Read AGENT_PLAN.md first. Check off tasks ([x]) as you complete them."
	default: // fresh
		preamble = "Implement the ticket described in TICKET.md."
		planInstructions = `Before writing any code:
1. Create AGENT_PLAN.md at the worktree root with a task breakdown derived from the spec. Use this format:
   ## Goal
   One sentence description.
   ## Tasks
   - [ ] Task one
   - [ ] Task two
   ## Decisions / blockers
   (fill in as you go)
2. Check off tasks ([x]) as you complete them. Do not commit AGENT_PLAN.md.`
	}

	validateLine := ""
	if inv.ValidateCmd != "" {
		validateLine = fmt.Sprintf("- Run `%s` — do not open a PR if it fails\n", inv.ValidateCmd)
	}

	prLine := ""
	if closesRef != "" {
		prLine = fmt.Sprintf("'%s' in the body. ", closesRef)
	}

	return fmt.Sprintf(`%s

Working directory: %s
Read CLAUDE.md first for project context, then read TICKET.md for the full spec.

%s

- Implement exactly what the spec says, nothing more
%s- If you hit an architectural decision not covered by the spec or CLAUDE.md:
  Write AGENT_STATUS.md with exactly:
    needs-input
    <explain the decision, the options, and why you cannot proceed without input>
  Then stop without opening a PR.
- When done: open a PR with %sPR description must include: what changed, which files, what to manually test.
  Then write AGENT_STATUS.md with exactly:
    needs-review
`, preamble, worktree, planInstructions, validateLine, prLine)
}

func (inv *Invoker) buildAssessorPrompt(worktree string) string {
	return fmt.Sprintf(`You are assessing an autonomous coding agent that hit its turn limit.

Step 1 — understand the goal:
  Read TICKET.md in the working directory.

Step 2 — review what the agent did:
  cat %s/AGENT_PLAN.md   (if it exists)
  git -C %s diff HEAD

Step 3 — decide: is the agent making meaningful progress toward completing the spec,
or is it stuck (looping, confused, or blocked on something it cannot resolve alone)?

If PROGRESS — the remaining work is clear and completable:
  a. Append to AGENT_PLAN.md (create if missing):
       ## Assessor Continuation Note
       <2-3 sentences: what is done, what remains, where to start next>
  b. Write AGENT_STATUS.md with exactly:
       spec-approved

If STUCK — the agent needs human input:
  a. Write AGENT_STATUS.md with exactly:
       needs-input
       <explain what the agent tried, what it changed, and what is blocking it>
`, worktree, worktree)
}

// ExtractClosesRef reads TICKET.md and returns "Closes #NNN" if a GitHub issue is linked.
func ExtractClosesRef(ticketPath string) string {
	data, err := os.ReadFile(ticketPath)
	if err != nil {
		return ""
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "GitHub Issue: #") {
			num := strings.TrimPrefix(line, "GitHub Issue: #")
			num = strings.TrimSpace(num)
			if num != "" {
				return "Closes #" + num
			}
		}
	}
	return ""
}
