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

function parseRateLimitSleep(output: string): number {
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

async function pickTicket(p: Provider, signal: AbortSignal): Promise<{ id: string; needsInput: boolean }> {
  const resumable = await p.findResumable(signal);
  if (resumable) return { id: resumable, needsInput: true };
  const next = await p.findNext(signal);
  return { id: next, needsInput: false };
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

  if (!fileExists(worktreePath)) {
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
    } catch (err) {
      log(`WARN: worktree remove failed: ${err}`);
    }
  } else {
    log(`leaving worktree: ${worktree} (session did not complete)`);
  }
}

async function applyStatus(
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
    case 'spec-approved':
      log(`assessor: progress — resetting ${ticketId} to spec-approved`);
      await p.markSpecApproved(ticketId, signal).catch(() => {});
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
  needsInput: boolean,
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
    const mode = needsInput
      ? 'needs-input'
      : fileExists(path.join(worktree, 'AGENT_PLAN.md'))
      ? 'continuing'
      : 'fresh';

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

  log(`daemon started — provider: ${cfg.ticketProvider}`);

  try {
    for (;;) {
      let id: string;
      let needsInput: boolean;
      try {
        ({ id, needsInput } = await pickTicket(p, signal));
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

      if (needsInput) {
        log(`resuming ticket ${id} (human replied to needs-input)`);
      } else {
        log(`picked up ticket ${id}`);
      }

      try {
        await processTicket(cfg, p, inv, log, id, needsInput, signal);
      } catch (err) {
        if (signal.aborted) return;
        log(`ERROR: processTicket ${id}: ${err}`);
      }
    }
  } finally {
    logStream.end();
  }
}
