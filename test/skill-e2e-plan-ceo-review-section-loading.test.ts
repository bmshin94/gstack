/**
 * /plan-ceo-review section-loading E2E (periodic, paid, SDK capture) — v2 plan
 * Phase B carve backstop. The per-PR guard is the free static test
 * skill-ceo-section-ordering.test.ts; THIS is the behavioral proof that a real
 * agent actually Reads the carved section instead of working from memory.
 *
 * Detection is LOSSLESS. Earlier this test drove a real PTY and scraped the ANSI
 * screen buffer for the `sections/<file>.md` path. That silently saw nothing in a
 * Conductor PTY — cursor-positioned tool renders and an unanswered Step 0 question
 * loop both defeat the regex, so it reported `read: []` even when the agent did the
 * work. It now runs the skill through `claude -p` (the SDK path the AUQ matrix
 * uses) and detects section reads from the tool-use stream (`Read` calls whose
 * file_path contains `sections/review-sections.md`). No rendering layer to mangle.
 *
 * Hermetic, not install-mutating: the freshly-generated worktree skeleton +
 * sections are copied into a throwaway fixture dir and the absolute path is pinned,
 * so the test validates THIS branch's carve without touching the user's active
 * ~/.claude install. (Install-layout linking is covered separately by
 * setup-sections-linking.test.ts.)
 *
 * The agent is told AskUserQuestion is unavailable, so it auto-picks the
 * recommended option through Step 0 and reaches the post-Step-0 STOP-Read. HOLD
 * SCOPE is the simplest mode that still requires the full review section. Cost:
 * ~$1-2/run. Periodic tier.
 */

import { test, expect } from 'bun:test';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  setupSkillDir,
  skillFromWorktree,
  captureSectionReads,
  validateCeoReviewCompletion,
} from './helpers/auq-sdk-capture';

const describeE2E = describeE2ETier('periodic');
const runId = `plan-ceo-section-loading-${process.env.EVALS_RUN_ID ?? 'local'}`;

// Sections every plan-ceo-review run must consult after Step 0.
const REQUIRED_SECTIONS = ['review-sections.md'];

const PLAN_MD = [
  '# Plan: add an in-memory cache layer',
  '',
  '## Context',
  'Reads hit the DB on every request. Add a process-local LRU cache in front of',
  'the read path to cut DB load.',
  '',
  '## Approach',
  '- Wrap the read repository in a cache that stores the last 1000 keys.',
  '- Invalidate on write.',
  '',
  '## Out of scope',
  'Distributed cache, cross-process coherence.',
  '',
].join('\n');

describeE2E('/plan-ceo-review section-loading E2E (periodic, SDK capture)', () => {
  test(
    'a real review Reads the carved section before producing the report',
    async () => {
      const { skillMd, sectionsFrom } = skillFromWorktree('plan-ceo-review');
      const planDir = setupSkillDir({
        skillName: 'plan-ceo-review',
        skillMd,
        sectionsFrom,
        fixtures: { 'PLAN.md': PLAN_MD },
        tmpPrefix: 'gstack-ceo-secload-',
      });

      const capture = await captureSectionReads({
        planDir,
        skillName: 'plan-ceo-review',
        scenario:
          'Review the plan in PLAN.md. Hold the current scope (HOLD SCOPE mode) — do not challenge or expand scope. Run the full CEO review and produce the review report. For the independent outside-voice plan review, use the available Agent tool. Read-only delegation is permitted and is part of this review, not environment setup. Use Read for the skill, sections and plan, never Bash. After all review sections and outside-voice integration, write REPORT.md once with concise prose and every required finding, decision, diagram and output; finish without repeating the report in chat.',
        reportMarker: /GSTACK REVIEW REPORT|COMPLETION SUMMARY|review/i,
        testName: 'plan-ceo-section-loading',
        runId,
        // Eleven sections plus outside voice are a long workflow. Use its
        // selected tier, leaving the historical 60s margin for setup/cleanup.
        timeout: CAPTURE_LONG_MS - 60_000,
      });

      validateCeoReviewCompletion(capture);
      // A report cannot replace the available independent review with a
      // made-up "automated test rules" skip. Verify an invocation for this plan.
      expect(capture.toolCalls.some(call => {
        if (call.tool !== 'Agent') return false;
        const request = JSON.stringify(call.input);
        return /outside.?voice|independent|fresh.context|second opinion/i.test(request)
          && /PLAN\.md|cache|LRU/i.test(request);
      })).toBe(true);
      const { readSections, reportProduced, output } = capture;
      const missing = REQUIRED_SECTIONS.filter(s => !readSections.has(s));
      expect({ reportProduced, read: [...readSections], missing }).toEqual({
        reportProduced: true,
        read: expect.any(Array),
        missing: [],
      });
      // Guard against an empty pass: the report must have real content.
      expect(output.trim().length).toBeGreaterThan(200);
    },
    CAPTURE_LONG_MS,
  );
});
