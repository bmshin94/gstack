import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');

test('the ship section case supplies a real version-changing branch with a working regression test', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-section-body-'));
  const script = path.join(temp, 'capture.fixture.test.ts');
  fs.writeFileSync(script, `
import { mock, describe, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as capture from ${JSON.stringify(path.join(ROOT, 'test/helpers/auq-sdk-capture.ts'))};
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({ describeE2ETier: () => describe }));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/auq-sdk-capture.ts'))}, () => ({ ...capture,
  captureSectionReads: async opts => {
    const cwd = opts.planDir;
    try {
      const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      expect(git('status', '--porcelain')).toBe('');
      expect(git('branch', '--show-current')).not.toBe('main');
      expect(git('diff', '--name-only', 'origin/main...HEAD').split('\\n')).toEqual(['app.js', 'app.test.js']);
      expect(git('show', 'origin/main:app.js')).not.toContain('newThing');
      expect(git('show', 'HEAD:app.js')).toContain('newThing');
      expect(git('show', 'origin/main:VERSION')).toBe(fs.readFileSync(path.join(cwd, 'VERSION'), 'utf8').trim());
      const runTest = () => spawnSync(process.execPath, ['test', 'app.test.js'], { cwd, encoding: 'utf8', timeout: 5000 });
      const green = runTest();
      expect(green.status, green.stderr).toBe(0);
      fs.writeFileSync(path.join(cwd, 'app.js'), 'export function newThing() { return 0; }\\n');
      const red = runTest();
      expect(red.status, red.stderr).toBe(1);
      expect(red.stderr).toContain('Expected: 42');
      return { readSections: new Set(['review-army.md', 'changelog.md']), reportProduced: true, output: 'Reviewed fixture. '.repeat(20) };
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-ship-section-loading.test.ts'))});
`);
  try {
    const result = spawnSync(process.execPath, ['test', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', TMPDIR: temp, TMP: temp, TEMP: temp },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(temp)).toEqual(['capture.fixture.test.ts']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}, 15_000);
