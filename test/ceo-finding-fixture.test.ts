import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject, seedPlanReviewProject } from './helpers/ceo-finding-fixture';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';

const ROOT = path.resolve(import.meta.dir, '..');

describe('CEO finding fixture establishes scope before launch', () => {
  test.each(['plan-eng-review', 'plan-design-review', 'plan-devex-review'] as const)('%s receives its own committed target and routing', skill => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fixture-'));
    try {
      const plan = '# Review this specific plan\nKeep every finding.\n';
      seedPlanReviewProject(root, plan, skill);
      expect(fs.readFileSync(path.join(root, 'review-input.md'), 'utf8')).toBe(plan);
      const guide = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
      expect(guide).toContain(`/${skill}`);
      expect(guide).not.toContain('/plan-ceo-review');
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: root, encoding: 'utf8' })).toBe(plan);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('input and project instructions are committed before the real preamble runs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-finding-seed-'));
    try {
      const cwd = path.join(root, 'project');
      const state = path.join(root, 'state');
      const home = path.join(root, 'home');
      for (const dir of [cwd, state, home]) fs.mkdirSync(dir);
      const plan = '# Payment Processing\nPlease review this exact input.\n';
      seedCeoFindingProject(cwd, plan);
      expect(fs.readFileSync(path.join(cwd, 'review-input.md'), 'utf8')).toBe(plan);
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd, encoding: 'utf8', timeout: 10_000 })).toBe(plan);
      expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd, encoding: 'utf8', timeout: 10_000 })).toBe('');
      expect(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toContain('Read it before\nchoosing review scope');
      fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\nrouting_declined: false\n');
      const output = execFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), ['--skill', 'plan-ceo-review'], {
        cwd, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state }, encoding: 'utf8', timeout: 10_000,
      });
      expect(output).toContain('HAS_ROUTING: yes');
      expect(output).not.toContain('GSTACK_INSTRUCTION_BEGIN: routing-injection');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('the split fixture preserves every candidate and exact per-attempt plan target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-split-seed-'));
    try {
      const target = path.join(root, 'gstack-test-plan-ceo-split-overflow.md');
      const input = FORCING_SPLIT_OVERFLOW_CEO.replaceAll('/tmp/gstack-test-plan-ceo-split-overflow.md', target);
      seedCeoFindingProject(root, input);
      const committed = execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      expect(committed).toBe(input);
      expect(committed).toContain(target);
      expect(committed.match(/^## E[1-5]\)/gm)).toHaveLength(5);
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('Payment processing');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('an existing project cannot be silently overwritten', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-finding-existing-'));
    try {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'operator instructions');
      expect(() => seedCeoFindingProject(root, 'replacement')).toThrow('fresh private directory');
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('operator instructions');
      expect(fs.readdirSync(root)).toEqual(['CLAUDE.md']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
