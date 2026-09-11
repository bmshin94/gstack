/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { CEO_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { describeE2ETier } from './helpers/e2e-gate';
import { seedCeoFindingProject, pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';
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
        seedCeoFindingProject(tmpDir, planText);
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
