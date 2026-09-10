import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { submitPlanSeed } from './helpers/plan-seed-submission';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import { runPlanSkillObservation, isProseAUQVisible, isNumberedOptionListVisible, isPermissionDialogVisible } from './helpers/claude-pty-runner';

// A real PTY process consumes the actual paste/Enter/slash bytes and publishes
// its own PID status and transcript. No provider or runner hooks are installed.
const CLI = fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'plan-seed-cli.ts'), 'utf8');

for (const scenario of ['success', 'completed-tool', 'status-updating', 'no-ack', 'fused', 'duplicate', 'session-switch', 'foreign-cwd',
  'pending-tool', 'question', 'prose-question', 'permission', 'no-end-turn', 'partial', 'wrong-pid',
  ...(process.platform === 'linux' ? ['wrong-start', 'wrong-domain'] : [])]) {
  test.skipIf(process.platform === 'win32')(`seed submission owns each protocol step: ${scenario}`, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-')));
    const config = path.join(dir, '.claude'); fs.mkdirSync(config);
    const script = path.join(dir, 'cli.ts'); fs.writeFileSync(script, CLI);
    const decoder = new PtyCurrentScreen({ cols: 120, rows: 40 });
    let raw = '', exited = false;
    const launchedAt = Date.now();
    const proc = Bun.spawn([process.execPath, script], {
      cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: config, SEED_CASE: scenario },
      terminal: { cols: 120, rows: 40, data(_terminal, data) { const s = Buffer.from(data).toString(); raw += s; decoder.feed(s); } },
      onExit() { exited = true; },
    });
    const sent: string[] = [];
    const session = {
      pid: () => proc.pid, exited: () => exited, hermeticConfigDir: config,
      send(s: string) { sent.push(s); proc.terminal!.write(s); },
      sendKey(key: string) { expect(key).toBe('Enter'); sent.push('\r'); proc.terminal!.write('\r'); },
      mark: () => raw.length,
      currentScreen: async () => { const mark = raw.length; const frame = await decoder.snapshot(); return { text: frame.text, rawEnd: mark }; },
    };
    const seed = 'Please review when I run the skill:\n\n# Plan\nKeep $HOME and `literal` text.\n';
    const deadlineAt = launchedAt + 1100;
    try {
      let failure: unknown;
      try { await submitPlanSeed(session, seed, { cwd: dir, launchedAt, deadlineAt,
        isQuestionOrPermission: text => isProseAUQVisible(text) || isNumberedOptionListVisible(text) || isPermissionDialogVisible(text) }); }
      catch (error) { failure = error; }
      if (['success', 'completed-tool', 'status-updating'].includes(scenario)) {
        expect(failure).toBeUndefined();
        session.send('/plan-eng-review\r');
        await Bun.sleep(50);
        const events = fs.readFileSync(path.join(config, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        expect(events.map(e => e.kind)).toEqual(['paste', 'enter', 'end_turn', 'slash']);
        expect(events.slice(0, 3).every(e => e.value === seed)).toBe(true);
        expect(sent).toEqual([`\x1b[200~${seed}\x1b[201~`, '\r', '/plan-eng-review\r']);
      } else {
        expect(failure).toBeInstanceOf(Error);
        const expected = ({ fused: 'fused, duplicated, or changed', duplicate: 'fused, duplicated, or changed',
          'session-switch': 'native session changed', 'foreign-cwd': 'Foreign cwd',
          question: 'requires an answer', 'prose-question': 'requires an answer', 'wrong-pid': 'does not match this launch',
          'wrong-start': 'native process identity changed', 'wrong-domain': 'native process identity changed' } as Record<string, string>)[scenario]
          ?? 'existing case budget';
        expect((failure as Error).message).toContain(expected);
        expect(sent.some(s => s === '/plan-eng-review\r')).toBe(false);
        expect(sent.filter(s => s === '\r').length).toBeLessThanOrEqual(1);
      }
      expect(Date.now() - deadlineAt).toBeLessThan(500);
    } finally {
      if (!exited) proc.kill();
      await proc.exited;
      proc.terminal?.close(); decoder.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 6000);
}

for (const mode of ['unseeded-deadline', 'seeded-deadline', 'protocol-error']) test.skipIf(process.platform === 'win32')(`actual observation caller preserves preflight outcome: ${mode}`, async () => {
  const seeded = mode !== 'unseeded-deadline';
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-budget-')));
  const config = path.join(dir, '.claude'); fs.mkdirSync(config);
  const script = path.join(dir, 'cli.ts');
  fs.writeFileSync(script, `#!${process.execPath}\n${CLI}`, { mode: 0o700 });
  const old = process.env.BROWSE_TERMINAL_BINARY;
  process.env.BROWSE_TERMINAL_BINARY = script;
  try {
    const run = runPlanSkillObservation({ skillName: 'plan-eng-review', cwd: dir,
      ...(seeded ? { initialPlanContent: '# Exact plan\nNo new work allowance.' } : {}), timeoutMs: mode === 'protocol-error' ? 10000 : 600, model: 'fixture',
      env: { CLAUDE_CONFIG_DIR: config, SEED_CASE: mode === 'protocol-error' ? 'wrong-pid' : 'success' } });
    if (mode === 'protocol-error') {
      await expect(run).rejects.toThrow('Plan seed PID status does not match this launch');
      expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
      return;
    }
    const obs = await run;
    expect(obs.outcome).toBe('timeout');
    expect(obs.summary).toContain('existing case budget');
    expect(obs.scopeGateAutoSelectObserved).toBe(false);
    expect(obs.elapsedMs).toBeLessThan(1600);
    expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
  } finally {
    if (old === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
