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
