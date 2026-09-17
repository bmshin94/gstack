import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
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
const FINDING = '☐ Finding\nWhich validation should protect the metric?\n❯ 1. Validate inputs\n  2. Keep current behavior\nEnter to select · ↑/↓ to navigate · Esc to cancel';
type Mode = 'captured' | 'owned' | 'owned-no-question' | 'foreign' | 'wrong-session' | 'missing-native' | 'linked-target' | 'native-question' | 'scope' | 'prose';

// Run the complete actual floor function with a clock/PTY boundary adapter.
// Real target binding, exact permission epochs and UI parsers remain in use;
// neither a model nor a shell process can be launched by this adapter.
async function exercise(mode: Mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-permission-free-'));
  const config = path.join(dir, '.claude');
  let now = Date.now() - 1, launched: any, fixture: ReturnType<typeof createPlanCountFixture> | undefined;
  let screen = '', history = '', granted = false, closed = 0, saved: any;
  const sent: string[] = [], judgments: string[] = [];
  const recorders: NonNullable<ReturnType<typeof createFilePermissionRecorder>>[] = [];
  let transcript: any = {status:'ready', calls:[], assistantMessages:[]};
  class Clock extends Date { static now() { return now; } }
  const boundary = {
    ...runner, fs, path, randomUUID, Date: Clock, Bun: {sleep: async (ms: number) => { now += ms; }},
    SANCTIONED_WRITE_SUBSTRINGS: ['gstack-test-plan-', '.claude/plans/'],
    createPlanCountFixture: (seed: string, opts: any) => (fixture = createPlanCountFixture(seed, opts)),
    readPlanFloorTarget, currentFilePermissionBinding,
    readPlanCountTranscript: () => transcript,
    createPlanCountSnapshotWriter: () => (value: any) => { saved = value; return {}; },
    logPtySnapshot: () => {},
    judgePtyState: (text: string) => { judgments.push(text); return {state:'waiting', reasoning:'controlled waiting classifier'}; },
    launchClaudePty: async (opts: any) => {
      launched = opts;
      const sid = opts.extraArgs[1], journal = path.join(config, 'projects', 'owned', sid + '.jsonl');
      fs.mkdirSync(path.dirname(journal), {recursive:true});
      transcript.assistantMessages = [{sessionId:sid, timestamp:new Date().toISOString(), text:'Reviewing the supplied plan.'}];
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
        hermeticConfigDir: config, pendingFilePermissionFiles,
        mark: () => 0, exited: () => false, exitCode: () => null,
        rawOutput: () => history, visibleText: () => history, visibleSince: () => history,
        currentScreen: async () => screen,
        send: (input: string) => {
          sent.push(input);
          if (input === '/plan-ceo-review PLAN.md\r') {
            fs.writeFileSync(journal, JSON.stringify({type:'user', isSidechain:false, cwd:opts.cwd, sessionId:sid,
              timestamp:new Clock(now).toISOString(), message:{role:'user', content:'<command-message>plan-ceo-review</command-message>\n<command-name>/plan-ceo-review</command-name>\n<command-args>PLAN.md</command-args>'}})+'\n');
            screen = mode === 'scope' ? 'What should I review?\n❯ 1. Current branch diff\n  2. A plan or design doc' :
              mode === 'prose' ? 'I need your choice about which metric to validate.' :
              permission;
            if (mode === 'native-question') {
              const question = `Create file\n${expected}\nDo you want to create ${path.basename(expected)}?`;
              const options = [{label:'Yes',description:'One review choice.'},
                {label:'Yes, and always allow access to /tmp',description:'A proposal about the product permission policy.'},
                {label:'No',description:'Keep the existing policy.'}];
              transcript.calls = [{sessionId:sid, toolUseId:'question1', answered:false, failed:false,
                questions:[{header:'Finding',question,multiSelect:false,options}]}];
              screen = ['☐ Finding',question,...options.map((o,i)=>`${i?' ':'❯'} ${i+1}. ${o.label}`),
                'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
              expect(runner.isPermissionDialogVisible(screen)).toBe(true);
            }
            history = screen;
          } else if (input === '1\r') {
            granted = true;
            screen = mode === 'owned' ? FINDING : '';
            history += '\n' + screen;
          } else throw Error('Unexpected actor input: ' + JSON.stringify(input));
        },
        close: async () => { closed++; },
      };
    },
  };
  const run = new Function(...Object.keys(boundary), body + '\nreturn runPlanSkillFloorCheck;')(...Object.values(boundary));
  try {
    const result = await run({skillName:'plan-ceo-review', slashCommand:'/plan-ceo-review', followUpPrompt:FORCING_FLOOR_CEO,
      requestedPlanPath:mode === 'captured' ? undefined : '/tmp/gstack-test-plan-ceo-floor.md', timeoutMs:100_000});
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
test('an actual native question is observed without spending a file permission', async () => {
  const e = await exercise('native-question'); expect(e.result.outcome).toBe('auq_observed');
  expect(e.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
});
test('scope gate exclusion and legitimate prose waiting remain distinct', async () => {
  expect((await exercise('scope')).result.outcome).toBe('timeout');
  const e = await exercise('prose'); expect(e.result.outcome).toBe('auq_observed'); expect(e.judgments).toHaveLength(1);
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
