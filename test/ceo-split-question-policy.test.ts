import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickCeoSplitQuestion } from './helpers/ceo-split-question-policy';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';

const ROOT = path.resolve(import.meta.dir, '..');
const question = (labels = ['A) Keep all six, lift the cap', 'B) Trim to cap: Slack + Teams (recommended)',
  'C) Revise one option', 'D) Hold — discuss first']): NativeQuestion => ({
  header: 'Final set', multiSelect: false,
  question: 'D4.final — The assembled set is six items at ~13 weeks, but the plan caps this quarter at 2-3 integrations. How do we resolve that?',
  options: labels.map(label => ({ label, description: 'Current assembled-scope choice.' })),
});

test('the observed cap conflict selects the offered trim rather than lifting the fixture cap', () => {
  expect(pickPlanReviewQuestion(question())).toBe(2);
  expect(pickCeoSplitQuestion(question())).toBe(2);
  const recommendsLiftingCap = question(['Keep all six, lift the cap (recommended)', 'Trim to cap: Slack + Teams']);
  expect(pickPlanReviewQuestion(recommendsLiftingCap)).toBe(1);
  expect(pickCeoSplitQuestion(recommendsLiftingCap)).toBe(2);
});

test.each([
  ['Trim to cap: Mattermost + Slack + Microsoft Teams', 'Keep all six, lift the cap'],
  ['Keep all six, lift the cap', 'Hold — discuss first', 'Trim to cap: Telegram + Discord'],
  ['Revise one option', 'Hold — discuss first', 'Keep all six, lift the cap', 'Trim to cap: Teams + Slack'],
].map(labels => [labels]))('an offered two-or-three-platform set can move within the menu: %j', labels => {
  expect(pickCeoSplitQuestion(question(labels))).toBe(labels.findIndex(label => label.startsWith('Trim to cap:')) + 1);
});

test.each([
  ['Keep all six, lift the cap', 'Revise one option'],
  ['Trim to cap: Slack + Teams', 'Trim to cap: Discord + Telegram'],
  ['Keep all six, lift the cap', '"Trim to cap: Slack + Teams"'],
  ['Keep all six, lift the cap', 'If budget expands, Trim to cap: Slack + Teams'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Teams if budget expands'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Teams + Discord + Telegram'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Webhook'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Slack'],
  ['Keep all six, lift the cap', 'Trim to cap: Teams + Microsoft Teams'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Teams', 'Skip the review'],
].map(labels => [labels]))('ambiguous, conditional or unsupported cap choices fail without inventing an answer: %j', labels => {
  expect(() => pickCeoSplitQuestion(question(labels))).toThrow('no unique offered');
});

test('multi-select cap reconciliation is not silently treated as a single choice', () => {
  expect(() => pickCeoSplitQuestion({ ...question(), multiSelect: true })).toThrow('no unique offered');
});

test('individual candidate decisions and unrelated, quoted or conditional questions keep the ordinary policy', () => {
  for (const [id, name] of ['Slack', 'Discord', 'Teams', 'Telegram', 'Mattermost'].entries()) {
    const candidate = { ...question(['Include', 'Defer to next quarter', 'Cut entirely']),
      header: `E${id + 1} ${name}`, question: `D4.${id + 1} — E${id + 1}) ${name}: include, defer, or cut?` };
    expect(pickCeoSplitQuestion(candidate)).toBe(pickPlanReviewQuestion(candidate));
    expect(pickCeoSplitQuestion(candidate)).toBe(1);
  }
  for (const other of [
    { ...question(), header: 'Documentation' },
    { ...question(), question: 'Quoted example: "' + question().question + '"' },
    { ...question(), question: 'If we ever exceed capacity, ' + question().question },
    { ...question(), question: 'Should the README quote this menu?\n' + question().question },
  ]) expect(pickCeoSplitQuestion(other)).toBe(pickPlanReviewQuestion(other));
});

test('the existing manual review handoff remains available unchanged', () => {
  const handoff = { ...question(['Run /plan-eng-review', 'Skip — handle manually']),
    header: 'Next review', question: 'D20 — What is next?' };
  expect(pickCeoSplitQuestion(handoff)).toBe(2);
});

// Exact ordinary native D5.1 input from the retained V4 split timeout.
const extraChannel = (): NativeQuestion => ({
  "header": "Webhook",
  "multiSelect": false,
  "options": [
    {
      "description": "Ship the Slack-compatible webhook channel this quarter after E1.",
      "label": "A) Add to scope (recommended)"
    },
    {
      "description": "Record it for next quarter.",
      "label": "B) Defer to TODOS.md"
    },
    {
      "description": "Do not pursue.",
      "label": "C) Skip"
    }
  ],
  "question": "D5.1 — Expansion: add a generic Slack-compatible incoming-webhook channel?\nProject/branch/task: main branch; cherry-pick 1 of 4 on top of the confirmed E1 + E3 + E4 scope.\nELI10: Picture the Mattermost admin at a high-ARR account opening your integration settings and finding a 'Slack-compatible webhook URL' field. They paste the URL their Mattermost server gave them, hit save, and the next incident lands in their channel formatted exactly like the Slack version. Same for a Discord community lead using their webhook's /slack endpoint. No bot install, no app review, no new auth flow. It reuses E1's Slack message builder and the adapter's post-and-retry loop, so the work is a settings field, a URL validator, and a test. Effort: S (human ~2-3 days / CC ~1 hour). Risk: low; the main gotcha is that Slack-format compatibility covers text and attachments but not interactive buttons.\nStakes if we pick wrong: skipping it leaves the two deferred segments with nothing this quarter; adding it costs a few days at the end of a full quarter.\nRecommendation: Add — this is a taste call, no strong preference either way, but it is the cheapest way to give the deferred segments something real this quarter.\nNote: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Add to this quarter's scope (recommended) (human: ~2-3 days / CC: ~1 hour)\n  ✅ Alert delivery reaches Mattermost and Discord this quarter for a fraction of a bot's cost\n  ✅ Doubles as a generic channel for any tool that speaks Slack payloads (Rocket.Chat, Zulip, custom)\n  ❌ Text-only delivery: no interactive buttons or slash commands on those platforms\n  ❌ Adds a fourth delivery surface to monitor at launch\nB) Defer to TODOS.md\n  ✅ Keeps the quarter at exactly three named integrations with a little more buffer\n  ✅ Still cheap next quarter since it depends only on E1's formatter\n  ❌ Deferred segments wait a full quarter for something that costs days\nC) Skip\n  ✅ Keeps the integrations page to first-class, branded platforms only\n  ✅ Avoids supporting arbitrary webhook endpoints you do not control\n  ❌ Gives up the eureka that made deferring E2 and E5 comfortable\nNet: a cheap generic channel for the deferred segments versus a tighter, branded-only launch."
});

test('the actual fourth-channel proposal defers while preserving the complete native input', () => {
  const native = extraChannel();
  const original = structuredClone(native);
  expect(pickPlanReviewQuestion(native)).toBe(1);
  expect(pickCeoSplitQuestion(native)).toBe(2);
  expect(native).toEqual(original);
});

test('the extra channel uses its unique offered deferral even when choices move', () => {
  const native = extraChannel();
  native.options = [native.options[1]!, native.options[2]!, native.options[0]!];
  expect(pickCeoSplitQuestion(native)).toBe(1);
});

test.each([
  ['Add to scope', 'Skip'],
  ['Add to scope', 'Defer to TODOS.md', 'Defer to TODOS.md'],
  ['Add to scope', 'If the cap stays, Defer to TODOS.md'],
  ['Add to scope', 'Defer to TODOS.md if convenient'],
  ['Add to scope', 'Defer to TODOS.md', 'Skip the review'],
].map(labels => [labels]))('a capped extra channel cannot invent a deferral: %j', labels => {
  const native = extraChannel();
  native.options = labels.map(label => ({ label, description: '' }));
  expect(() => pickCeoSplitQuestion(native)).toThrow('no unique offered deferral');
});

test('multi-select or repeated candidate IDs do not establish three confirmed integrations', () => {
  expect(() => pickCeoSplitQuestion({ ...extraChannel(), multiSelect: true })).toThrow('no unique offered deferral');
  const native = extraChannel();
  native.question = native.question.replace('E1 + E3 + E4', 'E1 + E3 + E1');
  expect(() => pickCeoSplitQuestion(native)).toThrow('no unique offered deferral');
});

test('the added-channel policy does not decline features, swaps, examples or a two-candidate set', () => {
  const native = extraChannel();
  for (const other of [
    { ...native, header: 'Test alert', question: native.question.replace(
      'add a generic Slack-compatible incoming-webhook channel?', "add a 'Send test alert' button on each integration's settings page?") },
    { ...native, header: 'Routing', question: native.question.replace(
      'add a generic Slack-compatible incoming-webhook channel?', 'route alerts by severity to different channels?') },
    { ...native, question: native.question.replace('Expansion: add', 'Expansion: replace Teams with') },
    { ...native, question: native.question.replace('E1 + E3 + E4', 'E1 + E3') },
    { ...native, question: 'Quoted example: ' + native.question },
    { ...native, question: 'If capacity later changes, ' + native.question },
    { ...native, question: native.question.replace('the confirmed', 'the proposed') },
  ]) expect(pickCeoSplitQuestion(other)).toBe(pickPlanReviewQuestion(other));
});

// Import the actual paid case with its provider boundary mocked. The caller
// supplies all five candidates; the native runner owns the workspace and count.
test.each([
  { outcome: 'plan_ready', count: 5, passes: true },
  { outcome: 'completion_summary', count: 5, passes: true },
  { outcome: 'ceiling_reached', count: 8, passes: true },
  { outcome: 'plan_ready', count: 3, passes: false },
  { outcome: 'timeout', count: 5, passes: false },
])('actual split registration preserves every candidate and its native outcome/count gates: %j', async scenario => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-cap-registration-')));
  const facts = path.join(temp, 'facts.json');
  const script = path.join(temp, 'registration.test.ts');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CEO_SCOPE_CANDIDATES } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
import { FORCING_SPLIT_OVERFLOW_CEO } from ${JSON.stringify(path.join(ROOT, 'test/fixtures/forcing-finding-seeds.ts'))};
const facts = { calls: 0, directory: '', candidates: [], validated: false };
const save = () => fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(facts));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
const boundary = () => false;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  ceoStep0Boundary: boundary,
  runPlanSkillCounting: async opts => {
    facts.calls++; save();
    expect(opts.skillName).toBe('plan-ceo-review');
    expect(opts.slashCommand).toBe('/plan-ceo-review');
    expect(opts.cwd).toBeUndefined();
    expect(opts.reviewCountCeiling).toBe(8);
    expect(opts.isLastStep0AUQ).toBe(boundary);
    expect(opts.timeoutMs).toBe(1_500_000);
    expect(opts.preconfiguredReviewActor).toBe(true);
    expect(opts.env).toEqual({ QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' });
    const directory = fs.readdirSync(${JSON.stringify(temp)}).find(name => name.startsWith('gstack-e2e-plan-ceo-split-overflow-'));
    expect(directory).toBeDefined();
    facts.directory = path.join(${JSON.stringify(temp)}, directory);
    const planPath = path.join(facts.directory, 'gstack-test-plan-ceo-split-overflow.md');
    expect(opts.followUpPrompt).toBe(FORCING_SPLIT_OVERFLOW_CEO.replaceAll('/tmp/gstack-test-plan-ceo-split-overflow.md', planPath));
    for (const target of CEO_SCOPE_CANDIDATES) {
      expect(opts.followUpPrompt).toContain('## ' + target.id + ')');
      facts.candidates.push(target.id);
    }
    facts.validated = true; save();
    return { outcome: ${JSON.stringify(scenario.outcome)}, reviewCount: ${scenario.count},
      fingerprints: CEO_SCOPE_CANDIDATES.slice(0, ${scenario.count}).map(target => ({preReview: false, promptSnippet: target.description})),
      step0Count: 0, elapsedMs: 1, evidence: 'controlled registration' };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-ceo-split-overflow.test.ts'))});
`);
  try {
    const child = Bun.spawn([process.execPath, 'test', script], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, TEMP: temp, TMP: temp,
        GIT_CONFIG_NOSYSTEM: '1', EVALS_HERMETIC: '1',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const [exit, out, err] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.calls, out + err).toBe(1); expect(observed.validated, out + err).toBe(true);
    expect(observed.candidates).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    expect(fs.existsSync(observed.directory)).toBe(false);
    expect(exit, out + err).toBe(scenario.passes ? 0 : 1);
    if (scenario.outcome === 'timeout') expect(out + err).toContain('split-overflow test FAILED: outcome=timeout');
    if (scenario.count < 4) expect(out + err).toContain('SPLIT-OVERFLOW REGRESSION: reviewCount=3 < FLOOR=4');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}, 20_000);
