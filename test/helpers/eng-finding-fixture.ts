import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedPlanReviewProject } from './ceo-finding-fixture';

/** Supply the existing behavior that the plan says it will rewrite. The new
 * AuthBroker/SessionMint/cache implementation remains proposed and absent. */
export function seedEngFindingProject(projectDir: string, plan: string): string {
  const input = plan + '\n\n## Existing behavior and boundaries\n' + [
    'Read `src/legacy-auth.ts`: this is the existing flow, not the proposed refactor.',
    'The HTTP admission middleware, IDP policy client, and session service keep their',
    'documented contracts. The five policy names identify the existing independent',
    'read-only verdict calls made by this function.',
    'The refactor preserves the return value and three public failure codes.',
    'No session lifecycle, HTTP protocol, schema, or deployment change is proposed.',
    'Those adapter implementations belong to the existing platform outside this',
    'fixture; their interface here defines the boundary of this refactor.',
    'The current route remains behind the existing rollout flag, so reverting that',
    'flag restores this implementation without migrating data or sessions.',
  ].join('\n') + '\n';
  seedPlanReviewProject(projectDir, input, 'plan-eng-review');
  fs.mkdirSync(path.join(projectDir, 'src'));
  fs.copyFileSync(path.resolve(import.meta.dir, '../fixtures/eng-existing-auth/legacy-auth.ts'), path.join(projectDir, 'src/legacy-auth.ts'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'pipe', timeout: 10_000 });
  git('add', 'src/legacy-auth.ts');
  git('-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Supply existing auth behavior');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return input;
}
