import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject, seedPlanReviewProject, pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';
import * as ceoFixture from './helpers/ceo-finding-fixture';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';
import { DESIGN_DOC_DISCOVERY_BLOCK } from '../scripts/resolvers/design-doc-discovery';

const ROOT = path.resolve(import.meta.dir, '..');

const reviewStartLead = 'D1 — Run /office-hours before this review?';
const reviewStartLabels = ['A) Run /office-hours first', 'B) Skip — standard review (recommended)'];
test.each([
  [reviewStartLead, reviewStartLabels, 2],
  ['D1 — No design doc found: run /office-hours before the review?', ['Run /office-hours now', 'Skip — proceed with review (Recommended)'], 2],
  [reviewStartLead, ['Skip — standard review', 'Run /office-hours first'], 1],
  ...['Example: ', 'If approved: ', 'Do not ', '> ', '    ', '"', '`'].map(prefix => [prefix + reviewStartLead, reviewStartLabels, 1]),
  ['D1 — Discuss /office-hours in our documentation?', reviewStartLabels, 1],
  ['D1 — Run /office-hours instead of this review?', reviewStartLabels, 1],
  [reviewStartLead, ['Run /office-hours first', 'Skip'], 1],
  [reviewStartLead, ['Run /office-hours first', 'Skip security review'], 1],
  [reviewStartLead, ['Run /office-hours first', 'Skip — standard review', 'Something else'], 1],
  [reviewStartLead, ['Skip — standard review', 'Skip — proceed with review'], 1],
  [reviewStartLead, ['Run /office-hours first', '"Skip — standard review"'], 1],
  [reviewStartLead, ['Run /office-hours first if approved', 'Skip — standard review'], 1],
] as const)('mode start recognizes only the explicit supplied-review route (%s)', (question, labels, expected) => {
  expect(ceoFixture.pickSuppliedCeoModeStart({ question, options: labels.map((label, i) => ({ index: i + 1, label })) })).toBe(expected);
});

test.each([
  { labels: ['Run /office-hours now', 'Skip — standard review (Recommended)'], expected: 2 },
  { labels: ['Skip — standard review', 'Run /office-hours now'], expected: 1 },
  { labels: ['A) Run /office-hours now', 'B) Skip (standard review without design doc context)'], expected: 2 },
  { labels: ['Run /office-hours', 'Skip'], expected: 2 },
  { labels: ['SCOPE EXPANSION', 'HOLD SCOPE (Recommended)'], expected: 1 },
  { labels: ['Approach A', 'Approach B (Recommended)'], expected: 1 },
  { labels: ['Run /office-hours now', 'Skip security review'], expected: 1 },
  { labels: ['Discuss /office-hours later', 'Skip — standard review'], expected: 1 },
  { labels: ['Run /office-hours now', 'Skip — standard review', 'Skip'], expected: 1 },
  { labels: ['Run /office-hours now', 'Skip — standard review', 'Something else'], expected: 1 },
])('supplied CEO plan chooses only the explicit prerequisite skip: $labels', ({ labels, expected }) => {
  const options = labels.map((label, i) => ({ index: i + 1, label }));
  expect(pickSuppliedCeoPlanStart({ options })).toBe(expected);
});

describe('CEO finding fixture establishes scope before launch', () => {
  test('a supplied design satisfies actual prerequisite discovery without becoming a branch change', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-design-seed-'));
    try {
      const cwd = path.join(root, 'project');
      const home = path.join(root, 'home');
      fs.mkdirSync(cwd); fs.mkdirSync(home);
      const plan = '# Export saved settings\nReview the CSV formatter before implementation.\n';
      const design = '# Settings export design\n\n## Problem\nOperators need saved settings in a spreadsheet for offline comparison.\n\n## Approach\nReuse the settings API and escape commas, quotes, and newlines in a CSV formatter.\n';
      seedCeoFindingProject(cwd, plan, design);
      const output = execFileSync('bash', ['-c', `SLUG=fixture; BRANCH=main; ${DESIGN_DOC_DISCOVERY_BLOCK}`], {
        cwd, env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 10_000,
      });
      expect(output).toBe(`Design doc found: ${path.join(cwd, 'DESIGN.md')}\n`);
      expect(execFileSync('git', ['show', 'HEAD:DESIGN.md'], { cwd, encoding: 'utf8' })).toBe(design);
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd, encoding: 'utf8' })).toBe(plan);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd, encoding: 'utf8' })).toBe('');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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
// and semantic-judge boundaries. Real seeding, outcome/report checks, and cleanup stay in use.
test.each(['success5', 'success7', 'success-paired', 'below', 'above', 'missing-report', 'trailing-report', 'timeout', 'throw', 'judge-error'])('count registration: %s', scenario => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-count-body-')));
  const script = path.join(root, 'registration.test.ts');
  const factsPath = path.join(root, 'facts.json');
  const established = [
    "## Established platform (unchanged)",
    "The running payment flow uses WebhookDispatcher and the existing Stripe, database",
    "and mail clients. This is a backend change: the event format, confirmation-email",
    "template and recipient resolution, UI, dependencies and credentials stay unchanged.",
    "Admission middleware verifies the raw Stripe signature and signing account,",
    "checks the JSON envelope/event ID/type and rejects malformed or oversized bodies.",
    "Unsupported event types are acknowledged without work. The request userId remains",
    "untrusted and is passed unchanged to the handler. Database access is scoped",
    "to the signing account. Missing/empty userId or an unknown user is logged and",
    "acknowledged with 200, without a mutation or email.",
    "The handler performs its user lookup first. Before any payment update, the existing",
    "repository commit guard requires the selected user's stored Stripe customer ID to",
    "match the verified event's nonempty payment customer ID within the signing account.",
    "A missing or mismatched customer is logged and returns 403 without mutation or email.",
    "Before exposing any order data, the existing repository read guard checks this",
    "customer match and rejects it with the same 403 policy. It also acknowledges",
    "a committed event receipt with 200 before reading orders, even if referenced",
    "orders were later deleted. The commit transaction still rechecks both guards",
    "under lock; concurrent first deliveries are deduplicated only at commit.",
    "",
    "The existing repository transaction owns the unique event receipt, payment update",
    "and audit entry as one atomic commit, including concurrent deliveries. A failed or",
    "rolled-back transaction never marks an event processed; a committed duplicate is",
    "acknowledged without another mutation. Payment success only sets the existing",
    "users.payment_status column to 'paid'. The audit records event/account/user IDs,",
    "changed fields and timestamp. User and order reads finish before this commit.",
    "Existing order-reader authorization scopes every requested order ID to the",
    "signing account and selected user; a foreign order follows the same missing",
    "order quarantine policy below. It applies to individual reads as well as lists.",
    "An empty order list is valid. Order reads supply line-item labels and amounts for",
    "the unchanged itemized confirmation-email template. A missing referenced order quarantines the",
    "event, logs its ID and returns 200 without a payment mutation or email; it does not",
    "write a processed-event receipt. Before 200, the existing account/event-keyed",
    "quarantine store durably records the verified payload, requested user ID and reason.",
    "A failed quarantine write returns 503. The existing on-call runbook restores missing",
    "data and replays the retained event through the same identity checks and idempotent",
    "transaction. DatabaseConnectionError, StatementTimeoutError",
    "and DeadlockDetectedError from any repository read/write abort the whole",
    "transaction; the existing request adapter logs the operation and event ID, returns",
    "503 and leaves Stripe able to retry. No partial order results escape. These",
    "facilities are below both handlers and do not depend on WebhookDispatcher.",
    "",
    "The user lookup uses users.id; individual order reads use orders.id. Both are",
    "existing primary keys; the orders.user_id list lookup is also indexed. Admission",
    "permits at most 100 orders per event and 20 concurrent requests within the existing",
    "25-connection pool. Requests beyond the payload/order limits are rejected with 400;",
    "excess concurrency returns 503 for retry. Neither marks an event processed. The",
    "repository has a one-second statement deadline. Email is sent only after the",
    "database commit and remains inline, with no email-leg catch, outbox or retry in",
    "the proposed handler.",
    "The unchanged mail client aborts a send after five seconds and releases",
    "its resources, throwing MailTimeoutError. It never retries automatically;",
    "provider-declared rejections use MailDeliveryError. The handler has no catch.",
    "",
    "The existing request/repository instrumentation carries a correlation ID and emits",
    "operation/status/latency/error-code logs and query/commit/failure metrics without",
    "raw payloads, credentials or email content. The payments dashboard and on-call",
    "alerts cover failed requests, missing commits, latency and pool saturation;",
    "retained event/audit records support the documented retry and incident runbooks.",
    "The platform team owns these clients, schema, operational docs and runbooks. Its",
    "existing tests cover these unchanged contracts, not the new PaymentService path.",
    "",
    "An upstream routing flag, outside WebhookDispatcher, switches traffic between the",
    "old and new handlers. They share the same event-receipt transaction and schema.",
    "The existing rollout runbook deploys to staging, checks the request/commit metrics,",
    "then increases the flag gradually. Rollback disables the flag, drains in-flight",
    "requests and reverts the release. Events whose database transaction did not commit",
    "remain retryable. There is no migration or backfill, and the old route remains",
    "available during mixed versions.",
    "For effects already committed by a defective release, the existing rollback",
    "runbook reconciles verified Stripe events against the payment/audit records",
    "and applies documented per-event corrections and confirmation re-sends. The",
    "platform team owns these repair procedures; rollout disables traffic first.",
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
  const pairedPlan = [
    '# Plan: Payment Processing — Test Coverage', '',
    '## Existing implementation',
    'Read README.md, src/payment.ts and contract.test.ts for the unchanged function',
    'and existing coverage. This change adds tests; the runtime behavior stays fixed.', '',
    '## Tests',
    'We need test coverage for `processPayment()`. Specifically:',
    '1. The happy path (successful Stripe charge — assert correct receipt is generated).',
    '2. The error/timeout path (Stripe returns 502 — assert retry-with-backoff fires once, then fails clean).', '',
    'Currently neither has a unit test. These are deliberately separate concerns:',
    'the success path is correctness, the failure path is graceful degradation.',
  ].join('\n');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertReviewReportAtBottom, ceoStep0Boundary, PLAN_SKILL_COUNT_FINALIZE_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
import { pickSuppliedCeoPlanStart } from ${JSON.stringify(path.join(ROOT, 'test/helpers/ceo-finding-fixture.ts'))};
import { CEO_FINDINGS, CEO_PAIRED_FINDINGS, pickPlanReviewQuestion } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
const reportAssertion = assertReviewReportAtBottom;
const step0Boundary = ceoStep0Boundary;
const finalizeMs = PLAN_SKILL_COUNT_FINALIZE_MS;
const scenario = ${JSON.stringify(scenario)};
const paired = scenario === 'success-paired';
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
    const target = path.join(opts.cwd, paired ? 'gstack-test-plan-ceo-paired.md' : 'gstack-test-plan-ceo.md');
    expect(input).toBe([
      'Please review this plan thoroughly. As you go, write your plan-mode plan to ' + target + ' (use Edit/Write to that exact path).',
      'Use HOLD SCOPE mode for this review; examine the current plan with full rigor.', '',
      ...(paired ? [${JSON.stringify(pairedPlan)}] : [
        '# Plan: Payment Processing Integration', '',
        ${JSON.stringify(established)}, '', ${JSON.stringify(originalDefects)},
      ]),
    ].join('\\n'));
    expect(execFileSync('git', ['show', 'HEAD:review-input.md'], {
      cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
    })).toBe(input);
    expect(execFileSync('git', ['diff', 'origin/main...HEAD'], {
      cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
    })).toBe('');
    if (paired) {
      for (const file of ['README.md', 'src/payment.ts', 'contract.test.ts']) {
        expect(execFileSync('git', ['show', 'HEAD:' + file], {
          cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
        })).toBe(fs.readFileSync(path.join(opts.cwd, file), 'utf8'));
      }
    }
    expect(opts).toEqual({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
      firstAUQPick: pickSuppliedCeoPlanStart,
      isLastStep0AUQ: step0Boundary, reviewCountCeiling: null, questionPick: pickPlanReviewQuestion, cwd: opts.cwd,
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
      outcome: scenario === 'timeout' ? 'timeout' : 'plan_ready',
      reviewCount: { success5: 5, success7: 7, 'success-paired': 2, below: 3, above: 8 }[scenario] ?? 5,
      step0Count: 2, elapsedMs: 1000, fingerprints: [], evidence: 'controlled observation',
    };
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async input => {
    const facts = JSON.parse(fs.readFileSync(${JSON.stringify(factsPath)}, 'utf8'));
    facts.judgeCalls = (facts.judgeCalls ?? 0) + 1;
    fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify(facts));
    expect(input).toEqual({
      plan: fs.readFileSync(path.join(facts.cwd, 'review-input.md'), 'utf8'),
      targets: paired ? CEO_PAIRED_FINDINGS : CEO_FINDINGS, fingerprints: [], kind: 'findings',
      floor: paired ? 2 : 4, ceiling: paired ? 4 : 7,
      deadlineAt: expect.any(Number),
    });
    expect(input.deadlineAt).toBeGreaterThan(Date.now());
    expect(input.deadlineAt).toBeLessThanOrEqual(Date.now() + 1_500_000);
    if (scenario === 'below') throw new Error('controlled finding floor failure');
    if (scenario === 'above') throw new Error('controlled finding ceiling failure');
    if (scenario === 'judge-error') throw new Error('controlled classification failure');
    return { count: paired ? 2 : scenario === 'success7' ? 7 : 5,
      coveredTargetIds: (paired ? CEO_PAIRED_FINDINGS : CEO_FINDINGS).map(target => target.id) };
  },
}));
await import(${JSON.stringify(path.join(ROOT, scenario === 'success-paired'
  ? 'test/skill-e2e-plan-ceo-paired-control.test.ts' : 'test/skill-e2e-plan-ceo-finding-count.test.ts'))});
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
    expect(facts.judgeCalls ?? 0).toBe(['success5', 'success7', 'success-paired', 'below', 'above', 'judge-error'].includes(scenario) ? 1 : 0);
    expect(fs.existsSync(facts.cwd), 'actual paid finally must remove its owned fixture').toBe(false);
    expect(child.status, output).toBe(scenario.startsWith('success') ? 0 : 1);
    const failures: Record<string, string> = {
      below: 'controlled finding floor failure',
      above: 'controlled finding ceiling failure',
      'judge-error': 'controlled classification failure',
      'missing-report': 'D19 FAIL: agent did not produce expected plan file',
      'trailing-report': 'trailing ## heading(s) after GSTACK REVIEW REPORT',
      timeout: 'finding-count FAILED: outcome=timeout',
      throw: 'controlled count observation failure',
    };
    if (failures[scenario]) expect(output).toContain(failures[scenario]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);
