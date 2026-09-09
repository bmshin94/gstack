/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { DEVEX_FINDINGS, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import { seedPlanReviewProject } from './helpers/ceo-finding-fixture';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  devexStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1;
const CEILING = N + 2;

const planDevex5Findings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  '',
  '# Plan: Public SDK Beta Launch',
  '',
  '## Persona',
  "The plan doesn't specify which developer persona is the target — we're",
  "shipping for \"everyone,\" which means we tune for nobody.",
  '',
  '## TTHW (time to hello world)',
  'Time-to-hello-world is not measured. No benchmark data referenced. We',
  "don't know if first-run takes 5 minutes or 50.",
  '',
  '## Friction Point',
  'First-run currently requires a 5-minute mandatory CI step before the',
  'developer can run their first eval. There is no way to skip it.',
  '',
  '## Magical Moment',
  'Getting-started flow has no delight beat. Pure documentation, no',
  'interactive demo, no "ah-ha" moment that makes the developer trust us.',
  '',
  '## Competitive Blind Spot',
  "The plan doesn't reference how peer SDKs (LangChain, Semantic Kernel,",
  'OpenAI) handle this DX surface. We may be reinventing worse versions',
  'of solved problems.',
].join('\n');

describeE2E('/plan-devex-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} substantive finding calls`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-devex-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-devex.md');

      try {
        const planText = planDevex5Findings(planPath);
        seedPlanReviewProject(tmpDir, planText, 'plan-devex-review');
        const obs = await runPlanSkillCounting({
          skillName: 'plan-devex-review',
          slashCommand: '/plan-devex-review',
          followUpPrompt: '', // plan already committed before the first model turn
          isLastStep0AUQ: devexStep0Boundary,
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
            `plan-devex-review finding-count FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `last sampled counting state: ${JSON.stringify(obs.diagnostics)}\n` +
              `All-phase fingerprints (last 8; bounded native IDs and prompt snippets):\n` +
              obs.fingerprints
                .slice(-8)
                .map((f) => `  - ${JSON.stringify({ preReview: f.preReview, nativeToolId: f.toolUseId?.slice(0, 256) ?? null, promptSnippet: f.promptSnippet.slice(0, 80) })}`)
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
          plan: planText, targets: DEVEX_FINDINGS, fingerprints: obs.fingerprints,
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
