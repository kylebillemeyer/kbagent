import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { applyStatus, deriveSessionMode, parseRateLimitSleep } from '../../src/daemon';
import type { Provider } from '../../src/provider/provider';

const SIGNAL = new AbortController().signal;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbagent-daemon-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let worktree: string;
beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(tmpRoot, 'wt-'));
});

function write(name: string, content: string): void {
  fs.writeFileSync(path.join(worktree, name), content, 'utf8');
}

// ------------------------------------------------------ deriveSessionMode ---

describe('deriveSessionMode', () => {
  it('is fresh when the worktree has neither file', () => {
    assert.equal(deriveSessionMode(worktree), 'fresh');
  });

  it('is continuing when a plan exists and no status does', () => {
    write('AGENT_PLAN.md', '## Goal\nx\n## Tasks\n- [x] one\n- [ ] two\n');
    assert.equal(deriveSessionMode(worktree), 'continuing');
  });

  it('is needs-input when the status says so, with no plan', () => {
    write('AGENT_STATUS.md', 'needs-input\nWhich database?\n');
    assert.equal(deriveSessionMode(worktree), 'needs-input');
  });

  it('is needs-input when the status says so and a plan exists', () => {
    write('AGENT_PLAN.md', '## Goal\nx\n');
    write('AGENT_STATUS.md', 'needs-input\nWhich database?\n');
    assert.equal(deriveSessionMode(worktree), 'needs-input');
  });

  it('is continuing for any other status keyword alongside a plan', () => {
    write('AGENT_PLAN.md', '## Goal\nx\n');
    for (const status of ['needs-review', 'ready', 'spec-approved', '']) {
      write('AGENT_STATUS.md', status ? `${status}\n` : '');
      assert.equal(deriveSessionMode(worktree), 'continuing', `status ${JSON.stringify(status)}`);
    }
  });

  it('is fresh for another status keyword with no plan', () => {
    write('AGENT_STATUS.md', 'needs-review\n');
    assert.equal(deriveSessionMode(worktree), 'fresh');
  });

  it('reads only the first line, ignoring leading and trailing whitespace', () => {
    write('AGENT_STATUS.md', '\n  needs-input  \nthe rest is an explanation\nneeds-review\n');
    assert.equal(deriveSessionMode(worktree), 'needs-input');
  });
});

// ------------------------------------------------------------ applyStatus ---

class RecordingProvider implements Provider {
  calls: string[] = [];
  comments: string[] = [];

  async checkDeps(): Promise<void> {}
  async findNext(): Promise<string> {
    return '';
  }
  async fetchTicket(): Promise<void> {}
  async markInProgress(): Promise<void> {
    this.calls.push('markInProgress');
  }
  async markNeedsInput(_id: string, comment: string): Promise<void> {
    this.calls.push('markNeedsInput');
    this.comments.push(comment);
  }
  async markNeedsReview(): Promise<void> {
    this.calls.push('markNeedsReview');
  }
  async markReady(): Promise<void> {
    this.calls.push('markReady');
  }
  async isComplete(): Promise<boolean> {
    return false;
  }
  async worktreeName(): Promise<string> {
    return '1';
  }
}

async function apply(): Promise<{ provider: RecordingProvider; logs: string[] }> {
  const provider = new RecordingProvider();
  const logs: string[] = [];
  await applyStatus('T-1', worktree, provider, (msg) => logs.push(msg), SIGNAL);
  return { provider, logs };
}

describe('applyStatus', () => {
  it('routes needs-review to markNeedsReview', async () => {
    write('AGENT_STATUS.md', 'needs-review\n');
    const { provider } = await apply();
    assert.deepEqual(provider.calls, ['markNeedsReview']);
  });

  it('routes needs-input to markNeedsInput, passing the rest of the file as the comment', async () => {
    write('AGENT_STATUS.md', 'needs-input\nShould stage moves be audited?\nOption A or B.\n');
    const { provider } = await apply();
    assert.deepEqual(provider.calls, ['markNeedsInput']);
    assert.deepEqual(provider.comments, ['Should stage moves be audited?\nOption A or B.']);
  });

  it('routes ready to markReady', async () => {
    write('AGENT_STATUS.md', 'ready\n');
    const { provider } = await apply();
    assert.deepEqual(provider.calls, ['markReady']);
  });

  it('leaves ticket state unchanged for an unrecognized keyword', async () => {
    write('AGENT_STATUS.md', 'all-done\nfinished it\n');
    const { provider, logs } = await apply();
    assert.deepEqual(provider.calls, []);
    assert.match(logs.join('\n'), /unrecognized/);
  });

  // The pre-rename alias was dropped with the Plane provider: no worktree can still
  // be in flight from a build that wrote it.
  it('no longer accepts the spec-approved alias', async () => {
    write('AGENT_STATUS.md', 'spec-approved\n');
    const { provider, logs } = await apply();
    assert.deepEqual(provider.calls, []);
    assert.match(logs.join('\n'), /unrecognized/);
  });

  it('leaves ticket state unchanged when the file is missing', async () => {
    const { provider, logs } = await apply();
    assert.deepEqual(provider.calls, []);
    assert.match(logs.join('\n'), /no AGENT_STATUS\.md/);
  });
});

// ----------------------------------------------------- parseRateLimitSleep ---

// The clock moves between the two Date reads, and the parser rounds to whole seconds.
const TOLERANCE = 2;

// Independently expresses "the next time the wall clock reads hh:mm", taking a 24-hour
// hour so the assertion pins the parser's 12-hour conversion rather than restating it.
function secondsUntilClock(hour24: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour24, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return Math.round((target.getTime() - now.getTime()) / 1000);
}

// Formats a moment the way the parser's regex expects it, e.g. "1:05 pm".
function clock12(d: Date): string {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

describe('parseRateLimitSleep', () => {
  it('falls back to an hour when no reset time is present', () => {
    assert.equal(parseRateLimitSleep('Claude usage limit reached.'), 3600);
    assert.equal(parseRateLimitSleep(''), 3600);
    assert.equal(parseRateLimitSleep('resets soon'), 3600);
    // No minutes, so nothing the parser can build a time from.
    assert.equal(parseRateLimitSleep('resets 3 pm'), 3600);
    // The regex requires whitespace before am/pm, so an unspaced time is not
    // recognised at all and the caller sleeps the default hour.
    assert.equal(parseRateLimitSleep('resets 9:15am'), 3600);
  });

  it('converts pm hours to 24-hour time', () => {
    assert.equal(
      parseRateLimitSleep('Session limit reached — resets 1:05 pm'),
      secondsUntilClock(13, 5)
    );
  });

  it('treats 12 pm as noon and 12 am as midnight', () => {
    assert.equal(parseRateLimitSleep('resets 12:00 pm'), secondsUntilClock(12, 0));
    assert.equal(parseRateLimitSleep('resets 12:30 am'), secondsUntilClock(0, 30));
  });

  it('is case-insensitive', () => {
    assert.equal(parseRateLimitSleep('RESETS 9:15 AM'), secondsUntilClock(9, 15));
  });

  it('waits for the given time later today', () => {
    const target = new Date(Date.now() + 90 * 60_000);
    const secs = parseRateLimitSleep(`resets ${clock12(target)}`);
    // Truncated to the minute, so the wait is 90 minutes minus the current seconds.
    const expected = 90 * 60 - target.getSeconds();
    assert.ok(Math.abs(secs - expected) <= TOLERANCE, `got ${secs}, expected ~${expected}`);
  });

  it('rolls over to tomorrow when the time has already passed today', () => {
    const target = new Date(Date.now() - 2 * 60 * 60_000);
    const secs = parseRateLimitSleep(`resets ${clock12(target)}`);
    const expected = 22 * 60 * 60 - target.getSeconds();
    assert.ok(Math.abs(secs - expected) <= TOLERANCE, `got ${secs}, expected ~${expected}`);
    assert.ok(secs > 0, 'a rolled-over reset must still be in the future');
  });
});
