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
 * Approach: the owned main transcript establishes assistant announcement order;
 * the rendered stream must corroborate that order. Tool previews cannot announce
 * completion. Design and DX are optional; Eng must complete last.
 * This oracle requires owned hermetic transcripts; EVALS_HERMETIC=0 is unsupported
 * for this case. The shared runner's opt-out behavior is unchanged.
 *
 * Cost: ~$5-8/run, 10-15 min wall clock. Periodic — runs weekly.
 */

import { test } from 'bun:test';
import { AutoplanFilePermissionViewport, corroboratedAutoplanPhases, observedAutoplanPhases, readAutoplanTranscript, reserveAutoplanFilePermission, retainAutoplanFailure, validateAutoplanPhaseOrder, type AutoplanTranscriptObservation } from './helpers/autoplan-phase-order';
import { seedAutoplanProject } from './helpers/autoplan-fixture';
import { PTY_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readPlanSkillQuestions, type NativePermissionGrant } from './helpers/plan-skill-questions';
import {
  launchClaudePty,
  isPlanReadyVisible,
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

describeE2E('/autoplan chain ordering (periodic)', () => {
  test(
    'completion markers follow CEO, optional Design, optional DX, then Eng',
    async () => {
      // A proposed focus-appearance change keeps Design applicable to the full chain.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-chain-'));
      try {
        const gitRun = (args: string[]) =>
          spawnSync('git', args, { cwd: tempDir, stdio: 'pipe', timeout: 5000 });
        gitRun(['init', '-b', 'main']);
        gitRun(['config', 'user.email', 'test@test.com']);
        gitRun(['config', 'user.name', 'Test']);

        const stateDir = seedAutoplanProject(tempDir, 'focus-appearance');
        gitRun(['add', '.']);
        gitRun(['commit', '-m', 'init focus-appearance fixture']);

        const sessionId = randomUUID();
        const session = await launchClaudePty({
          permissionMode: 'plan',
          cwd: tempDir,
          timeoutMs: 1_080_000, // 18 min, slightly above test budget
          seedSkills: true,
          env: { GSTACK_HOME: stateDir },
          captureQuestionsForSession: sessionId,
          captureScreen: true,
          rows: 120, // Preserve the full file title/subtitle above the restore preview.
        });

        let transcript: AutoplanTranscriptObservation = { file: null, phases: [], completedLines: 0, pendingBytes: 0 };
        let renderedPhases: number[] = [];
        let corroboratedPhases: number[] = [];
        let outcome: 'chain_complete' | 'plan_ready' | 'timeout' | 'exited' = 'timeout';
        let evidence = '';
        let exitCode: number | null = null;
        const counting: NonNullable<Parameters<typeof retainAutoplanFailure>[0]['counting']> = {
          native: null, dialog: '', events: session.nativeQuestionEvents, frame: null,
        };
        let lastPermissionCheck: { mark: number; nativeStable: boolean; lastInputMark: number } | null = null;
        const observations = () => JSON.stringify({ sessionId, transcript, renderedPhases, corroboratedPhases, lastPermissionCheck });

        try {
          await Bun.sleep(8000);
          const startupEvidence = session.visibleText();
          const since = session.mark();
          session.send('/autoplan\r');

          const budgetMs = 900_000; // 15 min
          const start = Date.now();
          const deadlineAt = start + budgetMs;
          // Phase markers live in autoplan's carved phase sections
          // (autoplan/sections/{ceo,design,eng,dx}-phase.md — the skeleton
          // STOP-Reads each one at its phase boundary):
          //   "**Phase 1 complete." / "**Phase 2 complete." / "**Phase 2.5 complete." / "**Phase 3 complete."

          const granted = new Set<string>();
          const requests = new Map<string, NativePermissionGrant>();
          let lastPermissionInputMark = -1;
          const permissionViewport = new AutoplanFilePermissionViewport({ session, deadlineAt, granted });
          while (Date.now() < deadlineAt) {
            // Match the runner's 250ms observation cadence. Native ownership,
            // fresh frames, and ACKs below authorize grants; elapsed sleep does not.
            await Bun.sleep(Math.min(250, Math.max(0, deadlineAt - Date.now())));
            if (Date.now() >= deadlineAt) break;
            if (session.exited()) {
              outcome = 'exited';
              exitCode = session.exitCode();
              evidence = `--- startup ---\n${startupEvidence}\n--- after command ---\n${session.visibleSince(since).slice(-3000)}`;
              break;
            }
            const visible = session.visibleSince(since);
            evidence = visible.slice(-3000);

            // Autoplan owns its decisions. Only grant a current, owned file
            // permission within this fixture or its private native plan folder.
            lastPermissionCheck = null;
            const native = readPlanSkillQuestions(session.hermeticConfigDir, sessionId, session.nativeQuestionEvents);
            counting.native = native;
            const frame = await session.currentScreen!();
            counting.dialog = frame.text;
            counting.frame = { text: frame.text, rawEnd: frame.rawEnd, observedAtMs: Date.now() - start,
              questionSince: since, viewportInputSince: lastPermissionInputMark };
            const afterFrame = readPlanSkillQuestions(session.hermeticConfigDir, sessionId, session.nativeQuestionEvents);
            lastPermissionCheck = { mark: session.mark(), nativeStable: isDeepStrictEqual(native, afterFrame), lastInputMark: lastPermissionInputMark };
            if (Date.now() >= deadlineAt) break;
            if (frame.rawEnd !== lastPermissionCheck.mark || !lastPermissionCheck.nativeStable) continue;
            if (native.calls.some(call => call.validation && call.result === 'pending')) continue;
            if (permissionViewport.active) {
              const wait = await permissionViewport.advance(native, frame);
              lastPermissionInputMark = Math.max(lastPermissionInputMark, permissionViewport.inputMark);
              if (wait) continue;
              // Recovery awaited a viewport transaction; refresh the same
              // owner/output bracket before the original reservation below.
              if (frame.rawEnd !== session.mark() || !isDeepStrictEqual(native,
                readPlanSkillQuestions(session.hermeticConfigDir, sessionId, session.nativeQuestionEvents))) continue;
            }
            const recentTail = frame.text;
            if (frame.rawEnd > lastPermissionInputMark && isNumberedOptionListVisible(recentTail) && isPermissionDialogVisible(recentTail)) {
              if (Date.now() >= deadlineAt) break;
              let reserved: boolean;
              try {
                reserved = reserveAutoplanFilePermission(native, recentTail, {
                  cwd: tempDir, planDir: path.join(fs.realpathSync(session.hermeticConfigDir!), 'plans'), granted, requests,
                });
              } catch (error) {
                if (!await permissionViewport.recover(error, native, frame)) throw error;
                lastPermissionInputMark = Math.max(lastPermissionInputMark, permissionViewport.inputMark);
                continue;
              }
              if (reserved) {
                lastPermissionInputMark = session.mark();
                session.send('1\r');
                continue;
              }
            }

            transcript = readAutoplanTranscript(session.hermeticConfigDir, sessionId);
            renderedPhases = [...new Set(observedAutoplanPhases(visible))];
            corroboratedPhases = corroboratedAutoplanPhases(transcript.phases, visible);
            if (Date.now() >= deadlineAt) break;
            // Reject a wrong authoritative order even if a tool preview looks
            // correct or some assistant announcements have not rendered yet.
            if (transcript.phases.includes(3)) validateAutoplanPhaseOrder(transcript.phases);

            // Terminal: all assistant announcements through Eng also rendered.
            if (corroboratedPhases.includes(3) && corroboratedPhases.length === transcript.phases.length) {
              outcome = 'chain_complete';
              break;
            }

            // Plan-ready as a fallback terminal — autoplan finished without
            // surfacing a Phase 3 marker. This is a regression surface.
            if (isPlanReadyVisible(visible) && transcript.file && transcript.pendingBytes === 0) {
              outcome = 'plan_ready';
              break;
            }
          }
          if (outcome === 'timeout') evidence = session.visibleSince(since).slice(-3000);
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
              `--- observed announcements ---\n${observations()}\n--- evidence ---\n${evidence}`,
            { cause: error },
          );
        } finally {
          if (outcome !== 'chain_complete') retainAutoplanFailure({
            configDir: session.hermeticConfigDir, sessionId,
            observation: { outcome, exitCode, transcript, renderedPhases, corroboratedPhases, lastPermissionCheck }, counting,
            raw: () => session.rawOutput(), visible: () => session.visibleText(),
          });
          await session.close();
        }

        if (outcome === 'exited' || outcome === 'timeout') {
          throw new Error(
            `autoplan chain test FAILED: outcome=${outcome}, exitCode=${exitCode}\n` +
              `--- observed announcements ---\n${observations()}\n` +
              `--- evidence ---\n${evidence}`,
          );
        }

        try {
          validateAutoplanPhaseOrder(transcript.phases);
          validateAutoplanPhaseOrder(corroboratedPhases);
          if (corroboratedPhases.length !== transcript.phases.length) {
            throw new Error('Not all assistant phase announcements appeared in the rendered stream');
          }
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
              `--- observed announcements ---\n${observations()}\n` +
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
