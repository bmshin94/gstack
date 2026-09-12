/** The chain fixture must reach /autoplan without project-routing onboarding. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedAutoplanProject } from './helpers/autoplan-fixture';
import { generateSlugEval, generateSlugSetup } from '../scripts/resolvers/utility';
import { DESIGN_DOC_DISCOVERY_BLOCK } from '../scripts/resolvers/design-doc-discovery';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

function withFixture(check: (project: string, runStart: () => string, state: string, home: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-routing-fixture-'));
  try {
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    for (const dir of [project, home, state]) fs.mkdirSync(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'pipe', timeout: 5000 });
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
  test('generated Autoplan discovers the design before offering a prerequisite', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf8');
    const offerIndex = skill.indexOf('## Prerequisite Skill Offer');
    expect(offerIndex).toBeGreaterThan(-1);
    const beforeOffer = skill.slice(0, offerIndex);
    const discovery = [...beforeOffer.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map(match => match[1]).find(block => block.includes('_LOCALDOC='));
    expect(discovery).toBeDefined();
    withFixture((project, _runStart, _state, home) => {
      const check = () => execFileSync('bash', ['-c', discovery!], {
        cwd: project, env: { PATH: process.env.PATH!, HOME: home },
        encoding: 'utf8', timeout: 5000,
      });
      expect(check()).toBe(`Design doc found: ${path.join(project, 'DESIGN.md')}\n`);
      fs.unlinkSync(path.join(project, 'DESIGN.md'));
      expect(check()).toBe('No design doc found\n');
    });
  });

  test('actual seed contains the existing app contracts while leaving the dashboard proposed', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-app-fixture-'));
    const db = new Database(':memory:');
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', timeout: 5000 });
      git(['init', '-b', 'main']);
      const state = seedAutoplanProject(project);
      const auth = await import(pathToFileURL(path.join(project, 'src/auth.ts')).href);
      const token = 'a'.repeat(64);
      const seen: string[] = [];
      const lookup = async (hash: string) => { seen.push(hash); return { user_id: 'alice', expires_at: 2000 }; };
      expect(await auth.sessionUser(new Request('https://app.test/api/session?userId=alice'), lookup, 1000)).toBeNull();
      expect(seen).toEqual([]);
      const request = new Request('https://app.test/api/session?userId=bob', { headers: { cookie: `session=${token}` } });
      expect(await auth.sessionUser(request, lookup, 1000)).toBe('alice');
      expect(seen).toEqual([auth.tokenHash(token)]);
      expect(seen[0]).not.toBe(token);
      expect(await auth.sessionUser(request, lookup, 2000)).toBeNull();
      expect(await auth.sessionUser(request, async () => undefined, 1000)).toBeNull();

      // The exact portable DDL is accepted by PostgreSQL and SQLite. SQLite
      // checks its real constraints/data shape here; this is not a live PG test.
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(fs.readFileSync(path.join(project, 'db/schema.sql'), 'utf8'));
      db.exec("INSERT INTO users VALUES ('alice', 'alice@example.test', 'hash'), ('bob', 'bob@example.test', 'hash')");
      db.exec("INSERT INTO notifications VALUES ('n1', 'alice', 'Ready', 1, NULL), ('n2', 'bob', 'Ready', 2, 3)");
      expect(db.query('SELECT message, read_at FROM notifications WHERE user_id = ?').all('alice')).toEqual([{ message: 'Ready', read_at: null }]);
      expect(db.query('SELECT read_at FROM notifications WHERE user_id = ?').get('bob')).toEqual({ read_at: 3 });

      // Execute the proposed statement against the exact fixture schema. This
      // checks ownership, repeat behavior and existing read timestamps; it does
      // not pretend the proposed HTTP handler already exists or run PostgreSQL.
      const plan = fs.readFileSync(path.join(project, '.claude/plans/ui-heavy-feature.md'), 'utf8');
      const sqlBlocks = [...plan.matchAll(/```sql\n([\s\S]*?)\n```/g)];
      expect(sqlBlocks).toHaveLength(1);
      db.exec("INSERT INTO notifications VALUES ('n3', 'bob', 'Unread', 3, NULL), ('n4', 'alice', 'Read already', 4, 5)");
      const markRead = db.query(sqlBlocks[0][1]);
      expect(markRead.all({ $1: 1000, $2: 'alice' })).toEqual([{ id: 'n1' }]);
      expect(markRead.all({ $1: 2000, $2: 'alice' })).toEqual([]);
      expect(db.query('SELECT id, read_at FROM notifications ORDER BY id').all()).toEqual([
        { id: 'n1', read_at: 1000 }, { id: 'n2', read_at: 3 },
        { id: 'n3', read_at: null }, { id: 'n4', read_at: 5 },
      ]);
      expect(() => db.exec("INSERT INTO activity VALUES ('a1', 'unknown', 'Invalid owner', 1)")).toThrow();
      db.exec("INSERT INTO activity VALUES ('a1', 'alice', 'Created project', 1)");
      expect(db.query('SELECT description FROM activity WHERE user_id = ?').get('alice')).toEqual({ description: 'Created project' });
      db.exec("INSERT INTO sessions VALUES ('hash', 'alice', 2000)");
      expect(db.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get('hash')).toEqual({ user_id: 'alice', expires_at: 2000 });

      expect(fs.readFileSync(path.join(project, '.claude/plans/ui-heavy-feature.md'), 'utf8'))
        .toBe(fs.readFileSync(path.join(ROOT, 'test/fixtures/plans/ui-heavy-feature.md'), 'utf8'));
      expect(fs.readdirSync(path.join(project, 'src/pages'))).toEqual(['Workspace.tsx']);
      expect(fs.existsSync(path.join(project, 'src/components'))).toBe(false);
      const server = fs.readFileSync(path.join(project, 'src/server.ts'), 'utf8');
      expect(server).not.toContain('/dashboard');
      expect(server).not.toContain('/api/notifications');
      const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
      expect(Object.keys(manifest.dependencies).sort()).toEqual(['react', 'react-dom']);
      expect(manifest.devDependencies.tailwindcss).toBeDefined();
      const transpiler = new Bun.Transpiler({ loader: 'tsx' });
      for (const file of ['src/main.tsx', 'src/pages/Workspace.tsx']) {
        expect(transpiler.transformSync(fs.readFileSync(path.join(project, file), 'utf8')).length).toBeGreaterThan(0);
      }
      git(['add', '.']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Seed existing app and proposed dashboard']);
      expect(git(['status', '--porcelain'])).toBe('');
      expect(git(['show', 'HEAD:src/auth.ts'])).toBe(fs.readFileSync(path.join(project, 'src/auth.ts'), 'utf8'));
      expect(git(['ls-files', '.gstack'])).toBe('');
      expect(fs.existsSync(path.join(state, 'config.yaml'))).toBe(true);
    } finally { db.close(); fs.rmSync(project, { recursive: true, force: true }); }
  });

  test('only the focus-appearance chain seeds a reusable browser test baseline, leaving its feature proposed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-ui-baseline-'));
    try {
      for (const scenario of ['dashboard', 'focus-appearance'] as const) {
        const project = path.join(dir, scenario);
        fs.mkdirSync(project);
        seedAutoplanProject(project, scenario);
        const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/autoplan-existing-app/package.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
        const harness = path.join(project, 'tests/sign-in.test.ts');
        if (scenario === 'focus-appearance') {
          expect(manifest.scripts.test).toBe('bun run css && bun test tests/sign-in.test.ts');
          expect(manifest.dependencies).toEqual(original.dependencies);
          expect(manifest.devDependencies).toEqual({ ...original.devDependencies, playwright: '1.62.1' });
          expect(fs.readFileSync(harness, 'utf8')).toBe(fs.readFileSync(path.join(ROOT, 'test/fixtures/autoplan-sign-in-ui/sign-in.test.ts.fixture'), 'utf8'));
          for (const [target, source] of [
            ['.claude/plans/autoplan-focus-appearance.md', 'autoplan-focus-appearance.md'],
            ['DESIGN.md', 'autoplan-focus-appearance-design.md'],
          ]) expect(fs.readFileSync(path.join(project, target), 'utf8')).toBe(fs.readFileSync(path.join(ROOT, 'test/fixtures/plans', source), 'utf8'));
        } else {
          expect(manifest).toEqual(original);
          expect(fs.existsSync(harness)).toBe(false);
        }
        for (const file of ['src/main.tsx', 'src/pages/Workspace.tsx', 'src/server.ts', 'src/auth.ts']) {
          expect(fs.readFileSync(path.join(project, file), 'utf8')).toBe(fs.readFileSync(path.join(ROOT, 'test/fixtures/autoplan-existing-app', file), 'utf8'));
        }
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('both Autoplan seeds declare the existing native review-artifact interface', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-artifact-interface-'));
    try {
      for (const scenario of ['dashboard', 'focus-appearance'] as const) {
        const project = path.join(dir, scenario);
        fs.mkdirSync(project);
        seedAutoplanProject(project, scenario);
        const instructions = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
        expect(instructions).toContain('do not edit application source');
        expect(instructions).toMatch(/review plan and report documents, including the CEO scope summary, inside this project \(including `\.gstack`\) or the current session's private plan directory/);
        expect(instructions).toContain('Use native Write/Edit with absolute paths');
        expect(instructions).toContain('wait for actual permission and a successful tool result before claiming a save');
        expect(instructions).toContain('cannot approve Bash permission prompts');
        expect(instructions).toMatch(/Do not rewrite these review documents through Python, sed, shell redirection or another Bash command/);
        expect(instructions).toContain('Other required artifacts retain the writers specified by the skill');
        expect(instructions).toMatch(/Host restrictions still apply\. If a native save is denied or fails, report it and stop; do not bypass the restriction through the shell/);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

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
test.each(['progress', 'deadline', 'late-completion'] as const)('autoplan permission progression preserves fresh frames and the deadline: %s', mode => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-caller-'));
  const script = path.join(dir, 'caller.fixture.test.ts');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as questions from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-skill-questions.ts'))};
import { isNumberedOptionListVisible, isPermissionDialogVisible } from ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
const root = ${JSON.stringify(ROOT)};
const facts = { inputs: [], inputTimes: [], frameInputs: [], closed: false, startedAt: null, elapsedMs: null };
const mode = ${JSON.stringify(mode)};
let clock = 0, frames = 0, grants = mode === 'late-completion' ? 2 : 0, rawEnd = 100, cwd, file, config, sessionId;
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
    const instructions = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(execFileSync('git', ['show', 'HEAD:CLAUDE.md'], { cwd, encoding: 'utf8', timeout: 5000 })).toBe(instructions);
    expect(instructions).toContain('## Review artifact editing');
    expect(instructions).toContain('The actor cannot approve Bash permission prompts.');
    const design = fs.readFileSync(path.join(root, 'test/fixtures/plans/autoplan-focus-appearance-design.md'), 'utf8');
    expect(fs.readFileSync(path.join(cwd, 'DESIGN.md'), 'utf8')).toBe(design);
    expect(execFileSync('git', ['show', 'HEAD:DESIGN.md'], { cwd, encoding: 'utf8', timeout: 5000 })).toBe(design);
    const proposedPlan = fs.readFileSync(path.join(root, 'test/fixtures/plans/autoplan-focus-appearance.md'), 'utf8');
    expect(execFileSync('git', ['show', 'HEAD:.claude/plans/autoplan-focus-appearance.md'], { cwd, encoding: 'utf8', timeout: 5000 })).toBe(proposedPlan);
    expect(execFileSync('git', ['ls-files', '.claude/plans'], { cwd, encoding: 'utf8', timeout: 5000 }))
      .toBe('.claude/plans/autoplan-focus-appearance.md\\n');
    const currentForm = fs.readFileSync(path.join(root, 'test/fixtures/autoplan-existing-app/src/main.tsx'), 'utf8');
    expect(execFileSync('git', ['show', 'HEAD:src/main.tsx'], { cwd, encoding: 'utf8', timeout: 5000 })).toBe(currentForm);
    const discovery = execFileSync('bash', ['-c', ${JSON.stringify('SLUG=fixture; BRANCH=main; ' + DESIGN_DOC_DISCOVERY_BLOCK)}], {
      cwd, env: { PATH: process.env.PATH, HOME: path.join(cwd, '.isolated-home') }, encoding: 'utf8', timeout: 5000,
    });
    expect(discovery).toBe('Design doc found: ' + path.join(cwd, 'DESIGN.md') + '\\n');
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
        if (mode !== 'progress') clock = facts.startedAt + 900000;
        if (mode === 'late-completion') {
          fs.writeFileSync(path.join(config, 'projects', 'fixture', sessionId + '.jsonl'),
            JSON.stringify({ type: 'assistant', isSidechain: false, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: phaseText }] } }) + '\\n');
          return { rawEnd, text: phaseText };
        }
        return { rawEnd, text: '─'.repeat(120) + '\\n Edit file\\n ' + path.relative(cwd, file) + '\\n' + '╌'.repeat(120) + '\\n' +
          Array.from({ length: 30 }, (_, i) => '  ' + (i + 1) + ' ' + 'plan preview '.repeat(4)).join('\\n') + '\\n' + '╌'.repeat(120) + '\\n Do you want to make this edit to ' + path.basename(file) + '?\\n❯ 1. Yes\\n  2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session\\n  3. No\\nEsc to cancel' };
      },
      send: value => {
        facts.inputs.push(value); facts.inputTimes.push(clock);
        if (value !== '1\\r') { facts.startedAt = clock; return; }
        facts.frameInputs.push(frames); grants++;
        if (grants === 2) fs.writeFileSync(path.join(config, 'projects', 'fixture', sessionId + '.jsonl'),
          JSON.stringify({ type: 'assistant', isSidechain: false, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: phaseText }] } }) + '\\n');
      },
      close: async () => { facts.closed = true; facts.elapsedMs = clock - facts.startedAt; },
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
    expect(child.status, child.stderr).toBe(mode === 'progress' ? 0 : 1);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    if (mode !== 'progress') {
      expect(child.stderr).toContain('outcome=timeout');
      expect(facts.inputs).toEqual(['/autoplan\r']);
      expect(facts.frameInputs).toEqual([]);
      expect(facts.elapsedMs).toBe(900000);
    } else {
      expect(facts.inputs).toEqual(['/autoplan\r', '1\r', '1\r']);
      expect(facts.frameInputs).toEqual([1, 3]);
      // Immediate native ACKs still need fresh frames, not fixed multi-second waits.
      expect(facts.inputTimes[1] - facts.inputTimes[0]).toBeLessThan(1000);
      expect(facts.inputTimes[2] - facts.inputTimes[1]).toBeLessThan(1000);
    }
    expect(facts.closed).toBe(true);
    expect(fs.readdirSync(dir).filter(name => name.startsWith('gstack-autoplan-chain-'))).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
