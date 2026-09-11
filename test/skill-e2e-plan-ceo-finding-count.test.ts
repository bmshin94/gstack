/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { CEO_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { describeE2ETier } from './helpers/e2e-gate';
import { seedCeoPaymentProject, pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  ceoStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N_DISTINCT = 5;
const FLOOR_DISTINCT = N_DISTINCT - 1; // 4 (D11)
const CEILING_DISTINCT = N_DISTINCT + 2; // 7 (D11)

const planCeo5Findings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  'Use HOLD SCOPE mode for this review; examine the current plan with full rigor.',
  '',
  '# Plan: Payment Processing Integration',
  '',
  "## Revised synthetic integration baseline",
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
  "The invoice handler uses independently reusable createBoundUserLookup and",
  "readOrdersInBatch callbacks from platform.ts; neither is a default for new handlers.",
  "",
  "Events have at most 100 distinct order IDs. The existing confirmation renderer",
  "uses the returned set sorted by ID; an empty set is valid. Missing orders or",
  "database failure leaves the transaction uncommitted. Existing request adaptation",
  "logs these failures and returns 503; authorization rejection remains 403, and",
  "unknown users are acknowledged without work.",
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
  "application.ts materializes the existing request adapter and composition API:",
  "its services expose db, mail, logger and metrics alongside the current dispatcher.",
  "Request metrics and failure logs already include the supplied eventType.",
  "NEW synthetic assumptions in this revision: an unregistered event returns 503",
  "without projection/mail work (no external retry guarantee); the bounded mail",
  "client records each send outcome before any handler catch and rethrows the same",
  "error. Telemetry is best effort and preserves the transport outcome. This adds",
  "no handler recovery, retry/outbox, alert rule or new-path regression coverage.",
  "",
  "Existing tests cover only the shared boundary and current invoice.paid handler.",
  "They do not execute the proposed PaymentService. Review its five sections below",
  "and any actual additional defect; none of its remedies has been approved.",
  '',
  '## Architecture',
  "We're adding a new `PaymentService` class that will handle Stripe webhooks.",
  'This bypasses the existing `WebhookDispatcher` module — we want a clean',
  'namespace separation.',
  '',
  '## Database access',
  'The new endpoint reads `request.params.userId` directly into a raw SQL',
  'fragment for the lookup query.',
  '',
  '## Webhook fan-out',
  'On payment success we update the user record AND fire a notification email.',
  'Both happen inline; no error handling on the email leg.',
  '',
  '## Tests',
  "None planned. We'll rely on the existing integration suite catching regressions.",
  '',
  '## Performance',
  'Each webhook lookup hits the database for the user, then fetches each',
  'order in a loop.',
].join('\n');

describeE2E('/plan-ceo-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR_DISTINCT}-${CEILING_DISTINCT} substantive finding calls`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-ceo-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-ceo.md');

      try {
        const planText = planCeo5Findings(planPath);
        seedCeoPaymentProject(tmpDir, planText);
        const obs = await runPlanSkillCounting({
          skillName: 'plan-ceo-review',
          slashCommand: '/plan-ceo-review',
          followUpPrompt: '', // review-input.md is available before the first scope question
          firstAUQPick: pickSuppliedCeoPlanStart,
          isLastStep0AUQ: ceoStep0Boundary,
          reviewCountCeiling: null, // classify findings after actual workflow completion
          questionPick: pickPlanReviewQuestion,
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt), // 25 min
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        console.log('Plan review native evidence:', JSON.stringify({
          plan: planText, outcome: obs.outcome, fingerprints: obs.fingerprints, diagnostics: obs.diagnostics,
        }));

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
          throw new Error(
            `plan-ceo-review finding-count FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `last sampled counting state: ${JSON.stringify(obs.diagnostics)}\n` +
              `fingerprints (last 8):\n` +
              obs.fingerprints
                .slice(-8)
                .map(
                  (f, i) =>
                    `  ${i}. preReview=${f.preReview} sig=${f.signature.slice(0, 12)} prompt="${f.promptSnippet.slice(0, 60)}"`,
                )
                .join('\n') +
              `\n--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        // D19: review report at bottom of plan file.
        if (!fs.existsSync(planPath)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${planPath}.\n` +
              `Either the agent ignored the path instruction in review-input.md, or\n` +
              `the helper exited before the agent wrote the file. ` +
              `outcome=${obs.outcome} review=${obs.reviewCount}`,
          );
        }
        const planContent = fs.readFileSync(planPath, 'utf-8');
        const verdict = assertReviewReportAtBottom(planContent);
        if (!verdict.ok) {
          throw new Error(
            `D19 FAIL: plan file at ${planPath} ${verdict.reason}\n` +
              (verdict.trailingHeadings
                ? `Trailing headings: ${verdict.trailingHeadings.join(' | ')}\n`
                : '') +
              `--- plan content (last 1KB) ---\n${planContent.slice(-1024)}`,
          );
        }
        const decisions = await evaluatePlanReviewDecisions({
          plan: planText, targets: CEO_FINDINGS, fingerprints: obs.fingerprints,
          kind: 'findings', floor: FLOOR_DISTINCT, ceiling: CEILING_DISTINCT,
          deadlineAt: caseStartedAt + 1_500_000,
        });
        console.log('Plan review decisions verified:', JSON.stringify({
          count: decisions.count, coveredTargetIds: decisions.coveredTargetIds, report: 'D19 passed',
        }));
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_500_000 + PLAN_SKILL_COUNT_FINALIZE_MS /* same work budget, plus bounded finalization */,
  );

});
