/** Paired finding control in its own process; original count bounds and 25-minute model budget. */
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
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N_PAIRED = 2;
const FLOOR_PAIRED = 2;
const CEILING_PAIRED = 4;

const planCeo2PairedFindings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  '',
  '# Plan: Payment Processing — Test Coverage',
  '',
  '## Tests',
  'We need test coverage for `processPayment()`. Specifically:',
  '1. The happy path (successful Stripe charge — assert correct receipt is generated).',
  '2. The error/timeout path (Stripe returns 502 — assert retry-with-backoff fires once, then fails clean).',
  '',
  'Currently neither has a unit test. These are deliberately separate concerns:',
  'the success path is correctness, the failure path is graceful degradation.',
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
        seedCeoFindingProject(tmpDir, planCeo2PairedFindings(planPath));
        const obs = await runPlanSkillCounting({
          skillName: 'plan-ceo-review',
          slashCommand: '/plan-ceo-review',
          followUpPrompt: '', // same fixture-first scope contract as the distinct case
          isLastStep0AUQ: ceoStep0Boundary,
          reviewCountCeiling: CEILING_PAIRED + 1,
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt),
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `paired-finding control FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount}\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        if (obs.reviewCount < FLOOR_PAIRED) {
          throw new Error(
            `PAIRED CONTROL FAIL: reviewCount=${obs.reviewCount} < FLOOR=${FLOOR_PAIRED}.\n` +
              `Expected separate finding questions; check scope and Step-0 classification before diagnosing batching.\n` +
              `outcome=${obs.outcome} step0=${obs.step0Count} elapsed=${obs.elapsedMs}ms\n` +
              `Review-phase fingerprints:\n` +
              obs.fingerprints
                .filter((f) => !f.preReview)
                .map((f) => `  - "${f.promptSnippet.slice(0, 80)}"`)
                .join('\n'),
          );
        }
        if (obs.reviewCount > CEILING_PAIRED) {
          throw new Error(
            `PAIRED CONTROL FAIL: reviewCount=${obs.reviewCount} > CEILING=${CEILING_PAIRED} (over-asking on a 2-finding fixture).`,
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
