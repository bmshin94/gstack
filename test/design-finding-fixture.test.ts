import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateDesignMockup } from '../scripts/resolvers/design';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

test('the actual Design count caller commits neutral existing contracts before observation', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-count-fixture-')));
  const facts = path.join(dir, 'facts.json');
  const child = path.join(dir, 'caller.test.ts');
  try {
    fs.writeFileSync(child, `import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertReviewReportAtBottom, designStep0Boundary, PLAN_SKILL_COUNT_FINALIZE_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
import { DESIGN_FINDINGS, pickPlanReviewQuestion } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
const report = assertReviewReportAtBottom, boundary = designStep0Boundary, finalize = PLAN_SKILL_COUNT_FINALIZE_MS;
const { seedDesignBoardActorProtocol, DESIGN_BOARD_ACTOR_PROTOCOL } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-board-feedback.ts'))});
let pickerScope;
const designPicker = question => pickPlanReviewQuestion(question);
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-board-feedback.ts'))}, () => ({
  seedDesignBoardActorProtocol,
  createDesignReviewPicker: scope => { pickerScope = scope; return designPicker; },
}));
let project = '', plan = '', observations = 0;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  assertReviewReportAtBottom: report, designStep0Boundary: boundary, PLAN_SKILL_COUNT_FINALIZE_MS: finalize,
  runPlanSkillCounting: async opts => {
    observations++; project = opts.cwd;
    plan = fs.readFileSync(path.join(project, 'review-input.md'), 'utf8');
    const design = fs.readFileSync(path.join(project, 'DESIGN.md'), 'utf8');
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toContain(DESIGN_BOARD_ACTOR_PROTOCOL);
    expect(design).toContain('disabled-opacity token to every visual');
    expect(design).toContain('values already use named CSS custom properties');
    expect(design).toContain('unchanged FormStack uses 16px between fields');
    expect(design).toContain('8px between a label and its input');
    expect(design).toContain('Reset and Export are\\ndisabled, Cancel remains available');
    expect(design).toContain('two-pixel offset on all Button variants');
    expect(design).toContain('Settings role values are scoped to the Settings page.');
    expect(design).toContain('wrap in their existing order, with intrinsic widths');
    expect(design).toContain('No new storyboard or onboarding flow is required.');
    expect(design).toContain('choosing the five proposed visual treatments remains open.');
    for (const file of ['DESIGN.md', 'review-input.md', 'CLAUDE.md']) {
      expect(execFileSync('git', ['show', 'HEAD:' + file], { cwd: project, encoding: 'utf8', timeout: 5000 }))
        .toBe(fs.readFileSync(path.join(project, file), 'utf8'));
    }
    expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd: project, encoding: 'utf8', timeout: 5000 })).toBe('');
    expect(plan).toContain('same size, weight, and color as');
    expect(plan).toContain('24px in some places, 32px in others, and 16px');
    expect(plan).toContain('approximately 3:1 (below WCAG AA)');
    expect(plan).toContain('14px, 16px, and 18px font sizes');
    expect(plan).toContain('2-5 seconds with no loading indicator');
    expect(opts).toEqual({ readDesignArtifacts: true, skillName: 'plan-design-review', slashCommand: '/plan-design-review',
      followUpPrompt: '', isLastStep0AUQ: boundary, reviewCountCeiling: null, questionPick: designPicker,
      cwd: project, timeoutMs: expect.any(Number), env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' } });
    expect(opts.timeoutMs).toBeGreaterThan(0); expect(opts.timeoutMs).toBeLessThanOrEqual(1500000);
    expect(pickerScope.cwd).toBe(project);
    expect(pickerScope.deadlineAt).toBeGreaterThan(Date.now());
    expect(pickerScope.deadlineAt).toBeLessThanOrEqual(Date.now() + 1500000);
    expect(finalize).toBe(10000);
    fs.writeFileSync(path.join(project, 'gstack-test-plan-design.md'), '# Reviewed plan\\n\\n## GSTACK REVIEW REPORT\\nVERDICT: APPROVED\\n');
    return { outcome: 'plan_ready', fingerprints: [], diagnostics: {}, step0Count: 2, reviewCount: 5, elapsedMs: 1000 };
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async input => {
    expect(input).toEqual({ plan, targets: DESIGN_FINDINGS, fingerprints: [], kind: 'findings', floor: 4, ceiling: 7, deadlineAt: expect.any(Number) });
    expect(input.deadlineAt).toBeGreaterThan(Date.now());
    expect(input.deadlineAt).toBe(pickerScope.deadlineAt);
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ observations, project, targetIds: input.targets.map(t => t.id) }));
    return { count: 5, coveredTargetIds: DESIGN_FINDINGS.map(t => t.id) };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-design-finding-count.test.ts'))});
`);
    await promisify(execFile)(process.execPath, ['test', child], {
      cwd: ROOT, env: { ...process.env, TMPDIR: dir }, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(result.observations).toBe(1);
    expect(result.targetIds).toEqual(['primary-action', 'spacing', 'contrast', 'typography', 'save-feedback']);
    expect(fs.existsSync(result.project)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15_000);


// Execute the documented setup, not a duplicate implementation of its path choice.
// The designer and provider are never invoked; mkdir is the observed side effect.
for (const storage of ['configured', 'plugin', 'default']) test(`Design mockup setup honors ${storage} state storage`, async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-output-root-')));
  const home = path.join(directory, 'operator home');
  const configured = path.join(directory, 'private state');
  const plugin = path.join(directory, 'plugin state');
  const cwd = path.join(directory, 'settings-fixture');
  try {
    fs.mkdirSync(path.join(home, '.claude/skills/gstack'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'bin'), path.join(home, '.claude/skills/gstack/bin'), 'dir');
    fs.mkdirSync(cwd);
    await promisify(execFile)('git', ['init', '-q', cwd], { timeout: 5000 });
    const expected = storage === 'configured' ? configured : storage === 'plugin' ? plugin : path.join(home, '.gstack');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: '', TMPDIR: directory, TMP: directory,
      ...(storage === 'configured' ? { GSTACK_HOME: configured, CLAUDE_PLUGIN_DATA: plugin, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } : {}),
      ...(storage === 'plugin' ? { CLAUDE_PLUGIN_DATA: plugin, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } : {}) };
    const sources = [
      ...['plan-design-review/SKILL.md.tmpl', 'design-shotgun/SKILL.md.tmpl',
        'design-consultation/sections/proposal-and-preview.md.tmpl', 'design-review/SKILL.md.tmpl']
        .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')),
      generateDesignMockup({ skillName: 'office-hours', tmplPath: '', host: 'claude', paths: HOST_PATHS.claude! }),
    ];
    let mockupDirectory = '';
    for (const source of sources) {
      const block = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)]
        .find(match => /(?:_DESIGN_DIR|REPORT_DIR)=/.test(match[1]!))?.[1];
      expect(block).toBeDefined();
      const { stdout } = await promisify(execFile)('bash', ['-c', block!.replaceAll('<screen-name>', 'settings-page')], {
        cwd, env, timeout: 5000,
      });
      const output = stdout.match(/^(?:DESIGN_DIR|REPORT_DIR): (.+)$/m)?.[1];
      expect(output).toBeDefined();
      expect(path.resolve(path.dirname(output!))).toBe(path.resolve(expected, 'projects', 'settings-fixture', 'designs'));
      expect(fs.statSync(output!).isDirectory()).toBe(true);
      if (!mockupDirectory) mockupDirectory = output!;
    }
    // Execute the optional ideal-image command with a local stand-in for the
    // provider binary, observing its exact output argument and created image.
    const fakeDesign = path.join(home, '.claude/skills/gstack/design/dist/design');
    fs.mkdirSync(path.dirname(fakeDesign), { recursive: true });
    fs.writeFileSync(fakeDesign, '#!/bin/sh\nprintf \'%s\n\' "$@" > "$DESIGN_FAKE_ARGS"\nwhile [ "$1" != --output ]; do shift; done\nshift\nprintf fixture > "$1"\n');
    fs.chmodSync(fakeDesign, 0o755);
    const argsPath = path.join(directory, 'ideal-args.txt');
    const idealBlock = [...sources[0]!.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .find(match => match[1]!.includes('ideal-<dimension>.png'))?.[1];
    expect(idealBlock).toBeDefined();
    const idealResult = await promisify(execFile)('bash', ['-c', idealBlock!.replaceAll('<dimension>', 'hierarchy')], {
      cwd, env: { ...env, DESIGN_FAKE_ARGS: argsPath }, timeout: 5000,
    });
    const idealPath = idealResult.stdout.match(/^IDEAL_IMAGE: (.+)$/m)?.[1];
    expect(idealPath).toBeDefined();
    expect(path.resolve(path.dirname(path.dirname(idealPath!))))
      .toBe(path.resolve(expected, 'projects', 'settings-fixture', 'designs'));
    expect(fs.readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual([
      'generate', '--brief', '<description of what 10/10 looks like for this dimension>', '--output', idealPath!,
    ]);
    expect(fs.readFileSync(idealPath!, 'utf8')).toBe('fixture');
    for (const file of ['approved.json', 'variant-A.png', 'finalized.html']) fs.writeFileSync(path.join(mockupDirectory, file), 'fixture');
    const consumer = fs.readFileSync(path.join(ROOT, 'design-html/SKILL.md.tmpl'), 'utf8');
    let discovered = '';
    for (const match of consumer.matchAll(/```bash\n([\s\S]*?)\n```/g)) {
      if (!/_(?:APPROVED|VARIANTS|FINALIZED)=/.test(match[1]!)) continue;
      const { stdout } = await promisify(execFile)('bash', ['-c', match[1]!], { cwd, env, timeout: 5000 });
      discovered += stdout;
    }
    for (const [label, file] of [['APPROVED', 'approved.json'], ['VARIANTS', 'variant-A.png'], ['FINALIZED', 'finalized.html']]) {
      expect(discovered).toContain(`${label}: ${mockupDirectory}/${file}`);
    }
    // Existing slug-cache behavior is separate from the design artifact namespace.
    if (storage !== 'default') expect(fs.existsSync(path.join(home, '.gstack/projects'))).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual(['.git']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
