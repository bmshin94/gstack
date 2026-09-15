import { expect, test } from 'bun:test';
import fixture from './fixtures/ceo-payment-ledger-decisions.json';
import { ceoPaymentFinding, createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ, ceoStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';

const clone = <T>(value: T): T => structuredClone(value);
const seeded = fixture.captures.filter(c => c.kind === 'seeded-remedy');
const fingerprint = (capture = seeded[0]!) => nativePlanCallFingerprint(clone(capture.call), 1, true);
const saved = (i = 0) => seeded[i]!.savedPlan!;
const recognize = (fp = fingerprint(), plan = saved(), seed = fixture.seed) => ceoPaymentFinding(fp, seed, plan);
const reanswer = (fp: ReturnType<typeof fingerprint>) => {
  const q = fp.nativeCall!.questions[0]!;
  fp.nativeCall!.answers = { [q.question]: q.options[0]!.label };
  fp.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
};

test('actual CLI 2.1.251 capture: five independently acknowledged 0D remedies have saved seed linkage', () => {
  expect(fixture.originalOutcome).toEqual({ outcome: 'no_review_questions', reviewCount: 0, step0Count: 8 });
  expect(seeded).toHaveLength(5);
  expect(seeded.map(c => ceoFirstReviewAUQ(fingerprint(c)))).toEqual([false, false, false, false, false]);
  expect(seeded.map(c => ceoPaymentFinding(fingerprint(c), fixture.seed, c.savedPlan!)?.seed))
    .toEqual(['dispatcher', 'lookup', 'email', 'tests', 'orders']);
  for (const c of seeded) {
    const found = ceoPaymentFinding(fingerprint(c), fixture.seed, c.savedPlan!);
    expect(found?.phase).toBe('Step 0D. Alternatives (pending)');
    expect(found?.signature).toBe(`${c.call.sessionId}:${c.call.toolUseId}`);
  }
});

test('all eight captured calls retain phase provenance, exclude onboarding and count the actual TODO toward the upper bound', () => {
  let plan = '', boundary = false, count = 0;
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => plan, ceoFirstReviewAUQ);
  const prior: any[] = [];
  for (const c of fixture.captures) {
    if (c.savedPlan) plan = c.savedPlan;
    const fp = fingerprint(c);
    const phase = planCountQuestionPhase(fp, boundary, ceoStep0Boundary, ceoFirstReviewAUQ);
    count += Number(counter.isReviewAUQ(fp, prior));
    boundary = phase.reviewStarted;
    prior.push(c.call);
  }
  expect(count).toBe(6);
  expect(boundary).toBe(false);
  expect(counter.trace.filter(t => 'seed' in t)).toHaveLength(5);
  expect(counter.trace.filter(t => 'phase' in t).every(t => t.phase.startsWith('Step 0D'))).toBe(true);
});

for (const [name, mutate] of Object.entries({
  unanswered: (fp: any) => { fp.nativeCall.answered = false; fp.nativeCall.answers = {}; },
  'failed tool result': (fp: any) => { fp.nativeCall.failed = true; },
  'unanswered question index': (fp: any) => { fp.nativeCall.unansweredQuestionIndices = [0]; },
  'foreign signature': (fp: any) => { fp.signature = 'other:tool'; },
  'wrong question answer identity': (fp: any) => { fp.nativeCall.answers = { other: fp.options[0].label }; },
  'not an offered answer': (fp: any) => { fp.nativeCall.answers[fp.nativeCall.questions[0].question] = 'not offered'; },
  multiselect: (fp: any) => { fp.nativeCall.questions[0].multiSelect = true; },
  'duplicate native labels': (fp: any) => { fp.nativeCall.questions[0].options[1].label = fp.options[0].label; reanswer(fp); },
  'stale visible option': (fp: any) => { fp.options[0].label = 'other'; },
  'missing acknowledgment time': (fp: any) => { delete fp.nativeCall.answeredAt; },
  'quoted current question': (fp: any) => { fp.nativeCall.questions[0].question = fp.nativeCall.questions[0].question.split('\n').map((l: string) => '> ' + l).join('\n'); reanswer(fp); },
  'copied question in code': (fp: any) => { fp.nativeCall.questions[0].question = '```\n' + fp.nativeCall.questions[0].question + '\n```'; reanswer(fp); },
  'wrong defect': (fp: any) => { fp.nativeCall.questions[0].question = fp.nativeCall.questions[0].question.replace(/^ELI10: .+$/m, 'ELI10: The plan has a missing loading spinner.'); reanswer(fp); },
  'ordinary approach only': (fp: any) => { fp.nativeCall.questions[0].question = fp.nativeCall.questions[0].question.replace(/^ELI10: .+$/m, 'ELI10: Choose the overall project approach; all current obligations are already satisfied.'); reanswer(fp); },
})) test(`does not credit ${name}`, () => { const fp = fingerprint(); mutate(fp); expect(recognize(fp)).toBeNull(); });

test('unrelated, quoted, duplicated or unresolved-without-comparison ledgers do not bind', () => {
  expect(recognize(fingerprint(), saved().replaceAll('R1', 'OTHER'))).toBeNull();
  expect(recognize(fingerprint(), saved().split('\n').map(l => '> ' + l).join('\n'))).toBeNull();
  expect(recognize(fingerprint(), '```md\n' + saved() + '\n```')).toBeNull();
  expect(recognize(fingerprint(), saved() + '\n' + saved())).toBeNull();
  expect(recognize(fingerprint(), saved().slice(0, saved().indexOf('### R1.')))).toBeNull();
  expect(recognize(fingerprint(), saved().replaceAll('PLAN.md', 'unrelated-project.md'))).toBeNull();
  expect(recognize(fingerprint(), saved().replace('Bypass `WebhookDispatcher` with standalone class', 'Existing dispatcher routing is correct'))).toBeNull();
  expect(recognize(fingerprint(), saved(), '# Unrelated plan\nBuild a loading spinner.')).toBeNull();
});

test('a changed baseline cannot borrow an obsolete seeded defect', () => {
  const fp = fingerprint(seeded[1]!);
  fp.nativeCall!.questions[0]!.question = fp.nativeCall!.questions[0]!.question.replace(/^ELI10: .+$/m,
    'ELI10: This finding is resolved. The current plan uses a bound parameter and has no current SQL defect.'); reanswer(fp);
  expect(ceoPaymentFinding(fp, fixture.seed, saved(1))).toBeNull();
  expect(recognize(fingerprint(), saved().replace('Bypass `WebhookDispatcher` with standalone class', 'Register through the existing dispatcher'))).toBeNull();
});

test('ledger IDs are bound values, not literal R1/R2 labels; saved phase remains accurate', () => {
  const fp = fingerprint(); fp.nativeCall!.questions[0]!.question = fp.nativeCall!.questions[0]!.question.replaceAll('R1', 'PAYMENT-9'); reanswer(fp);
  expect(recognize(fp, saved().replaceAll('R1', 'PAYMENT-9'))?.ledgerId).toBe('PAYMENT-9');
  expect(recognize(fingerprint(), saved().replace('Step 0D. Alternatives (pending)', 'Section 1. Architecture'))?.phase).toBe('Section 1. Architecture');
});

test('duplicate native callbacks never earn credit and repeated real questions still count toward the ceiling', () => {
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => saved(), ceoFirstReviewAUQ);
  const fp = fingerprint();
  expect(counter.isReviewAUQ(fp)).toBe(true);
  expect(() => counter.isReviewAUQ(fp, [fp.nativeCall!])).toThrow(/duplicated/);
  let count = 1;
  for (let i = 1; i < 8; i++) {
    const repeated = fingerprint(); repeated.nativeCall!.toolUseId += `-${i}`; repeated.signature += `-${i}`;
    count += Number(counter.isReviewAUQ(repeated));
  }
  expect(count).toBe(8); // unchanged hard cap: above the accepted ceiling of 7
  expect(counter.trace.filter(t => 'seed' in t)).toHaveLength(8);
});

test('a later mode/setup question stays excluded and unknown extra decisions fail rather than disappear', () => {
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => saved(), ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(fingerprint())).toBe(true);
  const mode = fingerprint(); const q = mode.nativeCall!.questions[0]!;
  q.header = 'Mode'; q.question = 'D9 — Which review mode should I use?';
  q.options = ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE EXPANSION', 'SCOPE REDUCTION'].map(label => ({ label })); reanswer(mode);
  expect(counter.isReviewAUQ(mode)).toBe(false);
  const approach = fingerprint(); approach.nativeCall!.questions[0]!.header = 'Approach';
  approach.nativeCall!.questions[0]!.question = 'D10 — Which overall approach should we choose?'; reanswer(approach);
  expect(counter.isReviewAUQ(approach)).toBe(false);
  const extra = fingerprint(); extra.nativeCall!.questions[0]!.question = 'D11 — Should the project change its billing currency?'; reanswer(extra);
  expect(() => counter.isReviewAUQ(extra)).toThrow(/cannot exclude it from the 4–7 count/);
});


test('source-required ledger meanings survive reordered columns, renamed heading and different nesting', () => {
  const plan = saved().replace('## Decision ledger', '# Choices').replace('## Step 0D.', '## Initial choices: Step 0D.').replace('### R1.', '#### R1.');
  const lines = plan.split('\n').map(line => {
    if (!line.startsWith('|')) return line;
    const cells = line.split('|');
    if (cells.length !== 8) return line;
    return '|'+[cells[3],cells[1],cells[5],cells[4],cells[2],cells[6]].join('|')+'|';
  });
  expect(recognize(fingerprint(), lines.join('\n'))?.seed).toBe('dispatcher');
});

test('native labels, decision title syntax and chosen alternative are not metric protocols', () => {
  const fp = fingerprint(seeded[1]!); const q = fp.nativeCall!.questions[0]!;
  q.question = q.question.replace('D4 (ledger R2) —', 'Resolve R2:');
  q.header = 'Safe lookup'; q.options[0]!.label = 'Keep the DB interface';
  q.options[0]!.description = 'Bind the external ID as a database parameter. ' + q.options[0]!.description;
  reanswer(fp);
  expect(ceoPaymentFinding(fp, fixture.seed, saved(1))?.seed).toBe('lookup');
  fp.nativeCall!.answers = { [q.question]: q.options[1]!.label };
  expect(ceoPaymentFinding(fp, fixture.seed, saved(1))?.seed).toBe('lookup');
});

test('an operative inline Proposed field needs no separately named comparison table', () => {
  const plan = saved().slice(0,saved().indexOf('## Step 0D.')).replace('see 0D', 'Register the handler through WebhookDispatcher; preserve its class name');
  expect(recognize(fingerprint(),plan)?.seed).toBe('dispatcher');
});


test('declared onboarding subjects and option semantics survive numbering and punctuation changes', () => {
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => saved(), ceoFirstReviewAUQ);
  for (const c of fixture.captures.slice(0, 2)) {
    const fp = fingerprint(c), q = fp.nativeCall!.questions[0]!;
    q.question = q.question.replace(/^D[0-9]+ — /, 'D37: ');
    q.options = q.options.map((o, i) => ({ ...o, label: `${i + 1}. ${o.label}` })); reanswer(fp);
    expect(counter.isReviewAUQ(fp)).toBe(false);
  }
  const mode = fingerprint(), q = mode.nativeCall!.questions[0]!;
  q.header = 'Review preference'; q.question = 'Select a review posture?';
  q.options = ['SCOPE REDUCTION — narrowest deliverable', 'HOLD SCOPE (recommended)', 'SELECTIVE EXPANSION — cherry-pick', 'SCOPE EXPANSION — dream big'].map(label => ({ label })); reanswer(mode);
  expect(counter.isReviewAUQ(mode)).toBe(false);
});

test('a TODO label cannot hide an actual question, and the existing completion predicate remains the administrative owner', () => {
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => saved(4), ceoFirstReviewAUQ);
  const todo = fixture.captures.at(-1)!;
  expect(counter.isReviewAUQ(fingerprint(todo))).toBe(true);
  expect(counter.trace.at(-1)).toMatchObject({ kind: 'additional-current-decision' });
  const informational = fingerprint(todo); informational.nativeCall!.questions[0]!.options = [{label:'Read the example'}, {label:'Show the same example'}]; reanswer(informational);
  expect(() => counter.isReviewAUQ(informational)).toThrow(/cannot exclude/);
});
