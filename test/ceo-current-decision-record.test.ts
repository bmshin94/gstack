/** Free count replay only. The original paid failures and checkpoint violations remain failures. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ } from './helpers/claude-pty-runner';
import captured from './fixtures/ceo-current-decision-cdd-public.json';
import exactFields from './fixtures/ceo-native-fields-f359.json';

type Capture = typeof captured.captures[number];
const clone = <T>(value: T): T => structuredClone(value);
const paired = captured.captures[0]!, distinct = captured.captures[1]!, retry = captured.captures[2]!;
function replay(row: Capture, plan = row.savedPlan, calls = clone(row.calls)) {
  const counter = createCeoPaymentFindingCounter(row.source, () => plan, ceoFirstReviewAUQ);
  const counted = calls.map((call, index) => counter.isReviewAUQ(nativePlanCallFingerprint(call, 1, false), calls.slice(0, index)));
  return { counted, trace: counter.trace };
}
function reject(row: Capture, plan: string, calls = clone(row.calls)) {
  expect(() => replay(row, plan, calls)).toThrow(/Unsupported|Invalid/);
}
for (const row of captured.captures) test(`${row.name}: exact public calls and saved record receive count credit, never paid PASS credit`, () => {
  expect(createHash('sha256').update(row.source).digest('hex')).toBe(row.sourceSha256);
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedSha256);
  expect(row.originalOutcome).toBe('FAIL'); expect(row.paidPassCredit).toBe(0);
  const result = replay(row);
  expect(result.counted).toEqual(row.calls.map((_, i) => i === row.calls.length - 1));
  expect(result.trace.at(-1)).toMatchObject({ kind: 'recorded-decision', ledgerId: row === paired ? 'D1' : 'R1' });
});

const pairedMarker = paired.savedPlan.match(/^\*\*(currentDecision: D1[^\n]+)\*\*$/m)![1]!;
for (const marker of [pairedMarker, `**${pairedMarker}**`, `### ${pairedMarker}`, `#### ${pairedMarker}`])
  test(`current comparison marker retains Markdown presentation ${marker.slice(0, 20)}`, () => {
    expect(replay(paired, paired.savedPlan.replace(`**${pairedMarker}**`, marker)).counted.at(-1)).toBe(true);
  });
const rowMarker = distinct.savedPlan.match(/^\*\*(Row R1[^\n]+)\*\*$/m)![1]!;
for (const marker of [rowMarker, `**${rowMarker}**`, `### ${rowMarker}`])
  test(`row marker under currentDecision retains Markdown presentation ${marker.slice(0, 14)}`, () => {
    expect(replay(distinct, distinct.savedPlan.replace(`**${rowMarker}**`, marker)).counted.at(-1)).toBe(true);
  });
for (const row of [paired, distinct]) {
  const marker = row === paired ? pairedMarker : rowMarker;
  const id = row === paired ? 'D1' : 'R1';
  for (const [name, change] of Object.entries({
    'quoted marker': (s: string) => s.replace(`**${marker}**`, `> **${marker}**`),
    'fenced marker': (s: string) => s.replace(`**${marker}**`, '```text\n'+marker+'\n```'),
    'different row marker': (s: string) => s.replace(`**${marker}**`, `**${marker.replace(id, 'R999')}**`),
    'duplicated current marker': (s: string) => s.replace(`**${marker}**`, `**${marker}**\n\n**${marker}**`),
    'withdrawn current marker': (s: string) => s.replace(`**${marker}**`, `**${marker}**\nThis decision is withdrawn.`),
    'historical comparison': (s: string) => s.replace(`**${marker}**`, `## Historical comparison\n\n**${marker}**`),
    'foreign source': (s: string) => s.replaceAll('PLAN.md', 'other/PLAN.md'),
    'missing source': (s: string) => s.replaceAll('PLAN.md', 'input'),
    'missing current row': (s: string) => s.replace(new RegExp('^\\| '+id+'(?:\\s|\\|)[^\\n]+\\n','m'), ''),
    'missing option risk': (s: string) => s.replace('Risk low.', ''),
    'invalid option risk': (s: string) => s.replace('Risk low.', 'Risk unknown.'),
    'invalid option effort': (s: string) => s.replace('Effort S ', 'Effort XS '),
    'withdrawn option': (s: string) => s.replace('Pros:', 'Pros: This option is withdrawn.'),
  })) test(`${row.name}: current paragraph rejects ${name}`, () => {
    const changed = change(row.savedPlan); expect(changed !== row.savedPlan).toBe(true); reject(row, changed);
  });
}
test('bare Row marker cannot borrow a non-currentDecision heading', () => {
  reject(distinct, distinct.savedPlan.replace('## currentDecision', '## Unrelated notes'));
});

for (const verb of ['Keep', 'Retain', 'Preserve']) for (const form of ['suffix', 'prefix', 'description']) test(`saved and offered ${verb} baseline resolve symmetrically (${form})`, () => {
  const calls = clone(retry.calls), q = calls.at(-1)!.questions[0]!;
  q.options[2]!.label = q.options[2]!.label.replace('Keep', verb);
  const caption = form === 'suffix' ? `C) ${verb} truthy only (as planned).`
    : form === 'prefix' ? `**C) As planned: ${verb} truthy only.**` : `**C) ${verb} truthy only** (as planned) —`;
  const plan = retry.savedPlan.replace('C) Keep truthy only (as planned).', caption);
  expect(replay(retry, plan, calls).counted.at(-1)).toBe(true);
});
for (const [name, caption] of Object.entries({
  'added action': 'Keep truthy only and delete records',
  'changed negation': 'Do not keep truthy only',
  'narrowed scope': 'Keep truthy only for admins',
  'different baseline': 'Keep rejection only',
})) test(`same-letter saved baseline rejects ${name}`, () => {
  reject(retry, retry.savedPlan.replace('C) Keep truthy only (as planned).', `C) ${caption} (as planned).`));
});

// Exercise the existing strict exact-native-fields path with the new marker
// presentations. This is distinct from the older complete-prose count path.
const q = exactFields.call.questions[0]!;
const begin = exactFields.savedPlan.indexOf('### currentDecision (D1)');
const end = exactFields.savedPlan.indexOf('## NOT in scope', begin);
const fields = ['Question: '+q.question, 'Header: '+q.header,
  ...q.options.map(o => o.label+'\n'+o.description)].join('\n\n');
function exactPlan(marker: string, body = fields) {
  return exactFields.savedPlan.slice(0, begin)+marker+'\n\n'+body+'\n\n'+exactFields.savedPlan.slice(end);
}
function exactCount(plan: string, call = clone(exactFields.call)) {
  return createCeoPaymentFindingCounter(exactFields.seed, () => plan, ceoFirstReviewAUQ)
    .isReviewAUQ(nativePlanCallFingerprint(call, 1, false));
}
for (const marker of ['**Row D1 — current question**', '**currentDecision (D1)**']) {
  const heading = '### currentDecision (D1)';
  test(`one exact record retains its heading plus immediate paragraph marker ${marker}`, () => {
    expect(exactCount(exactPlan(heading+'\n\n'+marker))).toBe(true);
  });
  test(`same-row heading continuation cannot hide a second full record ${marker}`, () => {
    expect(() => exactCount(exactPlan(heading+'\n\n'+marker, fields+'\n\n'+heading+'\n\n'+marker+'\n\n'+fields))).toThrow(/Unsupported/);
  });
  test(`same-row heading continuation cannot hide a later paragraph record ${marker}`, () => {
    expect(() => exactCount(exactPlan(heading+'\n\n'+marker, fields+'\n\n'+marker+'\n\n'+fields))).toThrow(/Unsupported/);
  });
}
for (const marker of ['### currentDecision (D1)', '**currentDecision (D1)**', 'currentDecision (D1)']) {
  test(`full native fields count with ${marker}`, () => expect(exactCount(exactPlan(marker))).toBe(true));
  for (const [name, change] of Object.entries({
    'missing Question': (s: string) => s.replace('Question: '+q.question, ''),
    'mismatched Header': (s: string) => s.replace('Header: '+q.header, 'Header: Another decision'),
    'missing option description': (s: string) => s.replace(q.options[0]!.description!, ''),
    'invalid effort domain': (s: string) => s.replace('Effort S', 'Effort XS'),
    'invalid risk domain': (s: string) => s.replace(/Risk (?:low|medium|high)/i, 'Risk unknown'),
  })) test(`${marker}: strict native fields reject ${name}`, () => {
    expect(() => exactCount(exactPlan(marker, change(fields)))).toThrow(/Unsupported/);
  });
}
for (const row of captured.captures) for (const defect of ['missing ACK', 'failed ACK', 'unoffered answer', 'foreign identity'])
  test(`${row.name}: paragraph normalization retains ${defect} rejection`, () => {
    const calls = clone(row.calls), call = calls.at(-1)!;
    if (defect === 'missing ACK') call.answered = false;
    if (defect === 'failed ACK') call.failed = true;
    if (defect === 'unoffered answer') call.answers = { [call.questions[0]!.question]: 'Not offered' };
    if (defect === 'foreign identity') call.sessionId = '';
    reject(row, row.savedPlan, calls);
  });

test('distinct retry retains its actual preceding D2 count and rejects D3 without an owned ledger row', () => {
  const row = captured.rejectedMissingRow;
  expect(row.originalOutcome).toBe('FAIL'); expect(row.paidPassCredit).toBe(0);
  expect(createHash('sha256').update(row.source).digest('hex')).toBe(row.sourceSha256);
  row.plans.forEach((plan, i) => {
    expect(createHash('sha256').update(plan).digest('hex')).toBe(row.planSha256[i]);
    expect(Date.parse(row.snapshotTimes[i]!)).toBeLessThan(Date.parse(row.questionTimes[i]!));
  });
  let plan = row.plans[0]!;
  const counter = createCeoPaymentFindingCounter(row.source, () => plan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.calls[0]!), 1, false))).toBe(false);
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.calls[1]!), 1, false), row.calls.slice(0, 1))).toBe(true);
  plan = row.plans[1]!;
  expect(plan).toContain('### currentDecision (D3, owner Section 2)');
  expect(/^\| D3\b/m.test(plan)).toBe(false);
  expect(() => counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.calls[2]!), 1, false), row.calls.slice(0, 2))).toThrow(/Unsupported/);
  expect(counter.trace).toHaveLength(2);
});

test('the actual CEO save layout preserves the full native payload and separates prior records', () => {
  const template = readFileSync(`${import.meta.dir}/../plan-ceo-review/SKILL.md.tmpl`, 'utf8');
  const layout = template.match(/```text\n(   ## currentDecision \(ROW-ID\)[\s\S]+?)\n   ```/);
  expect(layout).not.toBeNull();
  const grid = exactFields.savedPlan.slice(begin, end).match(/```text\n[\s\S]+?\n```/);
  expect(grid).not.toBeNull();
  // Fill the actual source example with the existing captured native fields;
  // do not reconstruct a more permissive format or promote its original FAIL.
  const record = layout![1]!.replace(/^   /gm, '')
    .replace('ROW-ID', 'D1').replace('<complete grid>', '\n\n'+grid![0])
    .replace('<entire currentDecision.question, including every brief paragraph>', q.question)
    .replace('<exact currentDecision.header>', q.header)
    .replace('A) <exact first option label; add a selector only if absent>', q.options[0]!.label)
    .replace('<full first option description>', q.options[0]!.description!)
    .replace('B) <exact second option label; add a selector only if absent>', q.options[1]!.label)
    .replace('<full second option description; include C when offered>',
      q.options[1]!.description!+'\n'+q.options[2]!.label+'\n'+q.options[2]!.description!);
  const saved = (section: string) => exactFields.savedPlan.slice(0, begin)+section+'\n\n'+exactFields.savedPlan.slice(end);
  expect(exactCount(saved(record))).toBe(true);
  const prior = '## Answered decision D0\nExact approval: prior answer A, scope unchanged.\n'+fields.replaceAll('D1', 'D0');
  expect(exactCount(saved(prior+'\n\n'+record))).toBe(true);
  for (const changed of [
    record.replace(q.question, q.question.split('\n')[0]!),
    record.replace(q.question.split('\n')[0]!, q.question.split('\n')[0]!+' (changed title)'),
    record.replace('Header: '+q.header, 'Header: Another decision'),
    record.replace(q.options[0]!.label, 'A) Delete every test'),
    record+'\n\n'+fields.replaceAll('D1', 'D0'),
    record+'\n\n'+record,
    '```text\n'+record+'\n```',
    record.replace('Question: ', 'Question:\n'),
    record.replace('Header: '+q.header, 'Header: '+q.header+'\nOptions:'),
  ]) {
    expect(changed).not.toBe(record);
    expect(() => exactCount(saved(changed))).toThrow(/Unsupported/);
  }
});
