/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { ENG_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { seedEngFindingProject } from './helpers/eng-finding-fixture';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  engStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1; // 4
const CEILING = N + 2; // 7

const planEng5Findings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  '',
  '# Plan: Multi-tenant Auth Refactor',
  '',
  '## Architecture',
  'Two new services (`AuthBroker` and `SessionMint`) share a global mutable',
  '`AuthCache` instance via module-level export. Both services mutate it.',
  '',
  '## Code quality',
  'The `validateAndDispatch()` function is 60 lines with three nested',
  'try/catch blocks; each catch swallows a different error class.',
  '',
  '## Tests',
  'The existing `legacyAuthFlow()` will get rewritten as part of this work;',
  'no regression test for the prior behavior is planned.',
  '',
  '## Performance',
  'Token validation issues 5 sequential API calls to the IDP; they could be',
  'parallelized via Promise.all trivially (calls are independent).',
  '',
  '## Architecture (scope smell)',
  'This touches 12 files and introduces 4 new classes (AuthBroker,',
  'SessionMint, TokenStore, RequestPolicy). Worth flagging the complexity check.',
].join('\n');

describeE2E('/plan-eng-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} substantive finding calls`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-eng-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-eng.md');

      try {
        const planText = seedEngFindingProject(tmpDir, planEng5Findings(planPath));
        const obs = await runPlanSkillCounting({
          skillName: 'plan-eng-review',
          slashCommand: '/plan-eng-review',
          followUpPrompt: '', // plan already committed before the first model turn
          isLastStep0AUQ: engStep0Boundary,
          reviewCountCeiling: null, // classify findings after actual workflow completion
          questionPick: pickPlanReviewQuestion,
          // The review target is present before scope selection.
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt),
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        console.log('Plan review native evidence:', JSON.stringify({
          plan: planText, outcome: obs.outcome, fingerprints: obs.fingerprints, diagnostics: obs.diagnostics,
        }));

        if (!['plan_ready', 'completion_summary'].includes(obs.outcome)) {
          throw new Error(
            `plan-eng-review finding-count FAILED: outcome=${obs.outcome}\n` +
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
        if (!fs.existsSync(planPath)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${planPath}. ` +
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
          plan: planText, targets: ENG_FINDINGS, fingerprints: obs.fingerprints,
          kind: 'findings', floor: FLOOR, ceiling: CEILING,
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
