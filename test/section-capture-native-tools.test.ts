import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('Eng section producer checkpoints complete outcomes and never credits an exhausted draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-section-checkpoints-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  // Public boundary from 749df444, first Eng carve attempt, session
  // 9cefb69f-60b7-49fe-bec3-f5b3d50118d4. The incomplete input was hashed,
  // never an executed Write. Replay its metadata, not reconstructed content.
  const exhausted = {
    type: 'public_stream_diagnostic', kind: 'message_delta',
    messageId: 'msg_011Cf75reetor7sBHhJw7xwT', elapsedMs: 454169,
    stopReason: 'max_tokens',
  };
  const incompleteWrite = {
    type: 'public_stream_diagnostic', kind: 'content_block_delta',
    messageId: exhausted.messageId, index: 2, elapsedMs: 454148,
    blockType: 'tool_use', toolName: 'Write', deltaType: 'input_json_delta',
    inputBytes: 27568, inputSha256: '01688dc5f6d704461620a43b8d0d5950c302801b2687bd8793b005dbfb06757d',
  };
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = await Bun.stdin.text();
fs.appendFileSync('observed.jsonl',JSON.stringify({prompt,args:process.argv.slice(2)})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init'}));
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_01WP9DBmwzdGhTYMJ3Tw8xrT',name:'Read',input:{file_path:process.cwd()+'/plan-eng-review/sections/review-sections.md'}}]}}));
if (prompt.includes('capture-case:timeout')) {
  console.log(JSON.stringify(${JSON.stringify(incompleteWrite)}));
  console.log(JSON.stringify(${JSON.stringify(exhausted)}));
  if (prompt.includes('capture-case:timeout-partial')) fs.writeFileSync('PLAN.md','# Partial review\\n\\n## GSTACK REVIEW REPORT\\nDraft only.\\n');
  await Bun.sleep(5000);
}
if (prompt.includes('capture-case:synthetic-success')) fs.writeFileSync('PLAN.md','# Synthetic complete fixture\\n\\n## GSTACK REVIEW REPORT\\nSynthetic complete review.\\n');
console.log(JSON.stringify({type:'result',subtype:'success',result:'Request delivered only.'}));
`, { mode: 0o755 });
  const script = path.join(dir, 'run.ts');
  fs.writeFileSync(script, `import {mock} from 'bun:test';
mock.module(${JSON.stringify(helper('eval-store'))},()=>({getProjectEvalDir:()=>${JSON.stringify(path.join(dir, 'evals'))}}));
const {captureSectionReads}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
const fs=await import('node:fs');
const results=[];
for(const scenario of ['delivery','timeout','timeout-partial','synthetic-success']) {
  fs.writeFileSync('PLAN.md','# Original accepted requirements\\n');
  const capture=await captureSectionReads({planDir:${JSON.stringify(dir)},skillName:'plan-eng-review',scenario:'capture-case:'+scenario,decisionPolicy:'- Preserve the supplied author scope; do not approve excluded work.',reportFile:'PLAN.md',reportMarker:/^## GSTACK REVIEW REPORT\\s*$/m,testName:'eng-checkpoints',timeout:scenario.startsWith('timeout')?300:480000,model:'fake-model'});
  results.push({scenario,reads:[...capture.readSections],report:capture.reportProduced,written:capture.reportWritten,exit:capture.exitReason,executedWrites:capture.toolCalls.filter(t=>t.tool==='Write').length});
}
console.log(JSON.stringify(results));
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS_HERMETIC: '1' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const results = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(results.map((r: any) => [r.scenario, r.exit, r.written, r.report, r.executedWrites])).toEqual([
      ['delivery', 'success', false, false, 0],
      ['timeout', 'timeout', false, false, 0],
      ['timeout-partial', 'timeout', true, false, 0],
      ['synthetic-success', 'success', true, true, 0],
    ]);
    for (const result of results) expect(result.reads).toEqual(['review-sections.md']);
    const launches = fs.readFileSync(path.join(dir, 'observed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launches).toHaveLength(4);
    for (const launch of launches) {
      expect(launch.prompt).toContain('When Scope Challenge finishes, save its outcome');
      expect(launch.prompt).toContain('after each completed review section, save');
      expect(launch.prompt).toContain('Check the Write/Edit result and Read the saved outcome before advancing');
      expect(launch.prompt).toContain('also apply when no new choice needs approval');
      expect(launch.prompt).toContain('Preserve all four review sections, every finding and original requirement');
      expect(launch.prompt).toContain('finish missing required outputs with scoped Edits');
      expect(launch.prompt).toContain("perform the skill's full final Read-back gate");
      expect(launch.prompt).not.toContain("When the workflow is complete, write the skill's final output");
      expect(launch.args[launch.args.indexOf('--max-turns') + 1]).toBe('25');
      expect(launch.args[launch.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Write,Edit,Agent');
      expect(launch.args[launch.args.indexOf('--model') + 1]).toBe('fake-model');
    }
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('CEO section caller supplies the author scope instead of blanket recommendation authority', () => {
  const caller = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-ceo-review-section-loading.test.ts'), 'utf8');
  expect(caller).toContain('decisionPolicy: CEO_SECTION_DECISION_POLICY');
  expect(caller).toContain('validateCeoReviewCompletion(capture)');
  expect(caller).toContain('expect(hasStaleFillRaceFinding(output)).toBe(true)');
  expect(caller).toContain('timeout: LONG_SECTION_CAPTURE_MS');
  expect(caller).toContain('CAPTURE_LONG_MS');
});

test('actual CEO capture delivers the author scope and fixture without granting excluded recommendations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-scope-capture-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  // This CLI records the actual request only. It performs no review, section
  // Read or report write, so its successful exit cannot earn completion credit.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = await Bun.stdin.text();
fs.writeFileSync('observed.json', JSON.stringify({prompt,args:process.argv.slice(2),plan:fs.readFileSync('PLAN.md','utf8')}));
console.log(JSON.stringify({type:'system',subtype:'init'}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'Request delivered only.'}));
`, { mode: 0o755 });
  const script = path.join(dir, 'run.ts');
  fs.writeFileSync(script, `import {mock} from 'bun:test';
mock.module(${JSON.stringify(helper('eval-store'))}, () => ({getProjectEvalDir:()=>${JSON.stringify(path.join(dir, 'evals'))}}));
const {captureSectionReads,LONG_SECTION_CAPTURE_MS}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
const {CEO_SECTION_CACHE_PLAN,CEO_SECTION_DECISION_POLICY}=await import(${JSON.stringify(helper('ceo-section-loading-fixture'))});
await Bun.write('PLAN.md',CEO_SECTION_CACHE_PLAN);
const capture=await captureSectionReads({planDir:${JSON.stringify(dir)},skillName:'plan-ceo-review',scenario:'Review PLAN.md. Consider weaker consistency, a new alert project, or full implementation code.',decisionPolicy:CEO_SECTION_DECISION_POLICY,reportFile:'PLAN.md',reportMarker:/^## GSTACK REVIEW REPORT\\s*$/m,nativeReviewOnly:true,testName:'ceo-scope-delivery',timeout:LONG_SECTION_CAPTURE_MS,model:'fake-model'});
console.log(JSON.stringify({reads:[...capture.readSections],report:capture.reportProduced,written:capture.reportWritten,exit:capture.exitReason}));
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS_HERMETIC: '1' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ reads: [], report: false, written: false, exit: 'success' });
    const observed = JSON.parse(fs.readFileSync(path.join(dir, 'observed.json'), 'utf8'));
    const { CEO_SECTION_CACHE_PLAN, CEO_SECTION_DECISION_POLICY } = await import('./helpers/ceo-section-loading-fixture');
    expect(observed.plan).toBe(CEO_SECTION_CACHE_PLAN);
    expect(observed.prompt).toContain(CEO_SECTION_DECISION_POLICY);
    expect(observed.prompt).not.toContain("silently pick the skill's recommended option");
    expect(observed.prompt).toContain('Do not authorize weaker consistency, changed limits, optional scope');
    expect(observed.prompt).toContain('never hide it or claim approval when no offered alternative satisfies these constraints');
    expect(observed.prompt).toContain('Give all 11 sections an explicit outcome');
    expect(observed.prompt).toContain('complete all required artifacts before returning');
    expect(observed.args[observed.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Write,Edit');
    expect(observed.args[observed.args.indexOf('--max-turns') + 1]).toBe('25');
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// POSIX executable shebang; parent environment and mocks stay untouched.
test('section capture keeps the native Read contract, tool availability and work deadline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-native-tools-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'argv.jsonl');
  const helper = (name: string) => path.resolve(import.meta.dir, 'helpers', name + '.ts');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const prompt = await Bun.stdin.text();
const log = ${JSON.stringify(log)};
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : '') + JSON.stringify({args:process.argv.slice(2), config:process.env.CLAUDE_CONFIG_DIR, prompt}) + '\\n');
console.log(JSON.stringify({type:'system',subtype:'init'}));
if (prompt === 'deadline') await Bun.sleep(3000);
const file = process.cwd() + '/fixture/sections/actual.md';
const tool = prompt.includes('shell-only') ? {name:'Bash',input:{command:'cat '+file}} : {name:'Read',input:{file_path:file}};
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'read-1',...tool}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'Review report complete',num_turns:1}));
`, { mode: 0o755 });
  const literal = 'Use Read.\nKeep "quotes", $(printf unsafe), and `literal` as text.';
  const script = path.join(dir, 'run.ts');
  fs.writeFileSync(script, `import {mock} from 'bun:test';
mock.module(${JSON.stringify(helper('eval-store'))}, () => ({getProjectEvalDir:()=>${JSON.stringify(path.join(dir, 'evals'))}}));
const {runSkillTest}=await import(${JSON.stringify(helper('session-runner'))});
const {captureSectionReads}=await import(${JSON.stringify(helper('auq-sdk-capture'))});
const base={workingDirectory:${JSON.stringify(dir)},model:'fake-model',maxTurns:7,timeout:3000,allowedTools:['Read','Bash']};
const plain=await runSkillTest({...base,prompt:'default'});
const literal=await runSkillTest({...base,prompt:'literal',appendSystemPrompt:${JSON.stringify(literal)}});
const capture={planDir:${JSON.stringify(dir)},skillName:'fixture',testName:'native-tool-contract',model:'fake-model',maxTurns:7,timeout:3000};
const section=await captureSectionReads({...capture,scenario:'native-read',artifactCommands:'Run the existing program when required.'});
const shell=await captureSectionReads({...capture,scenario:'shell-only'});
const started=Date.now();
const deadline=await runSkillTest({...base,prompt:'deadline',appendSystemPrompt:${JSON.stringify(literal)},timeout:200,startupGraceMs:200});
console.log(JSON.stringify({plain:plain.exitReason,literal:literal.exitReason,section:{reads:[...section.readSections],report:section.reportProduced},shell:{reads:[...shell.readSections],report:shell.reportProduced},deadline:{reason:deadline.exitReason,wall:Date.now()-started}}));
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS_HERMETIC: '1' };
  delete env.CI;
  const child = Bun.spawn([process.execPath, script], { env, cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.plain).toBe('success'); expect(result.literal).toBe('success');
    expect(result.section).toEqual({ reads: ['actual.md'], report: true });
    expect(result.shell).toEqual({ reads: [], report: true });
    expect(result.deadline.reason).toBe('timeout'); expect(result.deadline.wall).toBeLessThan(2000);
    const launches = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launches).toHaveLength(5);
    const args = (i: number) => launches[i].args as string[];
    expect(args(0)).not.toContain('--append-system-prompt');
    const added = args(1).indexOf('--append-system-prompt');
    expect(added).toBeGreaterThan(-1); expect(args(1)[added + 1]).toBe(literal);
    expect(args(1).filter((_, i) => i !== added && i !== added + 1)).toEqual(args(0));
    const sectionArgs = args(2);
    const instruction = launches[2].prompt.split('\n').find((line: string) => line.includes('with the Read tool BEFORE'));
    expect(sectionArgs).not.toContain('--append-system-prompt');
    expect(instruction).toContain('you MUST actually Read that sections/ file with the Read tool BEFORE doing the work it covers');
    expect(instruction).not.toContain('actual.md'); expect(instruction).not.toContain(dir);
    expect(sectionArgs.slice(sectionArgs.indexOf('--allowed-tools') + 1, sectionArgs.indexOf('--allowed-tools') + 8))
      .toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'Bash']);
    for (const [index, launch] of launches.entries()) {
      if (index === 2 || index === 3) {
        const expected = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', ...(index === 2 ? ['Bash'] : [])];
        expect(launch.args[launch.args.indexOf('--tools') + 1]).toBe(expected.join(','));
      } else expect(launch.args).not.toContain('--tools');
      expect(launch.args).not.toContain('--disallowed-tools');
      expect(launch.args).toContain('--dangerously-skip-permissions'); expect(launch.args).toContain('--strict-mcp-config');
      expect(launch.args[launch.args.indexOf('--max-turns') + 1]).toBe('7');
      expect(launch.args[launch.args.indexOf('--model') + 1]).toBe('fake-model');
      expect(path.relative(dir, launch.config).startsWith('..')).toBe(false);
    }
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
