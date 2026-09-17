import {expect,test} from 'bun:test';
import {buildPlanFloorReviewPrompt,validatePlanFloorAssessment,judgePlanFloorReview,pickPlanFloorMode,type PlanFloorReview} from './helpers/plan-floor-review';
import {FORCING_FLOOR_CEO} from './fixtures/forcing-finding-seeds';
const review = ():PlanFloorReview=>({seed:FORCING_FLOOR_CEO,candidate:{transport:'native',identity:'owned:call:question:0',question:{
  header:'Evidence',question:'Pricing is assumed to block adoption without developer interviews. Should we test that premise before launch?',multiSelect:false,
  options:[{label:'Interview developers',description:'Validate pricing as a barrier before changing the tier.'},{label:'Ship the tier',description:'Launch using the current untested premise.'}],
}}});
const finding=()=>({kind:'finding',seedQuote:"We haven't talked to any developers",questionQuote:'Should we test that premise before launch?',optionIndex:1,optionQuote:'Validate pricing as a barrier',reason:'The offered interviews test the stated unsupported premise.'});
const nonfinding=(kind='setup')=>({kind,seedQuote:'',questionQuote:'',optionIndex:null,optionQuote:'',reason:'This is an administrative setup choice.'});

test('complete native payload and seed reach the assessor without a fabricated answer',()=>{
 const input=review(),prompt=buildPlanFloorReviewPrompt(input);
 expect(prompt.endsWith(JSON.stringify(input))).toBe(true);
 expect(prompt).toContain('No answer has been supplied');
 expect(prompt).toContain('Mentioning a real problem within a setup question does not make it a finding');
 expect(JSON.parse(prompt.slice(prompt.indexOf('Evidence JSON:\n')+15))).toEqual(input);
 expect(validatePlanFloorAssessment(input,finding())).toEqual(finding());
});
test.each(['setup','unrelated','uncertain'])('%s is explicit zero finding credit',kind=>{
 expect(validatePlanFloorAssessment(review(),nonfinding(kind))).toEqual(nonfinding(kind));
 expect(()=>validatePlanFloorAssessment(review(),{...nonfinding(kind),seedQuote:'More signups.'})).toThrow();
});
test.each([
 ['missing seed quote',{seedQuote:''}],['invented seed quote',{seedQuote:'There are ten interviews already.'}],
 ['wrong question quote',{questionQuote:'Would dark mode help?'}],['cross-option evidence',{optionIndex:2}],
 ['missing option',{optionIndex:null}],['zero index',{optionIndex:0}],['fractional index',{optionIndex:1.5}],
 ['outside option',{optionIndex:3}],['invented option',{optionQuote:'Add analytics only'}],['empty reason',{reason:''}],
 ['fabricated answer',{answer:'A'}],['unknown result',{kind:'waiting'}],
] as const)('%s fails closed',(_label,delta)=>{
 expect(()=>validatePlanFloorAssessment(review(),{...finding(),...delta})).toThrow();
});
test('wrong seed and missing/partial native fields cannot claim evidence',()=>{
 expect(()=>validatePlanFloorAssessment({...review(),seed:'A different plan about storage'},finding())).toThrow();
 for(const change of [(q:any)=>q.header='',(q:any)=>q.question='',(q:any)=>q.options.pop(),
   (q:any)=>q.options[0].description='',(q:any)=>delete q.options[0].description,
   (q:any)=>q.options[1].label=q.options[0].label]){
  const input=review();change((input.candidate as any).question);expect(()=>buildPlanFloorReviewPrompt(input)).toThrow();
 }
});
test('complete prose fallback requires exact current question and remedy evidence',()=>{
 const native=review().candidate as any;
 const text=native.question.question+'\nA) Interview developers: Validate pricing as a barrier before launch.\nB) Ship the tier.';
 const input:PlanFloorReview={seed:FORCING_FLOOR_CEO,candidate:{transport:'prose',identity:'owned:public-message',text}};
 expect(validatePlanFloorAssessment(input,{...finding(),optionIndex:null}).kind).toBe('finding');
 expect(()=>validatePlanFloorAssessment(input,finding())).toThrow();
 expect(()=>validatePlanFloorAssessment({...input,candidate:{...input.candidate,text:'A) Partial menu'}},{...finding(),optionIndex:null})).toThrow();
});
test('large complete input is preserved; over-limit input is rejected without invoking a judge',()=>{
 const input=review();input.seed+='\n'+'.'.repeat(40_000)+'END OF SOURCE';
 expect(buildPlanFloorReviewPrompt(input)).toContain('END OF SOURCE');
 input.seed+='x'.repeat(256*1024);let calls=0;
 expect(()=>judgePlanFloorReview(input,{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,invoke:(()=>{calls++;throw Error('must not execute');}) as any})).toThrow();
 expect(calls).toBe(0);
});
test('replacement judge retains the original CLI model, one turn, 30s cap and absolute case deadline',()=>{
 for(const remaining of [5000,60_000]){
  const deadlineAt=Date.now()+remaining;let calls=0;
  const actual=judgePlanFloorReview(review(),{binary:'/fake/claude',model:'unchanged-warmup',deadlineAt,invoke:((file,args,opts)=>{
   calls++;expect(file).toBe('/fake/claude');expect(args).toEqual(['-p','--model','unchanged-warmup','--max-turns','1']);
   expect(opts.stdio).toEqual(['pipe','pipe','pipe']);expect(opts.encoding).toBe('utf8');
   expect(opts.input).toBe(buildPlanFloorReviewPrompt(review()));
   expect(opts.timeout).toBeGreaterThan(0);expect(opts.timeout).toBeLessThanOrEqual(Math.min(30_000,remaining));
   return {status:0,stdout:JSON.stringify(finding()),stderr:''};
  }) as any});expect(calls).toBe(1);expect(actual.kind).toBe('finding');
 }
});
test.each([
 ['nonzero',{status:1,stdout:'',stderr:'real stderr detail'}],
 ['runner error',{status:null,error:Error('runner failed'),stdout:'',stderr:''}],
 ['invalid JSON',{status:0,stdout:'waiting',stderr:''}],
 ['missing evidence',{status:0,stdout:JSON.stringify({...finding(),seedQuote:''}),stderr:''}],
] as const)('%s retains an explicit failure',(_label,result)=>{
 expect(()=>judgePlanFloorReview(review(),{binary:'fake',model:'warmup',deadlineAt:Date.now()+30_000,invoke:(()=>result) as any})).toThrow();
});
test('an exhausted deadline starts no assessment process',()=>{
 let calls=0;expect(()=>judgePlanFloorReview(review(),{binary:'fake',model:'warmup',deadlineAt:Date.now()-1,invoke:(()=>{calls++;}) as any})).toThrow('deadline');expect(calls).toBe(0);
});
test('only complete closed declared mode choices can be answered',()=>{
 const q=(labels:string[])=>({header:'Mode',question:'Which review mode should we use?',multiSelect:false,options:labels.map(label=>({label,description:'Apply this review mode.'}))});
 const ceo=q(['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION']);
 expect(pickPlanFloorMode('plan-ceo-review',ceo)).toBe(3);
 expect(pickPlanFloorMode('plan-devex-review',q(['DX TRIAGE','DX POLISH','DX EXPANSION']))).toBe(2);
 expect(pickPlanFloorMode('plan-eng-review',q(['SMALL_CHANGE','BIG_CHANGE (recommended)']))).toBe(2);
 for(const question of [{...ceo,multiSelect:true},{...ceo,options:ceo.options.slice(0,3)},q(['HOLD SCOPE','HOLD SCOPE','SELECTIVE EXPANSION','SCOPE REDUCTION']),q(['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE and approve launch','SCOPE REDUCTION'])])
  expect(pickPlanFloorMode('plan-ceo-review',question)).toBeNull();
 expect(pickPlanFloorMode('unknown',ceo)).toBeNull();
});
