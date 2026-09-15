import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fixture from './fixtures/design-count-native-8525.json';
import { isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import { nativePlanCallFingerprint, planCountQuestionPhase, designStep0Boundary, hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
const calls = () => structuredClone(fixture.transcript.calls) as NativePlanQuestionCall[];
const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, true);
function completion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-8525-replay-'));
  const file = path.join(dir, path.basename(fixture.provenance.planPath));
  const transcript = structuredClone(fixture.transcript) as PlanCountTranscript;
  const edit = fixture.provenance.operations.filter(o => o.tool === 'Edit').at(-1)!;
  const mtime = Date.parse(edit.acknowledgedAt) / 1000;
  const write = (content = fixture.report) => { fs.writeFileSync(file, content); fs.utimesSync(file, mtime, mtime); };
  write();
  // The replay starts before the first retained native assistant message.
  const startedAt = Math.min(...transcript.assistantMessages.map(m => Date.parse(m.timestamp))) - 1_000;
  const final = transcript.assistantMessages.at(-1)!;
  const check = () => hasNativePlanTerminal(transcript, file, startedAt, 'completion_summary');
  return { dir, file, transcript, final, write, check, cleanup: () => fs.rmSync(dir, {recursive:true, force:true}) };
}
test('full exact native attempt starts review at Issue 1 and counts six independently acknowledged decisions', () => {
  const input = calls(); let started = false; const counts = {step0:0,review:0,administrative:0};
  expect(isDesignCountFirstReview(fp(input[0]!))).toBe(false);
  expect(isDesignCountFirstReview(fp(input[1]!))).toBe(true);
  for (const call of input) {
    const p = planCountQuestionPhase(fp(call), started, designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
    counts[p.administrative ? 'administrative' : p.preReview ? 'step0' : 'review']++;
    started = p.reviewStarted;
  }
  expect(counts).toEqual({step0:1,review:6,administrative:0});
  expect(counts.review).toBeGreaterThanOrEqual(4); expect(counts.review).toBeLessThanOrEqual(7);
});
test('exact native final text and reconstructed read-back-verified report supply completion', () => {
  const f = completion(); try { expect(f.check()).toBe(true); } finally { f.cleanup(); }
});
const changedQuestion = (change: (c: NativePlanQuestionCall) => void) => {
  const c = calls()[1]!; change(c); const q = c.questions[0]!;
  c.answers = {[q.question]:q.options[0]!.label}; return c;
};
for (const [name, change] of Object.entries({
  'unrelated setup header': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Routing'; },
  'wrong native Issue header': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Issue 2'; },
  'wrong offered Issue ids': (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label = '2A: Filled primary Save'; },
  'multiselect': (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
  'another bundled question': (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
  'missing current source': (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('PLAN.md','other.md'); },
  'quoted current source': (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('PLAN.md','"PLAN.md"'); },
  'multiple source gaps': (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('gap G1','gap G1 and gap G2'); },
  'unowned gap in alternative': (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.description = 'Leave G2 open; the gap stays open.'; },
  'no current defect': (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('all four header buttons look identical','the header buttons have distinct approved styles'); },
  'quoted only defect': (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace(/ELI10: ([\s\S]*?)\nStakes/, 'ELI10: "$1"\nStakes'); },
  'historical assessment': (c: NativePlanQuestionCall) => { c.questions[0]!.question = c.questions[0]!.question.replace('ELI10:','ELI10: Historical example:'); },
  'withdrawn current issue': (c: NativePlanQuestionCall) => { c.questions[0]!.question += '\nThis issue is withdrawn.'; },
  'quoted withdrawn state': (c: NativePlanQuestionCall) => { c.questions[0]!.question += '\nThis issue is "withdrawn".'; },
  'no concrete offered remedy': (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = '✅ Follow the design system.'; },
  'quoted only remedy': (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.description = '"' + c.questions[0]!.options[0]!.description + '"'; },
  'no opposed open gap': (c: NativePlanQuestionCall) => { c.questions[0]!.options[2]!.description = 'The question remains available for discussion.'; },
  'quoted question': (c: NativePlanQuestionCall) => { c.questions[0]!.question = '> ' + c.questions[0]!.question.replaceAll('\n','\n> '); },
  'code example': (c: NativePlanQuestionCall) => { c.questions[0]!.question = '```text\n' + c.questions[0]!.question + '\n```'; },
})) test(`named current issue rejects ${name}`, () => expect(isDesignCountFirstReview(fp(changedQuestion(change)))).toBe(false));
test('native ownership and actual answer remain required', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered=false; },
    (c: NativePlanQuestionCall) => { c.failed=true; },
    (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices=[0]; },
    (c: NativePlanQuestionCall) => { delete c.answeredAt; },
    (c: NativePlanQuestionCall) => { c.answers={[c.questions[0]!.question]:'an unoffered recommendation'}; },
  ]) { const c=calls()[1]!; mutate(c); expect(isDesignCountFirstReview(fp(c))).toBe(false); }
  const c=calls()[1]!; expect(isDesignCountFirstReview({...fp(c),signature:'foreign:question'})).toBe(false);
});
test('the source gap and design-defect class are independent of seeded spelling or G-number', () => {
  const c=changedQuestion(c => { c.questions[0]!.question=c.questions[0]!.question.replaceAll('G1','G22').replaceAll('Save','Submit');
    c.questions[0]!.options.forEach(o=>{o.label=o.label.replaceAll('Save','Submit');o.description=o.description?.replaceAll('Save','Submit');}); });
  for (const o of c.questions[0]!.options) { c.answers={[c.questions[0]!.question]:o.label};expect(isDesignCountFirstReview(fp(c))).toBe(true); }
  const coded=changedQuestion(c=>{c.questions[0]!.question=c.questions[0]!.question.replace('PLAN.md','`PLAN.md`');});
  expect(isDesignCountFirstReview(fp(coded))).toBe(true);
  c.answered=false;delete c.answers;delete c.unansweredQuestionIndices;
  expect(pickDesignCountQuestion(fp(c),fp(c))).toBeNull(); // Existing actor/default answer ownership is unchanged.
});
test('current typed status accepts presentation, field order and current report prose independently', () => {
  const f=completion();try {
    for (const heading of ['## Completion','### Completion summary','## Review complete','## Design review complete','**Review completion:**']) {
      for (const status of ['STATUS: DONE','**STATUS:** DONE — review saved and verified.','**STATUS: DONE**']) {
        for (const fields of [
          [status,`What changed: \`${path.basename(f.file)}\` now carries the current review report.`],
          [`Report: ${f.file} contains the reviewed plan and verification.`,status],
          [status,`- Plan saved to \`${f.file}\`.`],
        ]) {f.final.text=heading+'\n\n'+fields.join('\n\n');expect(f.check(),f.final.text).toBe(true);}
      }
    }
  } finally {f.cleanup();}
});
for (const [name, change] of Object.entries({
  'blocked':(s:string)=>s.replace('DONE —','BLOCKED —'),
  'concerns':(s:string)=>s.replace('DONE —','DONE_WITH_CONCERNS —'),
  'pending':(s:string)=>s.replace('DONE —','NEEDS_CONTEXT —'),
  'conditional status':(s:string)=>s.replace('DONE —','DONE if approved —'),
  'conditional reason':(s:string)=>s.replace('completed with evidence','will be completed with evidence'),
  'quoted status':(s:string)=>s.replace('**STATUS:**','> **STATUS:**'),
  'literal status':(s:string)=>s.replace(/\*\*STATUS:\*\* (.+)/,'`STATUS: $1`'),
  'fenced status':(s:string)=>s.replace(/\*\*STATUS:\*\* (.+)/,'```text\nSTATUS: $1\n```'),
  'duplicate status':(s:string)=>s+'\nSTATUS: DONE',
  'conflicting status':(s:string)=>s+'\nSTATUS: BLOCKED',
  'historical context':(s:string)=>'Previous result:\n\n'+s,
  'copied section':(s:string)=>'Source example:\n\n'+s,
  'quoted section':(s:string)=>'> '+s.replaceAll('\n','\n> '),
  'duplicate section':(s:string)=>s+'\n## Review complete\nSTATUS: DONE',
  'unavailable report':(s:string)=>s.replace('now carries','is unavailable; would contain'),
  'proposed write':(s:string)=>s.replace('now carries','will contain'),
  'historical report':(s:string)=>s.replace('now carries','previously contained'),
  'wrong path':(s:string)=>s.replaceAll('gstack-test-plan-design.md','wrong-plan.md'),
  'ambiguous path':(s:string)=>s.replace('now carries','and `another-plan.md` now carry'),
  'different absolute directory':(s:string)=>s.replaceAll('gstack-test-plan-design.md','/elsewhere/gstack-test-plan-design.md'),
  'relative traversal':(s:string)=>s.replaceAll('gstack-test-plan-design.md','../gstack-test-plan-design.md'),
  'quoted artifact line':(s:string)=>s.replace('**What changed:**','> **What changed:**'),
  'literal artifact prose':(s:string)=>s.replace(/\*\*What changed:\*\* (.+)/,'**What changed:** "$1"'),
  'missing artifact field':(s:string)=>s.replace(/^\*\*What changed:\*\*.+\n/m,''),
  'withdrawn report':(s:string)=>s+'\nThe report is withdrawn.',
  'remaining decision':(s:string)=>s+'\nOne design decision is unresolved.',
})) test(`typed delivery rejects ${name}`, () => {const f=completion();try {f.final.text=change(f.final.text);expect(f.check()).toBe(false);}finally{f.cleanup();}});
test('typed delivery retains source session, answer chronology, fresh file and complete Design report checks', () => {
  const f=completion();try {
    const original=structuredClone(f.transcript);
    for (const change of [
      (t:PlanCountTranscript)=>{t.calls[1]!.answered=false;},
      (t:PlanCountTranscript)=>{t.calls[1]!.failed=true;},
      (t:PlanCountTranscript)=>{t.calls[1]!.sessionId='foreign';},
      (t:PlanCountTranscript)=>{t.calls[1]!.answeredAt=t.assistantMessages.at(-1)!.timestamp;},
      (t:PlanCountTranscript)=>{t.assistantMessages.at(-1)!.timestamp='2999-01-01T00:00:00Z';},
    ]) {Object.assign(f.transcript,structuredClone(original));change(f.transcript);expect(f.check()).toBe(false);}
    Object.assign(f.transcript,structuredClone(original));
    for (const body of ['# Draft',fixture.report+'\n## Implementation changes\n',fixture.report.replace('| 1 | clean |','| 1 | pending |'),fixture.report.replace('DESIGN CLEARED','NOT CLEARED'),fixture.report.replace('NO UNRESOLVED DECISIONS','**UNRESOLVED DECISIONS:**\n- Still open')]) {f.write(body);expect(f.check()).toBe(false);}
    f.write();fs.utimesSync(f.file,1,1);expect(f.check()).toBe(false);
    fs.rmSync(f.file);expect(f.check()).toBe(false);
    const alternate=path.join(f.dir,'alternate.md');fs.writeFileSync(alternate,fixture.report);fs.symlinkSync(alternate,f.file);expect(f.check()).toBe(false);
  }finally{f.cleanup();}
});
test('cancelled retry current native Issue is still classified without supplying terminal coverage', () => {
  const input=structuredClone(fixture.cancelledRetry.calls) as NativePlanQuestionCall[];
  expect(fixture.cancelledRetry.coverageCredit).toBe(0);
  expect(input).toHaveLength(2);expect(isDesignCountFirstReview(fp(input[0]!))).toBe(false);
  expect(isDesignCountFirstReview(fp(input[1]!))).toBe(true);
  const review=planCountQuestionPhase(fp(input[1]!),false,designStep0Boundary,isDesignCountFirstReview,isDesignCountSetup,isDesignCompletionHandoff);
  expect(review.preReview).toBe(false);
});
test('an unlabelled source gap still needs a current defect, concrete offered repair and its own retained violation', () => {
  const original=fixture.cancelledRetry.calls[1]! as NativePlanQuestionCall;
  for (const mutate of [
    (q:NativePlanQuestionCall['questions'][number])=>{q.question=q.question.replace('currently look identical','already have distinct correct styles');},
    (q:NativePlanQuestionCall['questions'][number])=>{q.question=q.question.replace('Pass 1 Information Architecture','planning setup');},
    (q:NativePlanQuestionCall['questions'][number])=>{q.question=q.question.replace('PLAN.md','other.md');},
    (q:NativePlanQuestionCall['questions'][number])=>{q.question=q.question.replace('ELI10:','ELI10: Historical example:');},
    (q:NativePlanQuestionCall['questions'][number])=>{q.options[0]!.description='Use the Button component as appropriate.';},
    (q:NativePlanQuestionCall['questions'][number])=>{q.options[2]!.description='This resolves the hierarchy gap completely.';},
    (q:NativePlanQuestionCall['questions'][number])=>{q.options[2]!.description='The plan keeps a documented DESIGN.md violation for G9.';},
    (q:NativePlanQuestionCall['questions'][number])=>{q.header='Setup';},
  ]) {const c=structuredClone(original);mutate(c.questions[0]!);c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};expect(isDesignCountFirstReview(fp(c))).toBe(false);}
});
