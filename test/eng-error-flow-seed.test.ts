import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-69193-count-public.json';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { evaluateEngSeedCoverage, isEngSeedDecisionAUQ } from './helpers/eng-seeded-coverage';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';

const original = fixture.calls.find(c=>c.questions[0]!.header === 'D5 error flow') as NativePlanQuestionCall;
const startedAt = Date.parse(fixture.windowStart), finishedAt = Date.parse(fixture.windowEnd);
const check = (call = structuredClone(original)) => evaluateEngSeedCoverage(
  { status: 'ready', calls: [call], assistantMessages: [] }, '', startedAt, finishedAt);
const classify = (call = structuredClone(original)) => isEngSeedDecisionAUQ(
  nativePlanCallFingerprint(call, 1, false), [], startedAt, finishedAt);
const regressionCalls = () => structuredClone(fixture.calls) as NativePlanQuestionCall[];
const regression = (plan = fixture.report, calls = regressionCalls()) => evaluateEngSeedCoverage(
  { status: 'ready', calls, assistantMessages: [] }, plan, startedAt, finishedAt).regression;

test('the current native-approved matrix captures legacy first and separately asserts its two approved deltas', () => {
  expect(regression()).toBe('plan');
});

function recordEdit(plan: string, id: string, edit: (text: string) => string) {
  const sections = plan.split(/(?=^#{1,6} )/m), selected = sections.filter(s => s.startsWith(`### ${id}:`));
  expect(selected).toHaveLength(1);
  const before = selected[0]!, after = edit(before); expect(after).not.toBe(before);
  return sections.map(s => s === before ? after : s).join('');
}
const scopeEdit = (id: string, edit: (text: string) => string, plan = fixture.report) => recordEdit(plan, id,
  text => text.replace(/^Accepted scope: (.+)$/m, (_line, scope: string) => 'Accepted scope: '+edit(scope)));

for (const [name, edit] of [
  ['missing baseline', (s: string) => s.replace(/\(1\) [^]*?(?=\(2\))/, '')],
  ['baseline after rewrite', (s: string) => s.replace('BEFORE any rewrite', 'AFTER the rewrite')],
  ['reversed baseline and replay', (s: string) => s.replace('(1)', '(later)').replace('(2)', '(1)').replace('(later)', '(2)')],
  ['new-path baseline', (s: string) => s.replace('against the existing `legacyAuthFlow()`', 'against `AuthBroker.validateAndDispatch()`')],
  ['missing replay', (s: string) => s.replace(/\(2\) [^]*?(?=\(3\))/, '')],
  ['different replay matrix', (s: string) => s.replace('The identical matrix run', 'A different matrix run')],
  ['foreign replay implementation', (s: string) => s.replace('`AuthBroker.validateAndDispatch()`', '`AnotherBroker.validateAndDispatch()`')],
  ['missing matrix axis', (s: string) => s.replace('wrong audience; ', '')],
  ['IDP failures not per call', (s: string) => s.replace('for each of the 5 calls', 'for one selected call')],
  ['one of five IDP calls', (s: string) => s.replace('for each of the 5 calls', 'for each of the 1 calls')],
  ['four of five IDP calls', (s: string) => s.replace('for each of the 5 calls', 'for each of the 4 calls')],
  ['missing IDP 5xx failures', (s: string) => s.replace('timeout and 5xx', 'timeout')],
  ['missing cache assertions', (s: string) => s.replace('cache read/write effect, and ', '')],
  ['wrong prior error decision', (s: string) => s.replace('(D5)', '(D19)')],
  ['wrong prior cache decision', (s: string) => s.replace('(D4)', '(D19)')],
  ['missing prior delta', (s: string) => s.replace('; stale write dropped after invalidation (D4)', '')],
  ['extra unapproved delta', (s: string) => s.replace('(D4).', '(D4); permit unknown tenants (D19).')],
  ['broader error delta', (s: string) => s.replace('explicit deny + reason code where legacy swallowed', 'deny every formerly valid request')],
  ['broader cache delta', (s: string) => s.replace('stale write dropped after invalidation', 'all cache writes dropped')],
  ['missing flag requirement', (s: string) => s.replace('Cutover behind a feature flag', 'Cutover immediately')],
  ['cutover before capture', (s: string) => s.replace('(1)', '(later)').replace('(5)', '(1)').replace('(later)', '(5)')],
  ['cutover before replay', (s: string) => s.replace('(2)', '(later)').replace('(5)', '(2)').replace('(later)', '(5)')],
  ['missing selected E2E', (s: string) => s.replace(/\(4\) [^]*?(?=\(5\))/, '')],
  ['missing selected E2E flow', (s: string) => s.replace('; IDP revocation → next request denied', '')],
  ['E2E before deltas', (s: string) => s.replace('(3)', '(later)').replace('(4)', '(3)').replace('(later)', '(4)')],
] as const) test(`matrix contract rejects ${name}`, () => {
  expect(regression(scopeEdit('R6', edit))).toBeUndefined();
});

for (const id of ['R4','R5','R6']) test(`matrix contract binds ${id} to its complete approved native selection`, () => {
  for (const edit of [
    (s: string) => s.replace('State: approved', 'State: pending'),
    (s: string) => s.replace(/^Actual answer: .+\n/m, ''),
    (s: string) => s.replace(/^Actual answer: A/m, 'Actual answer: B'),
    (s: string) => s.replace('PLAN.md:', 'OTHER.md:'),
    (s: string) => s.replace(/^Header: (.+)$/m, 'Header: $1 changed'),
    (s: string) => s.replace(/^Accepted scope: (.+)$/m, '$& This requirement is withdrawn.'),
  ]) expect(regression(recordEdit(fixture.report,id,edit))).toBeUndefined();
  const decision = id === 'R4' ? 'D4' : id === 'R5' ? 'D5' : 'D6';
  for (const edit of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description += ' New behavior.'; },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(finishedAt+1).toISOString(); },
  ]) {
    const calls = regressionCalls(), call = calls.find(c=>c.questions[0]!.header.startsWith(decision+' '))!;
    edit(call); expect(regression(fixture.report,calls)).toBeUndefined();
  }
  const calls = regressionCalls(), call = calls.find(c=>c.questions[0]!.header.startsWith(decision+' '))!;
  expect(regression(fixture.report,calls.filter(c=>c!==call))).toBeUndefined();
});

test('both supporting approvals must precede the regression selection', () => {
  for (const decision of ['D4','D5']) {
    const calls = regressionCalls(); calls.find(c=>c.questions[0]!.header.startsWith(decision+' '))!.answeredAt =
      calls.find(c=>c.questions[0]!.header.startsWith('D6 '))!.answeredAt;
    expect(regression(fixture.report,calls)).toBeUndefined();
  }
});

for (const edit of [
  (s: string) => s.replace('P1 CRITICAL', 'P1 non-CRITICAL'),
  (s: string) => s.replace('P1 CRITICAL', 'P1'),
]) test('a noncritical R6 cannot fill mandatory regression coverage', () => {
  expect(regression(recordEdit(fixture.report,'R6',edit))).toBeUndefined();
});

for (const [name, edit] of [
  ['missing task', (s: string) => s.replace(/^- \[ \] \*\*T4 [^]*?(?=^- \[ \] \*\*T5)/m, '')],
  ['baseline runs after rewrite', (s: string) => s.replace('BEFORE any rewrite', 'AFTER the rewrite')],
  ['missing replay', (s: string) => s.replace('then run the matrix against `AuthBroker`', 'stop after recording legacy')],
  ['different replay', (s: string) => s.replace('then run the matrix', 'then run another matrix')],
  ['missing green baseline', (s: string) => s.replace('suite green against legacy first', 'suite runs on the new path')],
  ['wrong outcome equality', (s: string) => s.replace('identical outcomes against `AuthBroker`', 'unverified outcomes against `AuthBroker`')],
  ['wrong delta inventory', (s: string) => s.replace('intended-delta assertions for D4/D5', 'intended-delta assertions for D4/D19')],
  ['wrong delta count', (s: string) => s.replace('except the two asserted deltas', 'except three asserted deltas')],
  ['wrong shared file', (s: string) => s.replace('tests/auth/legacyAuthFlow.characterization.test.ts', 'tests/auth/different.test.ts')],
] as const) test(`ordered task rejects ${name}`, () => {
  const parts = fixture.report.split(/(?=^#{1,6} )/m);
  const old = parts.find(s=>s.startsWith('## Implementation Tasks\n'))!, changed = edit(old);
  expect(changed).not.toBe(old);
  expect(regression(parts.map(s=>s===old?changed:s).join(''))).toBeUndefined();
});

for (const status of ['R4 is withdrawn.','D5 is "superseded".','R6 is cancelled.','T4 is optional.',
  'legacyAuthFlow() is modified before T4.']) test(`current cancellation rejects ${status}`, () => {
  expect(regression(fixture.report+'\n## Current assessment\n'+status)).toBeUndefined();
  expect(regression(fixture.report+'\n## Current assessment\nPrior note: "'+status.replaceAll('"',"'")+'"')).toBe('plan');
});

test('selector captions and scope numbering are representations of the same owned decisions', () => {
  const captioned = regressionCalls().filter(c=>/^D[456] /.test(c.questions[0]!.header)).reduce((plan,c)=>recordEdit(plan,'R'+c.questions[0]!.header.match(/^D(\d+)/)![1],
    s=>s.replace(/^Actual answer: A \((D\d+) answer, this session\)$/m,
      (_line,id)=>`Actual answer: A — "${c.questions[0]!.options[0]!.label}" (${id} answer)`)), fixture.report);
  expect(regression(captioned)).toBe('plan');
  expect(regression(scopeEdit('R6',s=>s.replace(/\(([1-5])\) /g,'Step $1: ')))).toBe('plan');
});

test('current approved deltas reject contradictions but retain historical comparison and dotted identifiers', () => {
  for (const [id, change] of [
    ['R4', (s: string) => s + ' Correction: stale writes are accepted after invalidation.'],
    ['R4', (s: string) => s.replace('captures the generation before the write', 'captures the generation after the write')],
    ['R4', (s: string) => s.replace(') if it advanced.', '). An unrelated guard checks if it advanced.')],
    ['R5', (s: string) => s + ' Correction: dispatch also runs when an error is denied.'],
    ['R5', (s: string) => s + ' Correction: this remedy is fail-open on unknown errors.'],
    ['R5', (s: string) => s.replace('unknown/unexpected error → deny', 'unknown/unexpected error → allow')],
  ] as const) expect(regression(scopeEdit(id,change))).toBeUndefined();
  for (const identifier of ['audit.trace.stale_write','metrics/auth.cache.counter']) {
    expect(regression(scopeEdit('R4',s=>s.replace('auth_cache.put_dropped_stale',identifier)))).toBe('plan');
  }
  for (const id of ['R4','R5','R6']) {
    // Text after the record's History field stays historical, not a current
    // cancellation. Current cancellation controls modify Accepted scope above.
    expect(regression(recordEdit(fixture.report,id,s=>s+'\nThis requirement is withdrawn.\n'))).toBe('plan');
  }
});

test('exact public neutral error-flow question establishes only the swallowed-error seed', () => {
  expect(classify()).toBe(true);
  expect(check().decisions).toEqual({ 'swallowed-errors': `${original.sessionId}:${original.toolUseId}` });
  expect(check().ok).toBe(false);
  expect(check().regression).toBeUndefined();
});

function editQuestion(call: NativePlanQuestionCall, edit: (text: string) => string) {
  const q = call.questions[0]!, answer = call.answers![q.question]!;
  const changed = edit(q.question);
  expect(changed).not.toBe(q.question);
  q.question = changed;
  call.answers = { [changed]: answer };
}

for (const [name, edit] of [
  ['different neutral title', (s: string) => s.replace(/^D5 — [^\n]+/, 'D42 — Which error policy should validateAndDispatch() use?')],
  ['unquoted structural description', (s: string) => s.replace('three nested "try this, and if it blows up, ignore it" blocks, each ignoring a different kind of failure', '3 nested catch blocks. Every block discards its error')],
  ['different quoted metaphor supplies no evidence', (s: string) => s.replace('"try this, and if it blows up, ignore it"', '"nested boxes"')],
  ['current evidence survives unrelated quoted history', (s: string) => s + '\nPrior note: "This finding is withdrawn."'],
  ['inline identifiers and bold headings', (s: string) => s.replaceAll('validateAndDispatch()', '`validateAndDispatch()`').replace('ELI10:', '**ELI10:**').replace('Project/branch/task:', '**Project/branch/task:**')],
] as const) test(name, () => {
  const call = structuredClone(original); editQuestion(call, edit);
  expect(classify(call)).toBe(true);
});

test('native descriptions do not need duplicate tradeoff bullets, and any offered answer still completes the decision', () => {
  for (const choice of original.questions[0]!.options) {
    const call = structuredClone(original), q = call.questions[0]!;
    q.options.reverse(); call.answers = { [q.question]: choice.label };
    expect(classify(call)).toBe(true);
  }
});

for (const [name, edit] of [
  ['foreign plan', (s: string) => s.replace('PLAN.md', 'OTHER.md')],
  ['foreign same basename', (s: string) => s.replace('PLAN.md', 'archive/PLAN.md')],
  ['missing plan ownership', (s: string) => s.replace('(PLAN.md)', '(the current proposal)')],
  ['foreign explanation', (s: string) => s.replace('The function that decides', 'Another function that decides')],
  ['unrelated title', (s: string) => s.replace(/^D5 — [^\n]+/, 'D5 — Which report format should we use?')],
  ['missing explanation', (s: string) => s.replace(/^ELI10: .+\n/m, '')],
  ['quoted explanation', (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: `$1`')],
  ['blockquoted explanation', (s: string) => s.replace(/^ELI10:/m, '> ELI10:')],
  ['historical explanation', (s: string) => s.replace(/^ELI10:/m, 'ELI10: Historical example:')],
  ['withdrawn finding', (s: string) => s + '\nThis finding is withdrawn.'],
  ['quoted current status', (s: string) => s + '\nThis finding is "not current".'],
  ['resolved finding', (s: string) => s + '\nThis finding is fixed.'],
  ['already surfaced errors', (s: string) => s + '\nCorrection: validateAndDispatch() now rethrows every error.'],
  ['no nested defect', (s: string) => s.replace('three nested "try this, and if it blows up, ignore it" blocks', 'one shallow block')],
  ['blocks rethrow instead of discarding', (s: string) => s.replace('each ignoring a different kind of failure', 'each rethrowing every failure')],
  ['discard fact exists only in quotation', (s: string) => s.replace('each ignoring a different kind of failure', '"each ignoring a different kind of failure"')],
  ['conditional current ownership', (s: string) => s + '\nThis finding applies only if approved.'],
] as const) test(name, () => {
  const call = structuredClone(original); editQuestion(call, edit);
  expect(classify(call)).toBe(false);
  expect(check(call).missing).toContain('swallowed-errors');
});

for (const [name, edit] of [
  ['no-op remedy', (s: string) => 'Keep validateAndDispatch() as written; no error-handling change.'],
  ['quoted native remedy', (s: string) => '`'+s+'`'],
  ['historical native remedy', (s: string) => 'Historical example: '+s],
  ['foreign native function', (s: string) => s.replace('validateAndDispatch()', 'anotherFunction()')],
  ['missing typed outcomes', (s: string) => s.replace('a typed `AuthError` subclass', 'an unclassified value')],
  ['missing deny mapping', (s: string) => s.replace('explicit deny', 'an unspecified response')],
  ['missing reason', (s: string) => s.replace('reason code + ', '')],
  ['missing log', (s: string) => s.replace('structured log + ', '')],
  ['partial step policy', (s: string) => s.replace('Each step throws', 'Only some steps throw')],
  ['partial handler policy', (s: string) => s.replace('maps class', 'maps only some classes')],
  ['dispatch reachable on failure', (s: string) => s.replace('Dispatch only reachable on the success path.', 'Dispatch also reachable on the failure path.')],
  ['current no-log correction', (s: string) => s + '\nCorrection: Do not log denials.'],
  ['current partial-error correction', (s: string) => s + '\nCorrection: Only some errors are surfaced.'],
  ['current fail-open correction', (s: string) => s + '\nCorrection: This remedy remains fail-open on unknown errors.'],
  ['current swallowed-error correction', (s: string) => s + '\nCorrection: Dispatch errors remain swallowed.'],
  ['dispatch contradicts deny boundary', (s: string) => s + '\nCorrection: Dispatch also runs when an error is denied.'],
  ['dispatch remains reachable after failure', (s: string) => s + '\nCorrection: Dispatch remains reachable after a validation failure.'],
  ['current withdrawn remedy', (s: string) => s + '\nThis option is withdrawn.'],
] as const) test(name, () => {
  const call = structuredClone(original), q = call.questions[0]!;
  const old = q.options[0]!.description!;
  q.options[0]!.description = edit(old); expect(q.options[0]!.description).not.toBe(old);
  // The displayed brief remains deliberately intact: it must not replace a
  // missing or contradictory contract in the actual native option fields.
  expect(classify(call)).toBe(false);
});

test('a complete remedy cannot be assembled across options', () => {
  const call = structuredClone(original), q = call.questions[0]!;
  q.options[0]!.description = q.options[0]!.description!.replace('reason code + structured log + ', '');
  q.options[1]!.description += ' Every deny includes reason code + structured log.';
  expect(classify(call)).toBe(false);
});

test('native completion and prior-call ownership still gate the recognized seed', () => {
  for (const edit of [
    (c: NativePlanQuestionCall) => { c.answered = false; },
    (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answers = {}; },
    (c: NativePlanQuestionCall) => { c.sessionId = ''; },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(startedAt-1).toISOString(); },
    (c: NativePlanQuestionCall) => { c.answeredAt = new Date(finishedAt+1).toISOString(); },
  ]) {
    const call = structuredClone(original); edit(call); expect(classify(call)).toBe(false);
  }
  const fingerprint = nativePlanCallFingerprint(original, 1, false);
  expect(isEngSeedDecisionAUQ(fingerprint, [original], startedAt, finishedAt)).toBe(false);
  expect(isEngSeedDecisionAUQ({ ...fingerprint, signature: 'foreign' }, [], startedAt, finishedAt)).toBe(false);
});
