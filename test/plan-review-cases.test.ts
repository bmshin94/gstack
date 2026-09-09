import { describe, expect, test } from 'bun:test';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { readFileSync } from 'node:fs';

const menu = (labels: string[], header = 'Next review', question = "D12 — What's next?"): NativeQuestion => ({
  header, question, multiSelect: false, options: labels.map(label => ({ label, description: 'Offered choice' })),
});

describe('plan-review manual handoff selection', () => {
  test('declines the retained native two-option next-review offer', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip — handle reviews manually']))).toBe(2);
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
    ['Run /plan-eng-review', 'Skip'],
    ['Run /plan-eng-review', 'Skip — handle reviews manually', 'Ship immediately'],
    ['Run /plan-eng-review', 'Skip — handle reviews manually', "Skip — I'll handle reviews manually"],
  ])('rejects an ambiguous or incomplete handoff menu: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
});
