import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGeneration } from '../scripts/gen-skill-docs';
import { ALL_HOST_NAMES } from '../hosts';

const ROOT = path.resolve(import.meta.dir, '..');

test('every host exposes the DX per-call rule before the pre-review audit and Step 0', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devex-rule-free-'));
  try {
    const generated = await runGeneration({ host: 'all', outputRoot });
    expect(generated.exitCode).toBe(0);
    const skills = generated.artifacts.filter(artifact => artifact.kind === 'skill'
      && /(?:^|\/)gstack-plan-devex-review\/SKILL\.md$|^plan-devex-review\/SKILL\.md$/.test(artifact.relativePath));
    expect(skills.map(artifact => artifact.host).sort()).toEqual([...ALL_HOST_NAMES].sort());
    for (const artifact of skills) {
      const content = fs.readFileSync(path.join(outputRoot, artifact.relativePath), 'utf8');
      const audit = content.indexOf('## PRE-REVIEW SYSTEM AUDIT');
      expect(audit).toBeGreaterThan(0);
      const beforeAudit = content.slice(0, audit);
      expect(beforeAudit).toContain('One issue = one AskUserQuestion call.');
      expect(beforeAudit).toContain('including Step 0');
      expect(beforeAudit).toContain('separate tabs in one call still bundle those decisions');
      const mode = content.slice(content.indexOf('### 0E. Mode Selection'), content.indexOf('Context-dependent defaults:'));
      expect(mode).toContain('Use the mode the user explicitly requested for this review.');
      expect(mode).toContain('skip the mode question and continue to 0F. Otherwise, ask below.');
      const sectionText = generated.artifacts.filter(item => item.kind === 'section'
        && item.host === artifact.host && item.relativePath.startsWith('plan-devex-review/'))
        .map(item => fs.readFileSync(path.join(outputRoot, item.relativePath), 'utf8')).join('\n');
      const allContent = content + '\n' + sectionText;
      expect(allContent).toContain('Record observed human onboarding separately from automated execution');
      expect(allContent).toContain('a warm snippet timer is neither a fresh-start check nor a human benchmark');
      expect(allContent).toContain('Keep estimates labeled until measured');
      expect(allContent).toContain('A target tier does not itself approve telemetry, an automated');

    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }); }
}, 20_000);

test('the actual DX finding registration commits its mode, unchanged defects, and existing contracts before launch', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devex-count-free-')));
  const script = path.join(directory, 'registration.test.ts');
  const facts = path.join(directory, 'facts.json');
  const originalPlan = [
    '# Plan: Public SDK Beta Launch', '', '## Persona',
    "The plan doesn't specify which developer persona is the target — we're",
    'shipping for "everyone," which means we tune for nobody.', '',
    '## TTHW (time to hello world)',
    'Time-to-hello-world is not measured. No benchmark data referenced. We',
    "don't know if first-run takes 5 minutes or 50.", '', '## Friction Point',
    'First-run currently requires a 5-minute mandatory CI step before the',
    'developer can run their first eval. There is no way to skip it.', '', '## Magical Moment',
    'Getting-started flow has no delight beat. Pure documentation, no',
    'interactive demo, no "ah-ha" moment that makes the developer trust us.', '',
    '## Competitive Blind Spot',
    "The plan doesn't reference how peer SDKs (LangChain, Semantic Kernel,",
    'OpenAI) handle this DX surface. We may be reinventing worse versions',
    'of solved problems.',
  ].join('\n');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  PLAN_SKILL_COUNT_FINALIZE_MS: 10000,
  devexStep0Boundary: () => false,
  assertReviewReportAtBottom: () => { throw new Error('must not bypass the failed runner'); },
  runPlanSkillCounting: async opts => {
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ cwd: opts.cwd, checked: false }));
    expect(path.dirname(opts.cwd)).toBe(${JSON.stringify(directory)});
    expect(opts.skillName).toBe('plan-devex-review');
    expect(opts.slashCommand).toBe('/plan-devex-review');
    expect(opts.timeoutMs).toBeGreaterThan(1400000);
    expect(opts.timeoutMs).toBeLessThanOrEqual(1500000);
    expect(opts.reviewCountCeiling).toBeNull();
    expect(opts.env).toEqual({ QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' });
    const expected = [
      'Please review this plan thoroughly. As you go, write your plan-mode plan to ' + path.join(opts.cwd, 'gstack-test-plan-devex.md') + ' (use Edit/Write to that exact path).',
      'Use DX POLISH mode for this review; examine the current plan with full rigor.',
      '', ${JSON.stringify(originalPlan)},
    ].join('\\n');
    const input = fs.readFileSync(path.join(opts.cwd, 'review-input.md'), 'utf8');
    expect(input.startsWith(expected + '\\n\\n')).toBe(true);
    const baseline = input.slice(expected.length + 2);
    expect(baseline.startsWith('## Existing SDK contracts (synthetic fixture assumptions)')).toBe(true);
    expect(baseline).toContain('are materialized product');
    expect(baseline).toContain('not runnable against an implementation in this review fixture.');
    expect(baseline).toContain("evaluate(target, cases, metric) accepts the developer's application callable");
    expect(baseline).toContain('caller supplies the metric');
    expect(baseline).toContain('Both the CLI and library enforce the mandatory first-run CI prerequisite');
    expect(baseline).toContain('without a\\n  separate scaffold/configuration language or an interactive demo');
    expect(baseline).toContain('no onboarding-duration measurement or peer-DX benchmark');
    expect(baseline).toContain('Cost ceilings remain enforced in\\n  noninteractive mode');
    expect(baseline).toContain('Releases preserve the\\n  published API/configuration contract during beta');
    for (const contract of [
      'five-line caller-owned exact-match metric for structured outputs',
      'neither is a bundled metric or an implicit default',
      'Result/Failure str/repr already show readable per-case scores',
      'structured fields retain full values',
      'maintainer compatibility/conformance checking using',
      'Evaluation does not\\n  consume that report or prerequisite state',
      'full five-minute step with no skip',
      'same configured ceilings/deadlines apply locally',
      'the library reports them when stderr is a TTY',
      'Library output never touches stdout',
      'code/anchor coverage',
      'snippets and shown output come from offline examples run in release checks',
      'runtime DeprecationWarning at\\n  the call site names the replacement',
      'Removal requires two minor releases of notice and a breaking release',
      'type hints and py.typed already ship',
    ]) expect(baseline).toContain(contract);

    for (const file of ['README.md', 'docs/getting-started.md', 'docs/feedback.md', 'docs/reference-v1.md']) {
      const body = fs.readFileSync(path.join(opts.cwd, file), 'utf8');
      expect(execFileSync('git', ['show', 'HEAD:' + file], { cwd: opts.cwd, encoding: 'utf8' })).toBe(body);
      expect(body).toBe(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'test/fixtures/devex-existing-sdk', file), 'utf8'));
    }
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: opts.cwd, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd: opts.cwd, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: opts.cwd, encoding: 'utf8' })).toBe(input);
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ cwd: opts.cwd, checked: true }));
    throw new Error('controlled DX runner failure');
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: () => { throw new Error('must not judge a failed runner'); },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-devex-finding-count.test.ts'))});
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT, timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull();
    expect(fs.existsSync(facts), output).toBe(true);
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.checked, output).toBe(true);
    expect(fs.existsSync(observed.cwd), 'actual paid finally must remove its owned fixture').toBe(false);
    expect(child.exitCode, output).toBe(1);
    expect(output).toContain('controlled DX runner failure');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('DX comparison registration passes and retains the exact owned final plan without another judge', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devex-comparison-free-')));
  const script = path.join(directory, 'registration.test.ts');
  const facts = path.join(directory, 'facts.json');
  const finalPlan = '# Reviewed plan\n\nExact completed comparison bytes, separate from the original review input.\n';
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const finalPlan = ${JSON.stringify(finalPlan)};
const factsPath = ${JSON.stringify(facts)};
let cwd, judgeCalls = 0;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  PLAN_SKILL_COUNT_FINALIZE_MS: 10000,
  devexStep0Boundary: () => false,
  assertReviewReportAtBottom: content => { expect(content).toBe(finalPlan); return { ok: true }; },
  runPlanSkillCounting: async opts => {
    cwd = opts.cwd;
    expect(path.dirname(cwd)).toBe(${JSON.stringify(directory)});
    fs.writeFileSync(path.join(cwd, 'gstack-test-plan-devex.md'), finalPlan);
    return { outcome: 'plan_ready', fingerprints: [], diagnostics: {}, elapsedMs: 100 };
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async input => {
    judgeCalls++;
    expect(judgeCalls).toBe(1);
    expect(input.devexPeerComparison).toEqual({ finalPlan });
    expect(input.plan).toBe(fs.readFileSync(path.join(cwd, 'review-input.md'), 'utf8'));
    expect(input.plan).not.toBe(finalPlan);
    expect(input.targets.map(target => target.id)).toEqual(['persona', 'first-run-benchmark', 'mandatory-ci', 'aha', 'peer-comparison']);
    expect(input.kind).toBe('findings'); expect(input.floor).toBe(4); expect(input.ceiling).toBe(7);
    expect(input.deadlineAt).toBeGreaterThan(Date.now() + 1400000);
    expect(input.deadlineAt).toBeLessThanOrEqual(Date.now() + 1500000);
    fs.writeFileSync(factsPath, JSON.stringify({ cwd, judgeCalls, finalPlan: input.devexPeerComparison.finalPlan }));
    return { count: 4, coveredTargetIds: input.targets.map(target => target.id) };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-devex-finding-count.test.ts'))});
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT, timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull(); expect(child.exitCode, output).toBe(0);
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.judgeCalls).toBe(1); expect(observed.finalPlan).toBe(finalPlan);
    expect(fs.existsSync(observed.cwd), 'actual paid finally must remove its owned fixture').toBe(false);
    const artifact = output.split('\n').find(line => line.startsWith('Plan review peer comparison artifact: '));
    expect(JSON.parse(artifact!.slice('Plan review peer comparison artifact: '.length))).toEqual({ finalPlan });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('materialized DX references have working local links without inventing completed launch work', () => {
  const fixture = path.join(ROOT, 'test/fixtures/devex-existing-sdk');
  const files = ['README.md', 'docs/getting-started.md', 'docs/feedback.md', 'docs/reference-v1.md'];
  for (const file of files) {
    const body = fs.readFileSync(path.join(fixture, file), 'utf8');
    for (const [, target] of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const [relative, anchor] = target!.split('#');
      const destination = path.resolve(path.dirname(path.join(fixture, file)), relative || path.basename(file));
      expect(destination.startsWith(fixture + path.sep)).toBe(true);
      const linked = fs.readFileSync(destination, 'utf8');
      if (anchor) {
        const headings = [...linked.matchAll(/^#+ (.+)$/gm)].map(match => match[1]!.toLowerCase()
          .replace(/[^\w\s-]/g, '').replace(/\s/g, '-'));
        expect(headings, target).toContain(anchor);
      }
    }
  }
  const readme = fs.readFileSync(path.join(fixture, 'README.md'), 'utf8');
  expect(readme).toContain('no selected primary developer persona or peer-DX study');
  expect(readme).toContain('No first-run duration has\nbeen measured');
  expect(readme).toContain('There is no skip');
  expect(readme).toContain('no interactive demo or designed aha sequence');
  expect(readme).toContain('one ordinary passing case; it has no staged regression');
  const reference = fs.readFileSync(path.join(fixture, 'docs/reference-v1.md'), 'utf8');
  const guide = fs.readFileSync(path.join(fixture, 'docs/getting-started.md'), 'utf8');
  const errorLink = /^Reference: (docs\/[^#]+)#([^\s]+)$/m.exec(guide);
  expect(errorLink).not.toBeNull();
  expect(fs.readFileSync(path.join(fixture, errorLink![1]!), 'utf8')).toBe(reference);
  const errorHeadings = [...reference.matchAll(/^### (.+)$/gm)].map(match => match[1]!.toLowerCase().replace(/\s/g, '-'));
  expect(errorHeadings).toContain(errorLink![2]!);

  expect(reference).toContain('cannot interrupt arbitrary application code or cap requests made by a separate');
  expect(reference).toContain('Examples describe\nits assumed existing interface; they have not been executed');
});
