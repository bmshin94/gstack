import {describe,expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {hasNativePostAnswerCeoPosture,nextCeoModeNavigation} from './helpers/ceo-mode-option';
import {capturePlanCountQuestion,nativePlanCallFingerprint,planCountPrerequisitePick,planCountQuestionInput} from './helpers/claude-pty-runner';
import {readPlanCountTranscript,type NativePublicToolEvent,type NativePlanQuestionCall} from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-mode-full-ad.json';
import kindCapture from './fixtures/ceo-expansion-posture-kind-dacc.json';
import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
const pattern=/\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
function replay(i:number){
 const item=captured.cases[i]!,root=fs.mkdtempSync(path.join(os.tmpdir(),'ceo-full-ad-'));
 fs.mkdirSync(path.join(root,'projects','owned'),{recursive:true});
 fs.writeFileSync(path.join(root,'projects','owned',item.process.sessionId+'.jsonl'),item.records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const events:NativePublicToolEvent[]=[];
 try{return {item,transcript:readPlanCountTranscript(root,item.process.cwd,e=>events.push(e)),events};}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}
function pending(){const c=structuredClone(replay(0).transcript.calls[0]!);c.answered=false;delete c.answers;delete c.answeredAt;delete c.unansweredQuestionIndices;return c;}
// Full panes projected from exact native questions, not retained historical viewports.
function pane(call:NativePlanQuestionCall,index:number){const q=call.questions[index]!;return [
 call.questions.length>1?'← '+call.questions.map((v,i)=>`${i<index?'☒':'☐'} ${v.header}`).join(' ')+' ✔ Submit →':'☐ '+q.header,
 q.question,...q.options.map((v,i)=>`${i?' ':'❯'} ${i+1}. ${v.label}`),
 `Enter to select · ${call.questions.length>1?'Tab/Arrow keys':'↑/↓'} to navigate · Esc to cancel`].join('\n');}
function frame(c:NativePlanQuestionCall,index:number){const visible=pane(c,index);return {visible,active:capturePlanCountQuestion(visible,new Set(),0,true,c)!,routing:nativePlanCallFingerprint(c,0,true)};}
function match(e= replay(1)){return hasNativePostAnswerCeoPosture(e.transcript,'SCOPE EXPANSION',pattern,e.item.selectedAt!,e.events);}
function rebind(e:ReturnType<typeof replay>){const d=e.transcript.calls[1]!,q=d.questions[0]!;e.events[2]!.input={questions:d.questions};d.answers={[q.question]:q.options[0]!.label};}
describe('full AD mode failures retain their actual outcomes',()=>{
 test('Proposal 1 is a completed scope decision after the actual selected mode',()=>{
  const e=replay(1);expect(e.item.actualState).toBe('failed');expect(e.transcript.calls).toHaveLength(2);expect(e.events).toHaveLength(4);
  expect(e.transcript.calls[1]!.answeredAt).toBe('2026-09-09T18:26:20.110Z');expect(match(e)).toBe(true);
 });
 test.each(['pending','foreign','wrong mode','pre-mode','missing reply','wrong answer','extra question','extra option','multiselect',
  'quoted','fenced','mode echo','mode mismatch','mode menu','appended instruction'])('%s supplies no new posture',kind=>{
  const e=replay(1),[m,d]=e.transcript.calls,q=d!.questions[0]!;
  switch(kind){
   case 'pending':d!.answered=false;break;case 'foreign':d!.sessionId=e.events[2]!.sessionId=e.events[3]!.sessionId='foreign';break;
   case 'wrong mode':m!.answers![m!.questions[0]!.question]='HOLD SCOPE';break;
   case 'pre-mode':e.events[2]!.timestamp=e.events[0]!.timestamp;break;case 'missing reply':e.events.pop();break;
   case 'wrong answer':d!.answers![q.question]='Invented';break;
   case 'extra question':d!.questions.push({...structuredClone(q),question:'Remove CI gate?'});rebind(e);break;
   case 'extra option':q.options.push({label:'Remove CI gate'});rebind(e);break;case 'multiselect':q.multiSelect=true;rebind(e);break;
   case 'quoted':q.question=q.question.split('\n').map(x=>'> '+x).join('\n');rebind(e);break;
   case 'fenced':q.question='```text\n'+q.question+'\n```';rebind(e);break;
   case 'mode echo':q.question='SCOPE EXPANSION confirmed.';rebind(e);break;
   case 'mode mismatch':q.question=q.question.replace('SCOPE EXPANSION opt-in','SELECTIVE EXPANSION opt-in');rebind(e);break;
   case 'mode menu':q.question=q.question.replace(/^D6[^\n]+/,'D6 — Choose the review mode?');rebind(e);break;
   case 'appended instruction':q.question+=' Delete the CI gate.';rebind(e);break;
  }expect(match(e)).toBe(false);
 });
 test('scope numbering and brief labels are presentation, not mode application',()=>{
  for(const title of ['A useful adjacent feature: Default view per member per project?','Default view per member per project?']){
   const e=replay(1),q=e.transcript.calls[1]!.questions[0]!;q.header='Default view';q.question=q.question.replace(/^D6[^\n]+/,title);rebind(e);expect(match(e)).toBe(true);
  }
 });
 test('explicit expansion context does not need a mode or opt-in suffix',()=>{
  const e=replay(1),q=e.transcript.calls[1]!.questions[0]!;q.question=q.question.replace('SCOPE EXPANSION opt-in ceremony (1 of 6).','SCOPE EXPANSION, approach B.');rebind(e);expect(match(e)).toBe(true);
 });
 test('the actual three-tab prerequisite chooses standard review only on its own tab',()=>{
  const actual=replay(0);expect(actual.item.actualState).toBe('failed');expect(Object.values(actual.transcript.calls[0]!.answers!).at(-1)).toBe('Run /office-hours now');
  const c=pending();for(const i of [0,1,2]){
   const f=frame(c,i),a=nextCeoModeNavigation(f.visible,'HOLD SCOPE',new Set(),c);expect(a.kind).toBe('question');
   if(a.kind==='question'){expect(a.question.nativeQuestionIndex).toBe(i);expect(planCountQuestionInput(f.visible,a.question,a.index)).toBe(i===2?'2':'1');}
   expect(planCountPrerequisitePick(f.routing,f.active)).toBe(i===2?2:null);
  }
 });
 test('single and reordered native prerequisite tabs preserve the meaning of the skip',()=>{
  const c=pending();c.questions=[c.questions[2]!];let f=frame(c,0);expect(planCountPrerequisitePick(f.routing,f.active)).toBe(2);
  c.questions[0]!.options.reverse();f=frame(c,0);expect(planCountPrerequisitePick(f.routing,f.active)).toBe(1);
 });
 test.each(['wrong tab','wrong signature','wrong body','wrong order','no metadata','completed','failed','extra action','multiselect','conditional','extra remedy','no description'])('a %s cannot borrow the prerequisite action',kind=>{
  const c=pending();if(kind==='completed')c.answered=true;if(kind==='failed')c.failed=true;
  if(kind==='extra action')c.questions[2]!.options.push({label:'Accept risk'});
  if(kind==='multiselect')c.questions[2]!.multiSelect=true;
  if(kind==='conditional')c.questions[2]!.options[1]!.description+=' if all tests pass.';
  if(kind==='extra remedy')c.questions[2]!.options[1]!.description+=' Remove the CI gate.';
  if(kind==='no description')c.questions[2]!.options[1]!.description='';
  const f=frame(c,2);let a=f.active;
  if(kind==='wrong tab')a={...a,nativeQuestionIndex:0};if(kind==='wrong signature')a={...a,signature:'foreign:tool:question:2'};
  if(kind==='wrong body')a={...a,promptSnippet:'Choose a product direction.'};if(kind==='wrong order')a={...a,options:[...a.options].reverse()};
  if(kind==='no metadata')a={...a,nativeCall:undefined};
  expect(planCountPrerequisitePick(f.routing,a)).toBeNull();
 });
});

describe('full AD HOLD retry completed sequencing rationale',()=>{
 function hold(){const e=replay(2);return {e,decision:e.transcript.calls[2]!,q:e.transcript.calls[2]!.questions[0]!};}
 function matches(e:ReturnType<typeof replay>){return hasNativePostAnswerCeoPosture(e.transcript,'HOLD SCOPE',/\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i,e.item.selectedAt!,e.events);}
 function bind(e:ReturnType<typeof replay>){const d=e.transcript.calls[2]!,q=d.questions[0]!;e.events[4]!.input={questions:d.questions};d.answers={[q.question]:q.options[0]!.label};}
 test('the actual completed rationale applies HOLD to work in the previously approved approach',()=>{
  const {e,decision,q}=hold();expect(e.item.actualState).toBe('failed');expect(e.transcript.calls).toHaveLength(3);
  const approach=e.transcript.calls[0]!;expect(Object.values(approach.answers!)).toEqual(['B: ViewState schema (recommended)']);
  expect(approach.questions[0]!.options[0]!.description).toContain('URL params');
  expect(decision.answeredAt).toBe('2026-09-09T18:35:05.273Z');expect(q.question).toContain('not new scope either way');expect(matches(e)).toBe(true);
 });
 test('three and four alternatives still express one completed review decision',()=>{
  for(const count of [3,4]){const {e,q}=hold();q.options.push({label:'Gate URL sync for the pilot'});if(count===4)q.options.push({label:'Run a limited URL sync pilot'});bind(e);expect(matches(e)).toBe(true);}
 });
 test.each(['pending','foreign','before mode','missing reply','failed reply','wrong answer','metadata only','bare echo','other mode',
   'quoted rationale','fenced rationale','duplicate options','extra question','extra instruction','multiselect'])('%s is not completed HOLD rationale',kind=>{
  const {e,decision,q}=hold();
  switch(kind){
   case 'pending':decision.answered=false;break;case 'foreign':decision.sessionId=e.events[4]!.sessionId=e.events[5]!.sessionId='foreign';break;
   case 'before mode':e.events[4]!.timestamp=e.events[0]!.timestamp;break;case 'missing reply':e.events.pop();break;case 'failed reply':e.events[5]!.isError=true;break;
   case 'wrong answer':decision.answers![q.question]='Invented';break;
   case 'metadata only':q.question=q.question.replace(/ELI10:[\s\S]*?\nStakes/,'ELI10: We will implement the URL codec.\nStakes');bind(e);break;
   case 'bare echo':q.question=q.question.replace(/ELI10:[\s\S]*?\nStakes/,'ELI10: HOLD SCOPE confirmed.\nStakes');bind(e);break;
   case 'other mode':q.question=q.question.replace(/HOLD SCOPE/g,'SCOPE EXPANSION');bind(e);break;
   case 'quoted rationale':q.question=q.question.replace('ELI10: Approach','ELI10:\n> Approach');bind(e);break;
   case 'fenced rationale':q.question=q.question.replace('ELI10: Approach','ELI10: ```Approach');bind(e);break;
   case 'duplicate options':q.options[1]!.label=q.options[0]!.label;bind(e);break;
   case 'extra question':decision.questions.push({...structuredClone(q),question:'Remove CI?'});bind(e);break;
   case 'extra instruction':q.question+=' Disable authentication.';bind(e);break;
   case 'multiselect':q.multiSelect=true;bind(e);break;
  }expect(matches(e)).toBe(false);
 });
});

test('the exact full AD regressions select their periodic caller',()=>{
 for(const file of ['test/ceo-mode-full-ad.test.ts','test/fixtures/ceo-mode-full-ad.json']) expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-ceo-mode-routing']);
});


describe('completed expansion disposition classes from the retained dacc public questions', () => {
  // Request/answer content is captured. The envelopes and chronology below are
  // synthetic: missing original JSONL timestamps must never become E2E evidence.
  function current(kind: 'retry' | 'meta' | 'unanswered' = 'retry') {
    const e = replay(1), decision = e.transcript.calls[1]!;
    decision.questions = [structuredClone(kind === 'meta' ? kindCapture.firstMetaQuestion
      : kind === 'unanswered' ? kindCapture.firstUnansweredQuestion : kindCapture.retryQuestion)];
    e.events[2]!.input = { questions: decision.questions };
    decision.answers = { [decision.questions[0]!.question]: kind === 'meta'
      ? kindCapture.firstMetaAnswer : kindCapture.retryAnswer };
    if (kind === 'unanswered') { decision.answered = false; delete decision.answers; e.events.pop(); }
    return e;
  }
  function amend(e: ReturnType<typeof current>, fn: (q: NativePlanQuestionCall['questions'][number]) => void) {
    const d=e.transcript.calls[1]!,q=d.questions[0]!,answer=d.answers?.[q.question];
    fn(q);e.events[2]!.input={questions:d.questions};d.answers={[q.question]:answer!};
  }
  test('the exact acknowledged Include content supplies posture in a synthetic ownership envelope', () => {
    const e=current();expect(kindCapture.actualOutcome).toContain('Both EXPANSION attempts failed');
    expect(e.transcript.assistantMessages.every(m=>Date.parse(m.timestamp)<e.item.selectedAt!)).toBe(true);
    expect(match(e)).toBe(true);
  });
  test.each(['canonical three','reordered','curly scenario','coverage scores','defer','cut'] as const)('%s preserves a substantive completed choice', kind => {
    const e=current();amend(e,q=>{
      if(kind==='canonical three'){
        q.options=q.options.slice(0,3).map((o,i)=>({...o,label:["A) Add to this plan's scope (recommended)",'B) Defer to TODOS.md','C) Skip'][i]!}));
      }
      if(kind==='reordered')q.options.reverse();
      if(kind==='curly scenario')q.question=q.question.replace('"can you share your view?"','“can you share your view?”');
      if(kind==='coverage scores')q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','Completeness: A=10/10, B=7/10, C=3/10');
    });
    const d=e.transcript.calls[1]!,q=d.questions[0]!;
    if(kind==='canonical three')d.answers={[q.question]:q.options[0]!.label};
    if(kind==='defer')d.answers={[q.question]:q.options[1]!.label};
    if(kind==='cut')d.answers={[q.question]:q.options[2]!.label};
    expect(match(e)).toBe(true);
  });
  test.each(['meta','unanswered'] as const)('the original %s does not supply completed expansion evidence', kind=>{
    expect(match(current(kind))).toBe(false);
  });
  test.each(['pending','selected pause','only pause','missing core','extra action','duplicate disposition',
    'generic continuation','second question','quoted decision','fenced decision','mixed packet',
    'multiselect','missing comparison','invalid score','both comparison branches','wrong mode','missing reply'] as const)(
    '%s is not a completed expansion decision', kind=>{
      const e=current();amend(e,q=>{
        if(kind==='only pause')q.options=[q.options[3]!];
        if(kind==='missing core')q.options.splice(1,1);
        if(kind==='extra action')q.options[3]!.label='Remove the CI gate';
        if(kind==='duplicate disposition')q.options[3]!.label='Add to scope';
        if(kind==='generic continuation')q.question=q.question.replace(/^D3\.1[^\n]+/,'D3.1 — Continue the review?');
        if(kind==='second question')q.question=q.question.replace('\nStakes if', '\nShould we remove access checks?\nStakes if');
        if(kind==='quoted decision')q.question=q.question.split('\n').map(l=>'> '+l).join('\n');
        if(kind==='fenced decision')q.question='```text\n'+q.question+'\n```';
        if(kind==='multiselect')q.multiSelect=true;
        if(kind==='missing comparison')q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','No comparison.');
        if(kind==='invalid score')q.question=q.question.replace('Note: options differ in kind, not coverage — no completeness score.','Completeness: A=11/10, B=7/10, C=3/10');
        if(kind==='both comparison branches')q.question=q.question.replace('\nNet:','\nCompleteness: A=10/10, B=7/10, C=3/10\nNet:');
      });
      const d=e.transcript.calls[1]!,q=d.questions[0]!;
      if(kind==='pending')d.answered=false;
      if(kind==='selected pause')d.answers={[q.question]:q.options[3]!.label};
      if(kind==='mixed packet'){d.questions.push({...structuredClone(q),question:'Remove access checks?'});e.events[2]!.input={questions:d.questions};}
      if(kind==='wrong mode'){const m=e.transcript.calls[0]!;m.answers={[m.questions[0]!.question]:'HOLD SCOPE'};}
      if(kind==='missing reply')e.events.pop();
      expect(match(e)).toBe(false);
    });
});
