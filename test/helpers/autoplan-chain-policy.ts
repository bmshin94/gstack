/**
 * Full-chain orchestration exception to the ordinary paid-test timeout tiers.
 * This case must observe CEO → optional Design/DX → Eng in one owned session;
 * splitting it into phase tests would lose its completion-order coverage.
 *
 * The 45-minute cap increases aggregate parent-session allowance. It is a bounded
 * allowance for sequential phases, not a measured completion guarantee. Individual
 * reviewer/model/token limits and retries remain unchanged. The outer margins
 * cover PTY startup, native cleanup, Bun reporting and external process cleanup.
 */
export const AUTOPLAN_CHAIN_BUDGET = {
  workMs: 45 * 60_000,
  ptyMs: 48 * 60_000,
  testMs: 50 * 60_000,
  fileWallMs: 52 * 60_000,
} as const;
