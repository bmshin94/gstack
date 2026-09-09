/** Seed the review target before the first model turn, in a caller-owned,
 * fresh private directory. Never reuse an operator project or its git state.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** These cases review a supplied plan. Decline only the initial, explicit
 * Office Hours prerequisite pair; every other question keeps the driver default. */
export function pickSuppliedCeoPlanStart({ options }: { options: Array<{ index: number; label: string }> }): number {
  const choices = options.map(option => ({ ...option, label: option.label.trim()
    .replace(/^[A-D][).]\s+/, '').replace(/\s*\(Recommended\)\s*$/i, '').trim() }));
  const run = choices.filter(option => /^Run \/office-hours(?: now)?$/i.test(option.label));
  const skip = choices.filter(option => /^Skip(?:\s*[—–-]\s*standard review|\s*\(standard review without design doc context\))?$/i.test(option.label));
  return choices.length === 2 && run.length === 1 && skip.length === 1 ? skip[0]!.index : 1;
}

export function seedCeoFindingProject(projectDir: string, plan: string): void {
  seedPlanReviewProject(projectDir, plan, 'plan-ceo-review');
}

export function seedPlanReviewProject(projectDir: string, plan: string, skill: 'plan-ceo-review' | 'plan-eng-review' | 'plan-design-review' | 'plan-devex-review'): void {
  if (!fs.lstatSync(projectDir).isDirectory() || fs.readdirSync(projectDir).length !== 0) {
    throw new Error('Plan review fixture requires a fresh private directory');
  }
  fs.writeFileSync(path.join(projectDir, 'review-input.md'), plan, { flag: 'wx' });
  fs.writeFileSync(path.join(projectDir, 'README.md'), `# ${skill} fixture\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), [
    `# ${skill}`, '',
    'The requested review target is the plan in `review-input.md`. Read it before',
    'choosing review scope. Follow its instruction for the output plan path.',
    'This repository contains the review input; its branch diff is not the plan.', '',
    '## Skill routing', '',
    `- Review the supplied plan with /${skill}.`, '',
  ].join('\n'), { flag: 'wx' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git(['init', '-b', 'main']);
  git(['add', 'README.md', 'CLAUDE.md', 'review-input.md']);
  git(['-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Seed review input']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}
