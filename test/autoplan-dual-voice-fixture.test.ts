import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const ORIGINAL_PLAN = `# Test Plan: add /greet skill

## Context
Add a new /greet skill that prints a welcome message.

## Scope
- Create greet/SKILL.md with a simple "hello" flow
- Add to gen-skill-docs pipeline
- One unit test
`;

// Exercise the actual paid registration and Bun retry lifecycle with only the
// provider replaced. The cab3 public first attempt left accepted requirements
// and a review record in TEST_PLAN; the next attempt read those as its input.
test.each(['retry', 'runner', 'no-agent', 'no-codex', 'no-progress', 'success', 'project', 'setup-failure'])(
  'dual-voice attempt owns fresh inputs and cleanup: %s', scenario => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-dual-free-'));
    const childHome = path.join(directory, 'home');
    fs.mkdirSync(childHome);
    const script = path.join(directory, 'registration.test.ts');
    const facts = path.join(directory, 'facts.json');
    fs.writeFileSync(script, `
import { describe, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const scenario = ${JSON.stringify(scenario)};
const attempts = [];
fs.writeFileSync(${JSON.stringify(facts)}, '[]');
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-helpers.ts'))}, () => ({
  ROOT: ${JSON.stringify(ROOT)}, runId: 'free-dual-voice', evalsEnabled: true,
  describeIfSelected: (name, ids, body) => describe(name, body),
  copyDirSync: (from, to) => {
    if (scenario === 'setup-failure') throw Error('controlled fixture copy failure');
    fs.cpSync(from, to, {recursive: true});
  },
  createEvalCollector: () => ({}), finalizeEvalCollector: () => {},
  logCost: () => {}, recordE2E: () => {},
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    const cwd = opts.workingDirectory;
    const plan = path.join(cwd, 'TEST_PLAN.md');
    const state = opts.env?.GSTACK_HOME;
    const config = opts.env?.CLAUDE_CONFIG_DIR;
    const fact = {cwd, initial: fs.readFileSync(plan, 'utf8'), env: opts.env,
      prompt: opts.prompt, timeout: opts.timeout, maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools, tools: opts.tools,
      appendedPrompt: opts.appendSystemPrompt, model: opts.model,
      trusted: config ? JSON.parse(fs.readFileSync(path.join(config, '.claude.json'), 'utf8')).projects?.[cwd]?.hasTrustDialogAccepted : null,
      disabledCodex: state ? /^codex_reviews: disabled$/m.test(fs.readFileSync(path.join(state, 'config.yaml'), 'utf8')) : null,
      stateHadPriorArtifact: state ? fs.existsSync(path.join(state, 'prior-report.md')) : null,
      configHadPriorSession: config ? fs.existsSync(path.join(config, 'prior-session.json')) : null};
    attempts.push(fact);
    fs.writeFileSync(plan, fact.initial + '\\n## Review record\\nPrior attempt review\\n<!-- autoplan-accepted:ceo -->\\nPrior accepted requirement\\n<!-- /autoplan-accepted:ceo -->\\n');
    if (state) fs.writeFileSync(path.join(state, 'prior-report.md'), 'prior attempt artifact');
    if (config) fs.writeFileSync(path.join(config, 'prior-session.json'), '{}');
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
    if (scenario === 'project') {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const run = args => spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 5000});
      const generated = run(['run', 'gen:skill-docs']);
      const baseline = run(['test', 'test/about.test.ts']);
      const about = fs.readFileSync(path.join(cwd, 'about/SKILL.md'), 'utf8');
      fact.project = {generator: generated.status, baseline: baseline.status,
        installed: fs.readFileSync(path.join(cwd, '.claude/skills/about/SKILL.md'), 'utf8') === about,
        proposedGreetAbsent: !fs.existsSync(path.join(cwd, 'greet'))};
      fs.mkdirSync(path.join(cwd, 'sample'));
      fs.writeFileSync(path.join(cwd, 'sample/SKILL.md.tmpl'), '---\\nname: sample\\ndescription: Existing generator control.\\n---\\nPrint sample.\\n');
      pkg.skills.push('sample');
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg));
      fact.project.registration = run(['run', 'gen:skill-docs']).status;
      fact.project.registered = fs.readFileSync(path.join(cwd, 'sample/SKILL.md'), 'utf8')
        === fs.readFileSync(path.join(cwd, '.claude/skills/sample/SKILL.md'), 'utf8');
      fs.writeFileSync(path.join(cwd, 'about/SKILL.md'), 'broken existing skill');
      fact.project.regression = run(['test', 'test/about.test.ts']).status;
      fs.rmSync(path.join(cwd, 'sample/SKILL.md.tmpl'));
      fact.project.missingTemplate = run(['run', 'gen:skill-docs']).status;
      fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(attempts));
    }
    if (scenario === 'runner') throw Error('controlled dual-voice runner failure');
    const noAgent = scenario === 'no-agent' || scenario === 'retry' && attempts.length === 1;
    const calls = [
      ...(!noAgent ? [{tool: 'Agent', input: {prompt: scenario === 'no-progress' ? 'Calculate one plus one' : 'CEO review of this plan'}}] : []),
      ...(scenario !== 'no-codex' ? [{tool: 'Bash', input: {command: 'codex exec fixture-prompt'}}] : []),
    ];
    return {output: '', toolCalls: calls,
      transcript: [{type: 'assistant', message: {content: calls.map(c => ({type: 'tool_use', name: c.tool, input: c.input}))}}],
      exitReason: noAgent ? 'timeout' : 'success', model: 'free-fixture',
      costEstimate: {estimatedCost: 0, turnsUsed: 1}};
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-autoplan-dual-voice.test.ts'))});
`);
    try {
      const child = spawnSync(process.execPath, ['test', ...(scenario === 'retry' ? ['--retry', '1'] : []), script], {
        cwd: ROOT, encoding: 'utf8', timeout: 15_000,
        env: { PATH: process.env.PATH ?? '', HOME: childHome, TMPDIR: directory, TMP: directory, TEMP: directory,
          GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}) },
      });
      expect(child.error, child.stderr).toBeUndefined();
      const shouldPass = ['retry', 'success', 'project'].includes(scenario);
      expect(child.status, child.stderr).toBe(shouldPass ? 0 : 1);
      const attempts = JSON.parse(fs.readFileSync(facts, 'utf8'));
      expect(attempts).toHaveLength(scenario === 'setup-failure' ? 0 : scenario === 'retry' ? 2 : 1);
      if (scenario === 'retry') expect(attempts[1].initial).toBe(attempts[0].initial);
      for (const attempt of attempts) {
        expect(attempt.initial).toBe(ORIGINAL_PLAN);
        expect(attempt.prompt).toBe(`/autoplan ${path.join(attempt.cwd, 'TEST_PLAN.md')}`);
        expect(attempt.timeout).toBe(600_000);
        expect(attempt.maxTurns).toBe(40);
        expect(attempt.allowedTools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'Skill']);
        expect(attempt.tools).toBeUndefined();
        expect(attempt.appendedPrompt).toBeUndefined();
        expect(attempt.model).toBeUndefined();
        expect(attempt.trusted).toBe(true);
        expect(attempt.disabledCodex).toBe(false);
        expect(fs.existsSync(attempt.cwd)).toBe(false);
        expect(attempt.env?.GSTACK_STATE_ROOT).toBe(attempt.env?.GSTACK_HOME);
        expect(attempt.stateHadPriorArtifact).toBe(false);
        expect(attempt.configHadPriorSession).toBe(false);
        expect(fs.existsSync(attempt.env.GSTACK_HOME)).toBe(false);
        expect(fs.existsSync(attempt.env.CLAUDE_CONFIG_DIR)).toBe(false);
      }
      if (scenario === 'retry') {
        expect(attempts[0].cwd).not.toBe(attempts[1].cwd);
        expect(attempts[0].env.GSTACK_HOME).not.toBe(attempts[1].env.GSTACK_HOME);
        expect(attempts[0].env.CLAUDE_CONFIG_DIR).not.toBe(attempts[1].env.CLAUDE_CONFIG_DIR);
      }
      if (scenario === 'runner') expect(child.stderr).toContain('controlled dual-voice runner failure');
      if (scenario === 'project') expect(attempts[0].project).toEqual({generator: 0, baseline: 0,
        installed: true, proposedGreetAbsent: true, registration: 0, registered: true, regression: 1, missingTemplate: 1});
      if (scenario === 'setup-failure') expect(child.stderr).toContain('controlled fixture copy failure');
      expect(fs.readdirSync(directory).sort()).toEqual(['facts.json', 'home', 'registration.test.ts']);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }, 20_000,
);
