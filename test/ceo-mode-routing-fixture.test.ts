/** Run the real paid case bodies with provider boundaries replaced in a child. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import { currentFilePermissionTarget, reserveNativePermissionGrant } from './helpers/plan-skill-questions';

const ROOT = path.resolve(import.meta.dir, '..');

test.each(['success', 'next-modal', 'launch', 'navigation', 'posture', 'close'])('mode fixture delivery and cleanup: %s', async scenario => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-body-'));
  const script = path.join(dir, 'body.fixture.test.ts');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(ROOT)};
const scenario = ${JSON.stringify(scenario)};
const facts = [];
let current;
let clock = 0;
Date.now = () => clock;
Bun.sleep = async ms => { clock += ms; };
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => describe }));
mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
  launchClaudePty: async opts => {
    current = { cwd: opts.cwd, options: opts, sends: [], closed: false, navigation: null, reads: [] };
    facts.push(current);
    current.input = fs.readFileSync(path.join(opts.cwd, 'review-input.md'), 'utf8');
    current.committed = execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 });
    current.design = fs.readFileSync(path.join(opts.cwd, 'DESIGN.md'), 'utf8');
    current.committedDesign = execFileSync('git', ['show', 'HEAD:DESIGN.md'], { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 });
    current.status = execFileSync('git', ['status', '--porcelain'], { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 });
    current.diff = execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 });
    if (scenario === 'launch') throw new Error('fixture launch failed');
    return {
      hermeticConfigDir: 'owned-config', mark: () => 11,
      send: value => current.sends.push(value), exited: () => false,
      visibleSince: since => 'rendered since ' + since,
      close: async () => { current.closed = true; if (scenario === 'close') throw new Error('fixture close failed'); },
    };
  },
  isNumberedOptionListVisible: () => false,
  isPlanReadyVisible: () => false,
}));
mock.module(path.join(root, 'test/helpers/plan-skill-mode-navigation.ts'), () => ({
  navigateToModeAskUserQuestion: async (_session, since, mode, opts) => {
    current.navigation = { since, mode, opts };
    current.reviewStartPicks = typeof opts.firstAUQPick === 'function' ? [
      ['D1 — Run /office-hours before this review?', ['A) Run /office-hours first', 'B) Skip — standard review (recommended)']],
      ['D1 — No design doc found: run /office-hours before the review?', ['Run /office-hours now', 'Skip — proceed with review (Recommended)']],
    ].map(([question, labels]) => opts.firstAUQPick({ question, options: labels.map((label, i) => ({ index: i + 1, label })) })) : null;
    if (scenario === 'navigation') throw new Error('fixture navigation failed');
    return { sincePick: 23, toolUseId: 'owned-mode-choice' };
  },
  waitForNativeModePosture: async (session, selection, mode, opts) => {
    current.posture = { selection, mode, budgetMs: opts.budgetMs, sessionId: opts.sessionId };
    current.reads.push({ config: session.hermeticConfigDir, sessionId: opts.sessionId,
      toolUseId: selection.toolUseId, visible: session.visibleSince(selection.sincePick) });
    if (scenario === 'next-modal') { session.send('2'); session.send('\\r'); }
    if (scenario === 'posture' || !opts.postureRe.test(mode)) throw new Error('routing FAILED: no posture match');
  },
}));
afterAll(() => fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify(facts)));
await import(path.join(root, 'test/skill-e2e-plan-ceo-mode-routing.test.ts'));
`);
  try {
    const child = spawnSync(process.execPath, ['test', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(['success', 'next-modal'].includes(scenario) ? 0 : 1);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts).toHaveLength(2);
    expect(facts[0].cwd).not.toBe(facts[1].cwd);
    expect(facts[0].input).toBe(facts[1].input);
    expect(facts[0].design).toBe(facts[1].design);
    for (const fact of facts) {
      expect(fact.cwd).not.toBe(ROOT);
      expect(fact.committed).toBe(fact.input);
      expect(fact.committedDesign).toBe(fact.design);
      expect(fact.design).toContain('## Problem');
      expect(fact.design).toContain('## Chosen approach');
      expect(fact.design).toContain('## Alternatives and boundaries');
      expect(fact.design).not.toMatch(/HOLD SCOPE|SCOPE EXPANSION|rigor|bulletproof|10x|delight|dream|cathedral|opt[\s-]?in/i);
      expect(fact.status).toBe('');
      expect(fact.diff).toBe('');
      expect(fact.input).toContain('present the full review-mode choice and wait for my selection');
      expect(fact.input).not.toMatch(/HOLD SCOPE|SCOPE EXPANSION|rigor|bulletproof|10x|delight|dream|cathedral|opt[\s-]?in/i);
      expect(fact.options).toMatchObject({ permissionMode: 'plan', timeoutMs: 900_000, seedSkills: true, captureScreen: true, cols: 240 });
      if (scenario === 'success') {
        // The retained native permission path is longer than the old120-column pane.
        // Exercise actual terminal wrapping and current-owner reservation at the caller's width.
        const filePath = '/tmp/gstack-paid-shard-PoCvJ2/tmp/gstack-hermetic-2353545-0NYCOc/gstack-home/projects/ceo-mode-routing-Seq4Vn/ceo-plans/2026-09-10-settings-csv-export.md';
        const frame = async (target: string, cols: number) => {
          const screen = new PtyCurrentScreen({ cols, rows: 40 });
          try {
            screen.feed([
              ' Do you want to create ' + path.basename(target) + '?', ' ❯ 1. Yes',
              '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; Yes, and always allow access to',
              '      ' + path.dirname(target) + ' for this session (shift+tab)', '   3. No', '', ' Esc to cancel · Tab to amend',
            ].join('\r\n'));
            return (await screen.snapshot()).text;
          } finally { screen.close(); }
        };
        expect(currentFilePermissionTarget(await frame(filePath, 120))).toBeNull();
        const visible = await frame(filePath, fact.options.cols);
        expect(currentFilePermissionTarget(visible)).toEqual({ operation: 'create', filePath });
        const request = { requestId: 'owned-width-request', capturedAtMs: 1, name: 'Write' as const,
          input: { file_path: filePath }, cwd: fact.cwd, result: 'pending' as const, nativeToolId: 'owned-width-write' };
        const native = { permissionTools: [], permissionResults: [], permissionRequestCapture: true, permissionRequests: [request] };
        const grants = new Set<string>(), requests = new Map();
        expect(reserveNativePermissionGrant(native, visible, grants, requests)).toBe(true);
        expect(reserveNativePermissionGrant(native, visible, grants, requests)).toBe(false);
        expect([...grants]).toEqual(['request:owned-width-request']);
        expect([...requests.keys()]).toEqual(['Write:' + filePath]);
        const wrong = { ...native, permissionRequests: [{ ...request, input: { file_path: filePath.replace('/ceo-plans/', '/other-plans/') } }] };
        expect(() => reserveNativePermissionGrant(wrong, visible, new Set(), new Map())).toThrow('cannot be bound');
        const ambiguous = { ...native, permissionRequests: [request, { ...request, requestId: 'another-owner' }] };
        expect(() => reserveNativePermissionGrant(ambiguous, visible, new Set(), new Map())).toThrow('Ambiguous native permission owner');
        const longer = filePath.replace('/ceo-plans/', '/' + 'longer-path-'.repeat(30) + '/');
        expect(currentFilePermissionTarget(await frame(longer, fact.options.cols))).toBeNull();
      }
      expect(fs.existsSync(fact.cwd)).toBe(false);
      expect(fact.closed).toBe(scenario !== 'launch');
      expect(fact.sends).toEqual(scenario === 'launch' ? [] : scenario === 'next-modal' ? ['/plan-ceo-review\r', '2', '\r'] : ['/plan-ceo-review\r']);
      if (scenario === 'launch') expect(fact.navigation).toBeNull();
      else {
        expect(fact.navigation.since).toBe(11);
        expect(fact.reviewStartPicks).toEqual([2, 2]);
        expect(fact.navigation.opts.sessionId).toBe(fact.options.captureQuestionsForSession);
        if (scenario !== 'navigation') expect(fact.posture).toEqual({ selection: { sincePick: 23, toolUseId: 'owned-mode-choice' },
          mode: fact.navigation.mode, budgetMs: 240_000, sessionId: fact.options.captureQuestionsForSession });
      }
      for (const read of fact.reads) expect(read).toEqual({
        config: 'owned-config', sessionId: fact.options.captureQuestionsForSession,
        toolUseId: 'owned-mode-choice', visible: 'rendered since 23',
      });
      expect(fact.reads.length > 0).toBe(!['launch', 'navigation'].includes(scenario));
    }
    if (scenario === 'posture') expect(child.stderr).toContain('routing FAILED: no posture match');
    else if (!['success', 'next-modal'].includes(scenario)) expect(child.stderr).toContain('fixture ' + scenario + ' failed');
    expect(fs.readdirSync(dir).filter(name => name.startsWith('ceo-mode-routing-'))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
