/** Bind live skill instructions to this checkout without changing HOME. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '../../lib/fs-atomic';
import { frontmatterName, skillCensus } from './skill-census';

// Match the install root, not similarly named siblings such as gstack-upgrade.
// Relative .claude/skills/gstack and project-root fallbacks remain untouched.
const GLOBAL_ROOT = /(?:~|\$HOME|\$\{HOME\})\/\.claude\/skills\/gstack(?![\w.-])/g;
const stat = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
const remove = (file: string) => fs.rmSync(file, { recursive: true, force: true });

function directory(file: string): void {
  const existing = stat(file);
  if (existing?.isDirectory()) return;
  if (existing) remove(file); // lstat + rm unlinks a symlink; never enter it.
  fs.mkdirSync(file);
}

function link(source: string, target: string): void {
  const existing = stat(target);
  if (existing?.isSymbolicLink() && fs.readlinkSync(target) === source) return;
  if (existing) remove(target);
  fs.symlinkSync(source, target, fs.statSync(source, { throwIfNoEntry: false })?.isDirectory() ? 'dir' : 'file');
}

function document(source: string, target: string, runtimeRoot: string): void {
  const content = fs.readFileSync(source, 'utf8').replace(GLOBAL_ROOT, () => runtimeRoot);
  const existing = stat(target);
  if (existing?.isFile() && fs.readFileSync(target, 'utf8') === content) return;
  if (existing?.isDirectory()) remove(target);
  atomicWriteSync(target, content); // Rename replaces a destination symlink itself.
}

/**
 * Refresh before EVERY seeded launch, including cached config returns. Only
 * generated instructions are derived copies; other paths (bin, VERSION, .git,
 * assets) remain live source symlinks. One root also handles variable-based
 * references such as ROOT=... followed by "$ROOT/plan-ceo-review/SKILL.md".
 * The private tree belongs to the caller's hermetic runRoot exit/GC lifecycle.
 */
export function refreshHermeticSkillRuntime(sourceRoot: string, privateDir: string): string {
  sourceRoot = path.resolve(sourceRoot);
  privateDir = path.resolve(privateDir);
  // The same replacement appears in prose, quoted shell, and unquoted shell.
  // Reject unsafe paths rather than inventing a Markdown/shell quoting parser.
  if (!/^\/[A-Za-z0-9_./-]+$/.test(privateDir)) {
    throw new Error('Hermetic skill runtime requires a shell-safe temporary path. Set TMPDIR to a path without spaces or shell metacharacters (for example /tmp) and retry.');
  }
  if (privateDir === sourceRoot || privateDir.startsWith(sourceRoot + path.sep)) {
    throw new Error('Hermetic skill runtime must be outside the source checkout');
  }
  const runtimeRoot = path.join(privateDir, 'runtime');
  const configDir = path.join(privateDir, '.claude');
  const skillsDir = path.join(configDir, 'skills');
  const docs = new Set<string>();
  const directories = new Set<string>(['.']);
  const registry = new Map<string, string>();
  for (const rel of skillCensus(sourceRoot).physicalSkillFiles) {
    docs.add(rel);
    const name = rel === 'SKILL.md' ? '_gstack-command' : frontmatterName(path.join(sourceRoot, rel)) || path.dirname(rel);
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new Error(`Invalid hermetic skill registry name: ${name}`);
    }
    registry.set(name, rel);
    const sections = path.join(path.dirname(rel), 'sections');
    if (rel !== 'SKILL.md' && fs.existsSync(path.join(sourceRoot, sections))) {
      for (const file of fs.readdirSync(path.join(sourceRoot, sections))) {
        if (file.endsWith('.md')) docs.add(path.join(sections, file));
      }
    }
  }
  for (const doc of docs) {
    let parent = path.dirname(doc);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.dirname(parent);
    }
  }

  function mirror(rel: string): void {
    const target = path.join(runtimeRoot, rel);
    directory(target);
    const entries = fs.readdirSync(path.join(sourceRoot, rel));
    for (const name of entries) {
      const child = path.join(rel, name);
      const source = path.join(sourceRoot, child);
      const dest = path.join(runtimeRoot, child);
      if (docs.has(child)) document(source, dest, runtimeRoot);
      else if (directories.has(child)) mirror(child);
      else link(source, dest);
    }
    for (const name of fs.readdirSync(target)) {
      if (!entries.includes(name)) remove(path.join(target, name));
    }
  }

  const existed = stat(privateDir);
  // The caller owns this directory. Refuse to publish through a substituted
  // parent, while repairing substituted runtime/registry children below it.
  if (existed && !existed.isDirectory()) throw new Error('Hermetic skill runtime parent must be a real directory');
  try {
    directory(privateDir);
    mirror('.');
    directory(configDir);
    directory(skillsDir);
    for (const [name, rel] of registry) {
      const target = path.join(skillsDir, name);
      directory(target);
      link(path.join(runtimeRoot, rel), path.join(target, 'SKILL.md'));
      const sections = path.join(runtimeRoot, path.dirname(rel), 'sections');
      if (rel !== 'SKILL.md' && fs.existsSync(sections)) link(sections, path.join(target, 'sections'));
      else remove(path.join(target, 'sections'));
    }
    for (const name of fs.readdirSync(skillsDir)) {
      if (!registry.has(name)) remove(path.join(skillsDir, name));
    }
  } catch (error) {
    if (!existed) remove(privateDir);
    throw error;
  }
  return configDir;
}


/** Only the two on-demand question-format companions need outside-cwd Read.
 * Keep both lexical and real paths: the CLI checks every symlink resolution.
 */
export function questionCompanionReadSettings(sourceRoot: string, runtimeRoot: string): { permissions: { allow: string[] } } {
  const source = fs.realpathSync(sourceRoot);
  const files = new Set<string>();
  for (const name of ['askuserquestion-split.md', 'askuserquestion-cjk.md']) {
    const expected = path.join(source, 'docs', name);
    const lexical = path.resolve(runtimeRoot, 'docs', name);
    if (!fs.lstatSync(expected).isFile() || fs.realpathSync(lexical) !== expected) {
      throw new Error('Question companion must resolve to its exact source document');
    }
    files.add(lexical); files.add(expected);
  }
  const allow = [...files].map(file => {
    const absolute = file.split(path.sep).join('/');
    // These exact file rules do not need glob syntax. The pinned CLI has two
    // pattern parsers; reject unsupported syntax instead of widening a grant.
    if (/[\x00-\x1f\x7f\\*?\[\]{}()|+^$]/.test(absolute)) {
      throw new Error('Question companion path contains unsupported permission-pattern syntax');
    }
    return `Read(${absolute.startsWith('/') ? '/' : ''}${absolute})`;
  });
  return { permissions: { allow } };
}
