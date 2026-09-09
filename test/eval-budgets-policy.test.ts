/**
 * Two invariants over paid-test timeout policy:
 *
 * 1. FIT: every tier in test/helpers/eval-budgets.ts executes inside the
 *    sharded runner's wall with real overhead (bun startup + module load +
 *    reporting). A budget the wall kills first is fiction — the failure
 *    surfaces as a shard 'timed-out' (no bun summary, no per-test message)
 *    instead of a clean test timeout. This is the structural fix for the
 *    seven 1,700s-inside-a-1,500s-job literals found in the 2026-08 audit.
 *
 * 2. RATCHET: raw numeric timeout literals in paid test files only shrink.
 *    New tests use the tiers; a literal is legal only with justification,
 *    and the count is pinned so sprawl can't regrow.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ALL_TIERS, PTY_LONG_MS } from './helpers/eval-budgets';
import { PLAN_SKILL_COUNT_FINALIZE_MS } from './helpers/claude-pty-runner';
import { isPaidTestFile } from './helpers/paid-test-set';
import { DEFAULT_SHARD_TIMEOUT_MS } from '../scripts/test-paid-shards';

const ROOT = path.resolve(__dirname, '..');

/** Wall overhead reserve: bun startup, module load, retry bookkeeping. */
const WALL_OVERHEAD_MS = 120_000;

describe('eval budget tiers', () => {
  test('every tier fits inside the shard wall minus overhead', () => {
    for (const [name, ms] of Object.entries(ALL_TIERS)) {
      expect(ms, `${name} exceeds the shard wall minus overhead`)
        .toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS - WALL_OVERHEAD_MS);
    }
  });

  test('tiers are ordered and the ceiling is PTY_LONG', () => {
    const values = Object.values(ALL_TIERS);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(Math.max(...values)).toBe(PTY_LONG_MS);
  });

  test('counting cases retain 25-minute work budgets including setup, plus cleanup only', () => {
    const files = ['test/skill-e2e-plan-ceo-finding-count.test.ts', 'test/skill-e2e-plan-ceo-paired-control.test.ts', 'test/skill-e2e-plan-ceo-split-overflow.test.ts', 'test/skill-e2e-plan-eng-finding-count.test.ts', 'test/skill-e2e-plan-design-finding-count.test.ts', 'test/skill-e2e-plan-devex-finding-count.test.ts', 'test/skill-e2e-plan-eng-multi-finding-batching.test.ts'];
    expect(PLAN_SKILL_COUNT_FINALIZE_MS).toBe(10_000);
    expect(1_500_000).toBeLessThanOrEqual(PTY_LONG_MS * 1.25);
    expect(1_500_000 + PLAN_SKILL_COUNT_FINALIZE_MS + WALL_OVERHEAD_MS).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);
    let cases = 0;
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const bodies = source.split('    async () => {').slice(1);
      expect(bodies.length, `${file} must own one process budget`).toBe(1);
      const outerBudgets = source.match(/1_500_000 \+ PLAN_SKILL_COUNT_FINALIZE_MS/g) ?? [];
      expect(outerBudgets.length, file).toBe(bodies.length);
      for (const body of bodies) {
        cases++;
        const start = body.indexOf('const caseStartedAt = Date.now();');
        expect(start, file).toBeGreaterThanOrEqual(0);
        expect(start, file).toBeLessThan(body.indexOf('fs.mkdtempSync('));
        expect(body, file).toContain('timeoutMs: 1_500_000 - (Date.now() - caseStartedAt)');
      }
    }
    expect(cases).toBe(7);
  });

  test('deploy workflow sessions use capture budgets, not single-call judge budgets', () => {
    const source = fs.readFileSync(path.join(ROOT, 'test/skill-e2e-deploy.test.ts'), 'utf8');
    expect(source).not.toContain('JUDGE_MS');
    expect([...source.matchAll(/timeout:\s*CAPTURE_MS/g)]).toHaveLength(6);
    expect([...source.matchAll(/\},\s*CAPTURE_LONG_MS\);/g)]).toHaveLength(6);
  });

  test('no paid-test timeout literal exceeds the ceiling tier', () => {
    const out = spawnSync('git', ['ls-files', 'test/*.test.ts'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
    const files = out.stdout.split('\n').filter((f) => f && isPaidTestFile(f));
    expect(files.length).toBeGreaterThan(50); // scan-rot guard

    const offenders: string[] = [];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // Trailing test-timeout args: `}, 1_234_000);` / `}, 300000);`
      for (const m of source.matchAll(/\}\s*,\s*(\d[\d_]*)\s*(?:\/\*[^*]*\*\/\s*)?\)/g)) {
        const ms = Number(m[1].replaceAll('_', ''));
        if (ms > PTY_LONG_MS * 1.25) offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders,
      `paid-test timeouts above the PTY_LONG ceiling (x1.25 slack) are fiction ` +
      `against the ${DEFAULT_SHARD_TIMEOUT_MS / 1000}s shard wall — split the test instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
