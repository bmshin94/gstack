/**
 * /plan-design-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Same shape as skill-e2e-plan-ceo-finding-count: drives /plan-design-review
 * against a 5-finding seeded plan and asserts review-phase AUQ count ∈ [N-1, N+2].
 * Plus D19: review report at bottom of produced plan file.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default per plan §D15.
 */

import { test } from 'bun:test';
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
    `5-finding plan emits ${FLOOR}-${CEILING} review-phase AskUserQuestions`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-design-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-design.md');

      try {
        seedPlanReviewProject(tmpDir, planDesign5Findings(planPath), 'plan-design-review');
        const obs = await runPlanSkillCounting({
          skillName: 'plan-design-review',
          slashCommand: '/plan-design-review',
          followUpPrompt: '', // plan already committed before the first model turn
          isLastStep0AUQ: designStep0Boundary,
          reviewCountCeiling: CEILING + 1,
          // The review target is present before scope selection.
          cwd: tmpDir,
          timeoutMs: 1_500_000 - (Date.now() - caseStartedAt),
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
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
        if (obs.reviewCount < FLOOR) {
          throw new Error(
            `BAND FAIL (below floor): reviewCount=${obs.reviewCount} < FLOOR=${FLOOR}.\n` +
              `outcome=${obs.outcome} step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `Inspect Step-0 classification and question evidence before diagnosing grouping.\n` +
              `All-phase fingerprints (last 8; bounded native IDs and prompt snippets):\n` +
              obs.fingerprints
                .slice(-8)
                .map((f) => `  - ${JSON.stringify({ preReview: f.preReview, nativeToolId: f.toolUseId?.slice(0, 256) ?? null, promptSnippet: f.promptSnippet.slice(0, 80) })}`)
                .join('\n'),
          );
        }
        if (obs.reviewCount > CEILING) {
          throw new Error(
            `BAND FAIL (above ceiling): reviewCount=${obs.reviewCount} > CEILING=${CEILING}.\n` +
              `outcome=${obs.outcome} step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `All-phase fingerprints (last 8; bounded native IDs and prompt snippets):\n` +
              obs.fingerprints
                .slice(-8)
                .map((f) => `  - ${JSON.stringify({ preReview: f.preReview, nativeToolId: f.toolUseId?.slice(0, 256) ?? null, promptSnippet: f.promptSnippet.slice(0, 80) })}`)
                .join('\n'),
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
