/** The chain fixture must reach /autoplan without project-routing onboarding. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedAutoplanProject } from './helpers/autoplan-fixture';

const ROOT = path.resolve(import.meta.dir, '..');

function withFixture(check: (project: string, runStart: () => string, state: string) => void): void {
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
    }), state);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('autoplan project fixture preamble', () => {
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
