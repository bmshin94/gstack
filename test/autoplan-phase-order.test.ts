/**
 * /autoplan phase-order pin (free, static).
 *
 * The pipeline order is a deliberate design decision (2026-08-25, user-directed):
 * CEO → Design (if UI scope) → DX (if developer-facing scope) → Eng, ALWAYS LAST.
 * Eng is the required shipping gate — it must review the FINAL amended plan, so
 * every other phase's amendments land before it. The original order buried Eng
 * mid-pipeline (CEO → Design → Eng → DX), which let DX findings land AFTER the
 * gate had signed off — the gate validated a stale plan.
 *
 * These assertions pin the template so a refactor can't silently restore the
 * old order. The paid chain E2E (skill-e2e-autoplan-chain.test.ts) verifies the
 * runtime behavior; this pins the source of truth for free on every PR.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'node:os';
import { prepareMethodology, createSnapshot, preparePhaseClose } from '../bin/gstack-autoplan-snapshot';

const ROOT = path.join(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const phases = [
  { child: 'ceo', id: '1', next: ['2'] },
  { child: 'design', id: '2', next: ['2.5', '3'] },
  { child: 'dx', id: '2.5', next: ['3'] },
  { child: 'eng', id: '3', next: ['4'] },
];

// Exercise the actual close renderer; the shared section now delegates its
// publication to this packet instead of carrying a separate copied template.
const closePackets = new Map<string, string>();
function closeContent(phase: string) {
  if (closePackets.has(phase)) return closePackets.get(phase)!;
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-order-'));
  try {
    const active = path.join(dir, 'active.md'), restore = path.join(dir, 'restore.md');
    const original = '## Implementation plan\nKeep the documented behavior.\n## Review record\n';
    fs.writeFileSync(active, original); fs.writeFileSync(restore, original);
    const skill = `plan-${phase === 'dx' ? 'devex' : phase}-review/SKILL.md`;
    const method = prepareMethodology(phase, path.join(ROOT, skill), restore).methodologyPath;
    const checkpoint = createSnapshot(phase, active, restore, method).snapshotPath;
    fs.appendFileSync(active, `<!-- autoplan-accepted:${phase} -->\nNone: current behavior is retained.\n<!-- /autoplan-accepted:${phase} -->\n`);
    const packet = preparePhaseClose(phase, active, checkpoint, restore, method);
    const text = fs.readFileSync(packet.closePacketPath, 'utf8');
    closePackets.set(phase, text); return text;
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

describe('autoplan phase order (Eng always last)', () => {
  const tmpl = read('autoplan/SKILL.md.tmpl');

  test('Sequential Execution block names Eng as the terminal phase', () => {
    const block = tmpl.split('## Sequential Execution')[1]?.split('---')[0] ?? '';
    expect(block).toContain('Eng runs LAST, always');
    expect(block).toMatch(/CEO → Design.*→ DX.*→ Eng/s);
    // The old order must not resurface anywhere in the template.
    expect(tmpl).not.toContain('CEO → Design → Eng → DX');
  });

  test('phase headings appear in the new order: 1, 2, 2.5, 3', () => {
    const idx = (h: string) => {
      const i = tmpl.indexOf(h);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const p1 = idx('## Phase 1: CEO Review');
    const p2 = idx('## Phase 2: Design Review');
    const p25 = idx('## Phase 2.5: DX Review');
    const p3 = idx('## Phase 3: Eng Review');
    expect(p1).toBeLessThan(p2);
    expect(p2).toBeLessThan(p25);
    expect(p25).toBeLessThan(p3);
    // No stale Phase 3.5 heading or transition marker survives.
    expect(tmpl).not.toContain('Phase 3.5');
  });

  test.each(phases)('carved child completion and handoff IDs match the pipeline: %j', ({ child, id, next }) => {
    const section = read(`autoplan/sections/${child}-phase.md.tmpl`);
    const shared = closeContent(child);
    const announced = [...shared.matchAll(/\*\*Phase ([\d.]+) complete\.\*\*/g)].map(match => match[1]);
    const handoff = shared.split('Passing to ')[1]?.split('\n')[0] ?? '';
    expect(section.trim().endsWith('{{SECTION:phase-close}}')).toBe(true);
    const pointer = section.indexOf('{{SECTION:phase-close}}');
    expect(pointer).toBeGreaterThan(section.indexOf('**Close this phase:**'));
    expect(section.slice(pointer).trim()).toBe('{{SECTION:phase-close}}');
    const generated = read(`autoplan/sections/${child}-phase.md`);
    expect(generated).toContain('Read `~/.claude/skills/gstack/autoplan/sections/phase-close.md` and execute it');
    expect(announced).toEqual([id]);
    expect([...handoff.matchAll(/Phase (\d+(?:\.\d+)?)/g)].map(m => m[1])).toEqual(next);
    // Catch obsolete Phase 3.5 references anywhere in any carved child,
    // including prose or prompts that could contradict otherwise-correct headings.
    const known = new Set(['0', '0.5', '1', '2', '2.5', '3', '4']);
    const mentioned = [...section.matchAll(/\bPhase (\d+(?:\.\d+)?)\b/gi)].map(m => m[1]);
    expect(mentioned.filter(id => !known.has(id))).toEqual([]);
  });

  test('each later Codex voice receives only already-completed phase context', () => {
    const dx = read('autoplan/sections/dx-phase.md.tmpl');
    const priorContext = [...dx.matchAll(/^\s*(CEO|Design|Eng|DX): <insert /gm)].map(m => m[1]);
    expect(priorContext).toEqual(['CEO', 'Design']);
    // Eng's Codex voice sees every prior phase's consensus, DX included.
    expect(read('autoplan/sections/eng-phase.md.tmpl')).toContain(
      'DX: <insert DX consensus table summary',
    );
  });

  test('single final gate: premises queue for the gate, never a mid-run stop', () => {
    expect(tmpl).toContain('Never auto-decide User Challenges');
    expect(tmpl.replace(/\s+/g, ' ')).toContain('or a premise is clearly wrong. Queue them for the Final Approval Gate, never mid-run stops');
    expect(tmpl).not.toContain('Premise gate passed (user confirmed)');
    const ceo = read('autoplan/sections/ceo-phase.md.tmpl');
    expect(ceo).not.toContain('GATE: Present premises to user for confirmation');
    expect(ceo).toContain('Queue clearly-wrong/challenged premises');
    expect(ceo).toContain('as User Challenges for Phase 4');
    expect(ceo).toContain('The user decides there; never stop mid-pipeline');
  });

  test('generated workflow loads each complete skill at its own phase boundary', () => {
    const skill = read('autoplan/SKILL.md');
    const phase0 = skill.slice(skill.indexOf('### Step 3:'), skill.indexOf('## Phase 1:'));
    const setup = phase0.split('**Section skip list')[0]!;
    expect(setup).toContain('Resolve this phase');
    expect(setup).toContain('Do not prefetch future phase sections or review skills');
    expect(setup).toContain('Missing skill: report the\nmissing phase and setup repair');
    expect(setup).toContain('Read each at its trigger');
    // Locating paths at intake does not load or execute their future phases.
    expect(setup).not.toMatch(/^Read `[^`]+\/SKILL\.md` in full now/gm);

    const owners = [
      { id: '1', name: 'ceo', next: '## Phase 2:' },
      { id: '2', name: 'design', next: '## Phase 2.5:' },
      { id: '2.5', name: 'devex', next: '## Phase 3:' },
      { id: '3', name: 'eng', next: '## Decision Audit Trail' },
    ];
    for (const { id, name, next } of owners) {
      const start = skill.indexOf(`## Phase ${id}:`);
      const end = skill.indexOf(next, start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = skill.slice(start, end);
      const child = name === 'devex' ? 'dx' : name;
      expect(block).toContain(`/autoplan/sections/${child}-phase.md`);
      // The phase checkpoint binds the installed host's complete methodology.
      // A second runtime-root Read would select another harness's skill.
      expect(block).not.toMatch(/^Read `[^`]+\/SKILL\.md` in full now/gm);
      const phase = read(`autoplan/sections/${child}-phase.md`);
      const load = phase.indexOf('Before dispatch, Read `methodologyPath`');
      expect(load).toBeGreaterThanOrEqual(0);
      expect(phase).toContain(`methodology ${child} "<REVIEW_SKILL>" "<RESTORE_PATH>"`);
      expect(phase).toContain('per `readRanges`; log successful ranges/total to EOF');
      expect(load).toBeLessThan(phase.indexOf(`create ${child} `));
      if (id === '2' || id === '2.5') {
        expect(block.indexOf('**Skip condition:**')).toBeLessThan(block.indexOf('> **STOP.**'));
      }
    }
    const gate = skill.indexOf('## Phase 4: Final Approval Gate');
    expect(gate).toBeGreaterThan(-1);
    expect(skill.indexOf('Read `~/.claude/skills/gstack/autoplan/sections/tasks-aggregator.md`'))
      .toBeGreaterThan(gate);
  });
});

describe('autoplan phase execution checkpoints', () => {
  const tmpl = read('autoplan/SKILL.md.tmpl');
  const phases = ['ceo', 'design', 'dx', 'eng'];

  test('loads full review skills at phase entry instead of prefetching future phases', () => {
    const intake = tmpl.split('### Step 3:')[1]?.split('## Phase 0.5:')[0] ?? '';
    expect(intake).toContain("Resolve this phase's source to absolute `<REVIEW_SKILL>`; load via its checkpoint");
    expect(intake).toContain('Do not prefetch future phase sections or review skills');
    for (const phase of phases) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      expect(section).toMatch(/^Before dispatch, Read \{\{AUTOPLAN_REVIEW_FILE:plan-[a-z-]+:with-sections\}\}/);
      const load = section.split('**Override rules:**')[0]!;
      expect(load).toContain('per `readRanges`');
      expect(load).toContain('log successful ranges/total');
      expect(load).toContain('to EOF');
      expect(load).toContain('Skip-listed: load only');
      expect(section.indexOf(':with-sections}}')).toBeLessThan(section.indexOf('create ' + phase));
      expect(section).toContain(`create ${phase} "<ACTIVE_PLAN>" "<RESTORE_PATH>" "<methodologyPath>"`);
    }
  });

  for (const phase of phases) {
    test(`${phase} places schema-aware dispatch and the actual completion wait before outside review`, () => {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const native = section.indexOf(`**{{NATIVE_LABEL}} ${phase === 'design' ? 'design' : phase === 'dx' ? 'DX' : phase === 'ceo' ? 'CEO' : 'eng'} subagent**`);
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(native).toBeGreaterThan(-1);
      expect(native).toBeLessThan(outside);
      const dispatch = section.slice(native, outside);
      expect(dispatch).toContain('run_in_background: false');
      expect(dispatch).toContain("ONLY/FINAL tool call");
      expect(dispatch).toContain('Keep native Reads enabled');
      expect(dispatch).toContain('Child first Reads `nativePromptPath` to EOF');
      expect(dispatch).toContain('all criteria + plan');
      expect(dispatch).toContain('if its schema exposes it');
      expect(dispatch).toContain('isAsync: true');
      expect(dispatch).toContain('Claude Code: end response immediately');
      expect(dispatch).toContain('No further tool calls/review until');
      expect(dispatch).toContain('Completed-native INPUT must match snapshot phase/hash');
      expect(dispatch).toContain('Retry invalid input once; then failure policy if still invalid');
      expect(dispatch).toContain('Other hosts await that ID');
      expect(dispatch).toContain("Then outside → this phase's review ONLY");
      expect(dispatch).toContain('No inline substitute; apply failure policy');
      // Provider preflight, timeout and native fallback remain at every call.
      expect(section).toContain('Outer tool timeout: 720000ms');
      expect(section).toContain('disabled → skip outside. Both retain the native pass.');
      expect(section).toContain(`{{OUTSIDE_PROVENANCE:${phase}}}`);
      expect(section).toContain(phase === 'ceo' ? 'Outside disabled/unavailable' : 'Missing/disabled');
      expect(section).toContain('N/A');
      expect(section).toContain('primary cannot replace');
      expect(section).toContain(phase === 'design' ? 'not CONFIRMED' : 'never CONFIRMED');
    });
  }

  test('the parent completes only the current phase and cannot waive native work for context pressure', () => {
    const contract = tmpl.split('## Sequential Execution')[1]?.split('---')[0] ?? '';
    expect(contract).toContain('Keep ONE phase active');
    expect(contract).toContain('Never draft future-phase reviews or outputs');
    expect(contract).toContain('After compaction, reload current phase instructions/skill/sections');
    expect(contract).toContain('reconcile saved artifacts and sent conversation messages separately');
    expect(contract).toContain('Load its phase instructions and full skill/sections');
    expect(contract).toContain("Complete the phase's required preliminary work (CEO: all Step 0");
    expect(contract.replace(/\s+/g, ' ')).toContain('then create the fresh snapshot and dispatch its nativeDispatchPrompt unchanged');
    expect(contract.replace(/\s+/g, ' ')).toContain("Consume the native terminal result and apply the phase's failure policy");
    expect(contract.replace(/\s+/g, ' ')).toContain("consume enabled outside results. Complete the phase's remaining primary review sections after these results");
    const workflow = contract.replace(/\s+/g, ' ');
    expect(workflow).toContain("At the phase's exit, load its `phase-close` section afresh");
    expect(workflow).toContain('the complete current readback followed by semantic reconciliation and the visible parent completion message in the same ordered artifact');
    expect(workflow).toContain('an earlier Read is not this close');
    expect(workflow).toContain('Only after the message has been sent may the driver load/create/dispatch the next phase');
    expect(workflow).toContain("Then continue to the next phase's tool calls in the same turn");
    expect(workflow).toContain('after Eng, proceed to final synthesis/approval');
    expect(workflow).toContain('an inapplicable phase; do not load its review or close steps');
    expect(workflow).toContain('reload `phase-close` and resume its first incomplete step');
    expect(contract).toContain('A missing gate means the current phase remains open');
    expect(contract).toContain('Read requests/self-reports and INPUT hashes do not prove uptake or review quality');
    expect(contract).toContain('Pending is not unavailable');
    expect(contract).toContain('Time/context pressure or your own review never permits\nskipping native passes or required sections');
    expect(contract).toContain('Never read raw agent transcripts');
    const rerun = tmpl.split('**Starting an affected-phase rerun:**')[1]!.split('---')[0]!.replace(/\s+/g, ' ');
    expect(rerun).toContain('record verbatim into fenced history');
    expect(rerun).toContain('retaining its original source SHA');
    expect(rerun).toContain('`baselineEdits.record` and `sourceSha256`');
    expect(rerun).toContain('compaction resumes the existing invocation');
    expect(tmpl).toContain('LOG each decision; record ALL accepted obligations below and run `amend-input` before continuing');
  });

  test('each phase binds its fixed amendment checkpoint before loading the shared close', () => {
    for (const [phase, number] of [['ceo', '1'], ['design', '2'], ['dx', '2.5'], ['eng', '3']]) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const barrier = section.indexOf('**Close this phase:**');
      const pointer = section.indexOf('{{SECTION:phase-close}}');
      const publication = read('autoplan/sections/phase-close.md.tmpl');
      expect(barrier).toBeGreaterThan(-1);
      expect(pointer).toBeGreaterThan(barrier);
      expect(closeContent(phase)).toContain(`**Phase ${number} complete.**`);
      expect(section.match(/\{\{SECTION:phase-close\}\}/g)).toHaveLength(1);
      const binding = section.slice(barrier, pointer).replace(/\s+/g, ' ');
      const checkpoint = phase === 'ceo' ? 'CEO_STEP0_CHECKPOINT' : `${phase.toUpperCase()}_INPUT`;
      expect(binding).toContain(`Use phase \`${phase}\`, checkpoint \`<${checkpoint}>\``);
      expect(binding).toContain("this phase's `methodologyPath`");
      expect(binding).toContain('load the shared close steps afresh, even if read earlier');
      expect(binding).toContain('Keep this checkpoint for this invocation; review exports do not replace it');
      expect(section.slice(pointer).trim()).toBe('{{SECTION:phase-close}}');
    }
  });

  test('the shared close prepares the full packet before its verification and publication', () => {
    const template = read('autoplan/sections/phase-close.md.tmpl');
    const close = template.replace(/\s+/g, ' ');
    const stages = ['1. **Finish and save the review.**', '2. **Reconcile accepted requirements.**',
      "3. **Prepare this phase's close packet.**", '4. **Read and execute the complete close packet.**'];
    const positions = stages.map(stage => template.indexOf(stage));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(close).toContain("the phase's full methodology/section Reads, required outputs, successful writes and terminal reviewer results");
    expect(close).toContain("Match a completed native review's INPUT to its voice snapshot");
    expect(close).toContain('A pending reviewer keeps the phase open');
    expect(close).toContain("Apply the phase's failure policy to failed native attempts");
    expect(close).toContain('unavailable/disabled voices receive no completion credit');
    expect(close).toContain("every accepted behavior, condition, test and manual checklist in this phase's accepted block");
    expect(close).toContain('Taste remains provisional; User Challenges preserve the original requirements');
    expect(close).toContain('A `None` record must explain why the implementation remains unchanged');
    expect(close).toContain('Keep the amendment checkpoint fixed for this invocation, including after compaction');
    expect(template).toContain('prepare-close "<PHASE>" "<ACTIVE_PLAN>" "<AMENDMENT_CHECKPOINT>" "<RESTORE_PATH>" "<methodologyPath>"');
    expect(close).toContain("For every returned `readRanges` entry, issue a Read of `closePacketPath` with that entry's exact `offset` and `limit`");
    expect(close).toContain('Finish all ranges through EOF, including the continuation after the implementation');
    expect(close).toContain('A Read of only the edited tail does not satisfy this step; previous snapshots do not satisfy it');
    expect(close).toContain('If a result is truncated, read its missing ranges');
    expect(close).toContain('If a Read fails, repair it and finish the missing ranges');
    expect(close).toContain('Do not advance on a request without its result');
    expect(close).toContain('regenerate the packet with the same checkpoint and Read the entire new packet before publication');
    const packet = closeContent('ceo').replace(/\s+/g, ' ');
    expect(packet).toContain('Compare the complete current implementation with the accepted decisions, source requirements, conditions, tests and required outputs');
    expect(packet).toContain('Retention checks prove bytes; counts, hashes, keyword probes and a saved “Read-back” sentence do not perform this semantic review');
    expect(packet).toContain('Fix omissions, then repeat preparation and the full packet readback');
    expect(packet).toContain('Review history stays in Review record');
    expect(packet).toContain('send the filled report below now as visible parent assistant text');
    expect(packet).toContain('using actual findings and voice statuses');
    expect(packet).toContain('Use N/A when either review voice is missing; confirmed counts require both voices');
    expect(packet).toContain('Saving it in ACTIVE_PLAN or printing it through Bash does not publish it');
    expect(packet).toContain('return to the driver in the same turn');
    expect(packet).toContain('Do not wait for a “continue” reply');
    expect(close).not.toContain('This message contains no tool calls');
    expect(read('autoplan/sections/phase-close.md')).toContain(template.trim());
  });

  test('publication precedes driver continuation without a repair bypass or user wait', () => {
    const packet = closeContent('ceo').replace(/\s+/g, ' ');
    const verify = packet.indexOf('## Verify and publish this phase');
    const report = packet.indexOf('**Phase 1 complete.**');
    const continueAt = packet.indexOf('After sending the actual parent report');
    expect(verify).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(verify);
    expect(continueAt).toBeGreaterThan(report);
    expect(packet.slice(verify, report)).toContain('If any prerequisite is incomplete, keep this phase open: repair and finish all required work and fresh readback before publishing');
    expect(packet.slice(verify, report)).toContain('send the filled report below now as visible parent assistant text');
    expect(packet.slice(continueAt)).toContain('The driver alone advances phases');
    expect(packet.slice(continueAt)).toContain('Do not wait for a “continue” reply');
    expect(packet.slice(continueAt)).toContain('a skip is never a completion');
    const driver = tmpl.split('## Sequential Execution')[1]!.split('---')[0]!.replace(/\s+/g, ' ');
    expect(driver).toContain('Only after the message has been sent may the driver load/create/dispatch the next phase');
    expect(driver).toContain('after Eng, proceed to final synthesis/approval');
    expect(read('autoplan/sections/phase-close.md.tmpl')).not.toContain('Read/create/dispatch');
  });

  test('a fresh packet carries publication data without recovering the pre-compaction caller', () => {
    const totals: Record<string, string> = {ceo: '6', design: 'rows in the completed design litmus scorecard', dx: '6', eng: '6'};
    const numbers: Record<string, string> = {ceo: '1', design: '2', dx: '2.5', eng: '3'};
    for (const child of phases) {
      const packet = closeContent(child);
      const publication = packet.split('## Verify and publish this phase')[1]!;
      expect(publication).toContain(`**Phase ${numbers[child]} complete.**`);
      expect(publication).toContain('Outside review: [completed: N concerns / unavailable / disabled]');
      expect(publication).toContain('Native subagent: [completed: N issues / unavailable]');
      expect(publication).toContain("Use the actual host's reviewer names");
      expect(publication).toContain('N/A (voice coverage missing)');
      expect(publication).toContain(`X/${totals[child]} native+outside confirmed`);
      expect(publication.includes('DX overall: [N]/10. TTHW: [N] min → [target] min.')).toBe(child === 'dx');
      expect([...publication.matchAll(/\*\*Phase ([\d.]+) complete\.\*\*/g)].map(m => m[1])).toEqual([numbers[child]]);
      const caller = read(`autoplan/sections/${child}-phase.md.tmpl`).split('**Close this phase:**')[1]!;
      expect(caller.trim().endsWith('{{SECTION:phase-close}}')).toBe(true);
      expect(caller).not.toContain('**Phase ');
      expect(caller).not.toContain('Passing to ');
    }
  });

  test('Design hands off to conditional DX and DX never requests a future Eng result', () => {
    const design = read('autoplan/sections/design-phase.md.tmpl');
    const dx = read('autoplan/sections/dx-phase.md.tmpl');
    expect(closeContent('design')).toContain('Phase 2.5 (DX Review) if DX scope was detected; otherwise Phase 3 (Eng Review)');
    expect(design).not.toContain('> Passing to Phase 3.');
    expect(dx).toContain("Design: <insert Design consensus summary, or 'skipped, no UI scope'>");
    expect(dx).not.toContain('Eng: <insert Eng consensus summary>');
  });
});


describe('autoplan current implementation-plan identity', () => {
  test('pins the assigned active plan and keeps accepted amendments separate from review analyses', () => {
    const intake = read('autoplan/SKILL.md.tmpl').split('## Phase 0: Intake')[1]?.split('### Step 2:')[0] ?? '';
    expect(intake).toContain('ACTIVE_PLAN (harness-assigned plan, else SOURCE_PLAN)');
    expect(intake).toContain('Save plan amendments and review artifacts to ACTIVE_PLAN');
    expect(intake).toContain('Send phase announcements and the final approval request in the conversation');
    expect(intake).toContain("init backs up SOURCE_PLAN exactly");
    expect(intake).toContain('without losing requirements');
    expect(intake).toContain('init "<SOURCE_PLAN>" "<ACTIVE_PLAN>" "<RESTORE_PATH>"');
    expect(intake).toContain('Use returned paths/`scope`');
    expect(intake).toContain('On helper errors, stop');
    expect(intake).toContain('analysis stays in `## Review record`');
    // Binding belongs to the lazy execution site, not a stale intake variable.
    expect(intake).not.toContain('Bind `<review_plan_path>`');
  });

  test('DX scope consumes the deterministic full-input result and permits only enabling overrides', () => {
    const intake = read('autoplan/SKILL.md.tmpl').split('### Step 2: Read context')[1]?.split('### Step 3:')[0] ?? '';
    expect(intake).toContain('scope "<ACTIVE_PLAN>"');
    expect(intake).toContain('Use returned `dxRequired`');
    expect(intake).toContain('threshold is 2+ term matches');
    expect(intake).toContain('`--developer-tool` or `--agent-primary`');
    expect(intake).toContain('no context label can negate a positive result');
    expect(intake).toContain('false and neither semantic trigger applies');
  });

  test('every native and outside call site binds the fresh snapshot, retaining requested outside consensus', () => {
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const bind = section.indexOf("**Bind phase input:**");
      const native = section.indexOf('subagent**');
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(bind).toBeGreaterThan(-1);
      expect(bind).toBeLessThan(native);
      expect(native).toBeLessThan(outside);
      const preparation = section.slice(bind, native);
      expect(preparation).toContain(`create ${phase} "<ACTIVE_PLAN>" "<RESTORE_PATH>"`);
      expect(preparation).toContain('`snapshotPath` as `<' + phase.toUpperCase() + '_INPUT>` for both voices');
      expect(preparation).toContain('excludes `Review record`');
      expect(section.replace(/\s+/g, ' ')).toContain('Send its `nativeDispatchPrompt` verbatim as the Agent prompt');
      expect(section).toContain('Read `snapshot.json` beside `<' + phase.toUpperCase() + '_INPUT>`');
      expect(section).toContain('Reads `nativePromptPath` to EOF');
      expect(section).toContain(`Outside prompt: inline the full contents of <${phase.toUpperCase()}_INPUT>`);
      const checkpoint = phase === 'ceo' ? 'CEO_STEP0_CHECKPOINT' : `${phase.toUpperCase()}_INPUT`;
      expect(section).toContain(`Use phase \`${phase}\`, checkpoint \`<${checkpoint}>\``);
      expect(section).toContain('{{SECTION:phase-close}}');
      expect(read('autoplan/sections/phase-close.md.tmpl')).toContain('prepare-close "<PHASE>" "<ACTIVE_PLAN>" "<AMENDMENT_CHECKPOINT>"');
      expect(read('autoplan/SKILL.md.tmpl')).toContain('checks exact retention');
      expect(section).not.toContain('<review_plan_path>');
      expect(section).not.toContain('<plan_path>');
      expect(section).toContain('no summaries or prior reviews');
    }
    const eng = read('autoplan/sections/eng-phase.md.tmpl');
    expect(eng).toContain('no summaries or prior reviews');
    expect(eng).toContain('DX: <insert DX consensus table summary');
  });
});
