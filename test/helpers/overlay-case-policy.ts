/** A complete fixture owns a process; model-work budgets are unchanged. */
export const OVERLAY_CASE_WORK_MS = 1_800_000;
export const OVERLAY_RECORD_GRACE_MS = 5_000;
export const OVERLAY_CASE_OUTER_MS = OVERLAY_CASE_WORK_MS + 10_000;
export const OVERLAY_MIN_FILE_WALL_MS = OVERLAY_CASE_WORK_MS + 30_000;

/** Canonical wrapper census. Runner integration must serialize these files. */
export const OVERLAY_CASE_FILES: Record<string, string> = {
  'test/skill-e2e-overlay-harness-opus-4-7-fanout-toy.test.ts': 'opus-4-7-fanout-toy',
  'test/skill-e2e-overlay-harness-opus-4-7-fanout-realistic.test.ts': 'opus-4-7-fanout-realistic',
  'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash.test.ts': 'claude-dedicated-tools-vs-bash',
  'test/skill-e2e-overlay-harness-opus-4-7-effort-match-trivial.test.ts': 'opus-4-7-effort-match-trivial',
  'test/skill-e2e-overlay-harness-opus-4-7-literal-interpretation.test.ts': 'opus-4-7-literal-interpretation',
  'test/skill-e2e-overlay-harness-opus-4-7-fanout-toy-sonnet.test.ts': 'opus-4-7-fanout-toy-sonnet',
  'test/skill-e2e-overlay-harness-opus-4-7-fanout-realistic-sonnet.test.ts': 'opus-4-7-fanout-realistic-sonnet',
  'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash-sonnet.test.ts': 'claude-dedicated-tools-vs-bash-sonnet',
  'test/skill-e2e-overlay-harness-opus-4-7-effort-match-trivial-sonnet.test.ts': 'opus-4-7-effort-match-trivial-sonnet',
  'test/skill-e2e-overlay-harness-opus-4-7-literal-interpretation-sonnet.test.ts': 'opus-4-7-literal-interpretation-sonnet',
};
