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

const ROOT = path.join(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const phases = [
  { child: 'ceo', id: '1', next: ['2'] },
  { child: 'design', id: '2', next: ['2.5', '3'] },
  { child: 'dx', id: '2.5', next: ['3'] },
  { child: 'eng', id: '3', next: ['4'] },
];

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
    const announced = [...section.matchAll(/^\*\*Phase (\d+(?:\.\d+)?) complete\.\*\*$/gm)].map(m => m[1]);
    const handoff = section.match(/^Passing to .+$/m)?.[0] ?? '';
    expect(section).toContain('Emit the following summary as its own visible parent assistant text block');
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
    expect(contract).toContain('Save the full review artifacts and accepted amendments');
    expect(contract).toContain('implementation check and readback');
    expect(contract).toContain('Emit the phase completion summary as its own visible parent assistant text block');
    expect(contract.replace(/\s+/g, ' ')).toContain("Then continue to the next phase's tool calls in the same turn");
    expect(contract.replace(/\s+/g, ' ')).toContain('for Eng, send this text before final synthesis/approval');
    expect(contract).toContain('A missing gate means the current phase remains open');
    expect(contract).toContain('Read requests/self-reports and INPUT hashes do not prove uptake or review quality');
    expect(contract).toContain('Pending is not unavailable');
    expect(contract).toContain('Time/context pressure or your own review never permits\nskipping native passes or required sections');
    expect(contract).toContain('Never read raw agent transcripts');
    expect(tmpl).toContain('LOG each decision; record ALL accepted obligations below and run `amend` before continuing');
  });

  test('each completed phase announces only after persisted full outputs and settled reviewers', () => {
    for (const [phase, number] of [['ceo', '1'], ['design', '2'], ['dx', '2.5'], ['eng', '3']]) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const barrier = section.indexOf('**Close this phase:**');
      const announcement = section.indexOf(`\n**Phase ${number} complete.**\n`);
      expect(barrier).toBeGreaterThan(-1);
      expect(barrier).toBeLessThan(announcement);
      const checkpoint = section.slice(barrier, announcement).replace(/\s+/g, ' ');
      expect(checkpoint).toContain('Require full skill/section ranges');
      expect(checkpoint).toContain('successful writes');
      expect(checkpoint).toContain('terminal reviewer results');
      expect(checkpoint).toContain('When the native review succeeded, match its INPUT');
      expect(checkpoint).toContain("A failed native attempt follows the phase's failure policy without native completion credit");
      expect(checkpoint).toContain('a pending reviewer keeps this phase open');
      expect(checkpoint).toContain('(unavailable/disabled allowed)');
      expect(checkpoint).toContain('successful writes/check');
      expect(checkpoint).toContain(phase === 'eng'
        ? 'After this text, proceed to final synthesis/approval in the same turn'
        : 'After this text, load/create/dispatch the next phase in the same turn');
      expect(checkpoint).toContain('EVERY accepted requirement/condition/test');
      expect(checkpoint).toContain('in its block');
      expect(checkpoint).toContain('Reconcile full review');
      expect(checkpoint).toContain('Read back fully');
      expect(checkpoint).toContain('retention ≠ approval/completeness/correctness');
      expect(checkpoint).toContain('Taste provisional');
      expect(checkpoint).toContain('User Challenges keep original');
      expect(checkpoint).toContain(`amend ${phase} "<ACTIVE_PLAN>" "<${phase.toUpperCase()}_INPUT>"`);
      expect(checkpoint).toContain('None: reason checks unchanged');
      expect(checkpoint).toContain('Emit the following summary as its own visible parent assistant text block');
      const save = checkpoint.indexOf('1. **Save artifacts.**');
      const verify = checkpoint.indexOf('2. **Verify.**');
      const notify = checkpoint.indexOf('3. **Notify the user.**');
      expect(save).toBeGreaterThan(-1);
      expect(save).toBeLessThan(verify);
      expect(verify).toBeLessThan(notify);
      expect(checkpoint).toContain('after the verification results');
      expect(checkpoint).not.toContain('This message contains no tool calls');
    }
  });

  test('Design hands off to conditional DX and DX never requests a future Eng result', () => {
    const design = read('autoplan/sections/design-phase.md.tmpl');
    const dx = read('autoplan/sections/dx-phase.md.tmpl');
    expect(design).toContain('Passing to Phase 2.5 (DX Review) if DX scope was detected; otherwise Phase 3');
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
      expect(section).toContain(`amend ${phase} "<ACTIVE_PLAN>" "<${phase.toUpperCase()}_INPUT>"`);
      expect(section).toContain('None: reason checks unchanged');
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
