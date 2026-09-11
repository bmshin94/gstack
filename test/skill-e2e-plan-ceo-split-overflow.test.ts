/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { CEO_SCOPE_CANDIDATES } from './helpers/plan-review-cases';
import { pickCeoSplitQuestion } from './helpers/ceo-split-question-policy';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  ceoStep0Boundary,
} from './helpers/claude-pty-runner';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';
import { seedCeoFindingProject, pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1; // 4 — must fire at least one AUQ per non-dropped option

/** Plan-file target baked into the FORCING_SPLIT_OVERFLOW_CEO fixture prompt.
 *  Rewritten per-run to a mkdtemp path so concurrent runs (--retry,
 *  EVALS_JOBS>1, sibling worktrees) never share one /tmp artifact. */
const FIXTURE_PLAN_PATH = '/tmp/gstack-test-plan-ceo-split-overflow.md';

describeE2E('/plan-ceo-review split-overflow regression (periodic)', () => {
  test(
    `5-option scope decision retains every option and emits >= ${FLOOR} substantive finding calls (no dropping)`,
    async () => {
      const caseStartedAt = Date.now();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-ceo-split-overflow-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-ceo-split-overflow.md');
      const followUpPrompt = FORCING_SPLIT_OVERFLOW_CEO.replaceAll(FIXTURE_PLAN_PATH, planPath);
      if (!followUpPrompt.includes(planPath)) {
        throw new Error(
          `fixture drift: FORCING_SPLIT_OVERFLOW_CEO no longer contains ${FIXTURE_PLAN_PATH} — update FIXTURE_PLAN_PATH`,
        );
      }

      try {
        const planText = followUpPrompt;
        seedCeoFindingProject(tmpDir, planText);
        const obs = await runPlanSkillCounting({
          skillName: 'plan-ceo-review',
          slashCommand: '/plan-ceo-review',
          followUpPrompt: '', // review-input.md is present before scope selection
          firstAUQPick: pickSuppliedCeoPlanStart,
          isLastStep0AUQ: ceoStep0Boundary,
          reviewCountCeiling: null, // classify findings after actual workflow completion
          questionPick: pickCeoSplitQuestion,
          cwd: tmpDir,
          readCeoPlanArtifacts: true,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt), // 25 min
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        console.log('Plan review native evidence:', JSON.stringify({
          plan: planText, outcome: obs.outcome, fingerprints: obs.fingerprints, diagnostics: obs.diagnostics,
        }));

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
          throw new Error(
            `split-overflow test FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        const decisions = await evaluatePlanReviewDecisions({
          plan: planText, targets: CEO_SCOPE_CANDIDATES, fingerprints: obs.fingerprints,
          kind: 'scope', floor: FLOOR,
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
