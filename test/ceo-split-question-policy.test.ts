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
  expect(pickPlanReviewQuestion(question())).toBe(1);
  expect(pickCeoSplitQuestion(question())).toBe(2);
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

// Import the actual paid case in a separate process with only its provider
// boundaries mocked. Seeding, chooser wiring, finalization and judgment gating run.
test.each(['complete', 'timeout'])('actual split registration keeps all five decisions and the native outcome gate: %s', async scenario => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-cap-registration-')));
  const facts = path.join(temp, 'facts.json');
  const script = path.join(temp, 'registration.test.ts');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickCeoSplitQuestion } from ${JSON.stringify(path.join(ROOT, 'test/helpers/ceo-split-question-policy.ts'))};
import { CEO_SCOPE_CANDIDATES } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
import { FORCING_SPLIT_OVERFLOW_CEO } from ${JSON.stringify(path.join(ROOT, 'test/fixtures/forcing-finding-seeds.ts'))};
const cap = ${JSON.stringify(question())};
const facts = { calls: 0, judgments: 0, cwd: '', selected: [], validated: false };
const fingerprints = [];
const save = () => fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(facts));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
const boundary = () => false;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  PLAN_SKILL_COUNT_FINALIZE_MS: 10_000, ceoStep0Boundary: boundary,
  runPlanSkillCounting: async opts => {
    facts.calls++; facts.cwd = opts.cwd; save();
    expect(opts.questionPick).toBe(pickCeoSplitQuestion);
    expect(opts.reviewCountCeiling).toBeNull();
    expect(opts.isLastStep0AUQ).toBe(boundary);
    expect(opts.timeoutMs).toBeGreaterThan(0); expect(opts.timeoutMs).toBeLessThanOrEqual(1_500_000);
    expect(opts.env).toEqual({ QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' });
    const input = fs.readFileSync(path.join(opts.cwd, 'review-input.md'), 'utf8');
    expect(input).toBe(FORCING_SPLIT_OVERFLOW_CEO.replaceAll('/tmp/gstack-test-plan-ceo-split-overflow.md',
      path.join(opts.cwd, 'gstack-test-plan-ceo-split-overflow.md')));
    for (const target of CEO_SCOPE_CANDIDATES) {
      const q = { ...cap, header: target.id, question: target.description,
        options: ['Include', 'Defer to next quarter', 'Cut entirely'].map(label => ({ label, description: '' })) };
      const selected = opts.questionPick(q); expect(selected).toBe(1);
      fingerprints.push({ toolUseId: target.id, questions: [q], selectedOptions: [selected] });
      facts.selected.push(target.id);
    }
    const selected = opts.questionPick(cap); expect(selected).toBe(2);
    fingerprints.push({ toolUseId: 'scope-cap', questions: [cap], selectedOptions: [selected] });
    facts.validated = true; save();
    return { outcome: ${JSON.stringify(scenario)} === 'timeout' ? 'timeout' : 'plan_ready',
      fingerprints, step0Count: 0, reviewCount: 6, elapsedMs: 1, evidence: 'controlled registration' };
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async opts => {
    facts.judgments++; save();
    expect(opts.fingerprints).toBe(fingerprints); expect(opts.fingerprints).toHaveLength(6);
    expect(opts.targets).toBe(CEO_SCOPE_CANDIDATES); expect(opts.targets.map(t => t.id)).toEqual(['E1','E2','E3','E4','E5']);
    expect(opts.kind).toBe('scope'); expect(opts.floor).toBe(4); expect(opts.ceiling).toBeUndefined();
    expect(opts.deadlineAt).toBeGreaterThan(Date.now()); expect(opts.deadlineAt).toBeLessThanOrEqual(Date.now() + 1_500_000);
    return { count: 6, coveredTargetIds: opts.targets.map(t => t.id) };
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
    expect(observed.selected).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    expect(observed.judgments).toBe(scenario === 'complete' ? 1 : 0);
    expect(fs.existsSync(observed.cwd)).toBe(false);
    expect(exit, out + err).toBe(scenario === 'complete' ? 0 : 1);
    if (scenario === 'timeout') expect(out + err).toContain('split-overflow test FAILED: outcome=timeout');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}, 20_000);
