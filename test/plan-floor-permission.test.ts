import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import * as floor from './helpers/plan-floor-review';
import {resolveEvalModel} from '../lib/eval-model';
import {createPendingQuestionRecorder,recordPendingQuestion,readPendingQuestion} from './helpers/plan-count-pending-question';
import routing from './fixtures/plan-floor-routing-361c.json';
import * as runner from './helpers/claude-pty-runner';
import {createPlanCountFixture} from './helpers/plan-count-fixture';
import {readPlanFloorTarget} from './helpers/plan-floor-target';
import {createFilePermissionRecorder, recordFilePermission, currentFilePermissionBinding} from './helpers/plan-count-file-permission';
import captured from './fixtures/plan-floor-permission-fb10.json';
import {FORCING_FLOOR_CEO, FORCING_FLOOR_ENG, FORCING_FLOOR_DESIGN, FORCING_FLOOR_DEVEX} from './fixtures/forcing-finding-seeds';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'), 'utf8');
const start = source.indexOf('export async function runPlanSkillFloorCheck(');
if (start < 0) throw Error('Missing actual floor runner');
const body = new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start).replace(/^export /, ''));
const QUESTIONS = {
  ceo: {header:'Evidence', question:'The pricing plan has no developer interviews. Should we validate that pricing blocks adoption before launching?',
    multiSelect:false, options:[{label:'Interview developers',description:'Test whether pricing is the adoption barrier before changing the tier.'}, {label:'Launch now',description:'Keep the unvalidated premise and collect evidence after launch.'}]},
  eng: {header:'UUID', question:'The plan repeats a custom generator in each service without a concrete reason. Should we use the built-in generator?',
    multiSelect:false, options:[{label:'Use built-in',description:'Use crypto.randomUUID() and remove unnecessary custom entropy handling.'}, {label:'Keep custom',description:'Retain the custom generator and its maintenance burden.'}]},
  design: {header:'Hierarchy', question:'The primary CTA has the same visual weight as Learn more. Should we make the main action visibly stronger?',
    multiSelect:false, options:[{label:'Emphasize primary CTA',description:'Increase primary contrast and give Learn more a secondary text style.'}, {label:'Keep equal weight',description:'Leave visitors to distinguish equally prominent actions.'}]},
  devex: {header:'First call', question:'Eight manual setup steps and an emailed API key delay the first SDK call. Should we provide a runnable sandbox?',
    multiSelect:false, options:[{label:'Provide sandbox',description:'Supply a hosted sandbox with a copy-pasteable first SDK call.'}, {label:'Keep manual setup',description:'Require all eight setup steps before the first call.'}]},
};
const SEEDS = {ceo:FORCING_FLOOR_CEO, eng:FORCING_FLOOR_ENG, design:FORCING_FLOOR_DESIGN, devex:FORCING_FLOOR_DEVEX};
const SEED_QUOTES = {ceo:"We haven't talked to any developers", eng:'custom UUIDv7 generator inline in each service',
  design:'the CTA button is the same visual weight', devex:'No quickstart command, no hosted sandbox, no copy-pasteable curl example.'};
const render = (question: typeof QUESTIONS.ceo) => ['☐ '+question.header,question.question,
  ...question.options.flatMap((o,i)=>[`${i?' ':'❯'} ${i+1}. ${o.label}`,o.description]),
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
const FINDING = render(QUESTIONS.ceo);
type Mode = 'captured' | 'owned' | 'owned-no-question' | 'foreign' | 'wrong-session' | 'missing-native' | 'linked-target' |
  'native-question' | 'scope' | 'prose' | 'finding' | 'routing' | 'unrelated' | 'partial' | 'quoted' | 'foreign-question' |
  'stale-question' | 'answered-question' | 'failed-question' | 'mismatched-use' | 'duplicate-use' | 'judge-error' | 'mode' | 'pending-hook' | 'failed-hook' | 'packet' | 'prose-quoted' | 'prose-partial' | 'prose-foreign' | 'prose-stale';

// Complete actual floor function; only clock/PTY/public-event and assessor
// boundaries are controlled. Real ownership, permission and viewport parsers run.
// Assessor responses are fixtures, never actual model-quality evidence.
async function exercise(mode: Mode, kind: keyof typeof SEEDS = 'ceo', capture?: typeof routing.captures[number]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-permission-free-'));
  const config = path.join(dir, '.claude');
  let now = Date.now() - (mode.includes('hook') ? 10_000 : 1), launched: any, fixture: ReturnType<typeof createPlanCountFixture> | undefined;
  let screen = '', history = '', granted = false, closed = 0, saved: any;
  const sent: string[] = [], judgments: floor.PlanFloorReview[] = [], tools: any[] = [];
  const recorders: NonNullable<ReturnType<typeof createFilePermissionRecorder>>[] = [];
  let transcript: any = {status:'ready', calls:[], assistantMessages:[]};
  const question = structuredClone(QUESTIONS[kind]);
  class Clock extends Date { static now() { return now; } }
  const boundary = {
    ...runner, fs, path, randomUUID, isDeepStrictEqual, readPendingQuestion, resolveEvalModel,
    pickPlanFloorMode: floor.pickPlanFloorMode, Date: Clock, Bun: {sleep: async (ms: number) => { now += ms; }},
    SANCTIONED_WRITE_SUBSTRINGS: ['gstack-test-plan-', '.claude/plans/'],
    createPlanCountFixture: (seed: string, opts: any) => {
      expect(opts).toMatchObject({nativeReviewOnly:true,preconfiguredReviewActor:true});
      fixture = createPlanCountFixture(seed, opts);
      const config = fs.readFileSync(path.join(fixture.env.GSTACK_HOME,'config.yaml'),'utf8');
      expect(config).toContain('routing_declined: true'); expect(config).toContain('cross_project_learnings: false');
      expect(config).toContain('codex_reviews: disabled'); return fixture;
    },
    readPlanFloorTarget, currentFilePermissionBinding,
    readPlanCountTranscript: (_config: string, _cwd: string, visit?: (event:any)=>void) => {tools.forEach(e=>visit?.(e));return transcript;},
    createPlanCountSnapshotWriter: () => (value: any) => { saved = value; return {}; },
    logPtySnapshot: () => {},
    judgePtyState: () => { throw Error('Generic waiting cannot establish a finding'); },
    judgePlanFloorReview: (input: floor.PlanFloorReview, opts: any) => {
      judgments.push(structuredClone(input));
      expect(opts.model).toBe(resolveEvalModel('warmup')); expect(opts.deadlineAt).toBeGreaterThan(now);
      floor.buildPlanFloorReviewPrompt(input);
      if(mode==='judge-error') throw Error('controlled assessment failure');
      const classification = mode==='routing'||mode==='scope'||mode==='native-question' ? 'setup' :
        mode==='unrelated' ? 'unrelated' : mode==='quoted' ? 'uncertain' : 'finding';
      return floor.validatePlanFloorAssessment(input, classification==='finding' ? {
        kind:'finding',seedQuote:SEED_QUOTES[kind],questionQuote:question.question,
        optionIndex:input.candidate.transport==='native'?1:null,optionQuote:question.options[0].label,
        reason:'Controlled evidence-backed finding assessment',
      } : {kind:classification,seedQuote:'',questionQuote:'',optionIndex:null,optionQuote:'',reason:'Controlled nonfinding assessment'});
    },
    launchClaudePty: async (opts: any) => {
      launched = opts;
      expect(opts.observeSetupQuestions).toBe(true);
      let sequence=0, activeTab=0;
      const sid = opts.extraArgs[1], journal = path.join(config, 'projects', 'owned', sid + '.jsonl');
      fs.mkdirSync(path.dirname(journal), {recursive:true});
      transcript.assistantMessages = [{sessionId:sid, timestamp:new Clock(now).toISOString(), text:'Reviewing the supplied plan.'}];
      const hookRecorder = mode.includes('hook') ? createPendingQuestionRecorder(opts.cwd,config) : undefined;
      if(hookRecorder)recorders.push(hookRecorder as any);
      const publish = (q = question) => {
        const call = {sessionId:mode==='foreign-question'?'foreign':sid,toolUseId:'question'+(++sequence),answered:mode==='answered-question',
          failed:mode==='failed-question',questions:[q]};
        transcript.calls=[call]; tools.splice(0);
        tools.push({sessionId:sid,toolUseId:call.toolUseId,name:'AskUserQuestion',kind:'use',
          timestamp:new Clock(mode==='stale-question'?now-100_000:now).toISOString(),
          input:{questions:mode==='mismatched-use'?[{...q,question:q.question+' different'}]:[q]}});
        if(mode==='duplicate-use')tools.push(structuredClone(tools[0]));
        screen=render(q);
      };
      const expected = opts.observeFilePermissions?.[0];
      if (mode === 'linked-target') {
        const outside = path.join(dir,'outside.md'); fs.writeFileSync(outside,'outside must stay unchanged');
        fs.symlinkSync(outside,expected);
      }
      const pendingFilePermissionFiles = expected ? [(() => {
        const recorder = createFilePermissionRecorder(opts.cwd, config, expected)!;
        recorders.push(recorder);
        if (mode !== 'missing-native') recordFilePermission(JSON.stringify({
          hook_event_name:'PreToolUse', tool_name:'Write', session_id:mode === 'wrong-session' ? 'foreign' : sid,
          tool_use_id:'write1', cwd:opts.cwd,
          transcript_path:mode === 'wrong-session' ? path.join(config,'projects','owned','foreign.jsonl') : journal,
          tool_input:{file_path:expected, content:'not retained in permission metadata'},
        }), recorder.file, opts.cwd, config, expected);
        return {file:recorder.file, expected};
      })()] : [];
      const permissionPath = mode === 'foreign' ? path.join(dir, 'foreign', path.basename(expected ?? 'report.md')) : expected;
      const permission = mode === 'captured' ? captured.rawPermission :
        `Create file\n${permissionPath}\n────────────────\n 1 # Working review\n────────────────\nDo you want to create ${path.basename(permissionPath ?? 'report.md')}?\n❯ 1. Yes\n  2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session\n  3. No\nEsc to cancel · Tab to amend`;
      return {
        hermeticConfigDir: config, pendingFilePermissionFiles, pendingQuestionFile:hookRecorder?.file,
        mark: () => 0, exited: () => false, exitCode: () => null,
        rawOutput: () => history, visibleText: () => history, visibleSince: () => history,
        currentScreen: async () => screen,
        send: (input: string) => {
          sent.push(input);
          if (input === `/plan-${kind}-review PLAN.md\r`) {
            fs.writeFileSync(journal, JSON.stringify({type:'user', isSidechain:false, cwd:opts.cwd, sessionId:sid,
              timestamp:new Clock(now).toISOString(), message:{role:'user', content:`<command-message>plan-${kind}-review</command-message>\n<command-name>/plan-${kind}-review</command-name>\n<command-args>PLAN.md</command-args>`}})+'\n');
            screen = permission;
            if(['finding','unrelated','partial','quoted','foreign-question','stale-question','answered-question','failed-question','mismatched-use','duplicate-use','judge-error'].includes(mode)) {
              if(mode==='partial')question.options[0].description='';
              if(mode==='quoted')question.question='Example from a previous review: '+question.question;
              if(mode==='unrelated')question.question='For OTHER.md, '+question.question;
              publish();
            } else if(mode.includes('hook')) {
              transcript.assistantMessages=[{sessionId:sid,timestamp:new Clock(now).toISOString(),text:'Reviewing the exact owned seed.'}];
              recordPendingQuestion(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',session_id:sid,
                tool_use_id:'hookQuestion',cwd:opts.cwd,transcript_path:journal,tool_input:{questions:[question]}}),hookRecorder!.file,opts.cwd,config);
              if(mode==='failed-hook')transcript.calls=[{sessionId:sid,toolUseId:'hookQuestion',questions:[question],answered:false,failed:true}];
              screen=render(question);
            } else if(mode==='packet') {
              const modeQuestion=(header:string)=>({header,question:'Which CEO review mode should apply to '+header+'?',multiSelect:false,
                options:['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION'].map(label=>({label,description:'Apply this review mode.'}))});
              const questions=[modeQuestion('Mode'),modeQuestion('Confirmation')];
              transcript.calls=[{sessionId:sid,toolUseId:'packet',questions,answered:false,failed:false}];
              tools.push({sessionId:sid,toolUseId:'packet',name:'AskUserQuestion',kind:'use',timestamp:new Clock(now).toISOString(),input:{questions}});
              screen='← ☐ Mode ☐ Confirmation ✔ Submit →\n'+render(questions[0]).split('\n').slice(1).join('\n').replace('↑/↓ to navigate','Tab/Arrow keys to navigate');
            } else if(mode==='mode') {
              publish({header:'Mode',question:'Which CEO review mode should we use?',multiSelect:false,
                options:['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION'].map(label=>({label,description:'Apply this review mode.'}))});
            } else if(mode==='routing') {
              screen=capture!.viewport; transcript.calls=structuredClone(capture!.calls).map(call=>({...call,sessionId:sid}));
              for(const call of transcript.calls)tools.push({sessionId:sid,toolUseId:call.toolUseId,name:'AskUserQuestion',kind:'use',
                timestamp:new Clock(now).toISOString(),input:{questions:call.questions}});
            } else if(mode==='scope') screen='What should I review?\n❯ 1. Current branch diff\n  2. A plan or design doc';
            else if(mode.startsWith('prose')) {
              screen=question.question+'\nA) '+question.options[0].label+' — '+question.options[0].description+'\nB) '+question.options[1].label+' — '+question.options[1].description+'\nReply with A or B.';
              if(mode==='prose-quoted')screen=screen.split('\n').map(line=>'> '+line).join('\n');
              transcript.assistantMessages=[{sessionId:mode==='prose-foreign'?'foreign':sid,
                timestamp:new Clock(mode==='prose-stale'?now-100_000:now).toISOString(),text:screen}];
              if(mode==='prose-partial')screen=screen.split('\n').slice(1).join('\n');
            } else if(mode==='native-question') {
              const q = {header:'Finding',question:`Create file\n${expected}\nDo you want to create ${path.basename(expected)}?`,multiSelect:false,
                options:[{label:'Yes',description:'One review choice.'},{label:'Yes, and always allow access to /tmp',description:'A product permission proposal.'},{label:'No',description:'Keep the existing policy.'}]};
              publish(q); expect(runner.isPermissionDialogVisible(screen)).toBe(true);
            }
            history = screen;
          } else if(mode==='packet' && input==='3') {
            activeTab++;
            if(activeTab===1)screen='← ☒ Mode ☐ Confirmation ✔ Submit →\n'+render(transcript.calls[0].questions[1]).split('\n').slice(1).join('\n').replace('↑/↓ to navigate','Tab/Arrow keys to navigate');
            else if(activeTab===2)screen='← ☒ Mode ☒ Confirmation ✔ Submit →\nReview your answers\nReady to submit your answers?\n❯ 1. Submit';
            else throw Error('Duplicate setup answer');
            history+='\n'+screen;
          } else if((mode==='packet' && input==='\r') || (mode==='mode' && input==='3')) {
            const old=structuredClone(transcript.calls[0]);old.answered=true;old.answers=Object.fromEntries(old.questions.map((q:any)=>[q.question,'HOLD SCOPE']));
            publish();transcript.calls.unshift(old);history+='\n'+screen;
          } else if (input === '1\r') {
            granted = true;
            if(mode==='owned')publish(); else screen='';
            history += '\n' + screen;
          } else throw Error('Unexpected actor input: ' + JSON.stringify(input));
        },
        close: async () => { closed++; },
      };
    },
  };
  const run = new Function(...Object.keys(boundary), body + '\nreturn runPlanSkillFloorCheck;')(...Object.values(boundary));
  try {
    const result = await run({skillName:`plan-${kind}-review`, slashCommand:`/plan-${kind}-review`, followUpPrompt:SEEDS[kind],
      requestedPlanPath:mode === 'captured' ? undefined : `/tmp/gstack-test-plan-${kind}-floor.md`, timeoutMs:100_000});
    expect(closed).toBe(1); expect(fs.existsSync(fixture!.cwd)).toBe(false);
    return {result, sent, judgments, granted, launched, saved, fixture};
  } finally { for (const recorder of recorders) recorder.dispose(); fixture?.cleanup(); fs.rmSync(dir,{recursive:true,force:true}); }
}

test('captured file permission never satisfies the floor through a waiting judge', async () => {
  expect(captured.originalOutcome).toBe('auq_observed');
  expect(runner.isPermissionDialogVisible(captured.rawPermission)).toBe(true);
  const e = await exercise('captured');
  expect(e.result.outcome).toBe('timeout'); expect(e.result.auqObserved).toBe(false);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']); expect(e.judgments).toHaveLength(0);
});
test('one owned native Write grant enables the actual later question without answering it', async () => {
  const e = await exercise('owned');
  expect(e.result.outcome).toBe('auq_observed'); expect(e.granted).toBe(true);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r', '1\r']);
  expect(e.launched.observeFilePermissions).toEqual([e.fixture!.workingPlanPath]);
  expect(path.dirname(e.fixture!.workingPlanPath!)).toBe(e.fixture!.cwd);
  expect(e.saved.observation.transcript.status).toBe('ready'); expect(e.saved.viewport).toBe(FINDING);
});
test.each(['owned-no-question','foreign','wrong-session','missing-native','linked-target'] as Mode[])('%s cannot supply finding credit', async mode => {
  const e = await exercise(mode); expect(e.result.outcome).toBe('timeout');
  expect(e.sent).toEqual(mode === 'owned-no-question' ? ['/plan-ceo-review PLAN.md\r','1\r'] : ['/plan-ceo-review PLAN.md\r']);
  expect(e.judgments).toHaveLength(0);
});
test('an unrelated actual native question cannot spend a file permission or supply finding credit', async () => {
  const e = await exercise('native-question'); expect(e.result.outcome).toBe('timeout');
  expect(e.judgments).toHaveLength(1);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
test('scope gate exclusion and legitimate prose waiting remain distinct', async () => {
  expect((await exercise('scope')).result.outcome).toBe('timeout');
  const e = await exercise('prose'); expect(e.result.outcome).toBe('auq_observed'); expect(e.judgments).toHaveLength(1);
});

for(const capture of routing.captures) test(`captured ${capture.skill} Routing is not a seeded finding`,async()=>{
  expect(capture.originalOutcome).toBe('auq_observed');
  const e=await exercise('routing',capture.skill as keyof typeof SEEDS,capture);
  expect(e.result.auqObserved).toBe(false); expect(e.result.outcome).toBe('timeout');
  expect(e.sent).toEqual([`/plan-${capture.skill}-review PLAN.md\r`]);
  expect(e.judgments).toHaveLength(capture.calls.length?1:0);
});
for(const kind of Object.keys(SEEDS) as (keyof typeof SEEDS)[]) test(`${kind} complete substantive question is assessed without answering`,async()=>{
  const e=await exercise('finding',kind);expect(e.result.outcome).toBe('auq_observed');
  expect(e.judgments).toHaveLength(1);expect(e.judgments[0].candidate).toMatchObject({transport:'native',question:QUESTIONS[kind]});
  expect(e.judgments[0].seed).toContain(SEED_QUOTES[kind]);expect(e.sent).toEqual([`/plan-${kind}-review PLAN.md\r`]);
  expect(e.saved.observation.pendingQuestion.answered).toBe(false);
  expect(e.saved.observation.pendingQuestion.answers).toBeUndefined();
});
test.each(['unrelated','quoted','foreign-question','stale-question','answered-question','failed-question','mismatched-use','duplicate-use','failed-hook'] as Mode[])('%s cannot earn finding credit',async mode=>{
  const e=await exercise(mode);expect(e.result.outcome).toBe('timeout');expect(e.result.auqObserved).toBe(false);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
test.each(['partial','judge-error'] as Mode[])('%s preserves explicit assessment error, snapshot and cleanup',async mode=>{
  const e=await exercise(mode);expect(e.result.outcome).toBe('assessment_error');expect(e.result.auqObserved).toBe(false);
  expect(e.saved.observation.outcome).toBe('assessment_error');expect(e.saved.observation.floorReview).toBeDefined();
});
test('declared HOLD mode is answered once and the later finding stays unanswered',async()=>{
  const e=await exercise('mode');expect(e.result.outcome).toBe('auq_observed');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r','3']);expect(e.judgments).toHaveLength(1);
});

test('owned pending AUQ recorder supplies the complete question before JSONL publishes the call',async()=>{
  const e=await exercise('pending-hook');expect(e.result.outcome).toBe('auq_observed');
  expect(e.saved.observation.transcript.calls).toEqual([]);
  expect(e.saved.observation.pendingQuestion.source).toBe('pre_tool_use');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
test('declared native setup tabs are answered and submitted exactly once before the finding',async()=>{
  const e=await exercise('packet');expect(e.result.outcome,JSON.stringify({sent:e.sent,viewport:e.saved.viewport,pending:e.saved.observation.pendingQuestion})).toBe('auq_observed');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r','3','3','\r']);
  expect(e.judgments).toHaveLength(1);expect(e.saved.observation.pendingQuestion.answered).toBe(false);
});

test.each(['prose-quoted','prose-partial','prose-foreign','prose-stale'] as Mode[])('%s is not a complete current public fallback',async mode=>{
  const e=await exercise(mode);expect(e.result.outcome).toBe('timeout');expect(e.judgments).toHaveLength(0);
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});

for (const [kind, seed] of Object.entries({ceo:FORCING_FLOOR_CEO, eng:FORCING_FLOOR_ENG, design:FORCING_FLOOR_DESIGN, devex:FORCING_FLOOR_DEVEX})) {
  test(`${kind} working-plan request is seeded and committed inside its owned root`, () => {
    const requestedPlanPath = `/tmp/gstack-test-plan-${kind}-floor.md`;
    const fixture = createPlanCountFixture(seed,{requestedPlanPath});
    try {
      expect(fixture.seed).toBe(seed.replace(requestedPlanPath,fixture.workingPlanPath!));
      expect(fs.readFileSync(path.join(fixture.cwd,'PLAN.md'),'utf8')).toBe(fixture.seed);
      expect(fs.readFileSync(path.join(fixture.cwd,'CLAUDE.md'),'utf8')).toContain(fixture.seed);
      const git = Bun.spawnSync(['git','show','HEAD:PLAN.md'],{cwd:fixture.cwd});
      expect(git.exitCode).toBe(0); expect(git.stdout.toString()).toBe(fixture.seed);
      expect(fs.existsSync(fixture.workingPlanPath!)).toBe(false);
    } finally { fixture.cleanup(); }
  });
}
test.each(['relative.md','/tmp/PLAN.md','/tmp/CLAUDE.md','/tmp/a/b/../bad.md','/tmp/.git','/tmp/absent.md'])('invalid or undeclared working-plan target %s fails before launch', requestedPlanPath => {
  expect(() => createPlanCountFixture(FORCING_FLOOR_CEO,{requestedPlanPath})).toThrow();
});
test('duplicate declarations and existing fixture files cannot be rewritten into ambiguous ownership', () => {
  const requestedPlanPath = '/tmp/gstack-test-plan-ceo-floor.md';
  expect(() => createPlanCountFixture(FORCING_FLOOR_CEO+'\n'+requestedPlanPath,{requestedPlanPath})).toThrow();
  expect(() => createPlanCountFixture(FORCING_FLOOR_CEO,{requestedPlanPath,files:{'gstack-test-plan-ceo-floor.md':'different source'}})).toThrow();
});

test.each(['auq_observed','timeout','throw'])('all four actual floor registrations keep the declared actor and %s outcome', outcome => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'floor-registration-free-'));
  const worker = path.join(dir,'registrations.test.ts'), facts = path.join(dir,'calls.jsonl');
  const files = ['ceo','eng','design','devex'].map(kind => path.join(ROOT,`test/skill-e2e-plan-${kind}-finding-floor.test.ts`));
  try {
    for (const file of files) expect(fs.statSync(file).isFile()).toBe(true);
    fs.writeFileSync(worker, `
import {describe,expect,mock} from 'bun:test';
import fs from 'node:fs';
import {CAPTURE_LONG_MS} from ${JSON.stringify(path.join(ROOT,'test/helpers/eval-budgets.ts'))};
mock.module(${JSON.stringify(path.join(ROOT,'test/helpers/e2e-gate.ts'))},()=>({describeE2ETier:()=>describe}));
mock.module(${JSON.stringify(path.join(ROOT,'test/helpers/claude-pty-runner.ts'))},()=>({runPlanSkillFloorCheck:async opts=>{
  const kind=/^plan-(ceo|eng|design|devex)-review$/.exec(opts.skillName)?.[1];
  expect(kind).toBeDefined();
  expect(opts.requestedPlanPath).toBe('/tmp/gstack-test-plan-'+kind+'-floor.md');
  expect(opts.followUpPrompt.split(opts.requestedPlanPath)).toHaveLength(2);
  expect(opts.timeoutMs).toBe(CAPTURE_LONG_MS);
  expect(opts.env).toEqual({QUESTION_TUNING:'false',EXPLAIN_LEVEL:'default'});
  fs.appendFileSync(${JSON.stringify(facts)},JSON.stringify({kind,path:opts.requestedPlanPath})+'\\n');
  if(${JSON.stringify(outcome)}==='throw')throw Error('controlled runner failure');
  return {outcome:${JSON.stringify(outcome)},auqObserved:${outcome === 'auq_observed'},elapsedMs:1,summary:'controlled outcome',evidence:'fixture'};
}}));
${files.map(file => `await import(${JSON.stringify(file)});`).join('\n')}
`);
    const result = Bun.spawnSync([process.execPath,'test',worker],{cwd:ROOT,timeout:20_000,
      env:{PATH:process.env.PATH ?? '',HOME:dir,TMPDIR:dir,TEMP:dir,TMP:dir,GIT_CONFIG_NOSYSTEM:'1',
        ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {})}});
    const output = result.stdout.toString()+result.stderr.toString();
    expect(result.exitCode,output).toBe(outcome === 'auq_observed' ? 0 : 1);
    expect(fs.readFileSync(facts,'utf8').trim().split('\n').map(line=>JSON.parse(line).kind).sort())
      .toEqual(['ceo','design','devex','eng']);
    if(outcome !== 'auq_observed') expect(output).toContain(outcome === 'throw' ? 'controlled runner failure' : 'floor test FAILED: outcome=timeout');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},25_000);
