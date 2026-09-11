import { expect, test } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { readNativeModePosture } from './helpers/plan-skill-mode-navigation';

async function run(scenario: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'fixtures', 'plan-skill-mode-navigation.ts'), scenario], {
    cwd: path.resolve(import.meta.dir, '..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    return { ...JSON.parse(stdout.trim()), stderr };
  } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited; } }
}

test.each(['plain', 'preview', 'later', 'tabs'])('supplied-review first choice keeps native mode and ACK routing (%s)', async variant => {
  const result = await run('review-start-' + variant);
  expect(result.error).toBeUndefined();
  expect(result.navigation).toMatchObject({ modeIndex: 3, toolUseId: 'mode' });
  expect(result.calls).toBe(1);
  expect(result.sends).toEqual(variant === 'preview' ? ['2', '\r', '3'] : ['later', 'tabs'].includes(variant) ? ['2', '1', '3'] : ['2', '3']);
});
test.each(['stale', 'unowned', 'no-first-ack', 'no-mode-ack', 'no-policy', 'previous-owner', 'invalid-pick'])('supplied-review selector cannot bypass native input or completion guards (%s)', async variant => {
  const result = await run('review-start-' + variant);
  expect(result.navigation).toBeUndefined();
  expect(result.error).toBeDefined();
  expect(result.sends).toEqual(['stale', 'unowned', 'invalid-pick'].includes(variant) ? [] : variant === 'no-mode-ack' ? ['2', '3'] : ['no-policy', 'previous-owner'].includes(variant) ? ['1'] : ['2']);
  expect(result.calls).toBe(['stale', 'unowned', 'no-policy', 'previous-owner'].includes(variant) ? 0 : 1);
});
test('a first-question target mode outranks the optional supplied-review selector', async () => {
  const result = await run('review-start-mode-first');
  expect(result.error).toBeUndefined();
  expect(result.navigation).toMatchObject({ modeIndex: 3, toolUseId: 'mode' });
  expect(result.sends).toEqual(['3']);
  expect(result.calls).toBe(0);
});

test('mode navigation ignores a mode-looking preview, selects native option four and waits for its result', async () => {
  const result = await run('native');
  expect(result.error).toBeUndefined();
  expect(result.premature).toEqual([]);
  expect(result.sends).toEqual(['1', '4']);
  expect(result.navigation.modeIndex).toBe(4);
  expect(result.acknowledged).toBe(true);
}, 15_000);
test('letter-prefixed native mode selects requested expansion at index three and requires its ACK', async () => {
  const result = await run('letter-prefixed');
  expect(result.error).toBeUndefined();
  expect(result.premature).toEqual([]);
  expect(result.sends).toEqual(['1', '3']);
  expect(result.navigation).toMatchObject({ modeIndex: 3, toolUseId: 'mode' });
  expect(result.acknowledged).toBe(true);
}, 15_000);
test('letter-prefixed native mode without ACK cannot start posture', async () => {
  const result = await run('letter-prefixed-unacknowledged');
  expect(result.error).toContain('not acknowledged');
  expect(result.sends).toEqual(['1', '3']);
  expect(result.acknowledged).toBe(false);
}, 15_000);
test.each([['parenthesized', 1], ['parenthesized-hold', 3]] as const)('parenthesized retained mode selects the requested native index (%s)', async (scenario, index) => {
  const result = await run(scenario);
  expect(result.error).toBeUndefined();
  expect(result.premature).toEqual([]);
  expect(result.sends).toEqual(['1', String(index)]);
  expect(result.navigation).toMatchObject({ modeIndex: index, toolUseId: 'mode' });
  expect(result.acknowledged).toBe(true);
}, 15_000);
test('parenthesized retained mode without ACK cannot start posture', async () => {
  const result = await run('parenthesized-unacknowledged');
  expect(result.error).toContain('not acknowledged');
  expect(result.sends).toEqual(['1', '1']);
  expect(result.acknowledged).toBe(false);
}, 15_000);
test('two native tabs select with digits and submit once after both answers', async () => {
  const result = await run('multi-tab');
  expect(result.error).toBeUndefined();
  expect(result.premature).toEqual([]);
  expect(result.sends).toEqual(['1', '4', '\r']);
  expect(result.navigation).toMatchObject({ modeIndex: 4, toolUseId: 'approach' });
  expect(result.acknowledged).toBe(true);
}, 15_000);
test('a real native mode question missing the requested mode fails explicitly', async () => {
  const result = await run('missing');
  expect(result.error).toContain('Native mode AskUserQuestion');
  expect(result.error).toContain('SCOPE EXPANSION');
  expect(result.sends).toEqual(['1']);
}, 15_000);
test('mode selection without acknowledgement cannot start the posture assertion', async () => {
  const result = await run('unacknowledged');
  expect(result.error).toContain('not acknowledged');
  expect(result.sends).toEqual(['1', '4']);
  expect(result.acknowledged).toBe(false);
}, 15_000);
test.each(['read-budget', 'write-budget', 'ack-budget'])('mode navigation respects its deadline after %s work', async scenario => {
  const result = await run(scenario);
  expect(result.navigation).toBeUndefined();
  expect(result.error).toContain('30000ms');
  expect(result.sends).toEqual(scenario === 'ack-budget' ? ['1', '4'] : ['1']);
}, 15_000);
test('nonfinite mode navigation budgets fail before input', async () => {
  const result = await run('invalid-budget');
  expect(result.error).toContain('must be finite');
  expect(result.sends).toEqual([]);
}, 15_000);

test.each(['diagnostic-unmatched', 'diagnostic-unacknowledged', 'diagnostic-write'])('mode navigation retains its actual failure state before cleanup: %s', async scenario => {
  const result = await run(scenario);
  expect(result.error).toContain('Mode AskUserQuestion not reached within 30000ms');
  expect(result.navigation).toBeUndefined();
  expect(result.configRemovedBeforeArtifactRead).toBe(true);
  if (process.platform !== 'win32') expect(result.diagnosticMode).toBe(0o600);
  const diagnostic = result.diagnostic;
  expect(diagnostic.sessionId).toBe('00000000-0000-4000-8000-000000000001');
  expect(diagnostic.error).toBe(result.error);
  expect(diagnostic.selected).toBeNull();
  expect(diagnostic.priorAnswered).toBe(0);
  const native = JSON.parse(diagnostic.native.text);
  if (scenario === 'diagnostic-write') {
    expect(native.calls).toEqual([]);
    expect(native.permissionTools.map((tool: any) => tool.id)).toEqual(['write-plan']);
    expect(diagnostic.granted).toEqual([]);
    expect(result.sends).toEqual([]);
  } else {
    expect(native.calls[0].id).toBe('approach');
    expect(native.calls[0].result).toBe('pending');
    expect(diagnostic.answered).toEqual(scenario === 'diagnostic-unacknowledged'
      ? [{ id: { text: 'approach', codeUnits: 8, truncated: false }, questions: 1, submitted: false, counted: false }] : []);
    expect(result.sends).toEqual(scenario === 'diagnostic-unacknowledged' ? ['1'] : []);
  }
  if (scenario === 'diagnostic-unacknowledged') {
    expect(diagnostic.lastSend.data).toBe('1');
    expect(diagnostic.lastSend.status).toBe('returned');
    expect(diagnostic.lastSend.visibleBefore.text).toContain('Choose architecture');
    expect(diagnostic.inputRaw.text).toBe('\n❯ 1\n');
    expect(diagnostic.questionSince).toBe(diagnostic.lastSend.inputMark);
    expect(diagnostic.lastSend.rawCodeUnitsBefore).toBe(diagnostic.lastSend.inputMark);
    expect(diagnostic.lastSend.rawCodeUnitsAfter).toBe(diagnostic.lastSend.rawCodeUnitsBefore + '\n❯ 1\n'.length);
  } else expect(diagnostic.lastSend).toBeNull();
}, 15_000);

test('mode failure diagnostics bound rendered/native payloads without changing the timeout', async () => {
  const result = await run('diagnostic-truncation');
  expect(result.error).toContain('within 30000ms');
  expect(result.sends).toEqual([]);
  expect(result.diagnostic.raw.truncated).toBe(true);
  expect(result.diagnostic.inputVisible.truncated).toBe(true);
  expect(result.diagnostic.native.truncated).toBe(true);
  expect(result.diagnostic.nativeSummary.pendingBytes).toBe(0);
  expect(result.diagnostic.nativeSummary.calls[0].id.text).toBe('approach');
  expect(result.diagnostic.nativeSummary.permissionCount).toBe(80);
  expect(result.diagnostic.nativeSummary.permissionTools).toHaveLength(64);
  expect(result.diagnostic.nativeSummary.permissionToolsOmitted).toBe(16);
  expect(result.diagnostic.nativeSummary.permissionTools[0].id.truncated).toBe(true);
  expect(result.diagnosticBytes).toBeLessThan(400_000);
  expect(result.diagnostic.raw.text.length).toBeLessThanOrEqual(16_384);
}, 15_000);

test('failed sends are recorded as attempts and preserve the exact thrown error', async () => {
  const result = await run('diagnostic-send-failure');
  expect(result.originalSendErrorPreserved).toBe(true);
  expect(result.sends).toEqual(['1']);
  expect(result.diagnostic.lastSend.status).toBe('threw');
  expect(result.diagnostic.lastSend.failureTruncated).toBe(true);
  expect(result.diagnostic.lastSend.rawCodeUnitsBefore).toBe(result.diagnostic.lastSend.rawCodeUnitsAfter);
  expect(result.diagnostic.errorTruncated).toBe(true);
  expect(result.diagnostic.error.length).toBe(1024);
  expect(result.diagnostic.errorCodeUnits).toBe(result.error.length);
}, 15_000);

test('diagnostic write failure preserves the original navigation error and reports the secondary failure', async () => {
  const result = await run('diagnostic-write-failure');
  expect(result.error).toBe('Error: Mode AskUserQuestion not reached within 30000ms');
  expect(result.diagnostic).toBeNull();
  expect(result.blockedOutputPreserved).toBe(true);
  expect(result.sends).toEqual([]);
  expect(result.stderr).toContain('Mode navigation diagnostic could not be retained');
}, 15_000);

test('posture requires rendered assistant text after the selected mode result', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mode-posture-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const append = (row: object) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
  const assistant = (content: unknown[], extra = {}) => append({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
  const posture = /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
  const read = (visible = 'SCOPE EXPANSION 10x') => readNativeModePosture(config, sessionId, 'mode', visible, posture);
  try {
    assistant([{ type: 'text', text: 'SCOPE EXPANSION' }]);
    expect(read()).toBeNull();
    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mode', content: 'Selected SCOPE EXPANSION' }] } });
    expect(read()).toBeNull();
    assistant([{ type: 'tool_use', name: 'Write', input: { content: 'SCOPE EXPANSION' } }]);
    assistant([{ type: 'thinking', thinking: 'SCOPE EXPANSION' }]);
    assistant([{ type: 'text', text: 'SCOPE EXPANSION' }], { isSidechain: true });
    expect(read()).toBeNull();
    assistant([{ type: 'text', text: 'We can pursue a 10x improvement in delivery.' }]);
    expect(read('Still waiting')).toBeNull();
    expect(read()).toBe('10x');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});

test('post-mode question-only posture uses fresh decoded output and waits for the question ACK', async () => {
  const result = await run('post-question-posture');
  expect(result.error).toBeUndefined();
  expect(result.sends).toEqual(['2', '\r']);
  expect(result.acknowledged).toBe(true);
  expect(result.closed).toBe(true);
  expect(result.premature).toEqual([]);
});

test.each(['stale', 'unrendered', 'wrong-mode', 'no-ack', 'no-frame', 'output-after-snapshot'])('question-only posture refuses %s evidence', async variant => {
  const result = await run('post-question-posture-' + variant);
  expect(result.error).toContain('no posture match');
  expect(result.sends).toEqual(['2', '\r']);
  expect(result.elapsed).toBe(30_000);
  expect(result.closed).toBe(true);
});

test.each(['question', 'mode-menu', 'selected-mode-id', 'wrong-mode', 'preview-only', 'history-only', 'read', 'bash', 'delegate', 'sidechain', 'foreign', 'before-mode', 'error-ack', 'no-ack'])('posture only admits owned post-mode question text (%s)', variant => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'native-question-posture-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const append = (row: object) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
  const ack = (id: string, error = false) => append({ type: 'user', timestamp: '2026-09-11T07:01:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: 'Selected SCOPE EXPANSION' }] } });
  const labels = variant === 'mode-menu' ? ['SCOPE EXPANSION', 'HOLD SCOPE'] : ['Include', 'Defer'];
  const question = variant === 'preview-only' ? 'Choose the filename?' : variant === 'wrong-mode' ? 'Keep this export bulletproof?' : 'Could this comparison view deliver a 10x improvement?';
  const id = variant === 'selected-mode-id' ? 'mode' : 'follow-up';
  const name = ({ read: 'Read', bash: 'Bash', delegate: 'Agent' } as Record<string, string>)[variant] ?? 'AskUserQuestion';
  try {
    ack('mode');
    append({ type: 'assistant', timestamp: variant === 'before-mode' ? '2026-09-11T07:00:00Z' : '2026-09-11T07:01:00Z',
      ...(variant === 'sidechain' ? { isSidechain: true } : variant === 'foreign' ? { sessionId: '00000000-0000-4000-8000-000000000002' } : {}),
      message: { role: 'assistant', content: [{ type: 'tool_use', name, id, input: { questions: [{ question, header: 'Scope', multiSelect: false,
        options: labels.map(label => ({ label, description: '10x improvement' })) }] } }] } });
    if (variant !== 'no-ack') ack(id, variant === 'error-ack');
    expect(readNativeModePosture(config, sessionId, 'mode', '10x improvement', /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i,
      variant === 'history-only' ? undefined : '10x improvement'))
      .toBe(variant === 'question' ? '10x' : null);
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});

for (const [scenario, sends] of [
  ['post-many-questions', Array.from({ length: 13 }, () => ['2', '\r']).flat()],
  ['post-next-modal', ['2', '\r']], ['post-multi-tab', ['2', '1', '\r']],
  ['post-repeat-mode', ['3', '\r']], ['post-no-recommendation', ['1', '\r']],
  ['post-ambiguous-recommendation', ['1', '\r']], ['post-permission', ['1\r', '2', '\r']],
] as const) {
  test(`post-mode continuation preserves owned input and original posture: ${scenario}`, async () => {
    const result = await run(scenario);
    expect(result.error).toBeUndefined(); expect(result.sends).toEqual(sends);
    expect(result.premature).toEqual([]); expect(result.acknowledged).toBe(true);
    expect(result.closed).toBe(true); expect(result.diagnostic).toBeNull();
    if (scenario === 'post-many-questions') expect(result.elapsed).toBeLessThan(240_000);
  }, 15_000);
}

test.skipIf(process.platform === 'win32')('post-mode hook invocation waits for actual native JSONL acknowledgement', async () => {
  const result = await run('post-early-event');
  expect(result.error).toBeUndefined(); expect(result.earlyWithoutNativeInvocation).toBe(true);
  expect(result.sends).toEqual(['2', '\r']); expect(result.acknowledged).toBe(true);
}, 15_000);

test.skipIf(process.platform === 'win32').each(['post-permission-request-long', 'post-permission-request-long-navigation'])('full current-frame permission keeps the owned path through navigation/posture (%s)', async scenario => {
  const result = await run(scenario);
  expect(result.error).toBeUndefined();
  expect(result.longPermissionFrame.length).toBeGreaterThan(1500);
  expect(result.sends).toEqual(scenario.endsWith('navigation') ? ['1\r', '3', '\r'] : ['1\r', '2', '\r']);
  expect(result.premature).toEqual([]); expect(result.acknowledged).toBe(true);
  expect(result.closed).toBe(true);
});
test.skipIf(process.platform === 'win32').each(['stale', 'unowned', 'history'])('full current-frame permission retains navigation %s refusal', async variant => {
  const result = await run('post-permission-request-long-' + variant);
  if (variant === 'history') {
    expect(result.initialPermissionHistory).toContain('\n Overwrite file\n ');
    const tail = result.initialPermissionHistory.slice(-1500);
    expect(tail).not.toContain('\n Overwrite file\n ');
    expect(tail).toContain('Do you want to overwrite ' + path.basename(result.permissionPath) + '?');
    expect(tail).not.toContain(path.dirname(result.permissionPath));
  }
  expect(result.error).toBeString(); expect(result.sends).toEqual([]);
  expect(result.closed).toBe(true);
});
test.skipIf(process.platform === 'win32')('recent permission history can bind its complete current outside directory without a historical header', async () => {
  const result = await run('post-permission-request-long-directory-history');
  const tail = result.initialPermissionHistory.slice(-1500);
  expect(tail).not.toContain('\n Overwrite file\n ');
  expect(tail).toContain(path.dirname(result.permissionPath));
  expect(tail).toContain('Do you want to overwrite ' + path.basename(result.permissionPath) + '?');
  expect(result.error).toBeUndefined(); expect(result.sends).toEqual(['1\r', '2', '\r']);
  expect(result.premature).toEqual([]); expect(result.acknowledged).toBe(true); expect(result.closed).toBe(true);
});
test.skipIf(process.platform === 'win32')('full current-frame permission keeps the short recent-history fallback', async () => {
  const result = await run('post-permission-request-history');
  expect(result.error).toBeUndefined(); expect(result.sends).toEqual(['1\r', '2', '\r']);
  expect(result.acknowledged).toBe(true); expect(result.closed).toBe(true);
});

test.skipIf(process.platform === 'win32').each(['post-permission-request', 'post-permission-request-navigation', 'post-permission-request-arrival-race'])('owned PermissionRequest grants Write before its native invocation (%s)', async scenario => {
  const result = await run(scenario);
  expect(result.error).toBeUndefined(); expect(result.earlyWithoutNativeInvocation).toBe(true);
  expect(result.raceInjected).toBe(scenario.endsWith('arrival-race'));
  expect(result.sends).toEqual(scenario.endsWith('arrival-race') ? ['1\r'] : ['1\r', scenario.endsWith('navigation') ? '3' : '2', '\r']);
  expect(result.premature).toEqual([]); expect(result.acknowledged).toBe(true);
  expect(result.closed).toBe(true); expect(result.diagnostic).toBeNull();
}, 15_000);

test.skipIf(process.platform === 'win32').each(['post-permission-request-no-ack', 'post-permission-request-unowned'])('permission failure remains failed with separate request identity (%s)', async scenario => {
  const result = await run(scenario);
  expect(result.error).toBeString(); expect(result.closed).toBe(true); expect(result.diagnosticBeforeClose).toBe(true);
  expect(result.sends).toEqual(scenario.endsWith('unowned') ? [] : ['1\r', '2', '\r']);
  const [request] = result.diagnostic.nativeSummary.permissionRequests;
  expect(request.requestId.text).toMatch(/^[a-f0-9-]{36}$/);
  expect(request.result).toBe('pending');
  expect(result.diagnostic.phase).toBe('posture');
}, 15_000);

for (const [scenario, sends] of [
  ['post-no-mode-ack', []], ['post-no-ack', ['2', '\r']], ['post-error-ack', ['2', '\r']],
  ['post-stale', []], ['post-stale-after-pick', ['2']], ['post-unowned', []], ['post-unmatched', []],
  ['post-concurrent', []], ['post-identical-mode', []], ['post-multiselect', []], ['post-permission-unowned', []],
  ['post-wrong-posture', ['2', '\r']], ['post-missing-posture', ['2', '\r']], ['post-not-rendered', ['2', '\r']],
  ['post-read-deadline', []], ['post-mark-deadline', []], ['post-exited', []], ['post-exit-during-pause', []], ['post-send-failure', ['2']],
] as const) {
  test(`post-mode failure remains failed and survives cleanup: ${scenario}`, async () => {
    const result = await run(scenario);
    expect(result.error).toBeString(); expect(result.sends).toEqual(sends); expect(result.premature).toEqual([]);
    expect(result.closed).toBe(true); expect(result.diagnosticBeforeClose).toBe(true);
    expect(result.configRemovedBeforeArtifactRead).toBe(true); expect(result.diagnostic.phase).toBe('posture');
    expect(result.diagnostic.modeToolUseId.text).toBe('mode'); expect(result.diagnostic.error).toBe(result.error);
    if (process.platform !== 'win32') expect(result.diagnosticMode).toBe(0o600);
    expect(result.elapsed).toBeLessThanOrEqual(30_000);
    if (scenario === 'post-send-failure') expect(result.originalSendErrorPreserved).toBe(true);
  }, 15_000);
}


for (const [scenario, sends] of [
  ['post-preview-already-focused', ['\r']],
  ['post-preview-focus', ['2', '\r']],
  ['post-preview-navigation', ['\r', '3', '\r', '\r']],
  ['post-preview-mixed', ['2', '\r', '1', '\r']],
] as const) test(`preview menus commit the focused native choice separately: ${scenario}`, async () => {
  const result = await run(scenario);
  expect(result.error).toBeUndefined();
  expect(result.sends).toEqual(sends);
  expect(result.premature).toEqual([]);
  expect(result.sameFocusWrites).toBe(0);
  expect(result.acknowledged).toBe(true);
  expect(result.closed).toBe(true);
}, 15_000);

for (const [scenario, sends] of [
  ['post-preview-stale-focus', ['2']],
  ['post-preview-wrong-focus', ['2']],
  ['post-preview-unowned', []],
  ['post-preview-multiselect', []],
  ['post-preview-deadline', ['2']],
  ['post-preview-input-change', ['2']],
  ['post-preview-no-ack', ['2', '\r']],
  ['post-preview-send-failure', ['2', '\r']],
] as const) test(`preview input never substitutes for a fresh frame and native ACK: ${scenario}`, async () => {
  const result = await run(scenario);
  expect(result.error).toBeDefined();
  expect(result.sends).toEqual(sends);
  expect(result.premature).toEqual([]);
  expect(result.acknowledged).toBe(false);
  expect(result.diagnosticBeforeClose).toBe(true);
  expect(result.closed).toBe(true);
}, 15_000);


test('a bounded viewport redraw restores the exact retained clipped question before ordinary selection', async () => {
  const result = await run('post-viewport-restored');
  expect(result.error).toBeUndefined();
  expect(result.sends).toEqual(['1']);
  expect(result.resizes).toEqual([80, 40]);
  expect(result.premature).toEqual([]);
  expect(result.acknowledged).toBe(true);
  expect(result.closed).toBe(true);
}, 15_000);

for (const [scenario, resizes, sends] of [
  ['post-viewport-cap', [80, 120], []],
  ['post-viewport-no-output', [80], []],
  ['post-viewport-input-change', [80], []],
  ['post-viewport-owner-change', [80], []],
  ['post-viewport-deadline', [], []],
  ['post-viewport-resize-failure', [80], []],
  ['post-viewport-no-ack', [80], ['1']],
  ['post-viewport-error-ack', [80], ['1']],
] as const) test(`viewport changes never replace native matching or ACK: ${scenario}`, async () => {
  const result = await run(scenario);
  expect(result.error).toBeDefined();
  expect(result.resizes).toEqual(resizes);
  expect(result.sends).toEqual(sends);
  expect(result.acknowledged).toBe(false);
  expect(result.closed).toBe(true);
  expect(result.diagnosticBeforeClose).toBe(true);
}, 15_000);


test('restoring geometry does not invalidate already owned post-mode completion', async () => {
  const result = await run('post-viewport-no-restore-output');
  expect(result.error).toBeUndefined();
  expect(result.sends).toEqual(['1']);
  expect(result.resizes).toEqual([80, 40]);
  expect(result.acknowledged).toBe(true);
  expect(result.diagnosticBeforeClose).toBe(false);
}, 15_000);


test('short preview mode navigation focuses HOLD below the pane and waits for native acknowledgement', async () => {
  const result = await run('post-preview-short');
  expect(result.error).toBeUndefined();
  expect(result.sends).toEqual(['3', '\r']);
  expect(result.premature).toEqual([]);
  expect(result.sameFocusWrites).toBe(0);
  expect(result.acknowledged).toBe(true);
}, 15_000);

test.each([
  ['post-preview-short-stale-focus', ['3']],
  ['post-preview-short-unowned', []],
  ['post-preview-short-no-ack', ['3', '\r']],
] as const)('short preview mode navigation retains frame, ownership and ACK barriers: %s', async (scenario, sends) => {
  const result = await run(scenario);
  expect(result.error).toBeDefined();
  expect(result.sends).toEqual(sends);
  expect(result.premature).toEqual([]);
  expect(result.acknowledged).toBe(false);
  expect(result.closed).toBe(true);
}, 15_000);


test('post-mode failure retains exact owned reply and assistant text before cleanup', async () => {
  const result = await run('post-diagnostic-text');
  expect(result.error).toContain('no posture match');
  expect(result.sends).toEqual(['2', '\r']);
  expect(result.closed).toBe(true); expect(result.diagnosticBeforeClose).toBe(true);
  expect(result.configRemovedBeforeArtifactRead).toBe(true);
  const evidence = result.diagnostic.postureNative;
  expect(evidence.modeResultCount).toBe(1); expect(evidence.assistantTextCount).toBe(2);
  expect(evidence.records.map(record => record.kind)).toEqual(['mode_result', 'assistant_text', 'assistant_text']);
  expect(JSON.parse(evidence.records[0].content.text)).toEqual({ type: 'tool_result', tool_use_id: 'mode', is_error: false, content: 'Answer accepted' });
  expect(evidence.records[1].content.text).toBe('Normal assistant message after mode reply.');
  expect(evidence.records[1].timestamp.text).toBe('1970-01-01T00:00:00.000Z');
  expect(evidence.records[1].stopReason.text).toBe('tool_use');
  expect(evidence.records[1].blockIndex).toBe(3);
  expect(evidence.records[2].content.text).toBe('I will make this plan bulletproof.');
  expect(evidence.records[2].stopReason).toBeNull();
  expect(evidence.records[2].rowIndex).toBeGreaterThan(evidence.records[1].rowIndex);
  expect(evidence.recordsOmitted).toBe(0); expect(evidence.pendingBytes).toBe(0);
  expect(JSON.stringify(evidence)).not.toMatch(/EXCLUDED_|BEFORE_MODE_TEXT/);
  expect(result.elapsed).toBe(30_000);
});

test('post-mode text retention bounds records and UTF-16 content without changing timeout', async () => {
  const result = await run('post-diagnostic-text-limits');
  expect(result.error).toContain('no posture match');
  const evidence = result.diagnostic.postureNative;
  expect(evidence.modeResultCount).toBe(1); expect(evidence.assistantTextCount).toBe(42);
  expect(evidence.records).toHaveLength(32); expect(evidence.recordsOmitted).toBe(11);
  expect(evidence.records.reduce((sum, record) => sum + record.content.text.length, 0)).toBe(65_536);
  expect(evidence.records[2].content.codeUnits).toBe(20_002);
  expect(evidence.records[2].content.text.length).toBe(16_384);
  expect(evidence.records[2].content.truncated).toBe(true);
  expect(evidence.records.at(-1).content.text).toBe('');
  expect(evidence.records.at(-1).content.truncated).toBe(true);
  expect(JSON.stringify(evidence)).not.toMatch(/EXCLUDED_|BEFORE_MODE_TEXT/);
  expect(Buffer.byteLength(JSON.stringify(result.diagnostic))).toBeLessThan(300_000);
  expect(result.elapsed).toBe(30_000); expect(result.closed).toBe(true);
});
