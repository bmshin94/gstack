import {expect, test} from 'bun:test';
import captured from './fixtures/eng-native-seed-contract-6f.json';
import goldenDeclaration from './fixtures/eng-legacy-declaration-90f.json';
import idpChoice from './fixtures/eng-idp-choice-90f.json';
import {evaluateEngSeedCoverage, isEngSeedDecisionAUQ} from './helpers/eng-seeded-coverage';
import structureChoice from './fixtures/eng-structure-choice-90f.json';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {nativePlanCallFingerprint, assertReviewReportAtBottom, classifyPlanCountFrame, hasNativePlanTerminal, isQuestionlessNativePlanExit} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall, PlanCountTranscript} from './helpers/plan-count-transcript';

const transcript=()=>structuredClone(captured.transcript) as PlanCountTranscript;
const evaluate=(calls=transcript().calls, plan=captured.report)=>evaluateEngSeedCoverage(
  {...transcript(),calls,assistantMessages:[]},plan,captured.startedAt,captured.finishedAt);
const seeds=[[4,'complexity'],[5,'shared-cache'],[7,'swallowed-errors'],[9,'sequential-idp']] as const;

test('current counted alternatives own a complexity reduction without borrowing the preceding fold',()=>{
  const call=structuredClone(structureChoice.calls[1]) as NativePlanQuestionCall;
  const result=evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,Date.parse(structureChoice.captureAt));
  expect(result.decisions).toEqual({complexity:`${call.sessionId}:${call.toolUseId}`});
});

const structureCall=()=>structuredClone(structureChoice.calls[1]) as NativePlanQuestionCall;
const structureResult=(call=structureCall())=>evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,Date.parse(structureChoice.captureAt));
const alterStructure=(edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const call=structureCall();edit(call.questions[0]!);
  call.answers={[call.questions[0]!.question]:call.questions[0]!.options[0]!.label};return call;
};
for(const [name,edit] of Object.entries({
  'renamed title':(q:any)=>{q.question=q.question.replace('Which class/module arrangement for the remaining new units?','Which structure should the remaining components use?');},
  'classes instead of units':(q:any)=>{q.options.forEach((o:any)=>{o.label=o.label.replace(' units:',' classes:');});},
  'reordered inventory':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache and RequestPolicy','RequestPolicy, AuthCache, AuthBroker and SessionMint');},
  'reordered choices':(q:any)=>{q.options.reverse();},
  'word counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 units:','Three components:');q.options[1].label=q.options[1].label.replace('4 units:','Four components:');},
  'quoted old withdrawal':(q:any)=>{q.question+='\nEarlier note: "D6 is reopened."';},
  'prior fold omitted':(q:any)=>{q.question=q.question.replace('after D4 (strangler) and D5 (TokenStore folded), ','').replace('drops the new-unit count from 5 to 3','drops the remaining class count from 4 to 3');},
}))test('current structure comparison accepts '+name,()=>expect(structureResult(alterStructure(edit)).decisions.complexity).toBeDefined());
for(const [name,edit] of Object.entries({
  'foreign plan':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  'foreign plan directory':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'quoted current source':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'historical source':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'missing current inventory':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache and RequestPolicy','the previous classes');},
  'foreign current component':(q:any)=>{q.question=q.question.replace('AuthCache and RequestPolicy','OtherCache and RequestPolicy');},
  'duplicated current component':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, AuthCache and RequestPolicy','AuthBroker, SessionMint, AuthBroker and RequestPolicy');},
  'no current lifecycle defect':(q:any)=>{q.question=q.question.replace('so a class adds ceremony without adding safety','so either approach is equally necessary');},
  'independent current lifecycle':(q:any)=>{q.question+='\nCorrection: RequestPolicy now requires an independent lifecycle.';},
  'missing baseline option':(q:any)=>{q.options[1].label='Discuss the arrangement';},
  'reversed option counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 units:','4 units:');q.options[1].label=q.options[1].label.replace('4 units:','3 units:');},
  'equal option counts':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 units:','4 units:');},
  'duplicate reduced inventory':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthBroker, SessionMint, AuthCache','AuthBroker, SessionMint, AuthBroker');},
  'foreign reduced component':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache','OtherCache');},
  'unrelated removed component':(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthBroker, SessionMint, AuthCache','RequestPolicy, SessionMint, AuthCache');},
  'pure function borrowed from other option':(q:any)=>{q.options[1].description+=' Pure function.';q.options[0].description=q.options[0].description.replace('pure function','method');},
  'pure function borrowed from question':(q:any)=>{q.question+='\nNet: use a pure function.';q.options[0].description=q.options[0].description.replace('pure function','method');},
  'quoted reduced remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
  'negated conversion':(q:any)=>{q.options[0].description+='\nDo not convert RequestPolicy.';},
  'retained lifecycle':(q:any)=>{q.options[0].description+='\nRequestPolicy still retains its lifecycle.';},
  'retained class':(q:any)=>{q.options[0].description+='\nRequestPolicy is still a class.';},
  'mutable result':(q:any)=>{q.options[0].description+='\nThe result is not an immutable type.';},
  'deferred remedy':(q:any)=>{q.options[0].description+='\nThis remedy is deferred.';},
  'quoted deferred remedy':(q:any)=>{q.options[0].description+='\nThis remedy is "deferred".';},
  'reopened decision':(q:any)=>{q.question+='\nD6 is reopened.';},
  'quoted reopened decision':(q:any)=>{q.question+='\nD6 is "reopened".';},
  'withdrawn decision':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
  'conditional decision':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
}))test('current structure comparison rejects '+name,()=>expect(structureResult(alterStructure(edit)).decisions).toEqual({}));
test('structure decision needs its own current native completion and stable guard identity',()=>{
  const call=structureCall(),finished=Date.parse(structureChoice.captureAt);
  const guard=(c=call,prior:NativePlanQuestionCall[]=[])=>isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),prior,0,finished);
  expect(guard()).toBe(true);
  expect(guard(call,[structuredClone(structureChoice.calls[0]) as NativePlanQuestionCall])).toBe(true);
  expect(guard(call,[call])).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.answeredAt=new Date(finished+1).toISOString();}]){
    const invalid=structureCall();edit(invalid);expect(guard(invalid)).toBe(false);expect(structureResult(invalid).decisions).toEqual({});
  }
  const alien=structuredClone(structureChoice.calls[0]) as NativePlanQuestionCall;alien.sessionId+='-foreign';expect(guard(call,[alien])).toBe(false);
  const both=structureCall();both.questions.push(transcript().calls[5]!.questions[0]!);both.answers={...both.answers,...transcript().calls[5]!.answers};
  expect(guard(both)).toBe(false);expect(structureResult(both).decisions).toEqual({});
});
const idpCall=()=>structuredClone(idpChoice.call) as NativePlanQuestionCall;
const idpResult=(call=idpCall())=>evaluateEngSeedCoverage({status:'ready',calls:[call],assistantMessages:[]},'',0,Date.parse(idpChoice.captureAt));
const alterIdp=(edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const call=idpCall();edit(call.questions[0]!);
  call.answers={[call.questions[0]!.question]:call.questions[0]!.options[0]!.label};return call;
};
test('IDP choice owns its current sequential defect and concurrent bounded remedy',()=>{
  const call=idpCall();expect(idpResult(call).decisions).toEqual({'sequential-idp':`${call.sessionId}:${call.toolUseId}`});
});
for(const [name,edit] of Object.entries({
  'numeric count':(q:any)=>{q.question=q.question.replaceAll('five','5');},
  'current ordering vocabulary':(q:any)=>{q.question=q.question.replace('Today the five checks run one after another','Currently the five calls run sequentially');},
  'plain Promise.all with same timeout':(q:any)=>{q.options[0].label=q.options[0].label.replace('Promise.allSettled','Promise.all');},
  'reordered choices':(q:any)=>{q.options.reverse();},
  'timeout in same description':(q:any)=>{q.options[0].description+=' Every call has a per-call timeout of 2000 ms.';q.options[0].label=q.options[0].label.replace(' + per-call timeout (default 2000 ms)','');},
  'quoted earlier cancellation':(q:any)=>{q.question+='\nEarlier note: "D13 is deferred."';},
  'planned future concurrency':(q:any)=>{q.question+='\nUnder the proposed option, the five IDP calls run concurrently.';},
  'parallel scheduling title':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel');},
}))test('IDP choice accepts '+name,()=>expect(idpResult(alterIdp(edit)).decisions['sequential-idp']).toBeDefined());
for(const [name,edit] of Object.entries({
  'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  'foreign source directory':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'quoted source':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'historical source':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'quoted current defect':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'unrelated title':(q:any)=>{q.question=q.question.replace('How should the five IDP validation calls be issued concurrently?','Which monitoring dashboard should we use?');},
  'dependent source calls':(q:any)=>{q.question=q.question.replace('five independent IDP calls','five dependent IDP calls');},
  'missing current ordering':(q:any)=>{q.question=q.question.replace('Today the five checks run one after another','The five checks have no specified ordering');},
  'reversed current ordering':(q:any)=>{q.question=q.question.replace('Today the five checks run one after another','Today the five checks run concurrently');},
  'current parallel correction':(q:any)=>{q.question+='\nCorrection: the five IDP calls already run concurrently.';},
  'current dependency correction':(q:any)=>{q.question+='\nCorrection: the IDP calls are not independent.';},
  'no offered timeout':(q:any)=>{q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};},
  'timeout borrowed from sequential choice':(q:any)=>{q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};q.options[2].description+=' Per-call timeout 2000 ms.';},
  'timeout borrowed from question':(q:any)=>{q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};q.question+='\nRecommendation: per-call timeout.';},
  'only sequential timeout remedy':(q:any)=>{q.options[0]={label:'Keep the five calls sequential with per-call timeout',description:'Run each call after the previous call completes.'};},
  'same-option no timeout':(q:any)=>{q.options[0].description+='\nCorrection: no per-call timeout.';},
  'same-option sequential correction':(q:any)=>{q.options[0].description+='\nCorrection: keep the five calls sequential.';},
  'same-option no concurrency':(q:any)=>{q.options[0].description+='\nDo not use Promise.allSettled.';},
  'same-option negated timeout addition':(q:any)=>{q.options[0].description+='\nDo not add a per-call timeout.';},
  'same-option calls remain sequential':(q:any)=>{q.options[0].description+='\nCorrection: The IDP calls remain sequential.';},
  'parallel title foreign source':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel').replaceAll('PLAN.md','OTHER.md');},
  'parallel title without timeout':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel');q.options[0]={label:'Promise.allSettled',description:'Launch all calls concurrently and report every result.'};},
  'parallel title sequential correction':(q:any)=>{q.question=q.question.replace('issued concurrently','issued in parallel');q.options[0].description+='\nCorrection: The IDP calls remain sequential.';},
  'quoted offered remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
  'conditional remedy':(q:any)=>{q.options[0].description='If approved, '+q.options[0].description;},
  'withdrawn decision':(q:any)=>{q.question+='\nD13 is withdrawn.';},
  'reopened decision':(q:any)=>{q.question+='\nD13 is reopened.';},
  'scalar quoted deferred decision':(q:any)=>{q.question+='\nD13 is "deferred".';},
  'deferred offered remedy':(q:any)=>{q.options[0].description+='\nThis remedy is deferred.';},
  'scalar quoted pending remedy':(q:any)=>{q.options[0].description+='\nThis remedy is "pending".';},
}))test('IDP choice rejects '+name,()=>expect(idpResult(alterIdp(edit)).decisions).toEqual({}));
test('IDP choice requires its own completed native answer and distinct seed identity',()=>{
  const call=idpCall(),finished=Date.parse(idpChoice.captureAt);
  const guard=(c=call,prior:NativePlanQuestionCall[]=[])=>isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),prior,0,finished);
  expect(guard()).toBe(true);expect(guard(call,[call])).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.answeredAt=new Date(finished+1).toISOString();}]){
    const invalid=idpCall();edit(invalid);expect(guard(invalid)).toBe(false);expect(idpResult(invalid).decisions).toEqual({});
  }
  const foreign=structuredClone(transcript().calls[5]) as NativePlanQuestionCall;foreign.sessionId+='-foreign';expect(guard(call,[foreign])).toBe(false);
  const bundled=idpCall();bundled.questions.push(transcript().calls[5]!.questions[0]!);bundled.answers={...bundled.answers,...transcript().calls[5]!.answers};
  expect(guard(bundled)).toBe(false);expect(idpResult(bundled).decisions).toEqual({});
});
for(const [index,seed] of seeds) test('actual native decision owns '+seed,()=>{
  expect(Object.keys(evaluate([transcript().calls[index]!],'').decisions)).toEqual([seed]);
});
test('actual final callback assertions pass without changing the recorded failed attempt',()=>{
  expect(captured.originalOutcome).toBe('no_review_questions');
  expect(captured.originalCounts).toEqual({review:0,setup:14});
  const result=evaluate();
  expect(result.ok).toBe(true);
  expect(new Set(Object.values(result.decisions)).size).toBe(4);
  expect(result.regression).toBe('plan');
  expect(assertReviewReportAtBottom(captured.report).ok).toBe(true);
});

const change=(index:number,edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
  const c=transcript().calls[index]!,q=c.questions[0]!;edit(q);c.answers={[q.question]:q.options[0]!.label};return c;
};
for(const [name,edit] of Object.entries({
  'quoted provenance':(q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
  'source history':(q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
  'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
  'foreign suffix':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER-PLAN.md');},
  'foreign directory':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
  'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
  'conditional explanation':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
  'withdrawn question':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
  'withdrawn remedy':(q:any)=>{q.options[0].description+='\nThis remedy is withdrawn.';},
  'quoted inactive status':(q:any)=>{q.question+='\nThis decision is "withdrawn".';},
  'remedy borrowed from Net':(q:any)=>{q.question+='\nNet: '+q.options[0].description;q.options[0].description='Discuss the next steps.';},
  'quoted remedy':(q:any)=>{q.options[0].label='"'+q.options[0].label+'"';q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
})) test('source-bound semantic classes reject '+name,()=>{
  for(const [index] of seeds.slice(0,3))expect(evaluate([change(index,edit)],'').decisions).toEqual({});
});
for(const [index,label,edit] of [
  [4,'inventory count',(q:any)=>{q.question=q.question.replace('five new building blocks','six new building blocks');}],
  [4,'second store',(q:any)=>{q.options[0].description=q.options[0].description.replace('One owner for cached token state; no second store','Two owners for cached token state; a second store');}],
  [4,'retained class independence',(q:any)=>{q.question+='\nTokenStore already has a documented independent purpose.';}],
  [5,'other service',(q:any)=>{q.options[0].label=q.options[0].label.replace('pass to both constructors','pass to another constructor');}],
  [5,'shared test instance',(q:any)=>{q.options[0].description=q.options[0].description.replace('fresh AuthCache','shared AuthCache');}],
  [5,'already repaired cache',(q:any)=>{q.question+='\nThe services are already injected.';}],
  [7,'partial mapping',(q:any)=>{q.options[0].label=q.options[0].label.replace('each error class','some error classes');}],
  [7,'fail open',(q:any)=>{q.options[0].label=q.options[0].label.replace('fail closed','fail open');}],
  [7,'swallowed errors',(q:any)=>{q.options[0].description=q.options[0].description.replace('nothing is silently swallowed','errors are silently swallowed');}],
  [7,'already repaired function',(q:any)=>{q.question+='\nvalidateAndDispatch() already no longer swallows failures.';}],
] as const)test('same-option remedy requires '+label,()=>expect(evaluate([change(index,edit)],'').decisions).toEqual({}));

test('semantic wording and type names do not require the captured sentence',()=>{
  const edits=[
    [4,(q:any)=>{q.question=q.question.replace('five new building blocks','5 new components').replace('TokenStore is never described','TokenStore is undefined');q.options[0].label=q.options[0].label.replace('Consolidate:','Merge:').replace('typed value/config','config');}],
    [5,(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache once','one AuthCache').replace('pass to both constructors','injected to both services');q.options[0].description=q.options[0].description.replace('fresh AuthCache','isolated instance');}],
    [7,(q:any)=>{q.options[0].label=q.options[0].label.replace('AuthFailure','RejectedAuth').replace('one boundary catch','single catch at the boundary');}],
  ] as const;
  for(const [index,edit] of edits)expect(Object.keys(evaluate([change(index,edit)],'').decisions)).toHaveLength(1);
});

test('guard replay extracts the actual seeded callback and reaches unchanged final assertions',()=>{
  const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-eng-finding-count.test.ts'),'utf8');
  const expression=/isReviewAUQ: ([^\n]+),/.exec(source)?.[1];expect(expression).toBeTruthy();
  const guard=new Function('isEngSeedDecisionAUQ','startedAt',`return (${expression});`)(isEngSeedDecisionAUQ,captured.startedAt);
  const calls=transcript().calls;
  expect(calls.filter((c,i)=>guard(nativePlanCallFingerprint(c,0,true),calls.slice(0,i)))).toHaveLength(4);
  expect(source).not.toContain('createEngBatchingIssueCounter');
  expect(source).toContain('evaluateEngSeedCoverage(obs.transcript, planContent, startedAt, Date.now())');
  expect(source).toContain('assertReviewReportAtBottom(planContent)');
  expect(source).toContain('reviewCountCeiling: Infinity');
  expect(source).toContain('timeoutMs: 1_500_000');
  expect(source).toContain('approveEngTestPlanEdits: true');
  expect(source).toContain('isCompletionHandoffAUQ:');
});
test('native guard rejects incomplete, unowned, duplicate and foreign calls',()=>{
  const c=transcript().calls[4]!;
  const guard=(call=c,prior:NativePlanQuestionCall[]=[],edit=(fp:any)=>{})=>{
    const fp=nativePlanCallFingerprint(call,0,true);edit(fp);
    return isEngSeedDecisionAUQ(fp,prior,captured.startedAt,captured.finishedAt);
  };
  expect(guard()).toBe(true);
  for(const [start,end] of [[NaN,captured.finishedAt],[0,Infinity],[captured.finishedAt,captured.startedAt]])expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),[],start,end)).toBe(false);
  for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answeredAt=new Date(captured.startedAt-1).toISOString();},
    (c:any)=>{c.answeredAt=new Date(captured.finishedAt+1).toISOString();},(c:any)=>{c.answers={};}]){
    const bad=structuredClone(c);edit(bad);expect(guard(bad)).toBe(false);
  }
  for(const edit of [(fp:any)=>{delete fp.nativeCall;},(fp:any)=>{fp.signature+='-foreign';},(fp:any)=>{fp.options[0].label='forged';},
    (fp:any)=>{fp.nativeQuestionIndex=1;}])expect(guard(c,[],edit)).toBe(false);
  expect(guard(c,[c])).toBe(false);
  const foreign=structuredClone(c);foreign.sessionId+='-foreign';expect(guard(c,[foreign])).toBe(false);
  const reask=structuredClone(c);reask.toolUseId+='-reasked';expect(guard(reask,[c])).toBe(false);
  const combined=structuredClone(c);combined.questions.push(transcript().calls[5]!.questions[0]!);
  combined.answers={...combined.answers,...transcript().calls[5]!.answers};expect(guard(combined)).toBe(false);
});

const declaration=/^\*\*CRITICAL regression contract \(D9\):\*\*.+$/m.exec(captured.report)![0];
const baselineTask=/^- \[ \] \*\*T1[^\n]+\n(?:  - [^\n]+\n?)+/m.exec(captured.report)![0];
const minimalBaseline=()=>`# Current reviewed plan\n\n## Tests\n${declaration}\n\n## Implementation Tasks\n${baselineTask}`;
const regression=(plan:string)=>evaluate([],plan).regression;
const goldenPlan = () => goldenDeclaration.report;
const goldenContract = /^\*\*Regression contract[^\n]*\n.*?(?=\n\n)/ms.exec(goldenPlan())![0];
const goldenTask = /^- \[ \] \*\*T9[^\n]*\n(?:  - [^\n]+\n?)+/m.exec(goldenPlan())![0];
const goldenLedger = goldenPlan().slice(goldenPlan().indexOf('### R5:'));
test('the final 90f declaration binds named legacy outcomes to its required task and unchanged baseline', () => {
  expect(goldenDeclaration.reportSha256).toBe('d4ae545eec013da903b5b3c0b459f9f8d2543ea838001271bd7c82b27ac848c3');
  expect(goldenDeclaration.originalOutcome).toBe('seed_coverage_failed');
  expect(goldenDeclaration.nativeCall.toolUseId).toBe('toolu_01DszoYCjnkNfCj5FxaZJsjQ');
  expect(goldenDeclaration.nativeCall.answered).toBe(true);
  expect(regression(goldenPlan())).toBe('plan');
});
for (const [name, edit] of Object.entries({
  'missing declaration': (s:string) => s.replace(goldenContract, ''),
  'missing task': (s:string) => s.replace(goldenTask, ''),
  'missing ledger': (s:string) => s.replace(goldenLedger, ''),
  'missing required status': (s:string) => s.replace('R5, D11, Iron Rule', 'R5, D11'),
  'negated required status': (s:string) => s.replace('R5, D11, Iron Rule', 'R5, D11, not Iron Rule'),
  'optional declaration': (s:string) => s.replace('Regression contract (', 'Optional regression contract ('),
  'conditional capture': (s:string) => s.replace('fixtures pinning current', 'fixtures if approved pinning current'),
  'future outcome oracle': (s:string) => s.replace('pinning current outputs', 'pinning proposed outputs'),
  'foreign legacy target': (s:string) => s.replaceAll('legacyAuthFlow', 'otherAuthFlow'),
  'wrong reviewed source': (s:string) => s.replace('Reviewed target: `PLAN.md`', 'Reviewed target: `OTHER.md`'),
  'wrong reviewed branch': (s:string) => s.replace('on `main`', 'on `feature`'),
  'conflicting reviewed source': (s:string) => s + '\n## Current ownership\nReviewed target: OTHER.md on main\n',
  'foreign finding source': (s:string) => s.replaceAll('PLAN.md:', 'archive/PLAN.md:'),
  'noncritical finding': (s:string) => s.replace('Finding: T1, P1 CRITICAL', 'Finding: T1, P2'),
  'negated critical finding': (s:string) => s.replace('Finding: T1, P1 CRITICAL', 'Finding: T1, P1 not CRITICAL'),
  'pending ownership': (s:string) => s.replace('State: approved', 'State: pending'),
  'duplicate owner': (s:string) => s + '\n' + goldenLedger,
  'wrong record owner': (s:string) => s.replace('### R5:', '### R15:'),
  'duplicate finding': (s:string) => s.replace('State: approved', 'Finding: T1, P1 CRITICAL, PLAN.md:14\nState: approved'),
  'different decision answer': (s:string) => s.replace('A (D11)', 'A (D12)'),
  'selected option omits characterization': (s:string) => s.replace('Actual answer: A', 'Actual answer: B'),
  'selected option has negated characterization': (s:string) => s.replace('Options: A) Characterization', 'Options: A) No characterization'),
  'duplicate offered identity': (s:string) => s.replace('; B) Parity + routing only', '; A) Parity + routing only'),
  'missing named preservation': (s:string) => s.replace(/^Behavior to preserve.+$/m, ''),
  'flagged outcome ownership': (s:string) => s.replace('Behavior to preserve (legacy tenants, flag off)', 'Behavior to preserve (flagged tenants, flag on)'),
  'missing accepted scope': (s:string) => s.replace(/^Accepted scope:.+$/m, ''),
  'conditional accepted scope': (s:string) => s.replace('Accepted scope: (1)', 'Accepted scope: If approved, (1)'),
  'wrong task decision': (s:string) => s.replace('Tests — T1 (PLAN.md:14-16, :27-28), D11', 'Tests — T1 (PLAN.md:14-16, :27-28), D12'),
  'mixed task decisions': (s:string) => s.replace('Tests — T1 (PLAN.md:14-16, :27-28), D11', 'Tests — T1 (PLAN.md:14-16, :27-28), D11, D12'),
  'foreign task source': (s:string) => s.replace('Tests — T1 (PLAN.md:14-16', 'Tests — T1 (archive/PLAN.md:14-16'),
  'negated critical task': (s:string) => s.replace('T9 (P1 CRITICAL', 'T9 (P1 not CRITICAL'),
  'noncritical task': (s:string) => s.replace('T9 (P1 CRITICAL', 'T9 (P2'),
  'negated task': (s:string) => s.replace('Write the `legacyAuthFlow`', 'Do not write the `legacyAuthFlow`'),
  'optional task': (s:string) => s.replace('Write the `legacyAuthFlow`', 'Optionally write the `legacyAuthFlow`'),
  'task count alone': (s:string) => s.replace('Write the `legacyAuthFlow` characterization suite (6 golden fixtures)', 'Create a suite (6 golden fixtures)'),
  'wrong task count': (s:string) => s.replace('suite (6 golden fixtures)', 'suite (5 golden fixtures)'),
  'missing task files': (s:string) => s.replace(/^  - Files:.+$/m, ''),
  'foreign task files': (s:string) => s.replace('legacyAuthFlow.characterization.test', 'otherAuthFlow.characterization.test'),
  'missing task verification': (s:string) => s.replace(/^  - Verify:.+$/m, ''),
  'different baseline': (s:string) => s.replace('unmodified main', 'unmodified feature'),
  'modified baseline': (s:string) => s.replace('unmodified main', 'modified main'),
  'post-refactor baseline': (s:string) => s.replace('before any refactor lands', 'after any refactor lands'),
  'negated baseline': (s:string) => s.replace('suite green on', 'suite not green on'),
  'conditional baseline': (s:string) => s.replace('suite green on', 'if convenient, suite green on'),
  'duplicate task': (s:string) => s.replace(goldenTask, goldenTask + '\n' + goldenTask),
  'neighbor task baseline': (s:string) => s.replace('  - Verify:', '- [ ] **T99** — Other tests\n  - Verify:'),
  'quoted declaration': (s:string) => s.replace(goldenContract, goldenContract.split('\n').map(l => '> ' + l).join('\n')),
  'fenced task': (s:string) => s.replace(goldenTask, '```\n' + goldenTask + '\n```'),
  'historical ledger': (s:string) => s.replace('## Review ledger', '## Historical review ledger'),
  'task withdrawal': (s:string) => s + '\n## Current amendments\nT9 is withdrawn.\n',
  'decision withdrawal': (s:string) => s + '\n## Current amendments\nD11 is withdrawn.\n',
  'record withdrawal': (s:string) => s + '\n## Current amendments\nR5 is withdrawn.\n',
  'baseline reversed': (s:string) => s + '\n## Current amendments\nlegacyAuthFlow will be changed before T9.\n',
})) test('owned legacy declaration rejects ' + name, () => expect(regression(edit(goldenPlan()))).toBeUndefined());
for (const outcome of ['valid', 'expired', 'revoked', 'malformed token', 'suspended tenant', 'IDP unavailable']) {
  for (const owner of ['declaration', 'preservation', 'scope']) test('owned legacy declaration retains ' + outcome + ' in ' + owner, () => {
    const source = goldenPlan();
    const field = owner === 'declaration' ? goldenContract : owner === 'preservation'
      ? /^Behavior to preserve.+$/m.exec(source)![0] : /^Accepted scope:.+$/m.exec(source)![0];
    const mutated = field.replace(new RegExp('\\b' + outcome + '(?:s)?(?:[,;] )?'), '');
    expect(mutated).not.toBe(field);
    expect(regression(source.replace(field, mutated))).toBeUndefined();
  });
}
test('owned legacy declarations support equivalent oracle verbs, selected identities and optional function parentheses', () => {
  for (const verb of ['recording existing', 'capturing prior']) expect(regression(goldenPlan().replace('pinning current', verb))).toBe('plan');
  expect(regression(goldenPlan().replace('Options: A)', 'Options: D)').replace('Actual answer: A (D11)', 'Actual answer: D (D11)'))).toBe('plan');
  expect(regression(goldenPlan().replaceAll('`legacyAuthFlow`', '`legacyAuthFlow()`').replace('Write the', 'Implement the')
    .replace('suite green on unmodified main before any refactor lands', 'suite passes on untouched main before the rewrite begins'))).toBe('plan');
  expect(regression(goldenPlan() + '\n## Other suite\nBilling characterization suite is withdrawn.\n')).toBe('plan');
});
test('the captured legacy contract and its owned task are sufficient without unrelated report text',()=>expect(regression(minimalBaseline())).toBe('plan'));
for(const [name,edit] of Object.entries({
  'missing declaration':(s:string)=>s.replace(declaration,''),
  'missing task':(s:string)=>s.replace(baselineTask,''),
  'foreign target':(s:string)=>s.replaceAll('legacyAuthFlow','otherAuthFlow'),
  'missing baseline verification':(s:string)=>s.replace(/^  - Verify:.+$/m,''),
  'modified baseline':(s:string)=>s.replace('unmodified `main`','modified `main`'),
  'different baseline':(s:string)=>s.replace('unmodified `main`','unmodified `feature`'),
  'wrong task decision':(s:string)=>s.replace('R4/D9 CRITICAL','R4/D99 CRITICAL'),
  'different outcome count':(s:string)=>s.replace('suite (7 outcomes','suite (6 outcomes'),
  'different verification count':(s:string)=>s.replace('each of the 7 outcomes','each of the 6 outcomes'),
  'baseline after wrap':(s:string)=>s.replace('BEFORE the Phase 1 flag wrap','AFTER the Phase 1 flag wrap'),
  'task after wrap':(s:string)=>s.replace('before any flag wrap','after any flag wrap'),
  'negated write':(s:string)=>s.replace('Write the `legacyAuthFlow()`','Do not write the `legacyAuthFlow()`'),
  'negated land':(s:string)=>s.replace('land it green','do not land it green'),
  'conditional task':(s:string)=>s.replace('Write the `legacyAuthFlow()`','If approved, write the `legacyAuthFlow()`'),
  'quoted declaration':(s:string)=>s.replace(declaration,'"'+declaration+'"'),
  'quoted task':(s:string)=>s.replace(baselineTask,'"'+baselineTask.trim().replaceAll('\n',' ')+'"'),
  'historical section':(s:string)=>s.replace('## Tests','## Historical Tests'),
  'conditional declaration':(s:string)=>s.replace('characterization suite at','if approved, characterization suite at'),
  'quoted document':(s:string)=>'Quoted source material only:\n'+s.replace('# Current reviewed plan','# Report'),
  'task cancellation':(s:string)=>s+'\n## Current amendments\nT1 is withdrawn.\n',
  'decision cancellation':(s:string)=>s+'\n## Current amendments\nD9 is "withdrawn".\n',
  'verification cancellation':(s:string)=>s+'\n## Current amendments\nThis verification is optional.\n',
  'reversed implementation order':(s:string)=>s+'\n## Current amendments\nlegacyAuthFlow() will be changed before T1.\n',
}))test('legacy baseline rejects '+name,()=>expect(regression(edit(minimalBaseline()))).toBeUndefined());
test('legacy baseline accepts equivalent mandatory verbs, preserves quoted history and other suite ownership',()=>{
  expect(regression(minimalBaseline().replace('CRITICAL regression contract','Required regression contract').replace('Written and green','Implemented and green').replace('land it green','land it passing'))).toBe('plan');
  expect(regression(minimalBaseline()+'\n## Current amendments\nEarlier note: "T1 is withdrawn."\n')).toBe('plan');
  expect(regression(minimalBaseline()+'\n## Billing regression suite\nThis suite is withdrawn.\n')).toBe('plan');
});
test('final assertion gate still rejects missing seeds, missing legacy coverage and missing report',()=>{
  for(const [index,seed] of seeds){const input=transcript().calls.filter((_,i)=>i!==index);expect(evaluate(input).missing).toContain(seed);expect(evaluate(input).ok).toBe(false);}
  expect(evaluate(transcript().calls,'## GSTACK REVIEW REPORT\nEng complete.\n').ok).toBe(false);
  expect(evaluate(transcript().calls,minimalBaseline()).ok).toBe(false);
});

for(const [index,verb] of [[4,'consolidate'],[5,'inject'],[7,'map']] as const)test('same-option explicit cancellation rejects '+verb,()=>{
  expect(evaluate([change(index,q=>{q.options[0]!.description+='\nCorrection: Do not '+verb+' this remedy.';})],'').decisions).toEqual({});
});

test('captured native exit and actual callback reach final assertions with the corrected guard',()=>{
  const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-eng-finding-count.test.ts'),'utf8');
  const start=source.indexOf("        if (!['plan_ready', 'completion_summary'].includes(obs.outcome))"),end=source.indexOf('\n      } finally {',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const validate=new Function('fs','planPath','obs','startedAt','evaluateEngSeedCoverage','assertReviewReportAtBottom',
    new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end)));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-seed-native-')),file=path.join(dir,'report.md');
  try{
    const write=(body=captured.report)=>{fs.writeFileSync(file,body);fs.utimesSync(file,captured.reportMtimeMs/1000,captured.reportMtimeMs/1000);};write();
    expect(createHash('sha256').update(captured.report).digest('hex')).toBe(captured.reportSha256);
    const t=transcript(),nonReview=new Set<string>();let review=0;
    t.calls.forEach((call,i)=>{const fp=nativePlanCallFingerprint(call,0,true);if(isEngSeedDecisionAUQ(fp,t.calls.slice(0,i),captured.startedAt,captured.finishedAt))review++;else nonReview.add(fp.signature);});
    const frame=classifyPlanCountFrame(captured.screen);
    expect(frame).toBe('plan_ready');expect(review).toBe(4);
    expect(hasNativePlanTerminal(t,file,captured.startedAt,'plan_ready')).toBe(true);
    expect(isQuestionlessNativePlanExit(t,file,captured.startedAt,captured.screen,new Set(t.calls.map(c=>`${c.sessionId}:${c.toolUseId}`)))).toBe(true);
    expect(isQuestionlessNativePlanExit(t,file,captured.startedAt,captured.screen,nonReview)).toBe(false);
    const obs={outcome:frame,transcript:t,reviewCount:review,step0Count:nonReview.size,fingerprints:[],elapsedMs:0,evidence:captured.screen};
    const check=(input=obs)=>validate(fs,file,input,captured.startedAt,evaluateEngSeedCoverage,assertReviewReportAtBottom);
    expect(()=>check()).not.toThrow();
    expect(()=>check({...obs,outcome:'no_review_questions' as any})).toThrow('finding-count FAILED');
    const missing={...obs,transcript:{...t,calls:t.calls.filter((_,i)=>i!==4)}};expect(()=>check(missing)).toThrow('SEED COVERAGE FAIL');
    write('## GSTACK REVIEW REPORT\nEng complete.\n');expect(()=>check()).toThrow('SEED COVERAGE FAIL');
    write(captured.report+'\n## Work after report\nExtra\n');expect(()=>check()).toThrow('D19 FAIL');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for(const [index,claim] of [
  [4,'Correction: A second store still remains.'],
  [5,'Correction: Do not inject AuthCache.'],
  [5,'Correction: Tests do not get a fresh AuthCache.'],
  [5,'Correction: Tests share one AuthCache.'],
  [7,'Correction: Not every failure class has a named outcome.'],
  [7,'Correction: Errors are still swallowed.'],
  [7,'Correction: Some errors are silently ignored.'],
] as const)test('a current contradictory remedy cannot retain earlier positive words: '+claim,()=>{
  expect(evaluate([change(index,q=>{q.options[0]!.description+='\n'+claim;})],'').decisions).toEqual({});
  expect(Object.keys(evaluate([change(index,q=>{q.options[0]!.description+='\nEarlier note: "'+claim+'"';})],'').decisions)).toHaveLength(1);
});

for(const outcomes of [', denied','denied, denied '])test('legacy outcomes cannot use empty or duplicate labels: '+outcomes,()=>{
  const plan=minimalBaseline().replace(/one test per current outcome: [^.]+\./,'one test per current outcome: '+outcomes+'.')
    .replaceAll('7 outcomes','2 outcomes');
  expect(regression(plan)).toBeUndefined();
});

for(const status of ['deferred','not required','not needed','superseded','no longer needed'])test('current baseline ownership respects '+status,()=>{
  for(const id of ['T1','D9']){
    expect(regression(minimalBaseline()+`\n## Current amendments\n${id} is ${status}.\n`)).toBeUndefined();
    expect(regression(minimalBaseline()+`\n## Current amendments\n${id} is "${status}".\n`)).toBeUndefined();
    expect(regression(minimalBaseline()+`\n## Current amendments\nEarlier note: "${id} is ${status}."\n`)).toBe('plan');
  }
});


// Current choice identity is in the title; current defect and exact inventory
// belong to this same native question's source and explanation.
import currentChoiceCab3 from './fixtures/eng-current-choice-cab3.json';
const cab3Call=(index:number)=>structuredClone(currentChoiceCab3.calls[index]) as NativePlanQuestionCall;
const cab3Result=(c:NativePlanQuestionCall)=>evaluateEngSeedCoverage({status:'ready',calls:[c],assistantMessages:[]},'',0,Date.parse(currentChoiceCab3.captureAt)).decisions;
const cab3Change=(index:number,edit:(q:NativePlanQuestionCall['questions'][number])=>void)=>{const c=cab3Call(index);edit(c.questions[0]!);c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};return c;};
for(const [index,seed] of [[0,'complexity'],[1,'swallowed-errors']] as const){
  test('cab3 current owned choice identifies '+seed,()=>{
    const c=cab3Call(index);expect(cab3Result(c)).toEqual({[seed]:`${c.sessionId}:${c.toolUseId}`});
    expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,true),[],0,Date.parse(currentChoiceCab3.captureAt))).toBe(true);
    for(const option of c.questions[0]!.options){c.answers={[c.questions[0]!.question]:option.label};expect(cab3Result(c)[seed]).toBeDefined();}
  });
  test('cab3 current choice preserves formatting, ordering and historical examples: '+seed,()=>{
    for(const edit of [
      (q:any)=>{q.question=q.question.replaceAll('`','');},
      (q:any)=>{q.options.reverse();},
      (q:any)=>{q.question+='\nEarlier note: "This decision is withdrawn."';},
      (q:any)=>{q.question=q.question.replace(/^D\d+ — /,'D42: ');},
    ])expect(cab3Result(cab3Change(index,edit))[seed]).toBeDefined();
  });
  test('cab3 current choice requires its own source and current evidence: '+seed,()=>{
    for(const edit of [
      (q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
      (q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
      (q:any)=>{q.question=q.question.replace(/^Project\/branch\/task: (.+)$/m,'Project/branch/task: "$1"');},
      (q:any)=>{q.question=q.question.replace('Project/branch/task: ','Project/branch/task: Historical example: ');},
      (q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
      (q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
      (q:any)=>{q.question+='\nThis decision is withdrawn.';},
      (q:any)=>{q.question+='\nThis decision is "reopened".';},
      (q:any)=>{q.question+='\nThis finding applies only if approved.';},
      (q:any)=>{q.question=q.question.replace(/^([^\n]+)/,'"$1"');},
    ]){const c=cab3Change(index,edit);expect(cab3Result(c),JSON.stringify(c.questions)).toEqual({});}
  });
  test('cab3 current choice cannot borrow an option or bypass native completion: '+seed,()=>{
    for(const edit of [
      (q:any)=>{q.options[0].description='No current remedy.';},
      (q:any)=>{q.options[0].description='"'+q.options[0].description.replaceAll('\n',' ')+'"';},
      (q:any)=>{q.options[0].description+='\nThis remedy is withdrawn.';},
      (q:any)=>{q.options[0].description+='\nThis remedy is "deferred".';},
      (q:any)=>{q.options[0].description+='\nThis remedy applies only if approved.';},
    ])expect(cab3Result(cab3Change(index,edit))).toEqual({});
    for(const edit of [(c:any)=>{c.answered=false;},(c:any)=>{c.failed=true;},(c:any)=>{c.answers={};},(c:any)=>{c.unansweredQuestionIndices=[0];},(c:any)=>{c.questions[0].multiSelect=true;}]){const c=cab3Call(index);edit(c);expect(cab3Result(c)).toEqual({});}
  });
}
test('cab3 store consolidation proves the current inventory and one fewer store',()=>{
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('four components:','4 components:');q.options[0].label=q.options[0].label.replace('3 components:','three components:');q.options[1].label=q.options[1].label.replace('4 components:','four components:');},
   (q:any)=>{q.question=q.question.replace('Component arrangement: keep TokenStore as a separate class, or fold it into AuthCache?','How should the TokenStore and AuthCache components be arranged?');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('drop TokenStore','remove TokenStore');},
 ])expect(cab3Result(cab3Change(0,edit)).complexity).toBeDefined();
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('four components:','five components:');},
   (q:any)=>{q.question=q.question.replace('AuthCache, and TokenStore.','AuthCache, and OtherStore.');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('3 components:','4 components:');},
   (q:any)=>{q.options[1].label=q.options[1].label.replace('4 components:','3 components:');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('AuthCache; drop','AuthBroker; drop');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('drop TokenStore','keep TokenStore');},
   (q:any)=>{q.options[0].description+='\nDo not remove TokenStore.';},
   (q:any)=>{q.options[0].description+='\nTokenStore remains a separate store.';},
   (q:any)=>{q.question+='\nCorrection: TokenStore has an independent persistence purpose.';},
   (q:any)=>{q.question=q.question.replace("a third layer doing the adapter's job",'an independent component with a separate contract');},
 ])expect(cab3Result(cab3Change(0,edit))).toEqual({});
});
test('cab3 typed error choice owns both visible known outcomes and unknown propagation',()=>{
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('quietly eat one kind of error','silently swallow one error class');},
   (q:any)=>{q.options[0].label=q.options[0].label.replace('AuthResult','AuthOutcome');},
   (q:any)=>{q.options[0].description=q.options[0].description.replace('Unknown errors propagate','Unknown failures are rethrown');},
 ])expect(cab3Result(cab3Change(1,edit))['swallowed-errors']).toBeDefined();
 for(const edit of [
   (q:any)=>{q.question=q.question.replace('quietly eat one kind of error','explicitly surface each error');},
   (q:any)=>{q.question+='\nCorrection: validateAndDispatch() no longer swallows failures.';},
   (q:any)=>{q.options[0].description=q.options[0].description.replace('Unknown errors propagate','Unknown errors are swallowed');},
   (q:any)=>{q.options[0].description=q.options[0].description.replace('Every known error class becomes a visible outcome','Some known error classes are ignored');},
   (q:any)=>{q.options[0].description+='\nNot every known error class becomes a visible outcome.';},
   (q:any)=>{q.options[0].description+='\nDo not propagate unknown errors.';},
   (q:any)=>{q.options[0].description+='\nErrors are still swallowed.';},
   (q:any)=>{q.options[0].description+='\nThis remedy applies to another function.';},
   (q:any)=>{q.options[1].description+=' Unknown errors propagate.';q.options[0].description=q.options[0].description.replace('Unknown errors propagate','Unknown errors are unspecified');},
 ])expect(cab3Result(cab3Change(1,edit))).toEqual({});
});


test('cab3 choice attribution cannot bypass guards through a more explicit title',()=>{
 for(const [index,title] of [[0,'Component classes: keep TokenStore separate, or fold it into AuthCache?'],[1,'Rewrite validateAndDispatch() to fix nested swallowed errors, or add logs?']] as const){
  expect(cab3Result(cab3Change(index,q=>{q.question=q.question.replace(/^D\d+ — [^\n]+/,'D20 — '+title);}))[index===0?'complexity':'swallowed-errors']).toBeDefined();
  for(const suffix of ['\nThis decision is withdrawn.','\nThis decision is "reopened".']) expect(cab3Result(cab3Change(index,q=>{q.question=q.question.replace(/^D\d+ — [^\n]+/,'D20 — '+title)+suffix;}))).toEqual({});
  expect(cab3Result(cab3Change(index,q=>{q.question=q.question.replace(/^D\d+ — [^\n]+/,'D20 — '+title).replaceAll('PLAN.md','OTHER.md');}))).toEqual({});
 }
});
test('cab3 owned remedies reject explicit contradictory retention and silent errors',()=>{
 for(const [index,tail] of [[0,'Keep TokenStore as a separate store.'],[0,'Retain TokenStore as a separate class.'],[1,'Known errors are still hidden.'],[1,'Unknown errors do not propagate.']] as const){
  expect(cab3Result(cab3Change(index,q=>{q.options[0]!.description+='\n'+tail;}))).toEqual({});
  expect(cab3Result(cab3Change(index,q=>{q.options[0]!.description+='\nEarlier note: "'+tail+'"';}))[index===0?'complexity':'swallowed-errors']).toBeDefined();
 }
});
