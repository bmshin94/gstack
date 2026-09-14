/** Actual paid caller lifecycle with only provider/native boundaries replaced. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test.each(['success', 'next-modal', 'launch', 'navigation', 'posture', 'close'])('native mode fixture delivery and cleanup: %s', scenario => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-body-'));
  const script = path.join(dir, 'body.fixture.test.ts');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(ROOT)}, scenario = ${JSON.stringify(scenario)};
const facts = [];
let current, clock = 0;
Date.now = () => clock;
Bun.sleep = async ms => { clock += ms; };
const question = { promptSnippet:'Select review mode', signature:'mode',
  options:[{index:1,label:'SCOPE EXPANSION'},{index:2,label:'HOLD SCOPE'}] };
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({describeE2ETier: () => describe}));
mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
  launchClaudePty: async opts => {
    current = {cwd:opts.cwd, options:opts, sends:[], closed:false, reads:[], selected:false, continued:false};
    facts.push(current);
    const git = file => execFileSync('git', ['show','HEAD:'+file], {cwd:opts.cwd,encoding:'utf8',timeout:5000});
    current.plan = fs.readFileSync(path.join(opts.cwd,'PLAN.md'),'utf8');
    current.committed = git('PLAN.md'); current.instructions = git('CLAUDE.md');
    current.status = execFileSync('git',['status','--porcelain'],{cwd:opts.cwd,encoding:'utf8',timeout:5000});
    if (scenario === 'launch') throw new Error('fixture launch failed');
    return {
      hermeticConfigDir:path.join(opts.cwd,'.native'), mark:()=>current.selected ? 23 : 11,
      send:value=>{current.sends.push(value); if (/^[12]$/.test(value)) {
        if (current.selected) current.continued=true; else current.selected=true;
      }}, exited:()=>false, exitCode:()=>null,
      visibleSince:()=>current.selected ? 'Current native posture' : 'Current mode menu',
      rawOutput:()=>'', visibleText:()=>'', currentScreen:async()=>current.selected ? 'Downstream question' : 'Mode menu',
      close:async()=>{current.closed=true;if(scenario==='close')throw new Error('fixture close failed');},
    };
  },
  isNumberedOptionListVisible:()=>false, isPlanReadyVisible:()=>false,
  planCountQuestionInput:(_visible,_question,index)=>String(index),
  capturePlanCountQuestion:()=>question,
  selectPtyNumberedOption:async(session,index)=>session.send(String(index)),
}));
mock.module(path.join(root,'test/helpers/ceo-mode-option.ts'),()=>({
  nextCeoModeNavigation:(_visible,target)=>{
    if(scenario==='navigation')throw new Error('fixture navigation failed');
    current.mode=target; return {kind:'mode',index:target==='HOLD SCOPE'?2:1,question};
  },
  hasNativePostAnswerCeoPosture:(_transcript,target,_pattern,selectedAt)=>{
    current.posture={target,selectedAt};
    return scenario!=='posture' && (scenario!=='next-modal'||current.continued);
  },
  nextCeoPostureContinuation:()=>scenario==='next-modal'&&!current.continued?'question':null,
}));
mock.module(path.join(root,'test/helpers/plan-count-transcript.ts'),()=>({
  readPlanCountTranscript:(config,cwd)=>{
    current.reads.push({config,cwd});return {status:'ready',calls:[],assistantMessages:[]};
  },
}));
mock.module(path.join(root,'test/helpers/plan-count-pending-question.ts'),()=>({
  readPendingQuestion:()=>undefined,pendingQuestionRecorderStatus:()=>({status:'idle'}),
}));
mock.module(path.join(root,'test/helpers/plan-count-artifacts.ts'),()=>({createPlanCountSnapshotWriter:()=>()=>({})}));
afterAll(()=>fs.writeFileSync(${JSON.stringify(factsPath)},JSON.stringify(facts)));
await import(path.join(root,'test/skill-e2e-plan-ceo-mode-routing.test.ts'));
`);
  try {
    const child = spawnSync(process.execPath, ['test', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_TIER: '', TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(['success', 'next-modal'].includes(scenario) ? 0 : 1);
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    expect(facts).toHaveLength(2);
    expect(facts[0].cwd).not.toBe(facts[1].cwd);
    for (const [index, fact] of facts.entries()) {
      expect(fact.plan).toContain('# Plan: Add saved project views');
      expect(fact.committed).toBe(fact.plan);
      expect(fact.instructions).toContain(fact.plan);
      expect(fact.status).toBe('');
      expect(fact.options).toMatchObject({permissionMode:'plan',seedSkills:true,observeScreen:true,observeSetupQuestions:true});
      expect(fs.existsSync(fact.cwd)).toBe(false);
      expect(fact.closed).toBe(scenario !== 'launch');
      const modeInput = index === 0 ? '2' : '1';
      expect(fact.sends).toEqual(scenario === 'launch' ? [] : scenario === 'navigation' ? ['/plan-ceo-review\r']
        : scenario === 'next-modal' ? ['/plan-ceo-review\r', modeInput, '1'] : ['/plan-ceo-review\r', modeInput]);
      for (const read of fact.reads) expect(read).toEqual({config:path.join(fact.cwd,'.native'),cwd:fact.cwd});
      if (!['launch','navigation'].includes(scenario)) {
        expect(fact.posture.target).toBe(index === 0 ? 'HOLD SCOPE' : 'SCOPE EXPANSION');
        expect(fact.posture.selectedAt).toBeGreaterThan(0);
      }
    }
    if (scenario === 'posture') expect(child.stderr).toContain('no posture match');
    else if (!['success','next-modal'].includes(scenario)) expect(child.stderr).toContain('fixture ' + scenario + ' failed');
    expect(fs.readdirSync(dir).filter(name => name.startsWith('gstack-plan-count-'))).toEqual([]);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
}, 20_000);
