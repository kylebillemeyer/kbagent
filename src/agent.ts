import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Config } from './config';

export interface InvokeResult {
  output: string;
  error: Error | null;
}

export class Invoker {
  private cfg: Config;
  private logStream: fs.WriteStream | null;

  constructor(cfg: Config, logStream: fs.WriteStream | null) {
    this.cfg = cfg;
    this.logStream = logStream;
  }

  async invokeClaude(worktree: string, mode: string, closesRef: string): Promise<InvokeResult> {
    const prompt = this.buildAgentPrompt(worktree, mode, closesRef);
    const workspace = path.basename(worktree);
    return this.runDevPod(workspace, worktree,
      'claude', '-p', prompt,
      '--permission-mode', 'bypassPermissions',
      '--max-turns', String(this.cfg.maxTurns),
    );
  }

  async invokeAssessor(worktree: string): Promise<InvokeResult> {
    const prompt = this.buildAssessorPrompt(worktree);
    const workspace = path.basename(worktree);
    return this.runDevPod(workspace, worktree,
      'claude', '-p', prompt,
      '--permission-mode', 'bypassPermissions',
      '--max-turns', '10',
    );
  }

  private runDevPod(workspace: string, worktree: string, ...claudeArgs: string[]): Promise<InvokeResult> {
    const args = ['ssh', workspace, '--', ...claudeArgs];
    return new Promise((resolve) => {
      const chunks: string[] = [];
      const proc = spawn('devpod', args, {
        env: {
          ...process.env,
          GITHUB_TOKEN: this.cfg.githubToken,
          CLAUDE_CODE_OAUTH_TOKEN: this.cfg.claudeOAuthToken,
        },
        cwd: worktree,
      });

      const onData = (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(text);
        this.logStream?.write(text);
        chunks.push(text);
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('close', (code) => {
        const output = chunks.join('');
        resolve({
          output,
          error: code === 0 ? null : new Error(`devpod exited with code ${code}`),
        });
      });

      proc.on('error', (err) => {
        resolve({ output: chunks.join(''), error: err });
      });
    });
  }

  private buildAgentPrompt(worktree: string, mode: string, closesRef: string): string {
    let preamble: string;
    let planInstructions: string;

    switch (mode) {
      case 'needs-input':
        preamble = 'A ticket was blocked waiting for human input. The human has replied — read TICKET.md (which includes the replies at the bottom) and continue implementing.';
        planInstructions = 'Read AGENT_PLAN.md to see what was completed before the block. Check off tasks as you complete them.';
        break;
      case 'continuing':
        preamble = 'A ticket hit its turn limit. The assessor determined work was progressing. Read AGENT_PLAN.md — it has a continuation note. Pick up from the first unchecked task.';
        planInstructions = 'Read AGENT_PLAN.md first. Check off tasks ([x]) as you complete them.';
        break;
      default: // fresh
        preamble = 'Implement the ticket described in TICKET.md.';
        planInstructions = `Before writing any code:
1. Create AGENT_PLAN.md at the worktree root with a task breakdown derived from the spec. Use this format:
   ## Goal
   One sentence description.
   ## Tasks
   - [ ] Task one
   - [ ] Task two
   ## Decisions / blockers
   (fill in as you go)
2. Check off tasks ([x]) as you complete them. Do not commit AGENT_PLAN.md.`;
    }

    const validateLine = this.cfg.validateCmd
      ? `- Run \`${this.cfg.validateCmd}\` — do not open a PR if it fails\n`
      : '';

    const prLine = closesRef ? `'${closesRef}' in the body. ` : '';

    return `${preamble}

Working directory: ${worktree}
Read CLAUDE.md first for project context, then read TICKET.md for the full spec.

${planInstructions}

- Implement exactly what the spec says, nothing more
${validateLine}- If you hit an architectural decision not covered by the spec or CLAUDE.md:
  Write AGENT_STATUS.md with exactly:
    needs-input
    <explain the decision, the options, and why you cannot proceed without input>
  Then stop without opening a PR.
- When done: open a PR with ${prLine}PR description must include: what changed, which files, what to manually test.
  Then write AGENT_STATUS.md with exactly:
    needs-review
`;
  }

  private buildAssessorPrompt(worktree: string): string {
    return `You are assessing an autonomous coding agent that hit its turn limit.

Step 1 — understand the goal:
  Read TICKET.md in the working directory.

Step 2 — review what the agent did:
  cat ${worktree}/AGENT_PLAN.md   (if it exists)
  git -C ${worktree} diff HEAD

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
`;
  }
}

export function extractClosesRef(ticketPath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(ticketPath, 'utf8');
  } catch {
    return '';
  }
  for (const line of content.split('\n')) {
    if (line.startsWith('GitHub Issue: #')) {
      const num = line.replace('GitHub Issue: #', '').trim();
      if (num) return `Closes #${num}`;
    }
  }
  return '';
}
