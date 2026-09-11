import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { repositoryPlanFixtures } from './helpers/carve-plan-fixture';
import { setupSkillDir } from './helpers/auq-sdk-capture';
import { CounterRepository } from './fixtures/carve-existing-repository/src/repository';

test.each(['plan-eng-review', 'plan-devex-review'] as const)('%s fixture supplies its existing implementation, companion reference, and runnable quickstart', skill => {
  const plan = '# Proposed cache\nStore 1000 keys and invalidate on write.\n';
  const fixtures = repositoryPlanFixtures(plan, skill);
  const dir = setupSkillDir({ skillName: skill, skillMd: '# Review', fixtures });
  try {
    expect(fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8').startsWith(plan + '\n')).toBe(true);
    const example = Bun.spawnSync([process.execPath, 'run', 'example.ts'], { cwd: dir, timeout: 5000 });
    expect(example.exitCode, example.stderr.toString()).toBe(0);
    expect(example.stdout.toString()).toBe('2 2 undefined\n');
    expect(fixtures['README.md']).toContain('Both known-key reads currently query SQLite');
    expect(fixtures['src/repository.ts']).not.toMatch(/new Map|LRU|cache\./);
    const companion = skill === 'plan-devex-review' ? 'plan-devex-review/dx-hall-of-fame.md' : 'review/TODOS-format.md';
    expect(fs.readFileSync(path.join(dir, companion), 'utf8')).toBe(fs.readFileSync(path.resolve(import.meta.dir, '..', companion), 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing point reads always see committed writes and preserve missing/error distinctions', () => {
  const db = new Database(':memory:');
  try {
    const repo = new CounterRepository(db);
    expect(repo.get('missing')).toBeUndefined();
    repo.set('orders', 2);
    expect(repo.get('orders')).toBe(2);
    repo.set('orders', 3);
    expect(repo.get('orders')).toBe(3);
    expect(() => repo.get('')).toThrow('Counter key');
    expect(() => repo.set('orders', Number.NaN)).toThrow('finite number');
    expect(repo.get('orders')).toBe(3);
  } finally { db.close(); }
  expect(() => new CounterRepository(db)).toThrow();
});


test('engineering plan appends an unapproved implementation proposal without changing the DX fixture or existing code', () => {
  const plan = '# Proposed cache\nStore 1000 keys and invalidate on write.\n';
  const dir = path.resolve(import.meta.dir, 'fixtures/carve-existing-repository');
  const existing = '\n## Existing project\nRead `README.md` and `src/repository.ts` for the current API and runtime.\nThe change adds the cache to that repository; the existing example must keep working.\n';
  const eng = repositoryPlanFixtures(plan, 'plan-eng-review');
  const dx = repositoryPlanFixtures(plan, 'plan-devex-review');
  const appendix = fs.readFileSync(path.join(dir, 'engineering-cache-plan.md'), 'utf8');
  const baseline = Object.fromEntries(['README.md', 'src/repository.ts', 'example.ts'].map(file => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
  expect(dx).toEqual({
    'PLAN.md': plan + existing,
    ...baseline,
    'plan-devex-review/dx-hall-of-fame.md': fs.readFileSync(path.resolve(import.meta.dir, '../plan-devex-review/dx-hall-of-fame.md'), 'utf8'),
  });
  expect(eng).toEqual({
    'PLAN.md': plan + existing + '\n' + appendix,
    ...baseline,
    'review/TODOS-format.md': fs.readFileSync(path.resolve(import.meta.dir, '../review/TODOS-format.md'), 'utf8'),
  });
  expect(appendix).toContain('subject to this review');
  expect(appendix).toContain('not implemented or approved');
  expect(appendix).toContain('Do not claim these tests already exist or pass');
});

test('existing repository objects and separate SQLite handles observe each other’s committed writes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-carve-baseline-'));
  const firstDb = new Database(path.join(temp, 'counters.sqlite'));
  const secondDb = new Database(path.join(temp, 'counters.sqlite'));
  try {
    const first = new CounterRepository(firstDb);
    const sibling = new CounterRepository(firstDb);
    const secondHandle = new CounterRepository(secondDb);
    expect(sibling.get('orders')).toBeUndefined();
    expect(secondHandle.get('orders')).toBeUndefined();
    first.set('orders', 2);
    expect(sibling.get('orders')).toBe(2);
    expect(secondHandle.get('orders')).toBe(2);
    secondHandle.set('orders', 3);
    expect(first.get('orders')).toBe(3);
    expect(sibling.get('orders')).toBe(3);
  } finally {
    secondDb.close();
    firstDb.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('existing scalar round trips and database errors remain distinct from missing values', () => {
  const db = new Database(':memory:');
  const repo = new CounterRepository(db);
  try {
    repo.set('zero', -0);
    expect(Object.is(repo.get('zero'), 0)).toBe(true);
    expect(Object.is(repo.get('zero'), -0)).toBe(false);
    expect(repo.get('missing')).toBeUndefined();
    repo.set('orders', 2);
    expect(() => repo.set('orders', Number.POSITIVE_INFINITY)).toThrow('finite number');
    expect(repo.get('orders')).toBe(2);
    expect(() => repo.get('')).toThrow('Counter key');
  } finally { db.close(); }
  expect(() => repo.get('zero')).toThrow();
  expect(() => repo.set('orders', 4)).toThrow();
});
