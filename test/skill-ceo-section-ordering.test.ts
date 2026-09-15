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

// Prose wrapping is not the contract; keep raw documents for line/heading guards.
const compactProse = (value: string) => value.replace(/\s+/g, ' ').trim();

// These three source scenarios guard instruction branches, not native execution.
test('CEO handoff allows no pending choice without inventing an approval', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const approach = compactProse(source.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const handoff = source.split('**Mode handoff:**')[1]!.split('### 0F.')[0]!;
  const noChoice = approach.indexOf('If no pending approach remains');
  expect(noChoice).toBeGreaterThan(0);
  expect(noChoice).toBeLessThan(approach.indexOf('**2. Record the pending choice.**'));
  expect(approach).toContain('continue to 0E');
  expect(approach).toContain('invent neither alternatives nor approval');
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

// Guards the missing public handoff instruction, not model compliance or posture detection.
test('CEO mode handoff applies the selected mode before the next question', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const selection = source.split('### 0E. Mode Selection')[1]!.split('### 0F.')[0]!;
  const handoffStart = selection.indexOf('**Mode handoff:**');
  const routeStart = selection.indexOf("Follow the selected mode's route:");
  expect(handoffStart).toBeGreaterThan(0);
  expect(routeStart).toBeGreaterThan(handoffStart);
  const handoff = selection.slice(handoffStart, routeStart);
  const instruction = handoff.split('\n')[0]!;
  expect(instruction).toMatch(/before the next scope or review question/i);
  expect(instruction).toMatch(/chat message.*how.*mode applies to this plan.*why/i);
  expect(selection).toContain('4. **Mode handoff:**');
  expect(selection).toContain('Use an explicit user mode choice and skip steps 2–3');
  expect(instruction).toContain('After either an explicit choice or step 3');
  expect(instruction).toContain('your next response is a brief chat message before tools');
  const selectionSteps = selection.slice(0, handoffStart);
  expect(selectionSteps).toContain('only if that check exits 0 with `AUTO_DECIDE`');
  expect(selectionSteps).toContain('**STOP for the answer**');
  expect(selectionSteps).not.toMatch(/\blog (?:with|that ID)\b/);
  const loggingStart = handoff.indexOf('After the handoff, use the preamble to log');
  expect(loggingStart).toBeGreaterThan(handoff.indexOf('- Other selections:'));
  expect(loggingStart).toBeLessThan(handoff.indexOf('Mode selection grants no approach or scope approval'));
  const logging = compactProse(handoff.slice(loggingStart));
  expect(logging).toContain('`auto_decided: true` for automatic selection');
  expect(logging).toContain('for an asked question, log its ID only when `QUESTION_TUNING: true`');
  const formats = handoff.split('\n').filter(line => line.startsWith('- '));
  expect(formats).toHaveLength(2);
  for (const format of formats) {
    expect(format).toContain('<Application and rationale>');
    expect(format).toContain('<rows or none>');
  }
});

test('SELECTIVE baseline cuts preserve prior answers until their own scope decision', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const modeWork = source.split('### 0G.')[1]!.split('### 0H.')[0]!;
  expect(modeWork).toContain('Run all three HOLD SCOPE checks below, including their defer/keep decisions');
  const holdChecks = modeWork.split('**For HOLD SCOPE**')[1]!.split('**For SCOPE REDUCTION**')[0]!;
  expect([...holdChecks.matchAll(/^\d+\. /gm)]).toHaveLength(3);
  const cuts = modeWork.split('**Deferring current scope:**')[1]!;
  expect(cuts).toContain('In REDUCTION, HOLD, and the HOLD checks performed by SELECTIVE');
  expect(cuts).toContain('**A)** Defer this item to TODOS.md **B)** Keep it in scope');
  expect(cuts).toContain("use 0D's prior-approval/reopening checks");
  expect(source).toContain('Mode selection grants no approach or scope approval');
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
  const step0 = compactProse(source.split('## Step 0:')[1]!);
  const policy = step0.indexOf('**Storage policy: choose before writing.**');
  const choice = step0.indexOf('A pending choice is');
  const firstDecision = step0.indexOf('### 0D.');
  expect(policy).toBeGreaterThan(0);
  expect(choice).toBeGreaterThan(0);
  expect(policy).toBeLessThan(firstDecision);
  expect(choice).toBeLessThan(firstDecision);
  const compare = compactProse(step0.split('**3. Compare and save')[1]!.split('**4. Ask, record')[0]!);
  expect(compare).toContain('**Save the completed comparison before asking.** Save or present the complete updated plan under the storage policy');
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
  const procedure = compactProse(source.split('### 0D.')[1]!.split('### 0E. Mode Selection')[0]!);
  const compare = procedure.indexOf('**3. Compare and save');
  const save = procedure.indexOf("In Proposed, compare every commitment");
  const ask = procedure.indexOf('**4. Ask, record');
  const actualAnswer = procedure.indexOf('Record its reference and scope in Exact approval and scope');
  const amend = procedure.indexOf('update Status, and apply only the authorized amendments');
  expect(0 <= compare && compare < save && save < ask && ask < actualAnswer && actualAnswer < amend).toBe(true);
  expect(procedure.slice(compare, ask)).toContain("**Save the completed comparison before asking.** Save or present the complete updated plan under the storage policy");
  expect(procedure.slice(compare, ask)).toContain('include unchanged, pending and shared values');
  expect(source).toContain('If an attempted save fails, report it and stop');
  expect(procedure.slice(0, compare)).toContain('**Save pending rows before comparing options.** Save or present the complete updated plan under the storage policy');
  expect(procedure.slice(ask)).toContain('before the next row');
});

// A topic row alone did not expose the independently selectable test additions.
// This guards the executable representation/order, not the model's compliance.
test('CEO value comparisons and decline-all outcomes stay explicit before approval', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = compactProse(source.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const pendingSave = procedure.indexOf('**Save pending rows before comparing options.**');
  const values = procedure.indexOf('Commitment | Source/approval or pending | Current | A | B | C');
  expect(values).toBeGreaterThan(-1);
  const comparedSave = procedure.indexOf('**Save the completed comparison before asking.** Save or present the complete updated plan under the storage policy');
  const ask = procedure.indexOf('**4. Ask, record');
  expect(pendingSave >= 0 && pendingSave < values && values < comparedSave && comparedSave < ask).toBe(true);
  const comparison = procedure.slice(values, ask);
  expect(comparison).toContain('include unchanged, pending and shared values');
  expect(comparison).toContain('A shared test framework does not join independent test additions');
  expect(comparison).toContain('split separately selectable changes, including an independent commitment shared by all options');
  expect(comparison).toContain('Each option resolves only this row');
  expect(comparison).toContain('preserve accepted requirements with their required tests and fixes');
  expect(procedure).toContain('If all alternatives are declined, continue only when the answer keeps a viable current approach');
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
      const approach = compactProse(source.split('### 0D.')[1]?.split('### 0E. Mode Selection')[0] ?? '');
      const positions = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
        'Fill Current and Proposed with behavior', '**Save pending rows before comparing options.**',
        "**3. Compare and save that row's options.**", '**Save the completed comparison before asking.**',
        '**4. Ask, record the answer, and amend.**',
        'Ask one row per call and cite its ID'].map(stage => approach.indexOf(stage));
      expect(positions.every(position => position >= 0), file).toBe(true);
      expect(positions, file).toEqual([...positions].sort((a, b) => a - b));
      expect(source).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
      expect(source.indexOf('| ID and owner |')).toBeLessThan(source.indexOf('**2. Record the pending choice.**'));
      expect(approach).toContain('behavior, limits, test method and coverage');
      expect(approach).toContain('other commitments fixed or pending');
      expect(approach).toContain('one can be selected while another stays unchanged');
      expect(approach.indexOf('Fill Current and Proposed with behavior')).toBeLessThan(approach.indexOf('Compare 2–3 approaches'));
      expect(approach).toContain('split separately selectable changes, including an independent commitment shared by all options');
      expect(source).toContain('If an attempted save fails, report it and stop');
      expect(approach).toContain('**Save pending rows before comparing options.** Save or present the complete updated plan under the storage policy');
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
  const alternatives = compactProse(skeleton.split('### 0D.')[1]?.split('### 0E.')[0] ?? '');
  const stages = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    '**Save pending rows before comparing options.**',
    "**3. Compare and save that row's options.**", '**Save the completed comparison before asking.**',
    '**4. Ask, record the answer, and amend.**'];
  const positions = stages.map(stage => alternatives.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const analyze = compactProse(section.split('**Analyze.**')[1]?.split('**Resolve.**')[0] ?? '');
  expect(analyze).toContain('Correct source-disproven claims');
  expect(section.indexOf('### Outside Voice Integration Rule')).toBeLessThan(section.indexOf('{{CODEX_PLAN_REVIEW}}'));
});

test('CEO outside findings reuse authority-first decisions without turning unknown facts into policies', () => {
  const section = fs.readFileSync(SECTION, 'utf8');
  const tension = section.split('**Cross-model tension:**')[1]?.split('**Persist the result:**')[0] ?? '';
  // The outside branch delegates to the original procedure, instead of defining
  // another four-stage approval loop with potentially different prerequisites.
  expect(tension).toContain('same six-column ledger. Use 0D for new or reopened choices');
  expect(tension).toContain('including both saves and the actual answer');
  expect(tension).toContain('do not start a second procedure');
  expect(tension).not.toContain('reference | commitment | current value');
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = compactProse(skeleton.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const stages = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    '**Save pending rows before comparing options.**', "**3. Compare and save that row's options.**",
    '**Save the completed comparison before asking.**', '**4. Ask, record the answer, and amend.**']
    .map(stage => procedure.indexOf(stage));
  expect(stages.every(position => position >= 0)).toBe(true);
  expect(stages).toEqual([...stages].sort((a, b) => a - b));
  expect(tension).toContain('Correct false premises without changing accepted behavior');
  expect(tension).toContain('Keep uncertainty with its owner and required verification');
  expect(tension).toContain('identify the causal mechanism and surface the decision or blocking verification now');
  expect(tension).toContain('A credible material risk can require action before confirmation');
  expect(tension).toContain('merely imagining another behavior is not evidence of a defect');
  expect(tension).toContain('factual corrections and confirmations need no behavior-change menu');
  expect(tension).toContain('Preserve the requested mode and its authorized scope exploration');
  expect(tension).toContain('A) Apply this change; B) Keep');
  expect(tension).toContain('A) Include; B) Defer; C) Cut; D) Hold');
  expect(tension).toContain('Revising two candidates takes two rows');
  expect(tension).toContain("check the assembled set's capacity and dependencies");
  expect(tension).toContain('Never silently trim or replace another candidate');
  expect(procedure).toContain('**Save pending rows before comparing options.** Save or present the complete updated plan under the storage policy');
  expect(skeleton).toContain('If an attempted save fails, report it and stop; do not switch to chat');
  expect(skeleton).toContain('Obey user/host restrictions separately for plans, tasks, TODOs, metadata and cleanup');
  expect(procedure).toContain('**Save the completed comparison before asking.** Save or present the complete updated plan under the storage policy');
  expect(procedure).toContain('Ask one row per call and cite its ID');
  expect(procedure).toContain('Record its reference and scope in Exact approval and scope');
  expect(procedure).toContain('apply only the authorized amendments before the next row');
  expect(tension).toContain('investigation and deferral do not authorize implementation');
  expect(tension).toContain('challenges wait for the final gate');
  expect(tension).toContain('One answer does not resolve other pending rows');
  expect(tension).toContain('including findings that needed only factual correction');
});

// Repeated public quality feedback identified these missing execution instructions.
// This guard checks the source contract; native clarity still requires paid evidence.
test('CEO Step 0 defines the decision record, execution order, and mode approval precedence', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const step0 = compactProse(source.split('## Step 0:')[1]?.split('### 0F.')[0] ?? '');
  expect(step0).toContain('Complete 0A–0E in order');
  expect(step0).toContain('Put the 0A–0C observations and evidence in the working plan; observations do not approve changes');
  expect(step0).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
  expect(step0).toContain('Keep one decision ledger through Step 0, Spec Review Loop and Outside Voice');
  expect(step0).toContain('Cite evidence, conventions and test coverage; mark unknowns');
  expect(step0).toContain('Count every requested deliverable, including those built with reused code');
  expect(step0).toContain('reuse and verification coverage');
  expect(step0).toContain('Give changes separate rows if one can be selected while another stays unchanged');
  expect(step0).toContain('observations do not approve changes');
  expect(step0).toContain('The preamble\'s session rules govern whether and how to ask');
  expect(step0).toContain('Use an explicit user mode choice and skip steps 2–3');
  expect(step0).toContain('SCOPE REDUCTION for >15 planned changed files; else SCOPE EXPANSION for greenfield work');
  expect(step0).toContain('When `QUESTION_TUNING: false`, skip the lookup');
  expect(step0).toContain('Otherwise check `question_id=plan-ceo-review-mode` through the preamble');
  expect(step0).toContain('Select the recommendation automatically only if that check exits 0 with `AUTO_DECIDE`');
  expect(step0).toContain('Without that successful check, offer all four modes in one AskUserQuestion');
  expect(step0).toContain('**STOP for the answer**');
  expect(step0).toContain('Mode selection grants no approach or scope approval');
  expect(step0).toContain('unresolved, approved, reopened, deferred or declined');
  expect(step0).toContain('This step recommends a mode; it does not select one');
  expect(step0).toContain("the user's choice wins");
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
  const alternatives = compactProse(skeleton.split('### 0D.')[1]?.split('### 0F.')[0] ?? '');
  const temporal = skeleton.split('### 0I.')[1]?.split('### 0E.')[0] ?? '';
  const continuity = compactProse(section.split('### Working review decisions')[1]!.split('### Section 1:')[0]!);
  const analyze = compactProse(continuity.split('**Analyze.**')[1]!.split('**Resolve.**')[0]!);
  const apply = compactProse(continuity.split('**Apply.**')[1]!);

  test('every approach comparison preserves approvals and separates independent changes', () => {
    expect(alternatives).toContain('preserve accepted requirements with their required tests and fixes');
    expect(alternatives).toContain('behavior, limits, test method and coverage');
    expect(skeleton).toContain('Review depth');
    expect(skeleton).toContain('Ask before expanding that depth');
    expect(alternatives).toContain('preserve unknowns');
    expect(alternatives).toContain('Give changes separate rows if one can be selected while another stays unchanged');
    expect(alternatives).toContain("Approved change with open test method/coverage | Decide once");
    expect(alternatives).toContain('every option preserves required behavior and approved tests');
    expect(compactProse(section)).toContain('Use 0D for each new or reopened choice in its owner section');
    expect(compactProse(section)).toContain("Follow 0D's test table");
    expect(alternatives).toContain('Code change and required regressions | Keep together; carry both forward once approved');
    expect(alternatives).toContain('Separate independently selectable additions. Tests for undecided behavior stay pending');
    expect(alternatives).toContain('Proposed tests for existing behavior | Separate independently selectable additions');
    expect(alternatives).toContain('Tests for undecided behavior stay pending');
    expect(alternatives).toContain('other commitments fixed or pending');
    expect(alternatives).toContain('reuse and verification coverage');
    expect(alternatives).not.toContain('for architecture choices');
    expect(alternatives.indexOf('Fill Current and Proposed with behavior')).toBeLessThan(alternatives.indexOf('Compare 2–3 approaches'));
    expect(alternatives).toContain('explain any necessary coupling');
    expect(alternatives).toContain('Carry exact approvals forward');
    expect(alternatives).toContain("Code change and required regressions | Keep together; carry both forward once approved");
    expect(alternatives).toContain('Proposed tests for existing behavior | Separate independently selectable additions');
    expect(skeleton).toContain("the actual instruction or answer reference and its exact scope");
    expect(alternatives).toContain('Weigh diff size and long-term architecture equally');
    expect(alternatives).toContain('a rewrite may be better');
    expect(alternatives).toContain('Resolve required approaches before 0E');
  });

  test('settled approach authority resolves the gate while new choices still require approval', () => {
    const approach = compactProse(alternatives.split('### 0E. Mode Selection')[0]!);
    const reuse = approach.split('**2. Record the pending choice.**')[0]!;
    const gate = approach.split('**STOP for the actual answer, even for a lone option.**')[1] ?? '';
    expect(reuse).toContain('Read the original input, inspected source and actual answers');
    expect(reuse).toContain('Carry exact approvals forward');
    const reopenRule = 'Reopen only for a concrete contradiction, changed assumption or explicit new user instruction';
    expect(compactProse(skeleton)).toContain(reopenRule);
    expect(compactProse(skeleton).indexOf(reopenRule)).toBeLessThan(compactProse(skeleton).indexOf('**2. Record the pending choice.**'));
    expect(approach).toContain('STOP for the actual answer, even for a lone option');
    expect(gate).toContain('Resolve required approaches before 0E');
    expect(approach).toContain('recommendations are not approval');
    expect(approach).not.toContain('Do NOT proceed to Step 0D or 0F until the user responds to 0C-bis');
    expect(approach).toContain('Ask one row per call and cite its ID');
    expect(approach).toContain('Use these four steps for new or reopened choices, here and in later sections');
    expect(compactProse(section)).toContain('resolve it through 0D before amending the plan');
    expect(section).toContain('An "obvious fix" still needs approval when it is not covered by an exact accepted choice');
    expect(approach).toContain("Use the preamble's format, recommendation and preference/session rules");
    expect(gate).toContain('Report settled findings');
    expect(gate).toContain('say "No issues, moving on." only for zero findings');
  });

  test('coverage scoring is conditional and legitimate early decisions retain their exact approval', () => {
    expect(alternatives).toContain('If options differ in coverage, score this row only');
    const currentAndProposed = alternatives.indexOf('Fill Current and Proposed with behavior');
    expect(currentAndProposed).toBeGreaterThan(0);
    expect(currentAndProposed).toBeLessThan(alternatives.indexOf('If options differ in coverage'));
    expect(alternatives).toContain("Use the preamble's format");
    expect(alternatives).toContain('10 = all edge cases');
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
      'One choice per AskUserQuestion',
      'Check every amendment against the actual answer or exact prior approval',
      'Save or present the complete updated plan under Step 0\'s storage policy before advancing',
      'Record this section\'s conclusions after its decisions are resolved',
    ].map(step => continuity.indexOf(step));
    expect(steps.every(position => position >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(continuity).toContain('STOP until the user responds');
    expect(compactProse(section)).toContain('Check the original input, inspected source and actual approvals');
    expect(apply).toContain('against the actual answer or exact prior approval');
    expect(apply).toContain('Preserve existing content and approved behavior, including its required implementation, tests and success/failure contracts');
    expect(apply).toContain("under Step 0's storage policy before advancing");
  });

  test('pending labels authorize only unresolved notes, not an outcome or future review conclusions', () => {
    expect(apply).toContain('Before approval, show proposed remedies only as alternatives');
    expect(apply).toContain('Keep them out of implementation tasks and do not prescribe them in diagrams or verification steps');
    expect(apply).toContain('Save or present the complete updated plan under Step 0\'s storage policy before advancing');
    expect(apply).toContain('Keep independent remedies and extra verification depth pending');
    expect(compactProse(section)).toContain('Keep each unknown risk\'s owner and required verification visible; approval does not verify it');
    expect(apply).toContain('Evaluate later sections before adding their conclusions or implementation tasks');
    expect(apply).toContain('approval settles the choice, not whether its remedy is implemented or verified');
    expect(apply).toContain('Retain unresolved choices in the ledger and final report');
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
  const continuity = compactProse(template.split('### Working review decisions')[1]?.split('### Section 1:')[0] ?? '');

  test('analysis, decision, and approved amendment precede advancing to the next section', () => {
    expect(continuity).not.toBe('');
    const positions = ['**Analyze.**', '**Resolve.**', '**Apply.**'].map(step => continuity.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(continuity).toContain("under Step 0's storage policy before advancing");
    for (const clause of clauses) {
      expect(clause).toContain('Analyze → resolve → apply');
      expect(clause).toContain('Do not prewrite the remaining sections');
      expect(clause).toContain('Proposed findings are not accepted plan changes');
      expect(clause).toContain('full review and terminal report');
    }
  });

  test('all eleven section gates preserve decisions without manufacturing a question per section', () => {
    const sections = [...template.matchAll(/^### Section (\d+):([^]*?)(?=^### Section \d+:|^## Closing sequence)/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    // One governing checkpoint supplies the same actual-answer rule to all
    // eleven callers; settled findings do not manufacture another question.
    expect(continuity).toContain("At each **Decision gate**, complete Analyze → Resolve → Apply");
    expect(continuity).toContain('One choice per AskUserQuestion');
    expect(continuity).toContain('One choice per AskUserQuestion: recommend + WHY and **STOP until the user responds**');
    expect(continuity).toContain('Cross-reference exact settled decisions instead of asking again');
    expect(continuity).toContain('Report findings with their dispositions; "No issues found" means zero findings, not zero new questions');
    expect(continuity).toContain('"No issues found" means zero findings, not zero new questions');
    expect(continuity).toContain('Check every amendment against the actual answer or exact prior approval');
    expect(continuity).toContain('Review only; do not change code');
    expect(template.indexOf('### Working review decisions')).toBeLessThan(template.indexOf('### Section 1:'));
    for (const [, number, body] of sections) {
      expect(body, `Section ${number}`).toContain('**Decision gate.** Complete Analyze → Resolve → Apply above for this section before continuing.');
      expect(body.match(/\*\*Decision gate\.\*\*/g), `Section ${number}`).toHaveLength(1);
    }
    expect(template).not.toContain('If the section has findings, you MUST call AskUserQuestion');
    expect(template).not.toContain('Otherwise, use AskUserQuestion for each finding');
    expect(template).not.toContain('After each section, pause and wait for feedback');
    expect(template).toContain('Evaluate Sections 1–10 in full regardless of plan type');
    expect(template).toContain('Evaluate Section 11 when the accepted scope includes UI; otherwise record `SKIPPED (no UI scope)`');
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
    const sources = compactProse(skeleton.split('**1. Check sources and prior answers.**')[1]!.split('**2. Record the pending choice.**')[0]!);
    expect(sources).toContain('Reopen only for a concrete contradiction, changed assumption or explicit new user instruction');
    expect(sources).toContain('never speculation or reviewer agreement');
    const limits = skeleton.split('**Keep the stated limits.**')[1]!.split('**Storage policy:')[0]!;
    expect(limits).toContain('Record what each limit measures, its value, unit and prerequisites');
    expect(limits).toContain('Changing a limit needs evidence and user approval');
    expect(limits).toContain('Count every requested deliverable, including those built with reused code');
    expect(skeleton.indexOf('Record what each limit measures')).toBeLessThan(skeleton.indexOf('### 0D.'));
    const temporal = skeleton.split('### 0I.')[1]?.split('{{SECTION:review-sections}}')[0] ?? '';
    expect(temporal).toContain('Resolve scope and feasibility blockers now');
    expect(temporal).toContain('Keep other design choices pending unless the user requested implementation planning');
    expect(template).toContain('required diagrams and maps show candidate boundaries, failure mechanisms, feasibility conditions and unresolved risks');
    expect(template).toContain('Keep non-blocking implementation choices pending with owners and required verification');
    expect(template).toContain('Resolve material blockers now; reopen priorities on new evidence');
    expect(template).toContain('report prioritization completion separately from implementation readiness');
    expect(continuity).toContain('Continue Step 0\'s six-column ledger');
    expect(earlyLedger).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
    expect(earlyLedger).toContain('Cite evidence, conventions and test coverage; mark unknowns');
    expect(sources).toContain('Carry exact approvals forward');
    expect(continuity).toContain('Use 0D for each new or reopened choice in its owner section');
    for (const requirement of ['naming the owner section for each row',
      'An approach approves its explicit commitments, not every implementation choice',
      'approval settles the choice, not whether its remedy is implemented or verified',
      'Preserve contracts and mitigations with their evidence; later silence does not revoke them',
      'Keep each unknown risk\'s owner and required verification visible']) expect(continuity).toContain(requirement);
    // The continued ledger uses Step 0's existing status schema, not a second table.
    expect(earlyLedger).toContain('unresolved, approved, reopened, deferred or declined');
  });

  test('ownership never defers a critical risk or merges distinct choices by topic', () => {
    const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
    expect(continuity).toContain('Use 0D for each new or reopened choice');
    expect(skeleton).toContain('Give changes separate rows if one can be selected while another stays unchanged');
    expect(compactProse(skeleton)).toContain('split separately selectable changes, including an independent commitment shared by all options');
    for (const requirement of ['newly discovered critical risks need immediate resolution',
      'Use 0D for each new or reopened choice in its owner section',
      'sharing a helper does not combine a safety fix with a throughput improvement']) expect(continuity).toContain(requirement);
    const testReview = compactProse(template.split('### Section 6: Test Review')[1]!.split('### Section 7:')[0]!);
    expect(testReview).toContain('Carry requested or approved coverage forward, including directly determined tests, without re-asking');
    expect(testReview).toContain('For an unresolved test-method choice or additional verification scope/depth, name the distinct regression existing tests miss and resolve that choice through 0D before prescribing it');
    expect(testReview).toContain('An approved runtime contract alone does not choose extra verification scope');
    const outside = compactProse(template.split('### Outside Voice Integration Rule')[1]!.split('{{CODEX_PLAN_REVIEW}}')[0]!);
    expect(outside).toContain('Apply Analyze above to each outside finding before adding it to the same ledger');
    expect(outside).toContain('Reviewer agreement is not new evidence or approval');
    expect(outside).toContain('resolve it through 0D before amending the plan');
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

test('CEO closing route checks approvals before outputs and verifies artifacts before telemetry without a file bounce', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const route = section.split('## Closing sequence')[1]!.split('### Outside Voice Integration Rule')[0]!;
  const routeStages = ['**Outside Voice:**', '**Resolve remaining TODO choices:**', '**Approval readiness:**',
    '**Required Outputs:**', '**Cleanup and history:**', '**Navigation:**', '**Learnings:**']
    .map(stage => route.indexOf(stage));
  expect(routeStages.every(position => position >= 0)).toBe(true);
  expect(routeStages).toEqual([...routeStages].sort((a, b) => a - b));
  expect(route.match(/^\d+\. /gm)).toHaveLength(7);
  expect(route).toContain('Record disabled or unavailable coverage and continue when no reviewer runs');
  expect(route).toContain('check the ledger and record PASS before writing outputs');
  expect(route).toContain('no report or log is needed yet');
  expect(route).toContain('A substantive answer returns to 0D → Approval readiness → affected outputs → report Read-back → log → dashboard');
  expect(route).toContain('queue the next skill');
  expect(route).toContain('Its EXIT gate only verifies completed work and the saved readiness result; it does not ask again');
  expect(route).toContain('A passing persisted review then runs telemetry, cache refresh and exit');

  const sectionStages = ['## Closing sequence', '{{CODEX_PLAN_REVIEW}}', '## Resolve remaining TODO choices',
    '### TODOS.md updates', '{{PLAN_REVIEW_APPROVAL_CHECK}}', '## Required Outputs',
    '{{PLAN_FILE_REVIEW_REPORT}}', '## Review Log', '{{REVIEW_DASHBOARD}}', '## Next Steps — Review Chaining',
    '## docs/designs Promotion', '{{LEARNINGS_LOG}}', '{{GBRAIN_SAVE_RESULTS}}', '{{BRAIN_WRITE_BACK}}',
    "Return to this skill's main `SKILL.md`: Section self-check → EXIT PLAN MODE GATE."]
    .map(stage => section.indexOf(stage));
  expect(sectionStages.every(position => position >= 0)).toBe(true);
  expect(sectionStages).toEqual([...sectionStages].sort((a, b) => a - b));
  expect(section).not.toContain('{{EXIT_PLAN_MODE_GATE}}');
  expect(section).not.toContain('{{BRAIN_CACHE_REFRESH}}');
  expect(section).not.toContain('Run the preamble\'s **Telemetry');

  const actualGate = skeleton.indexOf('{{EXIT_PLAN_MODE_GATE}}');
  expect(actualGate).toBeGreaterThan(skeleton.indexOf('## Section self-check'));
  const terminal = skeleton.slice(actualGate);
  const failed = terminal.split('**Failed or not persisted:**')[1]!.split('**Passed with a verified persisted report:**')[0]!;
  expect(failed).toContain('complete labeled chat output and stop here');
  expect(failed).toContain('Do not run success telemetry or call ExitPlanMode');
  const success = terminal.split('**Passed with a verified persisted report:**')[1]!;
  const terminalStages = ['**Telemetry (run last)** once', 'nonblocking cache refresh below',
    '{{BRAIN_CACHE_REFRESH}}', 'Only after a passing gate: call ExitPlanMode'].map(stage => success.indexOf(stage));
  expect(terminalStages.every(position => position >= 0)).toBe(true);
  expect(terminalStages).toEqual([...terminalStages].sort((a, b) => a - b));
  expect(terminal).not.toMatch(/return to (?:the )?section|Closing hooks/);
  expect(terminal).not.toContain('Finish with ExitPlanMode');
  expect(skeleton).not.toContain('Before summaries, review logs or next-step menus, run approval check 0 below');
  expect(success).toContain('without changing this review');

  const governingStages = ['## CRITICAL RULE — How to ask questions', '## Formatting Rules',
    '## Mode Quick Reference', '### Working review decisions', '### Section 1:']
    .map(stage => section.indexOf(stage));
  expect(governingStages.every(position => position >= 0)).toBe(true);
  expect(governingStages).toEqual([...governingStages].sort((a, b) => a - b));
  const questions = section.split('## CRITICAL RULE — How to ask questions')[1]!.split('## Mode Quick Reference')[0]!;
  expect(questions).toContain('`D<N>` question heading and A/B/C option labels');
  expect(questions).toContain('Cite the stable ledger ID separately');
  expect(questions).not.toMatch(/NUMBER \+ (?:option )?LETTER|"3A"|One sentence max per option/);
});

describe('plan-ceo-review carve — static ordering', () => {
  const skeleton = fs.readFileSync(SKELETON, 'utf-8');
  const section = fs.readFileSync(SECTION, 'utf-8');

  // Index into the skeleton, -1 if absent.
  const at = (needle: string): number => skeleton.indexOf(needle);

  const STEP0 = '## Step 0: Nuclear Scope Challenge + Mode Selection';
  const STOP = 'sections/review-sections.md'; // appears in the index row + STOP directive
  const GATE = 'GSTACK REVIEW REPORT';

  test('the interactive anti-shortcut contract is available before audit or lazy section loading', () => {
    const contract = '**Anti-shortcut clause:**';
    const audit = skeleton.indexOf('## PRE-REVIEW SYSTEM AUDIT');
    expect(skeleton.indexOf(contract)).toBeGreaterThan(-1);
    expect(skeleton.indexOf(contract)).toBeLessThan(audit);
    expect(skeleton.split(contract)).toHaveLength(2);
    expect(section).not.toContain(contract);
    // CEO's shared contract distinguishes unanswered choices from exact prior
    // approvals; the generic fallback's any-finding rule is not its contract.
    expect(skeleton).toContain(generateAntiShortcutClause({ skillName: 'plan-ceo-review' } as TemplateContext));
    expect(skeleton).toContain('Ask once per unresolved or reopened issue, wait for the answer');
    expect(skeleton).toContain('Cross-referencing settled decisions never replaces the full review and terminal report');
    expect(skeleton).toContain('never invent a question merely because a new section starts');
  });

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
    expect(skeleton.indexOf('## Continue after Step 0 (all modes)')).toBeGreaterThan(skeleton.indexOf('### 0I.'));
    expect(skeleton.indexOf('## Continue after Step 0 (all modes)')).toBeLessThan(skeleton.indexOf('> **STOP.**'));
    expect(skeleton).toContain('ask separately for each proposed cut');
    expect(skeleton).toContain("evaluate Sections 1–10 and Section 11's UI applicability, complete every applicable section, required outputs and terminal review report");
    expect(skeleton).toContain('SCOPE REDUCTION for >15 planned changed files; else SCOPE EXPANSION for greenfield work');
    expect(skeleton).toContain('the >8-file check challenges complexity within HOLD SCOPE and SELECTIVE EXPANSION');
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
      expect(step0.replace(/\s+/g, ' ')).toContain("Complete every Step 0 analysis/output on the loaded skill's SELECTIVE EXPANSION route");
      expect(step0.replace(/\s+/g, ' ')).toContain('CEO scope document and 0H Spec Review Loop before 0I and Review Sections');
      expect(step0).not.toMatch(/^- 0[A-I](?:-bis)?:/m);
      // The headings alone can be ordered while executable reviewer payloads
      // still run ahead of Step 0, or Codex is presented ahead of Claude.
      const prose = phase.replace(/\s+/g, ' ');
      const positions = ['**Required execution checklist (CEO):**', 'Step 0.5 (Dual Voices):',
        'Read `snapshot.json` beside `<CEO_INPUT>`',
        'Send its `nativeDispatchPrompt` verbatim as the Agent prompt', 'Native completion barrier:',
        'Outside prompt: inline the full contents of <CEO_INPUT>',
        suffix === '.md.tmpl' ? '{{OUTSIDE_INVOCATION:autoplan}}' : '_OUTSIDE_EXIT=0',
        'CEO DUAL VOICES — CONSENSUS TABLE:', 'Sections 1-11 —', '**Mandatory outputs from Phase 1:**', '**Close this phase:**',
        suffix === '.md.tmpl' ? '{{SECTION:phase-close}}' : 'Read `~/.claude/skills/gstack/autoplan/sections/phase-close.md` and execute it']
        .map(stage => prose.indexOf(stage));
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

  test('the loaded test-review section preserves mandatory behaviors and individual assertion decisions', () => {
    const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf-8');
    for (const document of [template, section]) {
      const testReview = document.split('### Section 6: Test Review')[1]?.split('### Section 7:')[0];
      expect(testReview).toBeDefined();
      const instructions = testReview!.replace(/\s+/g, ' ');
      expect(instructions).toContain("Map it to the user's exact requirement or individually approved remedy.");
      expect(instructions).toContain('A stated outcome plus its retained caller contract can determine the assertion, even without assertion syntax.');
      expect(instructions).toContain('Translate semantic counts, conditions and quantifiers exactly');
      expect(instructions).toContain('never weaken an exact count to a lower bound.');
      expect(instructions).toContain('Reuse these requirements without asking again.');
      expect(instructions).toContain('Ask individually only for an unresolved behavioral choice, new outcome, or independent uncovered failure mode.');
      expect(instructions).toContain('Vague success labels do not settle values');
      expect(instructions).toContain('scope/approach approval does not resolve an individual assertion gap.');
      expect(instructions).toContain("Verify the caller's path; helper coverage alone does not prove it.");
      expect(instructions).toContain('Explain what the existing requirement or approved remedy fails to cover before calling a check missing.');
      expect(instructions).toContain('Never silently add, defer or waive a missing behavioral assertion.');
      expect(instructions).toContain('Keep required behaviors mandatory unless the user explicitly approves changing them');
      expect(instructions).toContain('Honor previously accepted risks and equivalent caller coverage.');
      const phases = ['**Map the requirement.**', '**Reuse settled proof.**', '**Resolve actual gaps.**'].map(phase => instructions.indexOf(phase));
      expect(phases.every(position => position >= 0)).toBe(true);
      expect(phases).toEqual([...phases].sort((a, b) => a - b));
      expect(instructions).toContain('**Decision gate.** Complete Analyze → Resolve → Apply above for this section before continuing.');
      const procedure = document.split('### Working review decisions')[1]!.split('### Section 1:')[0]!.replace(/\s+/g, ' ');
      expect(document.indexOf('### Working review decisions')).toBeLessThan(document.indexOf('### Section 6: Test Review'));
      expect(procedure).toContain("At each **Decision gate**, complete Analyze → Resolve → Apply");
      expect(procedure).toContain('One choice per AskUserQuestion: recommend + WHY and **STOP until the user responds**');
      expect(procedure).toContain('STOP until the user responds');
      expect(procedure).toContain('Check every amendment against the actual answer or exact prior approval');
      expect(procedure).toContain('Report findings with their dispositions; "No issues found" means zero findings, not zero new questions');
    }
  });

  test('the loaded data-flow review requires evidence across interacting operations', () => {
    const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf-8');
    for (const document of [template, section]) {
      const dataFlow = document.split('### Section 4: Data Flow & Interaction Edge Cases')[1]?.split('### Section 5:')[0];
      expect(dataFlow).toBeDefined();
      const instructions = dataFlow!.replace(/\s+/g, ' ');
      expect(instructions).toContain('Draw a combined ASCII schedule with one column per operation and one for shared state.');
      expect(instructions).toContain('pause, let a competing operation complete, resume, then start a fresh consumer.');
      expect(instructions).toContain('State the invariant and its exact caller/time boundary.');
      expect(instructions).toContain('Show the observed result against the invariant.');
      expect(instructions).toContain('If safe, name the mechanism that prevents the violating schedule.');
      expect(instructions).toContain('Separate diagrams, one favorable schedule, single-thread execution and atomic calls do not prove ordering across awaits.');
      expect(instructions).toContain('An accepted exception needs its exact contract clause; bounded damage is insufficient.');
      expect(instructions).toContain('For each pair of overlapping awaits that can affect that invariant, show both completion orders.');
      expect(instructions).toContain('Exclude an order only by naming the mechanism that prevents it.');
      expect(instructions).toContain('The invariant is a requirement, not proof that the implementation meets it.');
      expect(instructions).toContain('Test the relevant completion orders with controlled pause/release points.');
      expect(instructions).toContain('Compare relevant pairs; exhaustive permutations are unnecessary.');
      const phases = ['**Define the boundary.**', '**Exercise both orders.**', '**Compare the result.**', '**Specify regression proof.**'].map(phase => instructions.indexOf(phase));
      expect(phases.every(position => position >= 0)).toBe(true);
      expect(phases).toEqual([...phases].sort((a, b) => a - b));
    }
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
