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
  test('pre-transcript question events drive real counting only after native acknowledgements', async () => {
    const result = await runFakeCounting('**DONE**', 'hook-only');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('omitted multiSelect defaults preserve acknowledged counting and completion', async () => {
    const result = await runFakeCounting('**DONE**', 'hook-omitted-default');
    expect(result.error).toBeUndefined();
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('an early hook invocation without a native acknowledgement cannot count', async () => {
    const result = await runFakeCounting('**DONE**', 'hook-no-ack');
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(0);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a current create dialog is decoded and granted only for its exact owned path', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-create');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
  }, 15_000);
  test('a current overwrite dialog is decoded and grants only the exact native Write before completion', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-overwrite');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['native', 'overwrite', 'stale-create', 'arrival-race', 'first-arrival-race', 'completion-arrival-race', 'ready-arrival-race', 'old-completion', 'old-ready'])('CREATE to final OVERWRITE waits for owned permission and native completion (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `permission-final-${variant}`);
    expect(result.error).toBeUndefined();
    expect(result.prematureAnswers).toEqual([]);
    expect(result.raceInjected).toBe(variant.endsWith('arrival-race'));
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1', '1\r']);
    expect(result.permissionWrites).toEqual(['create', 'overwrite']);
    expect(result.writtenPlanLines).toBe(518);
    expect(result.writtenPlanTail).toEndWith('## GSTACK REVIEW REPORT\nVERDICT: APPROVED');
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['no-prior-ack', 'error-prior-ack', 'repeat-overwrite', 'mismatch'])('file permission refuses unsafe repeated ownership (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `permission-final-${variant}`);
    expect(result.error).toMatch(/Ambiguous native permission|Repeated native permission|changed input|cannot be bound/);
    expect(result.permissionWrites).toEqual(variant === 'repeat-overwrite' ? ['create', 'overwrite'] : ['create']);
    expect(result.sends.filter((value: string) => value === '1\r')).toHaveLength(variant === 'repeat-overwrite' ? 2 : 1);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('an unowned overwrite preview never grants or completes the report', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-final-unowned');
    expect(result.error).toBeUndefined();
    expect(result.permissionWrites).toEqual(['create']);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.writtenPlanLines).toBeLessThan(518);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('capture-enabled file input waits for its PermissionRequest even with a stable native Write and dialog', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-final-missing-request');
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.permissionWrites).toEqual([]);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a granted file request is sent once but cannot complete without its native result', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-final-no-final-ack');
    expect(result.error).toBeUndefined();
    expect(result.permissionWrites).toEqual(['create', 'overwrite']);
    expect(result.sends.filter((value: string) => value === '1\r')).toHaveLength(2);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a file request arriving after the frame cannot inherit a conflicting native-only Write', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-final-input-race');
    expect(result.raceInjected).toBe(true);
    expect(result.error).toContain('changed input');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.permissionWrites).toEqual([]);
    expect(result.prematureAnswers).toEqual([]);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a decoded create dialog cannot grant a different pending path', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-create-mismatch');
    expect(result.error).toContain('cannot be bound');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a second-option question preference still grants only the current file request', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-current-create-pick-two');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '2', '2', '2']);
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
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
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
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1']);
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
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1']);
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
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(0);
    expect(result.observation.outcome).toBe('timeout');
  }, 15_000);
  test('two question tabs and final submit produce one acknowledged invocation', async () => {
    const result = await runFakeCounting('**DONE**', 'multi-question');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1', '\r']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(1);
    expect(result.observation.fingerprints[1].questions).toHaveLength(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('first-question routing survives native identity and acknowledgement', async () => {
    const result = await runFakeCounting('**DONE**', 'first-route');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '2', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
  }, 15_000);
  test('identical options on a different native question wait for that question render', async () => {
    const result = await runFakeCounting('**DONE**', 'wrong-question');
    expect(result.prematureAnswers).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('an answered menu with changed repaint text cannot send or count another answer', async () => {
    const result = await runFakeCounting('**DONE**', 'stale-redraw');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test.each([['**DONE**', 'normal'], ['## Completion Summary', 'normal'], ['**DONE**', 'reused-options'], ['**DONE**', 'redraw']])('fixture precedes slash, preview does not stop, and %s completes (%s)', async (completion, scenario) => {
    const result = await runFakeCounting(completion, scenario);
    expect(result.seededBeforeSlash).toBe(true);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
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


for (const [scenario, keys] of [
  ['preview-menu-focused', ['\r', '\r', '\r']],
  ['preview-menu-mixed-options', ['2', '\r', '2', '\r', '2', '\r']],
] as const) test(`counting commits preview choices only through native acknowledgement: ${scenario}`, async () => {
  const result = await runFakeCounting('**DONE**', scenario);
  expect(result.sends).toEqual(['/plan-ceo-review\r', ...keys]);
  expect(result.prematureAnswers).toEqual([]);
  expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
  expect(result.closed).toBe(true);
}, 15_000);

test.each(['preview-menu-stale-focus', 'preview-menu-no-ack'])('counting refuses stale preview focus or missing ACK: %s', async scenario => {
  const result = await runFakeCounting('**DONE**', scenario);
  expect(result.sends).toEqual(['/plan-ceo-review\r', '2', ...(scenario.endsWith('no-ack') ? ['\r'] : [])]);
  expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 0, reviewCount: 0 });
  expect(result.closed).toBe(true);
}, 15_000);


test('counting expands an owned clipped question then restores baseline only after native ACK', async () => {
  const result = await runFakeCounting('**DONE**', 'viewport-restored');
  expect(result.error).toBeUndefined();
  expect(result.resizes).toEqual([[120, 80], [120, 40]]);
  expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
  expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
  expect(result.terminalCloseCount).toBe(1);
  expect(result.closed).toBe(true);
}, 15_000);

for (const [scenario, resizes] of [
  ['viewport-cap', [[120, 80], [120, 120]]],
  ['viewport-no-output', [[120, 80]]],
  ['viewport-flush-deadline', []],
] as const) test(`counting viewport refuses unresolved clipping: ${scenario}`, async () => {
  const result = await runFakeCounting('**DONE**', scenario);
  expect(result.resizes).toEqual(resizes);
  expect(result.sends).toEqual(['/plan-ceo-review\r']);
  expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 0, reviewCount: 0 });
  expect(result.closed).toBe(true);
  expect(result.terminalCloseCount).toBe(1);
}, 15_000);

test('a failed viewport transaction sends no answer and closes its owned session', async () => {
  const result = await runFakeCounting('**DONE**', 'viewport-resize-failure');
  expect(result.error).toContain('controlled resize failure');
  expect(result.sends).toEqual(['/plan-ceo-review\r']);
  expect(result.closed).toBe(true);
  expect(result.terminalCloseCount).toBe(1);
}, 15_000);


test('viewport restoration preserves the raw Ready marker following the actual answer', async () => {
  const result = await runFakeCounting('**DONE**', 'viewport-ready-no-restore-output');
  expect(result.error).toBeUndefined();
  expect(result.resizes).toEqual([[120, 80], [120, 40]]);
  expect(result.sends).toEqual(['/plan-ceo-review\r', '1']);
  expect(result.observation).toMatchObject({ outcome: 'plan_ready', step0Count: 1, reviewCount: 0 });
  expect(result.closed).toBe(true);
}, 15_000);
