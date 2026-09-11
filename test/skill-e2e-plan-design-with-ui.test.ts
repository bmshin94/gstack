/**
 * /plan-design-review with UI scope (gate, paid, real-PTY).
 *
 * The exact UI-heavy plan is committed before the first model turn. Observe
 * an acknowledged Design focus/rating question and a subsequent review
 * question using the existing native counting driver. An initial target menu
 * or a no-UI early exit cannot satisfy this positive path. Option descriptions
 * are proposals, so mentioning "no UI scope" there is not an exit verdict.
 */

import { test } from 'bun:test';
import { PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { seedPlanReviewProject } from './helpers/ceo-finding-fixture';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  type AskUserQuestionFingerprint,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('gate');
const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plans', 'ui-heavy-feature.md');

const designFocusBoundary = (fp: AskUserQuestionFingerprint): boolean =>
  (fp.questions ?? []).some(({ question }) => {
    const text = question.trim().replace(/^D\d+(?:\.\d+)?\s*[—–:-]\s*/i, '');
    // Require the source Step 0D question or its retained native paraphrase.
    // A target menu can mention a design system without reviewing this plan.
    return /^I(?:['’]ve| have) rated this plan (?:10(?:\.0+)?|[0-9](?:\.\d+)?)\/10 on design completeness\.[\s\S]*\bWant me to focus on specific areas instead of all 7\?/i.test(text)
      || /^Review all 7 design dimensions, or focus on specific areas\?$/i.test(text.split(/\r?\n/, 1)[0]!);
  });

describeE2E('/plan-design-review with UI scope (gate)', () => {
  test(
    'reviews the supplied UI plan through an acknowledged Design finding',
    async () => {
      const startedAt = Date.now();
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'design-ui-project-'));
      try {
        seedPlanReviewProject(project, fs.readFileSync(FIXTURE, 'utf8'), 'plan-design-review');
        const obs = await runPlanSkillCounting({
          skillName: 'plan-design-review', slashCommand: '/plan-design-review',
          followUpPrompt: '', cwd: project,
          isLastStep0AUQ: designFocusBoundary,
          reviewCountCeiling: 1,
          questionPick: pickPlanReviewQuestion,
          timeoutMs: 600_000 - (Date.now() - startedAt),
        });
        const focus = obs.fingerprints.findIndex(designFocusBoundary);
        const postFocus = focus >= 0 && obs.fingerprints.slice(focus + 1).some(fp => !fp.preReview);
        if (obs.outcome !== 'ceiling_reached' || !postFocus) {
          throw new Error(
            `plan-design-review with UI scope FAILED: outcome=${obs.outcome}; no acknowledged Design focus and subsequent review question\n` +
            `--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
      } finally {
        try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* Preserve the observation failure. */ }
      }
    },
    PTY_MS,
  );
});
