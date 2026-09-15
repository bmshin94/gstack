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


import phaseEntry77 from './fixtures/design-phase-entry-77.json';
function phaseCalls77() { return structuredClone(phaseEntry77.calls) as NativePlanQuestionCall[]; }
function phaseSequence77(calls = phaseCalls77()) {
  let started = false;
  return calls.map(call => {
    const f = nativePlanCallFingerprint(call, 0, !started);
    const phase = planCountQuestionPhase(f, started, designStep0Boundary,
      isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
    started = phase.reviewStarted;
    return { id: call.toolUseId, ...phase };
  });
}
function phaseMutation77(index: number, mutate: (call: NativePlanQuestionCall) => void) {
  const call = phaseCalls77()[index]!; const before = call.questions[0]!.question;
  const answer = call.answers![before]!; mutate(call);
  if (call.questions[0]!.question !== before) call.answers = {[call.questions[0]!.question]: answer};
  return nativePlanCallFingerprint(call, 0, true);
}

test('actual77 focus ACK opens review, later learnings stays setup, all six real findings count', () => {
  const phases = phaseSequence77();
  expect(phases.slice(0, 3).map(p => p.preReview)).toEqual([true, true, true]);
  expect(phases[1]!.reviewStarted).toBe(true);
  expect(phases.slice(3).map(p => p.preReview)).toEqual([false, false, false, false, false, false]);
  expect(phases.filter(p => !p.preReview)).toHaveLength(6);
  const calls = phaseCalls77();
  // These remain setup decisions, never substituted for a substantive finding.
  expect(isDesignCountFirstReview(nativePlanCallFingerprint(calls[1]!, 0, true))).toBe(false);
  expect(isDesignCountSetup(nativePlanCallFingerprint(calls[2]!, 0, false))).toBe(true);
});

test('native focus and learnings classification follows scope actions, not recommendation or order', () => {
  for (const index of [1,2]) for (const reversed of [false,true]) for (const picked of [0,1]) {
    const call = phaseCalls77()[index]!; const q=call.questions[0]!;
    q.options.forEach(o => { o.label=o.label.replace(/\s*\(recommended\)/i,''); });
    q.options[picked]!.label += ' (recommended)';
    if(reversed)q.options.reverse();
    call.answers = {[q.question]:q.options[picked]!.label};
    const f=nativePlanCallFingerprint(call,0,true);
    expect(designStep0Boundary(f)).toBe(true);
    expect(isDesignCountSetup(f)).toBe(true);
  }
});

test('equivalent all-seven versus subset focus wording stays a plan-wide setup choice', () => {
  for(const title of ['Review all 7 design dimensions, or focus on specific areas?', 'Review all 7 dimensions or focus on a subset?', 'Review all 7 design passes, or focus?']) {
    const f=phaseMutation77(1,c=>{c.questions[0]!.question=c.questions[0]!.question.replace(/^D2[^\n]+/,'D21: '+title);});
    expect(designStep0Boundary(f)).toBe(true); expect(isDesignCountSetup(f)).toBe(true);
  }
});

for (const [name, mutate] of Object.entries({
  'pending': (c: NativePlanQuestionCall) => { c.answered=false; },
  'failed': (c: NativePlanQuestionCall) => { c.failed=true; },
  'missing answer time': (c: NativePlanQuestionCall) => { delete c.answeredAt; },
  'missing session': (c: NativePlanQuestionCall) => { c.sessionId=''; },
  'missing call ID': (c: NativePlanQuestionCall) => { c.toolUseId=''; },
  'partial': (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices=[0]; },
  'unoffered answer': (c: NativePlanQuestionCall) => { c.answers={[c.questions[0]!.question]:'Unrelated answer'}; },
  'checkbox': (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect=true; },
  'mixed packet': (c: NativePlanQuestionCall) => { c.questions.push({header:'Issue',question:'Approve a new layout?',options:[{label:'Approve'},{label:'Defer'}],multiSelect:false}); },
  'foreign source': (c: NativePlanQuestionCall) => { c.questions[0]!.question=c.questions[0]!.question.replace('of PLAN.md','of OTHER.md'); },
  'historical source': (c: NativePlanQuestionCall) => { c.questions[0]!.question=c.questions[0]!.question.replace('Project/branch/task:','Project/branch/task: Historical source:'); },
  'quoted question': (c: NativePlanQuestionCall) => { c.questions[0]!.question='> '+c.questions[0]!.question; },
  'additional approval': (c: NativePlanQuestionCall) => { c.questions[0]!.question+='\nApprove all findings?'; },
  'extra option': (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({label:'Approve deployment'}); },
  'extra option action': (c: NativePlanQuestionCall) => { c.questions[0]!.options[0]!.label+=' and approve the plan'; c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label}; },
})) for(const index of [1,2])test(`native ${index===1?'focus':'learnings'} does not classify ${name} as setup`,()=>{
  const f=phaseMutation77(index,mutate);
  expect(designStep0Boundary(f)).toBe(false); expect(isDesignCountSetup(f)).toBe(false);
});

test('narrow-only, duplicated scope, quoted rating and component rating do not open review',()=>{
  for(const mutate of [
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.label='Only the 2 listed gaps';},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.label='All 7 dimensions';},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.question=c.questions[0]!.question.replace("ELI10: I've rated this plan", "ELI10: Earlier: I've rated this plan");},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.question=c.questions[0]!.question.replace("rated this plan", "rated this error message");},
  ]) { const f=phaseMutation77(1,mutate);expect(designStep0Boundary(f)).toBe(false);expect(isDesignCountSetup(f)).toBe(false); }
  const f=nativePlanCallFingerprint(phaseCalls77()[1]!,0,true);
  for(const changed of [{...f,signature:'foreign:tool'},{...f,nativeQuestionIndex:1},{...f,options:[...f.options].reverse()}]) {
    expect(designStep0Boundary(changed)).toBe(false);expect(isDesignCountSetup(changed)).toBe(false);
  }
});

for (const suffix of ['Also approve deployment.', 'Approve all findings.', 'Continue the review and deploy to production.', 'Review while deleting the API.'])
  for (const location of ['question', 'option'] as const) for (const index of [1, 2])
    test(`native setup rejects mixed current action in ${location}: ${suffix} (${index})`, () => {
      const f = phaseMutation77(index, c => {
        if (location === 'question') c.questions[0]!.question += '\n' + suffix;
        else c.questions[0]!.options[0]!.description += ' ' + suffix;
      });
      expect(designStep0Boundary(f)).toBe(false); expect(isDesignCountSetup(f)).toBe(false);
    });
for (const index of [1, 2]) test(`native setup rejects contradictory duplicate source (${index})`, () => {
  const f = phaseMutation77(index, c => { c.questions[0]!.question += '\nProject/branch/task: plan-design-review of OTHER.md.'; });
  expect(designStep0Boundary(f)).toBe(false); expect(isDesignCountSetup(f)).toBe(false);
});
for (const index of [1, 2]) test(`native setup allows quoted examples and negative consequences without approving them (${index})`, () => {
  const f = phaseMutation77(index, c => {
    c.questions[0]!.question += '\nExample of a later finding: "Approve deployment." This scope choice does not approve that action.';
    c.questions[0]!.options[0]!.description += ' ❌ This does not approve deployment. Example: “Approve all findings.”';
  });
  expect(designStep0Boundary(f)).toBe(true); expect(isDesignCountSetup(f)).toBe(true);
});

for (const index of [1, 2]) for (const suffix of ['Also approve the design system.', 'Implement the first dimension.'])
  test(`native setup rejection cannot fall through to a legacy boundary (${index}): ${suffix}`, () => {
    const f = phaseMutation77(index, c => { c.questions[0]!.question += '\n' + suffix; });
    expect(designStep0Boundary(f)).toBe(false); expect(isDesignCountSetup(f)).toBe(false);
  });
