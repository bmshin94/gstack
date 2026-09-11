import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
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

// The failure-only viewport is now retained explicitly; all other payload redaction stays enforced.
const withoutDecodedFrame = (record: unknown) => JSON.stringify(record, (key, value) => key === 'decodedFrame' ? undefined : value);

describe('real plan counting loop with an isolated fake PTY', () => {
  test.skipIf(process.platform === 'win32').each(['binding', 'timeout-menu', 'timeout-frame-conflict'])(
    'failure frame retention preserves the exact sampled viewport and epochs (%s)', async variant => {
      const result = await runFakeCounting('**DONE**', `retention-${variant}`);
      if (variant === 'binding') expect(result.error).toContain('cannot be bound');
      else expect(result.observation.outcome).toBe('timeout');
      expect(result.sends).toEqual(['/plan-ceo-review\r']);
      expect(result.retainedBeforeClose).toBe(true);
      expect(result.closed && result.nativeRemoved).toBe(true);
      const frame = result.diagnostic.counting.decodedFrame;
      expect(frame).toMatchObject({ source: 'last-sampled-current-screen', rawEnd: result.lastFixtureFrame.rawEnd,
        text: result.lastFixtureFrame.text, codeUnits: result.lastFixtureFrame.text.length, truncated: false,
        sha256: createHash('sha256').update(result.lastFixtureFrame.text).digest('hex') });
      const sampled = JSON.parse(result.diagnostic.observation.text).lastObservation;
      expect(frame.observedAtMs).toBe(sampled.observedAtMs);
      expect(frame.questionSince).toBe(sampled.frame.questionSince);
      expect(frame.viewportInputSince).toBe(sampled.frame.viewportInputSince);
      expect(result.diagnostic.rawTail.text).toBeUndefined();
      expect(result.diagnostic.visibleTail.text).toBeUndefined();
      expect(JSON.stringify(result.diagnostic)).not.toMatch(/PRIVATE_(THINKING|SIGNATURE|BASH_ENV|RESULT|WRITE_CONTENT)/);
      if (variant === 'timeout-frame-conflict') expect(sampled.permissionMenu).toEqual({ numbered: true, permissionTail: true, permissionWindow: false });
    }, 15_000);

  test('failure frame retention does not invent a frame for a boot timeout', async () => {
    const result = await runFakeCounting('**DONE**', 'retention-timeout-boot');
    expect(result.observation.outcome).toBe('timeout');
    expect(result.diagnostic.counting.decodedFrame).toBeNull();
    expect(result.lastFixtureFrame).toBeNull();
    expect(result.sends).toEqual([]);
    expect(result.retainedBeforeClose && result.closed).toBe(true);
  }, 15_000);

  test.skipIf(process.platform === 'win32')('concurrent hook-only questions retain their exact owned inputs before cleanup without an answer', async () => {
    const result = await runFakeCounting('**DONE**', 'retention-questions');
    expect(result.error).toContain('Concurrent native AskUserQuestion calls are unsupported');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation).toBeUndefined();
    expect(result.closed).toBe(true);
    expect(result.nativeRemoved).toBe(true);
    expect(result.retainedBeforeClose).toBe(true);
    const evidence = result.diagnostic.counting.questionEvidence;
    expect(evidence.count).toBe(2);
    expect(evidence.observed.slice().sort((a: any, b: any) => a.id.text.localeCompare(b.id.text)).map((call: any) => [call.id.text, call.observedResult, call.resultAtRetention])).toEqual([
      ['tool-1', 'pending', 'absent'], ['tool-2', 'pending', 'absent'],
    ]);
    expect(evidence.hookEvents.map((event: any) => JSON.parse(event.inputJson.text).questions[0].question).sort()).toEqual([
      'D4 — Keep scope narrow?', 'D5 — Which review mode?',
    ]);
    expect(evidence.observed.map((call: any) => JSON.parse(call.questionsJson.text)[0].question).sort()).toEqual([
      'D4 — Keep scope narrow?', 'D5 — Which review mode?',
    ]);
    expect(evidence.nativeBlocks.rows).toEqual([]);
    expect(evidence.hookReadError).toBeNull();
    expect(withoutDecodedFrame(result.diagnostic)).not.toContain('PRIVATE_');
  }, 15_000);
  test.skipIf(process.platform === 'win32')('reader input conflict retains the new hook/native question pair before the last observation updates', async () => {
    const result = await runFakeCounting('**DONE**', 'retention-questions-conflict');
    expect(result.error).toContain('Native AskUserQuestion changed input for an existing tool ID');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation).toBeUndefined();
    expect(result.retainedBeforeClose).toBe(true);
    expect(result.nativeRemoved).toBe(true);
    expect(result.closed).toBe(true);
    const evidence = result.diagnostic.counting.questionEvidence;
    expect(evidence.count).toBe(0);
    expect(evidence.observed).toEqual([]);
    expect(evidence.candidateCount).toBe(1);
    expect(evidence.hookEvents[0].id.text).toBe('tool-1');
    expect(JSON.parse(evidence.hookEvents[0].inputJson.text).questions[0].question).toBe('D4 — Keep scope narrow?');
    expect(evidence.nativeBlocks.rows).toHaveLength(1);
    expect(evidence.nativeBlocks.rows[0].stopReason).toBeNull();
    expect(JSON.parse(evidence.nativeBlocks.rows[0].blockJson.text)).toMatchObject({ id: 'tool-1',
      input: { questions: [{ question: 'D4 — A different scope question' }] } });
    expect(withoutDecodedFrame(result.diagnostic)).not.toContain('PRIVATE_');
  }, 15_000);
  test.each(['ambiguous', 'binding', 'queue-operation', 'queue-content'])('early %s failure retains only owned diagnostic metadata before cleanup', async variant => {
    const result = await runFakeCounting('**DONE**', `retention-${variant}`);
    expect(result.error).toContain(variant === 'ambiguous' ? 'Ambiguous native permission owner' : variant === 'binding' ? 'cannot be bound' : 'Unsupported queue operation');
    expect(result.observation).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.closed).toBe(true);
    expect(result.nativeRemoved).toBe(true);
    expect(result.retainedBeforeClose).toBe(true);
    expect(result.diagnosticFiles).toHaveLength(1);
    const diagnostic = result.diagnostic;
    expect(withoutDecodedFrame(diagnostic)).not.toContain('PRIVATE_');
    expect(diagnostic.calls[0]).toMatchObject({ result: 'completed', input: { type: 'object', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(diagnostic.rawTail.text).toBeUndefined();
    expect(diagnostic.visibleTail.text).toBeUndefined();
    if (variant.startsWith('queue-')) {
      expect(diagnostic.counting.queueOperations.rows).toHaveLength(1);
      expect(diagnostic.counting.queueOperations.rows[0]).toMatchObject({
        operation: { text: variant === 'queue-operation' ? 'unrecognized' : 'enqueue' },
        content: { type: variant === 'queue-content' ? 'object' : 'string', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
    } else {
      expect(diagnostic.counting.permissionRequests).toHaveLength(1);
      expect(diagnostic.counting.permissionRequests[0]).toMatchObject({ name: 'Write', result: 'pending', nativeToolId: 'tool-1', input: { filePath: expect.stringContaining('/plan.md') } });
      expect(diagnostic.counting.permissionTools).toHaveLength(variant === 'ambiguous' ? 2 : 1);
      expect(diagnostic.counting.dialog.currentFileTarget).toMatchObject({ operation: 'create' });
    }
  }, 15_000);
  test('diagnostic failure cannot replace the original exception or prevent cleanup', async () => {
    const failedWrite = await runFakeCounting('**DONE**', 'retention-write-failure');
    expect(failedWrite.error).toContain('Ambiguous native permission owner');
    expect(failedWrite.diagnosticFiles).toEqual([]);
    expect(failedWrite.closed).toBe(true);
    expect(failedWrite.nativeRemoved).toBe(true);
    const original = await runFakeCounting('**DONE**', 'retention-original-error');
    expect(original.sameError).toBe(true);
    expect(original.retainedBeforeClose).toBe(true);
    expect(original.closed).toBe(true);
    expect(JSON.stringify(original.diagnostic)).not.toContain('PRIVATE_CALLBACK_ERROR');
  }, 15_000);

  test.each([
    ['menu', true, false, true],
    ['numbered', false, true, true],
    ['stale-frame', false, false, false],
  ] as const)('returned timeout retains the sampled %s guards before native cleanup', async (variant, numbered, permissionTail, fresh) => {
    const result = await runFakeCounting('**DONE**', `retention-timeout-${variant}`);
    expect(result.error).toBeUndefined();
    expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 0, reviewCount: 0, elapsedMs: result.helperTimeoutMs });
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.closed).toBe(true);
    expect(result.nativeRemoved).toBe(true);
    expect(result.retainedBeforeClose).toBe(true);
    expect(result.diagnosticFiles).toHaveLength(1);
    const diagnostic = result.diagnostic;
    expect(withoutDecodedFrame(diagnostic)).not.toContain('PRIVATE_');
    expect(diagnostic.rawTail.text).toBeUndefined();
    expect(diagnostic.visibleTail.text).toBeUndefined();
    expect(diagnostic.counting.dialog.text).toBeUndefined();
    expect(diagnostic.counting.dialog.sha256).toMatch(/^[a-f0-9]{64}$/);
    const retained = JSON.parse(diagnostic.observation.text);
    expect(retained).toMatchObject({ outcome: 'timeout', lastLoopStage: 'no-pending-question', step0Count: 0, reviewCount: 0 });
    expect(retained.lastObservation.permissionMenu).toEqual({ numbered, permissionTail, permissionWindow: permissionTail });
    expect(retained.lastObservation.frame.fresh).toBe(fresh);
    expect(result.observation.diagnostics.lastObservation.permissionMenu).toEqual({ numbered, permissionTail, permissionWindow: permissionTail });
    expect(diagnostic.counting.permissionRequests).toHaveLength(1);
    expect(diagnostic.counting.permissionRequests[0]).toMatchObject({ name: 'Write', result: 'pending', nativeToolId: 'tool-1' });
  }, 15_000);
  test('returned boot timeout retains metadata before cleanup without sending a command', async () => {
    const result = await runFakeCounting('**DONE**', 'retention-timeout-boot');
    expect(result.error).toBeUndefined();
    expect(result.observation).toMatchObject({ outcome: 'timeout', elapsedMs: result.helperTimeoutMs, step0Count: 0, reviewCount: 0 });
    expect(result.sends).toEqual([]);
    expect(result.retainedBeforeClose).toBe(true);
    expect(result.diagnosticFiles).toHaveLength(1);
    expect(JSON.parse(result.diagnostic.observation.text)).toMatchObject({ outcome: 'timeout', lastLoopStage: 'boot-grace', lastObservation: null });
    expect(result.closed).toBe(true);
    expect(result.nativeRemoved).toBe(true);
  }, 15_000);
  test('diagnostic write failure preserves the returned timeout and session cleanup', async () => {
    const result = await runFakeCounting('**DONE**', 'retention-timeout-write-failure');
    expect(result.error).toBeUndefined();
    expect(result.observation).toMatchObject({ outcome: 'timeout', elapsedMs: result.helperTimeoutMs, step0Count: 0, reviewCount: 0 });
    expect(result.observation.diagnostics.lastObservation.permissionMenu).toEqual({ numbered: true, permissionTail: false, permissionWindow: false });
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.diagnosticFiles).toEqual([]);
    expect(result.closed).toBe(true);
    expect(result.nativeRemoved).toBe(true);
  }, 15_000);

  test('null phase ceiling reaches owned completion beyond the old cap and picks manual handoff once', async () => {
    const result = await runFakeCounting('**DONE**', 'ceiling-null');
    expect(result.error).toBeUndefined();
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 6 });
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1', '1', '1', '1', '2']);
    expect(result.pickerCalls).toHaveLength(7);
    expect(result.pickerCalls.map((entry: any) => entry.isFirst)).toEqual([true, false, false, false, false, false, false]);
    const handoff = result.pickerCalls.filter((entry: any) => entry.question.question === 'How should we continue after this review?');
    expect(handoff).toHaveLength(1);
    expect(handoff[0].question).toMatchObject({ header: 'How should we continue after this review?', multiSelect: false,
      options: [{ label: 'Run eng review now', description: 'Choose Run eng review now' }, { label: 'Continue manually', description: 'Choose Continue manually' }] });
    expect(result.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual([[1], [1], [1], [1], [1], [1], [2]]);
    expect(result.sendTimes.every((ms: number) => ms < result.caseBudgetMs)).toBe(true);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('numeric phase ceiling still stops before further questions', async () => {
    const result = await runFakeCounting('**DONE**', 'ceiling-numeric');
    expect(result.observation).toMatchObject({ outcome: 'ceiling_reached', step0Count: 1, reviewCount: 4 });
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1', '1', '1']);
    expect(result.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual([[1], [1], [1], [1], [1]]);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('zero phase ceiling preserves its immediate-stop behavior', async () => {
    const result = await runFakeCounting('**DONE**', 'ceiling-zero');
    expect(result.observation).toMatchObject({ outcome: 'ceiling_reached', step0Count: 0, reviewCount: 0 });
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation.fingerprints).toEqual([]);
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['timeout', 'no-owner', 'no-ack'])('null phase ceiling preserves deadline, ownership, and ACK requirements (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `ceiling-null-${variant}`);
    expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 1, reviewCount: variant === 'no-owner' ? 6 : 5 });
    expect(result.observation.elapsedMs).toBe(result.helperTimeoutMs);
    expect(result.sendTimes.every((ms: number) => ms < result.caseBudgetMs)).toBe(true);
    expect(result.caseElapsedMs).toBeLessThan(result.caseBudgetMs + PLAN_SKILL_COUNT_FINALIZE_MS);
    expect(result.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual(
      variant === 'no-owner' ? [[1], [1], [1], [1], [1], [1], [2]] : [[1], [1], [1], [1], [1], [1]]);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('question picker receives every native tab and records its selected indexes only after final ACK', async () => {
    const result = await runFakeCounting('**DONE**', 'question-picker-multi');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '2', '\r']);
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 1 });
    expect(result.pickerCalls.map((entry: any) => entry.isFirst)).toEqual([true, false, false]);
    expect(result.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual([[1], [1, 2]]);
    expect(result.observation.fingerprints[1].questions).toEqual(result.pickerCalls.slice(1).map((entry: any) => entry.question));
    expect(result.closed).toBe(true);
    const noAck = await runFakeCounting('**DONE**', 'question-picker-multi-no-ack');
    expect(noAck.sends).toEqual(['/plan-ceo-review\r', '1', '1', '2', '\r']);
    expect(noAck.observation).toMatchObject({ outcome: 'timeout', step0Count: 1, reviewCount: 0 });
    expect(noAck.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual([[1]]);
  }, 15_000);
  test('firstAUQPick takes precedence over the per-question picker exactly once', async () => {
    const result = await runFakeCounting('**DONE**', 'question-picker-first');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '2', '1', '1']);
    expect(result.pickerCalls).toHaveLength(2);
    expect(result.pickerCalls.map((entry: any) => entry.isFirst)).toEqual([false, false]);
    expect(result.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual([[2], [1], [1]]);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('redraw cannot call the picker again or add a selected option', async () => {
    const result = await runFakeCounting('**DONE**', 'question-picker-redraw');
    expect(result.redraws).toBe(1);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.pickerCalls).toHaveLength(3);
    expect(result.observation.fingerprints.map((fp: any) => fp.selectedOptions)).toEqual([[1], [1], [1]]);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test.each(['stale-focus', 'no-ack'])('preview picker is called once but cannot record a selection without ACK (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `preview-menu-picker-${variant}`);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '2', ...(variant === 'no-ack' ? ['\r'] : [])]);
    expect(result.pickerCalls).toHaveLength(1);
    expect(result.pickerCalls[0].isFirst).toBe(true);
    expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 0, reviewCount: 0 });
    expect(result.observation.fingerprints).toEqual([]);
    expect(result.closed).toBe(true);
  }, 15_000);

  test.each(['no-owner', 'pending-tool', 'pending-auq', 'pending-file', 'pending-bytes', 'frame-race'])('terminal diagnostics distinguish blocked native state without approving the visible plan (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `terminal-diagnostic-${variant}`);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation.reviewCount).toBe(0);
    const diagnostic = result.observation.diagnostics;
    const last = diagnostic.lastObservation;
    expect(diagnostic.observationAgeMs).toBeGreaterThanOrEqual(0);
    expect(last.questionWindowPlanReady).toBe(true);
    expect(last.visiblePlanReady).toBe(true);
    expect(last.ready).toBe(variant !== 'no-owner');
    expect(last.hasPendingWork).toBe(['pending-tool', 'pending-auq', 'pending-file', 'frame-race'].includes(variant));
    if (variant === 'pending-tool') expect(last.pendingTools.items).toEqual([{ id: 'tool-2', name: 'ToolSearch' }]);
    if (variant === 'pending-auq') {
      expect(last.pendingQuestions.ids).toEqual(['tool-2']);
      expect(last.questionMatch).toBe('none');
    }
    if (variant === 'pending-file') {
      expect(last.pendingFileRequests.count).toBe(1);
      expect(last.pendingFileRequests.items[0].name).toBe('Write');
    }
    if (variant === 'pending-bytes') {
      expect(last.pendingBytes).toBeGreaterThan(0);
      expect(last.frame).toBeNull();
      expect(last.nativeStable).toBeNull();
      expect(diagnostic.lastLoopStage).toBe('pending-native-bytes');
    } else {
      expect(last.frame.planReady).toBe(true);
      expect(last.nativeStable).toBe(variant !== 'frame-race');
    }
    if (variant === 'frame-race') expect(diagnostic.lastLoopStage).toBe('native-frame-changed');
    expect(withoutDecodedFrame(diagnostic)).not.toContain('PRIVATE_');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('terminal diagnostics retain bounded IDs and names without native inputs', async () => {
    const result = await runFakeCounting('**DONE**', 'terminal-diagnostic-bounded');
    const diagnostic = result.observation.diagnostics;
    expect(result.observation.outcome).toBe('timeout');
    expect(diagnostic.lastObservation.pendingTools.count).toBe(20);
    expect(diagnostic.lastObservation.pendingTools.items).toHaveLength(8);
    for (const item of diagnostic.lastObservation.pendingTools.items) {
      expect(item.id.length).toBe(128);
      expect(item.name.length).toBe(64);
      expect(Object.keys(item).sort()).toEqual(['id', 'name']);
    }
    expect(withoutDecodedFrame(diagnostic)).not.toContain('PRIVATE_');
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
  }, 15_000);
  test('terminal diagnostics distinguish the existing full-plan terminal from a stale decoded frame', async () => {
    const ready = await runFakeCounting('**DONE**', 'terminal-diagnostic-ready');
    expect(ready.observation.outcome).toBe('plan_ready');
    expect(ready.observation.diagnostics.lastObservation.ready).toBe(true);
    expect(ready.observation.diagnostics.lastObservation.hasPendingWork).toBe(false);
    expect(ready.sends).toEqual(['/plan-ceo-review\r']);
    const stale = await runFakeCounting('**DONE**', 'exit-confirmation-stale-frame');
    expect(stale.observation.outcome).toBe('timeout');
    expect(stale.observation.diagnostics.lastObservation.frame.fresh).toBe(false);
    const corrected = await runFakeCounting('**DONE**', 'screen-only-plan-ready');
    expect(corrected.observation.outcome).toBe('timeout');
    expect(corrected.observation.diagnostics.lastObservation.questionWindowPlanReady).toBe(false);
    expect(corrected.observation.diagnostics.lastObservation.frame.planReady).toBe(true);
  }, 15_000);
  test('letter-prefixed retained mode ACK ends setup exactly once before later review ACKs', async () => {
    const result = await runFakeCounting('**DONE**', 'letter-prefixed-mode');
    expect(result.error).toBeUndefined();
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.fingerprints.map((entry: { preReview: boolean }) => entry.preReview)).toEqual([true, false, false]);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('letter-prefixed mode without native ACK cannot count or end setup', async () => {
    const result = await runFakeCounting('**DONE**', 'letter-prefixed-mode-no-ack');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1']);
    expect(result.observation.step0Count).toBe(0);
    expect(result.observation.reviewCount).toBe(0);
    expect(result.observation.fingerprints).toEqual([]);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('parenthesized retained mode ACK ends setup exactly once before later review ACKs', async () => {
    const result = await runFakeCounting('**DONE**', 'parenthesized-mode');
    expect(result.error).toBeUndefined();
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.fingerprints.map((entry: { preReview: boolean }) => entry.preReview)).toEqual([true, false, false]);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('parenthesized mode without native ACK cannot count or end setup', async () => {
    const result = await runFakeCounting('**DONE**', 'parenthesized-mode-no-ack');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1']);
    expect(result.observation.step0Count).toBe(0);
    expect(result.observation.reviewCount).toBe(0);
    expect(result.observation.fingerprints).toEqual([]);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
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
  test.each(['fresh', 'controls'])('one owned permission repaint requires a fresh exact frame and restores only after ACK (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', 'permission-repaint-' + variant);
    expect(result.error).toBeUndefined();
    expect(result.resizes).toEqual([[240, 120], [240, 40]]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1']);
    expect(result.permissionWrites).toEqual(['create']);
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 0 });
    expect(result.terminalCloseCount).toBe(1);
    expect(result.closed).toBe(true);
  });
  test.each(['malformed', 'mismatch'])('malformed permission controls remain refused after one repaint (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', 'permission-repaint-controls-' + variant);
    expect(result.resizes).toEqual([[240, 120]]);
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.permissionWrites).toEqual([]);
    expect(result.error).toContain('cannot be bound');
    expect(result.terminalCloseCount).toBe(1);
    expect(result.closed).toBe(true);
  });
  test.each(['no-output', 'still-conflicting', 'owner-change', 'failure', 'deadline', 'no-ack'])
  ('permission repaint preserves the %s boundary', async variant => {
    const result = await runFakeCounting('**DONE**', 'permission-repaint-' + variant);
    expect(result.resizes).toEqual(variant === 'deadline' ? [] : [[240, 120]]);
    expect(result.sends).toEqual(variant === 'no-ack' ? ['/plan-ceo-review\r', '1\r'] : ['/plan-ceo-review\r']);
    expect(result.permissionWrites).toEqual(variant === 'no-ack' ? ['create'] : []);
    if (variant === 'owner-change') expect(result.error).toMatch(/changed input|changed ownership/);
    else if (variant === 'failure') expect(result.error).toContain('controlled permission resize failure');
    else { expect(result.error).toBeUndefined(); expect(result.observation.outcome).toBe('timeout'); }
    expect(result.terminalCloseCount).toBe(1);
    expect(result.closed).toBe(true);
  });
  test('full current-frame permission keeps a long owned path through the real counting loop', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-long-frame');
    expect(result.error).toBeUndefined();
    expect(result.longPermissionFrame.length).toBeGreaterThan(1500);
    expect(result.longPermissionFrame).toContain('Yes, and always allow access to');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1']);
    expect(result.permissionWrites).toEqual(['create']);
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
    expect(result.closed).toBe(true);
  });
  test.each(['stale', 'mismatch', 'ambiguous'])('full current-frame permission retains counting %s refusal', async variant => {
    const result = await runFakeCounting('**DONE**', 'permission-long-frame-' + variant);
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.permissionWrites).toEqual([]);
    if (variant === 'stale') expect(result.observation.outcome).toBe('timeout');
    else expect(result.error).toMatch(/cannot be bound|Ambiguous native permission owner/);
    expect(result.closed).toBe(true);
  });
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
  test.each(['normal', 'pick-two'])('an active owned file dialog can advance before a queued native question (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `permission-final-queued-question-${variant}`);
    const answer = variant === 'pick-two' ? '2' : '1';
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', answer, answer, answer, '1\r']);
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.prematureAnswers).toEqual([]);
    expect(result.permissionWrites).toEqual(['create', 'overwrite']);
    expect(result.permissionAckIds).toEqual(result.permissionGrantIds);
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['mismatch', 'ambiguous', 'missing-request', 'stale', 'malformed'])('a queued question cannot weaken the file permission %s guard', async variant => {
    const result = await runFakeCounting('**DONE**', `permission-final-queued-question-${variant}`);
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.permissionWrites).toEqual([]);
    if (variant === 'mismatch') expect(result.error).toContain('cannot be bound');
    else if (variant === 'ambiguous') expect(result.error).toContain('Ambiguous native permission owner');
    else expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a file grant with a queued question still requires its native ACK and a question paint', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-final-queued-question-no-ack');
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r']);
    expect(result.permissionWrites).toEqual(['create']);
    expect(result.permissionAckIds).toEqual([]);
    expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 0, reviewCount: 0 });
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a later changed-content overwrite has one owned grant and ACK before terminal completion', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-final-repeat-overwrite');
    expect(result.error).toBeUndefined();
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.prematureAnswers).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1', '1\r', '1\r']);
    expect(result.permissionWrites).toEqual(['create', 'overwrite', 'overwrite']);
    expect(result.permissionGrantIds).toHaveLength(3);
    expect(new Set(result.permissionGrantIds).size).toBe(3);
    expect(result.permissionAckIds).toEqual(result.permissionGrantIds);
    expect(result.writtenPlanLines).toBe(519);
    expect(result.writtenPlanTail).toEndWith('## GSTACK REVIEW REPORT\nVERDICT: APPROVED\nAnother overwrite');
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['no-prior-ack', 'error-prior-ack', 'repeat-identical', 'mismatch'])('file permission refuses unsafe repeated ownership (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `permission-final-${variant}`);
    if (variant === 'repeat-identical') {
      expect(result.error).toBe('Error: Indistinguishable repeated native file permission request');
      expect(result.permissionGrantIds).toHaveLength(2);
      expect(result.permissionAckIds).toEqual(result.permissionGrantIds);
    } else expect(result.error).toMatch(/Ambiguous native permission|Repeated native permission|changed input|cannot be bound/);
    expect(result.permissionWrites).toEqual(variant === 'repeat-identical' ? ['create', 'overwrite'] : ['create']);
    expect(result.sends.filter((value: string) => value === '1\r')).toHaveLength(variant === 'repeat-identical' ? 2 : 1);
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['native', 'early', 'arrival-race', 'stale-redraw'])('a later owned Edit appends the report after the prior Edit completes (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `permission-edit-${variant}`);
    expect(result.error).toBeUndefined();
    expect(result.prematureAnswers).toEqual([]);
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.raceInjected).toBe(variant === 'arrival-race');
    expect(result.fileNativeBeforeGrant).toEqual([true, variant === 'native']);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1', '1', '1', '1\r']);
    expect(result.permissionWrites).toEqual(['edit', 'edit']);
    expect(result.writtenPlanTail).toEndWith('VERDICT: APPROVED');
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('a second owned Edit grant cannot complete without its own later native result', async () => {
    const result = await runFakeCounting('**DONE**', 'permission-edit-no-final-ack');
    expect(result.error).toBeUndefined();
    expect(result.fileNativeBeforeGrant).toEqual([true, false]);
    expect(result.permissionWrites).toEqual(['edit', 'edit']);
    expect(result.sends.filter((value: string) => value === '1\r')).toHaveLength(2);
    expect(result.observation.outcome).toBe('timeout');
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
  test.each(['normal', 'no-focus-choice', 'ascii-fallback', 'current-frame', 'history', 'early-only', 'early-unfinished', 'early-persisted'])('native ExitPlanMode confirmation is a read-only counting terminal (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `exit-confirmation-${variant}`);
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.permissionWrites).toEqual([]);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.fingerprints).toHaveLength(3);
    expect(result.observation.outcome).toBe('plan_ready');
    expect(result.observation.summary).toContain('awaiting its current native confirmation');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('early ExitPlanMode also waits at the existing full-plan confirmation without approving it', async () => {
    const result = await runFakeCounting('**DONE**', 'exit-confirmation-early-full-plan');
    expect(result.observation.outcome).toBe('plan_ready');
    expect(result.observation.summary).toContain('Ready to execute');
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.fingerprints).toHaveLength(3);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.permissionWrites).toEqual([]);
    expect(result.closed).toBe(true);
  }, 15_000);
  test('early ExitPlanMode owner replacement resamples even while ready stays true', async () => {
    const result = await runFakeCounting('**DONE**', 'exit-confirmation-early-owner-arrival-race');
    expect(result.observation.outcome).toBe('plan_ready');
    expect(result.raceInjected).toBe(true);
    expect(result.postExitOwnerRaceScreens).toBeGreaterThan(0);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.permissionWrites).toEqual([]);
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['no-owner', 'unfinished-owner', 'foreign-owner', 'tool-search', 'completed-owner', 'error-owner',
    'pending-question', 'pending-write', 'pending-file-request', 'completed-arrival-race', 'write-arrival-race',
    'early-completed', 'early-error', 'early-pending-write', 'early-pending-bytes', 'early-completed-arrival-race'])('native ExitPlanMode confirmation cannot replace pending ownership and stable native state (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `exit-confirmation-${variant}`);
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.permissionWrites).toEqual([]);
    expect(result.raceInjected).toBe(variant.endsWith('arrival-race'));
    expect(result.observation.step0Count).toBe(1);
    // An incomplete row pauses the whole native observation before counting
    // the last ACK; its visible terminal cannot bypass that existing guard.
    expect(result.observation.reviewCount).toBe(variant === 'early-pending-bytes' ? 1 : 2);
    if (variant === 'early-pending-bytes') expect(result.observation.diagnostics.lastLoopStage).toBe('pending-native-bytes');
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['missing-rule', 'rounded-rule', 'short-rule-fallback', 'clipped-no', 'wrong-mode', 'no-pointer', 'duplicate-pointer', 'duplicate-option',
    'extra-option', 'invented-footer', 'prose', 'quoted', 'fenced', 'open-fence'])('native ExitPlanMode confirmation refuses incomplete or copied modal text (%s)', async variant => {
    const result = await runFakeCounting('**DONE**', `exit-confirmation-${variant}`);
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.permissionWrites).toEqual([]);
    expect(result.observation.step0Count).toBe(1);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('native ExitPlanMode confirmation cannot reuse a frame from before the latest input', async () => {
    const result = await runFakeCounting('**DONE**', 'exit-confirmation-stale-frame');
    expect(result.error).toBeUndefined();
    expect(result.sends).toEqual(['/plan-ceo-review\r']);
    expect(result.observation.step0Count).toBe(0);
    expect(result.observation.reviewCount).toBe(0);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('cursor-corrected question text matches its native invocation and still requires acknowledgement', async () => {
    const result = await runFakeCounting('**DONE**', 'screen-question-redraw');
    expect(result.unsolicitedWrites).toEqual([]);
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
    expect(result.observation.reviewCount).toBe(2);
    expect(result.observation.outcome).toBe('completion_summary');
  }, 15_000);
  test('native Bash card sends one current grant and completes only after its exact native result', async () => {
    const result = await runFakeCounting('**DONE**', 'native-bash-valid');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r']);
    expect(result.permissionGrantIds).toEqual(['tool-1']);
    expect(result.permissionAckIds).toEqual(['tool-1']);
    expect(result.observation.outcome).toBe('completion_summary');
    expect(result.closed).toBe(true);
  }, 15_000);
  test('native Bash card cannot complete from a sent grant without its native acknowledgment', async () => {
    const result = await runFakeCounting('**DONE**', 'native-bash-no-ack');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r']);
    expect(result.permissionGrantIds).toEqual(['tool-1']);
    expect(result.permissionAckIds).toEqual([]);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['stale', 'history', 'clipped', 'wrong-focus', 'command-mismatch', 'ambiguous'])(
    'native Bash card preserves refusal for %s', async variant => {
      const result = await runFakeCounting('**DONE**', `native-bash-${variant}`);
      expect(result.sends).toEqual(['/plan-ceo-review\r']);
      expect(result.permissionGrantIds).toEqual([]);
      expect(result.permissionAckIds).toEqual([]);
      expect(result.closed).toBe(true);
      if (variant === 'ambiguous') expect(result.error).toContain('Ambiguous native permission owner');
      else if (variant === 'command-mismatch' || variant === 'clipped') expect(result.error).toContain('cannot be bound');
      else expect(result.observation.outcome).toBe('timeout');
    }, 15_000);
  test('queued AUQ follows its current singleton Bash grant and separate native acknowledgment', async () => {
    const result = await runFakeCounting('**DONE**', 'native-bash-queued-question');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r', '1']);
    expect(result.permissionGrantIds).toEqual(['tool-1']);
    expect(result.permissionAckIds).toEqual(['tool-1']);
    expect(result.bashQuestionAckIds).toEqual(['tool-2']);
    expect(result.prematureAnswers).toEqual([]);
    expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1 });
    expect(result.closed).toBe(true);
  }, 15_000);
  test('queued AUQ cannot advance from a Bash grant before its native result', async () => {
    const result = await runFakeCounting('**DONE**', 'native-bash-queued-no-ack');
    expect(result.sends).toEqual(['/plan-ceo-review\r', '1\r']);
    expect(result.permissionGrantIds).toEqual(['tool-1']);
    expect(result.permissionAckIds).toEqual([]);
    expect(result.bashQuestionAckIds).toEqual([]);
    expect(result.prematureAnswers).toEqual([]);
    expect(result.observation.outcome).toBe('timeout');
    expect(result.closed).toBe(true);
  }, 15_000);
  test.each(['file', 'ambiguous', 'unknown', 'malformed', 'mismatch', 'stale'])(
    'queued AUQ cannot authorize a Bash card with %s ownership evidence', async variant => {
      const result = await runFakeCounting('**DONE**', `native-bash-queued-${variant}`);
      expect(result.sends).toEqual(['/plan-ceo-review\r']);
      expect(result.permissionGrantIds).toEqual([]);
      expect(result.permissionAckIds).toEqual([]);
      expect(result.bashQuestionAckIds).toEqual([]);
      expect(result.closed).toBe(true);
      if (variant === 'mismatch') expect(result.error).toContain('cannot be bound');
      else if (variant === 'malformed') expect(result.error).toContain('Unsupported native permission');
      else expect(result.observation.outcome).toBe('timeout');
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

  test.each(['nan', 'infinity', 'negative', 'fraction', 'unsafe'])('invalid numeric phase cap (%s) fails before PTY launch', async variant => {
    const result = await runFakeCounting('**DONE**', `invalid-cap-${variant}`);
    expect(result.error).toContain('reviewCountCeiling must be null or a nonnegative safe integer');
    expect(result.launches).toBe(0);
    expect(result.sends).toEqual([]);
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

test('counting commits a preview clipping-ruler focus only through native acknowledgement', async () => {
  const result = await runFakeCounting('**DONE**', 'preview-menu-clipping-ruler');
  expect(result.error).toBeUndefined();
  expect(result.sends).toEqual(['/plan-ceo-review\r', '2', '\r', '2', '\r', '2', '\r']);
  expect(result.prematureAnswers).toEqual([]);
  expect(result.resizes).toEqual([]);
  expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
  expect(result.closed).toBe(true);
}, 15_000);

test.each(['malformed', 'no-ack'])('counting preview clipping-ruler refuses %s completion', async suffix => {
  const result = await runFakeCounting('**DONE**', `preview-menu-clipping-ruler-${suffix}`);
  expect(result.sends).toEqual(['/plan-ceo-review\r', '2', ...(suffix === 'no-ack' ? ['\r'] : [])]);
  expect(result.resizes).toEqual([]);
  expect(result.observation).toMatchObject({ outcome: 'timeout', step0Count: 0, reviewCount: 0 });
  expect(result.closed).toBe(true);
}, 15_000);


test('counting expands an owned clipped question then restores baseline only after native ACK', async () => {
  const result = await runFakeCounting('**DONE**', 'viewport-restored');
  expect(result.error).toBeUndefined();
  expect(result.resizes).toEqual([[240, 80], [240, 40]]);
  expect(result.sends).toEqual(['/plan-ceo-review\r', '1', '1', '1']);
  expect(result.observation).toMatchObject({ outcome: 'completion_summary', step0Count: 1, reviewCount: 2 });
  expect(result.terminalCloseCount).toBe(1);
  expect(result.closed).toBe(true);
}, 15_000);

for (const [scenario, resizes] of [
  ['viewport-cap', [[240, 80], [240, 120]]],
  ['viewport-no-output', [[240, 80]]],
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
  expect(result.resizes).toEqual([[240, 80], [240, 40]]);
  expect(result.sends).toEqual(['/plan-ceo-review\r', '1']);
  expect(result.observation).toMatchObject({ outcome: 'plan_ready', step0Count: 1, reviewCount: 0 });
  expect(result.closed).toBe(true);
}, 15_000);
