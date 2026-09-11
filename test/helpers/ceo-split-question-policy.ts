import type { NativeQuestion } from './plan-skill-questions';
import { pickPlanReviewQuestion } from './plan-review-cases';

/** This simulated user keeps the split fixture's stated 2–3 integration cap.
 * Only the explicit assembled-set reconciliation changes the ordinary picker;
 * every original candidate still gets its own native decision and evaluation. */
export function pickCeoSplitQuestion(question: NativeQuestion): number {
  const lead = question.question.split(/\r?\n/, 1)[0]!;
  const capQuestion = question.header.trim() === 'Final set'
    && /^D[1-9]\d*(?:\.final)? — The assembled set is (?:[4-9]|[1-9]\d+|four|five|six|seven|eight|nine) items at ~?\d+ weeks, but the plan caps this quarter at 2[-–]3 integrations\. How do we resolve that\?$/.test(lead);
  if (!capQuestion) return pickPlanReviewQuestion(question);

  const labels = question.options.map(option => option.label.trim()
    .replace(/^[A-D][).] /, '').replace(/ \(recommended\)$/i, ''));
  const platform = '(?:Slack|Discord|(?:Microsoft )?Teams|Telegram|Mattermost)';
  const trim = new RegExp(`^Trim to cap: (${platform}(?: \\+ ${platform}){1,2})$`);
  const choices: number[] = [];
  let supported = !question.multiSelect && labels.length >= 2 && labels.length <= 4;
  for (const [index, label] of labels.entries()) {
    const match = trim.exec(label);
    if (match) {
      const selected = match[1]!.split(' + ').map(name => name.replace(/^Microsoft /, ''));
      if (new Set(selected).size !== selected.length) supported = false;
      choices.push(index + 1);
    } else if (!/^(?:Keep all (?:[4-9]|[1-9]\d+|four|five|six|seven|eight|nine), lift the cap|Revise one option|Hold — discuss first)$/.test(label)) {
      supported = false;
    }
  }
  if (!supported || choices.length !== 1) {
    throw new Error('Split scope reconciliation has no unique offered 2–3-platform cap-preserving answer');
  }
  return choices[0]!;
}
