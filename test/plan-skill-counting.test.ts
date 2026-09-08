import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PLAN_SKILL_COUNT_FINALIZE_MS } from './helpers/claude-pty-runner';

async function runFakeCounting(completion: string, scenario: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'fixtures', 'plan-skill-counting.ts'), completion, scenario], {
    cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    return JSON.parse(stdout.trim());
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}

describe('real plan counting loop with an isolated fake PTY', () => {
  test('a current create dialog is decoded and granted only for its exact owned path', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-create');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r', '1\r']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
  }, 15_000);
  test('a decoded create dialog cannot grant a different pending path', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-create-mismatch');
    expect(result.error).toContain('cannot be bound');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a second-option question preference still grants only the current file request', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-create-pick-two');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '2\r', '2\r', '2\r']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('screen decoding cannot expand the existing plan-ready completion evidence', async () => {
    const result = await runFakeCounting('**DONE**', 'screen-only-plan-ready');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.observation.evidence).toContain('Reay to execute?');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('cursor-corrected question text matches its native invocation and still requires acknowledgement', async () => {
    const result = await runFakeCounting('**DONE**', 'screen-question-redraw');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('a stale grant cannot become permission for a new sole pending owner', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-owner-change');
    expect(result.error).toContain('cannot be bound');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r']);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a new tool ID with identical question text cannot inherit the old rendering', async () => {
    const result = await runFakeCounting('**DONE**', 'repeated-native');
    expect(result.error).toContain('Indistinguishable repeated native question');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r']);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('one permission dialog cannot grant two ambiguous pending tools', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-ambiguous');
    expect(result.error).toContain('Ambiguous native permission owner');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('unsupported checkbox navigation fails before sending an answer', async () => {
    const result = await runFakeCounting('**DONE**', 'multi-select');
    expect(result.error).toContain('multiSelect');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('permission acknowledgement consumes its owned tool despite later repaint', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-redraw');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r', '1\r']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
  }, 15_000);
  test('a preview without an owned question never receives an answer', async () => {
    const result = await runFakeCounting('**DONE**', 'preview-only');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.observation.step0Count).toBe(0);
  }, 15_000);
  test('a submitted question does not count until its matching acknowledgement', async () => {
    const result = await runFakeCounting('**DONE**', 'no-ack');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(0);
    expect(result.observation.outcome).toBe('timeout');
  }, 15_000);
  test('two question tabs and final submit produce one acknowledged invocation', async () => {
    const result = await runFakeCounting('**DONE**', 'multi-question');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r', '\r']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(1);
    expect(result.observation.fingerprints[1].questions).toHaveLength(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('first-question routing survives native identity and acknowledgement', async () => {
    const result = await runFakeCounting('**DONE**', 'first-route');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '2\r', '1\r', '1\r']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
  }, 15_000);
  test('identical options on a different native question wait for that question render', async () => {
    const result = await runFakeCounting('**DONE**', 'wrong-question');
    expect(result.prematureAnswers).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('an answered menu with changed repaint text cannot send or count another answer', async () => {
    const result = await runFakeCounting('**DONE**', 'stale-redraw');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test.each([['**DONE**', 'normal'], ['## Completion Summary', 'normal'], ['**DONE**', 'reused-options'], ['**DONE**', 'redraw']])('fixture precedes slash, preview does not stop, and %s completes (%s)', async (completion, scenario) => {
    const result = await runFakeCounting(completion, scenario);
    expect(result.seededBeforeSlash).toBe(true);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1\r', '1\r']);
    expect(result.closed).toBe(true);
    expect(result.redraws).toBe(scenario === 'redraw' ? 1 : 0);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.fingerprints.map((entry: { preReview: boolean }) => entry.preReview)).toEqual([true, false, false]);
  }, 15_000);
});

describe('counting work deadline and finalization', () => {
  test.each(['setup-budget', 'launch-budget', 'late-completion', 'timeout-after-question'])('%s cannot spend the finalization allowance on model work', async scenario => {
    const result = await runFakeCounting('**DONE**', scenario);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.observation.elapsedMs).toBe(result.helperTimeoutMs);
    expect(result.closed).toBe(true);
    expect(result.caseElapsedMs).toBeLessThan(result.caseBudgetMs + PLAN_SKILL_COUNT_FINALIZE_MS);
    expect(result.sendTimes.every((ms: number) => ms < result.caseBudgetMs)).toBe(true);
    if (scenario === 'launch-budget') expect(result.sends).toEqual([]);
    if (scenario === 'setup-budget') expect(result.helperTimeoutMs).toBe(result.caseBudgetMs - result.setupMs);
    if (scenario === 'late-completion') {
      expect(result.lateCompletionSent).toBe(true);
      expect(result.sends).toEqual(['/plan-ceo-review\r']);
      expect(result.observation.evidence).toContain('DONE');
    }
    if (scenario === 'timeout-after-question') {
      expect(result.observation.step0Count).toBe(1);
      expect(result.observation.reviewCount).toBe(1);
      expect(result.observation.evidence).toContain('WORK_IN_PROGRESS');
    }
  }, 15_000);

  test.each(['invalid-nan', 'invalid-infinity'])('%s fails before any PTY launch', async scenario => {
    const result = await runFakeCounting('**DONE**', scenario);
    expect(result.error).toContain('timeoutMs must be finite');
    expect(result.launches).toBe(0);
    expect(result.sends).toEqual([]);
  }, 15_000);

  test('setup that exhausts the case budget cannot launch model work', async () => {
    const result = await runFakeCounting('**DONE**', 'setup-exhausted');
    expect(result.helperTimeoutMs).toBeLessThan(0);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.observation.summary).toContain('before PTY launch');
    expect(result.launches).toBe(0);
    expect(result.sends).toEqual([]);
  }, 15_000);
});


test('real Bun retry starts only after the prior counting deadline closes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'counting-bun-retry-'));
  const receipt = path.join(root, 'events.jsonl');
  const nestedTest = path.join(root, 'counting-deadline.test.ts');
  const fixture = path.join(import.meta.dir, 'fixtures', 'plan-skill-counting.ts');
  fs.writeFileSync(nestedTest, `import { registerDeadlineRetryProbe } from ${JSON.stringify(fixture)};\nawait registerDeadlineRetryProbe(${JSON.stringify(receipt)});\n`);
  const child = Bun.spawn([process.execPath, 'test', '--retry', '1', nestedTest], {
    cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stdout + stderr).toBe(0);
    const events = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => `${event.attempt}:${event.kind}`)).toEqual([
      '1:start', '1:closed', '1:returned', '1:finalized',
      '2:start', '2:closed', '2:returned', '2:finalized',
    ]);
    expect(events.filter(event => event.kind === 'returned').every(event =>
      event.closed && event.outcome === 'timeout' && event.elapsedMs < event.outerMs)).toBe(true);
    expect(stderr).not.toContain('timed out after');
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
