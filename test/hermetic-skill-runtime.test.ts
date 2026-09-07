import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getHermeticDirs, hermeticSkillsConfigDir } from './helpers/hermetic-env';
import { refreshHermeticSkillRuntime } from './helpers/hermetic-skill-runtime';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fixture(check: (source: string, privateDir: string, home: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-runtime-'));
  try {
    const source = path.join(base, 'source');
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    write(path.join(source, 'SKILL.md'), '# Router\n');
    write(path.join(source, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nCURRENT alpha\n');
    write(path.join(source, 'alpha', 'sections', 'phase.md'), 'CURRENT phase\n');
    write(path.join(source, 'VERSION'), 'CURRENT_VERSION\n');
    write(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    check(source, path.join(base, 'private'), home);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe('hermetic skill runtime', () => {
  test('registered autoplan and its nested review reads use the current private runtime', () => {
    const config = hermeticSkillsConfigDir();
    const skill = fs.readFileSync(path.join(config, 'skills', 'autoplan', 'SKILL.md'), 'utf8');
    expect(skill.includes('~/.claude/skills/gstack/')).toBe(false);
    expect(skill.includes('$HOME/.claude/skills/gstack/')).toBe(false);
    const ceo = skill.match(/Read `([^`]+\/autoplan\/sections\/ceo-phase\.md)`/)?.[1];
    expect(ceo?.startsWith(getHermeticDirs().runRoot + path.sep)).toBe(true);
    expect(fs.readFileSync(ceo!, 'utf8')).toContain('**Phase 1 complete.**');
    const review = skill.match(/`([^`]+\/plan-ceo-review\/SKILL\.md)`/)?.[1];
    const reviewSkill = fs.readFileSync(review!, 'utf8');
    const body = reviewSkill.match(/Read `([^`]+\/plan-ceo-review\/sections\/review-sections\.md)`/)?.[1];
    expect(body?.startsWith(getHermeticDirs().runRoot + path.sep)).toBe(true);
    expect(fs.existsSync(body!)).toBe(true);
  });

  test('all global forms and variable-based reads use current bins/assets; project fallbacks stay literal', () => {
    fixture((source, privateDir, home) => {
      const script = [
        'ROOT=~/.claude/skills/gstack',
        '"$HOME/.claude/skills/gstack/bin/version"',
        '"${HOME}/.claude/skills/gstack/bin/version"',
        '~/.claude/skills/gstack/bin/version',
        'cat "$ROOT/alpha/sections/phase.md"',
      ].join('\n');
      write(path.join(source, 'alpha', 'SKILL.md'), script + '\n');
      write(path.join(source, 'alpha', 'sections', 'phase.md'), 'Read ~/.claude/skills/gstack/alpha/SKILL.md\n');
      write(path.join(source, 'alpha', 'sections', 'fallbacks.md'), '.claude/skills/gstack\n$_ROOT/.claude/skills/gstack\n~/.claude/skills/gstack-upgrade\n');
      write(path.join(source, 'bin', 'version'), '#!/usr/bin/env bash\nROOT=$(cd "$(dirname "$0")/.." && pwd)\ncat "$ROOT/VERSION"\n');
      fs.chmodSync(path.join(source, 'bin', 'version'), 0o755);
      const old = path.join(home, '.claude', 'skills', 'gstack', 'bin', 'version');
      write(old, '#!/usr/bin/env bash\nprintf STALE_OPERATOR\n');
      fs.chmodSync(old, 0o755);
      const config = refreshHermeticSkillRuntime(source, privateDir);
      const runtime = path.join(privateDir, 'runtime');
      const bound = read(path.join(config, 'skills', 'alpha', 'SKILL.md'));
      const output = execFileSync('bash', ['-c', bound], { env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 5000 });
      expect(output).toBe(`CURRENT_VERSION\nCURRENT_VERSION\nCURRENT_VERSION\nRead ${runtime}/alpha/SKILL.md\n`);
      expect(read(path.join(runtime, 'alpha', 'sections', 'fallbacks.md')))
        .toBe(read(path.join(source, 'alpha', 'sections', 'fallbacks.md')));
      expect(read(old)).toContain('STALE_OPERATOR');
      expect(fs.realpathSync(path.join(runtime, '.git'))).toBe(path.join(source, '.git'));
      fs.rmSync(privateDir, { recursive: true, force: true });
      expect(read(path.join(source, '.git', 'HEAD'))).toBe('ref: refs/heads/main\n');
      expect(read(path.join(source, 'alpha', 'SKILL.md'))).toBe(script + '\n');
    });
  });

  test('later refreshes preserve paths and config while updating, adding, and retiring live documents', () => {
    fixture((source, privateDir) => {
      const config = refreshHermeticSkillRuntime(source, privateDir);
      const skill = path.join(config, 'skills', 'alpha', 'SKILL.md');
      const runtime = path.join(privateDir, 'runtime');
      const originalTarget = fs.realpathSync(skill);
      const originalInode = fs.statSync(skill).ino;
      write(path.join(config, '.claude.json'), '{"session":"keep"}');
      write(path.join(config, 'plans', 'keep.md'), 'plan evidence');
      expect(refreshHermeticSkillRuntime(source, privateDir)).toBe(config);
      expect(fs.statSync(skill).ino).toBe(originalInode); // unchanged docs are not rewritten
      write(path.join(source, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nUPDATED alpha\n');
      write(path.join(source, 'alpha', 'sections', 'phase.md'), 'UPDATED phase\n');
      write(path.join(source, 'alpha', 'sections', 'new.md'), 'NEW phase\n');
      write(path.join(source, 'beta', 'SKILL.md'), '---\nname: beta\n---\nNEW beta\n');
      write(path.join(source, 'VERSION'), 'LIVE_ASSET\n');
      expect(read(path.join(runtime, 'VERSION'))).toBe('LIVE_ASSET\n');
      expect(refreshHermeticSkillRuntime(source, privateDir)).toBe(config);
      expect(fs.realpathSync(skill)).toBe(originalTarget);
      expect(fs.statSync(skill).ino).not.toBe(originalInode); // changed docs are replaced atomically
      expect(read(skill)).toContain('UPDATED alpha');
      expect(fs.readdirSync(path.join(config, 'skills')).sort()).toEqual(['_gstack-command', 'alpha', 'beta']);
      expect(fs.readdirSync(path.join(runtime, 'alpha', 'sections')).sort()).toEqual(['new.md', 'phase.md']);
      expect(read(path.join(runtime, 'alpha', 'sections', 'phase.md'))).toBe('UPDATED phase\n');
      expect(read(path.join(config, '.claude.json'))).toBe('{"session":"keep"}');
      expect(read(path.join(config, 'plans', 'keep.md'))).toBe('plan evidence');
      fs.rmSync(path.join(source, 'beta'), { recursive: true });
      fs.unlinkSync(path.join(source, 'alpha', 'sections', 'phase.md'));
      refreshHermeticSkillRuntime(source, privateDir);
      expect(fs.existsSync(path.join(config, 'skills', 'beta'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'beta'))).toBe(false);
      expect(fs.readdirSync(path.join(runtime, 'alpha', 'sections'))).toEqual(['new.md']);
      fs.rmSync(path.join(source, 'alpha', 'sections'), { recursive: true });
      refreshHermeticSkillRuntime(source, privateDir);
      expect(fs.existsSync(path.join(config, 'skills', 'alpha', 'sections'))).toBe(false);
    });
  });

  test('refresh never writes or cleans through substituted destination symlinks', () => {
    fixture((source, privateDir, home) => {
      const config = refreshHermeticSkillRuntime(source, privateDir);
      const runtime = path.join(privateDir, 'runtime');
      write(path.join(home, 'sentinel'), 'operator stays untouched');
      const original = read(path.join(source, 'alpha', 'SKILL.md'));
      for (const target of [path.join(runtime, 'alpha', 'sections'), path.join(config, 'skills', 'alpha')]) {
        fs.rmSync(target, { recursive: true });
        fs.symlinkSync(home, target, 'dir');
      }
      fs.unlinkSync(path.join(runtime, 'alpha', 'SKILL.md'));
      fs.symlinkSync(path.join(source, 'alpha', 'SKILL.md'), path.join(runtime, 'alpha', 'SKILL.md'));
      fs.symlinkSync(home, path.join(runtime, 'retired'), 'dir');
      refreshHermeticSkillRuntime(source, privateDir);
      expect(read(path.join(source, 'alpha', 'SKILL.md'))).toBe(original);
      expect(fs.readdirSync(home)).toEqual(['sentinel']);
      expect(fs.lstatSync(path.join(runtime, 'alpha', 'sections')).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(config, 'skills', 'alpha')).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(runtime, 'alpha', 'SKILL.md')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'retired'))).toBe(false);
    });
  });

  test('unsafe paths and a failed first refresh do not publish a partial tree', () => {
    fixture((source, privateDir, home) => {
      for (const suffix of [' space', '$dollar', ';command', '\nnewline']) {
        expect(() => refreshHermeticSkillRuntime(source, privateDir + suffix)).toThrow('Set TMPDIR');
        expect(fs.existsSync(privateDir + suffix)).toBe(false);
      }
      fs.symlinkSync(home, privateDir, 'dir');
      expect(() => refreshHermeticSkillRuntime(source, privateDir)).toThrow('real directory');
      expect(fs.readdirSync(home)).toEqual([]);
      fs.unlinkSync(privateDir);
      fs.symlinkSync(path.join(source, 'missing'), path.join(source, 'alpha', 'sections', 'missing.md'));
      expect(() => refreshHermeticSkillRuntime(source, privateDir)).toThrow('ENOENT');
      expect(fs.existsSync(privateDir)).toBe(false);
      expect(read(path.join(source, 'VERSION'))).toBe('CURRENT_VERSION\n');
    });
  });

  test('cached seeding refreshes derived bytes before returning without resetting Claude config', () => {
    const config = hermeticSkillsConfigDir();
    const skill = path.join(config, 'skills', 'autoplan', 'SKILL.md');
    const expected = read(skill);
    const seed = read(path.join(config, '.claude.json'));
    write(fs.realpathSync(skill), 'stale derived document');
    expect(hermeticSkillsConfigDir()).toBe(config);
    expect(read(skill) === expected).toBe(true);
    expect(read(path.join(config, '.claude.json'))).toBe(seed);
  });

  test('cached seeding repairs a substituted config directory without writing through it', () => {
    fixture((_source, _privateDir, home) => {
      const config = hermeticSkillsConfigDir();
      write(path.join(home, '.claude.json'), '{"operator":"untouched"}');
      fs.rmSync(config, { recursive: true });
      fs.symlinkSync(home, config, 'dir');
      expect(hermeticSkillsConfigDir()).toBe(config);
      expect(fs.lstatSync(config).isDirectory()).toBe(true);
      expect(JSON.parse(read(path.join(config, '.claude.json'))).hasCompletedOnboarding).toBe(true);
      expect(read(path.join(home, '.claude.json'))).toBe('{"operator":"untouched"}');
      expect(fs.readdirSync(home)).toEqual(['.claude.json']);
    });
  });

  test('real runtime preamble and update helper resolve current bins, VERSION, and git metadata', () => {
    fixture((_source, _privateDir, home) => {
      const config = hermeticSkillsConfigDir();
      const runtime = path.join(path.dirname(config), 'runtime');
      const state = path.join(home, '.gstack');
      const commands = path.join(home, 'commands');
      const old = path.join(home, '.claude', 'skills', 'gstack', 'bin', 'gstack-skill-start');
      write(old, '#!/usr/bin/env bash\nprintf STALE_OPERATOR\n');
      fs.chmodSync(old, 0o755);
      write(path.join(commands, 'curl'), '#!/usr/bin/env bash\nprintf blocked > "$HOME/network-attempt"\nexit 1\n');
      fs.chmodSync(path.join(commands, 'curl'), 0o755);
      write(path.join(state, 'config.yaml'), 'update_check: false\nartifacts_sync_mode_prompted: true\n');
      const env = { PATH: `${commands}${path.delimiter}${process.env.PATH!}`, HOME: home, GSTACK_HOME: state };
      const preamble = read(path.join(config, 'skills', 'autoplan', 'SKILL.md'))
        .match(/## Preamble \(run first\)\n\n```bash\n([\s\S]*?)\n```/)![1];
      const output = execFileSync('bash', ['-c', preamble], { cwd: home, env, encoding: 'utf8', timeout: 20_000 });
      expect(output).toContain('SKILL_START_PROTO: 1');
      expect(output).not.toContain('STALE_OPERATOR');
      const version = read(path.join(ROOT, 'VERSION')).trim();
      write(path.join(state, 'config.yaml'), 'update_check: true\n');
      write(path.join(state, '.codex-desc-healed'), '');
      write(path.join(state, 'last-update-check'), `UP_TO_DATE ${version}\n`);
      write(path.join(state, 'just-upgraded-from'), 'TEST_OLD\n');
      expect(execFileSync(path.join(runtime, 'bin', 'gstack-update-check'), [], { cwd: home, env, encoding: 'utf8', timeout: 10_000 }))
        .toBe(`JUST_UPGRADED TEST_OLD ${version}\n`);
      expect(fs.existsSync(path.join(home, 'network-attempt'))).toBe(false);
      const gitDir = (cwd: string) => fs.realpathSync(path.resolve(cwd,
        execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5000 }).trim()));
      expect(gitDir(runtime)).toBe(gitDir(ROOT));
      expect(read(old)).toContain('STALE_OPERATOR');
    });
  });

  test('a first .claude.json write failure cleans the runtime and preserves the original error', () => {
    fixture((_source, privateDir, home) => {
      const script = `
        import { spyOn } from 'bun:test';
        import * as fs from 'node:fs';
        import * as path from 'node:path';
        import { getHermeticDirs, hermeticSkillsConfigDir } from ${JSON.stringify(path.join(ROOT, 'test/helpers/hermetic-env.ts'))};
        const dirs = getHermeticDirs();
        const expected = new Error('seed-write-failed');
        const original = fs.writeFileSync;
        const spy = spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
          if (String(file).endsWith('/with-skills/.claude/.claude.json')) throw expected;
          return original(file, ...args);
        });
        let sameError = false;
        try { hermeticSkillsConfigDir(); } catch (error) { sameError = error === expected; }
        spy.mockRestore();
        const removed = !fs.existsSync(path.join(dirs.runRoot, 'with-skills'));
        const config = hermeticSkillsConfigDir();
        console.log(JSON.stringify({ sameError, removed, retrySeeded: fs.existsSync(path.join(config, '.claude.json')) }));
      `;
      fs.mkdirSync(privateDir);
      const result = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT, env: { PATH: process.env.PATH!, HOME: home, TMPDIR: privateDir, EVALS_HERMETIC: '1' }, encoding: 'utf8', timeout: 20_000,
      });
      expect(JSON.parse(result)).toEqual({ sameError: true, removed: true, retrySeeded: true });
      expect(fs.readdirSync(privateDir)).toEqual([]); // process-exit cleanup owns the completed tree
    });
  });
});
