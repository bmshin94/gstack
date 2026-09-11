import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyPaidProjection, WebhookDispatcher, type PaymentRequest, type User } from './fixtures/ceo-existing-payment/platform';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject, seedPlanReviewProject, pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';
import * as ceoFixture from './helpers/ceo-finding-fixture';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';
import { DESIGN_DOC_DISCOVERY_BLOCK } from '../scripts/resolvers/design-doc-discovery';

const ROOT = path.resolve(import.meta.dir, '..');

// These boundary probes belong to the harness, not the seeded project's tests.
// They prove the proposed lookup, email and reader decisions remain independent.
function paymentBoundaryDb(): Database {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/ceo-existing-payment/schema.sql'), 'utf8'));
  db.exec("INSERT INTO users VALUES ('acct','user','customer','unpaid'), ('acct','other','customer','unpaid')");
  db.exec("INSERT INTO orders VALUES ('acct','a','user','First',100), ('acct','b','user','Second',200)");
  return db;
}
const paymentRequest = (): PaymentRequest => ({ accountId: 'acct', eventId: 'evt', customerId: 'customer',
  orderIds: ['b', 'a'], params: { userId: 'user' } });
const boundLookup = (db: Database, request: PaymentRequest) => (id: string) =>
  db.query<User, string[]>('SELECT * FROM users WHERE account_id = ? AND id = ?').get(request.accountId, id) ?? undefined;

test('the shared facade does not sanitize the proposed raw lookup into a safe lookup', async () => {
  const db = paymentBoundaryDb();
  const request = { ...paymentRequest(), orderIds: [], params: { userId: "missing' OR id='other' --" } };
  const notified: string[] = [];
  try {
    const callbacks = { readOrders: () => [], afterCommit: async (user: User) => { notified.push(user.id); } };
    expect(await applyPaidProjection(db, request, { ...callbacks, lookupUser: boundLookup(db, request) }))
      .toEqual({ status: 200, kind: 'unknown-user' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 0 });
    expect(await applyPaidProjection(db, request, { ...callbacks, lookupUser: id =>
      db.query<User, []>(`SELECT * FROM users WHERE account_id = '${request.accountId}' AND id = '${id}'`).get() ?? undefined }))
      .toEqual({ status: 200, kind: 'committed' });
    expect(notified).toEqual(['other']);
    expect(db.query('SELECT id,payment_status FROM users ORDER BY id').all()).toEqual([
      { id: 'other', payment_status: 'paid' }, { id: 'user', payment_status: 'unpaid' },
    ]);
  } finally { db.close(); }
});

test('the shared facade leaves an email exception uncaught after the database commit', async () => {
  const db = paymentBoundaryDb(), request = paymentRequest();
  const failure = new Error('mail delivery failed');
  let sends = 0;
  const callbacks = { lookupUser: boundLookup(db, request),
    readOrders: (ids: readonly string[], reader: import('./fixtures/ceo-existing-payment/platform').OrderReader) => reader.list(ids),
    afterCommit: async () => { sends++; throw failure; } };
  try {
    await expect(applyPaidProjection(db, request, callbacks)).rejects.toBe(failure);
    expect(db.query('SELECT payment_status FROM users WHERE id = ?').get('user')).toEqual({ payment_status: 'paid' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 1 });
    expect(db.query('SELECT COUNT(*) AS n FROM payment_audit').get()).toEqual({ n: 1 });
    expect(await applyPaidProjection(db, request, callbacks)).toEqual({ status: 200, kind: 'duplicate' });
    expect(sends).toBe(1);
  } finally { db.close(); }
});

test('registering a handler leaves per-order versus batch reading as a separate choice', async () => {
  const results: Array<{ one: number; list: number; ordered: string[] }> = [];
  for (const strategy of ['one', 'list'] as const) {
    const db = paymentBoundaryDb(), request = paymentRequest(), dispatcher = new WebhookDispatcher();
    const calls = { one: 0, list: 0, ordered: [] as string[] };
    try {
      dispatcher.register('probe', input => applyPaidProjection(db, input, {
        lookupUser: boundLookup(db, request),
        readOrders: (ids, reader) => strategy === 'one'
          ? ids.map(id => { calls.one++; return reader.one(id)!; })
          : (calls.list++, reader.list(ids)),
        afterCommit: async (_user, orders) => { calls.ordered = orders.map(order => order.id); },
      }));
      expect(await dispatcher.dispatch('probe', request)).toEqual({ status: 200, kind: 'committed' });
      results.push(calls);
    } finally { db.close(); }
  }
  expect(results).toEqual([{ one: 2, list: 0, ordered: ['a', 'b'] }, { one: 0, list: 1, ordered: ['a', 'b'] }]);
});

test('the committed current invoice fixture is runnable without implementing the proposed route', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-current-invoice-'));
  try {
    ceoFixture.seedCeoPaymentProject(root, '# Proposed PaymentService\n');
    const child = spawnSync(process.execPath, ['test', 'contract.test.ts'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root, TEMP: root, TMP: root,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toContain('2 pass');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toBe('');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
      expect(execFileSync('git', ['show', 'HEAD:DESIGN.md'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe(design);
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe(plan);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe('');
      expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe('');
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
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toBe(plan);
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
    "## Established integration boundary (unchanged)",
    "",
    "This is a synthetic backend application for handling an already-settled Stripe",
    "payment, not charging a card. Read the existing source in `src/`: it contains a",
    "small payment projection boundary, WebhookDispatcher and the current invoice.paid",
    "handler. The proposed payment_intent.succeeded PaymentService is not implemented.",
    "",
    "The existing ingress adapter verifies Stripe signatures/accounts and envelopes.",
    "It passes event metadata userId unchanged: that string is untrusted. The shared",
    "facade owns receipt deduplication, account/customer authorization, scoped order",
    "reads, and the atomic user-status/receipt/audit transaction. The callback interface",
    "leaves user lookup and order access strategy to the handler. Dispatcher registration",
    "only invokes that handler and supplies none of those choices automatically.",
    "",
    "Events have at most 100 distinct order IDs. The existing confirmation renderer",
    "uses the returned set sorted by ID; an empty set is valid. Missing/foreign data or",
    "database failure leaves the transaction uncommitted. Existing request adaptation",
    "logs these failures and returns 503; unknown users are acknowledged without work.",
    "The local status is an idempotent projection; the financial ledger is upstream.",
    "",
    "Confirmation email runs after this transaction. Its existing client uses the",
    "current template/recipient, aborts after five seconds with MailTimeoutError, and",
    "reports provider rejection as MailDeliveryError. It supplies no retry, outbox or",
    "handler error policy. Ordinary database requests have the existing one-second",
    "statement deadline. The request adapter's scoped logs/metrics and application",
    "release/rollback procedure stay in place. No new schema, migration, quarantine",
    "service, customer-facing UI or handler-routing flag is proposed.",
    "",
    "Existing tests cover only the shared boundary and current invoice.paid handler.",
    "They do not execute the proposed PaymentService. Review its five sections below",
    "and any actual additional defect; none of its remedies has been approved.",
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
    'and existing coverage. The runtime behavior stays fixed.', '',
    '## Proposed verification',
    'For now, manually check `processPayment()` for:',
    '1. The happy path (Stripe succeeds on the first charge — confirm the correct receipt is returned).',
    '2. The error/timeout path (Stripe returns 502 or times out — confirm one retry after the 100 ms wait, then clean failure).', '',
    'Neither path has a dedicated unit test. This proposal relies on manual checks',
    'for both; whether and what dedicated unit coverage to add is unresolved.',
    'The success path is correctness; the failure path is graceful degradation.',
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
    if (!paired) {
      expect(fs.readdirSync(path.join(opts.cwd, 'src')).sort()).toEqual(['existing-invoice-handler.ts', 'platform.ts']);
      for (const file of ['README.md', 'src/platform.ts', 'src/existing-invoice-handler.ts', 'schema.sql', 'contract.test.ts']) {
        expect(execFileSync('git', ['show', 'HEAD:' + file], {
          cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
        })).toBe(fs.readFileSync(path.join(opts.cwd, file), 'utf8'));
      }
    }
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
