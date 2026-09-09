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
 * Tier: periodic (not gate). Each run navigates 8-12 prior AskUserQuestions (telemetry,
 * proactive, routing, vendoring, brain, office-hours, premise×3, approach)
 * before reaching Step 0F. At ~30s per AskUserQuestion that's a 4-6 min navigation
 * phase per case. The full 2-case suite runs ~12-15 min, $3-4. Too slow
 * for gate-tier; weekly is fine.
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
          seedCeoFindingProject(project, `# Export saved settings

Add a CSV export button to the settings page. Reuse the existing settings API;
validate escaping for commas, quotes, and newlines. The change touches the settings
page, a CSV formatter, and formatter tests. Review this plan before implementation.

Please present the full review-mode choice and wait for my selection before
selecting a mode. I have not chosen a review mode for this plan.
`);
          const sessionId = randomUUID();
          session = await launchClaudePty({
            cwd: project,
            permissionMode: 'plan',
            captureQuestionsForSession: sessionId,
            // Navigation (420s) + posture (240s) must both fit; phase budgets stay fixed.
            timeoutMs: PTY_MS,
            seedSkills: true,
            captureScreen: true,
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
