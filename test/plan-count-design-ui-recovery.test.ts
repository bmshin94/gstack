import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRejectedSlashCommand } from './helpers/claude-pty-runner';

// Exact public tool-result frame from the first Sep 15 Design UI attempt.
const TOOL_HELP_FRAME = "● Bash(eval \"$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)\"\n      eval \"$(~/.claude/skills/gstack/bin/gstack-paths)\"…)\n  ⎿  DESIGN_DIR: /tmp/gstack-owned-display-9o13klaz/gstack-paid-shard-awmDRC/tmp/gstack-native-review-state-mT1Xxz/\n     projects/gstack-plan-count-UAhijs/designs/user-dashboard-20260915\n     Unknown command: --help\n     … +34 lines (ctrl+o to expand)\n  ⎿  Allowed by auto mode classifier\n\n";

test('a tool help error does not reject the successfully invoked review skill', () => {
  expect(isRejectedSlashCommand(TOOL_HELP_FRAME, '/plan-design-review')).toBe(false);
  for (const other of ['--help', '/other-review', '/plan-design-review-extra']) {
    expect(isRejectedSlashCommand(`Unknown command: ${other}`, '/plan-design-review')).toBe(false);
  }
  expect(isRejectedSlashCommand('Quoted: Unknown command: /plan-design-review', '/plan-design-review')).toBe(false);
});

test('the requested native slash rejection remains an immediate failure', () => {
  // Both forms are emitted by the pinned Claude CLI's cmd_unknown branch.
  for (const suffix of ['', '. Did you mean /plan-eng-review?']) {
    expect(isRejectedSlashCommand(`Unknown command: /plan-design-review${suffix}`, '/plan-design-review')).toBe(true);
    expect(isRejectedSlashCommand(`\x1b[31mUnknown command: /plan-design-review${suffix}\x1b[0m`, '/plan-design-review')).toBe(true);
  }
});

test.skipIf(process.platform === 'win32').each(['answer', 'throw'] as const)(
  'real counting loop binds a pending board before publication and preserves %s evidence', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-ui-count-recovery-'));
    const fake = path.join(root, 'fake-claude'), worker = path.join(root, 'worker.ts');
    const events = path.join(root, 'events.jsonl'), resultFile = path.join(root, 'result.json');
    const evalDir = path.join(root, 'eval');
    const helper = (name: string) => pathToFileURL(path.join(import.meta.dir, 'helpers', name)).href;
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs'; import * as path from 'node:path';
const cwd=process.cwd(), session='owned-board-session', id='owned-board-call';
const journal=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','owned',session+'.jsonl');
fs.mkdirSync(path.dirname(journal),{recursive:true});
const record=value=>fs.appendFileSync(process.env.PROBE_EVENTS,JSON.stringify(value)+'\n');
const persist=(role,content,extra={})=>fs.appendFileSync(journal,JSON.stringify({cwd,sessionId:session,
  isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
const question={header:'Comparison board',question:'Review http://127.0.0.1:48123/boards/owned-fixture/ and continue?',
  multiSelect:false,options:[{label:'Submitted',description:'Feedback was submitted.'},
    {label:'Type preferences',description:'Use a manual preference.'}]};
const at=process.argv.indexOf('--settings'), settings=JSON.parse(process.argv[at+1]);
async function hook(kind) {
  const entries=settings.hooks[kind]?.filter(e=>e.matcher==='^AskUserQuestion$')??[];
  if(entries.length!==1||entries[0].hooks.length!==1||entries[0].hooks[0].timeout!==5)throw Error('missing scoped observer');
  const payload={hook_event_name:kind,tool_name:'AskUserQuestion',session_id:session,tool_use_id:id,
    cwd,transcript_path:journal,tool_input:{questions:[question]}};
  const child=Bun.spawn(['bash','-c',entries[0].hooks[0].command],{
    stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  record({kind:'hook',event:kind,code,out,err});if(code||out||err)throw Error('observer changed native response');
}
let started=false, ready=false, answered=false;
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',async data=>{
  const input=data.toString();record({kind:'input',input});
  if(!started){
    if(input!=='/plan-design-review\r')throw Error('wrong initial command');started=true;
    persist('assistant',[{type:'text',text:'Preparing the owned board.'}]);
    process.stdout.write('\x1b[2J\x1b[H'+process.env.PROBE_HELP_FRAME.replace(/\n/g,'\r\n'));
    setTimeout(async()=>{
      await hook('PreToolUse');ready=true;
      const screen='☐ Comparison board\n'+question.question+'\n❯ 1. Submitted\n  2. Type preferences\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
      process.stdout.write('\x1b[2J\x1b[H'+screen.replace(/\n/g,'\r\n'));
    },3000);return;
  }
  if(!ready||answered||input!=='1')throw Error('unowned or duplicate board input');
  answered=true;await hook('PostToolUse');
  persist('assistant',[{type:'tool_use',id,name:'AskUserQuestion',input:{questions:[question]}}]);
  persist('user',[{type:'tool_result',tool_use_id:id,content:'Answered.'}],{toolUseResult:{answers:{[question.question]:'Submitted'}}});
  process.stdout.write('\x1b[2J\x1b[HBOARD_ACKNOWLEDGED\r\n');
});
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
`, { mode: 0o755 });
    fs.writeFileSync(worker, `
import * as fs from 'node:fs';
import {runPlanSkillCounting,resolveClaudeBinary} from ${JSON.stringify(helper('claude-pty-runner.ts'))};
if(resolveClaudeBinary()!==${JSON.stringify(fake)})throw Error('fake CLI binding failed');
let picks=0, originalError;
try {
  const observation=await runPlanSkillCounting({skillName:'plan-design-review',slashCommand:'/plan-design-review',
    followUpPrompt:'# Owned board ordering control',observeSetupQuestions:true,
    env:${JSON.stringify({ PROBE_EVENTS: events, PROBE_HELP_FRAME: TOOL_HELP_FRAME })},
    isLastStep0AUQ:()=>false,isReviewAUQ:fp=>fp.nativeCall?.answered===true,
    reviewCountCeiling:1,timeoutMs:28000,pickAUQ:(_routing,active)=>{
      if(!active.nativeCall||active.nativeCall.answered||active.nativeCall.toolUseId!=='owned-board-call')throw Error('board missing owned pending identity');
      picks++;if(${JSON.stringify(mode)}==='throw')throw Error('controlled board actor failure');return 1;
    }});
  fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({picks,observation}));
}catch(error){originalError=error.message;fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({picks,error:originalError}));}
`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, EVALS_HERMETIC: '1', EVALS_RUN_ID: `board-ordering-${mode}`,
        GSTACK_EVAL_DIR: evalDir, BROWSE_TERMINAL_BINARY: fake, PROBE_EVENTS: events, PROBE_HELP_FRAME: TOOL_HELP_FRAME },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 32_000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(0);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(result.picks, JSON.stringify(result)).toBe(1);
      const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.kind === 'input').map(row => row.input)).toEqual(
        mode === 'answer' ? ['/plan-design-review\r', '1'] : ['/plan-design-review\r']);
      const run = path.join(evalDir, 'pty-count', `board-ordering-${mode}`);
      const snapshots = fs.readdirSync(run);
      expect(snapshots).toHaveLength(1);
      const artifact = path.join(run, snapshots[0]!);
      const saved = JSON.parse(fs.readFileSync(path.join(artifact, 'observation.json'), 'utf8'));
      expect(fs.existsSync(saved.capture.cwd)).toBe(false);
      if (mode === 'answer') {
        expect(result.observation.outcome).toBe('ceiling_reached');
        expect(result.observation.reviewCount).toBe(1);
        expect(result.observation.transcript.calls).toHaveLength(1);
        expect(result.observation.transcript.calls[0].answered).toBe(true);
        expect(saved.outcome).toBe('ceiling_reached');
      } else {
        expect(result.error).toBe('controlled board actor failure');
        expect(saved.state).toBe('threw');
        expect(saved.error).toBe(result.error);
        expect(saved.reviewCount).toBe(0);
        expect(saved.transcript.calls).toEqual([]);
        expect(saved.pendingQuestion).toMatchObject({ toolUseId: 'owned-board-call', answered: false, source: 'pre_tool_use' });
        expect(fs.readFileSync(path.join(artifact, 'terminal.screen.log'), 'utf8')).toContain('/boards/owned-fixture/');
        expect(fs.readFileSync(path.join(artifact, 'terminal.raw.log'), 'utf8')).toContain('Submitted');
        expect(err).toContain(`Full PTY artifacts: ${artifact}`);
      }
    } finally {
      clearTimeout(timer); child.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 35_000,
);
