/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { ENG_BATCHING_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { seedPlanReviewProject } from './helpers/ceo-finding-fixture';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  engStep0Boundary,
} from './helpers/claude-pty-runner';
import { FORCING_BATCHING_ENG } from './fixtures/forcing-finding-seeds';

const describeE2E = describeE2ETier('periodic');

const N = 4;
const FLOOR = N - 1; // 3 — agent must fire at least one AUQ per non-batched finding

/** Plan-file target baked into the FORCING_BATCHING_ENG fixture prompt.
 *  Rewritten per-run to a mkdtemp path so concurrent runs (--retry,
 *  EVALS_JOBS>1, sibling worktrees) never share one /tmp artifact. */
const FIXTURE_PLAN_PATH = '/tmp/gstack-test-plan-eng-batching.md';

describeE2E('/plan-eng-review multi-finding batching regression (periodic)', () => {
  test(
    `4-finding plan emits >= ${FLOOR} substantive finding calls (no batching)`,
    async () => {
      const caseStartedAt = Date.now();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-eng-batching-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-eng-batching.md');
      const followUpPrompt = FORCING_BATCHING_ENG.replaceAll(FIXTURE_PLAN_PATH, planPath);
      if (!followUpPrompt.includes(planPath)) {
        throw new Error(
          `fixture drift: FORCING_BATCHING_ENG no longer contains ${FIXTURE_PLAN_PATH} — update FIXTURE_PLAN_PATH`,
        );
      }

      try {
        const planText = followUpPrompt;
        seedPlanReviewProject(tmpDir, planText, 'plan-eng-review');
        const obs = await runPlanSkillCounting({
          skillName: 'plan-eng-review',
          slashCommand: '/plan-eng-review',
          followUpPrompt: '', // plan already committed before the first model turn
          isLastStep0AUQ: engStep0Boundary,
          reviewCountCeiling: null, // classify findings after actual workflow completion
          questionPick: pickPlanReviewQuestion,
          // The review target is present before scope selection.
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt), // 25 min
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        console.log('Plan review native evidence:', JSON.stringify({
          plan: planText, outcome: obs.outcome, fingerprints: obs.fingerprints, diagnostics: obs.diagnostics,
        }));

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
          throw new Error(
            `multi-finding batching test FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        const decisions = await evaluatePlanReviewDecisions({
          plan: planText, targets: ENG_BATCHING_FINDINGS, fingerprints: obs.fingerprints,
          kind: 'findings', floor: FLOOR,
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
