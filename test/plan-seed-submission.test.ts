import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { submitPlanSeed } from './helpers/plan-seed-submission';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import { runPlanSkillObservation, isProseAUQVisible, isNumberedOptionListVisible, isPermissionDialogVisible } from './helpers/claude-pty-runner';

// A real PTY process consumes the actual paste/Enter/slash bytes and publishes
// its own PID status and transcript. No provider or runner hooks are installed.
const CLI = String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
const dir=process.env.CLAUDE_CONFIG_DIR, scenario=process.env.SEED_CASE;
const sid='aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', cwd=process.cwd();
const file=path.join(dir,'projects','fixture',sid+'.jsonl');
const events=path.join(dir,'events.jsonl'), statusFile=path.join(dir,'sessions',process.pid+'.json');
fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(statusFile),{recursive:true});
const status={pid:process.pid,sessionId:sid,cwd,startedAt:Date.now(),kind:'interactive',entrypoint:'cli',version:'fixture',
 procStart:process.platform==='linux'?fs.readFileSync('/proc/self/stat','utf8').split(') ').pop().split(' ')[19]:'opaque-test-start',
 pidDomain:process.platform==='linux'?'linux:'+fs.readFileSync('/etc/machine-id','utf8').trim()+':'+fs.readlinkSync('/proc/self/ns/pid'):'test-domain'};
if(scenario==='wrong-pid')status.pid++;
if(scenario==='wrong-start')status.procStart+='0';
if(scenario==='wrong-domain')status.pidDomain+='-different';
fs.writeFileSync(statusFile,JSON.stringify(status));
const event=(kind,value)=>fs.appendFileSync(events,JSON.stringify({kind,value,at:Date.now()})+'\n');
const row=(type,content,stop)=>JSON.stringify({type,sessionId:sid,cwd,message:{role:type,content,stop_reason:stop}})+'\n';
const text=s=>[{type:'text',text:s}];
const append=(type,content,stop)=>fs.appendFileSync(file,row(type,content,stop));
const frame=s=>process.stdout.write('\x1b[2J\x1b[H❯ '+s+'\r\n');
let input='',seed='',submitted=false;
process.stdin.setRawMode(true);process.stdin.resume();frame('');
process.stdin.on('data',chunk=>{
 input+=chunk.toString();
 if(input.startsWith('\x1b[200~')&&input.endsWith('\x1b[201~')){
  seed=input.slice(6,-6);input='';event('paste',seed);
  frame('[Pasted text #1 +'+(seed.match(/\n/g)||[]).length+' lines]');return;
 }
 if(input==='\r'&&!submitted){
  submitted=true;input='';event('enter',seed);frame('');
  if(scenario==='no-ack')return;
  append('user',text(scenario==='fused'?seed+'\n/plan-eng-review':seed));
  if(scenario==='duplicate')append('user',text(seed));
  if(scenario==='session-switch'){status.sessionId='bbbbbbbb-1111-2222-3333-aaaaaaaaaaaa';fs.writeFileSync(statusFile,JSON.stringify(status));return;}
  if(scenario==='foreign-cwd'){fs.writeFileSync(file,row('user',text(seed)).replace(cwd,cwd+'-other'));return;}
  if(scenario==='pending-tool'||scenario==='completed-tool'||scenario==='question'){
   append('assistant',[{type:'tool_use',id:'call1',name:scenario==='question'?'AskUserQuestion':'Read',input:{}}],'tool_use');
  }
  if(scenario==='status-updating'){fs.writeFileSync(statusFile,'{\"pid\":');setTimeout(()=>fs.writeFileSync(statusFile,JSON.stringify(status)),120);}
  if(scenario==='permission'){status.waitingFor='permission prompt';fs.writeFileSync(statusFile,JSON.stringify(status));}
  setTimeout(()=>{
   if(scenario==='no-end-turn')return;
   if(scenario==='completed-tool')append('user',[{type:'tool_result',tool_use_id:'call1',content:'Read complete'}]);
   append('assistant',text('Draft received; waiting for your skill command.'),'end_turn');event('end_turn',seed);
   if(scenario==='partial')fs.appendFileSync(file,'{"type":');
   frame(scenario==='prose-question' ? '\r\nWhich option do you prefer?\r\nA) Full review (recommended)\r\nB) Skip review\r\n❯ ' : '');
  },180);return;
 }
 if(input==='/plan-eng-review\r'){event('slash',input);input='';}
});
setTimeout(()=>process.exit(0),scenario==='wrong-pid'?12000:5000);
`;

for (const scenario of ['success', 'completed-tool', 'status-updating', 'no-ack', 'fused', 'duplicate', 'session-switch', 'foreign-cwd',
  'pending-tool', 'question', 'prose-question', 'permission', 'no-end-turn', 'partial', 'wrong-pid',
  ...(process.platform === 'linux' ? ['wrong-start', 'wrong-domain'] : [])]) {
  test.skipIf(process.platform === 'win32')(`seed submission owns each protocol step: ${scenario}`, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-')));
    const config = path.join(dir, '.claude'); fs.mkdirSync(config);
    const script = path.join(dir, 'cli.ts'); fs.writeFileSync(script, CLI);
    const decoder = new PtyCurrentScreen({ cols: 120, rows: 40 });
    let raw = '', exited = false;
    const launchedAt = Date.now();
    const proc = Bun.spawn([process.execPath, script], {
      cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: config, SEED_CASE: scenario },
      terminal: { cols: 120, rows: 40, data(_terminal, data) { const s = Buffer.from(data).toString(); raw += s; decoder.feed(s); } },
      onExit() { exited = true; },
    });
    const sent: string[] = [];
    const session = {
      pid: () => proc.pid, exited: () => exited, hermeticConfigDir: config,
      send(s: string) { sent.push(s); proc.terminal!.write(s); },
      sendKey(key: string) { expect(key).toBe('Enter'); sent.push('\r'); proc.terminal!.write('\r'); },
      mark: () => raw.length,
      currentScreen: async () => { const mark = raw.length; const frame = await decoder.snapshot(); return { text: frame.text, rawEnd: mark }; },
    };
    const seed = 'Please review when I run the skill:\n\n# Plan\nKeep $HOME and `literal` text.\n';
    const deadlineAt = launchedAt + 1100;
    try {
      let failure: unknown;
      try { await submitPlanSeed(session, seed, { cwd: dir, launchedAt, deadlineAt,
        isQuestionOrPermission: text => isProseAUQVisible(text) || isNumberedOptionListVisible(text) || isPermissionDialogVisible(text) }); }
      catch (error) { failure = error; }
      if (['success', 'completed-tool', 'status-updating'].includes(scenario)) {
        expect(failure).toBeUndefined();
        session.send('/plan-eng-review\r');
        await Bun.sleep(50);
        const events = fs.readFileSync(path.join(config, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        expect(events.map(e => e.kind)).toEqual(['paste', 'enter', 'end_turn', 'slash']);
        expect(events.slice(0, 3).every(e => e.value === seed)).toBe(true);
        expect(sent).toEqual([`\x1b[200~${seed}\x1b[201~`, '\r', '/plan-eng-review\r']);
      } else {
        expect(failure).toBeInstanceOf(Error);
        const expected = ({ fused: 'fused, duplicated, or changed', duplicate: 'fused, duplicated, or changed',
          'session-switch': 'native session changed', 'foreign-cwd': 'Foreign cwd',
          question: 'requires an answer', 'prose-question': 'requires an answer', 'wrong-pid': 'does not match this launch',
          'wrong-start': 'native process identity changed', 'wrong-domain': 'native process identity changed' } as Record<string, string>)[scenario]
          ?? 'existing case budget';
        expect((failure as Error).message).toContain(expected);
        expect(sent.some(s => s === '/plan-eng-review\r')).toBe(false);
        expect(sent.filter(s => s === '\r').length).toBeLessThanOrEqual(1);
      }
      expect(Date.now() - deadlineAt).toBeLessThan(500);
    } finally {
      if (!exited) proc.kill();
      await proc.exited;
      proc.terminal?.close(); decoder.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 6000);
}

for (const mode of ['unseeded-deadline', 'seeded-deadline', 'protocol-error']) test.skipIf(process.platform === 'win32')(`actual observation caller preserves preflight outcome: ${mode}`, async () => {
  const seeded = mode !== 'unseeded-deadline';
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-seed-budget-')));
  const config = path.join(dir, '.claude'); fs.mkdirSync(config);
  const script = path.join(dir, 'cli.ts');
  fs.writeFileSync(script, `#!${process.execPath}\n${CLI}`, { mode: 0o700 });
  const old = process.env.BROWSE_TERMINAL_BINARY;
  process.env.BROWSE_TERMINAL_BINARY = script;
  try {
    const run = runPlanSkillObservation({ skillName: 'plan-eng-review', cwd: dir,
      ...(seeded ? { initialPlanContent: '# Exact plan\nNo new work allowance.' } : {}), timeoutMs: mode === 'protocol-error' ? 10000 : 600, model: 'fixture',
      env: { CLAUDE_CONFIG_DIR: config, SEED_CASE: mode === 'protocol-error' ? 'wrong-pid' : 'success' } });
    if (mode === 'protocol-error') {
      await expect(run).rejects.toThrow('Plan seed PID status does not match this launch');
      expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
      return;
    }
    const obs = await run;
    expect(obs.outcome).toBe('timeout');
    expect(obs.summary).toContain('existing case budget');
    expect(obs.scopeGateAutoSelectObserved).toBe(false);
    expect(obs.elapsedMs).toBeLessThan(1600);
    expect(fs.existsSync(path.join(config, 'events.jsonl'))).toBe(false);
  } finally {
    if (old === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
