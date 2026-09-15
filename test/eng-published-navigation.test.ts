import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import a from './fixtures/eng-published-navigation.json';
import {isEngCompletionHandoff} from './helpers/eng-completion-handoff';
import {nativePlanCallFingerprint,hasNativePlanTerminal,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall,PlanCountTranscript} from './helpers/plan-count-transcript';
const plan=a.plan;
function check(name:string,expected:boolean,mutate?:(x:any)=>void) {
 test(name,()=>{
  const x={call:structuredClone(a.call),plan};mutate?.(x);
  const fp=nativePlanCallFingerprint(x.call,0,false);
  expect(isEngCompletionHandoff(fp,x.plan,a.priorCalls)).toBe(expected);
 });
}
function question(x:any,f:(s:string)=>string) {const q=x.call.questions[0],answer=x.call.answers[q.question];q.question=f(q.question);x.call.answers={[q.question]:answer};}
check('actual captured acknowledged D16 + acknowledged report',true);
check('reordered ready and optional review choices',true,x=>x.call.questions[0].options.reverse());
check('optional review answer changes route, not report',true,x=>x.call.answers[x.call.questions[0].question]=x.call.questions[0].options[1].label);
check('plural native navigation header',true,x=>x.call.questions[0].header='Next steps');
check('independent decision ordinal',true,x=>question(x,s=>s.replace('D16 —','D27:')));
check('different task count is bound to same catalog',true,x=>{question(x,s=>s.replaceAll('T1–T10','T1–T9'));x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1–T10','T1–T9');});
check('new task reference',false,x=>{question(x,s=>s.replaceAll('T1–T10','T1–T11'));x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1–T10','T1–T11');});
check('different existing task subsets remain a recap',true,x=>question(x,s=>s.replaceAll('T1–T10','T2–T9')));
check('changed lane order',false,x=>x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B, then C+D','C+D, then A+B'));
check('changed lane grouping',false,x=>x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B, then C+D','A+C, then B+D'));
check('unpublished lane',false,x=>x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('then E','then F'));
check('task withdrawn in own current task',false,x=>x.plan=x.plan.replace('  - Verify: matrix green against legacy; replayed green against new path before swap','  - Correction: T1 is withdrawn.'));
check('missing published task',false,x=>x.plan=x.plan.replace('**T3 (P1,','**T99 (P1,'));
check('quoted whole plan',false,x=>x.plan=x.plan.split('\n').map((s:string)=>'> '+s).join('\n'));
check('fenced whole plan',false,x=>x.plan='```markdown\n'+x.plan+'\n```');
check('foreign historical task heading',false,x=>x.plan=x.plan.replace('## Implementation Tasks','## Historical Implementation Tasks'));
check('incomplete report',false,x=>x.plan=x.plan.replace('NO UNRESOLVED DECISIONS','Unresolved decisions pending'));
check('missing report',false,x=>x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT')));
check('reopened report',false,x=>x.plan=x.plan.replace('CLEAR (mode: SCOPE_REDUCED)','NOT CLEARED'));
check('unanswered native call',false,x=>{x.call.answered=false;x.call.unansweredQuestionIndices=[0];});
check('failed native call',false,x=>x.call.failed=true);
check('unoffered answer',false,x=>x.call.answers[x.call.questions[0].question]='Do something else');
check('missing acknowledgment',false,x=>delete x.call.answeredAt);
check('multiselect',false,x=>x.call.questions[0].multiSelect=true);
check('bundled substantive question',false,x=>x.call.questions.push(structuredClone(a.priorCalls[0].questions[0])));
check('new requirement option',false,x=>x.call.questions[0].options.push({label:'Add another datastore'}));
check('implementation option disguised as navigation',false,x=>x.call.questions[0].options[0].label+=' and add Redis');
check('new action in ready description',false,x=>x.call.questions[0].options[0].description+=' Add a datastore first.');
check('new action in optional description',false,x=>x.call.questions[0].options[1].description+=' Install a new cache before review.');
check('new obligation in metadata',false,x=>question(x,s=>s+'\nA new dependency is required before implementation.'));
check('conditional closure',false,x=>question(x,s=>s.replace('review is done','review will be done')));
check('withdrawn closure',false,x=>question(x,s=>s.replace('review is done','review is not done')));
check('quoted question',false,x=>question(x,s=>'> '+s));

check('fully reworded brief and descriptions, same actions and catalog',true,x=>{
 question(x,_=>"D27: What is the next workflow?\nThe engineering review is complete. This only selects the next workflow; it does not authorize any implementation change. Tasks T1 through T10 are ready. The approved sequence is lanes A+B then C+D then E. A further CEO review is optional. All required reviews are clear.\nChoose the implementation route or the optional strategy review.");
 x.call.questions[0].options[0].description='The reviewed tasks T1 to T10 are ready. The current implementation plan remains unchanged. No further engineering approval is needed.';
 x.call.questions[0].options[1].description='An optional strategy review offers another perspective. The engineering result remains clear; the cost is one more review.';
});
check('different clause order and wrapping',true,x=>{
 question(x,s=>s.replace('This is navigation only; it approves no implementation change.','It does not modify implementation. This is routing only.').replace('The engineering review is done and logged clean:','The Eng review is finished and logged clean:').replaceAll('T1–T10','T1 through T10'));
 x.call.questions[0].options[0].description='T1–T10 are already covered by the reviewed plan; lanes A+B then C+D then E. The Eng review is clear and all decisions are settled.';
 x.call.questions[0].options[1].description='A CEO strategy review remains optional. It costs another review cycle and adds perspective.';
});
check('same tasks and renamed published lanes',true,x=>{
 for(const [old,neo] of [['A','V'],['B','W'],['C','X'],['D','Y'],['E','Z']]) {
  x.plan=x.plan.replaceAll('Lane '+old+':','Lane '+neo+':');
 }
 x.plan=x.plan.replace('launch A + B in parallel worktrees; merge. Launch C + D in parallel; merge. Then E.','launch V + W in parallel worktrees; merge. Launch X + Y in parallel; merge. Then Z.');
 x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('A+B, then C+D, then E','V+W, then X+Y, then Z');
});
check('a later new-work command after a no-change assertion still fails',false,x=>question(x,s=>s+' Also externalize token state into Redis.'));
check('current review is only conditionally complete',false,x=>question(x,s=>s.replace('The engineering review is done','The engineering review is done if we add caching')));
check('quoted completion does not supply present closure',false,x=>question(x,s=>s.replace('The engineering review is done','Historical: The engineering review is done')));


test('the real completed navigation preserves freshness only for its own acknowledged answer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-published-navigation-')),file=path.join(dir,'review.md');
 try {
  fs.writeFileSync(file,plan);const at=Date.parse(a.reportWriteAt);fs.utimesSync(file,at/1000,at/1000);
  const call=structuredClone(a.call) as NativePlanQuestionCall;
  const fp=nativePlanCallFingerprint(call,0,false),isHandoff=isEngCompletionHandoff(fp,plan,a.priorCalls as NativePlanQuestionCall[]);
  for(const started of [false,true])expect(planCountQuestionPhase(fp,started,()=>false,undefined,undefined,()=>isHandoff))
    .toEqual({preReview:false,reviewStarted:started,administrative:'completion-handoff'});
  const transcript:PlanCountTranscript={status:'ready',calls:[...structuredClone(a.priorCalls),call] as NativePlanQuestionCall[],assistantMessages:[],planReadyRequests:structuredClone(a.planReadyRequests)};
  const admin=new Set(isHandoff?[fp.signature]:[]),check=(t=transcript,ids=admin)=>hasNativePlanTerminal(t,file,Date.parse(a.startedAt),'plan_ready',ids);
  expect(check()).toBe(true);expect(check(transcript,new Set())).toBe(false);expect(check(transcript,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (t:PlanCountTranscript)=>{t.calls[0]!.answeredAt=call.answeredAt;},
   (t:PlanCountTranscript)=>{t.calls[1]!.answered=false;t.calls[1]!.unansweredQuestionIndices=[0];},
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
  ]){const t=structuredClone(transcript);mutate(t);expect(check(t)).toBe(false);}
  fs.writeFileSync(file,'## GSTACK REVIEW REPORT\n');fs.utimesSync(file,at/1000,at/1000);expect(check()).toBe(false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for (const conjunction of ['and', 'but', 'then']) check(`a nonmodifying clause cannot hide ${conjunction} an implementation command`, false, x =>
  question(x, s => s.replace('it approves no implementation change.', `it approves no implementation change ${conjunction} add Redis caching.`)));
for (const [open, close] of [['"', '"'], ['“', '”']]) {
  check(`a wholly ${open}quoted${close} question cannot assert current closure`, false, x => question(x, s => open + s + close));
  check(`quoted ${open}completion${close} alone does not establish current closure`, false, x => question(x, s => s.replace('The engineering review is done and logged clean', open + 'The engineering review is done and logged clean' + close).replace('the Eng gate is the only required one and it is CLEAR', 'there is an engineering gate').replace('all required reviews are complete', 'the task catalog is available')));
}

for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
  for (const template of ['The implementation requirement is COMMAND.', 'Also COMMAND before implementation.']) {
    check(`raw ${open}quoted work${close} remains a veto: ${template}`, false, x =>
      question(x, s => s + '\n' + template.replace('COMMAND', open + 'add Redis caching' + close)));
  }
}


import currentMenu from './fixtures/eng-completed-navigation-cab3.json';
function currentMenuCheck(name:string,expected:boolean,mutate?:(x:any)=>void) {
 test(`completed current menu: ${name}`,()=>{
  const x=structuredClone(currentMenu);mutate?.(x);
  expect(isEngCompletionHandoff(nativePlanCallFingerprint(x.call,0,false),x.plan,x.priorCalls)).toBe(expected);
 });
}
currentMenuCheck('actual D19 ready versus optional CEO with published task references',true);
currentMenuCheck('reordered options and independent ordinal',true,x=>{x.call.questions[0].options.reverse();question(x,s=>s.replace('D19 —','D31:'));});
currentMenuCheck('equivalent current decision-only routing',true,x=>question(x,s=>s.replace('The only question left is whether to start building or first get a strategy-level second look.','Only the next workflow remains: implementation or an optional strategy review.')));
currentMenuCheck('explicit lane sequence must still match the published sequence',true,x=>{x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('ordered with lanes','ordered with lanes A then B then C');x.plan=x.plan.replace('Execution: launch A and B in parallel worktrees. Merge both. Then C.','Execution: launch A; then B; then C.');});
for(const [name,mutate] of Object.entries({
 'unanswered':(x:any)=>{x.call.answered=false;x.call.unansweredQuestionIndices=[0];},
 'failed':(x:any)=>{x.call.failed=true;},
 'unknown answer':(x:any)=>{x.call.answers[x.call.questions[0].question]='Other';},
 'missing ACK':(x:any)=>{delete x.call.answeredAt;},
 'bundled work question':(x:any)=>{x.call.questions.push(structuredClone(x.priorCalls[3].questions[0]));},
 'new task':(x:any)=>{x.call.questions[0].options[0].description=x.call.questions[0].options[0].description.replace('T1-T9','T1-T10');},
 'missing task':(x:any)=>{x.plan=x.plan.replace('**T6 (','**T99 (');},
 'unpublished lane':(x:any)=>{x.call.questions[0].options[0].description+=' Lanes A then Z.';},
 'changed lane grouping':(x:any)=>{x.call.questions[0].options[0].description+=' Lanes A+C then B.';},
 'missing current report':(x:any)=>{x.plan=x.plan.slice(0,x.plan.indexOf('## GSTACK REVIEW REPORT'));},
 'reopened report':(x:any)=>{x.plan=x.plan.replace('CLEAR (PLAN)','NOT CLEARED');},
 'quoted report':(x:any)=>{x.plan='```md\n'+x.plan+'\n```';},
 'historical catalog':(x:any)=>{x.plan=x.plan.replace('## Implementation Tasks','## Historical tasks');},
 'withdrawn task':(x:any)=>{x.plan=x.plan.replace('  - Verify: six scenarios green for both implementations before any tenant is allowlisted','  - Correction: T6 is withdrawn.');},
 'foreign plan title':(x:any)=>{x.plan=x.plan.replace('# Plan: Multi-tenant Auth Refactor (reviewed)','# Plan: Different Auth Refactor (reviewed)');},
 'quoted completion':(x:any)=>{question(x,s=>s.replace('Eng Review CLEAR','"Eng Review CLEAR"'));},
 'conditional completion':(x:any)=>{question(x,s=>s.replace('Eng Review CLEAR','Eng Review CLEAR if more tests pass'));},
 'negative completion':(x:any)=>{question(x,s=>s.replace('Eng Review CLEAR','Eng Review not CLEAR'));},
 'other decision remains':(x:any)=>{question(x,s=>s.replace('The only question left is whether','Another question is whether'));},
 'new work in ready label':(x:any)=>{x.call.questions[0].options[0].label+=' and add Redis';},
 'new work in ready description':(x:any)=>{x.call.questions[0].options[0].description+=' Also add Redis.';},
 'new work in CEO description':(x:any)=>{x.call.questions[0].options[1].description+=' Then rewrite the router.';},
 'new requirement in brief':(x:any)=>{question(x,s=>s+'\nA new dependency is required.');},
 'additional imperative':(x:any)=>{question(x,s=>s+'\nAlso externalize token state into Redis.');},
 'quoted imperative':(x:any)=>{question(x,s=>s+'\nAlso "add Redis" before implementation.');},
 'subordinate action':(x:any)=>{question(x,s=>s+'\nStart building while deleting the old database.');},
}))currentMenuCheck(name,false,mutate);

test('current completed D19 alone is administrative; report and other answers retain exact freshness',()=>{
 const x=structuredClone(currentMenu), dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-current-menu-')),file=path.join(dir,'review.md');
 const now=Date.now;
 try {
  Date.now=()=>Date.parse(x.captureAt);fs.writeFileSync(file,x.plan);fs.utimesSync(file,x.reportMtimeMs/1000,x.reportMtimeMs/1000);
  const fp=nativePlanCallFingerprint(x.call,0,false),admin=new Set(isEngCompletionHandoff(fp,x.plan,x.priorCalls)?[fp.signature]:[]);
  const transcript:PlanCountTranscript={status:'ready',calls:[...x.priorCalls,x.call],assistantMessages:[],planReadyRequests:x.planReadyRequests};
  const check=(t=transcript,ids=admin)=>hasNativePlanTerminal(t,file,x.startedAt,'plan_ready',ids);
  expect(check()).toBe(true);expect(check(transcript,new Set())).toBe(false);expect(check(transcript,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (t:PlanCountTranscript)=>{t.calls[0]!.answeredAt=x.call.answeredAt;},
   (t:PlanCountTranscript)=>{t.calls[0]!.answered=false;t.calls[0]!.unansweredQuestionIndices=[0];},
   (t:PlanCountTranscript)=>{t.planReadyRequests=[];},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.failed=true;},
   (t:PlanCountTranscript)=>{t.planReadyRequests![0]!.sessionId='foreign';},
  ]){const t=structuredClone(transcript);mutate(t);expect(check(t)).toBe(false);}
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});

for(const action of ['adding Redis','rewriting the router','replacing the database','dropping a table','building a second service'])
 currentMenuCheck(`subordinate new work: ${action}`,false,x=>question(x,s=>s+'\nStart building while '+action+'.'));
for(const status of ['Not every decision is answered.', 'Some decisions remain open.', 'One decision is unresolved.'])
 currentMenuCheck(`current unresolved decision: ${status}`,false,x=>question(x,s=>s+'\nCorrection: '+status));
currentMenuCheck('quoted historical decision status is not a current withdrawal',true,x=>question(x,s=>s+'\nEarlier note: "One decision is unresolved."'));
currentMenuCheck('quoted current scalar status still withdraws completion',false,x=>question(x,s=>s+'\nCorrection: One decision is "unresolved".'));
