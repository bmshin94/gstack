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
  if (scenario === 'password-visibility') {
    const manifestPath = path.join(projectDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scripts.test = 'bun run css && bun test tests/sign-in.test.ts';
    manifest.devDependencies.playwright = '1.62.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    fs.mkdirSync(path.join(projectDir, 'tests'));
    fs.copyFileSync(path.resolve(import.meta.dir, '../fixtures/autoplan-password-ui/sign-in.test.ts.fixture'),
      path.join(projectDir, 'tests/sign-in.test.ts'));
  }
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
    ...(scenario === 'password-visibility' ? [
      '## Existing UI regression tests', '',
      'After `bun install` and `bunx playwright install chromium`, run `bun run test`.',
      'The existing Bun + Playwright harness builds the actual React entry and Tailwind CSS.',
      'It checks the masked sign-in form, Enter-to-submit payload and success navigation,',
      'and the current wrong-password behavior: the form disappears into the generic error.',
      'Tests intercept `/api/session` and `/api/login` with explicit responses. They do not',
      'exercise PostgreSQL, credential validation, cookies or password-manager autofill.',
      'Reuse this harness for proposed UI verification. The current no-visibility-control',
      'assertion records the unimplemented baseline; replace it with the approved toggle',
      'checks when implementing that feature. Password-manager autofill still needs the',
      'manual browser check required by the plan. No feature decision is pre-approved.', '',
    ] : []),
  ].join('\n'));
  // The chain exercises review phases in an already configured project.
  // Use skill-start's canonical project marker, preserving user-state defaults.
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), [
    '# Autoplan chain fixture', '',
    '## Skill routing', '',
    '- Full review pipeline → invoke /autoplan.', '',
    '## Review artifact editing', '',
    'Review the proposal; do not edit application source.',
    'You may create or update review plan and report documents, including the CEO',
    'scope summary, inside this project (including `.gstack`) or the current',
    "session's private plan directory. Use native Write/Edit with absolute paths",
    'for these documents. The fixture actor can approve those native file requests;',
    'wait for actual permission and a successful tool result before claiming a save.', '',
    'The actor cannot approve Bash permission prompts. Do not rewrite these review',
    'documents through Python, sed, shell redirection or another Bash command.',
    'Other required artifacts retain the writers specified by the skill.', '',
    'Host restrictions still apply. If a native save is denied or fails, report it',
    'and stop; do not bypass the restriction through the shell.', '',
  ].join('\n'));
  // Keep artifact writes in this fixture's workspace, not the operator HOME.
  const stateDir = path.join(projectDir, '.gstack');
  fs.mkdirSync(stateDir);
  seedHermeticGstackHome(stateDir);
  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.gstack/\nnode_modules/\npublic/styles.css\n');
  return stateDir;
}
