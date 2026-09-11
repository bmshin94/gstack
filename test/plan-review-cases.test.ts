import { describe, expect, test } from 'bun:test';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { readFileSync } from 'node:fs';
import { generateAntiShortcutClause, generateCodexPlanReview } from '../scripts/resolvers/review';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';

const menu = (labels: string[], header = 'Next review', question = "D12 — What's next?"): NativeQuestion => ({
  header, question, multiSelect: false, options: labels.map(label => ({ label, description: 'Offered choice' })),
});

test('Eng independent-remedy rule is loaded before Step 0 and retains outside-voice consent', () => {
  const definition = 'Ask separately about each independently selectable remedy';
  for (const suffix of ['.tmpl', '']) {
    const skeleton = readFileSync(`plan-eng-review/SKILL.md${suffix}`, 'utf8');
    const sections = readFileSync(`plan-eng-review/sections/review-sections.md${suffix}`, 'utf8');
    const rule = skeleton.indexOf(definition);
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(skeleton.indexOf('### Step 0: Scope Challenge'));
    expect(skeleton.slice(rule, rule + 350).replace(/\s+/g, ' ')).toContain('Keep implementation details and tests directly establishing one chosen contract together');
    expect((skeleton + sections).split(definition)).toHaveLength(2);
    expect(skeleton).toContain('For new or reopened decisions, explain tradeoffs');
    expect(skeleton).toContain('Ask separately about each independently selectable remedy still pending');
    expect(skeleton).not.toContain('For every issue or recommendation');
    const scope = skeleton.slice(skeleton.indexOf('### Step 0: Scope Challenge'), skeleton.indexOf('**STOP.** Until the user resolves'));
    expect(scope).toContain('8+ files or 2+ new classes/services');
    expect(scope).toContain('STOP before section work');
    expect(scope).toContain("Use the preamble's question flow in this order");
    expect(scope).toContain('If the smaller design requires removing a feature, ask about that cut separately first');
    expect(scope).toContain('Every option must include, drop or defer the same features, following earlier approvals');
    expect(scope).toContain('Preserve established contracts in both designs');
    expect(scope).toContain('Keep approved security, error-handling, test and performance fixes unchanged; unresolved fixes stay undecided');
    expect(scope).toContain('That answer does not approve, drop or postpone any independent fix');
    expect(scope).toContain('ask about each fix separately before making that change');
    expect(scope).not.toContain('proceed as-is');
    const inventory = sections.indexOf('**Decision gate (all sections and outside voice):**');
    expect(inventory).toBeGreaterThan(0);
    expect(inventory).toBeLessThan(sections.indexOf('### 1. Architecture review'));
    const boundary = sections.slice(inventory, sections.indexOf('### 1. Architecture review')).replace(/\s+/g, ' ');
    expect(boundary).toContain('Name the behavior policy, implementation choice or optional verification depth the answer will decide');
    expect(boundary).toContain("List the problems that could be fixed independently. For each, record exactly what was approved and what is still undecided");
    expect(boundary).toContain('In every offered option, keep all other approved choices fixed and all unresolved choices undecided');
    expect(boundary).toContain('Keep a chosen behavior and the code, tests and docs needed to establish it together');
    expect(boundary).toContain('Score completeness only within this one decision');
    expect(boundary).toContain('Preserve established contracts; ask separately before changing one');
    expect(boundary).toContain('Never make an option smaller by dropping settled behavior');
    expect(boundary).toContain('For that approved behavior, add its required implementation work, tests and docs to the plan without asking again, even after the Tests section');
    expect(boundary).toContain('attempt limit, jitter and behavior after retries are exhausted separately');
    expect(boundary).toContain('Crash tests proving that same chosen behavior belong with its implementation');
    expect(boundary).toContain('This does not authorize a behavior change');
    expect(sections).toContain('Assess every outside voice finding through the same decision gate');
    expect(sections).toContain('New or reopened decisions remain INFORMATIONAL until individually presented via');
    expect(sections).toContain('AskUserQuestion and explicitly approved, even when you agree with the outside');
  }
});

// Source/renderer contract controls only: native review behavior remains a paid
// regression. Resolve the actual Eng clause on every host without trusting an
// old generated carrier to hide a contradictory unconditional approval gate.
describe('Eng approved-work decision gate', () => {
  const template = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
  const gate = template.split('**Decision gate (all sections and outside voice):**')[1]?.split('### 1. Architecture review')[0] ?? '';

  test('all four section gates and outside voice distinguish pending choices from findings', () => {
    const sections = [...template.matchAll(/^### ([1-4])\.([^]*?)(?=^### [1-4]\.|^\{\{CODEX_PLAN_REVIEW\}\})/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual([1, 2, 3, 4]);
    for (const [, number, body] of sections) {
      expect(body, `Section ${number}`).toContain('For each new or reopened decision identified by the decision gate');
      expect(body, `Section ${number}`).toContain('One independent decision per call');
      expect(body, `Section ${number}`).toContain('**STOP for each pending decision.**');
      expect(body, `Section ${number}`).toContain('until the user responds');
      expect(body, `Section ${number}`).toContain('An unapproved remedy with an "obvious fix" still needs explicit user approval');
    }
    expect(template).toContain('Assess every outside voice finding through the same decision gate');
    expect(template).toContain('New or reopened decisions remain INFORMATIONAL');
    expect(template).toContain("report the section's findings and dispositions");
    expect(template).toContain('Never condense, abbreviate, or skip any review section (1-4)');
    expect(template).toContain('{{PLAN_FILE_REVIEW_REPORT}}');
    for (const stale of ['For each issue found in this section',
      'Otherwise, use AskUserQuestion for each finding',
      'Outside voice findings are INFORMATIONAL until the user explicitly approves each one']) {
      expect(template).not.toContain(stale);
    }
  });

  test('exact prior answers authorize follow-through while new risk and optional depth stay pending', () => {
    const normalized = gate.replace(/\s+/g, ' ');
    expect(normalized).toContain('Correct factual descriptions when source evidence shows they are wrong');
    expect(normalized).toContain('This does not authorize a behavior change');
    expect(normalized).toContain('Cite the actual selected option, its question/answer reference and the exact approved scope');
    expect(normalized).toContain('A broad approach, recommendation or cross-model agreement is not approval');
    expect(normalized).toContain('Ask separately about scope changes');
    expect(normalized).toContain('concrete new risks that invalidate a prior choice');
    expect(normalized).toContain('If the prior answer does not cover the proposed work, leave it undecided');
    expect(normalized).toContain('Never hide a risk or omit required proof');
  });

  test('every host resolves the Eng gate without the conflicting generic shortcut clause', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const clause = generateAntiShortcutClause({ skillName: 'plan-eng-review', host: host.name } as TemplateContext);
      expect(clause).toContain('Ask once per new or reopened independent decision');
      expect(clause).toContain('wait for the actual answer');
      expect(clause).toContain('cite that selected answer and scope');
      expect(clause).toContain('retain the finding and proof');
      expect(clause).toContain('does not approve independent remedies or optional verification depth');
      expect(clause).toContain('Concrete new risks or changed assumptions may reopen a decision');
      expect(clause).not.toContain('ANY non-trivial finding');
      expect(clause).not.toContain('Zero findings in every section is the only path');
    }
  });
});

// These checks cover generated instructions, not native model compliance.
describe('outside-voice pending-change queue', () => {
  const skills = ['plan-ceo-review', 'plan-eng-review', 'plan-devex-review'];
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: maps changes before asking, answering and applying one row`, () => {
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
        const stages = [
          '**1. Map findings to pending changes.**',
          '**2. Draft from one pending row.**',
          "Use AskUserQuestion for that row's change.",
          '**3. Obtain the answer.**',
          '**4. Apply the answered row.**',
          'then use a scoped Edit for those amendments before taking the next row.',
        ].map(stage => queue.indexOf(stage));
        expect(stages.every(position => position >= 0)).toBe(true);
        expect(stages).toEqual([...stages].sort((a, b) => a - b));
        const text = queue.replace(/\s+/g, ' ');
        expect(text).toContain('finding | issue/decision reference | current disposition + approval reference | proposed change');
        expect(text).toContain('against existing working decisions or issue references; reuse their ledger where present');
        expect(text).toContain('A reviewer bullet affecting separate issues produces separate rows');
        expect(text).toContain('Exact confirmations and source-proven factual corrections update evidence without authorizing behavior changes');
        expect(text).toContain('New proposed changes still queue when reviewers agree');
        expect(text).toContain('Outside-voice proposal [issue/decision reference]: [proposed change]');
        expect(text).toContain('Current disposition: [approved choice + reference, or unresolved]');
        expect(text).not.toContain('The review chose [X]');
        expect(text).not.toContain('Cross-model disagreement on [topic]');
        expect(text).toContain("Hold every other row's approved value or pending disposition constant across options");
        expect(text).toContain('Record its answer reference and exact accepted scope');
        expect(text).toContain("one answer does not clear the finding's remaining changes");
        expect(text).toContain('reopening requires concrete contradictory evidence or a changed assumption');
        expect(text).toContain('Retain unresolved risks and verification');
        expect(text).toContain('preserve its authorized auto-decision and User Challenge rules, audit trail and final gate');
        expect(text).toContain("User Challenges stay pending for /autoplan's final gate");
        expect(queue.match(/^- [A-D]\)/gm)).toEqual(['- A)', '- B)', '- C)', '- D)']);
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
