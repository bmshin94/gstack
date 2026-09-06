/** Project setup shared by the paid autoplan chain and its free preamble check. */
import * as fs from 'node:fs';
import * as path from 'node:path';

const UI_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'plans', 'ui-heavy-feature.md');

export function seedAutoplanProject(projectDir: string): void {
  const plansDir = path.join(projectDir, '.claude', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.copyFileSync(UI_FIXTURE, path.join(plansDir, 'ui-heavy-feature.md'));
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# Autoplan chain fixture\n');
  // The chain exercises review phases in an already configured project.
  // Use skill-start's canonical project marker, preserving user-state defaults.
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Autoplan chain fixture\n\n## Skill routing\n\n- Full review pipeline → invoke /autoplan.\n');
}
