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
      expect(beforeAudit).toContain('including Step 0 and outside voice');
      expect(beforeAudit).toContain('One independent choice per AskUserQuestion call, never separate tabs');
      // Claude loads the review section later; these evidence limits must also
      // govern Step 0's first journey questions on every host.
      const earlyEvidence = beforeAudit.replace(/\s+/g, ' ');
      expect(earlyEvidence).toContain('A description of what a reporter includes does not establish its exact words');
      expect(earlyEvidence).toContain('Confirmation of an empathy narrative is not runtime observation');
      const journey = content.slice(content.indexOf('### 0F.'), content.indexOf('### 0G.'));
      const wholeGate = journey.indexOf('Run all four Decision gate steps');
      expect(wholeGate).toBeGreaterThanOrEqual(0);
      expect(wholeGate).toBeLessThan(journey.indexOf('> "Journey Stage: INSTALL'));
      expect(journey).not.toContain('AskUserQuestion per friction point');
      const mode = content.slice(content.indexOf('### 0E. Mode Selection'), content.indexOf('Context-dependent defaults:'));
      expect(mode).toContain('Use the mode the user explicitly requested for this review.');
      expect(mode).toContain('skip the mode question and continue to 0F. Otherwise, ask below.');
      const sectionText = generated.artifacts.filter(item => item.kind === 'section'
        && item.host === artifact.host && item.relativePath.startsWith('plan-devex-review/'))
        .map(item => fs.readFileSync(path.join(outputRoot, item.relativePath), 'utf8')).join('\n');
      const allContent = content + '\n' + sectionText;
      expect(allContent).toContain('if viable, split them before asking');
      expect(allContent).toContain('A code example and an optional checklist are separate choices');
      expect(allContent).toContain('as are a timer and its release-gate policy');
      const gate = beforeAudit.indexOf('### Decision gate');
      const ground = beforeAudit.indexOf('1. **Ground the evidence.**', gate);
      const classify = beforeAudit.indexOf('2. **Classify the finding.**', gate);
      const scope = beforeAudit.indexOf('3. **Check the scope.**', gate);
      const options = beforeAudit.indexOf('4. **Draft and answer one decision.**', gate);
      expect([gate, ground, classify, scope, options].every((offset, i, offsets) =>
        offset >= 0 && (i === 0 || offset > offsets[i - 1]!))).toBe(true);
      const localRule = allContent.slice(allContent.indexOf('## CRITICAL RULE — How to ask questions'),
        allContent.indexOf('## Required Outputs', allContent.indexOf('## CRITICAL RULE — How to ask questions')));
      expect(localRule).toContain('Run the Decision gate before drafting options.');
      expect(localRule).not.toContain('use AskUserQuestion for each gap');
      expect(allContent).toContain('Record observed human onboarding separately from automated execution');
      expect(allContent).toContain('a warm snippet timer is neither a fresh-start check nor a human benchmark');
      expect(allContent).toContain('Keep estimates labeled until measured');
      const benchmark = content.slice(content.indexOf('### 0C. Competitive DX Benchmarking'),
        content.indexOf('### 0D. Magical Moment Design'));
      expect(benchmark.indexOf('Define the clock before comparing')).toBeGreaterThanOrEqual(0);
      expect(benchmark.indexOf('Define the clock before comparing')).toBeLessThan(benchmark.indexOf('AskUserQuestion:'));
      expect(benchmark).toContain('Compare times only across equivalent boundaries');
      expect(benchmark).toContain('Never infer no wait from a peer');
      expect(benchmark).toContain('Start → result');
      expect(benchmark).toContain('Carry the approved clock and target into 0D, Pass 1, Pass 8 and the report');
      expect(allContent).toContain('Measure the approved 0C clock and 0D useful result');
      expect(allContent).not.toContain('**STOP.** AskUserQuestion once per issue.');
      expect(allContent).toContain('A target tier does not itself approve telemetry, an automated');
      expect(allContent).toContain('only when proposing them, with ownership and frequency explicit');
      expect(allContent).toContain('Continue the same working list from Step 0');
      expect(allContent).toContain('compare its evidence with the prior decision and options already considered');
      expect(allContent).toContain('A disclosed tradeoff or rejected alternative is not new evidence merely because a reviewer prefers it');
      expect(allContent).toContain('identify a concrete contradiction or changed assumption before reopening');
      expect(allContent).toContain('Unverified loss of existing coverage remains a risk to verify');
      expect(allContent).toContain('not proof that a new release policy is needed');
      expect(allContent).toContain('If a necessary remedy crosses an explicit scope boundary, name that boundary');
      expect(allContent).toContain('obtain scope approval before choosing or applying the remedy');
      expect(allContent).toContain('Implementation details and proof of one chosen behavior\nstay together; independent policies each need their own decision');

    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }); }
}, 20_000);

test('the actual DX finding registration commits its mode, unchanged defects, and existing contracts before launch', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devex-count-free-')));
  const script = path.join(directory, 'registration.test.ts');
  const facts = path.join(directory, 'facts.json');
  const originalPlan = [
    '# Plan: First-Run Onboarding Polish for the Public SDK Beta', '',
    'This change is limited to first-run onboarding polish for the existing SDK.',
    'All five obligations below remain unresolved, including the mandatory first-run',
    'gate in both the API and CLI. Other existing API/CLI semantics, packaging and',
    'release-policy work are not otherwise redesign scope. Documentation/reference',
    'corrections and genuine risks required by the selected persona or new onboarding',
    'journey remain in scope. Unknown baseline details stay unknown, not assumed solved.',
    '', '## Persona',
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
  expect(reference).toContain('those calls have not been executed against\nthe SDK here');
  expect(reference).toContain('Fixture checks execute the local application files and explicit\ncontract doubles');
});

test('materialized DX error examples identify their cause, bound and reachable code reference', () => {
  const reference = fs.readFileSync(path.join(ROOT, 'test/fixtures/devex-existing-sdk/docs/reference-v1.md'), 'utf8');
  const expected = [
    { heading: '### SDK E002', count: 1, causes: ['MetricTypeError'], values: ['cases[0]'] },
    { heading: '### SDK E003', count: 2, causes: ['DeadlineExceeded', 'ManagedProviderCostLimit'],
      values: ['deadline_seconds=20', 'max_cost_usd=0.25'] },
  ];
  for (const spec of expected) {
    const start = reference.indexOf(spec.heading);
    const next = reference.indexOf('\n##', start + spec.heading.length);
    const section = reference.slice(start, next < 0 ? undefined : next);
    const blocks = [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]!);
    expect(blocks, spec.heading).toHaveLength(spec.count);
    for (const [index, block] of blocks.entries()) {
      const code = spec.heading.replace('### SDK ', 'SDK_');
      expect(block.split('\n')[0]).toStartWith(code + ':');
      expect(block).toContain('Cause: ' + spec.causes[index]);
      expect(block).toContain(spec.values[index]!);
      expect(block).toMatch(/^Next: .+/m);
      const anchor = spec.heading.replace('### ', '').toLowerCase().replace(/ /g, '-');
      expect(block).toContain('Reference: docs/reference-v1.md#' + anchor);
    }
  }
});

// Materialize the documented files in a temp directory. These controls test
// application examples against an explicit contract stub, never the absent SDK.
const dxDocs = () => Object.fromEntries(['README.md', 'docs/getting-started.md', 'docs/reference-v1.md']
  .map(file => [file, fs.readFileSync(path.join(ROOT, 'test/fixtures/devex-existing-sdk', file), 'utf8')]));
function dxBlock(body: string, after: string, language: string): string {
  const offset = body.indexOf(after);
  expect(offset, `missing documented example: ${after}`).toBeGreaterThanOrEqual(0);
  const match = new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```').exec(body.slice(offset));
  expect(match, `missing ${language} block after ${after}`).not.toBeNull();
  return match![1]!;
}
function runDxDocumentationControl(code: string, payload: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devex-doc-control-'));
  try {
    const script = path.join(directory, 'control.py');
    fs.writeFileSync(script, code);
    // Like bin/gstack-config, support both Python command names. Windows
    // installs normally expose python.exe; avoid preferring its python3 Store alias.
    const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
      .map(command => Bun.which(command)).find((command): command is string => command !== null);
    if (!python) throw new Error('Python 3 is required for the DX documentation controls');
    const child = Bun.spawnSync([python, script], { cwd: directory, timeout: 10_000,
      stdin: Buffer.from(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe' });
    expect(child.signalCode ?? null, child.stderr.toString()).toBeNull();
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return child.stdout.toString();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('materialized DX success blocks print the documented structured fields without assuming SDK repr', () => {
  const docs = dxDocs();
  const first = dxBlock(docs['README.md']!, '## Quick start', 'python');
  expect(first).toBe(dxBlock(docs['docs/getting-started.md']!, '## Neutral first evaluation', 'python'));
  const examples = [
    { code: first, expected: dxBlock(docs['README.md']!, 'Shown application output', 'text') },
    { code: dxBlock(docs['docs/getting-started.md']!, '## Neutral first evaluation', 'python'),
      expected: dxBlock(docs['docs/getting-started.md']!, 'Shown application output', 'text') },
    { code: dxBlock(docs['docs/getting-started.md']!, '## Caller-owned metric for free text', 'python'),
      expected: dxBlock(docs['docs/getting-started.md']!, 'Shown free-text application output', 'text') },
  ];
  for (const { code } of examples) { expect(code).not.toContain('print(result)'); expect(code).toContain('result.cases'); }
  const output = runDxDocumentationControl(String.raw`
import contextlib, io, json, sys, types
examples = json.load(sys.stdin)
# Deliberate assumed-contract double: not an implementation of eval-sdk.
def evaluate(target, cases, metric):
    result = []
    for case in cases:
        actual = target(case['inputs'])
        result.append(types.SimpleNamespace(actual=actual, expected=case['expected'], score=metric(actual, case['expected'])))
    return types.SimpleNamespace(cases=result)
stub = types.ModuleType('eval_sdk'); stub.evaluate = evaluate; sys.modules['eval_sdk'] = stub
for example in examples:
    output = io.StringIO(); namespace = {}
    with contextlib.redirect_stdout(output): exec(example['code'], namespace)
    assert output.getvalue().strip() == example['expected']
    assert json.loads(output.getvalue())[0]['score'] == 1.0
# Preserve the caller-owned metric's mismatching-prose behavior separately.
assert namespace['text_metric']('red', 'green') == 0.0
print('three documented outputs match the contract stub; no SDK executed')
`, examples);
  expect(output).toContain('three documented outputs match the contract stub; no SDK executed');
});

test('materialized DX application client bounds actual local process timeouts, retries and reservations', () => {
  const guide = dxDocs()['docs/getting-started.md']!;
  const client = dxBlock(guide, 'Save as `bounded_client.py`', 'python');
  const transport = dxBlock(guide, 'Save as `fixture_transport.py`', 'python');
  const usage = dxBlock(guide, 'Use the application client in the callable', 'python');
  expect(guide).toContain('verified upper bound');
  expect(guide).toContain('not refunded');
  expect(guide).toContain('does not prove that a remote provider cancelled');
  const output = runDxDocumentationControl(String.raw`
import json, pathlib, subprocess, sys, time, types
payload = json.load(sys.stdin)
pathlib.Path('bounded_client.py').write_text(payload['client'])
pathlib.Path('fixture_transport.py').write_text(payload['transport'])
from bounded_client import BoundedClient
# Observe the real handles; subprocess.run still owns timeout/kill/wait.
original_popen = subprocess.Popen
children = []
def capture_popen(*args, **kwargs):
    child = original_popen(*args, **kwargs)
    children.append(child)
    return child
subprocess.Popen = capture_popen
command = [sys.executable, 'fixture_transport.py']
client = BoundedClient(command, timeout_seconds=1, max_attempts=2, total_cents=4, attempt_cents=2)
assert client({'enabled': True}) == {'ready': True}
assert client.reserved_cents == 2
assert client({'enabled': False}) == {'ready': False}
assert client.reserved_cents == 4
try: client({'enabled': True}); raise AssertionError('budget exceeded')
except RuntimeError as e: assert 'spending limit' in str(e)
assert client.reserved_cents == 4
# Calls sharing this application client also share one reservation ceiling.
from concurrent.futures import ThreadPoolExecutor
client = BoundedClient(command, timeout_seconds=1, max_attempts=2, total_cents=4, attempt_cents=2)
def concurrent_call(_):
    try: return client({'enabled': True})
    except RuntimeError as e:
        assert 'spending limit' in str(e); return None
with ThreadPoolExecutor(max_workers=4) as pool: outputs = list(pool.map(concurrent_call, range(4)))
assert outputs.count({'ready': True}) == 2 and outputs.count(None) == 2
assert client.reserved_cents == 4
# Real child failure/retry and real child timeout: no network or SDK involved.
pathlib.Path('controlled_transport.py').write_text('''import sys, time
mode = sys.argv[1]
with open('attempts', 'a') as f: f.write('attempt\\n')
if mode == 'stall': time.sleep(30)
if mode == 'fail': sys.exit(75)
''')
for mode in ('fail', 'stall'):
    first_child = len(children)
    pathlib.Path('attempts').unlink(missing_ok=True)
    client = BoundedClient([sys.executable, 'controlled_transport.py', mode], timeout_seconds=0.2,
                           max_attempts=2, total_cents=6, attempt_cents=2)
    started = time.monotonic()
    try: client({'enabled': True}); raise AssertionError('failed transport succeeded')
    except (RuntimeError, subprocess.TimeoutExpired): pass
    assert time.monotonic() - started < 3
    attempts = pathlib.Path('attempts').read_text().splitlines()
    owned_children = children[first_child:]
    assert len(attempts) == len(owned_children) == 2 and client.reserved_cents == 4
    for child in owned_children:
        assert child.poll() is not None, 'transport process leaked'
        assert child.wait(timeout=0) == child.returncode
        assert child.returncode != 0
        if mode == 'fail': assert child.returncode == 75
# Insufficient reservation prevents even the retry from starting.
pathlib.Path('attempts').unlink()
client = BoundedClient([sys.executable, 'controlled_transport.py', 'fail'], timeout_seconds=1,
                       max_attempts=2, total_cents=2, attempt_cents=2)
try: client({'enabled': True}); raise AssertionError('budget exceeded')
except RuntimeError as e: assert 'spending limit' in str(e)
assert len(pathlib.Path('attempts').read_text().splitlines()) == 1
assert client.reserved_cents == 2
# The full shown usage sends independent limits to the SDK contract double.
seen = []
def evaluate(target, cases, metric, **options):
    seen.append(options)
    assert target(cases[0]['inputs']) == cases[0]['expected']
    return types.SimpleNamespace(cases=[])
stub = types.ModuleType('eval_sdk'); stub.evaluate = evaluate; sys.modules['eval_sdk'] = stub
exec(payload['usage'], {})
assert seen == [{'deadline_seconds': 20, 'max_cost_usd': 0.25}]
print('local timeout/retry/reservation bounds verified; no SDK/provider call')
`, { client, transport, usage });
  expect(output).toContain('local timeout/retry/reservation bounds verified; no SDK/provider call');
});

test('materialized DX CLI cases and import targets match the exact shown invocation in an offline contract double', () => {
  const reference = dxDocs()['docs/reference-v1.md']!;
  const cli = reference.slice(reference.indexOf('## CLI'), reference.indexOf('## Errors'));
  const payload = { app: dxBlock(cli, 'Save as `app.py`', 'python'), cases: dxBlock(cli, 'Save as `cases.json`', 'json'),
    command: dxBlock(cli, 'Run with the assumed SDK', 'bash') };
  expect(JSON.parse(payload.cases)).toEqual([{ inputs: { enabled: true }, expected: { ready: true } }]);
  const output = runDxDocumentationControl(String.raw`
import argparse, importlib, json, pathlib, shlex, sys
payload = json.load(sys.stdin)
pathlib.Path('app.py').write_text(payload['app']); pathlib.Path('cases.json').write_text(payload['cases'])
# Parse the documented command as an explicit contract double, not the absent CLI.
args = shlex.split(payload['command']); assert args[:2] == ['eval-sdk', 'run']
parser = argparse.ArgumentParser()
for flag in ('target', 'cases', 'metric', 'deadline-seconds', 'max-cost-usd'): parser.add_argument('--' + flag, required=True)
parser.add_argument('--no-input', action='store_true')
options = parser.parse_args(args[2:])
assert options.no_input and options.deadline_seconds == '20' and options.max_cost_usd == '0.25'
def resolve(value):
    module, name = value.split(':'); return getattr(importlib.import_module(module), name)
target, metric = resolve(options.target), resolve(options.metric)
cases = json.loads(pathlib.Path(options.cases).read_text())
assert isinstance(cases, list) and len(cases) == 1
for case in cases:
    assert set(case) == {'inputs', 'expected'}
    assert metric(target(case['inputs']), case['expected']) == 1.0
print('shown cases file, CLI arguments and import targets agree; no SDK executed')
`, payload);
  expect(output).toContain('shown cases file, CLI arguments and import targets agree; no SDK executed');
});
