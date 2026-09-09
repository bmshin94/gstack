/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { DESIGN_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { seedPlanReviewProject } from './helpers/ceo-finding-fixture';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  designStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1;
const CEILING = N + 2;

const planDesign5Findings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  '',
  '# Plan: Settings Page UI redesign',
  '',
  '## Visual Hierarchy',
  'The "Save" button is rendered with the same size, weight, and color as',
  'three other buttons in the page header (Reset, Cancel, Export). Nothing',
  'tells the user which is the primary action.',
  '',
  '## Spacing',
  'Between sections we have 24px in some places, 32px in others, and 16px',
  'in a third — no consistent vertical rhythm.',
  '',
  '## Color',
  'The error message uses red text on a light pink background. Contrast',
  'ratio is approximately 3:1 (below WCAG AA).',
  '',
  '## Typography',
  'We use 14px, 16px, and 18px font sizes across the form labels. Two',
  'sizes would suffice and create stronger hierarchy.',
  '',
  '## Motion',
  'The "Save" action takes 2-5 seconds with no loading indicator. Users',
  'see a frozen page; we should add a spinner or skeleton state.',
].join('\n');

describeE2E('/plan-design-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} substantive finding calls`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-design-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-design.md');

      try {
        const planText = planDesign5Findings(planPath);
        seedPlanReviewProject(tmpDir, planText, 'plan-design-review');
        const obs = await runPlanSkillCounting({
          skillName: 'plan-design-review',
          slashCommand: '/plan-design-review',
          followUpPrompt: '', // plan already committed before the first model turn
          isLastStep0AUQ: designStep0Boundary,
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
            `plan-design-review finding-count FAILED: outcome=${obs.outcome}\n` +
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
          plan: planText, targets: DESIGN_FINDINGS, fingerprints: obs.fingerprints,
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
