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

import currentFixture from './fixtures/ceo-recorded-decisions-dacc95ea.json';

const currentFp = (row = currentFixture.cases[1]!) =>
  nativePlanCallFingerprint(clone(row.call) as any, Date.parse(row.call.answeredAt), true);
const countCurrent = (question = currentFp(), plan = currentFixture.cases[1]!.savedPlan, seed = currentFixture.cases[1]!.seed) =>
  createCeoPaymentFindingCounter(seed, () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);

for (const row of currentFixture.cases) test(`captured dacc95ea ${row.name} counts its owned saved decision`, () => {
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedPlanSha256);
  expect(Date.parse(row.successfulPriorMutations.at(-1)!.completedAt)).toBeLessThan(Date.parse(row.questionIssuedAt));
  expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt));
  expect(countCurrent(currentFp(row), row.savedPlan, row.seed)).toBe(true);
});


const pairedCurrent = currentFixture.cases[1]!;
const optionsStart = pairedCurrent.savedPlan.indexOf('- **A)');
const beforeOptions = pairedCurrent.savedPlan.slice(0, optionsStart);
const optionBody = pairedCurrent.savedPlan.slice(optionsStart, pairedCurrent.savedPlan.indexOf('\nRecommendation:', optionsStart));
const afterOptions = pairedCurrent.savedPlan.slice(pairedCurrent.savedPlan.indexOf('\nRecommendation:', optionsStart));
const replaceOptions = (body: string) => beforeOptions + body + afterOptions;
const sourceLine = pairedCurrent.savedPlan.split('\n').find(line => line.startsWith('Working plan for'))!;
const currentOptions = optionBody.split(/\n(?=- \*\*[A-C]\))/);

for (const [name, plan] of Object.entries({
  'standalone source metadata': pairedCurrent.savedPlan.replace(sourceLine, 'Source plan: PLAN.md.'),
  'source-plan label in current metadata': pairedCurrent.savedPlan.replace('Source: `PLAN.md`', 'Source plan: `PLAN.md`'),
  'review-target source metadata': pairedCurrent.savedPlan.replace('Source: `PLAN.md`', 'Plan under review: `PLAN.md`'),
  'source section citations': pairedCurrent.savedPlan.replaceAll('plan §', 'plan section '),
  'paragraph alternatives': replaceOptions(currentOptions.map(block => block.replace(/^- /, '')).join('\n\n')),
  'plain list labels': replaceOptions(optionBody.replaceAll('**', '')),
  'named effort and risk fields': replaceOptions(optionBody.replaceAll('Effort S', 'Effort estimate: S').replaceAll('Risk low', 'Risk level: low').replaceAll('Risk high', 'Risk level: high')),
  'risk before effort': replaceOptions(optionBody.replace('Effort S (~6 lines).\n  Risk low.', 'Risk low. Effort S (~6 lines).')),
  'line-separated typed facts': replaceOptions(optionBody.replace(/\.\s+(?=Effort|Risk|Pros:|Cons:)/g, '\n  ')),
  'semicolon-separated typed facts': replaceOptions(optionBody.replace(/\.\s+(?=Effort|Risk|Pros:|Cons:)/g, '; ')),
})) test(`owned prose comparison accepts ${name}`, () => expect(countCurrent(currentFp(), plan)).toBe(true));

for (const [name, plan] of Object.entries({
  'source missing': pairedCurrent.savedPlan.replace(sourceLine, 'Working plan; source unavailable.'),
  'foreign source': pairedCurrent.savedPlan.replace('Source: `PLAN.md`', 'Source: `OTHER.md`'),
  'source in unrelated prose': pairedCurrent.savedPlan.replace(sourceLine, 'An unrelated example elsewhere mentions PLAN.md.'),
  'quoted source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '> ' + sourceLine),
  'fenced source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '```md\n' + sourceLine + '\n```'),
  'literal source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '"' + sourceLine + '"'),
  'historical source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '## Historical metadata\n\n' + sourceLine + '\n\n## Current review'),
  'contradictory source records': pairedCurrent.savedPlan + '\n\nSource plan: OTHER.md.\n',
  'row has no source citation': pairedCurrent.savedPlan.replaceAll('(plan §Existing behavior)', '(unsupported)').replaceAll('(plan §Infrastructure)', '(unsupported)'),
  'row cites a foreign source': pairedCurrent.savedPlan.replaceAll('plan §', 'OTHER.md §'),
  'wrong row identity': pairedCurrent.savedPlan.replaceAll('D1', 'DIFFERENT'),
  'inactive row status': pairedCurrent.savedPlan.replaceAll('| unresolved |', '| historical |'),
  'unchanged current/proposed values': pairedCurrent.savedPlan.replace('Assert full receipt equality; optionally assert single charge call with `{amountCents:1000, currency:"USD"}` and zero sleeper records.', 'Assert receipt is truthy only.'),
  'withdrawn proposed remedy': pairedCurrent.savedPlan.replace('Assert full receipt equality;', 'This decision is withdrawn. Assert full receipt equality;'),
  'quoted ledger': pairedCurrent.savedPlan.split('\n').map(line => '> ' + line).join('\n'),
  'fenced ledger': '```md\n' + pairedCurrent.savedPlan + '\n```',
  'duplicate ledger': pairedCurrent.savedPlan + '\n' + pairedCurrent.savedPlan,
  'comparison under history': pairedCurrent.savedPlan.replace('### D1 — options comparison', '## Historical review\n\n### D1 — options comparison'),
  'historical comparison heading': pairedCurrent.savedPlan.replace('### D1 — options comparison', '### Historical D1 — options comparison'),
  'foreign comparison heading': pairedCurrent.savedPlan.replace('### D1 — options comparison', '### D9 — options comparison'),
  'fenced alternatives': replaceOptions('```md\n' + optionBody + '\n```\n'),
  'quoted alternatives': replaceOptions(optionBody.split('\n').map(line => '> ' + line).join('\n')),
  'literal alternatives': replaceOptions(currentOptions.map(block => '"' + block.replace(/^- /, '') + '"').join('\n\n')),
  'missing effort': replaceOptions(optionBody.replace('Effort S (~6 lines)', 'Work S (~6 lines)')),
  'missing risk': replaceOptions(optionBody.replace('Risk low.', 'Unassessed.')),
  'missing pros': replaceOptions(optionBody.replace('Pros: catches', 'Notes: catches')),
  'missing cons': replaceOptions(optionBody.replace('Cons: couples', 'Notes: couples')),
  'quoted effort value': replaceOptions(optionBody.replace('Effort S (~6 lines)', 'Effort "S (~6 lines)"')),
  'missing alternative': replaceOptions(currentOptions.slice(1).join('\n')),
  'duplicate alternative': replaceOptions(optionBody + '\n' + currentOptions[0]),
  'foreign option label': replaceOptions(optionBody.replace('**B) Receipt fields only**', '**D) Change the deployment region**')),
  'withdrawn comparison': replaceOptions(optionBody.replace('Pros: catches', 'This decision is withdrawn. Pros: catches')),
})) test(`owned prose comparison rejects ${name}`, () => expect(() => countCurrent(currentFp(), plan)).toThrow());

for (const [name, mutate] of Object.entries({
  'unanswered native call': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.answered = false; },
  'failed native call': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.failed = true; },
  'foreign native identity': (q: ReturnType<typeof currentFp>) => { q.signature = 'foreign:call'; },
  'unoffered native answer': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.answers = { [q.nativeCall!.questions[0]!.question]: 'Recommendation A' }; },
  'quoted native question': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.questions[0]!.question = '> ' + q.nativeCall!.questions[0]!.question.replaceAll('\n', '\n> '); reanswer(q); },
  'ID only in historical recap': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.questions[0]!.question = 'How should we continue?\n> Earlier D1 was discussed.'; reanswer(q); },
})) test(`owned prose comparison rejects ${name}`, () => { const question = currentFp(); mutate(question); expect(() => countCurrent(question)).toThrow(); });

test('prose decision count is not approval and does not bypass duplicate native ownership', () => {
  const question = currentFp(), before = pairedCurrent.savedPlan;
  const counter = createCeoPaymentFindingCounter(pairedCurrent.seed, () => before, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(question)).toBe(true);
  expect(counter.trace).toEqual([{ signature: question.signature, kind: 'recorded-decision', ledgerId: 'D1', phase: 'D1 — options comparison (Test 1: successful charge)' }]);
  expect(pairedCurrent.savedPlan).toBe(before);
  expect(before).toContain('| unresolved |');
  expect(() => counter.isReviewAUQ(question, [question.nativeCall!])).toThrow('duplicated');
});

test('fourth actual native decision has an ACK but receives no credit without its saved record', () => {
  const row = currentFixture.unreconstructedCalls[0]!;
  expect(row.limitation).toContain('saved plan at question time was not retained');
  expect(row.call.answered).toBe(true);
  expect(row.call.failed).toBe(false);
  const question = nativePlanCallFingerprint(clone(row.call) as any, Date.parse(row.call.answeredAt), true);
  expect(() => countCurrent(question, currentFixture.cases[0]!.seed, currentFixture.cases[0]!.seed)).toThrow(/cannot exclude/);
});

import fixture6714 from './fixtures/ceo-recorded-decisions-67147822.json';
for (const row of fixture6714.cases) test(`captured6714 ${row.label} preserves the owned saved comparison`, () => {
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedPlanSha256);
  expect(createHash('sha256').update(row.seed).digest('hex')).toBe(row.seedSha256);
  expect(Date.parse(row.successfulPriorMutations.filter(m => m.filePath?.endsWith(row.label.startsWith('paired') ? 'gstack-test-plan-ceo-paired.md' : 'gstack-test-plan-ceo.md')).at(-1)!.completedAt)).toBeLessThan(Date.parse(row.questionIssuedAt));
  expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt!));
  const question = nativePlanCallFingerprint(clone(row.call) as any, 0, true);
  const counter = createCeoPaymentFindingCounter(row.seed, () => row.savedPlan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(question)).toBe(true);
  expect(counter.trace.at(-1)).toMatchObject({ kind: 'recorded-decision' });
});

const grid6714 = fixture6714.cases.find(row => row.label === 'paired')!;
const prose6714 = fixture6714.cases.find(row => row.label === 'five')!;
const retry6714 = fixture6714.cases.find(row => row.label === 'paired-retry')!;
const question6714 = (row = grid6714) => nativePlanCallFingerprint(clone(row.call) as any, 0, true);
const count6714 = (plan: string, question = question6714(), row = grid6714) => {
  const counter = createCeoPaymentFindingCounter(row.seed, () => plan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(question)).toBe(true);
  expect(counter.trace.at(-1)).toMatchObject({ kind: 'recorded-decision' });
};
const gridStart6714 = grid6714.savedPlan.indexOf('### R1 option comparison');
const gridEnd6714 = grid6714.savedPlan.indexOf('### R2', gridStart6714);
const gridBody6714 = grid6714.savedPlan.slice(gridStart6714, gridEnd6714);
const replaceGrid6714 = (body: string) => grid6714.savedPlan.slice(0, gridStart6714) + body + grid6714.savedPlan.slice(gridEnd6714);

for (const [name, body] of Object.entries({
  'unbordered GFM rows': gridBody6714.replace(/^\|(.*)\|$/gm, '$1'),
  'reordered source/current/option columns': gridBody6714.split('\n').map(line => line.startsWith('|')
    ? '| ' + [5, 2, 0, 4, 1, 3].map(i => line.split('|').slice(1, -1)[i]!.trim()).join(' | ') + ' |' : line).join('\n'),
  'separate current completeness paragraph': gridBody6714.replace('\nCompleteness:', '\n\nCompleteness:'),
})) test(`owned commitment matrix accepts ${name}`, () => count6714(replaceGrid6714(body)));

for (const [name, plan] of Object.entries({
  'review target metadata': grid6714.savedPlan.replace('Reviewed plan:', 'Review target plan:'),
  'input plan metadata': grid6714.savedPlan.replace('Reviewed plan:', 'Input plan:'),
  'historical sibling does not own current review': '## Historical notes\n\nOld unrelated material.\n\n## Current review\n\n' + grid6714.savedPlan,
})) test(`owned commitment matrix accepts ${name}`, () => count6714(plan));

for (const [name, body] of Object.entries({
  'missing native alternative column': gridBody6714.split('\n').map(line => line.startsWith('|') ? line.split('|').slice(0, -2).join('|') + '|' : line).join('\n'),
  'duplicate alternative identity': gridBody6714.replace('B: chargeId only', 'A: chargeId only'),
  'wrong native alternative identity': gridBody6714.replace('B: chargeId only', 'D: chargeId only'),
  'swapped option meanings': gridBody6714.replace('A: exact receipt equality | B: chargeId only', 'A: chargeId only | B: exact receipt equality'),
  'missing behavior value': gridBody6714.replace('C1 | no | yes | no | no', 'C1 | no | yes | | no'),
  'missing commitment source': gridBody6714.replace('C1 | no | yes | yes | no', ' | no | yes | yes | no'),
  'missing current behavior': gridBody6714.replace('C1 | no | yes | yes | no', 'C1 | | yes | yes | no'),
  'missing effort and risk row': gridBody6714.replace(/^\| Effort \/ risk.*\n/m, ''),
  'missing one effort/risk value': gridBody6714.replace('S / low | S / low | S / low', 'S / low | | S / low'),
  'untyped effort/risk value': gridBody6714.replace('S / low | S / low | S / low', 'small / maybe | S / low | S / low'),
  'duplicate effort/risk row': gridBody6714.replace('| Effort / risk', '| Effort / risk | | | S / low | S / low | S / low |\n| Effort / risk'),
  'withdrawn inline footer': gridBody6714.replace('Completeness:', 'This decision is withdrawn. Completeness:'),
  'historical comparison': gridBody6714.replace('### R1', '### Historical R1'),
  'historical ancestor': '## Historical review\n\n' + gridBody6714,
  'nested historical matrix': gridBody6714.replace('### R1 option comparison', '### R1 option comparison\n\n#### Historical example'),
  'foreign comparison owner': gridBody6714.replace('### R1', '### DIFFERENT'),
  'quoted comparison': gridBody6714.split('\n').map(line => '> ' + line).join('\n'),
  'fenced comparison': '```md\n' + gridBody6714 + '\n```\n',
})) test(`owned commitment matrix rejects ${name}`, () => expect(() => count6714(replaceGrid6714(body))).toThrow());

for (const [name, plan] of Object.entries({
  'foreign source metadata': grid6714.savedPlan.replace('Reviewed plan: `PLAN.md`', 'Reviewed plan: `OTHER.md`'),
  'contradictory current source': grid6714.savedPlan + '\n\nInput plan: OTHER.md.\n',
  'unrelated mention of source': grid6714.savedPlan.replace('Reviewed plan: `PLAN.md`', 'An unrelated example reviewed `PLAN.md`'),
  'quoted source metadata': grid6714.savedPlan.replace('Reviewed plan:', '> Reviewed plan:'),
  'duplicate current ledger': grid6714.savedPlan + '\n\n' + grid6714.savedPlan,
})) test(`owned commitment matrix rejects ${name}`, () => expect(() => count6714(plan)).toThrow());

for (const [name, mutate] of Object.entries({
  'extra native action': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.label += ' and delete customer records'; },
  'native action reversal': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'A) Do not assert exact receipt equality'; },
  'missing native pros': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '❌ Incomplete coverage.'; },
  'missing native cons': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '✅ Complete coverage.'; },
  'quoted native facts': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '> ✅ Earlier benefit\n> ❌ Earlier tradeoff'; },
  'fenced native facts': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '```md\n✅ Earlier benefit\n❌ Earlier tradeoff\n```'; },
})) test(`owned commitment matrix rejects ${name}`, () => {
  const question = question6714(); mutate(question); reanswer(question);
  expect(() => count6714(grid6714.savedPlan, question)).toThrow();
});

for (const [name, mutate] of Object.entries({
  'unlettered action reversal': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'Do not register in WebhookDispatcher'; },
  'unlettered action appended': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[2]!.label += ' and delete customer records'; },
  'unlettered internal scope qualifier': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'Register only in WebhookDispatcher'; },
  'unlettered words borrowed only from cons': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'Register in WebhookDispatcher dependency coupling'; },
})) test(`owned prose comparison rejects ${name}`, () => {
  const question = question6714(prose6714); mutate(question); reanswer(question);
  expect(() => count6714(prose6714.savedPlan, question, prose6714)).toThrow();
});

for (const [name, plan] of Object.entries({
  'comma-separated fields still require risk': prose6714.savedPlan.replace('risk low.', 'exposure low.'),
  'comma-separated fields still require pros': prose6714.savedPlan.replace('Pros: one routing path', 'Benefits: one routing path'),
  'saved caption reverses unlettered action': prose6714.savedPlan.replace('**A) Register in WebhookDispatcher.**', '**A) Register not in WebhookDispatcher.**'),
  'plain colon list still requires cons': retry6714.savedPlan.replace('Cons: fails if', 'Notes: fails if'),
})) test(`owned format variants reject ${name}`, () => {
  const row = name.startsWith('plain') ? retry6714 : prose6714;
  expect(plan).not.toBe(row.savedPlan);
  expect(() => count6714(plan, question6714(row), row)).toThrow();
});

for (const caption of ['Register in WebhookDispatcher and delete backups.', 'Register in WebhookDispatcher only for admins.'])
  test('unlettered saved caption cannot add scope: ' + caption, () => {
    const plan = prose6714.savedPlan.replace('Register in WebhookDispatcher.', caption);
    expect(plan).not.toBe(prose6714.savedPlan);
    expect(() => count6714(plan, question6714(prose6714), prose6714)).toThrow();
  });
