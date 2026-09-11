/** Project setup shared by the paid autoplan chain and its free preamble check. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedHermeticGstackHome } from './hermetic-env';

const UI_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'plans', 'ui-heavy-feature.md');
const DESIGN_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'plans', 'ui-heavy-feature-design.md');
const CHAIN_UI_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'plans', 'autoplan-password-visibility.md');
const CHAIN_DESIGN_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'plans', 'autoplan-password-visibility-design.md');
const APP_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'autoplan-existing-app');

export function seedAutoplanProject(projectDir: string, scenario: 'dashboard' | 'password-visibility' = 'dashboard'): string {
  const plansDir = path.join(projectDir, '.claude', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const plan = scenario === 'password-visibility' ? CHAIN_UI_FIXTURE : UI_FIXTURE;
  const design = scenario === 'password-visibility' ? CHAIN_DESIGN_FIXTURE : DESIGN_FIXTURE;
  fs.copyFileSync(plan, path.join(plansDir, path.basename(plan)));
  fs.copyFileSync(design, path.join(projectDir, 'DESIGN.md'));
  // Both scenarios extend this existing React/Tailwind app with PostgreSQL-backed
  // authentication. Supply its source, leaving the proposed UI unimplemented.
  fs.cpSync(APP_FIXTURE, projectDir, { recursive: true, errorOnExist: true, force: false });
  fs.writeFileSync(path.join(projectDir, 'README.md'), [
    '# Workspace app', '',
    'Current behavior: password sign-in issues a one-hour server session; the',
    'post-login page is `/workspace`. PostgreSQL schema is in `db/schema.sql`.',
    'Activity and notifications are stored already; notifications have read state.',
    scenario === 'password-visibility'
      ? 'The proposed password visibility control is `.claude/plans/autoplan-password-visibility.md`; it is not implemented.'
      : 'The dashboard plan is `.claude/plans/ui-heavy-feature.md`; it is not implemented.', '',
    'To run the app: install the manifest dependencies, apply the schema to a',
    'PostgreSQL database with provisioned users/password hashes, set DATABASE_URL and',
    'APP_ORIGIN to the public HTTPS origin,',
    'run `bun run css`, then `bun start` behind HTTPS (session cookies are Secure).',
    'This source fixture does not install dependencies or provision a live database.', '',
  ].join('\n'));
  // The chain exercises review phases in an already configured project.
  // Use skill-start's canonical project marker, preserving user-state defaults.
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Autoplan chain fixture\n\n## Skill routing\n\n- Full review pipeline → invoke /autoplan.\n');
  // Keep artifact writes in this fixture's workspace, not the operator HOME.
  const stateDir = path.join(projectDir, '.gstack');
  fs.mkdirSync(stateDir);
  seedHermeticGstackHome(stateDir);
  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.gstack/\nnode_modules/\npublic/styles.css\n');
  return stateDir;
}
