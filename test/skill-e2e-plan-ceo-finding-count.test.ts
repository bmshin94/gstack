/**
 * /plan-ceo-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Asserts the load-bearing rule "One issue = one AskUserQuestion call" by
 * driving /plan-ceo-review against a 5-finding seeded plan and counting
 * distinct review-phase AUQs. Passes when count is in [N-1, N+2].
 *
 * This file covers the 5-finding distinct fixture. The 2-finding paired
 * control has its own paid process in skill-e2e-plan-ceo-paired-control.test.ts
 * so both cases retain their complete 25-minute budget even in serial runs.
 *
 * Tier: periodic. Each run drives Step 0 + 11 review sections end-to-end
 * (~25 min, ~$5/run). Sequential by default per plan §D15. See
 * test/helpers/claude-pty-runner.ts for runPlanSkillCounting internals.
 */

import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import { seedCeoFindingProject } from './helpers/ceo-finding-fixture';
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
  '',
  '# Plan: Payment Processing Integration',
  '',
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
    `5-finding plan emits ${FLOOR_DISTINCT}-${CEILING_DISTINCT} review-phase AskUserQuestions`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-ceo-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-ceo.md');

      try {
        seedCeoFindingProject(tmpDir, planCeo5Findings(planPath));
        const obs = await runPlanSkillCounting({
          skillName: 'plan-ceo-review',
          slashCommand: '/plan-ceo-review',
          followUpPrompt: '', // review-input.md is available before the first scope question
          isLastStep0AUQ: ceoStep0Boundary,
          reviewCountCeiling: CEILING_DISTINCT + 1, // hard cap above assertion ceiling
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt), // 25 min
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `plan-ceo-review finding-count FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
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
        if (obs.reviewCount < FLOOR_DISTINCT) {
          throw new Error(
            `BAND FAIL (below floor): reviewCount=${obs.reviewCount} < FLOOR=${FLOOR_DISTINCT}.\n` +
              `Check scope, Step-0 boundary, and finding evidence before diagnosing batching.\n` +
              `outcome=${obs.outcome} step0=${obs.step0Count} elapsed=${obs.elapsedMs}ms\n` +
              `Fingerprints (review-phase only):\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
          );
        }
        if (obs.reviewCount > CEILING_DISTINCT) {
          throw new Error(
            `BAND FAIL (above ceiling): reviewCount=${obs.reviewCount} > CEILING=${CEILING_DISTINCT}.\n` +
              `Possible over-asking regression. Review-phase fingerprints:\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
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
