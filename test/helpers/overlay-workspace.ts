/** Exact task contracts for the overlay fixtures, independent of edit counts. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import type { AgentSdkResult } from './agent-sdk-runner';

const IMPLEMENTATIONS: Record<string, string> = {
  'src/auth.ts': 'export function canSignIn(active: boolean, locked: boolean) { return active || !locked; }\n',
  'src/billing.ts': 'export function totalCents(prices: number[]) { return prices.length; }\n',
  'src/notifications.ts': 'export function recipients(ids: string[]) { return ids; }\n',
};

export const LITERAL_TESTS: Record<string, string> = {
  'auth.test.ts': "import { test, expect } from 'bun:test';\nimport { canSignIn } from './src/auth';\ntest('only active, unlocked accounts sign in', () => { expect(canSignIn(true, false)).toBe(true); expect(canSignIn(false, false)).toBe(false); expect(canSignIn(true, true)).toBe(false); });\n",
  'billing.test.ts': "import { test, expect } from 'bun:test';\nimport { totalCents } from './src/billing';\ntest('sum prices in cents', () => { expect(totalCents([100, 250])).toBe(350); expect(totalCents([])).toBe(0); });\n",
  'notifications.test.ts': "import { test, expect } from 'bun:test';\nimport { recipients } from './src/notifications';\ntest('notify each recipient once, preserving first occurrence', () => { expect(recipients(['a', 'b', 'a'])).toEqual(['a', 'b']); });\n",
};

export function setupLiteralWorkspace(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const [name, text] of Object.entries({ ...IMPLEMENTATIONS, ...LITERAL_TESTS })) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# Account service\n\nRun `bun test`. The tests specify required behavior; repair implementation bugs without weakening tests.\n');
}

/** Snapshot small fixture files for validation AND post-cleanup evidence. */
export function snapshotWorkspace(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`fixture contains symlink: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).size > 256_000) throw new Error(`fixture file exceeds evidence limit: ${name}`);
        if (Object.keys(files).length >= 100) throw new Error('fixture exceeds evidence file limit');
        files[name.replaceAll(path.sep, '/')] = fs.readFileSync(full, 'utf8');
      } else throw new Error(`fixture contains unsupported entry: ${name}`);
    }
  };
  visit('');
  return files;
}

export function assertReadOnlyWorkspace(before: Record<string, string>, after: Record<string, string>): void {
  assertWorkspaceChanges(before, after, []);
}

export function assertWorkspaceChanges(before: Record<string, string>, after: Record<string, string>, allowedChanges: string[]): void {
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[name] !== after[name] && !allowedChanges.includes(name)) throw new Error(`fixture changed outside the allowed scope: ${name}`);
  }
}

export function assertOutputIncludes(result: AgentSdkResult, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    if (!pattern.test(result.output)) throw new Error(`answer is missing expected content: ${pattern}`);
  }
}

/**
 * Execute an independent oracle outside the agent's writable fixture. The
 * metric is correct target behaviors (0..3), never number of writes. Public
 * tests are immutable and unrelated writes cannot buy coverage.
 */
export function correctLiteralTargets(dir: string, deadlineAt?: number): number {
  for (const [name, source] of Object.entries(LITERAL_TESTS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, 'utf8') !== source) {
      throw new Error(`fixture test was changed or removed: ${name}`);
    }
  }
  const oracleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-oracle-'));
  try {
    const checks = [
      { file: 'src/auth.ts', code: 'const { canSignIn } = mod; for (const active of [false, true]) for (const locked of [false, true]) assert.equal(canSignIn(active, locked), active && !locked);' },
      { file: 'src/billing.ts', code: 'const { totalCents } = mod; for (const prices of [[], [0], [17], [100, 250], [7, 13, 29], [99, 1, 0]]) assert.equal(totalCents(prices), prices.reduce((a, b) => a + b, 0));' },
      { file: 'src/notifications.ts', code: "const { recipients } = mod; for (const ids of [[], ['a'], ['a', 'a'], ['z', 'a', 'z', 'b', 'a']]) { const original = [...ids]; assert.deepEqual(recipients(ids), [...new Set(original)]); assert.deepEqual(ids, original); }" },
    ];
    let passed = 0;
    for (const [index, check] of checks.entries()) {
      const remaining = deadlineAt === undefined ? 5000 : Math.min(5000, deadlineAt - Date.now());
      if (remaining <= 0) throw Object.assign(new Error('overlay case work deadline expired'), { name: 'OverlayDeadlineError' });
      const source = path.join(dir, check.file);
      if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) throw new Error(`missing regular implementation: ${check.file}`);
      const oracle = path.join(oracleDir, `check-${index}.ts`);
      fs.writeFileSync(oracle, `import assert from 'node:assert/strict';\nconst mod = await import(${JSON.stringify(source)});\n${check.code}\n`);
      const execution = spawnSync(process.execPath, [oracle], { cwd: dir, encoding: 'utf8', timeout: remaining, maxBuffer: 64_000 });
      if (execution.error) throw new Error(`behavior oracle failed for ${check.file}: ${execution.error.message}`);
      if (execution.signal) throw new Error(`behavior oracle killed for ${check.file}: ${execution.signal}`);
      if (execution.status === 0) passed++;
    }
    return passed;
  } finally {
    fs.rmSync(oracleDir, { recursive: true, force: true });
  }
}
