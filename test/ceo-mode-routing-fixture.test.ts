/** Run the real paid case bodies with provider boundaries replaced in a child. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test.each(['success', 'launch', 'navigation', 'posture', 'close'])('mode fixture delivery and cleanup: %s', scenario => {
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
    if (scenario === 'navigation') throw new Error('fixture navigation failed');
    return { sincePick: 23, toolUseId: 'owned-mode-choice' };
  },
  readNativeModePosture: (config, sessionId, toolUseId, visible, pattern) => {
    current.reads.push({ config, sessionId, toolUseId, visible });
    const mode = current.navigation.mode;
    return scenario !== 'posture' && pattern.test(mode) ? mode : null;
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
    expect(child.status, child.stderr).toBe(scenario === 'success' ? 0 : 1);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts).toHaveLength(2);
    expect(facts[0].cwd).not.toBe(facts[1].cwd);
    expect(facts[0].input).toBe(facts[1].input);
    for (const fact of facts) {
      expect(fact.cwd).not.toBe(ROOT);
      expect(fact.committed).toBe(fact.input);
      expect(fact.diff).toBe('');
      expect(fact.input).toContain('present the full review-mode choice and wait for my selection');
      expect(fact.input).not.toMatch(/HOLD SCOPE|SCOPE EXPANSION|rigor|bulletproof|10x|delight|dream|cathedral|opt[\s-]?in/i);
      expect(fact.options).toMatchObject({ permissionMode: 'plan', timeoutMs: 900_000, seedSkills: true, captureScreen: true });
      expect(fs.existsSync(fact.cwd)).toBe(false);
      expect(fact.closed).toBe(scenario !== 'launch');
      expect(fact.sends).toEqual(scenario === 'launch' ? [] : ['/plan-ceo-review\r']);
      if (scenario === 'launch') expect(fact.navigation).toBeNull();
      else {
        expect(fact.navigation.since).toBe(11);
        expect(fact.navigation.opts.sessionId).toBe(fact.options.captureQuestionsForSession);
      }
      for (const read of fact.reads) expect(read).toEqual({
        config: 'owned-config', sessionId: fact.options.captureQuestionsForSession,
        toolUseId: 'owned-mode-choice', visible: 'rendered since 23',
      });
      expect(fact.reads.length > 0).toBe(!['launch', 'navigation'].includes(scenario));
    }
    if (scenario === 'posture') expect(child.stderr).toContain('routing FAILED: no posture match');
    else if (scenario !== 'success') expect(child.stderr).toContain('fixture ' + scenario + ' failed');
    expect(fs.readdirSync(dir).filter(name => name.startsWith('ceo-mode-routing-'))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
