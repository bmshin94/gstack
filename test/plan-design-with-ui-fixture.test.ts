import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// Execute the real paid registration with only native observation replaced.
// Exact input seeding, case assertions, and cleanup still execute.
function exercise(mode: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'design-ui-free-'));
  const script = path.join(directory, 'registration.test.ts');
  const facts = path.join(directory, 'facts.json');
  fs.writeFileSync(script, `
import { describe, expect, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const mode = ${JSON.stringify(mode)};
const fixture = ${JSON.stringify(path.join(ROOT, 'test/fixtures/plans/ui-heavy-feature.md'))};
const template = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'plan-design-review/SKILL.md.tmpl'))}, 'utf8');
const focus = template.match(/### 0D\\. Focus Areas\\nAskUserQuestion: "([^\\n]+)"/)![1]
  .replace('{N}', '4').replace('{X, Y, Z}', 'hierarchy, spacing, contrast');
const { pickPlanReviewQuestion } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))});
const fp = (id, question, preReview = true) => ({
  signature: id, toolUseId: id, promptSnippet: question.slice(0, 240),
  questions: [{ header: 'Review', question, multiSelect: false, options: [
    { label: 'Review all 7 dimensions (recommended)', description: 'Review the supplied UI plan.' },
    { label: 'Review a different branch', description: 'That branch may have no UI scope; design review is not applicable there.' },
  ] }],
  options: [{ index: 1, label: 'Review all 7 dimensions (recommended)' }, { index: 2, label: 'Review a different branch' }],
  selectedOptions: [1], observedAtMs: 1000, preReview,
});
const target = fp('target', 'D1 — What should I design-review?\\nProject/branch/task: gstack repo, no plan file drafted yet.\\nELI10: A design review needs a target. Pick what I should rate 0-10 across the 7 design dimensions.');
target.questions[0].header = 'Review target';
if (mode === 'target-menu-design-system') {
  target.questions[0].question = 'What should I design-review? ELI10: Choose a plan, design system, or the current branch diff.';
  target.promptSnippet = target.questions[0].question;
}
target.questions[0].options = [
  { label: 'B) A plan or design doc (recommended)', description: 'You need to paste the plan or point me to a path.' },
  { label: 'A) The current branch diff', description: 'The working tree is clean, so there may be no UI scope to review.' },
];
const paraphrase = fp('focus', 'D1 — Review all 7 design dimensions, or focus on specific areas?\\nELI10: I rated this plan 4/10.');
// Public titles/options projected from the retained Sep 11 native PostToolUse
// events: focus toolu_01XJZk6qbs3Fj3VRbm6sCNv2, setup toolu_01WkR4juMdcMxCTJe8FfRMVY,
// finding toolu_012EsyqshgBk2Ap7CfuzwhwQ. No transcript paths or private content.
const nativeFocus = fp('native-focus', 'D1 — Review all 7 design dimensions, or focus?');
nativeFocus.questions[0].options = [
  { label: 'All 7 dimensions (recommended)', description: 'Full review: hierarchy, states, journey, specificity, AI slop, responsive, accessibility. Completeness 10/10.' },
  { label: 'States + hierarchy + a11y', description: 'Focus on the three weakest areas only. Completeness 7/10.' },
  { label: 'Visual + AI slop only', description: 'Focus on look and originality, skip state and interaction passes. Completeness 4/10.' },
];
const nativeSetup = fp('native-setup', 'D2 — Run outside design voices before the 7 passes?', false);
nativeSetup.questions[0].options = [
  { label: 'Yes, run outside voices (recommended)', description: 'Codex design critique + independent Claude subagent, run in parallel, synthesized into a litmus scorecard.' },
  { label: 'No, skip to the passes', description: 'Go straight to Pass 1 with my review only.' },
];
const nativeFinding = fp('native-finding', "D3 — Issue 1 [HARD REJECTION risk]: Which region is the dashboard's primary anchor, and how is the page composed?", false);
nativeFinding.questions[0].options = [
  { label: '1A Notifications-primary (recommended)', description: 'Status line + unread count anchors; notifications ~7/12, activity ~5/12; mobile order status, notifications, activity. Completeness 10/10.' },
  { label: '1B Activity-primary (Codex)', description: 'Activity dominant ~7/12, notifications right rail; primary action beside title. Completeness 10/10.' },
  { label: '1C Three peer regions, decide later', description: 'Keep the plan as written; hard rejection #1 stays open. Completeness 3/10.' },
];
const unnumberedFinding = fp('unnumbered-finding', "Which region is the dashboard's primary anchor, and how is the page composed?", false);
unnumberedFinding.questions[0].options = nativeFinding.questions[0].options;
const finding = fp('finding', 'Which loading feedback should Save show?', false);
finding.questions[0].options = [
  { label: 'Saving label and spinner (recommended)', description: 'Show in-flight feedback in the Save button.' },
  { label: 'Keep the current button', description: 'Keep the button label and current loading feedback.' },
];
let calls = 0;
fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ calls }));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('gate'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  runPlanSkillCounting: async opts => {
    calls++;
    expect(path.dirname(opts.cwd)).toBe(${JSON.stringify(directory)});
    expect(opts.cwd).not.toBe(${JSON.stringify(ROOT)});
    expect(opts.skillName).toBe('plan-design-review');
    expect(opts.slashCommand).toBe('/plan-design-review');
    expect(opts.followUpPrompt).toBe('');
    expect(opts.reviewCountCeiling).toBe(1);
    expect(opts.questionPick).toBe(pickPlanReviewQuestion);
    expect(opts).not.toHaveProperty('model');
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(600_000);
    expect(fs.readFileSync(path.join(opts.cwd, 'review-input.md'), 'utf8')).toBe(fs.readFileSync(fixture, 'utf8'));
    expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 })).toBe(fs.readFileSync(fixture, 'utf8'));
    expect(fs.readFileSync(path.join(opts.cwd, 'CLAUDE.md'), 'utf8')).toContain('Read it before\\nchoosing review scope.');
    expect(opts.isLastStep0AUQ(target)).toBe(false);
    expect(opts.isLastStep0AUQ(fp('focus', focus))).toBe(true);
    expect(opts.isLastStep0AUQ(paraphrase)).toBe(true);
    if (mode.startsWith('native-')) expect(opts.isLastStep0AUQ(nativeFocus)).toBe(true);
    expect(opts.isReviewAUQ(target)).toBe(false);
    expect(opts.isReviewAUQ(nativeFocus)).toBe(false);
    expect(opts.isReviewAUQ(nativeSetup)).toBe(false);
    expect(opts.isReviewAUQ(nativeFinding)).toBe(true);
    expect(opts.isReviewAUQ(unnumberedFinding)).toBe(true);
    expect(opts.isReviewAUQ(finding)).toBe(true);
    const chosenFocus = mode.startsWith('native-') ? nativeFocus : mode === 'paraphrase' ? paraphrase : fp('focus', focus);
    expect(opts.questionPick(chosenFocus.questions[0], true)).toBe(1);
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ calls, cwd: opts.cwd, seeded: true }));
    if (mode === 'throw') throw new Error('controlled UI observation failure');
    const observed = mode.startsWith('target-menu') ? [target, fp('other', 'Which artifact should I inspect?', false)]
      : mode === 'early-exit' ? [] : mode === 'focus-only' ? [chosenFocus]
      : mode === 'native-setup-only' ? [nativeFocus, nativeSetup]
      : mode.startsWith('native-') ? [nativeFocus, nativeSetup, mode === 'native-unnumbered' ? unnumberedFinding : nativeFinding]
      : [chosenFocus, finding];
    return {
      outcome: mode === 'early-exit' ? 'plan_ready' : mode === 'timeout' ? 'timeout' : mode === 'exited' ? 'exited' : 'ceiling_reached',
      fingerprints: observed, step0Count: 1, reviewCount: 1, elapsedMs: 1000,
      evidence: mode === 'early-exit' ? "This plan has no UI scope. A design review isn't applicable."
        : 'Unselected alternative: The other branch may have no UI scope.',
    };
  },
}));
if (mode === 'missing-fixture') {
  const read = fs.readFileSync;
  spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (String(file) === fixture) throw Object.assign(new Error('UI fixture is missing'), { code: 'ENOENT' });
    return read(file, ...args);
  });
}
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-design-with-ui.test.ts'))});
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT, timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TEMP: directory, TMP: directory,
        GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull();
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.calls, output).toBe(mode === 'missing-fixture' ? 0 : 1);
    if (mode !== 'missing-fixture') expect(observed.seeded, output).toBe(true);
    expect(fs.readdirSync(directory).filter(name => name.startsWith('design-ui-project-'))).toEqual([]);
    return { code: child.exitCode, output };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test.each(['source', 'paraphrase', 'native-sequence', 'native-unnumbered'])('UI gate seeds the exact target and accepts Design progress with an unselected no-UI alternative (%s)', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(0);
}, 20_000);

test.each(['target-menu', 'target-menu-design-system', 'focus-only', 'native-setup-only', 'early-exit', 'timeout', 'exited'])('UI gate rejects %s and removes its fixture', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('plan-design-review with UI scope FAILED');
}, 20_000);

test.each(['throw', 'missing-fixture'])('UI gate preserves %s failure and removes its fixture', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(mode === 'throw' ? 'controlled UI observation failure' : 'UI fixture is missing');
}, 20_000);
