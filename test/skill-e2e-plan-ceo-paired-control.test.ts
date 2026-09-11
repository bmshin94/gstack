/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */
import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { CEO_PAIRED_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { describeE2ETier } from './helpers/e2e-gate';
import { pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';
import { seedCeoPairedProject } from './helpers/ceo-paired-fixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  ceoStep0Boundary,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N_PAIRED = 2;
const FLOOR_PAIRED = 2;
const CEILING_PAIRED = 4;

const planCeo2PairedFindings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  'Use HOLD SCOPE mode for this review; examine the current plan with full rigor.',
  '',
  '# Plan: Payment Processing — Test Coverage',
  '',
  '## Existing implementation',
  'Read README.md, src/payment.ts and contract.test.ts for the unchanged function',
  'and existing coverage. The runtime behavior stays fixed.',
  '',
  '## Proposed verification',
  'For now, manually check `processPayment()` for:',
  '1. The happy path (Stripe succeeds on the first charge — confirm the correct receipt is returned).',
  '2. The error/timeout path (Stripe returns 502 or times out — confirm one retry after the 100 ms wait, then clean failure).',
  '',
  'Neither path has a dedicated unit test. This proposal relies on manual checks',
  'for both; whether and what dedicated unit coverage to add is unresolved.',
  'The success path is correctness; the failure path is graceful degradation.',
].join('\n');

describeE2E('/plan-ceo-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `paired-finding positive control: ${N_PAIRED} related findings produce ${FLOOR_PAIRED}-${CEILING_PAIRED} AskUserQuestions`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir — see the distinct-findings test above.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-ceo-paired-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-ceo-paired.md');

      try {
        const planText = planCeo2PairedFindings(planPath);
        seedCeoPairedProject(tmpDir, planText);
        const obs = await runPlanSkillCounting({
          skillName: 'plan-ceo-review',
          slashCommand: '/plan-ceo-review',
          followUpPrompt: '', // same fixture-first scope contract as the distinct case
          firstAUQPick: pickSuppliedCeoPlanStart,
          isLastStep0AUQ: ceoStep0Boundary,
          reviewCountCeiling: null, // classify findings after actual workflow completion
          questionPick: pickPlanReviewQuestion,
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt),
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        console.log('Plan review native evidence:', JSON.stringify({
          plan: planText, outcome: obs.outcome, fingerprints: obs.fingerprints, diagnostics: obs.diagnostics,
        }));

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
          throw new Error(
            `paired-finding control FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount}\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        const decisions = await evaluatePlanReviewDecisions({
          plan: planText, targets: CEO_PAIRED_FINDINGS, fingerprints: obs.fingerprints,
          kind: 'findings', floor: FLOOR_PAIRED, ceiling: CEILING_PAIRED,
          deadlineAt: caseStartedAt + 1_500_000,
        });
        console.log('Plan review decisions verified:', JSON.stringify({
          count: decisions.count, coveredTargetIds: decisions.coveredTargetIds,
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
