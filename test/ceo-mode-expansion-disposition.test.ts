import {describe,expect,test} from 'bun:test';
import captured from './fixtures/ceo-expansion-disposition-77.json';
import {hasNativePostAnswerCeoPosture} from './helpers/ceo-mode-option';
import type {NativePlanQuestionCall,NativePublicToolEvent,PlanCountTranscript} from './helpers/plan-count-transcript';
const posture=/\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
function evidence(){
 const calls=[structuredClone(captured.selected),structuredClone(captured.proposal)] as NativePlanQuestionCall[];
 const events=captured.eventTimes.map(e=>{
  const call=calls.find(c=>c.toolUseId===e.toolUseId)!;
  return e.kind==='use'?{...e,sessionId:call.sessionId,name:'AskUserQuestion',input:{questions:call.questions}}:
   {...e,sessionId:call.sessionId,isError:false,content:captured.resultContentById[e.toolUseId as keyof typeof captured.resultContentById]};
 }) as NativePublicToolEvent[];
 const transcript:PlanCountTranscript={status:'ready',calls,assistantMessages:[]};
 return {transcript,events,proposal:calls[1]!,selected:calls[0]!};
}
function label(v:ReturnType<typeof evidence>,text:string){
 const q=v.proposal.questions[0]!;q.options[0]!.label=text;v.proposal.answers={[q.question]:text};
}
const accepted=(v:ReturnType<typeof evidence>)=>hasNativePostAnswerCeoPosture(v.transcript,'SCOPE EXPANSION',posture,captured.selectionStartedAt,v.events);
describe('completed expansion disposition targets the current plan',()=>{
 test('actual acknowledged shared-views proposal is current expansion posture',()=>{
  const v=evidence();expect(v.proposal.answered).toBe(true);
  expect(v.proposal.answers?.[v.proposal.questions[0]!.question]).toBe('A) Add to this plan (recommended)');
  expect(accepted(v)).toBe(true);
 });
 test.each(['Include','Include in scope','Include in this plan','Include in the plan’s scope','Add to scope','Add to this plan','Add to the plan','Add to this plan’s scope'])('same-plan inclusion disposition: %s',text=>{
  const v=evidence();label(v,text+' (recommended)');expect(accepted(v)).toBe(true);
 });
 test.each(['Add to another plan','Add to that plan','Add to this plan after deployment','Include if tests pass','Do not add to this plan','Defer adding to this plan','Propose adding to this plan','Add to this plan and delete the API','Add to scope; approve production','Include in the other plan','Include in this plan but skip authorization'])('does not infer inclusion from %s',text=>{
  const v=evidence();label(v,text);expect(accepted(v)).toBe(false);
 });
 test('explicit exclusion of this plan still fails even with an inclusion phrase nearby',()=>{
  const v=evidence();label(v,'Add to another plan (not this plan)');expect(accepted(v)).toBe(false);
 });
 test('pending, failed, missing, duplicate or foreign acknowledgments give no posture credit',()=>{
  const variants=[
   (v:ReturnType<typeof evidence>)=>{v.proposal.answered=false;},
   (v:ReturnType<typeof evidence>)=>{v.proposal.failed=true;},
   (v:ReturnType<typeof evidence>)=>{v.events.pop();},
   (v:ReturnType<typeof evidence>)=>{v.events.push({...v.events.at(-1)!});},
   (v:ReturnType<typeof evidence>)=>{v.events.at(-1)!.sessionId='foreign-session';},
   (v:ReturnType<typeof evidence>)=>{v.proposal.answeredAt='2026-09-15T17:14:00.000Z';},
  ];
  for(const mutate of variants){const v=evidence();mutate(v);expect(accepted(v)).toBe(false);}
 });
 test('a different selected mode, bare mode echo, or unbound request remains insufficient',()=>{
  const wrong=evidence();wrong.selected.answers={[wrong.selected.questions[0]!.question]:'HOLD SCOPE'};expect(accepted(wrong)).toBe(false);
  const echo=evidence();echo.proposal.questions[0]!.question='SCOPE EXPANSION confirmed.';expect(accepted(echo)).toBe(false);
  const foreign=evidence();foreign.events[2]={...foreign.events[2]!,input:{questions:[]}};expect(accepted(foreign)).toBe(false);
 });
});
