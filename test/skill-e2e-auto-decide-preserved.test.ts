/**
 * AUTO_DECIDE opt-in preserved under Conductor flags (periodic-tier, paid, real-PTY).
 *
 * Regression test for v1.21+ fix: the new "Tool resolution" preamble
 * (scripts/resolvers/preamble/generate-ask-user-format.ts) tells the model
 * to prefer mcp__*__AskUserQuestion variants and fall back to plan-file
 * decisions when neither is callable. This must NOT break the legitimate
 * `/plan-tune` AUTO_DECIDE path: when the user has explicitly opted into
 * auto-deciding a specific question via `gstack-question-preference --write
 * never-ask`, the model is supposed to honor that — it should still
 * auto-pick the recommended option and emit the AUTO_DECIDE annotation
 * ("Auto-decided <summary> → <option> (your preference). Change with
 * /plan-tune.") instead of opening a question prompt.
 *
 * Periodic tier: AUTO_DECIDE behavior depends on the model adhering to
 * the QUESTION_TUNING preamble injection. Non-deterministic; runs weekly
 * or manually rather than gating CI.
 *
 * Set up:
 *   - tmpDir as GSTACK_HOME (isolated state, doesn't touch the user's
 *     real ~/.gstack)
 *   - question_tuning=true in the tmp config
 *   - preference for plan-ceo-review-mode → never-ask (source: plan-tune)
 *
 * Spawn:
 *   claude --permission-mode plan --disallowedTools AskUserQuestion
 *   /plan-ceo-review
 *
 * Expected:
 *   - outcome === 'auto_decided' (the AUTO_DECIDE preamble fired and the
 *     "Auto-decided ... (your preference)" text rendered)
 *
 * If outcome is 'asked', the model ignored the user's `/plan-tune`
 * preference — that's a regression against the opt-in feature. A bare 'plan_ready' without mode-specific evidence is inconclusive, not a pass.
 */

import { test, expect } from 'bun:test';
import { CAPTURE_LONG_MS, PTY_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { runCeoModePreferenceObservation } from './helpers/ceo-mode-preference';
import { seedCeoFindingProject } from './helpers/ceo-finding-fixture';
import { seedHermeticGstackHome } from './helpers/hermetic-env';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const describeE2E = describeE2ETier('periodic');

const ROOT = path.resolve(import.meta.dir, '..');

describeE2E('AUTO_DECIDE opt-in preserved under Conductor flags (periodic)', () => {
  test('user-opted-in question still auto-decides when AskUserQuestion is --disallowedTools', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-auto-decide-'));
    const tmpHome = path.join(fixture, 'state');
    const project = path.join(fixture, 'project');
    fs.mkdirSync(tmpHome);
    fs.mkdirSync(project);
    try {
      seedCeoFindingProject(project, '# Export saved settings\n\nAdd a CSV export button to the settings page. Reuse the existing settings API;\nvalidate escaping for commas, quotes, and newlines. The change touches the settings\npage, a CSV formatter, and formatter tests. Review this plan before implementation.\n');
      // This explicit override replaces the default hermetic state. Keep its
      // normal onboarding/update baseline so unrelated setup prompts cannot
      // intercept the one question whose never-ask behavior this case checks.
      seedHermeticGstackHome(tmpHome);

      // 1. Bootstrap the tmp GSTACK_HOME with question_tuning=true.
      const configBin = path.join(ROOT, 'bin', 'gstack-config');
      const setRes = spawnSync(configBin, ['set', 'question_tuning', 'true'], {
        cwd: project,
        env: { ...process.env, GSTACK_HOME: tmpHome },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      if (setRes.status !== 0) {
        throw new Error(`gstack-config set failed: ${setRes.stderr || setRes.stdout}`);
      }

      // 2. Resolve slug for the project (uses git remote — same as the spawned
      //    claude would resolve). The preference file path keys on this slug.
      const slugBin = path.join(ROOT, 'bin', 'gstack-slug');
      const slugRes = spawnSync(slugBin, [], {
        // The slug probe and model must resolve the same isolated project.
        cwd: project,
        env: { ...process.env, GSTACK_HOME: tmpHome },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      // gstack-slug emits `eval`-able shell exports like `SLUG=garrytan-gstack`.
      const slug = (slugRes.stdout.match(/SLUG=([^\s;]+)/)?.[1] ?? 'unknown').replace(/['"]/g, '');

      // 3. Write the preference: plan-ceo-review-mode → never-ask. The
      //    'plan-tune' source bypasses the inline-user origin gate.
      const prefBin = path.join(ROOT, 'bin', 'gstack-question-preference');
      const writeRes = spawnSync(
        prefBin,
        ['--write', JSON.stringify({
          question_id: 'plan-ceo-review-mode',
          preference: 'never-ask',
          source: 'plan-tune',
        })],
        {
          cwd: project,
          env: { ...process.env, GSTACK_HOME: tmpHome },
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );
      if (writeRes.status !== 0) {
        throw new Error(`gstack-question-preference --write failed: ${writeRes.stderr || writeRes.stdout}`);
      }

      // Sanity: the preference file landed where we expect.
      const prefFile = path.join(tmpHome, 'projects', slug, 'question-preferences.json');
      if (!fs.existsSync(prefFile)) {
        throw new Error(`expected preference file at ${prefFile}; not found. slug=${slug}`);
      }

      // 4. Run the real skill with Conductor flags in the seeded project.
      //    GSTACK_HOME=tmpHome is REQUIRED: the preference + question_tuning were
      //    seeded there. Without it the spawned claude reads the real ~/.gstack,
      //    never sees the never-ask preference, and the test silently exercises
      //    the wrong state root (pre-existing bug, Codex #9 / Issue 13).
      //    CONDUCTOR_WORKSPACE_PATH additionally proves auto-decide still WINS
      //    over the Conductor prose redirect (precedence: settled preference
      //    beats transport-avoidance).
      const obs = await runCeoModePreferenceObservation({
        cwd: project,
        timeoutMs: CAPTURE_LONG_MS,
        env: { GSTACK_HOME: tmpHome, CONDUCTOR_WORKSPACE_PATH: project },
      });

      // A never-ask preference applies only to the mode question. The helper
      // answers owned, unrelated questions once and ignores tool previews.
      console.log('Mode preference observation:', JSON.stringify(obs));
      if (obs.outcome !== 'auto_decided') {
        throw new Error(
          `AUTO_DECIDE mode preference ${obs.outcome === 'asked' ? 'regression' : 'unverified'}: outcome=${obs.outcome}\n` +
          `--- owned evidence ---\n${obs.evidence}`,
        );
      }
      expect(obs.outcome).toBe('auto_decided');
    } finally {
      try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, PTY_MS);
});
