import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSdkResult, QueryProvider } from './helpers/agent-sdk-runner';
import { firstAssistantMessageToolCount, reportedThinkingTokens, assessComparison, trialArtifactStem } from './helpers/overlay-measurement';
import { runOverlayTrial, awaitOverlayWorkers, assessOverlayArms, captureOverlayQueryAttempts, type OverlayTrialOutcome } from './helpers/overlay-attempt';
import { setupLiteralWorkspace, correctLiteralTargets, snapshotWorkspace, assertReadOnlyWorkspace } from './helpers/overlay-workspace';
import { fanoutPass, higherIsBetter20Pct, lowerIsBetter20Pct, OVERLAY_FIXTURES, type OverlayFixture } from './fixtures/overlay-nudges';

function result(overrides: Partial<AgentSdkResult> = {}): AgentSdkResult {
  return {
    events: [{ type: 'result', subtype: 'success', usage: { output_tokens_details: { thinking_tokens: 31 } } }] as AgentSdkResult['events'],
    assistantTurns: [], toolCalls: [], output: 'Version 1.0.0', exitReason: 'success',
    turnsUsed: 3, durationMs: 100, firstResponseMs: 10, maxInterTurnMs: 20,
    costUsd: 0.03, model: 'claude-opus-4-7', sdkVersion: 'test', sdkClaudeCodeVersion: 'test', resolvedBinaryPath: 'test', browseErrors: [], ...overrides,
  };
}
function assistant(id: string | undefined, content: unknown[]): AgentSdkResult['assistantTurns'][number] {
  return { type: 'assistant', message: { id, content } } as AgentSdkResult['assistantTurns'][number];
}
function tool(id: string) { return { type: 'tool_use', id, name: 'Read', input: { file_path: `${id}.txt` } }; }
function fixture(overrides: Partial<OverlayFixture> = {}): OverlayFixture {
  return { id: 'unit-overlay', overlayPath: 'model-overlays/opus-4-7.md', model: 'claude-opus-4-7', trials: 3, setupWorkspace: (dir) => fs.writeFileSync(path.join(dir, 'config.json'), '{"version":"1.0.0"}'), userPrompt: 'Read version', metric: () => 31, pass: lowerIsBetter20Pct, ...overrides };
}
function temp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-unit-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('SDK overlay measurements', () => {
  test('groups thinking/tool fragments by native message id despite intervening results', () => {
    const first = assistant('A', [{ type: 'thinking', thinking: 'Inspect files' }]);
    const a = assistant('A', [tool('a')]);
    const b = assistant('A', [tool('b')]);
    const cumulative = assistant('A', [tool('a'), tool('b'), tool('c')]);
    const later = assistant('B', [tool('d')]);
    const events = [first, a, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'read' }] } }, b, cumulative, later];
    expect(firstAssistantMessageToolCount(result({ events: events as AgentSdkResult['events'], assistantTurns: [first, a, b, cumulative, later] }))).toBe(3);
  });
  test('does not count calls from a later message after a text-only first message', () => {
    expect(firstAssistantMessageToolCount(result({ assistantTurns: [assistant('A', [{ type: 'text', text: 'Hello' }]), assistant('B', [tool('a')])] }))).toBe(0);
  });
  test('empty assistant stream counts zero', () => expect(firstAssistantMessageToolCount(result())).toBe(0));
  test('missing native message identity fails instead of guessing groups', () => {
    expect(() => firstAssistantMessageToolCount(result({ assistantTurns: [assistant(undefined, [tool('a')])] }))).toThrow('message.id');
  });
  test('missing call identity fails instead of duplicating fragmented calls', () => {
    expect(() => firstAssistantMessageToolCount(result({ assistantTurns: [assistant('A', [{ type: 'tool_use', name: 'Read' }])] }))).toThrow('no id');
  });
  test('reasoning uses reported thinking tokens, not SDK turns or all output tokens', () => {
    expect(reportedThinkingTokens(result({ turnsUsed: 400 }))).toBe(31);
  });
  test.each([undefined, -1, NaN, Infinity, '31'])('missing/invalid thinking metadata fails: %s', (count) => {
    const r = result({ events: [{ type: 'result', subtype: 'success', usage: { output_tokens_details: { thinking_tokens: count } } }] as AgentSdkResult['events'] });
    expect(() => reportedThinkingTokens(r)).toThrow('thinking_tokens');
  });
  test('explicit zero thinking tokens is valid', () => {
    const r = result({ events: [{ type: 'result', subtype: 'success', usage: { output_tokens_details: { thinking_tokens: 0 } } }] as AgentSdkResult['events'] });
    expect(reportedThinkingTokens(r)).toBe(0);
  });
});

describe('correctness versus efficacy', () => {
  test('saturated full coverage does not pass the unchanged 20% criterion', () => {
    const arms = { overlay: [3, 3, 3], off: [3, 3, 3] };
    expect(higherIsBetter20Pct(arms)).toBe(false);
    expect(assessComparison(arms, 3, { direction: 'higher_is_better', minimum: 0, maximum: 3 }, higherIsBetter20Pct)).toMatchObject({ status: 'baseline_saturated', criterionMet: false });
  });
  test('zero/zero is saturation, not a 20% improvement', () => {
    const arms = { overlay: [0, 0, 0], off: [0, 0, 0] };
    expect(lowerIsBetter20Pct(arms)).toBe(false);
    expect(assessComparison(arms, 3, { direction: 'lower_is_better', minimum: 0 }, lowerIsBetter20Pct)).toMatchObject({ status: 'baseline_saturated', criterionMet: false });
  });
  test('retains recorded thinking-token failures at the original threshold', () => {
    const on = [32, 37, 28, 38, 27, 32, 27, 0, 38, 32];
    const off = [47, 38, 30, 32, 39, 28, 30, 35, 40, 35];
    expect(assessComparison({ overlay: on, off }, 10, { direction: 'lower_is_better', minimum: 0 }, lowerIsBetter20Pct)).toMatchObject({ status: 'no_measured_improvement', criterionMet: false, meanOn: 29.1, meanOff: 35.4 });
  });
  test('the original 20% improvement still passes when actually achieved', () => {
    expect(assessComparison({ overlay: [20, 20, 20], off: [30, 30, 30] }, 3, { direction: 'lower_is_better', minimum: 0 }, lowerIsBetter20Pct)).toMatchObject({ status: 'improved', criterionMet: true });
  });
  test('a worse overlay remains regression even when the baseline is at optimum', () => {
    expect(assessComparison({ overlay: [1, 1, 1], off: [0, 0, 0] }, 3, { direction: 'lower_is_better', minimum: 0 }, lowerIsBetter20Pct)).toMatchObject({ status: 'regressed', criterionMet: false });
  });
  test('partial or out-of-range arms fail as incomplete', () => {
    for (const overlay of [[3], [4, 4, 4], [NaN, 3, 3]]) {
      expect(assessComparison({ overlay, off: [2, 2, 2] }, 3, { direction: 'higher_is_better', minimum: 0, maximum: 3 }, higherIsBetter20Pct).status).toBe('incomplete');
    }
  });
  test('an absent overlay claim cannot be rescued by an apparent numeric lift', () => {
    expect(assessComparison({ overlay: [3, 3, 3], off: [0, 0, 0] }, 3, { direction: 'higher_is_better', minimum: 0, unsupportedHypothesis: 'No fanout nudge' }, fanoutPass)).toMatchObject({ status: 'unsupported_hypothesis', criterionMet: false });
  });
  test('valid baseline incompleteness is measured while overlay completeness remains mandatory', () => {
    const f = fixture({ comparison: { direction: 'higher_is_better', minimum: 0, maximum: 3 }, pass: higherIsBetter20Pct });
    const sample = (metric: number): OverlayTrialOutcome => ({ passed: true, taskCorrect: metric === 3, metric, exitReason: 'success' });
    expect(assessOverlayArms(f, [sample(3), sample(3), sample(3)], [sample(2), sample(2), sample(2)])).toMatchObject({ measurementsValid: true, correctnessPassed: true, passed: true });
    expect(assessOverlayArms(f, [sample(3), sample(3), sample(2)], [sample(0), sample(0), sample(0)])).toMatchObject({ measurementsValid: true, correctnessPassed: false, passed: false });
    expect(assessOverlayArms(f, [sample(3), sample(3), sample(3)], [sample(3), sample(3), sample(3)])).toMatchObject({ correctnessPassed: true, passed: false, comparison: { status: 'baseline_saturated' } });
  });
  test('an incomplete measurement arm never passes using its remaining samples', () => {
    const f = fixture({ comparison: { direction: 'higher_is_better', minimum: 0, maximum: 3 }, pass: higherIsBetter20Pct });
    const good: OverlayTrialOutcome = { passed: true, taskCorrect: true, metric: 3, exitReason: 'success' };
    const bad: OverlayTrialOutcome = { passed: false, taskCorrect: false, exitReason: 'harness_error' };
    expect(assessOverlayArms(f, [good, good, good], [bad, bad, bad])).toMatchObject({ measurementsValid: false, passed: false });
  });
  test('artifact names retain each Bun retry with the same trial identity', () => {
    expect(trialArtifactStem('fixture', 1, 'overlay-on', 0)).not.toBe(trialArtifactStem('fixture', 2, 'overlay-on', 0));
    expect(() => trialArtifactStem('../fixture', 1, 'overlay-on', 0)).toThrow();
  });
});

describe('literal fixture task correctness', () => {
  test('three initially broken behaviors score zero', () => temp((dir) => {
    setupLiteralWorkspace(dir);
    expect(correctLiteralTargets(dir)).toBe(0);
  }));
  test('unrelated writes cannot inflate scope coverage', () => temp((dir) => {
    setupLiteralWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'unrelated.ts'), 'export const fixed = true;');
    expect(correctLiteralTargets(dir)).toBe(0);
  }));
  test('all real repairs score three with public tests unchanged', () => temp((dir) => {
    setupLiteralWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'src/auth.ts'), 'export const canSignIn = (active, locked) => active && !locked;');
    fs.writeFileSync(path.join(dir, 'src/billing.ts'), 'export const totalCents = prices => prices.reduce((a, b) => a + b, 0);');
    fs.writeFileSync(path.join(dir, 'src/notifications.ts'), 'export const recipients = ids => [...new Set(ids)];');
    expect(correctLiteralTargets(dir)).toBe(3);
  }));
  test('weakening or removing public tests fails instead of buying a green suite', () => temp((dir) => {
    setupLiteralWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'auth.test.ts'), '');
    expect(() => correctLiteralTargets(dir)).toThrow('test was changed');
  }));
  test('read-only comparison detects additional files and content mutations', () => temp((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'original');
    const before = snapshotWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'b'), 'extra');
    expect(() => assertReadOnlyWorkspace(before, snapshotWorkspace(dir))).toThrow('b');
  }));
  test('registry preserves all ten case ids and original model/trial budgets', () => {
    expect(OVERLAY_FIXTURES).toHaveLength(10);
    expect(OVERLAY_FIXTURES.every((f) => f.trials === 10 && f.comparison)).toBe(true);
    expect(OVERLAY_FIXTURES.filter((f) => f.model === 'claude-opus-4-7')).toHaveLength(5);
    expect(OVERLAY_FIXTURES.filter((f) => f.model === 'claude-sonnet-4-6')).toHaveLength(5);
  });
});

describe('complete trial lifecycle', () => {
  test.each(['success', 'runner_error', 'setup_error', 'max_turns', 'bad_terminal', 'empty_output', 'bad_metric', 'assertion', 'workspace_mutation'])('%s records once after validation', async (scenario) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-attempt-unit-'));
    const records: OverlayTrialOutcome[] = [];
    try {
      const f = fixture({
        ...(scenario === 'setup_error' ? { setupWorkspace: () => { throw new Error('setup broke'); } } : {}),
        ...(scenario === 'bad_metric' ? { metric: () => NaN } : {}),
        ...(scenario === 'assertion' ? { verify: () => { throw new Error('required output absent'); } } : {}),
      });
      const outcome = await runOverlayTrial({ fixture: f, directory: dir, invoke: async () => {
        if (scenario === 'runner_error') throw new Error('runner broke');
        if (scenario === 'workspace_mutation') fs.writeFileSync(path.join(dir, 'new.txt'), 'unrequested');
        return result({
          ...(scenario === 'max_turns' ? { exitReason: 'error_max_turns' } : {}),
          ...(scenario === 'bad_terminal' ? { events: [] } : {}),
          ...(scenario === 'empty_output' ? { output: '' } : {}),
        });
      }, record: (entry) => records.push(entry) });
      expect(records).toHaveLength(1);
      expect(records[0]).toBe(outcome);
      expect(outcome.passed).toBe(scenario === 'success');
      if (scenario === 'runner_error' || scenario === 'setup_error') expect(outcome.exitReason).toBe('harness_error');
      if (scenario === 'max_turns') expect(outcome.exitReason).toBe('error_max_turns');
      if (scenario !== 'success') expect(outcome.error).toBeTruthy();
      if (scenario !== 'runner_error' && scenario !== 'setup_error') expect(outcome.result?.costUsd).toBe(0.03);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('recording errors propagate without a duplicate record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-attempt-unit-'));
    let records = 0;
    try {
      await expect(runOverlayTrial({ fixture: fixture(), directory: dir, invoke: async () => result(), record: () => { records++; throw new Error('disk full'); } })).rejects.toThrow('disk full');
      expect(records).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('one worker failure still waits for the remaining worker before returning', async () => {
    let settled = false;
    const workers = [Promise.reject(new Error('first failed')), new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 20))];
    await expect(awaitOverlayWorkers(workers)).rejects.toThrow('overlay workers failed');
    expect(settled).toBe(true);
  });
});

describe('retry-specific native evidence', () => {
  test('retains events preceding an exception and a separate successful retry stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-capture-unit-'));
    let calls = 0;
    try {
      const provider = (() => {
        const attempt = ++calls;
        return (async function* () {
          yield { type: 'assistant', message: { id: `message-${attempt}`, content: [] } };
          if (attempt === 1) throw new Error('429 native failure');
          yield { type: 'result', subtype: 'success' };
        })();
      }) as unknown as QueryProvider;
      const wrapped = captureOverlayQueryAttempts(dir, 'fixture-attempt-1-overlay-on-0', provider);
      const consume = async () => { for await (const _event of wrapped({ prompt: 'test', options: {} })) { /* capture is under test */ } };
      await expect(consume()).rejects.toThrow('429 native failure');
      await consume();
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(4);
      expect(fs.readFileSync(path.join(dir, 'fixture-attempt-1-overlay-on-0-sdk-attempt-1.jsonl'), 'utf8')).toContain('message-1');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'fixture-attempt-1-overlay-on-0-sdk-attempt-1.json'), 'utf8'))).toMatchObject({ streamCompleted: false, error: '429 native failure' });
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'fixture-attempt-1-overlay-on-0-sdk-attempt-2.json'), 'utf8'))).toMatchObject({ streamCompleted: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('synchronous query startup exceptions leave explicit metadata', () => temp((dir) => {
    const wrapped = captureOverlayQueryAttempts(dir, 'fixture-attempt-1-overlay-on-0', (() => { throw new Error('startup failed'); }) as QueryProvider);
    expect(() => wrapped({ prompt: 'test', options: {} })).toThrow('startup failed');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'fixture-attempt-1-overlay-on-0-sdk-attempt-1.json'), 'utf8'))).toMatchObject({ streamCompleted: false, error: 'startup failed' });
  }));
});
