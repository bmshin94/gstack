import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-batching-native-8525.json';
import { isEngBatchingIssueAUQ } from './helpers/eng-seeded-coverage';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const copy = <T>(v: T): T => structuredClone(v);
const first = fixture.attempts[0]!, retry = fixture.attempts[1]!;
const check = (call: NativePlanQuestionCall, prior: readonly NativePlanQuestionCall[] = []) =>
  isEngBatchingIssueAUQ(nativePlanCallFingerprint(call, 0, true), prior);
const revise = (call: NativePlanQuestionCall, text: string) => {
  const answer = call.answers![call.questions[0]!.question]!;
  call.questions[0]!.question = text; call.answers = { [text]: answer };
};
for (const attempt of fixture.attempts) test(`actual attempt ${attempt.attempt} independently answered review decisions satisfy the unchanged floor`, () => {
  const calls = attempt.calls as NativePlanQuestionCall[];
  const decisions = calls.filter((call, i) => check(call, calls.slice(0, i)));
  expect(attempt.originalOutcome.reviewCount).toBe(0);
  expect(calls.every(call => call.answered && !call.failed && call.questions.length === 1)).toBe(true);
  expect(decisions).toHaveLength(attempt.expectedSeparateDecisions);
  expect(decisions.length).toBeGreaterThanOrEqual(3);
  // Replay the full retained history to expose extra real questions; the paid
  // runner keeps its original ceiling7 and stops on the seventh valid decision.
  expect(calls.slice(0, 3).some(call => check(call))).toBe(false);
  expect(calls.slice(-3).some(call => check(call))).toBe(false);
});

for (const [name, change] of Object.entries({
  'pending': (c: NativePlanQuestionCall) => { c.answered = false; },
  'failed': (c: NativePlanQuestionCall) => { c.failed = true; },
  'unanswered component': (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
  'missing timestamp': (c: NativePlanQuestionCall) => { delete c.answeredAt; },
  'unoffered recommendation': (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Recommendation: A' }; },
  'quoted question': (c: NativePlanQuestionCall) => revise(c, '> ' + c.questions[0]!.question.replaceAll('\n', '\n> ')),
  'code question': (c: NativePlanQuestionCall) => revise(c, '```text\n' + c.questions[0]!.question + '\n```'),
  'historical question': (c: NativePlanQuestionCall) => revise(c, 'Historical example:\n' + c.questions[0]!.question),
  'source only in quoted text': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replaceAll('PLAN.md', '"PLAN.md"')),
  'source-only metadata': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace('Project/branch/task:', 'Project/branch/task: quoted source material,')),
  'literal-only explanation': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace(/^ELI10: (.*)$/m, 'ELI10: "$1"')),
  'no own current source': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replaceAll('PLAN.md', 'another-project.md')),
  'no own explanation': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace(/^ELI10:.*$/m, '')),
  'quoted explanation': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace(/^ELI10:/m, '> ELI10:')),
  'withdrawn own decision': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question + '\nThis decision is withdrawn.'),
  'scalar withdrawn own decision': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question + '\nThis decision is `withdrawn`.'),
  'duplicate options': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
})) test(`current decision identity rejects ${name}`, () => {
  for (const source of [first.calls[3]!, retry.calls[3]!]) {
    const call = copy(source) as NativePlanQuestionCall; change(call); expect(check(call)).toBe(false);
  }
});

test('current question identity cannot come only from an unrelated recap or bare decision number', () => {
  const call = copy(first.calls[3]!) as NativePlanQuestionCall;
  revise(call, call.questions[0]!.question.replace('finding F1 (PLAN.md:6-8)', 'unrelated prior finding F1 is fixed (PLAN.md:6-8)'));
  expect(check(call)).toBe(false);
  const bare = copy(retry.calls[3]!) as NativePlanQuestionCall;
  revise(bare, bare.questions[0]!.question.replace('R1: ', ''));
  expect(check(bare)).toBe(false);
});

test('each owned issue counts once regardless of option order, recommendation or repeated tool ID', () => {
  for (const source of [first.calls[3]!, retry.calls[3]!]) {
    const call = copy(source) as NativePlanQuestionCall;
    call.questions[0]!.options.reverse(); call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
    expect(check(call)).toBe(true);
    expect(check(call, [call])).toBe(false);
    const reasked = copy(call); reasked.toolUseId += '_again';
    expect(check(reasked, [call])).toBe(false);
    expect(check(reasked, [{ ...call, sessionId: 'foreign-session' }])).toBe(false);
  }
});

test('one native batch cannot satisfy the floor and does not suppress a later separate issue', () => {
  const calls = first.calls.slice(3, 7).map(call => copy(call)) as NativePlanQuestionCall[];
  const batch = copy(calls[0]!);
  batch.questions = calls.flatMap(call => call.questions); batch.answers = Object.assign({}, ...calls.map(call => call.answers));
  expect(check(batch)).toBe(false);
  expect(Number(check(batch))).toBeLessThan(3);
  const separate = copy(calls[0]!); separate.toolUseId += '_separate';
  expect(check(separate, [batch])).toBe(true);
});

test('native fingerprint ownership stays mandatory', () => {
  const fp = nativePlanCallFingerprint(copy(retry.calls[3]!) as NativePlanQuestionCall, 0, true);
  fp.signature = 'different:owner'; expect(isEngBatchingIssueAUQ(fp)).toBe(false);
});


test('a record title must match its own native header and remains the same issue after a new D number', () => {
  const original = copy(retry.calls[3]!) as NativePlanQuestionCall;
  const wrong = copy(original); wrong.questions[0]!.header = 'R9 unrelated'; expect(check(wrong)).toBe(false);
  const repeated = copy(original); repeated.toolUseId += '_reopen';
  revise(repeated, repeated.questions[0]!.question.replace('D4 —', 'D24 —'));
  expect(check(repeated, [original])).toBe(false);
  revise(repeated, repeated.questions[0]!.question + '\nR1 is no longer current.');
  expect(check(repeated)).toBe(false);
});
