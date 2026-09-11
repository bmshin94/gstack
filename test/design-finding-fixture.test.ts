import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('the actual Design count caller commits neutral existing contracts before observation', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-count-fixture-')));
  const facts = path.join(dir, 'facts.json');
  const child = path.join(dir, 'caller.test.ts');
  try {
    fs.writeFileSync(child, `import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertReviewReportAtBottom, designStep0Boundary, PLAN_SKILL_COUNT_FINALIZE_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
import { DESIGN_FINDINGS, pickPlanReviewQuestion } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
const report = assertReviewReportAtBottom, boundary = designStep0Boundary, finalize = PLAN_SKILL_COUNT_FINALIZE_MS;
let project = '', plan = '', observations = 0;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  assertReviewReportAtBottom: report, designStep0Boundary: boundary, PLAN_SKILL_COUNT_FINALIZE_MS: finalize,
  runPlanSkillCounting: async opts => {
    observations++; project = opts.cwd;
    plan = fs.readFileSync(path.join(project, 'review-input.md'), 'utf8');
    const design = fs.readFileSync(path.join(project, 'DESIGN.md'), 'utf8');
    expect(design).toContain('disabled-opacity token to every visual');
    expect(design).toContain('values already use named CSS custom properties');
    expect(design).toContain('unchanged FormStack uses 16px between fields');
    expect(design).toContain('8px between a label and its input');
    expect(design).toContain('Reset and Export are\\ndisabled, Cancel remains available');
    expect(design).toContain('two-pixel offset on all Button variants');
    expect(design).toContain('Settings role values are scoped to the Settings page.');
    expect(design).toContain('wrap in their existing order, with intrinsic widths');
    expect(design).toContain('No new storyboard or onboarding flow is required.');
    expect(design).toContain('choosing the five proposed visual treatments remains open.');
    for (const file of ['DESIGN.md', 'review-input.md']) {
      expect(execFileSync('git', ['show', 'HEAD:' + file], { cwd: project, encoding: 'utf8', timeout: 5000 }))
        .toBe(fs.readFileSync(path.join(project, file), 'utf8'));
    }
    expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd: project, encoding: 'utf8', timeout: 5000 })).toBe('');
    expect(plan).toContain('same size, weight, and color as');
    expect(plan).toContain('24px in some places, 32px in others, and 16px');
    expect(plan).toContain('approximately 3:1 (below WCAG AA)');
    expect(plan).toContain('14px, 16px, and 18px font sizes');
    expect(plan).toContain('2-5 seconds with no loading indicator');
    expect(opts).toEqual({ skillName: 'plan-design-review', slashCommand: '/plan-design-review',
      followUpPrompt: '', isLastStep0AUQ: boundary, reviewCountCeiling: null, questionPick: pickPlanReviewQuestion,
      cwd: project, timeoutMs: expect.any(Number), env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' } });
    expect(opts.timeoutMs).toBeGreaterThan(0); expect(opts.timeoutMs).toBeLessThanOrEqual(1500000);
    expect(finalize).toBe(10000);
    fs.writeFileSync(path.join(project, 'gstack-test-plan-design.md'), '# Reviewed plan\\n\\n## GSTACK REVIEW REPORT\\nVERDICT: APPROVED\\n');
    return { outcome: 'plan_ready', fingerprints: [], diagnostics: {}, step0Count: 2, reviewCount: 5, elapsedMs: 1000 };
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async input => {
    expect(input).toEqual({ plan, targets: DESIGN_FINDINGS, fingerprints: [], kind: 'findings', floor: 4, ceiling: 7, deadlineAt: expect.any(Number) });
    expect(input.deadlineAt).toBeGreaterThan(Date.now());
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ observations, project, targetIds: input.targets.map(t => t.id) }));
    return { count: 5, coveredTargetIds: DESIGN_FINDINGS.map(t => t.id) };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-design-finding-count.test.ts'))});
`);
    await promisify(execFile)(process.execPath, ['test', child], {
      cwd: ROOT, env: { ...process.env, TMPDIR: dir }, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(result.observations).toBe(1);
    expect(result.targetIds).toEqual(['primary-action', 'spacing', 'contrast', 'typography', 'save-feedback']);
    expect(fs.existsSync(result.project)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
