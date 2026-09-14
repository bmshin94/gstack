import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
