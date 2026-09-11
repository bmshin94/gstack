import { describe, expect, test } from 'bun:test';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { readFileSync } from 'node:fs';

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
    expect(skeleton).toContain('Fewer components does not approve a pending remedy; ask about each separately before applying it.');
    expect(sections).toContain('Outside voice findings are INFORMATIONAL until the user explicitly approves each one');
    expect(sections).toContain('Do NOT incorporate outside voice recommendations into the plan without presenting each');
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
