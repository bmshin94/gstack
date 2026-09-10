/**
 * /plan-ceo-review mode-routing E2E (periodic, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review reaches its Step 0F mode-selection
 * AskUserQuestion and the user picks HOLD SCOPE or SCOPE EXPANSION,
 * the downstream rendered output reflects that mode's distinctive
 * posture language.
 *
 * Why this exists: existing tests verify that the question fires. Nothing
 * verifies the answer actually routes. A regression where Step 0F shows
 * the question but the agent ignores the choice (e.g. always defaults
 * to EXPANSION) would not be caught by any prior test.
 *
 * Tier: periodic (not gate). The supplied plan and design satisfy prerequisite
 * discovery; each run still navigates the review's premise and approach
 * decisions before Step 0F, then verifies the selected mode's downstream posture.
 *
 * Mode coverage: HOLD SCOPE + SCOPE EXPANSION cover the two posture poles
 * (rigor vs ambition). SELECTIVE EXPANSION and SCOPE REDUCTION are V2 once
 * the navigation phase is shorter or has a deterministic fast-path through
 * Step 0A/0C-bis.
 *
 * Posture assertions: each mode has distinct downstream language. The
 * checks below are deliberately permissive — they catch the binary
 * "did the mode posture even apply" question, not Opus-specific phrasing.
 *
 *   HOLD SCOPE        — "rigor" or "bulletproof" or "hold scope"
 *   SCOPE EXPANSION   — "expansion" or "10x" or "delight" or "dream"
 */

import { test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject, pickSuppliedCeoModeStart } from './helpers/ceo-finding-fixture';
import { navigateToModeAskUserQuestion, waitForNativeModePosture } from './helpers/plan-skill-mode-navigation';
import { PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  launchClaudePty,
  type ClaudePtySession,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

interface ModeCase {
  mode: 'HOLD SCOPE' | 'SCOPE EXPANSION';
  /** Regex applied to visible-since-mode-pick text. At least one must match. */
  postureRe: RegExp;
}

const CASES: ModeCase[] = [
  { mode: 'HOLD SCOPE',      postureRe: /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i },
  { mode: 'SCOPE EXPANSION', postureRe: /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i },
];

describeE2E('/plan-ceo-review mode routing (gate)', () => {
  for (const c of CASES) {
    test(
      `mode "${c.mode}" routes to its distinctive posture`,
      async () => {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-routing-'));
        let session: ClaudePtySession | undefined;
        try {
          // Both choices start from the same user request. An ambient branch can
          // otherwise look like a bug fix and legitimately bypass the mode menu.
          // Supply the same mode-neutral design as the saved-preference fixture
          // to avoid the missing-design Office Hours detour.
          seedCeoFindingProject(project, `# Export saved settings

Add a CSV export button to the settings page. Reuse the existing settings API;
validate escaping for commas, quotes, and newlines. The change touches the settings
page, a CSV formatter, and formatter tests. Review this plan before implementation.

Please present the full review-mode choice and wait for my selection before
selecting a mode. I have not chosen a review mode for this plan.
`, [
            '# Design: export saved settings', '',
            '## Problem',
            'Operators need a spreadsheet of their saved settings for offline comparison',
            'and support investigations. The existing settings page is the entry point.', '',
            '## Chosen approach',
            'Add one CSV download button. Read the existing authenticated settings API,',
            'format its saved values with a focused CSV formatter, and test escaping',
            'for commas, quotes, and newlines before wiring the button.', '',
            '## Alternatives and boundaries',
            'A new backend export endpoint duplicates the existing read API. A generic',
            'multi-format framework adds work before there is a second consumer.',
            'Importing settings, changing authorization, and adding export formats are',
            'outside this proposal. Review gaps and risks before implementation.', '',
          ].join('\n'));
          const sessionId = randomUUID();
          session = await launchClaudePty({
            cwd: project,
            permissionMode: 'plan',
            captureQuestionsForSession: sessionId,
            // Navigation (420s) + posture (240s) must both fit; phase budgets stay fixed.
            timeoutMs: PTY_MS,
            seedSkills: true,
            captureScreen: true,
            // Keep the current outside-directory permission path on one physical line.
            cols: 240,
          });
          await Bun.sleep(8000);
          const since = session.mark();
          session.send('/plan-ceo-review\r');

          const selection = await navigateToModeAskUserQuestion(session, since, c.mode, { sessionId, firstAUQPick: pickSuppliedCeoModeStart });
          await waitForNativeModePosture(session, selection, c.mode, { sessionId, postureRe: c.postureRe, budgetMs: 240_000 });
        } finally {
          try { await session?.close(); }
          finally { fs.rmSync(project, { recursive: true, force: true }); }
        }
      },
      PTY_MS,
    );
  }
});
