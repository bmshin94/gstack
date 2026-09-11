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
  '## Existing page and accepted boundaries',
  'This is an incremental redesign of the existing settings form. Preserve its',
  'documented behavior and layout in DESIGN.md; these contracts are unchanged.',
  'The proposal below changes action emphasis, section rhythm, error treatment,',
  'form-label hierarchy, and the visual feedback during an in-flight Save.',
  'The chosen treatments remain open for review. Other changes need new evidence',
  'of a conflict with the existing page, rather than an omission from this proposal.',
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

// The count fixture is an existing page, not a blank-slate product. These
// contracts answer the unrelated questions observed in the native review;
// none chooses a remedy for the five defects in the proposed change.
// These are synthetic fixture contracts, not claims about production code.
const existingSettingsDesign = `# Existing settings page design

## Purpose and information architecture
Account administrators edit their own Profile, Notifications, and Security settings.
The page is a flat form in a 640px-wide content column, with those three named
sections in that order. A page heading and one sentence of purpose precede the
form. Each section has its own heading and a short description. There are no
cards, side navigation, new routes, or new section names in this change.

## Existing actions and interaction contract
Save persists the complete valid draft using the existing API. It is disabled
until values differ from the saved state and there are no validation errors.
The proposed visual emphasis of Save relative to the other actions is unresolved.
The shared Button already applies the app's disabled-opacity token to every visual
variant without changing its size or position. This disabled treatment is unchanged;
the redesign chooses action emphasis, not a new disabled-state design.
During an in-flight Save, duplicate submission is blocked; Reset and Export are
disabled, Cancel remains available, fields keep their values, focus stays on Save,
and cancellation does not discard the draft. These action states are unchanged.
The visual feedback during this delay is the unresolved part of the proposal.
Success shows the existing saved-status line and announces it through the polite
live region. Failure preserves every draft value and offers retry beside the
error message. Partial saves are not supported: the API updates the form atomically.
Cancel restores the saved values after a discard confirmation when the draft is
dirty. Navigating away uses the same existing discard guard. Reset opens a dialog
naming all three sections, then loads page-wide defaults into the draft; Save is
still required to persist them. Export downloads the last saved settings as CSV
through the existing flow and reports download failures inline. No new keyboard
shortcut, action behavior, or per-section reset is part of this redesign.

## Existing visual system
The app uses its locally bundled Source Sans 3 face. Body and input text are 16px,
page headings 24px, and section headings 20px. Form-label tiers are under review;
the current inconsistent 14px, 16px, and 18px usage remains a defect to resolve.
The app's primary accent is #0F6E6E on white. Neutral text is #1F2937 on white,
with a visible two-pixel focus outline and two-pixel offset on all Button variants,
including filled buttons. The existing outline and offset are unchanged. Section gaps currently vary as described
in the proposal; the redesign must choose a coherent rhythm. The error-message
foreground/background pair is also unresolved; other colors remain unchanged.
No new font, brand palette, dark mode, component library, or motion system is needed.
Color, spacing, type, and motion values already use named CSS custom properties
on the shared Button, FormStack, and Field components. The current inconsistent
values are legacy role assignments, not missing token infrastructure. Reuse the
existing mechanism; choosing the five proposed visual treatments remains open.
Settings role values are scoped to the Settings page. Shared component defaults
and other pages retain their existing values; app-wide adoption is outside this change.
Within each section, the unchanged FormStack uses 16px between fields and the
Field component uses 8px between a label and its input. Only the gaps between
sections are inconsistent and under review; intra-section spacing is preserved.

## Responsive and accessible behavior already in place
At 375px the form fits the viewport with 16px side padding; the header actions
wrap in their existing order, with intrinsic widths, without hiding actions or
causing horizontal scroll. The visual redesign preserves that geometry.
At 768px and above the content column remains at most 640px, centered with at least
24px side gutters. Controls and touch targets are at least 44px high.
There is one main landmark, a page heading, named form sections, and explicit
labels linked to each input. Tab order follows the visual order. Buttons use
native keyboard behavior, dialogs trap focus and return it to their trigger,
validation links each message to its field, and the existing save-status live
region announces progress and completion.
The error-message color contrast in the proposal is the known accessibility gap.

## Existing user journey
Land and orient using the heading and named sections; scan saved values; edit
with inline validation; save; see the persisted status and leave confidently.
First-time and returning administrators use the same flow. Empty optional fields
show their labels and helper text; an empty settings response shows the existing
retry state. The proposal preserves this journey and improves the visual
problems it identifies. No new storyboard or onboarding flow is required.
`;

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
        seedPlanReviewProject(tmpDir, planText, 'plan-design-review', existingSettingsDesign);
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
