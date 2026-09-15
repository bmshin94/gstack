import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAutoplanArtifactRecorder, recordAutoplanArtifact, autoplanArtifactRecorderStatus, readPendingAutoplanArtifact } from './helpers/autoplan-artifact-recorder';
import { createPlanCountPermissionGuard, classifyPlanCountFrame, runPlanSkillCounting } from './helpers/claude-pty-runner';
import { readPlanCountTranscript } from './helpers/plan-count-transcript';
import fixture from './fixtures/eng-test-plan-edit-dacc.json';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

// Tool IDs, requested edits, preceding actual successes and their ordering are
// captured. Paths, clock, hook envelope and message/request IDs are explicitly
// synthetic fixture scaffolding; no result is invented for the pending Edit.
function replay(kind = 'owned', dual = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-qa-edit-'));
  const cwd = path.join(root, path.basename(fixture.cwd));
  const config = path.join(root, 'config'), stateRoot = path.join(root, '.gstack');
  fs.mkdirSync(cwd); fs.mkdirSync(stateRoot);
  const primaryRoot = dual ? path.join(root, 'native-state') : stateRoot;
  if (dual) fs.mkdirSync(primaryRoot);
  const qaRoot = dual ? stateRoot : undefined;
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalRoot = fixture.file.slice(0, fixture.file.indexOf('/projects/'));
  const target = path.join(stateRoot, path.relative(originalRoot, fixture.file));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, fixture.before);
  const nativeEvents = structuredClone(fixture.publicEvents) as any[];
  const now = Date.now(), delta = now - 1000 - Date.parse(nativeEvents.at(-1).timestamp);
  const start = fixture.commandStartedAt + delta;
  const uses = new Map<string, any>();
  const events = nativeEvents.map((event, index) => {
    const timestamp = new Date(Date.parse(event.timestamp) + delta).toISOString();
    if (event.type === 'tool_use') {
      const input = { ...event.input, file_path: event.input.file_path.replace(originalRoot, stateRoot) };
      const use = { kind: 'use', sessionId: event.sessionId, toolUseId: event.id, name: event.name, input, timestamp,
        messageId: `msg_replay_${index}`, requestId: `req_replay_${index}` };
      uses.set(event.id, use); return use;
    }
    const owner = uses.get(event.tool_use_id)!;
    return { kind: 'result', sessionId: owner.sessionId, toolUseId: event.tool_use_id, timestamp,
      isError: event.is_error, content: event.content };
  });
  const current = events.at(-1)! as any;
  if (kind === 'foreign') current.input.file_path = path.join(root, 'foreign.md');
  if (kind === 'sibling') current.input.file_path = target.replace(path.basename(cwd), 'sibling-project');
  if (kind === 'ceo' || kind === 'ceo-default' || kind === 'native-ceo' || kind === 'native-qa') {
    const foreign = path.join(kind.startsWith('native-') ? primaryRoot : stateRoot, 'projects', path.basename(cwd),
      ...(kind === 'native-qa' ? [path.basename(target)] : ['ceo-plans', '2026-09-15-plan.md']));
    fs.mkdirSync(path.dirname(foreign), { recursive: true }); fs.writeFileSync(foreign, fixture.before);
    for (const event of events) if ((event as any).input?.file_path === target) (event as any).input.file_path = foreign;
    fs.utimesSync(foreign, new Date(now - 2000), new Date(now - 2000));
  }
  if (kind === 'config') current.input.file_path = path.join(stateRoot, 'config.json');
  if (kind === 'symlink') {
    const moved = target + '.real'; fs.renameSync(target, moved); fs.symlinkSync(moved, target);
  }
  if (kind === 'no-success') events.splice(0, events.length - 1);
  if (kind === 'failed-success') for (const event of events) if (event.kind === 'result') event.isError = true;
  if (kind === 'already-complete') events.push({ kind: 'result', sessionId: current.sessionId,
    toolUseId: current.toolUseId, timestamp: new Date(now - 500).toISOString(), isError: false } as any);
  if (kind === 'missing-public-identity') delete current.messageId;
  const journal = path.join(config, 'projects', 'fixture', current.sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, events.map((event: any) => JSON.stringify({ cwd, sessionId: event.sessionId,
    isSidechain: false, timestamp: event.timestamp, requestId: event.requestId,
    message: event.kind === 'use' ? { role: 'assistant', id: event.messageId,
      content: [{ type: 'tool_use', id: event.toolUseId, name: event.name, input: event.input }] } :
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: event.toolUseId, content: event.content, is_error: event.isError }] },
  })).join('\n') + '\n');
  fs.utimesSync(target, new Date(now - 2000), new Date(now - 2000));
  const clock = Date.now; Date.now = () => start;
  let recorder: ReturnType<typeof createAutoplanArtifactRecorder>;
  try { recorder = createAutoplanArtifactRecorder(cwd, config, primaryRoot, true, !dual && kind !== 'ceo-default', qaRoot); recorder.startEditApproval!(start); }
  finally { Date.now = clock; }
  cleanups.push(recorder!.dispose);
  const hook = { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: current.sessionId,
    tool_use_id: current.toolUseId, cwd, transcript_path: journal, tool_input: { ...current.input } };
  if (kind === 'changed-input') hook.tool_input.new_string = 'A different request';
  const invoke = () => recordAutoplanArtifact(JSON.stringify(hook), recorder!.file, cwd, config, primaryRoot, true, !dual && kind !== 'ceo-default', qaRoot);
  return { root, cwd, config, stateRoot: primaryRoot, qaRoot, start, target, journal, recorder: recorder!, hook, invoke, current };
}

test('exact captured second QA Edit has no result; its native request receives one scoped approval', () => {
  const r = replay(), before = fs.readFileSync(r.target), journal = fs.readFileSync(r.journal);
  expect(fixture.originalOutcome.outcome).toBe('timeout');
  expect(r.current.toolUseId).toBe('toolu_01SEAYuQ8CwCLoncZH84P8Xe');
  expect(r.invoke()).toBe(true);
  expect(r.invoke()).not.toBe(true);
  expect(autoplanArtifactRecorderStatus(r.recorder.file, r.cwd, r.config, r.stateRoot).status).toBe('pending');
  expect(fs.readFileSync(r.target)).toEqual(before); expect(fs.readFileSync(r.journal)).toEqual(journal);
  const transcript = readPlanCountTranscript(r.config, r.cwd);
  expect(transcript.calls).toHaveLength(0); // Permission metadata is never answer/count credit.
});

for (const kind of ['foreign', 'sibling', 'ceo', 'config', 'symlink', 'no-success', 'failed-success',
  'already-complete', 'missing-public-identity', 'changed-input']) test('Eng QA approval rejects ' + kind, () => {
  const r = replay(kind); expect(r.invoke()).not.toBe(true);
});

test('actual standalone hook command keeps the path filter and emits only native one-time approval', () => {
  const r = replay();
  const command = r.recorder.hooks.PreToolUse[0]!.hooks[0]!.command;
  expect(command).toContain('--eng-test-plan-only');
  const result = spawnSync('bash', ['-c', command], { cwd: r.cwd, input: JSON.stringify(r.hook), encoding: 'utf8', timeout: 6000 });
  expect(result.status).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
});

test('the captured repeated viewport cannot authorize a new request by itself', () => {
  const guard = createPlanCountPermissionGuard();
  expect(classifyPlanCountFrame(fixture.viewport)).toBeNull();
  expect(guard(fixture.viewport)).toBeNull();
  expect(guard(fixture.viewport)).toBeNull();
  const r = replay(); expect(r.invoke()).toBe(true); expect(r.invoke()).not.toBe(true);
});

test('the declared opt-in rejects another skill before fixture or model startup', async () => {
  await expect(runPlanSkillCounting({ skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review',
    followUpPrompt: 'Unused', expectedPlanPath: '/tmp/unused.md', approveEngTestPlanEdits: true,
    isLastStep0AUQ: () => false, reviewCountCeiling: 7 })).rejects.toThrow('Eng test-plan approval');
});

test('actual caller declares QA support without changing its budgets or expected report', () => {
  const caller = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-eng-finding-count.test.ts'), 'utf8');
  expect(caller).toContain('approveEngTestPlanEdits: true');
  expect(caller).toContain('expectedPlanPath: planPath');
  expect(caller).toContain('timeoutMs: 1_500_000');
});


test('default Autoplan scope still accepts its owned CEO artifact, while Eng scope rejects it', () => {
  const legacy = replay('ceo-default'); expect(legacy.invoke()).toBe(true);
  const eng = replay('ceo'); expect(eng.invoke()).not.toBe(true);
});

for (const kind of ['owned', 'native-ceo', 'native-qa', 'ceo', 'foreign', 'symlink', 'changed-input'])
test('Autoplan two-root approval is kind-bound: ' + kind, () => {
  const r = replay(kind, true);
  expect(r.invoke() === true).toBe(kind === 'owned' || kind === 'native-ceo');
  expect(r.invoke()).not.toBe(true);
});

test('two-root metadata requires the bound QA root and exposes only the same native pending request', () => {
  const r = replay('owned', true); expect(r.invoke()).toBe(true);
  expect(autoplanArtifactRecorderStatus(r.recorder.file, r.cwd, r.config, r.stateRoot, r.qaRoot)).toEqual({ status: 'pending' });
  expect(autoplanArtifactRecorderStatus(r.recorder.file, r.cwd, r.config, r.stateRoot).status).toBe('invalid');
  const tools: any[] = []; readPlanCountTranscript(r.config, r.cwd, event => tools.push(event));
  expect(readPendingAutoplanArtifact(r.recorder.file, r.cwd, r.config, r.stateRoot, r.start, tools, Date.now(), true, r.qaRoot)?.toolUseId).toBe(r.current.toolUseId);
  expect(readPendingAutoplanArtifact(r.recorder.file, r.cwd, r.config, r.stateRoot, r.start, tools, Date.now(), true)).toBeUndefined();
});

test('one queue cannot approve a second-root mutation while the current Edit is pending', () => {
  const r = replay('owned', true); expect(r.invoke()).toBe(true);
  r.hook.tool_use_id = 'other_native_edit';
  r.hook.tool_input.file_path = path.join(r.stateRoot, 'projects', path.basename(r.cwd), 'ceo-plans', '2026-09-15-plan.md');
  expect(r.invoke()).not.toBe(true);
  expect(autoplanArtifactRecorderStatus(r.recorder.file, r.cwd, r.config, r.stateRoot, r.qaRoot)).toEqual({ status: 'invalid', reason: 'concurrent_pending' });
});

// This exercises the actual count loop and native hook command, using a fake
// CLI only. The short journal is synthetic launch scaffolding; the full exact
// public chronology is replayed separately above.
test.skipIf(process.platform === 'win32')('real count launcher scopes QA approval to its HOME artifact and starts it at the slash command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-qa-launch-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'fake-claude');
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const fixture=JSON.parse(fs.readFileSync(process.env.QA_FIXTURE,'utf8'));
const args=process.argv.slice(2),settings=JSON.parse(args[args.indexOf('--settings')+1]);
const hook=settings.hooks?.PreToolUse?.flatMap(e=>e.hooks).find(h=>h.command.includes('autoplan-artifact-recorder.ts'));
const result={pid:process.pid,cwd:process.cwd(),home:process.env.HOME,nativeState:process.env.GSTACK_HOME,hook:hook?.command};
const save=()=>fs.writeFileSync(process.env.QA_RESULT,JSON.stringify(result));
save();
process.stdin.setRawMode(true);process.stdin.resume();
let received='';
process.stdin.on('data',async bytes=>{
 received+=bytes.toString();if(!received.includes('\r')||result.input)return;
 result.input=received;
 try {
  if(hook){
   const stateFile=/'--record' '([^']+)'/.exec(hook.command)?.[1];
   const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
   result.approvalStartedAt=state.approvalStartedAt;result.commandReceivedAt=Date.now();result.boundRoot=state.stateRoot;
   const sourceRoot=process.env.QA_MODE==='native-state'?process.env.GSTACK_HOME:path.join(process.env.HOME,'.gstack');
   const target=path.join(sourceRoot,'projects',path.basename(process.cwd()),path.basename(fixture.file));
   result.target=target;fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,fixture.before);
   const current=fixture.publicEvents.at(-1),sid=current.sessionId;
   const journal=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','qa-launch',sid+'.jsonl');
   fs.mkdirSync(path.dirname(journal),{recursive:true});
   const time=state.approvalStartedAt;
   const use=(id,input,offset,name='Edit')=>({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(time+offset).toISOString(),requestId:'req_launch_'+offset,
    message:{role:'assistant',id:'msg_launch_'+offset,content:[{type:'tool_use',id,name,input}]}});
   const ack=(id,offset)=>({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date(time+offset).toISOString(),
    message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:false,content:'Synthetic fixture write succeeded'}]}});
   const input={...current.input,file_path:target};
   const rows=process.env.QA_MODE==='withheld'?[]:[use('prior_write',{file_path:target,content:fixture.before},1,'Write'),ack('prior_write',2)];
   rows.push(use(current.id,input,3));fs.writeFileSync(journal,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
   await Bun.sleep(20);
   const event={hook_event_name:'PreToolUse',tool_name:'Edit',session_id:sid,tool_use_id:current.id,cwd:process.cwd(),transcript_path:journal,tool_input:input};
   const invoke=()=>spawnSync('bash',['-c',hook.command],{input:JSON.stringify(event),encoding:'utf8',timeout:6000});
   const first=invoke(),repeat=invoke();result.first=first.stdout;result.repeat=repeat.stdout;result.hookStatuses=[first.status,repeat.status];
   result.unchanged=fs.readFileSync(target,'utf8')===fixture.before;
   if(first.stdout){
    fs.writeFileSync(target,fixture.before.replace(input.old_string,input.new_string));
    fs.appendFileSync(journal,JSON.stringify(ack(current.id,Date.now()-time))+'\n');
    event.hook_event_name='PostToolUse';
    result.postStatus=spawnSync('bash',['-c',hook.command],{input:JSON.stringify(event),encoding:'utf8',timeout:6000}).status;
   }
   result.stateFile=stateFile;
  }
 }catch(error){result.error=String(error);}
 save();setTimeout(()=>process.exit(0),100);
});
process.on('SIGINT',()=>process.exit(0));
`, { mode: 0o755 });
  const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
  const variants = ['owned', 'default', 'native-state', 'withheld'];
  const results = await Promise.allSettled(variants.map(async variant => {
    const dir = path.join(root, variant); fs.mkdirSync(dir);
    const resultFile = path.join(dir, 'result.json'), worker = path.join(dir, 'worker.ts');
    fs.writeFileSync(worker, `import fs from 'node:fs';\nimport {runPlanSkillCounting,resolveClaudeBinary} from ${JSON.stringify(runner)};\n` +
      `if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake CLI binding');\n` +
      `const result=await runPlanSkillCounting({skillName:'plan-eng-review',slashCommand:'/plan-eng-review',followUpPrompt:'Synthetic QA permission fixture',expectedPlanPath:${JSON.stringify(path.join(dir, 'report.md'))},approveEngTestPlanEdits:${variant !== 'default'},isLastStep0AUQ:()=>false,reviewCountCeiling:12,timeoutMs:18000,env:{QA_RESULT:${JSON.stringify(resultFile)},QA_MODE:${JSON.stringify(variant)},QA_FIXTURE:${JSON.stringify(path.join(import.meta.dir, 'fixtures/eng-test-plan-edit-dacc.json'))}}});\n` +
      `fs.writeFileSync(${JSON.stringify(path.join(dir, 'observation.json'))},JSON.stringify(result));\n`);
    const child = Bun.spawn([process.execPath, worker], { cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1', EVALS: '', EVALS_RUN_ID: '', TMPDIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 23000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(0);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      const observation = JSON.parse(fs.readFileSync(path.join(dir, 'observation.json'), 'utf8'));
      expect(result.error).toBeUndefined(); expect(result.input).toBe('/plan-eng-review\r');
      expect(observation.reviewCount).toBe(0); expect(observation.step0Count).toBe(0);
      expect(observation.outcome).toBe(variant === 'withheld' ? 'artifact_permission_failed' : 'exited');
      if (variant === 'default') expect(result.hook).toBeUndefined();
      else {
        expect(result.hook).toContain('--eng-test-plan-only');
        expect(result.boundRoot).toBe(path.join(result.home, '.gstack'));
        expect(result.boundRoot).not.toBe(result.nativeState);
        expect(result.approvalStartedAt).toBeLessThanOrEqual(result.commandReceivedAt);
        expect(result.commandReceivedAt - result.approvalStartedAt).toBeLessThan(2000);
        expect(result.first ? JSON.parse(result.first).hookSpecificOutput.permissionDecision : null).toBe(variant === 'owned' ? 'allow' : null);
        expect(result.repeat).toBe(''); expect(result.hookStatuses).toEqual([0, 0]);
        expect(result.unchanged).toBe(true); expect(fs.existsSync(result.stateFile)).toBe(false);
      }
      expect(fs.existsSync(result.cwd)).toBe(false);
      expect(() => process.kill(result.pid, 0)).toThrow();
    } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}, 26000);
