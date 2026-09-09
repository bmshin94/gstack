/** The chain fixture must reach /autoplan without project-routing onboarding. */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedAutoplanProject } from './helpers/autoplan-fixture';
import { generateSlugEval, generateSlugSetup } from '../scripts/resolvers/utility';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

function withFixture(check: (project: string, runStart: () => string, state: string, home: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-routing-fixture-'));
  try {
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    for (const dir of [project, home, state]) fs.mkdirSync(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'pipe' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\nrouting_declined: false\n');
    fs.writeFileSync(path.join(state, '.proactive-prompted'), '');
    seedAutoplanProject(project);
    check(project, () => execFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), ['--skill', 'autoplan'], {
      cwd: project,
      env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state },
      encoding: 'utf8',
      timeout: 10_000,
    }), state, home);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('autoplan project fixture preamble', () => {
  test('the actual restore block respects private state instead of operator HOME', () => {
    withFixture((project, _runStart, state, home) => {
      const template = fs.readFileSync(path.join(ROOT, 'autoplan/SKILL.md.tmpl'), 'utf8');
      const block = template.split('### Step 1: Capture restore point')[1]!.match(/```bash\n([\s\S]*?)\n```/)![1]!;
      const ctx = { paths: { binDir: path.join(ROOT, 'bin') } } as TemplateContext;
      const script = block.replace('{{SLUG_SETUP}}', generateSlugSetup(ctx))
        .replace('{{SLUG_EVAL}}', generateSlugEval(ctx))
        .replaceAll('~/.claude/skills/gstack/bin/', path.join(ROOT, 'bin') + '/');
      const output = execFileSync('bash', ['-c', script], {
        cwd: project, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state },
        encoding: 'utf8', timeout: 10_000,
      });
      const restore = /^RESTORE_PATH=(.+)$/m.exec(output)?.[1];
      expect(restore).toStartWith(path.join(state, 'projects') + path.sep);
      expect(fs.existsSync(path.dirname(restore!))).toBe(true);
      expect(fs.existsSync(path.join(home, '.gstack'))).toBe(false);
    });
  });

  test('the actual chain fixture owns its state without exposing it as source', () => {
    withFixture((project) => {
      const state = path.join(project, '.gstack');
      expect(fs.readFileSync(path.join(state, 'config.yaml'), 'utf8')).toContain('update_check: false');
      expect(execFileSync('git', ['check-ignore', '.gstack/config.yaml'], {
        cwd: project, encoding: 'utf8', timeout: 5000,
      }).trim()).toBe('.gstack/config.yaml');
    });
  });

  test('the actual chain fixture has routing configured without changing user preferences', () => {
    withFixture((project, runStart, state) => {
      const config = fs.readFileSync(path.join(state, 'config.yaml'), 'utf8');
      const output = runStart();
      expect(output).toContain('SKILL_START_PROTO: 1');
      expect(output).toContain('HAS_ROUTING: yes');
      expect(output).toContain('ROUTING_DECLINED: false');
      expect(output).not.toContain('GSTACK_INSTRUCTION_BEGIN: routing-injection');
      expect(fs.readFileSync(path.join(state, 'config.yaml'), 'utf8')).toBe(config);
      expect(fs.readFileSync(path.join(project, '.claude', 'plans', 'ui-heavy-feature.md'), 'utf8'))
        .toBe(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'plans', 'ui-heavy-feature.md'), 'utf8'));
    });
  });

  test('missing project routing reproduces the actual onboarding block', () => {
    withFixture((project, runStart) => {
      fs.rmSync(path.join(project, 'CLAUDE.md'), { force: true });
      const output = runStart();
      expect(output).toContain('HAS_ROUTING: no');
      expect(output).toContain('ROUTING_DECLINED: false');
      expect(output).toContain('GSTACK_INSTRUCTION_BEGIN: routing-injection');
      expect(output).toContain('Add routing rules to CLAUDE.md (recommended)');
    });
  });
});


// Run the actual paid body with only its provider/native boundaries replaced.
// A completed Edit1 and new Edit2 may precede the next terminal repaint.
test('autoplan waits for a new permission frame after its preceding input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-caller-'));
  const script = path.join(dir, 'caller.fixture.test.ts');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as questions from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-skill-questions.ts'))};
import { isNumberedOptionListVisible, isPermissionDialogVisible } from ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
const root = ${JSON.stringify(ROOT)};
const facts = { inputs: [], frameInputs: [], closed: false };
let clock = 0, frames = 0, grants = 0, rawEnd = 100, cwd, file, config, sessionId;
Date.now = () => clock;
Bun.sleep = async ms => { clock += ms; };
const phaseText = '**Phase 1 complete.**\\n**Phase 2 complete.**\\n**Phase 2.5 complete.**\\n**Phase 3 complete.**';
const request = (n, result = 'pending') => ({ requestId: 'edit-' + n, capturedAtMs: n * 3,
  name: 'Edit', cwd, input: { file_path: file, old_string: String(n), new_string: String(n + 1) }, result,
  ...(result === 'completed' ? { nativeToolId: 'tool-' + n, nativeResultAtMs: n * 3 + 1 } : {}) });
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => describe }));
mock.module(path.join(root, 'test/helpers/plan-skill-questions.ts'), () => ({ ...questions,
  readPlanSkillQuestions: () => ({ calls: [], ready: false, pendingExitPlanModeIds: [], pendingBytes: 0,
    permissionTools: [], permissionResults: [], permissionRequestCapture: true,
    permissionRequests: grants === 0 ? [request(1)] : [request(1, 'completed'), request(2, grants === 2 ? 'completed' : 'pending')] }),
}));
mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
  isNumberedOptionListVisible, isPermissionDialogVisible, isPlanReadyVisible: () => false,
  launchClaudePty: async opts => {
    cwd = fs.realpathSync(opts.cwd); file = path.join(cwd, '.gstack', 'projects', 'fixture', 'restore.md');
    config = path.join(cwd, '.native'); sessionId = opts.captureQuestionsForSession;
    fs.mkdirSync(path.join(config, 'projects', 'fixture'), { recursive: true });
    expect(opts).toMatchObject({ permissionMode: 'plan', timeoutMs: 1080000, seedSkills: true, captureScreen: true, rows: 120,
      env: { GSTACK_HOME: path.join(opts.cwd, '.gstack') } });
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    return {
      hermeticConfigDir: config, nativeQuestionEvents: {}, mark: () => rawEnd,
      exited: () => false, exitCode: () => null, rawOutput: () => '',
      visibleText: () => grants === 2 ? phaseText : '', visibleSince: () => grants === 2 ? phaseText : '',
      currentScreen: async () => {
        frames++; rawEnd = frames < 3 ? 110 : 111;
        return { rawEnd, text: '─'.repeat(120) + '\\n Edit file\\n ' + path.relative(cwd, file) + '\\n' + '╌'.repeat(120) + '\\n' +
          Array.from({ length: 30 }, (_, i) => '  ' + (i + 1) + ' ' + 'plan preview '.repeat(4)).join('\\n') + '\\n' + '╌'.repeat(120) + '\\n Do you want to make this edit to ' + path.basename(file) + '?\\n❯ 1. Yes\\n  2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session\\n  3. No\\nEsc to cancel' };
      },
      send: value => {
        facts.inputs.push(value);
        if (value !== '1\\r') return;
        facts.frameInputs.push(frames); grants++;
        if (grants === 2) fs.writeFileSync(path.join(config, 'projects', 'fixture', sessionId + '.jsonl'),
          JSON.stringify({ type: 'assistant', isSidechain: false, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: phaseText }] } }) + '\\n');
      },
      close: async () => { facts.closed = true; },
    };
  },
}));
afterAll(() => fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify(facts)));
await import(path.join(root, 'test/skill-e2e-autoplan-chain.test.ts'));
`);
  try {
    const child = spawnSync(process.execPath, ['test', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts.inputs).toEqual(['/autoplan\r', '1\r', '1\r']);
    expect(facts.frameInputs).toEqual([1, 3]);
    expect(facts.closed).toBe(true);
    expect(fs.readdirSync(dir).filter(name => name.startsWith('gstack-autoplan-chain-'))).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
