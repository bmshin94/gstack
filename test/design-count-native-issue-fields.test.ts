import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-count-native-issue-fields.json';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const accepts = (call: NativePlanQuestionCall) => isDesignCountFirstReview(fingerprint(call));
type Question = NativePlanQuestionCall['questions'][number];
function changed(index: number, edit: (question: Question) => void) {
  const call = calls()[index]!, question = call.questions[0]!;
  edit(question);
  call.answers = { [question.question]: question.options[0]!.label };
  return call;
}

describe('native numbered design gaps with complete decision fields', () => {
  test('the exact first four findings each establish review independently', () => {
    for (const index of [1, 2, 3, 4]) expect(accepts(calls()[index]!)).toBe(true);
  });

  test('all eight public calls retain one setup and seven review decisions without mutation', () => {
    const input = calls(), before = JSON.stringify(input);
    let started = false;
    const phases = input.map(call => {
      const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
        isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      return phase;
    });
    expect(input).toHaveLength(8);
    expect(captured.assistantMessages).toHaveLength(3);
    expect(phases.map(phase => phase.preReview)).toEqual([true, false, false, false, false, false, false, false]);
    expect(phases.filter(phase => phase.administrative)).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('a finding keeps its identity across descriptive headers, ordinals and offered answers', () => {
    for (const index of [1, 2, 3, 4]) {
      const call = changed(index, question => {
        question.header = 'Current design requirement';
        question.question = question.question.replace(/Issue [1-9]\d*/, 'Issue 17')
          .replace(/\bG[1-9]\d*\b/g, 'G29').replace(/\b[1-9]\d*([ABC])\b/g, '17$1');
        question.options = question.options.map(option => ({
          label: option.label.replace(/^[1-9]\d*/, '17'),
          description: option.description?.replace(/\bG[1-9]\d*\b/g, 'G29'),
        })).reverse();
      });
      for (const option of call.questions[0]!.options) {
        call.answers = { [call.questions[0]!.question]: option.label };
        expect(accepts(call)).toBe(true);
      }
    }
  });

  test('decision fields tolerate prose layout and equivalent current defect descriptions', () => {
    const descriptions = [
      'The header buttons currently share the same visual weight; the primary action is not distinguishable.',
      'The Save request currently gives no visible feedback while it is pending; users try again.',
      'The form labels currently mix 14px, 16px and 18px with no consistent role; the hierarchy is unclear.',
      'The form currently mixes 24px, 32px and 16px section gaps without a spacing rule.',
    ];
    for (const [offset, assessment] of descriptions.entries()) {
      const call = changed(offset + 1, question => {
        question.question = question.question.replace(/^ELI10: .+$/m, `ELI10: ${assessment} DESIGN.md specifies the existing treatment.`)
          .replace(/\n(?=(?:Stakes if we pick wrong|Recommendation|Completeness|Net):)/g, '\n\n');
      });
      expect(accepts(call)).toBe(true);
    }
  });

  test('bare gap IDs, scores, or setup menus cannot replace the current design defect', () => {
    for (const index of [1, 2, 3, 4]) for (const edit of [
      (q: Question) => { q.header = 'Focus'; },
      (q: Question) => { q.header = 'Issue 99'; },
      (q: Question) => { q.question = q.question.replace(/^D\d+[^\n]+/, 'D2 — Issue 1 (G1): Are we ready to review the design?'); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: .+$/m, 'ELI10: G1 is a design finding with a score of 6/10.'); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: .+$/m, 'ELI10: The form already follows every design requirement and has no current defect.'); },
      (q: Question) => { q.options = [{ label: `${index}A Start review`, description: 'Continue the review.' }, { label: `${index}B Wait`, description: 'Keep the gap open.' }]; },
    ]) expect(accepts(changed(index, edit))).toBe(false);
  });

  test('source, quoted, conditional, withdrawn and duplicate evidence does not establish review', () => {
    for (const index of [1, 2, 3, 4]) for (const edit of [
      (q: Question) => { q.question = `Historical example:\n${q.question}`; },
      (q: Question) => { q.question = `\`\`\`\n${q.question}\n\`\`\``; },
      (q: Question) => { q.question = q.question.replace('ELI10: ', 'ELI10: If approved, '); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'); },
      (q: Question) => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: Earlier review example: '); },
      (q: Question) => { q.question += '\nELI10: No current defect exists.'; },
      (q: Question) => { q.question += '\nCorrection: this finding is withdrawn.'; },
      (q: Question) => { q.question += '\nCorrection: this gap is already resolved.'; },
      (q: Question) => { q.options[0]!.description = `If approved later, ${q.options[0]!.description}`; },
      (q: Question) => { q.options[0]!.description = `> ${q.options[0]!.description}`; },
      (q: Question) => { q.options[0]!.description += ' This amendment is withdrawn.'; },
      (q: Question) => { q.options[2]!.description += ' This gap is now closed.'; },
    ]) expect(accepts(changed(index, edit))).toBe(false);
  });

  test('the offered remedy and retained gap must belong to this decision', () => {
    for (const index of [1, 2, 3, 4]) for (const edit of [
      (q: Question) => { q.options[0]!.label = '99A A different issue'; },
      (q: Question) => { q.options[0]!.description = 'Record a finding after the next review.'; },
      (q: Question) => { q.options[2]!.description = q.options[2]!.description!.replace(/G\d+/, 'G999'); },
      (q: Question) => { q.options[2]!.description = 'The gap is resolved; nothing remains open.'; },
      (q: Question) => { q.options[2]!.label = `${index}C Choose the next workflow`; },
      (q: Question) => { q.question = q.question.replace('Recommendation:', 'Previous recommendation:'); },
      (q: Question) => { q.question = q.question.replace(/^Recommendation: [1-9]\d*[A-Z]/m, 'Recommendation: 99A'); },
    ]) expect(accepts(changed(index, edit))).toBe(false);
  });

  test('owned quoted status scalars still withdraw a decision; quoted history does not', () => {
    for (const index of [1, 2, 3, 4]) for (const target of ['question', 'remedy', 'deferral']) {
      const append = (q: Question, text: string) => {
        if (target === 'question') q.question += text;
        else q.options[target === 'remedy' ? 0 : 2]!.description += text;
      };
      for (const [left, right] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['`', '`']]) {
        expect(accepts(changed(index, q => append(q, `\nThis finding is ${left}withdrawn${right}.`)))).toBe(false);
      }
      expect(accepts(changed(index, q => append(q, '\nPrior note: "This finding is withdrawn."')))).toBe(true);
      expect(accepts(changed(index, q => append(q, '\n> This finding is withdrawn.')))).toBe(true);
    }
  });

  test('only a completed, successful native call with its actual selected answer can start review', () => {
    const changes = [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { delete c.answeredAt; },
      (c: NativePlanQuestionCall) => { c.sessionId = ''; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'not offered' }; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ];
    for (const index of [1, 2, 3, 4]) {
      for (const change of changes) { const call = calls()[index]!; change(call); expect(accepts(call)).toBe(false); }
      for (const change of [
        (fp: ReturnType<typeof fingerprint>) => { fp.signature = 'other:call'; },
        (fp: ReturnType<typeof fingerprint>) => { fp.nativeQuestionIndex = 1; },
        (fp: ReturnType<typeof fingerprint>) => { fp.options.reverse(); },
      ]) { const fp = fingerprint(calls()[index]!); change(fp); expect(isDesignCountFirstReview(fp)).toBe(false); }
    }
  });
});
