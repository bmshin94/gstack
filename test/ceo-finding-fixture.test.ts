import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
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

// Import the actual paid registration only after replacing its observation
// boundary. The real seeder, Step-0 boundary and report assertion stay in use.
test.each(['success4', 'success7', 'below', 'above', 'missing-report', 'trailing-report', 'timeout', 'throw'])('count registration: %s', scenario => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-count-body-')));
  const script = path.join(root, 'registration.test.ts');
  const factsPath = path.join(root, 'facts.json');
  const established = [
    '## Established payment boundary',
    'Existing admission middleware verifies Stripe signatures before either handler path.',
    'The existing database event-ID guard prevents duplicate payment mutations under',
    'retries and concurrency; it does not deliver or retry notification emails.',
    'A database audit mechanism records each payment mutation with its event ID, user ID,',
    'changed fields and timestamp in the same transaction.',
    'Absent or empty userId, or a lookup with no matching user, is logged and acknowledged',
    'with 200, without a mutation or email. A successful payment only sets the existing',
    "users.payment_status column to 'paid'; no schema change is needed.",
    'These deployed facilities operate independently of WebhookDispatcher and remain unchanged.',
  ].join('\n');
  const originalDefects = [
    '## Architecture',
    "We're adding a new `PaymentService` class that will handle Stripe webhooks.",
    'This bypasses the existing `WebhookDispatcher` module — we want a clean',
    'namespace separation.', '',
    '## Database access',
    'The new endpoint reads `request.params.userId` directly into a raw SQL',
    'fragment for the lookup query.', '',
    '## Webhook fan-out',
    'On payment success we update the user record AND fire a notification email.',
    'Both happen inline; no error handling on the email leg.', '',
    '## Tests',
    "None planned. We'll rely on the existing integration suite catching regressions.", '',
    '## Performance',
    'Each webhook lookup hits the database for the user, then fetches each',
    'order in a loop.',
  ].join('\n');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertReviewReportAtBottom, ceoStep0Boundary, PLAN_SKILL_COUNT_FINALIZE_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
const reportAssertion = assertReviewReportAtBottom;
const step0Boundary = ceoStep0Boundary;
const finalizeMs = PLAN_SKILL_COUNT_FINALIZE_MS;
const scenario = ${JSON.stringify(scenario)};
let calls = 0;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  assertReviewReportAtBottom: reportAssertion,
  ceoStep0Boundary: step0Boundary,
  PLAN_SKILL_COUNT_FINALIZE_MS: finalizeMs,
  runPlanSkillCounting: async opts => {
    calls++;
    const facts = { calls, cwd: opts.cwd, validated: false };
    fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify(facts));
    expect(path.dirname(opts.cwd)).toBe(${JSON.stringify(root)});
    const input = fs.readFileSync(path.join(opts.cwd, 'review-input.md'), 'utf8');
    const target = path.join(opts.cwd, 'gstack-test-plan-ceo.md');
    expect(input).toBe([
      'Please review this plan thoroughly. As you go, write your plan-mode plan to ' + target + ' (use Edit/Write to that exact path).',
      '', '# Plan: Payment Processing Integration', '',
      ${JSON.stringify(established)}, '', ${JSON.stringify(originalDefects)},
    ].join('\\n'));
    expect(execFileSync('git', ['show', 'HEAD:review-input.md'], {
      cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
    })).toBe(input);
    expect(execFileSync('git', ['diff', 'origin/main...HEAD'], {
      cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
    })).toBe('');
    expect(opts).toEqual({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
      isLastStep0AUQ: step0Boundary, reviewCountCeiling: 8, cwd: opts.cwd,
      timeoutMs: expect.any(Number), env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    });
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(1_500_000);
    expect(finalizeMs).toBe(10_000);
    facts.validated = true;
    fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify(facts));
    if (scenario === 'throw') throw new Error('controlled count observation failure');
    if (scenario !== 'missing-report') fs.writeFileSync(target,
      '# Reviewed plan\\n\\n## GSTACK REVIEW REPORT\\nVERDICT: APPROVED\\n' +
      (scenario === 'trailing-report' ? '\\n## Unreviewed tail\\n' : ''));
    return {
      outcome: scenario === 'timeout' ? 'timeout' : scenario === 'above' ? 'ceiling_reached' : 'plan_ready',
      reviewCount: { success4: 4, success7: 7, below: 3, above: 8 }[scenario] ?? 5,
      step0Count: 2, elapsedMs: 1000, fingerprints: [], evidence: 'controlled observation',
    };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-ceo-finding-count.test.ts'))});
`);
  try {
    const child = spawnSync(process.execPath, ['test', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root, TEMP: root, TMP: root,
        GIT_CONFIG_NOSYSTEM: '1', EVALS_HERMETIC: '1',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    const output = child.stdout + child.stderr;
    expect(child.error, output).toBeUndefined();
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts.calls).toBe(1);
    expect(facts.validated, output).toBe(true);
    expect(fs.existsSync(facts.cwd), 'actual paid finally must remove its owned fixture').toBe(false);
    expect(child.status, output).toBe(scenario.startsWith('success') ? 0 : 1);
    const failures: Record<string, string> = {
      below: 'BAND FAIL (below floor): reviewCount=3 < FLOOR=4.',
      above: 'BAND FAIL (above ceiling): reviewCount=8 > CEILING=7.',
      'missing-report': 'D19 FAIL: agent did not produce expected plan file',
      'trailing-report': 'trailing ## heading(s) after GSTACK REVIEW REPORT',
      timeout: 'finding-count FAILED: outcome=timeout',
      throw: 'controlled count observation failure',
    };
    if (failures[scenario]) expect(output).toContain(failures[scenario]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);
