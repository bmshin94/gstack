import {expect, test} from 'bun:test';
import captured from './fixtures/eng-native-seed-contract-6f.json';
import {evaluateEngSeedCoverage, isEngSeedDecisionAUQ} from './helpers/eng-seeded-coverage';
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
