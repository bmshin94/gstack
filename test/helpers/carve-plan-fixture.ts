import * as fs from 'node:fs';
import * as path from 'node:path';

/** The cache reviews need an inspectable repository, interface, and quickstart.
 * Keep the proposed cache absent so the skill still has real design work. */
export function repositoryPlanFixtures(plan: string, skill: 'plan-eng-review' | 'plan-devex-review'): Record<string, string> {
  const dir = path.resolve(import.meta.dir, '../fixtures/carve-existing-repository');
  const companion = skill === 'plan-devex-review' ? 'plan-devex-review/dx-hall-of-fame.md' : 'review/TODOS-format.md';
  return {
    'PLAN.md': plan + '\n## Existing project\nRead `README.md` and `src/repository.ts` for the current API and runtime.\nThe change adds the cache to that repository; the existing example must keep working.\n',
    ...Object.fromEntries(['README.md', 'src/repository.ts', 'example.ts'].map(file => [file, fs.readFileSync(path.join(dir, file), 'utf8')])),
    [companion]: fs.readFileSync(path.resolve(import.meta.dir, '../..', companion), 'utf8'),
  };
}
