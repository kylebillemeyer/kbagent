package cmd

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"

	"github.com/spf13/cobra"
)

type initData struct {
	ProjectName     string
	ProjectSlug     string
	RepoPath        string
	WorktreesDir    string
	DockerImage     string
	LogFile         string
	TicketProvider  string
	KeychainService string
	ValidateCmd     string
	GitHubRepo      string
	NodeDir         string // npm working directory, "" if not a node project
	GoProject       bool
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Scaffold kbagent config and project files in the current repo",
	Long: `Creates kbagent.toml, CLAUDE.md, scripts/Dockerfile, scripts/entrypoint.sh,
and .github/workflows/ci.yml in the current repository root.

Skips any file that already exists. Run from the root of a git repository.`,
	SilenceUsage: true,
	RunE:         runInit,
}

func init() {
	rootCmd.AddCommand(initCmd)
}

func runInit(_ *cobra.Command, _ []string) error {
	repoRoot, err := initGitRepoRoot()
	if err != nil {
		return fmt.Errorf("not a git repository: run kbagent init from inside a git repo")
	}
	wd, _ := os.Getwd()
	if wd != repoRoot {
		return fmt.Errorf("run kbagent init from the repository root (%s)", repoRoot)
	}

	r := bufio.NewReader(os.Stdin)
	ask := func(label, def string) string {
		if def != "" {
			fmt.Printf("  %s [%s]: ", label, def)
		} else {
			fmt.Printf("  %s: ", label)
		}
		line, _ := r.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			return def
		}
		return line
	}
	askOpt := func(label string, opts []string) string {
		def := opts[0]
		fmt.Printf("  %s (%s) [%s]: ", label, strings.Join(opts, "/"), def)
		line, _ := r.ReadString('\n')
		v := strings.TrimSpace(strings.ToLower(line))
		if v == "" {
			return def
		}
		for _, o := range opts {
			if v == o {
				return o
			}
		}
		fmt.Printf("  unknown value %q, using %q\n", v, def)
		return def
	}

	fmt.Println("kbagent init")
	fmt.Println()

	defaultSlug := initSlugify(filepath.Base(repoRoot))
	defaultRepo, _ := initDetectGitHubRepo()

	d := initData{RepoPath: repoRoot}
	d.ProjectName = ask("Project name", initTitleCase(defaultSlug))
	d.ProjectSlug = ask("Project slug", defaultSlug)
	d.TicketProvider = askOpt("Ticket provider", []string{"plane", "github"})
	d.ValidateCmd = ask("Validate command (empty to skip CI workflow)", "")

	d.WorktreesDir = repoRoot + "-worktrees"
	d.DockerImage = d.ProjectSlug + "-agent"
	d.KeychainService = d.ProjectSlug + "-agent"
	d.LogFile = filepath.Join(os.Getenv("HOME"), "Library", "Logs", d.ProjectSlug+"-daemon.log")
	d.GitHubRepo = defaultRepo
	d.NodeDir = initDetectNodeDir(repoRoot, d.ValidateCmd)
	d.GoProject = initFileExists(filepath.Join(repoRoot, "go.mod"))

	fmt.Println()

	type fileSpec struct {
		path    string
		tmpl    string
		mode    os.FileMode
		include bool
	}
	files := []fileSpec{
		{"kbagent.toml", initTomlTmpl, 0644, true},
		{"CLAUDE.md", initClaudeMdTmpl, 0644, true},
		{"scripts/Dockerfile", initDockerfileTmpl, 0644, true},
		{"scripts/entrypoint.sh", initEntrypointTmpl, 0755, true},
		{".github/workflows/ci.yml", initCiTmpl, 0644, d.ValidateCmd != ""},
	}

	wrote, skipped := 0, 0
	for _, f := range files {
		if !f.include {
			continue
		}
		abs := filepath.Join(repoRoot, f.path)
		if initFileExists(abs) {
			fmt.Printf("  skip   %s (already exists)\n", f.path)
			skipped++
			continue
		}
		content, err := initRender(f.tmpl, d)
		if err != nil {
			return fmt.Errorf("render %s: %w", f.path, err)
		}
		if err := initWriteFile(abs, content, f.mode); err != nil {
			return fmt.Errorf("write %s: %w", f.path, err)
		}
		fmt.Printf("  wrote  %s\n", f.path)
		wrote++
	}

	fmt.Printf("\n%d file(s) written", wrote)
	if skipped > 0 {
		fmt.Printf(", %d skipped", skipped)
	}
	fmt.Println()
	fmt.Println()
	initPrintNextSteps(d)
	return nil
}

func initPrintNextSteps(d initData) {
	step := 1
	next := func(s string, lines ...string) {
		fmt.Printf("  %d. %s\n", step, s)
		for _, l := range lines {
			fmt.Printf("       %s\n", l)
		}
		fmt.Println()
		step++
	}

	fmt.Println("Next steps:")
	fmt.Println()

	credLines := []string{
		fmt.Sprintf("security add-generic-password -a %s -s GITHUB_TOKEN -w <token>", d.KeychainService),
		fmt.Sprintf("security add-generic-password -a %s -s CLAUDE_CODE_OAUTH_TOKEN -w <token>", d.KeychainService),
	}
	if d.TicketProvider == "plane" {
		credLines = append(credLines, fmt.Sprintf("security add-generic-password -a %s -s PLANE_API_KEY -w <key>", d.KeychainService))
	}
	next(fmt.Sprintf("Store credentials in Keychain (service: %s):", d.KeychainService), credLines...)

	if d.TicketProvider == "plane" {
		next("Fill in Plane state UUIDs in kbagent.toml",
			"GET /api/v1/workspaces/<slug>/projects/<id>/states/")
	}

	next("Fill in the TODOs in CLAUDE.md")
	next("Build the Docker agent image:", "kbagent build")
	next("Start the daemon:", "kbagent run")
}

// ── helpers ───────────────────────────────────────────────────────────────────

func initGitRepoRoot() (string, error) {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func initDetectGitHubRepo() (string, error) {
	out, err := exec.Command("gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func initDetectNodeDir(repoRoot, validateCmd string) string {
	re := regexp.MustCompile(`(?:^|&&)\s*cd\s+(\S+)`)
	if m := re.FindStringSubmatch(validateCmd); m != nil {
		if initFileExists(filepath.Join(repoRoot, m[1], "package.json")) {
			return m[1]
		}
	}
	if initFileExists(filepath.Join(repoRoot, "package.json")) {
		return "."
	}
	entries, _ := os.ReadDir(repoRoot)
	for _, e := range entries {
		if e.IsDir() && initFileExists(filepath.Join(repoRoot, e.Name(), "package.json")) {
			return e.Name()
		}
	}
	return ""
}

func initSlugify(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "-")
	return strings.ReplaceAll(s, "_", "-")
}

func initTitleCase(s string) string {
	words := strings.Fields(strings.ReplaceAll(s, "-", " "))
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

func initRender(tmplStr string, data any) (string, error) {
	t, err := template.New("").Funcs(template.FuncMap{
		"bt":  func() string { return "`" },
		"bts": func() string { return "```" },
	}).Parse(tmplStr)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func initWriteFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), mode)
}

func initFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ── templates ─────────────────────────────────────────────────────────────────

var initTomlTmpl = `[daemon]
repo_path        = "{{.RepoPath}}"
worktrees_dir    = "{{.WorktreesDir}}"
docker_image     = "{{.DockerImage}}"
dockerfile       = "scripts/Dockerfile"
log_file         = "{{.LogFile}}"
ticket_provider  = "{{.TicketProvider}}"
max_turns        = 50
sleep_no_work    = 1800
sleep_error      = 300
keychain_service = "{{.KeychainService}}"{{if .ValidateCmd}}
validate_cmd     = "{{.ValidateCmd}}"{{end}}

[provider.github]
{{- if .GitHubRepo}}
repo = "{{.GitHubRepo}}"
{{- else}}
# repo = "owner/repo"  # auto-detected from gh repo view if omitted
{{- end}}

[provider.plane]
base_url       = "https://api.plane.so"
workspace_slug = "your-workspace"
project_id     = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# State UUIDs — find via: GET /api/v1/workspaces/<slug>/projects/<id>/states/
# Required states: Backlog, Spec Approved, In Progress, Needs Input, In Review
state_backlog       = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_spec_approved = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_in_progress   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_needs_input   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_in_review     = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
`

var initClaudeMdTmpl = `# {{.ProjectName}}

<!-- TODO: describe what this project does and who it's for -->

## Repo layout

{{bts}}
{{.ProjectSlug}}/
<!-- TODO: fill in directory structure -->
{{bts}}

## Key constraints

<!-- TODO: add key product and technical constraints that agents must always respect -->

## Ticket workflow

All work is tracked as tickets. Tickets flow through these states:

{{bts}}
needs-spec → spec-written → spec-approved → in-progress → needs-review
                                                 ↓
                                            needs-input  (agent blocked, awaiting human input)
{{bts}}

{{- if eq .TicketProvider "github"}}

**GitHub Issues labels:**

| Label | Meaning |
|-------|---------|
| {{bt}}needs-spec{{bt}} | Needs a product spec before work can begin |
| {{bt}}spec-written{{bt}} | Spec written, awaiting human approval |
| {{bt}}spec-approved{{bt}} | Ready for implementation |
| {{bt}}in-progress{{bt}} | Agent is working on it |
| {{bt}}needs-review{{bt}} | PR open, awaiting human review |
| {{bt}}needs-input{{bt}} | Agent blocked, awaiting a human decision |

**Priority labels** — agents pick up {{bt}}spec-approved{{bt}} issues in this order:

| Label | Meaning |
|-------|---------|
| {{bt}}p0{{bt}} | Broken, blocking usage — pick up immediately |
| {{bt}}p1{{bt}} | High priority |
| {{bt}}p2{{bt}} | Standard backlog (default if no priority set) |
| {{bt}}p3{{bt}} | Deprioritized — only when p0–p2 queue is empty |
| {{bt}}p4{{bt}} | Tracked idea — never auto-implemented |
{{- else}}

**Plane states:** Backlog → Spec Approved → In Progress → In Review / Needs Input

Agents pick up tickets in **Spec Approved** state, ordered by priority (p0 → p3).
Priority p4 tickets are tracked ideas — agents never auto-implement them.
{{- end}}

**Ticket spec format** — every ticket body must have these sections before it can be spec-approved:

{{bts}}
## What
Plain description of the feature or bug.

## Spec
- Which files/components this touches
- Exact behavior and acceptance criteria (specific and testable)
- Any constraints relevant to this ticket
{{bts}}

**Needs-input protocol** — if you hit an architectural decision not covered by the spec or this file, do not guess. Instead:
1. Write {{bt}}AGENT_STATUS.md{{bt}} with exactly:
   {{bts}}
   needs-input
   <explain the decision, the options, and why you cannot proceed without input>
   {{bts}}
2. Stop without opening a PR.

The human will reply in the ticket/issue thread. The next agent session will read the reply and continue.

## Spec workflow (specs-as-PRs)

When writing a spec for a {{bt}}needs-spec{{bt}} ticket:
1. Create {{bt}}docs/specs/TICKET-N-feature-name.md{{bt}} with sections:
   - {{bt}}## What{{bt}} — plain description
   - {{bt}}## Spec{{bt}} — acceptance criteria, exact behavior, files touched
   - {{bt}}## Out of scope{{bt}} — explicit exclusions
2. Open a PR titled {{bt}}Spec: [feature name]{{bt}}
3. Human reviews the PR with inline comments; agent iterates and pushes updates
4. When the PR is approved and merged → transition ticket to spec-approved

The merged spec file is the authoritative correctness definition used during code review of the implementation PR.

## PR and branching workflow

**Branch from the dependency, not from main.**

If a ticket is blocked by another, create the feature branch from the dependency's branch — not from {{bt}}main{{bt}}:

{{bts}}bash
# Wrong — branch from main, duplicates dependency work in the diff:
git checkout main && git checkout -b feat/ticket-N

# Right — branch from the dependency so the diff only shows this ticket's changes:
git checkout feat/ticket-X && git checkout -b feat/ticket-N
{{bts}}

A PR diff should only show work done for that specific ticket. If the diff contains files already changed in a dependency PR, the branch was created from the wrong base.

**After a dependency merges into main**, rebase the next branch before review or merge:

{{bts}}bash
git fetch origin
git rebase origin/main feat/ticket-N
git push --force-with-lease origin feat/ticket-N
{{bts}}

## Development

{{- if .ValidateCmd}}

{{bts}}bash
{{.ValidateCmd}}   # validate — run before opening a PR
{{bts}}
{{- end}}

<!-- TODO: add how to start the local dev server, run tests, etc. -->
`

var initDockerfileTmpl = `{{- if .GoProject -}}
FROM golang:1.22-bookworm

RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    ca-certificates \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*
{{- else -}}
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
{{- end}}

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user — required because claude refuses to run as root
RUN useradd -m -s /bin/bash agent

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
`

var initEntrypointTmpl = `#!/bin/bash
# Configure git to authenticate via GITHUB_TOKEN for all GitHub HTTPS operations
gh auth setup-git
exec "$@"
`

var initCiTmpl = `name: CI

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
{{- if .GoProject}}
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
{{- else if .NodeDir}}
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: '{{.NodeDir}}/package-lock.json'
      - run: npm ci
        working-directory: {{.NodeDir}}
{{- end}}
      - run: {{.ValidateCmd}}
`
