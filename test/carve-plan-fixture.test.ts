import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
