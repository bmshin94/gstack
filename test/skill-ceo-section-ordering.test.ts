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
import { generateAntiShortcutClause, generateSpecReviewLoop, generatePlanFileReviewReport, generateExitPlanModeGate, generateCodexPlanReview } from '../scripts/resolvers/review';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateTasksSectionEmit } from '../scripts/resolvers/tasks-section';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const SKELETON = path.join(ROOT, 'plan-ceo-review', 'SKILL.md');
const SECTION = path.join(ROOT, 'plan-ceo-review', 'sections', 'review-sections.md');

// These three source scenarios guard instruction branches, not native execution.
test('CEO handoff allows no pending choice without inventing an approval', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const approach = source.split('### 0D.')[1]!.split('### 0E.')[0]!;
  const handoff = source.split('**Mode handoff:**')[1]!.split('### 0F.')[0]!;
  const noChoice = approach.indexOf('If no pending approach remains');
  expect(noChoice).toBeGreaterThan(0);
  expect(noChoice).toBeLessThan(approach.indexOf('**2. Record the pending choice.**'));
  expect(approach).toContain('continue to 0E');
  expect(approach).toContain('Do not invent alternatives or approval to fill the handoff');
  expect(handoff).toContain('No new approach decision was needed');
  expect(handoff).toContain('carry prior approvals forward');
  expect(handoff).toContain('<rows or none>');
});

test('CEO handoff carries all answered rows instead of one synthetic approach', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const handoff = source.split('**Mode handoff:**')[1]!.split('### 0F.')[0]!;
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  expect(handoff).toContain('every governing approved row\'s ID, answer reference and accepted scope');
  expect(handoff).toContain('Do not collapse several choices into one approach');
  expect(handoff).toContain('Auto-decided review mode → <selected mode> (your preference)');
  expect(handoff).toContain('Mode: <selected mode>; approved decisions: <rows or none>');
  expect(handoff).not.toContain('<approved 0D approach>');
  expect(section).toContain('Step 0E mode-handoff format and the current ledger dispositions');
  expect(section).toContain('including actual later scope-answer references');
  expect(section).toContain('Keep the original handoff as history; do not reannounce superseded scope as current');
});

test('SELECTIVE baseline cuts preserve prior answers until their own scope decision', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const modeWork = source.split('### 0G.')[1]!.split('### 0H.')[0]!;
  expect(modeWork).toContain('Run both HOLD SCOPE checks below, including their defer/keep decisions');
  const cuts = modeWork.split('**Deferring current scope:**')[1]!;
  expect(cuts).toContain('In REDUCTION, HOLD, and the HOLD checks performed by SELECTIVE');
  expect(cuts).toContain('**A)** Defer this item to TODOS.md **B)** Keep it in scope');
  expect(cuts).toContain("use 0D's prior-approval/reopening checks");
  expect(source).toContain('Selecting a mode never approves a scope change');
  const answer = cuts.indexOf("Wait for its actual answer");
  const apply = cuts.indexOf('An approved cut changes only its delivery scope');
  expect(answer).toBeGreaterThan(0);
  expect(apply).toBeGreaterThan(answer);
  expect(cuts).toContain('record the new answer and reason beside the earlier answer');
  expect(cuts).toContain('Leave other approvals and limits unchanged');
});

// These check the storage branches and their order, not model compliance.
test('CEO defines pending choices and storage before its first decision procedure', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const step0 = source.split('## Step 0:')[1]!;
  const policy = step0.indexOf('**Storage policy: choose before writing.**');
  const choice = step0.indexOf('A pending choice is');
  const firstDecision = step0.indexOf('### 0D.');
  expect(policy).toBeGreaterThan(0);
  expect(choice).toBeGreaterThan(0);
  expect(policy).toBeLessThan(firstDecision);
  expect(choice).toBeLessThan(firstDecision);
  const compare = step0.split('**3. Compare and save')[1]!.split('**4. Ask, record')[0]!;
  expect(compare).toContain('Save or present the complete updated plan again before asking');
  const persistence = step0.split('### 0H.')[1]!.split('### 0I.')[0]!;
  expect(persistence.indexOf('**Save each input under the storage policy.**')).toBeLessThan(persistence.indexOf('mkdir -p'));
  expect(persistence).toContain('**Otherwise:**');
  expect(persistence.indexOf('**Otherwise:**')).toBeLessThan(persistence.indexOf('{{SPEC_REVIEW_LOOP}}'));
  expect(persistence).not.toContain('Save a chat-only plan');
});

test('CEO chat storage still supplies both spec inputs and the full report without claiming file completion', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const spec = generateSpecReviewLoop(ctx);
    const report = generatePlanFileReviewReport(ctx);
    const gate = generateExitPlanModeGate(ctx);
    expect(spec).toContain('both complete labeled texts');
    expect(spec).toContain('all five dimensions');
    expect(spec).toContain('Make at most three reviewer launches');
    expect(spec).toContain('If launch or review fails, times out, or cannot review both complete inputs');
    expect(report.indexOf('### Generate the report')).toBeLessThan(report.indexOf('### Write to the plan file'));
    expect(report).not.toContain('If no file is in scope, skip this section');
    expect(report).toContain('not persisted');
    expect(report).toContain('**Read-back gate:**');
    expect(report).not.toContain('retry once');
    const tasks = generateTasksSectionEmit(ctx, ['ceo-review']);
    expect(tasks).toContain('write when permitted, including zero tasks');
    expect(tasks).not.toContain('always write');
    const outside = generateCodexPlanReview(ctx);
    if (outside) expect(outside).toContain('Include the CEO scope summary when available for this mode');
    expect(gate).toContain('do not call ExitPlanMode');
    expect(gate.indexOf('not persisted')).toBeLessThan(gate.indexOf('1. Read the plan file'));
  }
});

test('CEO saves compared proposals before recording an actual answer in its separate field', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = source.split('### 0D.')[1]!.split('### 0E. Mode Selection')[0]!;
  const compare = procedure.indexOf('**3. Compare and save');
  const save = procedure.indexOf("In Proposed, record each commitment");
  const ask = procedure.indexOf('**4. Ask, record');
  const actualAnswer = procedure.indexOf('Record its reference and scope in Exact approval and scope');
  const amend = procedure.indexOf('update Status, and apply only the authorized amendments');
  expect(0 <= compare && compare < save && save < ask && ask < actualAnswer && actualAnswer < amend).toBe(true);
  expect(procedure.slice(compare, ask)).toContain("Save or present the complete updated plan again before asking");
  expect(procedure.slice(compare, ask)).toContain('include unchanged, pending and shared values');
  expect(source).toContain('If an attempted save fails, report it and stop');
  expect(procedure.slice(0, compare)).toContain('present the complete updated chat plan before comparing options');
  expect(procedure.slice(ask)).toContain('before the next row');
});

// A topic row alone did not expose the independently selectable test additions.
// This guards the executable representation/order, not the model's compliance.
test('CEO value comparisons and decline-all outcomes stay explicit before approval', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = source.split('### 0D.')[1]!.split('### 0E.')[0]!;
  const pendingSave = procedure.indexOf('save this pending row or present the complete updated chat plan');
  const values = procedure.indexOf('commitment [source/approval or pending]: current=value; A=value; B=value; C=value');
  expect(values).toBeGreaterThan(-1);
  const comparedSave = procedure.indexOf('Save or present the complete updated plan again before asking');
  const ask = procedure.indexOf('**4. Ask, record');
  expect(pendingSave >= 0 && pendingSave < values && values < comparedSave && comparedSave < ask).toBe(true);
  const comparison = procedure.slice(values, ask);
  expect(comparison).toContain('include unchanged, pending and shared values');
  expect(comparison).toContain('test additions that can be accepted separately');
  expect(comparison).toContain('Each option may resolve only one pending choice');
  expect(comparison).toContain('Preserve accepted requirements and their required tests and fixes in every option');
  expect(procedure).toContain('If all alternatives are declined, continue only when the actual answer keeps a viable current approach');
  expect(procedure).toContain('Otherwise leave the row unresolved and stop for new direction');
});

// The paid paired-control skipped its provisional ledger and treated two
// contracts as one test strategy. Guard recording before menu synthesis on each
// host; this is an instruction-order check, not proof of native compliance.
test('CEO Step 0 records provisional contracts before drafting any menu on every host', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-pending-rows-'));
  try {
    const generated = await runGeneration({ host: 'all', outputRoot, contentLinkRoot: null, log: () => {} });
    expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
    const carriers = generated.artifacts.filter(artifact => artifact.kind === 'skill'
      && (artifact.relativePath === 'plan-ceo-review/SKILL.md'
        || artifact.relativePath.endsWith('/gstack-plan-ceo-review/SKILL.md')));
    expect(carriers).toHaveLength(ALL_HOST_CONFIGS.length);
    for (const file of [`${SKELETON}.tmpl`, ...carriers.map(carrier => path.join(outputRoot, carrier.relativePath))]) {
      const source = fs.readFileSync(file, 'utf8');
      const approach = source.split('### 0D.')[1]?.split('### 0E. Mode Selection')[0] ?? '';
      const positions = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
        'Fill Current and Proposed with behavior', 'save this pending row or present the complete updated chat plan',
        "**3. Compare and save that row's options.**", '**4. Ask, record the answer, and amend.**',
        'Ask one row per call and cite its ID'].map(stage => approach.indexOf(stage));
      expect(positions.every(position => position >= 0), file).toBe(true);
      expect(positions, file).toEqual([...positions].sort((a, b) => a - b));
      expect(source).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
      expect(source.indexOf('| ID and owner |')).toBeLessThan(source.indexOf('**2. Record the pending choice.**'));
      expect(approach).toContain('behavior, limits, test method and coverage');
      expect(approach).toContain('other commitments fixed or pending');
      expect(approach).toContain('one can be selected while another stays unchanged');
      expect(approach.indexOf('Fill Current and Proposed with behavior')).toBeLessThan(approach.indexOf('Compare 2–3 approaches'));
      expect(approach).toContain('Split independently varying commitments into separate rows');
      expect(source).toContain('If an attempted save fails, report it and stop');
      expect(approach).toContain('present the complete updated chat plan before comparing options');
      expect(approach).toContain('Do not prewrite approval or implementation tasks');
      expect(approach).toContain('Record its reference and scope in Exact approval and scope');
      expect(source.indexOf('### 0D.')).toBeLessThan(source.indexOf('### 0E. Mode Selection'));
    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }); }
}, 30_000);

// A saved topic row did not prevent the captured paired menu from combining
// separately proposed coverage. Main review also asked about a draft-created
// recovery promise before reconciling it with the original contract.
// These guards enforce instruction order, not model compliance or judge results.
test('CEO decision units and factual reconciliation precede menu synthesis', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const alternatives = skeleton.split('### 0D.')[1]?.split('### 0E.')[0] ?? '';
  const stages = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    'save this pending row or present the complete updated chat plan',
    "**3. Compare and save that row's options.**", '**4. Ask, record the answer, and amend.**'];
  const positions = stages.map(stage => alternatives.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const analyze = section.split('**Analyze.**')[1]?.split('**Resolve.**')[0] ?? '';
  expect(analyze).toContain('Correct source-disproven draft claims');
  expect(section.indexOf('### Outside Voice Integration Rule')).toBeLessThan(section.indexOf('{{CODEX_PLAN_REVIEW}}'));
});

test('CEO outside findings reuse authority-first decisions without turning unknown facts into policies', () => {
  const section = fs.readFileSync(SECTION, 'utf8');
  const tension = section.split('**Cross-model tension:**')[1]?.split('**Persist the result:**')[0] ?? '';
  const positions = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    "**3. Compare and save that row's options.**", '**4. Ask, record the answer, and amend.**'].map(step => tension.indexOf(step));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(tension).toContain('same six-column decision ledger and the four steps of 0D');
  expect(tension).not.toContain('reference | commitment | current value');
  expect(tension).toContain('Correct false premises in the draft and its evidence without changing accepted behavior');
  expect(tension).toContain('Keep factual uncertainty explicit, with its owner and required verification');
  expect(tension).toContain('A credible material risk can require action before its occurrence is confirmed');
  expect(tension).toContain('they need no behavior-change menu');
  expect(tension).toContain('A) Apply this change; B) Keep');
  expect(tension).toContain('A) Include; B) Defer; C) Cut; D) Hold');
  expect(tension).toContain("Save or present pending rows under 0D Step 2");
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  expect(skeleton).toContain('A failed save stops before the question');
  expect(skeleton).toContain('User/host edit restrictions govern artifacts, metadata and cleanup');
  expect(tension).toContain('Update the working rows and comparisons under 0D Step 3 before asking');
  expect(skeleton).toContain('apply only approved amendments before the next row');
  expect(tension).toContain('one row per call, record its actual answer and scope');
  expect(tension).toContain('challenges wait for the final gate');
  expect(tension).toContain('including findings that needed only factual correction');
});

// Repeated public quality feedback identified these missing execution instructions.
// This guard checks the source contract; native clarity still requires paid evidence.
test('CEO Step 0 defines the decision record, execution order, and mode approval precedence', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const step0 = source.split('## Step 0:')[1]?.split('### 0F.')[0] ?? '';
  expect(step0).toContain('Complete 0A–0E in order');
  expect(step0).toContain('Put the 0A–0C observations and evidence in the working plan; observations do not approve changes');
  expect(step0).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
  expect(step0).toContain('Keep one decision ledger through Step 0, Spec Review Loop and Outside Voice');
  expect(step0).toContain('Cite evidence, conventions and test coverage; mark unknowns');
  expect(step0).toContain('Reuse may lower effort; two allowed deliverables still means two');
  expect(step0).toContain('reuse and verification coverage');
  expect(step0).toContain('Give changes separate rows if one can be selected while another stays unchanged');
  expect(step0).toContain('observations do not approve changes');
  expect(step0).toContain('The preamble\'s session rules govern whether and how to ask');
  expect(step0).toContain('Use an explicit user mode choice and skip steps 2–3');
  expect(step0).toContain('SCOPE REDUCTION for >15 planned changed files; else SCOPE EXPANSION for greenfield work');
  expect(step0).toContain('When `QUESTION_TUNING: false`, skip the lookup and ask normally');
  expect(step0).toContain('`ASK_NORMALLY` asks the user to choose');
  expect(step0).toContain('Selecting a mode never approves a scope change');
  expect(step0).toContain('unresolved, approved, reopened, deferred or declined');
  expect(step0).toContain('This step recommends a mode; it does not select one');
  expect(step0).toContain("The user's answer selects the mode, even if it differs from the recommendation");
  expect(step0.indexOf("The preamble's session rules govern whether and how to ask")).toBeLessThan(step0.indexOf('Use an explicit user mode choice'));
  const reduction = source.split('**For SCOPE REDUCTION**')[1]?.split('### 0H.')[0] ?? '';
  expect(reduction).toContain('ask separately for each proposed cut');
  expect(reduction).toContain('**A)** Defer this item to TODOS.md **B)** Keep it in scope');
  expect(reduction).not.toContain('Remove it without a follow-up');
  expect(reduction).not.toContain('Accepted items govern');
  expect(source).toContain('For both expansion modes, ask separately for each proposed addition');
  expect(source).toContain('Accepted items govern the remaining sections');
  expect(source).toContain('put rejected items in "NOT in scope."');
  expect(source).toContain('Record approved deferrals and context in TODOS.md');
  expect(source).toContain('Reuse answered scope decisions without another question or alternatives comparison');
  expect(source).toContain("In REDUCTION, HOLD, and the HOLD checks performed by SELECTIVE");
  expect(source).toContain('present both inputs for approval: link saved files and show unsaved text');
});

// Boundary checks stay on source templates: generated carriers remain the
// integration owner's responsibility, and these do not prove model behavior.
describe('CEO review decision boundaries contract', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const alternatives = skeleton.split('### 0D.')[1]?.split('### 0F.')[0] ?? '';
  const temporal = skeleton.split('### 0I.')[1]?.split('### 0E.')[0] ?? '';
  const apply = section.split('**Apply.**')[1]?.split('### Section 1:')[0] ?? '';

  test('every approach comparison preserves approvals and separates independent changes', () => {
    expect(alternatives).toContain('Preserve accepted requirements and their required tests and fixes in every option');
    expect(alternatives).toContain('behavior, limits, test method and coverage');
    expect(skeleton).toContain('Review depth');
    expect(skeleton).toContain('Ask before expanding that depth');
    expect(alternatives).toContain('preserve unknowns');
    expect(alternatives).toContain('Give changes separate rows if one can be selected while another stays unchanged');
    expect(alternatives).toContain("If an approved change's test method or coverage remains open, decide that once");
    expect(alternatives).toContain('Every option preserves required behavior and approved test requirements');
    expect(section).toContain('Apply the three test rules in Step 0D');
    expect(section).toContain('carry approved regression tests forward, separate independently selectable new test additions, and keep tests for undecided behavior pending');
    expect(alternatives).toContain('For existing behavior, separate proposed tests if either can be selected alone');
    expect(alternatives).toContain('Keep tests for undecided behavior pending');
    expect(alternatives).toContain('other commitments fixed or pending');
    expect(alternatives).toContain('reuse and verification coverage');
    expect(alternatives).not.toContain('for architecture choices');
    expect(alternatives.indexOf('Fill Current and Proposed with behavior')).toBeLessThan(alternatives.indexOf('Compare 2–3 approaches'));
    expect(alternatives).toContain('If they must stay together, explain why');
    expect(alternatives).toContain('Carry exact approvals forward');
    expect(alternatives).toContain("Keep a code change with its required regression tests. Carry that pair forward once approved");
    expect(alternatives).toContain('For existing behavior, separate proposed tests if either can be selected alone');
    expect(skeleton).toContain("the actual instruction or answer reference and its exact scope");
    expect(alternatives).toContain('Weigh diff size and long-term architecture equally');
    expect(alternatives).toContain('a rewrite may be better');
    expect(alternatives).toContain('Resolve required approaches before 0E');
  });

  test('settled approach authority resolves the gate while new choices still require approval', () => {
    const approach = alternatives.split('### 0E. Mode Selection')[0]!;
    const reuse = approach.split('**2. Record the pending choice.**')[0]!;
    const gate = approach.split('**STOP for the actual answer, even for a lone option.**')[1] ?? '';
    expect(reuse).toContain('Read the original input, inspected source and actual answers');
    expect(reuse).toContain('Carry exact approvals forward');
    const reopenRule = 'Reopen only for a concrete contradiction, changed assumption or explicit new user instruction';
    expect(skeleton).toContain(reopenRule);
    expect(skeleton.indexOf(reopenRule)).toBeLessThan(skeleton.indexOf('**2. Record the pending choice.**'));
    expect(approach).toContain('STOP for the actual answer, even for a lone option');
    expect(gate).toContain('Resolve required approaches before 0E');
    expect(approach).toContain('Recommendations are not approval');
    expect(approach).not.toContain('Do NOT proceed to Step 0D or 0F until the user responds to 0C-bis');
    expect(approach).toContain('Ask one row per call and cite its ID');
    expect(gate).toContain('Use this procedure for later new or reopened choices, including Outside Voice');
    expect(section).toContain('An obvious recommendation still needs approval if not already accepted');
    expect(approach).toContain("Use the preamble's question format, recommendation and preference/session rules");
    expect(gate).toContain('Report settled findings');
    expect(gate).toContain('say "No issues, moving on." only when none remain');
  });

  test('coverage scoring is conditional and legitimate early decisions retain their exact approval', () => {
    expect(alternatives).toContain('If options differ in coverage, score this row only');
    const currentAndProposed = alternatives.indexOf('Fill Current and Proposed with behavior');
    expect(currentAndProposed).toBeGreaterThan(0);
    expect(currentAndProposed).toBeLessThan(alternatives.indexOf('If options differ in coverage'));
    expect(alternatives).toContain("Use the preamble's question format");
    expect(alternatives).toContain('10 covers all its edge cases');
    expect(alternatives).toContain('Note: options differ in kind, not coverage — no completeness score.');
    // Scoring and recommendation details are reused from the existing preamble.
    const generated = fs.readFileSync(SKELETON, 'utf8');
    expect(generated).toContain('10 = complete, 7 = happy path, 3 = shortcut');
    expect(generated).toContain('Recommendation is ALWAYS present');
    expect(generated).toContain('Note: options differ in kind, not coverage — no completeness score.');
    expect(alternatives).not.toContain('These approaches differ in coverage (minimal viable vs ideal architecture)');
    expect(temporal).toContain('Use 0D for urgent decisions');
    expect(temporal).toContain('never defer critical risks');
    expect(temporal).toContain('Carry the ledger and each answer\'s exact scope into the review sections');
    expect(alternatives).toContain('Reopen only for a concrete contradiction, changed assumption or explicit new user instruction');
  });

  test('an unresolved section decision is answered before its scoped plan amendment', () => {
    const steps = [
      'If the current section has an unresolved or reopened decision, call AskUserQuestion',
      'After the actual answer, check each new or changed commitment',
      'Record the choice and only its authorized amendments',
      'Once the current section\'s decisions have answers, record its review conclusions',
    ].map(step => apply.indexOf(step));
    expect(steps.every(position => position >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(apply).toContain('STOP until the user responds');
    expect(apply).toContain('Begin with the supplied input and explicitly accepted decisions');
    expect(apply).toContain('against the selected option or an explicit earlier approval');
    expect(apply).toContain('Preserve existing content and approvals, including direct implementation and verification of the accepted behavior');
    expect(apply).toContain("before advancing, using Step 0's storage policy");
  });

  test('pending labels authorize only unresolved notes, not an outcome or future review conclusions', () => {
    expect(apply).toContain('only the pending issue, evidence, and alternatives in the ledger');
    expect(apply).toContain('A pending label does not authorize a task, verification step, or diagram to prescribe an unapproved outcome');
    expect(apply).toContain('Record the choice and only its authorized amendments, including explicit deferrals');
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
    expect(continuity).toContain("before advancing, using Step 0's storage policy");
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
      expect(body, `Section ${number}`).toContain('one decision unit = one AskUserQuestion call');
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
    const start = skeleton.indexOf('Keep one decision ledger');
    expect(start).toBeGreaterThan(skeleton.indexOf('## Step 0:'));
    expect(start).toBeLessThan(skeleton.indexOf('### 0D.'));
    const earlyLedger = skeleton.slice(start, skeleton.indexOf('### 0A.'));
    expect(earlyLedger).toContain('Cite evidence, conventions and test coverage; mark unknowns');
    const sources = skeleton.split('**1. Check sources and prior answers.**')[1]!.split('**2. Record the pending choice.**')[0]!;
    expect(sources).toContain('Reopen only for a concrete contradiction, changed assumption or explicit new user instruction');
    expect(sources).toContain('speculation or reviewer agreement is not enough');
    const limits = skeleton.split('**Keep the stated limits.**')[1]!.split('**Storage policy:')[0]!;
    expect(limits).toContain('Record what each limit measures, its value, unit and prerequisites');
    expect(limits).toContain('Changing a limit needs evidence and user approval');
    expect(limits).toContain('Reuse may lower effort; two allowed deliverables still means two');
    expect(skeleton.indexOf('Record what each limit measures')).toBeLessThan(skeleton.indexOf('### 0D.'));
    const temporal = skeleton.split('### 0I.')[1]?.split('{{SECTION:review-sections}}')[0] ?? '';
    expect(temporal).toContain('Resolve scope and feasibility blockers now');
    expect(temporal).toContain('Keep other design choices pending unless the user requested implementation planning');
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
      'Keep unknown risks, their owners and required verification visible']) expect(continuity).toContain(requirement);
  });

  test('ownership never defers a critical risk or merges distinct choices by topic', () => {
    for (const requirement of ['Do not defer a newly discovered critical risk',
      'Topic names alone never establish equivalence', 'materially different remedy, scope, or risk',
      'Resolve each decision unit in its natural owner section', 'Independently proposed commitments require separate rows',
      'email recovery does not settle request instrumentation',
      'Correcting test wording does not choose test depth']) expect(continuity).toContain(requirement);
    expect(template).toContain('Outside-voice findings use the same working decision ledger');
    expect(template).toContain('New or reopened decisions still require explicit approval');
  });

  test('Design preserves decision gating while DX and fallback retain their existing output on every host', () => {
    // SHA-256 of the e801b515 default resolver output; detects collateral changes.
    const original = '82e55bcd35a16a20d243978707c786f25e24ac5d6a197d9fedb2cb0bb223abb7';
    // Pin DX's e15ba218 output independently: Eng now has its own wording.
    const originalDevex = '29fe85565c2ea16c0d205a06a2515e30228342078a44bb688489274c157ddba2';
    for (const host of ALL_HOST_CONFIGS) {
      const fallback = generateAntiShortcutClause({ skillName: 'review', host: host.name } as TemplateContext);
      expect(createHash('sha256').update(fallback).digest('hex'), `review/${host.name}`).toBe(original);
      const devex = generateAntiShortcutClause({ skillName: 'plan-devex-review', host: host.name } as TemplateContext);
      expect(createHash('sha256').update(devex).digest('hex'), `plan-devex-review/${host.name}`).toBe(originalDevex);
      const design = generateAntiShortcutClause({ skillName: 'plan-design-review', host: host.name } as TemplateContext);
      expect(design).toMatch(/Ask once per independent decision, wait for the actual answer, then apply only its accepted scope/);
      expect(design).toContain('Necessary code, tests and docs for an exact previously selected contract do not reopen it');
      expect(design).toContain('does not approve independent remedies or optional verification depth');
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
    const approach = at('### 0D.');
    const mode = at('### 0E. Mode Selection');
    const analysis = at('### 0G. Mode-Specific Analysis');
    expect(approach).toBeGreaterThan(-1);
    expect(mode).toBeGreaterThan(approach);
    expect(analysis).toBeGreaterThan(mode);
    expect(skeleton).toContain('Complete 0A–0E in order');
    expect(skeleton).toContain('| SCOPE EXPANSION / SELECTIVE EXPANSION | 0F → 0G → 0H (including its spec review loop) → 0I |');
    expect(skeleton).toContain('| HOLD SCOPE | 0G → 0I |');
    expect(skeleton).toContain('| SCOPE REDUCTION | 0G |');
    expect(skeleton).toContain('ask separately for each proposed cut');
    expect(skeleton).toContain('complete all 11 sections, required outputs and terminal review report');
    expect(skeleton).toContain('SCOPE REDUCTION for >15 planned changed files; else SCOPE EXPANSION for greenfield work');
    expect(skeleton).toContain('The >8-file check applies to HOLD SCOPE and SELECTIVE EXPANSION');
    const persist = skeleton.split('### 0H. Persist CEO Plan (EXPANSION and SELECTIVE EXPANSION only)')[1]?.split('### 0I.')[0] ?? '';
    expect(persist).toMatch(/^#### Spec Review Loop$/m);
    expect(persist).toContain('After the loop completes or reports unavailable');
    const handoff = persist.slice(persist.indexOf('After the loop completes or reports unavailable'));
    const wait = handoff.indexOf("Follow the preamble's session rules");
    expect(wait).toBeGreaterThan(handoff.indexOf('for approval'));
    expect(handoff.indexOf('Then continue to 0I')).toBeGreaterThan(wait);
  });

  test('the heavy review body (Sections 1-11) is NOT in the skeleton', () => {
    expect(skeleton).not.toContain('### Section 1: Architecture Review');
    expect(skeleton).not.toContain('### Section 11:');
    // ...it lives in the section instead.
    expect(section).toContain('### Section 1: Architecture Review');
    expect(section).toContain('### Section 11:');
  });

  test('Autoplan CEO uses the loaded Step 0 route before its dual voices and review sections', () => {
    for (const suffix of ['.md.tmpl', '.md']) {
      const phase = fs.readFileSync(path.join(ROOT, 'autoplan/sections/ceo-phase' + suffix), 'utf8');
      const step0 = phase.split('**Required execution checklist (CEO):**')[1]?.split('Step 0.5 (Dual Voices):')[0] ?? '';
      expect(step0).toContain('order required by the loaded CEO skill');
      expect(step0).toContain('Spec Review Loop in 0H before 0I and Review Sections');
      expect(step0).not.toMatch(/^- 0[A-I](?:-bis)?:/m);
      // The headings alone can be ordered while executable reviewer payloads
      // still run ahead of Step 0, or Codex is presented ahead of Claude.
      const positions = ['**Required execution checklist (CEO):**', 'Step 0.5 (Dual Voices):',
        '"Read the plan file at <plan_path>. You are an independent CEO/strategist',
        '_gstack_codex_timeout_wrapper 600 codex exec', 'CEO DUAL VOICES — CONSENSUS TABLE:',
        'Sections 1-10 —', '**Mandatory outputs from Phase 1:**', '**PHASE 1 COMPLETE.**']
        .map(stage => phase.indexOf(stage));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
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
