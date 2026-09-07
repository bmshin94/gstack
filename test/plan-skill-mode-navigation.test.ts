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
    return JSON.parse(stdout.trim());
  } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited; } }
}

test('mode navigation ignores a mode-looking preview, selects native option four and waits for its result', async () => {
  const result = await run('native');
  expect(result.error).toBeUndefined();
  expect(result.premature).toEqual([]);
  expect(result.sends).toEqual(['1\r', '4\r']);
  expect(result.navigation.modeIndex).toBe(4);
  expect(result.acknowledged).toBe(true);
}, 15_000);
test('a real native mode question missing the requested mode fails explicitly', async () => {
  const result = await run('missing');
  expect(result.error).toContain('Native mode AskUserQuestion');
  expect(result.error).toContain('SCOPE EXPANSION');
  expect(result.sends).toEqual(['1\r']);
}, 15_000);
test('mode selection without acknowledgement cannot start the posture assertion', async () => {
  const result = await run('unacknowledged');
  expect(result.error).toContain('not acknowledged');
  expect(result.sends).toEqual(['1\r', '4\r']);
  expect(result.acknowledged).toBe(false);
}, 15_000);
test.each(['read-budget', 'write-budget', 'ack-budget'])('mode navigation respects its deadline after %s work', async scenario => {
  const result = await run(scenario);
  expect(result.navigation).toBeUndefined();
  expect(result.error).toContain('30000ms');
  expect(result.sends).toEqual(scenario === 'ack-budget' ? ['1\r', '4\r'] : ['1\r']);
}, 15_000);
test('nonfinite mode navigation budgets fail before input', async () => {
  const result = await run('invalid-budget');
  expect(result.error).toContain('must be finite');
  expect(result.sends).toEqual([]);
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
