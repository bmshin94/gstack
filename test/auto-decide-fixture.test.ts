/** Real preamble/preference checks for the explicit AUTO_DECIDE state override. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedHermeticGstackHome } from './helpers/hermetic-env';

const ROOT = path.resolve(import.meta.dir, '..');
const TARGET = 'plan-ceo-review-mode';
const UNRELATED = 'feature-continuous-checkpoint';

function withFixture(check: (fixture: {
  state: string;
  home: string;
  preferenceFile: string;
  run: (bin: string, args?: string[], input?: string) => string;
}) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-decide-fixture-'));
  try {
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    const tmp = path.join(root, 'tmp');
    for (const dir of [project, home, state, tmp]) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(home, '.gstack'));
    fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), 'operator sentinel\n');
    const env = {
      PATH: process.env.PATH!, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      GSTACK_HOME: state, CONDUCTOR_WORKSPACE_PATH: project,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: project, env, stdio: 'pipe', timeout: 10_000 });
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Test project\n\n## Skill routing\n\n- Review plans with /plan-ceo-review.\n');
    const run = (bin: string, args: string[] = [], input?: string): string =>
      execFileSync(path.join(ROOT, 'bin', bin), args, {
        cwd: project, env, input, encoding: 'utf8', timeout: 10_000,
      });

    // Same explicit baseline as the paid case; never seed a blanket preference.
    seedHermeticGstackHome(state);
    run('gstack-config', ['set', 'question_tuning', 'true']);
    run('gstack-question-preference', ['--write', JSON.stringify({
      question_id: TARGET, preference: 'never-ask', source: 'plan-tune',
    })]);
    const rawSlug = run('gstack-slug').match(/SLUG=([^\s;]+)/)?.[1];
    if (!rawSlug) throw new Error('Fixture project slug was not emitted');
    const slug = rawSlug.replace(/['"]/g, '');
    const preferenceFile = path.join(state, 'projects', slug, 'question-preferences.json');
    check({ state, home, preferenceFile, run });
    expect(fs.readFileSync(path.join(home, '.gstack', 'config.yaml'), 'utf8')).toBe('operator sentinel\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('AUTO_DECIDE explicit fixture state', () => {
  test('normal baseline reaches the target preference without unrelated onboarding', () => {
    withFixture(({ preferenceFile, run }) => {
      const output = run('gstack-skill-start', ['--skill', 'plan-ceo-review']);
      expect(output).toContain('SKILL_START_PROTO: 1');
      expect(output).toContain('SESSION_KIND: interactive');
      expect(output).toContain('CONDUCTOR_SESSION: true');
      expect(output).toContain('QUESTION_TUNING: true');
      expect(output).toContain('UPDATE_CHECK: false');
      expect(output).not.toContain('GSTACK_INSTRUCTION_BEGIN:');
      expect(run('gstack-question-preference', ['--check', TARGET, '--summary-stdin'], 'Choose the CEO review mode')).toBe('AUTO_DECIDE\n');
      expect(run('gstack-question-preference', ['--check', UNRELATED, '--summary-stdin'], 'Enable continuous checkpoint auto-commits?')).toBe('ASK_NORMALLY\n');
      expect(JSON.parse(fs.readFileSync(preferenceFile, 'utf8'))).toEqual({ [TARGET]: 'never-ask' });
    });
  });

  test('the missing checkpoint marker reproduces the unrelated question from both paid failures', () => {
    withFixture(({ state, run }) => {
      fs.unlinkSync(path.join(state, '.feature-prompted-continuous-checkpoint'));
      const output = run('gstack-skill-start', ['--skill', 'plan-ceo-review']);
      expect(output).toContain('GSTACK_INSTRUCTION_BEGIN: feature-checkpoint ');
      expect(output).toContain('Feature discovery: AskUserQuestion for Continuous checkpoint auto-commits.');
      expect(run('gstack-question-preference', ['--check', TARGET])).toBe('AUTO_DECIDE\n');
      expect(run('gstack-question-preference', ['--check', UNRELATED])).toBe('ASK_NORMALLY\n');
    });
  });

  test('seeding refuses existing state and a symlink instead of resetting its target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-decide-seed-'));
    try {
      const state = path.join(root, 'state');
      const alias = path.join(root, 'alias');
      fs.mkdirSync(state);
      fs.writeFileSync(path.join(state, 'config.yaml'), 'operator sentinel\n');
      fs.symlinkSync(state, alias, 'dir');
      expect(() => seedHermeticGstackHome(state)).toThrow('private, existing empty directory');
      expect(() => seedHermeticGstackHome(alias)).toThrow('private, existing empty directory');
      expect(fs.readdirSync(state)).toEqual(['config.yaml']);
      expect(fs.readFileSync(path.join(state, 'config.yaml'), 'utf8')).toBe('operator sentinel\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
