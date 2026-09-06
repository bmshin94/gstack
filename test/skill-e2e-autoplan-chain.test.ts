/**
 * /autoplan cross-skill chain (periodic, paid, real-PTY).
 *
 * Asserts: when /autoplan runs against a plan fixture, the phase markers
 * the autoplan template emits appear in the correct order:
 *
 *   "**Phase 1 complete." (CEO)        →
 *   "**Phase 2 complete." (Design — only if UI scope detected) →
 *   "**Phase 2.5 complete." (DX — optional, skipped if no DX scope) →
 *   "**Phase 3 complete." (Eng — always runs, always LAST: the required
 *     gate reviews the final amended plan)
 *
 * Why this exists: per-phase smoke tests do not check the chain's
 * completion-marker order. This observes that order through Eng completion;
 * it does not establish whether any reviewer executions overlapped.
 *
 * Approach: preserve the order in which completion markers first appear in
 * the visible stream. Several markers may arrive in one poll, so timestamps
 * are diagnostic only. Design and DX are optional; Eng must complete last.
 *
 * Cost: ~$5-8/run, 10-15 min wall clock. Periodic — runs weekly.
 */

import { test } from 'bun:test';
import { observedAutoplanPhases, validateAutoplanPhaseOrder } from './helpers/autoplan-phase-order';
import { seedAutoplanProject } from './helpers/autoplan-fixture';
import { PTY_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  launchClaudePty,
  isPlanReadyVisible,
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

interface PhaseHit {
  phase: number;
  ts: number;
}

describeE2E('/autoplan chain ordering (periodic)', () => {
  test(
    'completion markers follow CEO, optional Design, optional DX, then Eng',
    async () => {
      // UI-heavy fixture so Phase 2 runs.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-chain-'));
      try {
        const gitRun = (args: string[]) =>
          spawnSync('git', args, { cwd: tempDir, stdio: 'pipe', timeout: 5000 });
        gitRun(['init', '-b', 'main']);
        gitRun(['config', 'user.email', 'test@test.com']);
        gitRun(['config', 'user.name', 'Test']);

        seedAutoplanProject(tempDir);
        gitRun(['add', '.']);
        gitRun(['commit', '-m', 'init UI-heavy fixture']);

        const session = await launchClaudePty({
          permissionMode: 'plan',
          cwd: tempDir,
          timeoutMs: 1_080_000, // 18 min, slightly above test budget
          seedSkills: true,
        });

        const hits: PhaseHit[] = [];
        let outcome: 'chain_complete' | 'plan_ready' | 'timeout' | 'exited' = 'timeout';
        let evidence = '';
        let exitCode: number | null = null;

        try {
          await Bun.sleep(8000);
          const startupEvidence = session.visibleText();
          const since = session.mark();
          session.send('/autoplan\r');

          const budgetMs = 900_000; // 15 min
          const start = Date.now();
          // Phase markers live in autoplan's carved phase sections
          // (autoplan/sections/{ceo,design,eng,dx}-phase.md — the skeleton
          // STOP-Reads each one at its phase boundary):
          //   "**Phase 1 complete." / "**Phase 2 complete." / "**Phase 2.5 complete." / "**Phase 3 complete."

          let lastPermSig = '';
          while (Date.now() - start < budgetMs) {
            await Bun.sleep(5000);
            if (session.exited()) {
              outcome = 'exited';
              exitCode = session.exitCode();
              evidence = `--- startup ---\n${startupEvidence}\n--- after command ---\n${session.visibleSince(since).slice(-3000)}`;
              break;
            }
            const visible = session.visibleSince(since);

            // Auto-grant any permission dialog so autoplan can keep moving
            // through its phases. The autoplan template auto-decides AskUserQuestions
            // it owns; only permission prompts (file/tool grants) need our
            // hand-pressing. Classify on tail to avoid stale matches.
            const recentTail = visible.slice(-1500);
            if (isNumberedOptionListVisible(recentTail) && isPermissionDialogVisible(recentTail)) {
              const sig = visible.slice(-500);
              if (sig !== lastPermSig) {
                lastPermSig = sig;
                session.send('1\r');
                await Bun.sleep(2000);
                continue;
              }
            }

            // Re-scan for any phase markers we haven't yet recorded.
            for (const phaseNum of observedAutoplanPhases(visible)) {
              if (hits.some(h => h.phase === phaseNum)) continue;
              hits.push({ phase: phaseNum, ts: Date.now() });
            }

            // Terminal: Phase 3 (Eng) seen — chain reached the required end.
            if (hits.some(h => h.phase === 3)) {
              outcome = 'chain_complete';
              evidence = visible.slice(-3000);
              break;
            }

            // Plan-ready as a fallback terminal — autoplan finished without
            // surfacing a Phase 3 marker. This is a regression surface.
            if (isPlanReadyVisible(visible)) {
              outcome = 'plan_ready';
              evidence = visible.slice(-3000);
              break;
            }
          }
          if (outcome === 'timeout') evidence = session.visibleSince(since).slice(-3000);
        } finally {
          await session.close();
        }

        if (outcome === 'exited' || outcome === 'timeout') {
          throw new Error(
            `autoplan chain test FAILED: outcome=${outcome}, exitCode=${exitCode}, hits=${JSON.stringify(hits)}\n` +
              `--- evidence ---\n${evidence}`,
          );
        }

        try {
          validateAutoplanPhaseOrder(hits.map(hit => hit.phase));
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
              `--- observed markers ---\n${JSON.stringify(hits)}\n` +
              `--- evidence ---\n${evidence}`,
            { cause: error },
          );
        }

      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
    PTY_LONG_MS, // 20 min absolute test ceiling
  );
});
