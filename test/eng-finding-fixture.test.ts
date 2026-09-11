import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedEngFindingProject } from './helpers/eng-finding-fixture';
import { legacyAuthFlow, POLICIES, AuthFailure, type Platform, type Policy } from './fixtures/eng-existing-auth/legacy-auth';

const identity = Object.freeze({ tenantId: 'tenant-a', subjectId: 'subject-a' });
const session = { id: 'opaque-session', expiresAt: 3_600_000 };

test('Eng fixture commits a real legacy flow alongside the unchanged supplied defects', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-finding-fixture-'));
  try {
    const defects = '# Proposed refactor\nBoth services mutate a global cache.\nNo regression test is planned.\n';
    const input = seedEngFindingProject(cwd, defects);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    expect(input.startsWith(defects)).toBe(true);
    expect(git('show', 'HEAD:review-input.md')).toBe(input);
    expect(git('show', 'HEAD:src/legacy-auth.ts')).toBe(fs.readFileSync(path.resolve(import.meta.dir, 'fixtures/eng-existing-auth/legacy-auth.ts'), 'utf8'));
    const pkg = git('show', 'HEAD:package.json');
    expect(pkg).toBe(fs.readFileSync(path.resolve(import.meta.dir, 'fixtures/eng-existing-auth/package.json'), 'utf8'));
    expect(JSON.parse(pkg).scripts.test).toBe('bun test');
    expect(input).toContain('POLICIES order, not response-arrival order');
    expect(input).toContain('prior build artifact for rollback');
    expect(input).toContain('reserve concurrency and rate capacity for five policy calls');
    expect(input).not.toContain('reverting that\nflag restores');
    expect(git('diff', 'origin/main...HEAD')).toBe('');
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.readdirSync(path.join(cwd, 'src'))).toEqual(['legacy-auth.ts']);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('legacy flow has five sequential independent calls and issues a session only after all allow', async () => {
  const called: Policy[] = [];
  const pending: Array<(allow: boolean) => void> = [];
  let minted = 0;
  const result = legacyAuthFlow(identity, {
    checkPolicy: (actual, policy) => {
      expect(actual).toBe(identity);
      called.push(policy);
      return new Promise(resolve => pending.push(resolve));
    },
    issueSession: async actual => { expect(actual).toBe(identity); minted++; return session; },
  });
  for (let i = 0; i < POLICIES.length; i++) {
    expect(called).toEqual(POLICIES.slice(0, i + 1));
    expect(minted).toBe(0);
    pending[i]!(true);
    await Promise.resolve();
  }
  expect(await result).toBe(session);
  expect(minted).toBe(1);
});

test.each(['denied', 'provider_unavailable', 'session_unavailable'] as const)('legacy %s remains an explicit failure', async code => {
  const cause = new Error('dependency failure');
  let minted = 0;
  const platform: Platform = {
    checkPolicy: async () => { if (code === 'provider_unavailable') throw cause; return code !== 'denied'; },
    issueSession: async () => { minted++; throw cause; },
  };
  const failure = await legacyAuthFlow(identity, platform).catch(error => error);
  expect(failure).toBeInstanceOf(AuthFailure);
  expect(failure.code).toBe(code);
  expect(failure.cause).toBe(code === 'denied' ? undefined : cause);
  expect(minted).toBe(code === 'session_unavailable' ? 1 : 0);
});


test('existing policy-order failure and short-circuit behavior stay unchanged', async () => {
  const called: Policy[] = [];
  let minted = false;
  const result = await legacyAuthFlow(identity, {
    checkPolicy: async (_identity, policy) => {
      called.push(policy);
      if (policy === 'tenant') return false;
      if (policy === 'device') throw new Error('later unavailable policy');
      return true;
    },
    issueSession: async () => { minted = true; return session; },
  }).catch(error => error);
  expect(result).toBeInstanceOf(AuthFailure);
  expect(result.code).toBe('denied');
  expect(called).toEqual(['account', 'tenant']);
  expect(minted).toBe(false);
});


test.each(['synchronous throw', 'promise rejection'] as const)('legacy preserves the same provider failure contract for %s', async mode => {
  const cause = new Error('policy client failure');
  const called: Policy[] = [];
  let minted = false;
  const platform: Platform = {
    checkPolicy: (_identity, policy) => {
      called.push(policy);
      if (mode === 'synchronous throw') throw cause;
      return Promise.reject(cause);
    },
    issueSession: async () => { minted = true; return session; },
  };
  const failure = await legacyAuthFlow(identity, platform).catch(error => error);
  expect(failure).toBeInstanceOf(AuthFailure);
  expect(failure.code).toBe('provider_unavailable');
  expect(failure.cause).toBe(cause);
  expect(called).toEqual(['account']);
  expect(minted).toBe(false);
});
