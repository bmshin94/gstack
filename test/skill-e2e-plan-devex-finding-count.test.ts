/** Periodic real-PTY review: validate every seeded decision across all phases,
 * count substantive calls within the existing band, and reject bundled issues.
 * The 25-minute work budget includes the final semantic judgment. */

import { test } from 'bun:test';
import { evaluatePlanReviewDecisions } from './helpers/plan-review-decisions';
import { DEVEX_FINDINGS, pickDevexCheckpointQuestion } from './helpers/plan-review-cases';
import { seedDevexReviewProject } from './helpers/ceo-finding-fixture';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  PLAN_SKILL_COUNT_FINALIZE_MS,
  devexStep0Boundary,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1;
const CEILING = N + 2;

// Authored fixture assumptions about the existing SDK, not production discoveries
// or proposed remedies for the five launch gaps below.
// This revised synthetic baseline explicitly supplies documentation/feedback facts
// that V5 left unknown. It does not reinterpret V5 or guarantee a question count.
const existingDevexContracts = `## Existing SDK contracts (synthetic fixture assumptions)

This launch exposes an existing SDK to public beta users; it is not a proposal to
design its language, evaluator, API, or release infrastructure from scratch. These
unchanged contracts describe the fixture's current product and remain reviewable
if a concrete incompatibility with the launch plan is found.
This review input summarizes those contracts. README.md and docs/getting-started.md
(including the free-text example), docs/feedback.md, and docs/reference-v1.md
are materialized product documentation for this synthetic baseline. The SDK
implementation is not included; example commands describe the assumed SDK and are
not runnable against an implementation in this review fixture.
The revised fixture additionally supplies a version lookup, reference navigation,
beta-stability summary, neutral pytest assertion, error example, and documented
configuration boundaries. These are new explicit synthetic baseline facts, not
claims about earlier runs. In particular, arbitrary application requests need
their own bounds; SDK-managed provider limits cannot intercept them. All five
launch gaps in the supplied plan remain unresolved; the added reference is not their remedy.
The materialized success snippets now print deterministic JSON from documented
case fields and show the exact output, without assuming the SDK's repr. The guide
also supplies complete local application-client/transport files with per-attempt
timeouts, finite retries and upfront integer-cent reservations; a paid substitute
requires a verified per-attempt charge bound, and timeout reservations are not refunded.
The CLI reference supplies its exact app.py targets and JSON-list cases.json.
Fixture checks execute those application examples and explicit SDK-contract doubles
offline. These are authored baseline additions; no SDK execution is claimed.

- The Python package is eval-sdk, imported as eval_sdk, with the eval-sdk CLI.
  The README already states its purpose (evaluate an application's outputs against
  caller-supplied cases), supported Python versions, pip install command, and link
  to a plain-text getting-started guide. It also mirrors the guide's neutral
  first example and output contract; the existing offline release checks keep
  the two copies consistent. No second-language port is planned.
- evaluate(target, cases, metric) accepts the developer's application callable;
  cases contain inputs and expected outputs, and the caller supplies the metric
  and acceptance rule. Results expose per-case scores and failures. There is no
  hard-coded quality threshold or implied built-in production acceptance policy.
  Result/Failure str/repr already show readable per-case scores and expected/actual
  failure summaries, with explicit truncation; structured fields retain full values.
  The existing guide runs the same callable and cases as real usage, without a
  separate scaffold/configuration language or an interactive demo. It includes a
  five-line caller-owned exact-match metric for structured outputs and a custom-
  metric example for free text; neither is a bundled metric or an implicit default.
  The latter is a complete callable/cases/evaluate example, exercised by existing
  offline release checks with matching and mismatching prose. Those checks verify
  its per-case scores; they do not choose a production quality threshold. The
  neutral getting-started flow still has no designed delight or aha sequence.
- Both the CLI and library enforce the mandatory first-run CI prerequisite
  described above. Existing API documentation does not bypass that requirement.
  Its documented purpose is maintainer compatibility/conformance checking using
  bundled deterministic cases; it writes a diagnostic report. Evaluation does not
  consume that report or prerequisite state, but both entrypoints still block
  the first eval for the full five-minute step with no skip.
- Errors have stable codes, the originating cause, and an actionable next step;
  secrets are redacted. CLI help documents noninteractive execution and exit
  statuses. The same validated invocation runs locally and in CI. Text and
  structured errors carry a stable versioned URL/anchor to the code's reference
  entry; release checks verify code/anchor coverage.
- Provider calls have documented request timeouts and a finite retry policy;
  execution accepts an overall deadline. Cost ceilings remain enforced in
  noninteractive mode, and the same configured ceilings/deadlines apply locally.
  Before work, the CLI reports case count, deadline and ceiling (or "none set") to
  stderr; the library reports them when stderr is a TTY, with a documented reporter
  on/off override. Library output never touches stdout. Responses and scores are
  not persisted in a shared cache. These controls establish no first-run time target.
- In-repo API, error, configuration, and upgrade references already exist, with
  executable examples and a documented pytest pattern. Shipped documentation
  snippets and shown output come from offline examples run in release checks.
  Releases preserve the
  published API/configuration contract during beta. Breaking changes require a
  versioned migration guide and deprecation notices; runtime DeprecationWarning at
  the call site names the replacement, removal version and migration anchor.
  Removal requires two minor releases of notice and a breaking release. Public API
  type hints and py.typed already ship; release checks include strict type checking.
  No AST rewriting tool or plugin is part of this launch.
- The SDK is already open source. CONTRIBUTING, issue templates, and a public
  discussion forum define support and contribution paths. The existing
  getting-started friction template and pinned forum thread request the stuck
  step, optional elapsed-time estimate, SDK version, expected/actual behavior
  and a redacted reproducer; README links this path. These voluntary reports
  are not an onboarding-duration benchmark or telemetry. The beta adds no
  hosted docs service, new CI provider, telemetry system, or watch-mode feature.
  Release checks exercise existing API/error/compatibility behavior, but they
  contain no onboarding-duration measurement or peer-DX benchmark.
`;

const planDevex5Findings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  'Use DX POLISH mode for this review; examine the current plan with full rigor.',
  '',
  '# Plan: First-Run Onboarding Polish for the Public SDK Beta',
  '',
  // This onboarding scope is authored for the synthetic fixture.
  'This is a decision-planning checkpoint for the five first-run obligations below,',
  'not a beta-launch readiness review. All five remain unresolved, including the',
  'mandatory first-run gate in both the API and CLI. Evaluate all eight DX passes',
  'and the required peer comparison. Include the code, documentation and regression',
  'proof necessary for the chosen remedies; no obligation may be deferred as a TODO.',
  'Unknown SDK or repository facts remain verification requirements or blockers,',
  'not assumptions that the product is complete. Surface any real incompatibility',
  'that affects a chosen remedy, even if it prevents completing this checkpoint.',
  'Independent roadmap, baseline-documentation, packaging and release additions',
  'belong in separate planning; this session does not authorize scope expansion.',
  'Report those opportunities without adding them to this delivery. If offered an',
  'optional TODO disposition, keep it for later planning in TODOS.md, not Build it now.',
  '',
  '## Persona',
  "The plan doesn't specify which developer persona is the target — we're",
  "shipping for \"everyone,\" which means we tune for nobody.",
  '',
  '## TTHW (time to hello world)',
  'Time-to-hello-world is not measured. No benchmark data referenced. We',
  "don't know if first-run takes 5 minutes or 50.",
  '',
  '## Friction Point',
  'First-run currently requires a 5-minute mandatory CI step before the',
  'developer can run their first eval. There is no way to skip it.',
  '',
  '## Magical Moment',
  'Getting-started flow has no delight beat. Pure documentation, no',
  'interactive demo, no "ah-ha" moment that makes the developer trust us.',
  '',
  '## Competitive Blind Spot',
  "The plan doesn't reference how peer SDKs (LangChain, Semantic Kernel,",
  'OpenAI) handle this DX surface. We may be reinventing worse versions',
  'of solved problems.',
].join('\n') + '\n\n' + existingDevexContracts;

describeE2E('/plan-devex-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-obligation plan covers four decisions and peer analysis in ${FLOOR}-${CEILING} substantive calls`,
    async () => {
      const caseStartedAt = Date.now();
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-devex-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-devex.md');

      try {
        const planText = planDevex5Findings(planPath);
        seedDevexReviewProject(tmpDir, planText);
        const obs = await runPlanSkillCounting({
          skillName: 'plan-devex-review',
          slashCommand: '/plan-devex-review',
          followUpPrompt: '', // plan already committed before the first model turn
          isLastStep0AUQ: devexStep0Boundary,
          reviewCountCeiling: null, // classify findings after actual workflow completion
          questionPick: pickDevexCheckpointQuestion,
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
            `plan-devex-review finding-count FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `last sampled counting state: ${JSON.stringify(obs.diagnostics)}\n` +
              `All-phase fingerprints (last 8; bounded native IDs and prompt snippets):\n` +
              obs.fingerprints
                .slice(-8)
                .map((f) => `  - ${JSON.stringify({ preReview: f.preReview, nativeToolId: f.toolUseId?.slice(0, 256) ?? null, promptSnippet: f.promptSnippet.slice(0, 80) })}`)
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
        // Peer research is required analysis; it must not manufacture an extra
        // approval. Retain the exact same-run plan used for quoted evidence.
        console.log('Plan review peer comparison artifact:', JSON.stringify({ finalPlan: planContent }));
        const decisions = await evaluatePlanReviewDecisions({
          plan: planText, targets: DEVEX_FINDINGS, fingerprints: obs.fingerprints,
          devexPeerComparison: { finalPlan: planContent },
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
