import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { Config } from './config';
import type { Provider } from './provider/provider';
import { Invoker, extractClosesRef } from './agent';

function logf(logStream: fs.WriteStream, format: string, ...args: unknown[]): void {
  const msg = format.replace(/%s/g, () => String(args.shift()));
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}\n`;
  process.stdout.write(line);
  logStream.write(line);
}

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

function fileExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

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
