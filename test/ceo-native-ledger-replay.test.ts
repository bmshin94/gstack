import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/ceo-native-ledger-8525.json';
import { ceoPaymentFinding, createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ, ceoStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';

const clone = <T>(v: T): T => structuredClone(v);
const five = fixture.groups.find(g => g.name === 'five-retry')!;
const paired = fixture.groups.find(g => g.name === 'paired-first')!;
const record = five.calls.at(-1)!;
const fp = (row = record) => nativePlanCallFingerprint(clone(row.call), 1, true);
const recognize = (question = fp(), plan = record.savedPlan, seed = five.seed) => ceoPaymentFinding(question, seed, plan);
const reanswer = (question: ReturnType<typeof fp>) => {
  const q = question.nativeCall!.questions[0]!;
  question.nativeCall!.answers = { [q.question]: q.options[0]!.label };
  question.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
};

test('public capture lineage has a successful exact-path save before each remedy question and its actual ACK', () => {
  for (const group of [five, paired]) for (const row of group.calls.filter(c => c.savedPlan)) {
    const save = row.successfulPriorMutations.at(-1)!;
    expect(Date.parse(save.completedAt)).toBeLessThan(Date.parse(row.questionIssuedAt));
    expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt!));
    expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(save.savedPlanSha256);
    expect(save.path).toMatch(/gstack-test-plan-ceo(?:-paired)?\.md$/);
    expect(row.call.answered).toBe(true);
    expect(row.call.failed).toBe(false);
  }
});

for (const [name, expected] of [['five-first', 0], ['five-retry', 1], ['paired-first', 2], ['paired-second', 3]] as const) {
  test(`actual ${name} public calls count remedies independently and never read a missing plan for onboarding`, () => {
    const group = fixture.groups.find(g => g.name === name)!;
    let plan = '', count = 0, reads = 0, boundary = false;
    const counter = createCeoPaymentFindingCounter(group.seed, () => {
      reads += 1;
      if (!plan) throw new Error('working plan does not exist yet');
      return plan;
    }, ceoFirstReviewAUQ);
    const prior: typeof group.calls[number]['call'][] = [];
    for (const row of group.calls) {
      plan = row.savedPlan;
      const question = fp(row);
      const phase = planCountQuestionPhase(question, boundary, ceoStep0Boundary, ceoFirstReviewAUQ);
      count += Number(counter.isReviewAUQ(question, prior));
      boundary = phase.reviewStarted;
      prior.push(row.call);
    }
    expect(count).toBe(expected);
    expect(reads).toBe(expected);
    expect(boundary).toBe(false); // fixture metric does not advance the shared review phase
    expect(counter.trace.filter(t => 'seed' in t).map(t => 'seed' in t && t.seed)).toEqual(
      name === 'five-retry' ? ['dispatcher'] : []);
    if (name.startsWith('paired')) expect(counter.trace.filter(t => 'kind' in t && t.kind === 'recorded-decision'))
      .toHaveLength(expected);
  });
}

test('a correct existing dispatcher baseline does not erase its defective pending alternative', () => {
  expect(record.savedPlan).toContain('Prior library-adapter handler, dispatched through `WebhookDispatcher`.');
  expect(recognize()).toMatchObject({ seed: 'dispatcher', ledgerId: 'R1' });
  const renamed = fp(); renamed.nativeCall!.questions[0]!.question = renamed.nativeCall!.questions[0]!.question.replaceAll('R1', 'PAYMENT-19'); reanswer(renamed);
  expect(recognize(renamed, record.savedPlan.replaceAll('R1', 'PAYMENT-19'))).toMatchObject({ seed: 'dispatcher', ledgerId: 'PAYMENT-19' });
});

for (const [name, mutation] of Object.entries({
  'resolved proposal': (plan: string) => plan.replace('Bypass the dispatcher with a standalone class (plan) vs register the new app-owned class with the existing dispatcher. Options compared below.', 'Register the app-owned class with the existing dispatcher. This decision is resolved.'),
  'approved baseline with no pending defect': (plan: string) => plan.replace('| unresolved |', '| approved |'),
  'deferred proposal': (plan: string) => plan.replace('| unresolved |', '| deferred |'),
  'quoted ledger': (plan: string) => plan.split('\n').map(l => '> ' + l).join('\n'),
  'code-only ledger': (plan: string) => '```md\n' + plan + '\n```',
  'foreign row identity': (plan: string) => plan.replaceAll('R1', 'OTHER'),
  'unrelated source evidence': (plan: string) => plan.replaceAll('PLAN.md', 'elsewhere.md'),
  'duplicate row evidence': (plan: string) => plan + '\n' + plan,
})) test(`pending-proposal route rejects ${name}`, () => expect(recognize(fp(), mutation(record.savedPlan))).toBeNull());

for (const [name, mutation] of Object.entries({
  'missing answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.answered = false; q.nativeCall!.answers = {}; },
  'failed call': (q: ReturnType<typeof fp>) => { q.nativeCall!.failed = true; },
  'foreign owner': (q: ReturnType<typeof fp>) => { q.signature = 'another:call'; },
  'recommendation without offered answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.answers = { [q.nativeCall!.questions[0]!.question]: 'Recommendation: A' }; },
  'quoted question': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = q.nativeCall!.questions[0]!.question.split('\n').map(l => '> ' + l).join('\n'); reanswer(q); },
  'no current defect': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = q.nativeCall!.questions[0]!.question.replace(/^ELI10: .+$/m, 'ELI10: This finding is resolved. There is no current defect.'); reanswer(q); },
})) test(`native evidence rejects ${name}`, () => { const q = fp(); mutation(q); expect(recognize(q)).toBeNull(); });

test('learnings recognition delegates to shared setup semantics without accepting a component remedy or arbitrary menu', () => {
  const learnings = fixture.groups[0]!.calls.at(-1)!;
  const counter = createCeoPaymentFindingCounter(five.seed, () => { throw new Error('plan read'); }, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(fp(learnings))).toBe(false);
  for (const mutate of [
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.header = 'Security issue'; },
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.options[1]!.label = 'Discuss later'; },
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = 'D2 — Enable the new storage feature?'; },
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = '> ' + q.nativeCall!.questions[0]!.question.replaceAll('\n', '\n> '); },
  ]) {
    const q = fp(learnings); mutate(q); reanswer(q);
    expect(() => counter.isReviewAUQ(q)).toThrow('plan read');
  }
});

test('paired remedies require their own saved row and verification contract, not bare identifiers', () => {
  for (const row of paired.calls.slice(1)) {
    const q = fp(row);
    const counter = (plan: string) => createCeoPaymentFindingCounter(paired.seed, () => plan, ceoFirstReviewAUQ);
    expect(counter(row.savedPlan).isReviewAUQ(q)).toBe(true);
    expect(() => counter(paired.seed).isReviewAUQ(q)).toThrow(/cannot exclude/);
    q.nativeCall!.questions[0]!.options = [{label:'chargeId amountCents currency retries backoff'}, {label:'Other'}]; reanswer(q);
    expect(() => counter(row.savedPlan).isReviewAUQ(q)).toThrow(/cannot exclude/);
  }
});

for (const [name, mutate] of Object.entries({
  'missing document source': (plan: string) => plan.replace(/^Source plan:.*$/m, ''),
  'foreign document source': (plan: string) => plan.replace(/^Source plan: PLAN\.md/m, 'Source plan: unrelated.md'),
  'quoted document source': (plan: string) => plan.replace(/^Source plan:(.*)$/m, '> Source plan:$1'),
  'code-only document source': (plan: string) => plan.replace(/^Source plan:(.*)$/m, '\n```text\nSource plan:$1\n```\n'),
  'row lacking its own evidence reference': (plan: string) => plan.replaceAll('Evidence: plan text; factory/sleeper not in checkout.', 'No evidence available.'),
})) test(`paired source inheritance rejects ${name}`, () => {
  const row = paired.calls[2]!;
  const counter = createCeoPaymentFindingCounter(paired.seed, () => mutate(row.savedPlan), ceoFirstReviewAUQ);
  expect(() => counter.isReviewAUQ(fp(row))).toThrow(/cannot exclude/);
});

test('a packet that batches both paired findings earns no single-question substitute credit', () => {
  const q = fp(paired.calls[1]!);
  q.nativeCall!.questions.push(clone(paired.calls[2]!.call.questions[0]!));
  q.nativeCall!.answers = Object.assign({}, paired.calls[1]!.call.answers, paired.calls[2]!.call.answers);
  expect(ceoPaymentFinding(q, paired.seed, paired.calls[2]!.savedPlan)).toBeNull();
});

test('unknown decisions still fail closed and repeated owned remedies count toward the unchanged ceiling', () => {
  const counter = createCeoPaymentFindingCounter(five.seed, () => record.savedPlan, ceoFirstReviewAUQ);
  let count = 0;
  for (let i = 0; i < 8; i++) {
    const q = fp(); q.nativeCall!.toolUseId += `-${i}`; q.signature += `-${i}`;
    count += Number(counter.isReviewAUQ(q));
  }
  expect(count).toBe(8);
  const unknown = fp(); unknown.nativeCall!.questions[0]!.question = 'D5 — Should we change billing currency?'; reanswer(unknown);
  expect(() => counter.isReviewAUQ(unknown)).toThrow(/cannot exclude/);
});


const pairedRetry = fixture.groups.find(g => g.name === 'paired-second')!;
const addedDecision = pairedRetry.calls.at(-1)!;
const genericCounter = (plan = addedDecision.savedPlan) => createCeoPaymentFindingCounter(pairedRetry.seed, () => plan, ceoFirstReviewAUQ);

test('paired retry preserves all five original calls and labels missing saved-plan evidence as synthetic', () => {
  expect(pairedRetry.calls).toHaveLength(5);
  expect(pairedRetry.syntheticSavedPlans).toBe(true);
  expect(pairedRetry.limitations).toContain('do not prove original saved bytes or mutation timestamps');
  for (const row of pairedRetry.calls) {
    expect(row.call.answered).toBe(true);
    expect(row.call.failed).toBe(false);
    expect(row.successfulPriorMutations).toEqual([]);
    if (row.savedPlan) expect(row.savedPlan).toContain('not the original saved artifact');
  }
  const counter = genericCounter();
  expect(counter.isReviewAUQ(fp(addedDecision))).toBe(true);
  expect(counter.trace).toEqual([{ signature: fp(addedDecision).signature, kind: 'recorded-decision', ledgerId: 'R3', phase: 'R3 options' }]);
});

for (const [name, mutate] of Object.entries({
  'no saved decision record': (_plan: string) => pairedRetry.seed,
  'wrong ledger identity': (plan: string) => plan.replaceAll('R3', 'UNOWNED'),
  'wrong evidence source': (plan: string) => plan.replaceAll('PLAN.md', 'another-project.md'),
  'source named only in unrelated body': (plan: string) => plan.replace('Payment test review; source PLAN.md.', 'No evidence available.'),
  'unchanged proposal': (plan: string) => plan.replace('Also assert Stripe mock call history length === 1 in test 1', 'Test 1 asserts receipt only (R1)'),
  'withdrawn proposal': (plan: string) => plan.replace('Also assert Stripe mock call history length === 1 in test 1', 'This decision is withdrawn. Also assert Stripe mock call history length === 1 in test 1'),
  'inactive status': (plan: string) => plan.replace('| unresolved |', '| historical |'),
  'blockquote ledger': (plan: string) => plan.split('\n').map(line => '> ' + line).join('\n'),
  'code ledger': (plan: string) => '```markdown\n' + plan + '\n```',
  'comparison belongs to another row': (plan: string) => plan.replace('### R3 options', '### R2 options'),
  'historical comparison': (plan: string) => plan.replace('### R3 options', '### Historical R3 options'),
  'missing comparison': (plan: string) => plan.split('### R3 options')[0]!,
  'incomplete comparison': (plan: string) => plan.replace('| S | medium |', '|  | medium |'),
  'missing risk column': (plan: string) => plan.replace('| Risk |', '| Notes |'),
  'duplicate current row': (plan: string) => plan + '\n' + plan,
})) test(`generic saved-decision route rejects ${name}`, () => {
  expect(() => genericCounter(mutate(addedDecision.savedPlan)).isReviewAUQ(fp(addedDecision))).toThrow(/cannot exclude/);
});

for (const [name, mutate] of Object.entries({
  'unowned call': (q: ReturnType<typeof fp>) => { q.signature = 'other-session:other-tool'; },
  'pending answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.answered = false; q.nativeCall!.answers = {}; },
  'failed answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.failed = true; },
  'recommendation only': (q: ReturnType<typeof fp>) => { q.nativeCall!.answers = { [q.nativeCall!.questions[0]!.question]: 'Recommendation: A' }; },
  'ID only in quoted recap': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = 'D3 — Should we alter the setup?\n> Earlier R3: single-attempt assertion'; reanswer(q); },
  'quoted current question': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = '> ' + q.nativeCall!.questions[0]!.question.replaceAll('\n', '\n> '); reanswer(q); },
  'unrelated menu with matching letters': (q: ReturnType<typeof fp>) => {
    q.nativeCall!.questions[0]!.question = 'D3 — R3: Which project theme should we use?';
    q.nativeCall!.questions[0]!.options = [{ label: 'A) Indigo palette', description: 'Use indigo.' }, { label: 'B) Orange palette', description: 'Use orange.' }]; reanswer(q);
  },
})) test(`generic saved-decision ownership rejects ${name}`, () => {
  const q = fp(addedDecision); mutate(q);
  expect(() => genericCounter().isReviewAUQ(q)).toThrow();
});

test('known onboarding and scope menus cannot borrow a saved decision row for finding credit', () => {
  for (const row of pairedRetry.calls.slice(0, 2)) {
    const counter = genericCounter();
    expect(counter.isReviewAUQ(fp(row))).toBe(false);
    expect(counter.trace).toEqual([{ signature: fp(row).signature, kind: 'setup' }]);
  }
  const q = fp(addedDecision);
  q.nativeCall!.questions[0]!.question = 'D3 — R3: Select review mode';
  q.nativeCall!.questions[0]!.options = ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'].map(label => ({ label })); reanswer(q);
  expect(genericCounter().isReviewAUQ(q)).toBe(false);
});
