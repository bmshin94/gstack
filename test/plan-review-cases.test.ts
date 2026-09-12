import { describe, expect, test } from 'bun:test';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGeneration } from '../scripts/gen-skill-docs';
import { generateAntiShortcutClause, generateCodexPlanReview, generatePlanFileReviewReport } from '../scripts/resolvers/review';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateTestCoverageAuditPlan } from '../scripts/resolvers/testing';
import { ALL_HOST_CONFIGS } from '../hosts';

const menu = (labels: string[], header = 'Next review', question = "D12 — What's next?"): NativeQuestion => ({
  header, question, multiSelect: false, options: labels.map(label => ({ label, description: 'Offered choice' })),
});

// Generated instruction ordering only; native completion remains a paid check.
describe('plan report persistence precedes completion logging', () => {
  const plans = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'];
  for (const skill of plans) {
    test(`${skill}: save/readback gate precedes its log and dashboard`, () => {
      const template = readFileSync(`${skill}/sections/review-sections.md.tmpl`, 'utf8');
      const report = template.indexOf('{{PLAN_FILE_REVIEW_REPORT}}');
      const log = template.indexOf('## Review Log');
      const dashboard = template.indexOf('{{REVIEW_DASHBOARD}}');
      expect(report).toBeGreaterThan(0);
      expect(report).toBeLessThan(log);
      expect(log).toBeLessThan(dashboard);
      expect(template.match(/\{\{PLAN_FILE_REVIEW_REPORT\}\}/g)).toHaveLength(1);
      expect(template.slice(log, dashboard)).toContain('successful write and Read-back');
      expect(template.slice(log, dashboard)).toContain('report the error and stop');
    });
  }
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: current report does not depend on a premature completion record`, () => {
      for (const skillName of plans) {
        const report = generatePlanFileReviewReport({ skillName, host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext);
        // PLAN.md may be the review input while REPORT.md is the requested output.
        const target = report.slice(report.indexOf('### Detect the plan file'), report.indexOf('### Generate the report'));
        expect(target).toContain('Use an explicitly requested output/report file first.');
        expect(target).toContain('Otherwise use the reviewed plan named by the user, then the host active plan.');
        expect(target).toContain('If no file is in scope, skip this section');
        expect(report).toContain('prior review entries');
        expect(report).toContain('current Completion Summary or DX Scorecard');
        expect(report).toContain('add exactly one to its prior run count');
        expect(report).toContain('Do not pre-log this run');
        expect(report).toContain('full review output');
        expect(report).toContain('whether or not a prior report existed');
        expect(report).toContain('stop before Review Log or decision logging');
        expect(report.indexOf('Read-back gate')).toBeGreaterThan(report.indexOf('### Write to the plan file'));
        expect(report).not.toContain('After displaying the Review Readiness Dashboard');
        expect(report).not.toContain('review log output you already have');
      }
      for (const skillName of ['codex', 'devex-review']) {
        const report = generatePlanFileReviewReport({ skillName, host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext);
        expect(report).toContain('After displaying the Review Readiness Dashboard');
        expect(report).not.toContain('Do not pre-log this run');
      }
    });
  }
  test('every generated plan-review carrier keeps write/readback before log before dashboard', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'review-persistence-order-'));
    try {
      const generated = await runGeneration({ host: 'all', outputRoot, contentLinkRoot: null, log: () => {} });
      expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
      const carriers = generated.artifacts.filter(artifact => artifact.host === 'claude'
        ? artifact.kind === 'section' && plans.some(skill => artifact.relativePath === `${skill}/sections/review-sections.md`)
        : artifact.kind === 'skill' && plans.some(skill => artifact.relativePath.endsWith(`/gstack-${skill}/SKILL.md`)));
      expect(carriers).toHaveLength(plans.length * ALL_HOST_CONFIGS.length);
      for (const carrier of carriers) {
        const content = readFileSync(join(outputRoot, carrier.relativePath), 'utf8');
        const report = content.indexOf('\n## Plan File Review Report\n');
        const readback = content.indexOf('**Read-back gate:**', report);
        const log = content.indexOf('\n## Review Log\n');
        const dashboard = content.indexOf('\n## Review Readiness Dashboard\n');
        expect({ carrier: carrier.relativePath, ordered: 0 < report && report < readback && readback < log && log < dashboard }).toMatchObject({ ordered: true });
        expect(content.slice(report, readback)).toContain('current Completion Summary or DX Scorecard');
        expect(content.slice(readback, log)).toContain('stop before Review Log or decision logging');
      }
    } finally { rmSync(outputRoot, { recursive: true, force: true }); }
  }, 30_000);
});

test('Eng independent-remedy rule is loaded before Step 0 and retains outside-voice consent', () => {
  const definition = 'ask separately about each pending independent remedy';
  for (const suffix of ['.tmpl', '']) {
    const skeleton = readFileSync(`plan-eng-review/SKILL.md${suffix}`, 'utf8');
    const sections = readFileSync(`plan-eng-review/sections/review-sections.md${suffix}`, 'utf8');
    const reviewBoundary = skeleton.indexOf('Do not build features, acceptance suites or benchmarks unless explicitly authorized by the user');
    expect(reviewBoundary).toBeGreaterThan(skeleton.indexOf('# Plan Review Mode'));
    expect(reviewBoundary).toBeLessThan(skeleton.indexOf('## Scope gate'));
    expect(skeleton.slice(reviewBoundary, skeleton.indexOf('## Scope gate'))).toContain('Use existing tests, examples or bounded probes of current behavior for evidence');
    const rule = skeleton.indexOf(definition);
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(skeleton.indexOf('### Step 0: Scope Challenge'));
    expect(skeleton.slice(rule, rule + 350).replace(/\s+/g, ' ')).toContain("Keep one chosen contract's implementation and tests together");
    expect((skeleton + sections).split(definition)).toHaveLength(2);
    expect(skeleton).toContain('Explain tradeoffs, recommend, and ask separately about each pending independent remedy, including outside findings');
    expect(skeleton).toContain('Scope reduction does not approve independent remedies');
    expect(skeleton).not.toContain('For every issue or recommendation');
    const scope = skeleton.slice(skeleton.indexOf('### Step 0: Scope Challenge'), skeleton.indexOf('**STOP while a Step 0 question'));
    expect(scope).toContain('8+ files or 2+ new classes/services');
    expect(scope).toContain('STOP before section work');
    expect(scope).toContain("Use the preamble's question rules");
    expect(scope).toContain('Ask about each needed feature cut or deferral separately first');
    expect(scope).toContain('Compare original and smaller class/module arrangements with the same feature choices');
    expect(scope).toContain('Preserve contracts and approved security, error handling, test and performance fixes in both');
    expect(scope).toContain('leave unapproved fixes pending');
    expect(scope).toContain('This chooses structure only');
    expect(scope).toContain('Ask separately before accepting, rejecting or deferring another remedy');
    expect(scope).not.toContain('proceed as-is');
    const stop = skeleton.indexOf('**STOP while a Step 0 question');
    const resume = skeleton.indexOf('After the gate resolves', stop);
    expect(resume).toBeGreaterThan(stop);
    expect(skeleton.slice(stop, resume)).toContain('Do not start Section 1, call ExitPlanMode, or write findings or fixes into a plan file');
    expect(skeleton.slice(resume)).toContain('apply only accepted scope changes');
    expect(skeleton.slice(resume)).toContain('run Prior Learnings and Confidence Calibration, and enter Section 1');
    expect(skeleton.slice(resume)).toContain('Take the same route if complexity did not trigger the gate');
    const inventory = sections.indexOf('**Decision gate (all sections and outside voice):**');
    expect(inventory).toBeGreaterThan(0);
    expect(inventory).toBeLessThan(sections.indexOf('### 1. Architecture review'));
    const boundary = sections.slice(inventory, sections.indexOf('### 1. Architecture review')).replace(/\s+/g, ' ');
    expect(boundary).toContain('Start this after Step 0 resolves scope');
    expect(boundary).toContain('Could the user accept one change and reject another?');
    expect(boundary).toContain('If yes, separate them now. Sharing an issue heading, helper or patch does not make two changes one choice');
    expect(boundary).toContain('one behavior, implementation approach, bound or optional verification depth');
    expect(boundary).toContain("For a bound, include what it measures and its unit");
    expect(boundary).toContain('Keep other approved choices fixed and unresolved choices pending');
    expect(boundary).toContain('Keep a chosen behavior together with the code, tests and docs required to establish it');
    expect(sections).toContain('Score completeness only within this one decision');
    expect(boundary).toContain('Never shrink an option by dropping an established contract or earlier accepted choice');
    expect(boundary).toContain('changing that contract needs its own decision');
    expect(boundary).toContain('Carry forward the code, tests and docs needed for an exact approved behavior, even when discovered after the Tests section');
    expect(boundary).toContain('Each option must answer the choice selected in Step 2');
    expect(boundary).toContain('Do the same if any option adds another independently selectable change');
    expect(boundary).toContain('Required proof is part of that approved work');
    expect(boundary).toContain('do not change behavior as part of that correction');
    expect(sections).toContain('Use the same decision gate and ledger for outside voice findings');
    expect(sections).toContain('Agreement between reviewers is evidence, not approval');
    expect(sections).toContain('keep new or reopened choices pending until their own answers resolve them');
  }
});

// Source/renderer contract controls only: native review behavior remains a paid
// regression. Resolve the actual Eng clause on every host without trusting an
// old generated carrier to hide a contradictory unconditional approval gate.
describe('Eng approved-work decision gate', () => {
  const template = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
  const gate = template.split('**Decision gate (all sections and outside voice):**')[1]?.split('### 1. Architecture review')[0] ?? '';

  test('identifies the question before drafting alternatives, then saves before asking', () => {
    const identify = gate.indexOf('**2. Identify one independently answerable change.**');
    const alternatives = gate.indexOf('**3. Build alternatives for that change.**');
    const save = gate.indexOf('**4. Assign and save rows.**');
    const ask = gate.indexOf('**5. Ask, record the answer, then edit.**');
    expect(0 <= identify && identify < alternatives && alternatives < save && save < ask).toBe(true);
    const choice = gate.slice(identify, alternatives);
    expect(choice).toContain('Before writing options');
    expect(choice).toContain('Could the user accept one change and reject another?');
    expect(choice).toContain('Keep other approved choices fixed and unresolved choices pending');
    expect(choice).toContain('Keep a chosen behavior together with the code, tests and docs required to establish it');
    expect(choice).toContain('Choosing unit, integration or smoke-test depth for a fixed behavior is one verification choice');
    const options = gate.slice(alternatives, save);
    expect(options).toContain('If an option keeps one proposed change but drops another, you have two choices');
    expect(options).toContain('return to Step 2');
    expect(options).toContain('Include values shared by all options');
    expect(gate.slice(save, ask)).toContain('Save the rows and options with Write or Edit before calling AskUserQuestion');
    expect(gate.slice(ask)).toContain('Record the actual selected option and answer');
    expect(gate.slice(ask)).toContain('separately from your draft options');
  });

  test('current contracts and completed comparisons precede saved questions without approving a fix', () => {
    const stages = ['**1. Check the source and prior answers.**', '**2. Identify one independently answerable change.**',
      '**3. Build alternatives for that change.**', '**4. Assign and save rows.**',
      '**5. Ask, record the answer, then edit.**'].map(stage => gate.indexOf(stage));
    expect(stages.every(position => position >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(gate).toContain("For a bound, include what it measures and its unit");
    expect(gate).toContain('For verification, include the method and depth');
    expect(gate).toContain('For EVERY option, read its label, description and pros/cons');
    expect(gate).toContain('Compare each item with the source and actual answers from Step 1');
    expect(gate).toContain('Save the rows and options with Write or Edit before calling AskUserQuestion');
    expect(gate).toContain('If saving fails, report the error and stop before asking');
    expect(gate).toContain("Respect the user's read-only request and the host's file-write limits");
    expect(gate).toContain('when no writable plan is in scope, present the table instead');
    expect(gate).toContain('Each AskUserQuestion call contains exactly one question for one row');
    expect(gate).toContain('Mark undecided rows `pending`');
    expect(gate).toContain('do not add their remedies as accepted work');
  });

  test('all four section gates and outside voice distinguish pending choices from findings', () => {
    const sections = [...template.matchAll(/^### ([1-4])\.([^]*?)(?=^### [1-4]\.|^\{\{CODEX_PLAN_REVIEW\}\})/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual([1, 2, 3, 4]);
    for (const [, number, source] of sections) {
      const body = source.replace('{{TEST_COVERAGE_AUDIT_PLAN}}', () => generateTestCoverageAuditPlan({} as TemplateContext));
      expect(body, `Section ${number}`).toContain("Run the decision gate for this section's new or reopened choices");
      expect(body, `Section ${number}`).toContain('**STOP for each pending decision.**');
      expect(body, `Section ${number}`).toContain('Wait for its answer before applying that remedy, moving to the next section or calling ExitPlanMode');
      if (number === '3') {
        const stop = body.indexOf('**STOP for each pending decision.**');
        const artifact = body.indexOf('### Test Plan Artifact');
        const report = body.indexOf('After the Test Plan Artifact is saved or presented, report the Test review findings');
        expect(0 <= stop && stop < artifact && artifact < report).toBe(true);
        expect(body.slice(stop, artifact)).not.toContain('and continue');
      } else {
        expect(body, `Section ${number}`).toContain('When no decision remains, report the findings and their dispositions and continue');
      }
    }
    expect(gate).toContain('An obvious fix still needs approval unless an exact prior answer already covers it');
    expect(template).toContain('Use the same decision gate and ledger for outside voice findings');
    expect(template).toContain('keep new or reopened choices pending until their own answers resolve them');
    expect(template).toContain('Never condense, abbreviate, or skip any review section (1-4)');
    expect(template).toContain('{{PLAN_FILE_REVIEW_REPORT}}');
    for (const stale of ['For each issue found in this section',
      'Otherwise, use AskUserQuestion for each finding',
      'Outside voice findings are INFORMATIONAL until the user explicitly approves each one']) {
      expect(template).not.toContain(stale);
    }
  });

  test('every option is recorded against one decision before asking or scoring coverage', () => {
    const compare = gate.indexOf('**3. Build alternatives for that change.**');
    const rows = gate.indexOf('**4. Assign and save rows.**');
    const record = gate.indexOf('For each option, fill `Option comparisons`');
    const save = gate.indexOf('Save the rows and options with Write or Edit before calling AskUserQuestion');
    const ask = gate.indexOf('**5. Ask, record the answer, then edit.**');
    expect(0 <= compare && compare < rows && rows < record && record < save && save < ask).toBe(true);
    expect(gate.slice(rows, record)).toContain('| Option comparisons |');
    expect(gate.slice(record, save)).toContain('`label: changes; preserves; pending`');
    const format = template.split('## CRITICAL RULE — How to ask questions')[1]!.split('## Required outputs')[0]!;
    expect(format).toContain('After the decision gate validates the options');
    expect(format).toContain('one recorded decision');
    expect(format).not.toContain('per-issue AskUserQuestion');
  });

  test('exact prior answers authorize follow-through while new risk and optional depth stay pending', () => {
    const normalized = gate.replace(/\s+/g, ' ');
    expect(normalized).toContain('Correct factual mistakes against source evidence and disclose the correction');
    expect(normalized).toContain('do not change behavior as part of that correction');
    expect(normalized).toContain('An approval needs its selected option, answer reference and exact scope');
    expect(normalized).toContain('A broad approach, your recommendation or agreement between reviewers does not approve other work');
    expect(normalized).toContain('A test that adds a different guarantee or policy needs its own decision');
    expect(normalized).toContain('Reopen an approved choice only for a concrete new risk, contradictory evidence or changed assumption');
    expect(normalized).toContain('An uncertain risk can still need a decision; state what is unknown');
    expect(normalized).toContain('Which other choices remain pending');
    expect(normalized).toContain('keep tests for an unapproved policy conditional on its approval');
    expect(normalized).toContain('retain unresolved risks and required verification');
    expect(normalized).toContain('A number in your draft is not a user answer; leave unknown values unknown');
  });

  test('every host resolves the Eng gate without the conflicting generic shortcut clause', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const clause = generateAntiShortcutClause({ skillName: 'plan-eng-review', host: host.name } as TemplateContext);
      expect(clause).toContain('Use the decision gate for all four sections and outside voice');
      expect(clause).toContain('Retain findings and evidence');
      expect(clause).toContain('Ask only for new or reopened choices and apply their exact answers');
      expect(clause).toContain('Never prewrite unapproved remedies or skip sections or the terminal report');
      expect(clause).not.toContain('ANY non-trivial finding');
      expect(clause).not.toContain('Zero findings in every section is the only path');
    }
  });
});

// These checks cover generated instructions, not native model compliance.
describe('outside-voice commitment queue', () => {
  test('Eng under-Codex preflight has one explicit skip route on every host', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const context = { host: host.name, paths: HOST_PATHS[host.name]! };
      const eng = generateCodexPlanReview({ ...context, skillName: 'plan-eng-review' } as TemplateContext);
      if (host.name === 'codex') {
        expect(eng).toBe('');
        continue;
      }
      const underCodex = eng.split('- **`under_codex`**')[1]!.split('\n- **')[0]!;
      expect(underCodex).toContain('skip this outside-voice section and continue to the required outputs');
      expect(underCodex).toContain('No in-host substitute is defined here');
      expect(eng).not.toContain("run the section's free in-host pass instead if it defines one");
      expect(eng).not.toContain('On `under_codex`,');
      const other = generateCodexPlanReview({ ...context, skillName: 'plan-design-review' } as TemplateContext);
      expect(other).toContain("run the section's free in-host pass instead if it defines one");
      expect(other).toContain('On `under_codex`, no in-host substitute is defined here');
    }
  });

  const skills = ['plan-ceo-review', 'plan-eng-review', 'plan-devex-review'];
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: separates changed commitments and preserves scope revision choices`, () => {
      for (const skillName of skills) {
        const tmplPath = `${skillName}/sections/review-sections.md.tmpl`;
        expect(readFileSync(tmplPath, 'utf8')).toContain('{{CODEX_PLAN_REVIEW}}');
        const generated = generateCodexPlanReview({ skillName, tmplPath, host: host.name, paths: HOST_PATHS[host.name]! });
        if (host.name === 'codex') {
          expect(generated).toBe('');
          continue;
        }
        const start = generated.indexOf('**Cross-model tension:**');
        const end = generated.indexOf('**Persist the result:**', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const queue = generated.slice(start, end);
        // Each review reuses its own gate; DX retains the generic queue.
        if (skillName === 'plan-ceo-review') {
          const order = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
            "**3. Compare and save that row's options.**", '**4. Ask, record the answer, and amend.**']
            .map(stage => queue.indexOf(stage));
          expect(order.every(position => position >= 0)).toBe(true);
          expect(order).toEqual([...order].sort((a, b) => a - b));
          expect(queue).toContain('same six-column decision ledger and the four steps of 0D');
          expect(queue).not.toContain('reference | commitment | current value');
          expect(queue).toContain('original input, inspected source and exact approvals');
          expect(queue).toContain('Correct false premises in the draft and its evidence without changing accepted behavior');
          expect(queue).toContain('Keep factual uncertainty explicit, with its owner and required verification');
          expect(queue).toContain('A credible material risk can require action before its occurrence is confirmed');
          expect(queue).toContain("Apply 0D's separation and approval rules");
          expect(queue).toContain('distinction between required proof and new test additions');
          expect(queue).toContain('Hold every other commitment fixed or pending in every option; split independently selectable changes');
          expect(queue).toContain("A) Apply this change; B) Keep this row's current value; C) Investigate before choosing; D) Defer this proposed change only");
          expect(queue).toContain('does not defer its candidate or authorize a new schedule gate');
          expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
          expect(queue).toContain('Revising two candidates takes two rows');
          expect(queue).toContain('Hold stops for discussion without changing the prior disposition');
          expect(queue).toContain("check the assembled set's capacity and dependencies");
          expect(queue).toContain("A conflict returns to the affected candidate's Include/Defer/Cut/Hold row");
          expect(queue).toContain('retain prior answers, report unresolved conflicts and recheck before confirming the set');
          expect(queue).toContain('Never silently trim or replace another candidate');
          expect(queue).toContain('one row per call, record its actual answer and scope');
          expect(queue).toContain('then amend only that approved scope');
          expect(queue).toContain('Follow 0D Step 4');
          expect(queue).toContain('Update the saved rows and comparisons under 0D Step 3 before asking');
          const skeleton = readFileSync('plan-ceo-review/SKILL.md.tmpl', 'utf8');
          expect(skeleton).toContain('apply only approved amendments to the working plan before the next row');
          expect(queue).toContain('Keep preserves the current disposition; investigation and deferral do not authorize implementation');
          expect(queue).toContain('preserve authorized auto-decisions, the audit trail and User Challenge rules; challenges wait for the final gate');
          expect(queue).toContain('One answer does not resolve other pending rows');
          expect(queue).toContain('including findings that needed only factual correction');
          continue;
        }
        if (skillName === 'plan-eng-review') {
          expect(queue).toContain('Run every outside finding through the same Decision procedure and seven-column ledger above');
          expect(queue).toContain('Record the reviewer and evidence');
          expect(queue).not.toContain('reference | commitment | current value');
          expect(queue).toContain('Agreement between reviewers is evidence, not approval');
          expect(queue).toContain('new or reopened choices still need their own answers');
          expect(queue).toContain('four-option menus instead of the ordinary 2-3 options');
          expect(queue).toContain('Identify one independently answerable change before building its alternatives, then compare and save them as the Decision procedure requires');
          // The outside step delegates authority, saved comparisons and actual
          // answers to the one procedure already checked above, not a second gate.
          const procedure = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
          expect(procedure).toContain('Reopen an approved choice only for a concrete new risk, contradictory evidence or changed assumption');
          expect(procedure).toContain('Save the rows and options with Write or Edit before calling AskUserQuestion');
          expect(procedure).toContain('Record the actual selected option and answer, their reference and exact accepted scope');
          expect(procedure).toContain('Then apply only those amendments with a scoped Edit before taking the next row');
          expect(queue).toContain("A) Apply this change; B) Keep this row's current value; C) Investigate before choosing; D) Defer this proposed change only");
          expect(queue).toContain('does not defer its entire candidate or approve a new schedule gate');
          expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
          expect(queue).toContain('Revising two candidates takes two rows');
          expect(queue).toContain('Hold stops for discussion without changing the prior disposition');
          expect(queue).toContain("check the assembled set's capacity and dependencies");
          expect(queue).toContain("return to the affected candidate's Include/Defer/Cut/Hold row");
          expect(queue).toContain('preserve prior answers, report unresolved conflicts, and recheck the set before confirming it');
          expect(queue).toContain('Never silently trim or replace another candidate');
          expect(queue).toContain('Keep necessary code, tests and docs for one approved behavior together');
          expect(queue).toContain("An answer to one row does not resolve the finding's other pending rows");
          expect(queue).toContain("Preserve /autoplan's authorized auto-decisions, audit trail and User Challenge rules; challenges wait for its final gate");
          continue;
        }
        if (skillName === 'plan-devex-review') {
          expect(queue).toContain('same five-field working list and four-step Decision gate');
          expect(queue).not.toContain('reference | commitment | current value');
          const stages = ['1. **Ground the evidence.**', '2. **Classify the finding.**',
            '3. **Check the scope.**', '4. **Draft and answer one decision.**',
            'Use AskUserQuestion', 'Wait for the actual answer',
            'then use a scoped Edit for those amendments before taking the next row.']
            .map(stage => queue.indexOf(stage));
          expect(stages.every(position => position >= 0)).toBe(true);
          expect(stages).toEqual([...stages].sort((a, b) => a - b));
          expect(queue).toContain('Hold every other value fixed or pending in EVERY option');
          expect(queue).toContain('split independently selectable changes');
          expect(queue).toContain('Defer this proposed change only');
          expect(queue).toContain('does not defer its entire candidate or approve a new schedule gate');
          expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
          expect(queue).toContain('Revising two candidates takes two rows');
          expect(queue).toContain('Hold stops for discussion without changing the prior disposition');
          expect(queue).toContain("check the assembled set's capacity and dependencies");
          expect(queue).toContain("returns to the affected candidate's Include/Defer/Cut/Hold row");
          expect(queue).toContain('preserve prior answers, report unresolved conflicts, and recheck before confirming the set');
          expect(queue).toContain('Never silently trim or replace another candidate');
          expect(queue).toContain('Record its answer reference and exact accepted scope');
          expect(queue).toContain("An answer to one row does not resolve the finding's other pending rows");
          expect(queue).toContain('preserve its authorized auto-decisions, audit trail and User Challenge rules');
          expect(queue).toContain('challenges stay pending for the final gate');
          continue;
        }
        const stages = [
          '**1. Queue one changed commitment per row.**',
          '**2. Draft from one row.**',
          'Use AskUserQuestion.',
          '**3. Obtain the answer.**',
          '**4. Apply the answered row.**',
          'then use a scoped Edit for those amendments before taking the next row.',
        ].map(stage => queue.indexOf(stage));
        expect(stages.every(position => position >= 0)).toBe(true);
        expect(stages).toEqual([...stages].sort((a, b) => a - b));
        const text = queue.replace(/\s+/g, ' ');
        expect(text).toContain('reference | commitment | current value + approval reference | proposed value');
        expect(text).toContain('its reference is not the unit of approval');
        expect(text).toContain('an exhausted-job destination, an optional alert and a replay facility are separate commitments');
        expect(text).toContain('Code, tests and docs establishing that same chosen behavior stay together');
        expect(text).toContain('Hold every other commitment fixed or pending in EVERY option');
        expect(text).toContain('If an option changes another commitment, split it first');
        expect(text).toContain('Defer this proposed change only');
        expect(text).toContain('does not defer its entire candidate or approve a new schedule gate');
        expect(text).toContain('**Whole-candidate scope:** use A) Include; B) Defer; C) Cut; D) Hold');
        expect(text).toContain('Revising two candidates takes two rows, never a swap package');
        expect(text).toContain('Hold stops for discussion; it is not a final disposition');
        expect(text).toContain('preserve prior answers and report any blocking conflict unresolved');
        expect(text).toContain("validate the assembled set's capacity and dependencies");
        expect(text).toContain("a conflict returns to a named candidate's Include/Defer/Cut/Hold row");
        expect(text).toContain('Revalidate before confirming the set');
        expect(text).toContain('Record its answer reference and exact accepted scope');
        expect(text).toContain("one answer does not clear the finding's remaining changes");
        expect(text).toContain('Reopening requires concrete contradictory evidence or a changed assumption');
        expect(text).toContain('Retain unresolved risks and proof');
        expect(text).toContain('preserve its authorized auto-decision and User Challenge rules, audit trail and final gate');
        expect(text).toContain("User Challenges stay pending for /autoplan's final gate");
        expect(text).not.toContain('Cross-model disagreement on [topic]');
      }
    });
  }
});

describe('plan-review manual handoff selection', () => {
  test('selects the retained DX manual handoff over its separate implementation suggestion', () => {
    const labels = ['Run /plan-eng-review next (Recommended)', 'Ready to implement', 'Skip, handle manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps', 'D30 — Next steps: which review runs next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next steps', 'D30 — Next steps: which review runs next?'))).toBe(1);
  });
  test('accepts the retained paired-review short manual handoff by native position', () => {
    const labels = ['A: Run /plan-eng-review next (recommended)', 'B: Skip, handle manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next review', 'D10 — Which review runs next?'))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next review', 'D10 — Which review runs next?'))).toBe(1);
  });
  test('short manual handoff requires a recognized offer and excludes extra actions', () => {
    const run = 'Run /plan-eng-review';
    const skip = 'Skip, handle manually';
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior', skip]))).toBe(1);
    expect(pickPlanReviewQuestion(menu([run, skip], 'Tests', 'D8 — Should the test run a review?'))).toBe(1);
    for (const extra of [' and approve all edits', '; run /ship', ' after implementation']) {
      expect(() => pickPlanReviewQuestion(menu([run, skip + extra]))).toThrow('unambiguous');
    }
    for (const extra of [skip, 'Skip', 'Ship immediately']) {
      expect(() => pickPlanReviewQuestion(menu([run, skip, extra]))).toThrow('unambiguous');
    }
  });
  test('declines the actual colon-labelled CEO handoff by native position', () => {
    const labels = ['A: run /plan-eng-review next (recommended)', 'C: skip, handle reviews manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next review',
      'D13 — Which review should run next on this plan?'))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next review',
      'D13 — Which review should run next on this plan?'))).toBe(1);
  });
  test('colon labels do not broaden handoff authority or accept extra actions', () => {
    const labels = ['A: Run /plan-eng-review', 'C: Skip, handle reviews manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Tests', 'D8 — Should the test run a review?'))).toBe(1);
    for (const extra of [' and approve all edits', '; run /ship', ' after implementation']) {
      expect(() => pickPlanReviewQuestion(menu([labels[0]!, labels[1]! + extra])))
        .toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([...labels, 'D: Skip, handle reviews manually'])))
      .toThrow('unambiguous');
  });
  test('declines the retained native two-option next-review offer', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip — handle reviews manually']))).toBe(2);
  });
  test('selects the retained Engineering readiness offer by its native position', () => {
    const labels = ['C) Ready to implement (recommended)', 'B) Run /plan-ceo-review'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps',
      'Next steps: any further review before implementation?'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next steps',
      'Next steps: any further review before implementation?'))).toBe(2);
  });
  test('selects readiness from the retained Engineering review-first handoff', () => {
    const labels = ['C: Ready to implement — run /ship when done (recommended)', 'B: Run /plan-ceo-review first'];
    const question = 'D17 — Eng review is CLEARED. Chain another review, or proceed to implementation?';
    expect(pickPlanReviewQuestion(menu(labels, 'Next step', question))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next step', question))).toBe(2);
  });
  test('review-first recognition preserves manual precedence and question context', () => {
    const labels = ['Run /plan-ceo-review first (recommended)', 'Ready to implement', 'Skip — handle reviews manually'];
    expect(pickPlanReviewQuestion(menu(labels))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed()))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels, 'Tests', 'D4 — Should this test run a review?'))).toBe(1);
  });
  test.each([
    'Run /plan-ceo-review firstly',
    'Run /plan-ceo-review first next',
    'Run /plan-ceo-review first and approve all edits',
    'Run /plan-ceo-review first; run /ship',
    'Run /plan-unknown-review first',
    'Run /design-shotgun first',
  ])('review-first handoffs reject unknown or extended run labels: %s', label => {
    expect(() => pickPlanReviewQuestion(menu([label, 'Ready to implement — run /ship when done'])))
      .toThrow('unambiguous');
  });
  test.each([
    ['Run /plan-ceo-review', 'Ready to implement now'],
    ['Run /plan-ceo-review', 'Ready to implement and approve all edits'],
    ['Run /plan-ceo-review', 'Ready to implement; run /ship'],
    ['Ready to implement', 'Ready to implement — run /ship when done'],
  ])('rejects added execution authority or ambiguous readiness: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('selects the source-prescribed manual choice after both applicable reviews', () => {
    expect(pickPlanReviewQuestion(menu([
      'A) Run /plan-eng-review next (required gate) (Recommended)',
      'B) Run /plan-design-review next', "C) Skip — I'll handle reviews manually",
    ]))).toBe(3);
  });
  test('recognizes a full next-step brief without depending on its D ordinal', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip – I’ll handle reviews manually'],
      'Handoff', "D24 — What's next?\nProject: payment review\nRecommendation: A"))).toBe(2);
  });
  test.each([
    ['ceo', 3], ['design', 5], ['devex', 4], ['eng', 3],
  ] as const)('supports every current %s review source handoff option', (skill, selected) => {
    const source = readFileSync(`plan-${skill}-review/sections/review-sections.md.tmpl`, 'utf8');
    const block = source.match(/Use AskUserQuestion (?:to present the next step\. Include only applicable options:|with (?:only the )?applicable options:)\n((?:- \*\*[A-E]\)\*\* .+\n)+)/)![1]!;
    const labels = block.trim().split('\n').map(line => line.replace(/^- \*\*([A-E]\))\*\* /, '$1 '));
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps'))).toBe(selected);
    // Native dialogs allow at most four choices. Each applicable source subset
    // keeps its explicit non-running handoff; no absent choice is fabricated.
    for (let i = 0; i < selected - 1; i++) {
      expect(pickPlanReviewQuestion(menu([labels[i]!, labels[selected - 1]!]))).toBe(2);
    }
  });
  test('manual handoff takes precedence over a separate future implementation suggestion', () => {
    expect(pickPlanReviewQuestion(menu([
      'Run /plan-eng-review', 'Ready to implement, run /devex-review after shipping',
      "Skip, I'll handle next steps manually",
    ]))).toBe(3);
  });
  test('does not change ordinary findings, TODOs, mode choice, or prerequisite answers', () => {
    for (const header of ['Security', 'TODO', 'Mode', 'Office hours']) {
      expect(pickPlanReviewQuestion(menu(['Keep the current design', 'Skip — handle reviews manually'], header, 'D4 — Decide this issue'))).toBe(1);
    }
  });
  test('does not elect a skip from an unrelated question mentioning review commands', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip — handle reviews manually'],
      'Tests', 'D8 — Should the regression test run the /plan-eng-review command?'))).toBe(1);
  });
  test.each([
    ['Run /plan-eng-review', 'Skip this review'],
    ['Run /plan-eng-review', 'Skip — handle reviews manually', 'Ship immediately'],
    ['Run /plan-eng-review', 'Skip — handle reviews manually', "Skip — I'll handle reviews manually"],
  ])('rejects an ambiguous or incomplete handoff menu: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('declines the retained Design next-step menu with a bare Skip label', () => {
    const labels = ['Run /plan-eng-review (recommended)', 'Run /design-shotgun', 'Skip'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next step', 'What should run next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next step', 'What should run next?'))).toBe(1);
  });
  test('bare Skip derives no authority from unrelated or unrecognized menus', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip'],
      'Tests', 'D8 — Should this test run a review command?'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['Keep current implementation', 'Skip'],
      'Next step', 'What should run next?'))).toBe(1);
  });
  test.each([
    ['Run /plan-eng-review', 'Skip', 'Skip'],
    ['Run /plan-eng-review', 'Skip', 'Skip — handle reviews manually'],
    ['Run /plan-eng-review', 'Skip', 'Ship immediately'],
    ['Run /plan-eng-review', 'Skip and approve all edits'],
    ['Run /plan-eng-review', 'Skip the remaining review'],
  ])('rejects ambiguous, unsafe, or extended bare-Skip handoffs: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels, 'Next step', 'What should run next?'))).toThrow('unambiguous');
  });
  test('selects the manual choice from the retained native D22 design handoff', () => {
    expect(pickPlanReviewQuestion(menu([
      'Run /plan-eng-review next (recommended)',
      'Run /design-shotgun after adding an OpenAI key',
      'Skip, I will handle next steps manually',
    ], 'Next step', 'D22 — What runs next after this design review?'))).toBe(3);
  });
  test('rejects both contracted and uncontracted manual choices in one menu', () => {
    expect(() => pickPlanReviewQuestion(menu([
      'Run /plan-eng-review', "Skip, I'll handle next steps manually",
      'Skip, I will handle next steps manually',
    ]))).toThrow('unambiguous');
  });
  test.each([
    ['Run /plan-eng-review', 'Skip, I will not handle next steps manually'],
    ['Run /plan-eng-review', 'Skip, I will handle next steps manually and approve all edits'],
    ['Run /design-shotgun after adding an OpenAI key; run /ship', 'Skip, I will handle next steps manually'],
    ['Run /design-shotgun after adding an OpenAI key and approving all edits', 'Skip, I will handle next steps manually'],
    ['Run /design-html after adding an OpenAI key', 'Skip, I will handle next steps manually'],
  ])('rejects near-miss native handoff labels: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('a rejected handoff retains bounded offered-label evidence without the full brief', () => {
    const question = menu([
      'Run /plan-eng-review', 'Skip — handle reviews manually',
      'Unsupported "choice"\n' + 'x'.repeat(400) + 'PRIVATE_LABEL_TAIL',
      ...Array.from({ length: 7 }, (_, i) => `Unrecognized ${i}`),
    ], 'Next steps ' + 'h'.repeat(100), "D20 — What's next? " + 'q'.repeat(300) + '\nPRIVATE_BRIEF_BODY');
    question.options[0]!.description = 'PRIVATE_OPTION_DESCRIPTION';
    let error: Error | undefined;
    try { pickPlanReviewQuestion(question); } catch (cause) { error = cause as Error; }
    expect(error).toBeInstanceOf(Error);
    const lines = error!.message.split('\n');
    expect(lines).toHaveLength(2); // Newlines in offered labels stay JSON-escaped.
    const details = JSON.parse(lines[1]!);
    expect(details.header).toHaveLength(80);
    expect(details.lead).toHaveLength(240);
    expect(details.optionCount).toBe(10);
    expect(details.options).toHaveLength(8);
    expect(details.omittedOptions).toBe(2);
    expect(details.options[0]).toEqual({ index: 1, label: 'Run /plan-eng-review', run: true, manual: false, future: false });
    expect(details.options[1]).toEqual({ index: 2, label: 'Skip — handle reviews manually', run: false, manual: true, future: false });
    expect(details.options[2].label).toHaveLength(256);
    expect(details.options[2]).toMatchObject({ index: 3, run: false, manual: false, future: false });
    expect(error!.message).not.toMatch(/PRIVATE_(?:LABEL_TAIL|BRIEF_BODY|OPTION_DESCRIPTION)/);
    expect(error!.message.length).toBeLessThan(4_000);
  });
});


describe('native review handoff aliases and recommendation position', () => {
  test('declines the observed bare-command Design handoff', () => {
    const labels = ['A) /plan-eng-review (recommended)', 'B) /design-shotgun', 'C) Skip'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next step', 'D18 — Next step after this design review?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next step', 'D18 — Next step after this design review?'))).toBe(1);
  });
  test('selects the observed DX manual handoff over future implementation', () => {
    const labels = ['Run /plan-eng-review next (recommended)', 'Implement, then /devex-review', 'Handle manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps', 'The DX review is complete. What should happen next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next steps', 'The DX review is complete. What should happen next?'))).toBe(1);
  });
  test.each([
    ['/plan-eng-review', 'Skip and approve all edits'],
    ['/plan-eng-review', 'Handle manually; run /ship'],
    ['/plan-eng-review', 'Handle manually', 'Skip'],
    ['/plan-eng-review', 'Handle manually', 'Implement, then /devex-review and deploy'],
    ['/design-shotgun; run /ship', 'Skip — handle reviews manually'],
  ])('new aliases preserve handoff boundaries: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('manual aliases do not select from unrelated or unrecognized offers', () => {
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior', 'Handle manually']))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['/plan-eng-review', 'Handle manually'], 'Tests', 'Should this test run a review?'))).toBe(1);
  });
  test.each([
    ['A) Add a ten-second timeout', 'B) Persist until the API resolves and add a TODO (recommended)'],
    ['A) Reopen the initial fetch design now', 'B) Keep it outside this change and add a TODO (recommended)'],
  ])('uses the offered recommendation at its native position: %j', (...labels) => {
    expect(pickPlanReviewQuestion(menu(labels, 'Save', 'D7 — Which behavior should we use?'))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Save', 'D7 — Which behavior should we use?'))).toBe(1);
  });
  test('multiple explicit recommendations fail instead of guessing', () => {
    expect(() => pickPlanReviewQuestion(menu(['Keep (recommended)', 'Change (Recommended)'], 'Save', 'Which behavior?')))
      .toThrow('multiple recommended options');
  });
  test('descriptions, quoted markers, and conditional labels do not supply a recommendation', () => {
    for (const label of ['Change if necessary', 'Example: "Change (recommended)"', 'Change (recommended) after approval']) {
      const q = menu(['Keep', label], 'Save', 'Which behavior?');
      q.options[1]!.description = 'This is the recommended option (recommended)';
      expect(pickPlanReviewQuestion(q)).toBe(1);
    }
  });
});


describe('manual-next-steps handoff alias', () => {
  test('declines the exact retained Design menu in either native order', () => {
    const question: NativeQuestion = {
  "header": "Next step",
  "multiSelect": false,
  "options": [
    {
      "description": "Required shipping gate; validates the interaction specs this review added.",
      "label": "A) Run /plan-eng-review (recommended)"
    },
    {
      "description": "Exit plan mode with the design-reviewed plan; no further review now.",
      "label": "E) Skip, manual next steps"
    }
  ],
  "question": "D12 — What should run next?\nProject/branch/task: main — Settings redesign plan is design-complete (5/10 → 9/10, 7 decisions, 0 unresolved).\nELI10: The design review is done and written into the plan. Before anyone builds it, gstack's shipping gate wants an engineering review of the same plan: it checks that the token scoping, the aria-disabled click guard, the min-width lock, and the 14px audit are technically sound and testable. A CEO review is not warranted: the plan's product direction was never in question. Design exploration skills need a keyed designer, which this environment lacks.\nStakes if we pick wrong: skipping eng review means /ship will report NOT CLEARED later; running it now costs one more review pass.\nRecommendation: A because eng review is the only review that gates shipping, and this design review added interaction specs (busy-button semantics, token ownership) that need an architectural check.\nNote: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Run /plan-eng-review next (recommended)\n  ✅ Clears the required gate while the seven decisions are fresh in the plan\n  ✅ Validates aria-disabled guard, min-width lock, and Settings-scoped token ownership\n  ❌ One more interactive review session before implementation begins\nE) Skip, handle next steps manually\n  ✅ Start implementing T1-T7 immediately from the plan\n  ✅ No further review questions today\n  ❌ /ship will report NOT CLEARED until an eng review runs\nNet: clear the gate now or defer it to ship time."
};
    expect(pickPlanReviewQuestion(question)).toBe(2);
    expect(pickPlanReviewQuestion({ ...question, options: question.options.toReversed() })).toBe(1);
  });
  test('keeps manual preference and requires recognized next-review context', () => {
    const skip = 'E) Skip, manual next steps';
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Ready to implement', skip], 'Next step', 'What should run next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior', skip], 'Next step', 'What should run next?'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review (recommended)', skip], 'Tests', 'D8 — Should this test run a review?'))).toBe(1);
  });
  test.each([
    'Skip, automated next steps',
    'Skip, manual next steps and approve all edits',
    'Skip, manual next steps; run /ship',
    'Skip, manual next steps after implementation',
    'Skip, manual next steps (automatically)',
    'Skip, manual next steps then deploy',
  ])('rejects an automation or extended lookalike: %s', (label) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review', label], 'Next step', 'What should run next?'))).toThrow('unambiguous');
  });
  test.each([
    ['Skip, manual next steps', 'Skip, manual next steps'],
    ['Skip, manual next steps', 'Handle manually'],
    ['Skip, manual next steps', 'Ship immediately'],
  ])('keeps ambiguous or unsafe menus refused: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review', ...labels], 'Next step', 'What should run next?'))).toThrow('unambiguous');
  });
});


describe('DX implement-now future handoff alias', () => {
  test('declines the exact retained DX future-alias menu in either native order', () => {
    const question: NativeQuestion = {
  "header": "Next review",
  "multiSelect": false,
  "options": [
    {
      "description": "Architecture and test review of the amended plan; clears the required ship gate.",
      "label": "Run /plan-eng-review next (recommended)"
    },
    {
      "description": "Start on T1-T9; measure real TTHW with the boomerang after shipping.",
      "label": "Implement now, /devex-review after"
    },
    {
      "description": "End here; no next review scheduled.",
      "label": "Skip, handle manually"
    }
  ],
  "question": "D17 — DX review complete. Which review runs next?\nProject/branch/task: main branch; eval-sdk public beta plan, DX review CLEAR (7/10 → 8/10), 16 decisions logged, zero unresolved.\nELI10: This review changed the plan in ways that touch code: the first-run gate is decoupled in two entrypoints, a new explicit conformance command appears, and five release checks are added. Those are architecture and test decisions, and Eng Review is the one gate that must be clear before shipping. The dashboard shows Eng Review at zero runs, so the verdict is NOT CLEARED. No end-user UI is in scope, so Design Review does not apply. After implementation, /devex-review on the shipped beta is the boomerang that measures whether the 5-minute target held in reality.\nStakes if we pick wrong: skip Eng Review and the gate decoupling ships without an architecture pass on state handling and release-check design; run it and the plan gets validated where the DX changes are riskiest.\nRecommendation: A because the DX changes T1, T2, and T6 are code and test changes that Eng Review exists to validate, and the ship gate requires it anyway.\nNote: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Run /plan-eng-review next (required gate) (recommended)\n  ✅ Validates the gate decoupling, conformance command, and release-check design before any code is written (human: ~30 min / CC: ~10 min)\n  ✅ Clears the only review the ship dashboard requires\n  ❌ Adds a review cycle before implementation starts\nB) Ready to implement; run /devex-review after shipping\n  ✅ Fastest path to code; nine tasks are already specified with verification steps\n  ✅ The post-ship boomerang still measures the real TTHW against the 5-minute target\n  ❌ Ship dashboard stays NOT CLEARED until Eng Review runs on the diff instead of the plan\nC) Skip, I'll handle next steps manually\n  ✅ You keep full control of sequencing\n  ✅ Nothing else runs automatically\n  ❌ No review is scheduled; the required gate is still open\nNet: A clears the required gate on the plan; B defers it to the diff; C leaves it to you."
};
    expect(pickPlanReviewQuestion(question)).toBe(3);
    expect(pickPlanReviewQuestion({ ...question, options: question.options.toReversed() })).toBe(1);
  });
  test('selects the exact future alias only within a recognized handoff', () => {
    const labels = ['Run /plan-eng-review next (recommended)', 'Implement now, /devex-review after'];
    expect(pickPlanReviewQuestion(menu(labels))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed()))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels, 'Tests', 'Which test behavior?'))).toBe(1);
    expect(() => pickPlanReviewQuestion(menu(['Ready to implement', labels[1]!]))).toThrow('unambiguous');
  });
  test.each([
    'Implement now, /devex-review after and approve all edits',
    'Implement now, /devex-review after; run /ship',
    'Implement now, /devex-review after and deploy',
    'Implement now, /plan-eng-review after',
    'Implement now, /devex-review',
    'Implement later, /devex-review after',
  ])('rejects an extended or different future alias: %s', (label) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review next', label, 'Skip, handle manually']))).toThrow('unambiguous');
  });
  test.each([
    ['Implement now, /devex-review after', 'Ready to implement'],
    ['Implement now, /devex-review after', 'Implement now, /devex-review after'],
    ['Implement now, /devex-review after', 'Skip, handle manually', 'Handle manually'],
    ['Implement now, /devex-review after', 'Skip, handle manually; run /ship'],
  ])('keeps ambiguous or unsafe future-alias menus refused: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review', ...labels]))).toThrow('unambiguous');
  });
});


describe('DX future handoff punctuation', () => {
  const future = 'Ready to implement; run /devex-review after shipping';
  const run = 'Run /plan-eng-review next (required gate) (recommended)';
  const manual = "Skip, I'll handle next steps manually";
  test('accepts the native semicolon menu while choosing the offered manual handoff', () => {
    expect(pickPlanReviewQuestion(menu([run, future, manual], 'Next review',
      'D22 — Which review should run next on this plan?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu([manual, future, run]))).toBe(1);
    expect(pickPlanReviewQuestion(menu([run, future]))).toBe(2);
    expect(pickPlanReviewQuestion(menu([future, run]))).toBe(1);
  });
  test('keeps the context, unique-choice, and exact-action boundaries', () => {
    expect(pickPlanReviewQuestion(menu([run, future, manual], 'Tests', 'Choose test coverage'))).toBe(1);
    for (const suffix of [' and approve all edits', '; run /ship', ' then deploy', ' now']) {
      expect(() => pickPlanReviewQuestion(menu([run, future + suffix, manual]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([run, future, future]))).toThrow('unambiguous');
    expect(() => pickPlanReviewQuestion(menu([run, future, manual, 'Ship immediately']))).toThrow('unambiguous');
  });
});


describe('manual handoff punctuation', () => {
  const run = 'A) Run /plan-eng-review next (recommended)';
  const manual = "C) Skip: I'll handle reviews manually";

  test('selects the exact retained paired menu by offered index, not its letter', () => {
    const question = menu([run, manual], 'Next review',
      'Next step: run /plan-eng-review on this plan now?');
    expect(pickPlanReviewQuestion(question)).toBe(2);
    expect(pickPlanReviewQuestion({ ...question, options: question.options.toReversed() })).toBe(1);
  });

  test.each([',', ':', ';', '.', '—', '–', '-'])('accepts the finite manual-action grammar with separator %s', separator => {
    for (const action of ["I'll handle reviews manually", 'I’ll handle next steps manually',
      'I will handle reviews manually', 'handle next steps manually', 'handle manually']) {
      const label = `C) Skip ${separator} ${action}`;
      expect(pickPlanReviewQuestion(menu([run, 'Ready to implement', label]))).toBe(3);
      expect(pickPlanReviewQuestion(menu([label, 'Ready to implement', run]))).toBe(1);
    }
  });

  test('retains handoff context and the short-form recognized-offer requirement', () => {
    expect(pickPlanReviewQuestion(menu([run, manual], 'Tests', 'Choose regression coverage'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior (recommended)', 'Skip: handle manually']))).toBe(1);
    expect(pickPlanReviewQuestion(menu([run, 'Skip: handle manually']))).toBe(2);
  });

  test.each([
    "Skip: I won't handle reviews manually",
    'Skip: I will not handle reviews manually',
    "Skip: I'll handle reviews automatically",
    "Skip: I'll handle reviews manually and approve all edits",
    "Skip: I'll handle reviews manually; run /ship",
    "Skip: I'll handle reviews manually then deploy",
    "Maybe Skip: I'll handle reviews manually",
    "Skip:: I'll handle reviews manually",
    "Skip/ I'll handle reviews manually",
  ])('refuses changed or extended manual intent: %s', label => {
    expect(() => pickPlanReviewQuestion(menu([run, label]))).toThrow('unambiguous');
  });

  test('refuses duplicate manual choices and unknown additional actions', () => {
    for (const extra of [manual, "Skip — I'll handle reviews manually", 'Handle manually', 'Ship immediately']) {
      expect(() => pickPlanReviewQuestion(menu([run, manual, extra]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([run + '; run /ship', manual]))).toThrow('unambiguous');
  });
});


describe('Design native handoff formatting', () => {
  // Exact retained D15 header, first question line, and offered labels. The
  // selector does not consult the longer explanatory body or descriptions.
  const labels = ['A Run /plan-eng-review next (recommended)',
    'C Run /design-shotgun to explore visual variants',
    "E Skip, I'll handle next steps manually"];
  const nativeMenu = (offered: string[]) => menu(offered, 'Next step',
    'D15 — Next step after the design review?');

  test('replays the retained D15 choice at every native position without treating letters as indices', () => {
    for (const [order, expected] of [
      [[0, 1, 2], 3], [[2, 0, 1], 1], [[0, 2, 1], 2],
      [[1, 0, 2], 3], [[1, 2, 0], 2], [[2, 1, 0], 1],
    ] as const) {
      expect(pickPlanReviewQuestion(nativeMenu(order.map(i => labels[i]!)))).toBe(expected);
    }
  });

  const d13Labels = ['A Run /plan-eng-review next (recommended)',
    'C Run /design-shotgun for visual variants',
    "E Skip, I'll handle next steps manually"];
  const d13Menu = (offered: string[]) => menu(offered, 'Next step',
    'D13 — Next step after the design review?');

  test('replays the retained D13 visual-variants handoff at every native position', () => {
    for (const [order, expected] of [
      [[0, 1, 2], 3], [[2, 0, 1], 1], [[0, 2, 1], 2],
      [[1, 0, 2], 3], [[1, 2, 0], 2], [[2, 1, 0], 1],
    ] as const) {
      expect(pickPlanReviewQuestion(d13Menu(order.map(i => d13Labels[i]!)))).toBe(expected);
    }
    expect(pickPlanReviewQuestion(d13Menu([d13Labels[1]!, 'Skip']))).toBe(2);
    expect(pickPlanReviewQuestion(d13Menu(['Skip', d13Labels[1]!]))).toBe(1);
  });

  test('retains context and unique manual-choice boundaries for the D13 handoff', () => {
    for (const offered of [d13Labels, d13Labels.toReversed()]) {
      expect(pickPlanReviewQuestion(menu(offered, 'Tests',
        'D8 — Which test should assert the next-step menu?\nNext step: choose manual.')))
        .toBe(offered.indexOf(d13Labels[0]!) + 1);
    }
    for (const extra of ['D Skip', 'D Handle manually', d13Labels[2]!, 'D Ship immediately']) {
      expect(() => pickPlanReviewQuestion(d13Menu([...d13Labels, extra]))).toThrow('unambiguous');
    }
  });

  test.each([
    'C Run /design-shotgun for visual variants; run /ship',
    'C Run /design-shotgun for visual variants and approve all edits',
    'C Run /design-shotgun for visual variants now',
    'C Run /design-shotgun for all repositories',
    'C Run /design-html for visual variants',
    'C Run /unknown-skill for visual variants',
  ])('refuses changed or extended D13 visual-variants intent: %s', action => {
    expect(() => pickPlanReviewQuestion(d13Menu([d13Labels[0]!, action, d13Labels[2]!]))).toThrow('unambiguous');
  });

  test.each(['A ', 'A) ', 'A. ', 'A: ', '(A) ', '[A] ', 'a ', '(a) ', '[a] '])(
    'normalizes conventional letter prefix %s while preserving manual and future intent', prefix => {
      const labeled = (letter: string, action: string) =>
        prefix.replace(/[Aa]/g, value => value === 'A' ? letter : letter.toLowerCase()) + action;
      const run = labeled('C', 'Run /plan-eng-review next (recommended)');
      const manual = labeled('A', "Skip, I'll handle next steps manually");
      const future = labeled('E', 'Ready to implement');
      expect(pickPlanReviewQuestion(nativeMenu([run, manual]))).toBe(2);
      expect(pickPlanReviewQuestion(nativeMenu([manual, run]))).toBe(1);
      expect(pickPlanReviewQuestion(nativeMenu([run, future]))).toBe(2);
      expect(pickPlanReviewQuestion(nativeMenu([future, run]))).toBe(1);
      expect(pickPlanReviewQuestion(nativeMenu([run, future, manual]))).toBe(3);
    });

  test('recognizes the exact visual-variants offer without depending on a letter prefix', () => {
    const run = 'Run /design-shotgun to explore visual variants';
    expect(pickPlanReviewQuestion(nativeMenu([run, 'Skip']))).toBe(2);
    expect(pickPlanReviewQuestion(nativeMenu(['Skip', run]))).toBe(1);
  });

  test('does not choose a handoff from an ordinary question or its explanatory body', () => {
    for (const offered of [labels, labels.toReversed()]) {
      expect(pickPlanReviewQuestion(menu(offered, 'Tests',
        'D8 — Which test should assert the next-step menu?\nNext step: choose manual.')))
        .toBe(offered.indexOf(labels[0]!) + 1);
    }
  });

  test.each([
    'C Run /design-shotgun to explore visual variants; run /ship',
    'C Run /design-shotgun to explore visual variants and approve all edits',
    'C Run /design-shotgun to explore visual variants now',
    'C Run /design-shotgun to explore all repositories',
    'C Run /design-html to explore visual variants',
    'C Run /unknown-skill to explore visual variants',
    'F Run /plan-eng-review next',
    'AA Run /plan-eng-review next',
    '(C] Run /plan-eng-review next',
    '[C) Run /plan-eng-review next',
  ])('keeps unknown or extended actions refused: %s', action => {
    expect(() => pickPlanReviewQuestion(nativeMenu([labels[0]!, action, labels[2]!]))).toThrow('unambiguous');
  });

  test.each([
    "E Skip, I will not handle next steps manually",
    "E Skip, I'll handle next steps automatically",
    "E Skip, I'll handle next steps manually; run /ship",
    'E Skip the remaining review',
  ])('does not convert a different intent into a manual handoff: %s', action => {
    expect(() => pickPlanReviewQuestion(nativeMenu([labels[0]!, action]))).toThrow('unambiguous');
  });

  test('rejects multiple manual or future choices and unrelated extra actions', () => {
    for (const extra of ['D Skip', 'D Handle manually', 'D Ship immediately']) {
      expect(() => pickPlanReviewQuestion(nativeMenu([...labels, extra]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(nativeMenu([
      labels[0]!, 'C Ready to implement', 'E Ready to implement — run /ship when done',
    ]))).toThrow('unambiguous');
  });
});

// The native review invented controls from a section name, then reopened an
// accepted treatment. This guards the instructions, not model compliance.
test('Design decision register grounds new items before offering design choices', () => {
  const template = readFileSync('plan-design-review/sections/review-sections.md.tmpl', 'utf8');
  const register = template.split('### Pass 7: Unresolved Design Decisions')[1]!.split('### Post-Pass:')[0]!;
  const grounding = register.indexOf('cite an actual in-scope element');
  expect(grounding).toBeGreaterThan(0);
  expect(grounding).toBeLessThan(register.indexOf('Each decision = one AskUserQuestion'));
  expect(register).toContain('Page/section names and outside-review suggestions do not establish that a control exists');
  expect(register).toContain('if its existence is unknown, keep the item conditional');
  expect(register).toContain('Do not invent controls or reopen accepted treatments for a hypothetical element');
  expect(register).toContain('Surface real missing decisions and concrete conflicts');
});
