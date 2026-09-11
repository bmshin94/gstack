/**
 * plan-ceo-review carve — static ordering guard (GATE tier, free, deterministic).
 *
 * This is the per-PR mechanical backstop for the v2-plan Phase B carve of
 * plan-ceo-review (Codex outside-voice P2). The periodic real-PTY E2E
 * (skill-e2e-plan-ceo-review-section-loading.test.ts) is the behavioral proof,
 * but it runs weekly and costs money. This file runs on every `bun test` and
 * fails CI the moment the carve's structural invariants break:
 *
 *  1. The skeleton points at the section with a STOP-Read directive, and that
 *     directive sits AFTER Step 0 (scope + mode) — so the conversational Step 0
 *     stays in the always-loaded skeleton, never stranded in the on-demand file.
 *  2. The heavy review body (Sections 1-11) is NOT in the skeleton — it moved to
 *     the section. A regression that inlines it back would re-bloat the skeleton.
 *  3. The review report writer ("GSTACK REVIEW REPORT") lives in the section, and
 *     the blocking EXIT PLAN MODE GATE that verifies it lives in the skeleton
 *     AFTER the STOP — so the gate fires once the section work returns.
 *  4. Nothing review-governing sits in the skeleton below the STOP (Codex P1):
 *     no "Section N", no "## Mode Quick Reference", no "## Formatting Rules".
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { validateCeoReviewCompletion } from './helpers/auq-sdk-capture';
import { generateAntiShortcutClause } from '../scripts/resolvers/review';
import type { TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';

const ROOT = path.resolve(import.meta.dir, '..');
const SKELETON = path.join(ROOT, 'plan-ceo-review', 'SKILL.md');
const SECTION = path.join(ROOT, 'plan-ceo-review', 'sections', 'review-sections.md');

// Boundary checks stay on source templates: generated carriers remain the
// integration owner's responsibility, and these do not prove model behavior.
describe('CEO review decision boundaries contract', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const alternatives = skeleton.split('### 0C-bis.')[1]?.split('### 0D-prelude.')[0] ?? '';
  const temporal = skeleton.split('### 0E.')[1]?.split('### 0F.')[0] ?? '';
  const apply = section.split('**Apply.**')[1]?.split('### Section 1:')[0] ?? '';

  test('every approach comparison holds independent contracts and remedies constant', () => {
    expect(alternatives).toContain('Preserve accepted requirements and unchanged contracts');
    expect(alternatives).toContain('For every approach comparison');
    expect(alternatives).toContain('identify one decision first');
    expect(alternatives).toContain('Hold only approved behavior, coverage and remedies constant');
    expect(alternatives).toContain('other choices stay pending outside option commitments');
    expect(alternatives).toContain('cannot bundle coverage choices for separate contracts');
    expect(alternatives).not.toContain('for architecture choices');
    expect(alternatives).toContain('Ask each pending remedy separately');
    expect(alternatives).toContain('Combine only inseparable choices; explain the constraint and exact scope approved');
    expect(alternatives).toContain('Approving an approach approves no pending remedy');
    expect(alternatives).toContain('Direct implementation and tests proving the same behavior belong together');
    expect(alternatives).toContain('Sharing a file or step is not coupling');
    expect(alternatives).toContain('"minimal viable"');
    expect(alternatives).toContain('"ideal architecture"');
    expect(alternatives).toContain('New/reopened choices need user approval before 0D/0F');
  });

  test('settled approach authority resolves the gate while new choices still require approval', () => {
    const approach = alternatives.split('### 0F. Mode Selection')[0]!;
    const reuse = approach.split('For new/reopened choices, compare')[0]!;
    const gate = approach.split('**STOP:**')[1] ?? '';
    expect(reuse).toContain('Evaluate approaches before 0F');
    expect(reuse).toContain('applicable instructions or an accepted decision');
    expect(reuse).toContain('cite that authority');
    expect(reuse).toContain('mark 0C-bis resolved without re-asking');
    expect(reuse).toContain('unless concrete contradiction or changed assumptions warrant reopening');
    expect(gate).toContain('New/reopened choices need user approval before 0D/0F, even one viable option');
    expect(gate).toContain('A recommendation is not approval');
    expect(approach).not.toContain('Do NOT proceed to Step 0D or 0F until the user responds to 0C-bis');
    expect(approach).toContain('Ask each pending remedy separately');
  });

  test('coverage scoring is conditional and legitimate early decisions retain their exact approval', () => {
    expect(alternatives).toContain('only for coverage of that one decision');
    expect(alternatives.indexOf('identify one decision first')).toBeLessThan(alternatives.indexOf('Completeness: N/10'));
    expect(alternatives).toContain('Note: options differ in kind, not coverage — no completeness score.');
    expect(alternatives).not.toContain('These approaches differ in coverage (minimal viable vs ideal architecture)');
    expect(temporal).toContain('separate questions for the user NOW');
    expect(temporal).toContain('Do not defer a critical risk');
    expect(temporal).toContain('An explicit Step 0 answer remains valid');
    expect(temporal).toContain('exact accepted choice and scope');
    expect(temporal).toContain('Do not ask again merely to move a decision into a review section');
  });

  test('an unresolved section decision is answered before its scoped plan amendment', () => {
    const steps = [
      'If the current section has an unresolved or reopened decision, call AskUserQuestion',
      'After the actual answer, check each new or changed commitment',
      'Then use a scoped Edit',
      'Once the current section\'s decisions have answers, record its review conclusions',
    ].map(step => apply.indexOf(step));
    expect(steps.every(position => position >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(apply).toContain('STOP until the user responds');
    expect(apply).toContain('If no plan file exists, first create it from the provided input and explicitly accepted Step 0 decisions');
    expect(apply).toContain('against the selected option or an explicit earlier approval');
    expect(apply).toContain('Preserve existing content and approvals, including direct implementation and verification of the accepted behavior');
    expect(apply).toContain('before advancing to the next section');
  });

  test('pending labels authorize only unresolved notes, not an outcome or future review conclusions', () => {
    expect(apply).toContain('only the pending issue, evidence, and alternatives in the ledger');
    expect(apply).toContain('A pending label does not authorize a task, verification step, or diagram to prescribe an unapproved outcome');
    expect(apply).toContain('record the choice and its authorized amendments, including explicit deferrals');
    expect(apply).toContain('Details found only in pending proposals or surrounding analysis remain pending');
    expect(apply).toContain('Preserve unsupported premises as unknown: choosing a remedy does not verify its factual premise');
    expect(apply).toContain('Add later sections\' review conclusions and implementation tasks only after evaluating those sections');
    expect(apply).toContain('Approval settles the planning choice; it does not prove the mitigation is implemented');
    expect(apply).toContain('Retain unresolved choices and supporting findings in the ledger and final report');
  });
});

// These are source-contract checks, not model-behavior evidence. Read the
// template and resolve its shared clause directly so an old generated carrier
// cannot conceal conflicting per-section instructions during implementation.
describe('CEO review decision continuity contract', () => {
  const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const clauses = ALL_HOST_CONFIGS.map(host => generateAntiShortcutClause({
    skillName: 'plan-ceo-review', host: host.name,
  } as TemplateContext));
  const continuity = template.split('### Working review decisions')[1]?.split('### Section 1:')[0] ?? '';

  test('analysis, decision, and approved amendment precede advancing to the next section', () => {
    expect(continuity).not.toBe('');
    const positions = ['**Analyze.**', '**Resolve.**', '**Apply.**'].map(step => continuity.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(continuity).toContain('before advancing to the next section');
    for (const clause of clauses) {
      expect(clause).toContain('Analyze → resolve → apply');
      expect(clause).toContain('Do not prewrite the remaining sections');
      expect(clause).toContain('Proposed findings are not accepted plan changes');
      expect(clause).toContain('full review and terminal report');
    }
  });

  test('all eleven section gates preserve decisions without manufacturing a question per section', () => {
    const sections = [...template.matchAll(/^### Section (\d+):([^]*?)(?=^### Section \d+:|^\{\{CODEX_PLAN_REVIEW\}\})/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    for (const [, number, body] of sections) {
      expect(body, `Section ${number}`).toContain('For each unresolved or reopened decision');
      expect(body, `Section ${number}`).toContain('one issue = one AskUserQuestion call');
      expect(body, `Section ${number}`).toContain('STOP until the user responds');
      expect(body, `Section ${number}`).toContain('If no decision remains');
    }
    expect(template).not.toContain('If the section has findings, you MUST call AskUserQuestion');
    expect(template).not.toContain('Otherwise, use AskUserQuestion for each finding');
    expect(template).not.toContain('After each section, pause and wait for feedback');
    expect(template).toContain('Never condense, abbreviate, or skip any review section (1-11)');
    expect(template).toContain('### Completion Summary');
    expect(template).toContain('{{PLAN_FILE_REVIEW_REPORT}}');
  });

  test('the ledger carries exact approvals and declared contracts without claiming implementation', () => {
    const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
    const start = skeleton.indexOf('From input reading through Step 0 and outside voice');
    expect(start).toBeGreaterThan(skeleton.indexOf('## Step 0:'));
    expect(start).toBeLessThan(skeleton.indexOf('### 0C-bis.'));
    const earlyLedger = skeleton.slice(start, skeleton.indexOf('### 0A.'));
    expect(earlyLedger).toContain('declared contracts, conventions, existing coverage and exact decisions');
    expect(earlyLedger).toContain('concrete contradiction or changed assumptions');
    expect(earlyLedger).toContain('hypothetical violations or model agreement alone do not invalidate a contract');
    expect(earlyLedger).toContain('Keep actual code risks visible');
    expect(earlyLedger).toContain('Preserve stated units and dependencies');
    expect(earlyLedger).toContain('Changing them via reuse or savings needs evidence and approval');
    expect(earlyLedger).toContain('a deliverable cap is not a time budget');
    const temporal = skeleton.split('### 0E.')[1]?.split('{{SECTION:review-sections}}')[0] ?? '';
    expect(temporal).toContain('settle scope and feasibility blockers now');
    expect(temporal).toContain('leave other design choices pending unless expansion is approved');
    expect(template).toContain('each required diagram, map, and output describes the candidate boundaries');
    expect(template).toContain('Preserve non-blocking implementation choices as pending with an owner and required verification');
    expect(template).toContain('resolve or reopen any that change the scope decision or expose a material blocker');
    expect(template).toContain('distinguish a completed prioritization review from implementation readiness');
    expect(continuity).toContain('Continue the ledger from input reading and Step 0');
    expect(continuity).toContain('declared conventions and existing test coverage');
    for (const requirement of ['issue ID', 'owner section', 'evidence', 'exact accepted choice and scope',
      'decision reference', 'unresolved, approved, or reopened',
      'Selecting an approach is not blanket approval',
      'Approval settles the planning choice; it does not prove the mitigation is implemented',
      'declared unchanged contracts', 'concrete new evidence or a changed assumption',
      'Keep the risk and required verification visible']) expect(continuity).toContain(requirement);
  });

  test('ownership never defers a critical risk or merges distinct choices by topic', () => {
    for (const requirement of ['Do not defer a newly discovered critical risk',
      'Topic names alone never establish equivalence', 'materially different remedy, scope, or risk',
      'one complete choice in its natural owner section', 'Distinct choices remain separate',
      'email recovery does not settle request instrumentation',
      'correcting test wording does not choose test depth']) expect(continuity).toContain(requirement);
    expect(template).toContain('Outside-voice findings use the same working decision ledger');
    expect(template).toContain('New or reopened decisions still require explicit approval');
  });

  test('Design and DX retain the exact preceding anti-shortcut contract on every host', () => {
    // SHA-256 of the e801b515 resolver output; detects collateral prompt changes.
    const original = '82e55bcd35a16a20d243978707c786f25e24ac5d6a197d9fedb2cb0bb223abb7';
    for (const skillName of ['plan-devex-review', 'plan-design-review']) {
      for (const host of ALL_HOST_CONFIGS) {
        const clause = generateAntiShortcutClause({ skillName, host: host.name } as TemplateContext);
        expect(createHash('sha256').update(clause).digest('hex'), `${skillName}/${host.name}`).toBe(original);
      }
    }
  });
});

describe('plan-ceo-review carve — static ordering', () => {
  const skeleton = fs.readFileSync(SKELETON, 'utf-8');
  const section = fs.readFileSync(SECTION, 'utf-8');

  // Index into the skeleton, -1 if absent.
  const at = (needle: string): number => skeleton.indexOf(needle);

  const STEP0 = '## Step 0: Nuclear Scope Challenge + Mode Selection';
  const STOP = 'sections/review-sections.md'; // appears in the index row + STOP directive
  const GATE = 'GSTACK REVIEW REPORT';

  test('skeleton emits a STOP-Read directive pointing at the section', () => {
    expect(skeleton).toContain('> **STOP.**');
    expect(skeleton).toContain('plan-ceo-review/sections/review-sections.md');
    expect(skeleton).toContain('## Section index — Read each section when its situation applies');
  });

  test('Step 0 (scope + mode) stays in the skeleton, BEFORE the STOP', () => {
    const step0 = at(STEP0);
    const stop = skeleton.indexOf('> **STOP.**');
    expect(step0).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(step0); // STOP fires only after Step 0
  });

  test('mode selection precedes mode-specific analysis after approach approval', () => {
    const approach = at('### 0C-bis.');
    const mode = at('### 0F. Mode Selection');
    const analysis = at('### 0D. Mode-Specific Analysis');
    expect(approach).toBeGreaterThan(-1);
    expect(mode).toBeGreaterThan(approach);
    expect(analysis).toBeGreaterThan(mode);
  });

  test('the heavy review body (Sections 1-11) is NOT in the skeleton', () => {
    expect(skeleton).not.toContain('### Section 1: Architecture Review');
    expect(skeleton).not.toContain('### Section 11:');
    // ...it lives in the section instead.
    expect(section).toContain('### Section 1: Architecture Review');
    expect(section).toContain('### Section 11:');
  });

  test('nothing review-governing sits in the skeleton below the STOP (Codex P1)', () => {
    // Mode Quick Reference + Formatting Rules govern review-time behavior and must
    // travel with the section, not be stranded below the STOP in the skeleton.
    expect(skeleton).not.toContain('## Mode Quick Reference');
    expect(skeleton).not.toContain('## Formatting Rules');
    expect(section).toContain('## Mode Quick Reference');
  });

  test('review report writer lives in the section; the EXIT PLAN MODE GATE stays in the skeleton AFTER the STOP', () => {
    // The report itself is produced inside the section work...
    expect(section).toContain(GATE);
    // ...and the blocking gate that verifies it is the last thing the skeleton runs.
    const stop = skeleton.indexOf('> **STOP.**');
    const gate = skeleton.lastIndexOf(GATE);
    expect(gate).toBeGreaterThan(stop);
  });

  test('the section is generated, not hand-edited', () => {
    expect(section.slice(0, 120)).toContain('AUTO-GENERATED');
  });
});

describe('section capture completion signal', () => {
  // Isolate the runner mock in its own Bun process. Loading a mock in this free
  // shard would replace the real runner for unrelated tests in the same process.
  function captureFixture(exitReason: string, draft: boolean, options: { seed?: string; output?: string; directoryBefore?: boolean; directoryAfter?: boolean } = {}) {
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-capture-result-'));
    try {
      if (options.seed !== undefined) fs.writeFileSync(path.join(planDir, 'REPORT.md'), options.seed);
      if (options.directoryBefore) fs.mkdirSync(path.join(planDir, 'REPORT.md'));
      const script = `
        import { mock } from 'bun:test';
        import { writeFileSync, mkdirSync } from 'node:fs';
        let runnerCalls = 0;
        import { captureSectionReads } from ${JSON.stringify(path.join(ROOT, 'test/helpers/auq-sdk-capture.ts'))};
        mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
          runSkillTest: async () => {
            runnerCalls++;
            ${options.directoryAfter ? `mkdirSync(${JSON.stringify(path.join(planDir, 'REPORT.md'))});` : ''}
            ${draft ? `writeFileSync(${JSON.stringify(path.join(planDir, 'REPORT.md'))}, '# Review report\\nIN PROGRESS');` : ''}
            return { exitReason: ${JSON.stringify(exitReason)}, toolCalls: [], output: ${JSON.stringify(options.output ?? 'Final review report from stdout')} };
          },
        }));
        try {
        const capture = await captureSectionReads({
          planDir: ${JSON.stringify(planDir)}, skillName: 'plan-ceo-review',
          scenario: 'fixture', testName: 'capture-result-fixture', reportMarker: /review report/i,
        });
        process.stdout.write(JSON.stringify(capture));
        } catch (error) { process.stdout.write(JSON.stringify({ errorCode: error.code, runnerCalls })); }
      `;
      const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: ROOT, timeout: 10_000 });
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe('');
      return JSON.parse(child.stdout.toString());
    } finally {
      fs.rmSync(planDir, { recursive: true, force: true });
    }
  }

  test('an unchanged seeded report marker cannot supply attempt completion', () => {
    expect(captureFixture('success', false, { seed: '# Review report\nSeeded plan', output: 'Nothing completed' }))
      .toMatchObject({ exitReason: 'success', reportWritten: false, reportProduced: false, output: 'Nothing completed' });
  });
  test('unchanged seed preserves a valid successful terminal report fallback', () => {
    expect(captureFixture('success', false, { seed: '# Review report\nSeeded plan' }))
      .toMatchObject({ reportWritten: false, reportProduced: true, output: 'Final review report from stdout' });
  });
  test('changed seeded bytes are this attempt artifact, still gated by native success', () => {
    for (const exitReason of ['success', 'timeout']) {
      expect(captureFixture(exitReason, true, { seed: 'Original plan', output: '' }))
        .toMatchObject({ exitReason, reportWritten: true, reportProduced: exitReason === 'success', output: '# Review report\nIN PROGRESS' });
    }
  });
  test('same-byte rewrite is not new report evidence and empty terminal text stays incomplete', () => {
    expect(captureFixture('success', true, { seed: '# Review report\nIN PROGRESS', output: '' }))
      .toMatchObject({ reportWritten: false, reportProduced: false, output: '' });
  });
  test('a newly created report is retained on successful native completion', () => {
    expect(captureFixture('success', true, { output: '' }))
      .toMatchObject({ reportWritten: true, reportProduced: true, output: '# Review report\nIN PROGRESS' });
  });
  test('report snapshot errors retain their cause before the native attempt', () => {
    expect(captureFixture('success', false, { directoryBefore: true }))
      .toEqual({ errorCode: 'EISDIR', runnerCalls: 0 });
  });
  test('report read errors retain their cause after the native attempt', () => {
    expect(captureFixture('success', false, { directoryAfter: true }))
      .toEqual({ errorCode: 'EISDIR', runnerCalls: 1 });
  });

  test.each(['timeout', 'error_api'])('a draft from %s does not signal shared capture completion', exitReason => {
    const capture = captureFixture(exitReason, true);
    expect(capture).toMatchObject({
      exitReason, reportWritten: true, reportProduced: false, output: '# Review report\nIN PROGRESS',
    });
  });

  test('successful captures preserve the terminal-output fallback', () => {
    const capture = captureFixture('success', false);
    expect(capture).toMatchObject({
      exitReason: 'success', reportWritten: false, reportProduced: true, output: 'Final review report from stdout',
    });
  });
});

describe('CEO review completion evidence', () => {
  const completeReport = [
    '# CEO review — HOLD SCOPE',
    'Keep the cache process-local and invalidate only after a successful write.',
    '### Completion Summary',
    '| Review area | Outcome |',
    '| --- | --- |',
    '| Section 1 (Arch) | 1 issue: centralize the invalidation boundary |',
    '| Section 2 (Errors) | 3 error paths mapped, 1 fallback gap |',
    '| Section 3 (Security) | 1 issue: include tenant identity in keys |',
    '| Section 4 (Data/UX) | 2 edge cases mapped, 0 unhandled |',
    '| Section 5 (Quality) | No issues found |',
    '| Section 6 (Tests) | Diagram produced, 2 test gaps |',
    '| Section 7 (Perf) | 1 issue: cap cached value size |',
    '| Section 8 (Observ) | 1 gap: missing hit-rate metric |',
    '| Section 9 (Deploy) | 1 risk: warm-up load |',
    '| Section 10 (Future) | Reversibility: 5/5, 0 debt items |',
    '| Section 11 (Design) | SKIPPED (no UI scope) |',
    '## GSTACK REVIEW REPORT',
    '| Review | Runs | Status | Findings |',
    '| CEO | 1 | CLEAR | Cache boundaries reviewed |',
    '**VERDICT:** CEO CLEARED',
    'NO UNRESOLVED DECISIONS',
  ].join('\n');
  const completed = { exitReason: 'success', reportWritten: true, output: completeReport };

  test('accepts a complete compact report, including the documented no-UI skip', () => {
    expect(() => validateCeoReviewCompletion(completed)).not.toThrow();
  });

  test('accepts bold Markdown section labels', () => {
    const output = completeReport.replace(/\| (Section \d+ \([^|]+\)) \|/g, '| **$1** |');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('accepts a numbered Completion Summary heading', () => {
    const output = completeReport.replace('### Completion Summary', '### 12. Completion Summary');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('does not require the host plan-mode footer in a standalone report', () => {
    const output = completeReport.split('## GSTACK REVIEW REPORT')[0];
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('accepts completed reviews with unresolved findings and pending decisions', () => {
    const output = completeReport.replace('No issues found', '2 gaps; approval pending; TODO decisions recorded');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('accepts a concrete finding about skipped work', () => {
    const output = completeReport.replace('1 gap: missing hit-rate metric', '1 gap: audit logging is skipped on failures');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('rejects a timeout even when the report file exists', () => {
    expect(() => validateCeoReviewCompletion({ ...completed, exitReason: 'timeout' }))
      .toThrow('execution failed: timeout');
  });

  test('rejects report-like stdout when the requested report file is absent', () => {
    expect(() => validateCeoReviewCompletion({ ...completed, reportWritten: false }))
      .toThrow('did not write REPORT.md');
  });

  test('rejects generic prose mentioning a review and completion summary', () => {
    expect(() => validateCeoReviewCompletion({
      ...completed,
      output: 'I reviewed all eleven sections and will produce the Completion Summary and GSTACK REVIEW REPORT. '.repeat(3),
    })).toThrow('missing its Completion Summary');
  });

  test('requires an actual Completion Summary', () => {
    expect(() => validateCeoReviewCompletion({
      ...completed,
      output: completeReport.replace('### Completion Summary', 'The Completion Summary will follow.'),
    })).toThrow('missing its Completion Summary');
  });

  test.each(Array.from({ length: 11 }, (_, index) => index + 1))('requires the Section %i outcome', section => {
    const output = completeReport.split('\n')
      .filter(line => !line.startsWith(`| Section ${section} (`)).join('\n');
    expect(() => validateCeoReviewCompletion({ ...completed, output }))
      .toThrow(`Section ${section} outcome`);
  });

  test.each(['___ issues found', 'TBD', 'reviewed', 'SKIPPED'])('rejects unfinished or skipped non-UI outcomes: %s', outcome => {
    const output = completeReport.replace('No issues found', outcome);
    expect(() => validateCeoReviewCompletion({ ...completed, output }))
      .toThrow('Section 5 outcome');
  });

  test('rejects the original template placeholders as completed outcomes', () => {
    const output = completeReport.replace('SKIPPED (no UI scope)', '___ issues / SKIPPED (no UI scope)');
    expect(() => validateCeoReviewCompletion({ ...completed, output }))
      .toThrow('Section 11 outcome');
  });
});
