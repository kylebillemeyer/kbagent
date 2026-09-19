import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { Config } from './config';
import type { Provider } from './provider/provider';
import { Invoker, extractClosesRef } from './agent';

/**
 * The daemon loop and the worktree lifecycle around it.
 *
 * `run` polls the provider for one ready ticket at a time and hands each to
 * `processTicket`, which sets up a worktree, invokes the agent inside it, applies
 * whatever the agent reported, and tears the worktree back down. Everything else in
 * this module is a step of that cycle.
 *
 * The two things worth knowing before editing: a worktree and its devpod workspace
 * are one unit and must be created and destroyed together (see `setupWorktree`), and
 * `AGENT_STATUS.md`'s first line is a contract shared with the prompt in `agent.ts`
 * (see `applyStatus`).
 */

/** Write one timestamped line to both stdout and the log file. */
function logf(logStream: fs.WriteStream, format: string, ...args: unknown[]): void {
  const msg = format.replace(/%s/g, () => String(args.shift()));
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}\n`;
  process.stdout.write(line);
  logStream.write(line);
}

/** Sleep, rejecting immediately if the abort signal fires (so Ctrl-C is not swallowed). */
function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/** Whether a path exists at all — not whether it is a file, a directory, or usable. */
function fileExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `worktree` is a git worktree this repo actually knows about: a `.git` file
 * plus an entry in `git worktree list`. Mere directory existence is not enough.
 */
// A directory can exist at the worktree path without being a registered git
// worktree (e.g. left behind as plain scaffolding after a prior `worktree
// remove`). Treating such a stale dir as reusable both skips `worktree add`
// and — because its inode no longer matches what a reused devpod container is
// bound to — produces an empty/stale bind mount inside the container.
function isValidWorktree(repoPath: string, worktree: string): boolean {
  if (!fileExists(path.join(worktree, '.git'))) return false;
  try {
    const out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']).toString();
    return out.split('\n').includes(`worktree ${worktree}`);
  } catch {
    return false;
  }
}

/**
 * Seconds to sleep from a Claude rate-limit message such as "resets 3:45pm", rolling
 * over to tomorrow when that time has already passed today. Falls back to an hour when
 * the message has no time in it.
 */
export function parseRateLimitSleep(output: string): number {
  const m = output.match(/resets\s+(\d+:\d+\s+[ap]m)/i);
  if (!m) return 3600;
  const match = m[1].toUpperCase();
  const [timePart, period] = match.split(' ');
  const [hStr, mStr] = timePart.split(':');
  let h = parseInt(hStr, 10);
  const min = parseInt(mStr, 10);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  const now = new Date();
  const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0);
  if (reset <= now) reset.setDate(reset.getDate() + 1);
  return Math.round((reset.getTime() - now.getTime()) / 1000);
}

export type SessionMode = 'fresh' | 'continuing' | 'needs-input';

/**
 * Which of the three agent prompt modes this run should use, inferred from what a
 * previous session left behind in the worktree.
 */
// With one queue and one trigger — a human moving the ticket back to Ready — the
// ticket system can no longer say *why* the previous session stopped, so the worktree
// answers instead. An AGENT_STATUS.md still reading `needs-input` is the agent's own
// record that it stopped on a question; an AGENT_PLAN.md without one means a session
// ran and was cut short (turn limit). Neither means nothing has run here yet.
//
// Must be called before processTicket deletes the stale AGENT_STATUS.md.
export function deriveSessionMode(worktree: string): SessionMode {
  let status = '';
  try {
    status = fs.readFileSync(path.join(worktree, 'AGENT_STATUS.md'), 'utf8').trim().split('\n')[0].trim();
  } catch {
    // no status file — fall through to the plan check
  }
  if (status === 'needs-input') return 'needs-input';
  if (fileExists(path.join(worktree, 'AGENT_PLAN.md'))) return 'continuing';
  return 'fresh';
}

/**
 * Return the worktree path for a ticket, creating it if needed. A directory that
 * exists but is not a registered worktree is torn down first — along with any devpod
 * workspace still bound to its old inode — because reusing it would leave the
 * container mounted on a deleted directory.
 */
async function setupWorktree(
  cfg: Config,
  log: (msg: string) => void,
  p: Provider,
  ticketId: string,
  signal: AbortSignal
): Promise<string> {
  const name = await p.worktreeName(ticketId, signal);
  const worktreePath = path.join(cfg.worktreesDir, `ticket-${name}`);

  fs.mkdirSync(cfg.worktreesDir, { recursive: true });

  if (!isValidWorktree(cfg.repoPath, worktreePath)) {
    // A stale dir and any orphaned devpod container bound to its old inode must
    // both go before we recreate, or the rebuilt worktree will be shadowed by a
    // reused container's stale bind mount.
    if (fileExists(worktreePath)) {
      try {
        execFileSync('devpod', ['delete', `ticket-${name}`, '--force']);
      } catch (err) {
        log(`WARN: devpod delete failed for ticket-${name}: ${err}`);
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
      execFileSync('git', ['-C', cfg.repoPath, 'worktree', 'prune']);
    }
    execFileSync('git', ['-C', cfg.repoPath, 'worktree', 'add', worktreePath, '-B', `feat/ticket-${name}`]);
    log(`created worktree: ${worktreePath}`);
  } else {
    log(`reusing worktree: ${worktreePath}`);
  }
  return worktreePath;
}

/**
 * Tear down the worktree and its devpod workspace, but only if the ticket reached a
 * terminal stage. An unfinished session keeps both so the next run can resume in
 * place; the two are always removed together.
 */
async function cleanupWorktree(
  cfg: Config,
  log: (msg: string) => void,
  p: Provider,
  ticketId: string,
  worktree: string,
  signal: AbortSignal
): Promise<void> {
  if (!fileExists(worktree)) return;
  let done: boolean;
  try {
    done = await p.isComplete(ticketId, signal);
  } catch (err) {
    log(`WARN: IsComplete check failed for ${ticketId}: ${err}`);
    return;
  }
  if (done) {
    try {
      execFileSync('git', ['-C', cfg.repoPath, 'worktree', 'remove', worktree, '--force']);
      log(`removed worktree: ${worktree}`);
      // Tear the devpod workspace down with the worktree so the container and
      // its bind mount are never left bound to a deleted inode.
      try {
        execFileSync('devpod', ['delete', path.basename(worktree), '--force']);
        log(`removed devpod workspace: ${path.basename(worktree)}`);
      } catch (err) {
        log(`WARN: devpod delete failed for ${path.basename(worktree)}: ${err}`);
      }
    } catch (err) {
      log(`WARN: worktree remove failed: ${err}`);
    }
  } else {
    log(`leaving worktree: ${worktree} (session did not complete)`);
  }
}

/**
 * Read `AGENT_STATUS.md` and move the ticket to the stage its first line asks for.
 *
 * That first line is a contract with the prompt in `agent.ts`: `needs-review`,
 * `needs-input`, or `ready`. Anything after it is the agent's explanation, posted as a
 * comment when it is blocked. An unrecognized keyword or a missing file leaves the
 * ticket where it is rather than guessing — changing this parser means changing the
 * prompt too.
 */
export async function applyStatus(
  ticketId: string,
  worktree: string,
  p: Provider,
  log: (msg: string) => void,
  signal: AbortSignal
): Promise<void> {
  let data: string;
  try {
    data = fs.readFileSync(path.join(worktree, 'AGENT_STATUS.md'), 'utf8');
  } catch {
    log(`WARN: no AGENT_STATUS.md for ${ticketId} — leaving ticket state unchanged`);
    return;
  }

  const parts = data.trim().split('\n');
  const status = parts[0].trim();
  const comment = parts.slice(1).join('\n').trim();

  switch (status) {
    case 'needs-review':
      log(`agent completed — marking needs-review for ${ticketId}`);
      await p.markNeedsReview(ticketId, signal).catch(() => {});
      break;
    case 'needs-input':
      log(`agent blocked — marking needs-input for ${ticketId}`);
      await p.markNeedsInput(ticketId, comment, signal).catch(() => {});
      break;
    case 'ready':
      log(`assessor: progress — resetting ${ticketId} to ready`);
      await p.markReady(ticketId, signal).catch(() => {});
      break;
    default:
      log(`WARN: unrecognized AGENT_STATUS.md status "${status}" for ${ticketId} — leaving ticket state unchanged`);
  }
}

/**
 * Take one ticket from pickup to teardown: set up the worktree, mark it in progress,
 * write `TICKET.md`, run the agent, and apply the result.
 *
 * Three outcomes get special handling. A rate limit sleeps until the quota resets and
 * leaves the ticket untouched. A turn limit spawns the assessor, which decides whether
 * the work is progressing or stuck and writes the status file itself. An agent that
 * exits non-zero leaves the ticket in progress and backs off.
 */
async function processTicket(
  cfg: Config,
  p: Provider,
  inv: Invoker,
  log: (msg: string) => void,
  ticketId: string,
  signal: AbortSignal
): Promise<void> {
  let worktree: string;
  try {
    worktree = await setupWorktree(cfg, log, p, ticketId, signal);
  } catch (err) {
    log(`ERROR: setup worktree for ${ticketId}: ${err}`);
    await sleep(cfg.sleepError, signal);
    return;
  }

  try {
    const mode = deriveSessionMode(worktree);

    try {
      await p.markInProgress(ticketId, signal);
    } catch (err) {
      log(`WARN: mark in-progress ${ticketId}: ${err}`);
    }

    try {
      await p.fetchTicket(ticketId, worktree, mode, signal);
    } catch (err) {
      log(`ERROR: fetch ticket ${ticketId}: ${err}`);
      await sleep(cfg.sleepError, signal);
      return;
    }

    try {
      fs.unlinkSync(path.join(worktree, 'AGENT_STATUS.md'));
    } catch {
      // may not exist
    }

    const closesRef = extractClosesRef(path.join(worktree, 'TICKET.md'));
    log(`invoking agent — ticket: ${ticketId}, mode: ${mode}`);

    const { output, error: runErr } = await inv.invokeClaude(worktree, mode, closesRef);
    const outputLower = output.toLowerCase();

    if (outputLower.includes('session limit')) {
      const secs = parseRateLimitSleep(output);
      log(`rate limit hit — sleeping ${secs}s`);
      await sleep(secs, signal);
    } else if (outputLower.includes('reached max turns')) {
      log(`turn limit hit for ${ticketId} — spawning assessor`);
      await inv.invokeAssessor(worktree);
      await applyStatus(ticketId, worktree, p, log, signal);
    } else if (!runErr) {
      await applyStatus(ticketId, worktree, p, log, signal);
      log('session complete — checking for more work');
    } else {
      log(`ERROR: agent exited with error for ${ticketId}: ${runErr}`);
      await sleep(cfg.sleepError, signal);
    }
  } finally {
    await cleanupWorktree(cfg, log, p, ticketId, worktree, signal);
  }
}

/**
 * The daemon loop: pick a ticket, process it, repeat; sleep when the queue is empty.
 *
 * Strictly sequential — one ticket at a time, one process per project. Errors from
 * picking or processing are logged and backed off rather than fatal, so a transient
 * database or devpod failure does not stop the daemon. Only an abort ends it.
 */
export async function run(cfg: Config, p: Provider, signal: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
  const logStream = fs.createWriteStream(cfg.logFile, { flags: 'a' });
  const log = (msg: string) => logf(logStream, msg);

  const inv = new Invoker(cfg, logStream);

  log(`daemon started — project: ${cfg.projectName}, provider: ${cfg.ticketProvider}`);

  try {
    for (;;) {
      let id: string;
      try {
        id = await p.findNext(signal);
      } catch (err) {
        if (signal.aborted) return;
        log(`ERROR: pick ticket: ${err}`);
        await sleep(cfg.sleepError, signal);
        continue;
      }

      if (!id) {
        log(`queue empty — sleeping ${cfg.sleepNoWork}s`);
        try {
          await sleep(cfg.sleepNoWork, signal);
        } catch {
          return;
        }
        continue;
      }

      log(`picked up ticket ${id}`);

      try {
        await processTicket(cfg, p, inv, log, id, signal);
      } catch (err) {
        if (signal.aborted) return;
        log(`ERROR: processTicket ${id}: ${err}`);
      }
    }
  } finally {
    logStream.end();
  }
}
