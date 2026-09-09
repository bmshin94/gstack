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

test('mode navigation ignores a mode-looking preview, selects native option four and waits for its result', async () => {
  const result = await run('native');
  expect(result.error).toBeUndefined();
  expect(result.premature).toEqual([]);
  expect(result.sends).toEqual(['1', '4']);
  expect(result.navigation.modeIndex).toBe(4);
  expect(result.acknowledged).toBe(true);
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
