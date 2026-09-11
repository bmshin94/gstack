import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { retainCeoModeEvidence } from './helpers/ceo-mode-evidence';
import { runCeoModePreferenceObservation } from './helpers/ceo-mode-preference';
import type { ClaudePtySession } from './helpers/claude-pty-runner';

test('private evidence preserves JSON and counters, redacts secrets and refuses replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-evidence-'));
  const sessionId = randomUUID();
  try {
    const file = retainCeoModeEvidence(root, sessionId, {
      text: 'before credential-value-123456 after', password: 'other-hidden-value',
      usage: { input_tokens: 12, output_tokens: 34 },
      keyDocument: ["-----BEGIN ", "PRIVATE KEY-----\nprivate material\n-----END ", "PRIVATE KEY-----"].join(''),
    }, { TEST_API_KEY: 'credential-value-123456' });
    const raw = fs.readFileSync(file, 'utf8');
    const saved = JSON.parse(raw);
    expect(saved.evidence.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(saved.evidence.text).toBe('before [REDACTED_ENV] after');
    for (const secret of ['credential-value-123456', 'other-hidden-value', 'private material']) expect(raw).not.toContain(secret);
    expect(saved.redaction.omittedStrings).toBe(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(() => retainCeoModeEvidence(root, sessionId, { replacement: true }, {})).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(() => retainCeoModeEvidence(root, '../escape', {}, {})).toThrow('UUID');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.each(['success', 'timeout', 'runner-error', 'launch-error', 'cleanup-error', 'write-error', 'transcript-error', 'terminal-error', 'screen-error'] as const)(
  'observation retains %s evidence before session cleanup and preserves failures', async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-attempt-'));
    const config = path.join(root, 'config');
    const evidenceRoot = path.join(root, 'evidence');
    let time = 0; let closed = false; let sessionId = ''; let text = '';
    const automatic = 'Auto-decided review mode → HOLD SCOPE (your preference).';
    const noDecision = 'D1 — Still waiting?\nA) Continue\nB) Stop';
    if (scenario === 'write-error') fs.writeFileSync(evidenceRoot, 'not a directory');
    const session = {
      hermeticConfigDir: config, mark: () => text.length,
      currentScreen: async () => {
        if (scenario === 'screen-error') throw new Error('screen exploded');
        return { text, rawEnd: text.length };
      },
      visibleSince: (since = 0) => text.slice(since), rawOutput: () => {
        if (scenario === 'terminal-error') throw new Error('terminal read exploded');
        return text;
      },
      visibleText: () => text, exited: () => false, exitCode: () => null, pid: () => 1,
      send() {
        if (scenario === 'runner-error') throw new Error('runner exploded');
        text = scenario === 'timeout' ? noDecision : automatic;
        const row = { type: 'assistant', sessionId, message: { id: 'owned-message',
          role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } };
        const file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(row) + '\n' + JSON.stringify({ ...row, sessionId: randomUUID() }) + '\n');
        if (scenario === 'transcript-error') fs.appendFileSync(file, '{broken json}\n');
      },
      async close() {
        closed = true;
        fs.rmSync(config, { recursive: true, force: true });
        if (scenario === 'cleanup-error') throw new Error('cleanup exploded');
      },
    } as unknown as ClaudePtySession;
    try {
      const attempt = runCeoModePreferenceObservation({ cwd: root, env: {}, timeoutMs: 12_000, evidenceRoot }, {
        now: () => time, pause: async ms => { time += ms; },
        launch: async opts => {
          sessionId = opts.captureQuestionsForSession!;
          if (scenario === 'launch-error') throw new Error('launch exploded');
          return session;
        },
      });
      if (['success', 'timeout'].includes(scenario)) {
        expect((await attempt).outcome).toBe(scenario === 'success' ? 'auto_decided' : 'timeout');
      } else await expect(attempt).rejects.toThrow(
        scenario === 'runner-error' ? 'runner exploded' : scenario === 'launch-error' ? 'launch exploded'
          : scenario === 'screen-error' ? 'screen exploded' : 'evidence/cleanup failed');
      expect(closed).toBe(scenario !== 'launch-error');
      if (scenario === 'write-error') return;
      expect(fs.readdirSync(evidenceRoot)).toEqual([sessionId]);
      const saved = JSON.parse(fs.readFileSync(path.join(evidenceRoot, sessionId, 'observation.json'), 'utf8')).evidence;
      expect(saved.outcome).toBe(['success', 'timeout'].includes(scenario)
        ? scenario === 'success' ? 'auto_decided' : 'timeout' : 'harness_error');
      if (['success', 'timeout', 'cleanup-error'].includes(scenario)) {
        expect(saved.snapshot.transcript.rows).toHaveLength(1);
        expect(saved.snapshot.transcript.rows[0].message.id).toBe('owned-message');
        expect(saved.snapshot.rawTerminal).toBe(text);
        expect(fs.existsSync(config)).toBe(false);
      }
      if (scenario === 'runner-error') expect(saved.failure).toContain('runner exploded');
      if (scenario === 'screen-error') expect(saved.failure).toBe('Error: screen exploded');
      if (scenario === 'cleanup-error') expect(saved.finalizationErrors).toEqual(['Error: cleanup exploded']);
      if (scenario === 'transcript-error') {
        expect(saved.snapshot.rawTerminal).toBe(text);
        expect(saved.snapshot.visibleTerminal).toBe(text);
        expect(saved.snapshot.transcript.captureError).toContain('Malformed Claude transcript');
      }
      if (scenario === 'terminal-error') {
        expect(saved.snapshot.rawTerminal.captureError).toBe('terminal read exploded');
        expect(saved.snapshot.visibleTerminal).toBe(text);
        expect(saved.snapshot.transcript.rows).toHaveLength(1);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

test('a pre-launch deadline still leaves an attempt artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-deadline-'));
  try {
    const observed = await runCeoModePreferenceObservation({ cwd: root, env: {}, timeoutMs: 0, evidenceRoot: root }, {
      launch: async () => { throw new Error('must not launch'); },
    });
    expect(observed.outcome).toBe('timeout');
    const dirs = fs.readdirSync(root);
    expect(dirs).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, dirs[0], 'observation.json'), 'utf8'));
    expect(saved.evidence.outcome).toBe('timeout');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
