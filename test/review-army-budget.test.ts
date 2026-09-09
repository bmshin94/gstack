import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('consensus drains its timed-out capture before Bun retries or removes the fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-army-finalization-'));
  try {
    const script = path.join(dir, 'consensus.test.ts');
    fs.writeFileSync(script, `
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSkillSections, REVIEW_ARMY_E2E_SECTIONS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/skill-fixture.ts'))};
const root = ${JSON.stringify(ROOT)};
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  fs.readFileSync(path.join(root, 'test/skill-e2e-review-army.test.ts'), 'utf8'),
).replace(/^import\\b[^;]*;\\s*$/gm, '');
let attempts = 0;
const records = [], registrations = [], captureOptions = [];
// These scaled values exercise native Bun retry/afterAll ordering without a
// provider. Capture returns only after its work timeout and a separate drain.
const captureMs = 100, drainMs = 40;
const run = async opts => {
  const attempt = ++attempts;
  captureOptions.push({ timeout: opts.timeout, maxTurns: opts.maxTurns });
  if (attempt === 1) await Bun.sleep(captureMs + drainMs);
  else await Bun.sleep(50);
  expect(fs.existsSync(opts.workingDirectory)).toBe(true);
  if (attempt === 2) fs.writeFileSync(path.join(opts.workingDirectory, 'review-output.md'), 'SQL injection');
  return { exitReason: attempt === 1 ? 'timeout' : 'success' };
};
new Function('describe', 'test', 'expect', 'beforeAll', 'afterAll',
  'JUDGE_MS', 'CAPTURE_MS', 'SESSION_DRAIN_GRACE_MS', 'runSkillTest',
  'ROOT', 'runId', 'describeIfSelected', 'testConcurrentIfSelected',
  'logCost', 'recordE2E', 'createEvalCollector', 'finalizeEvalCollector',
  'extractSkillSections', 'REVIEW_ARMY_E2E_SECTIONS', 'spawnSync', 'fs', 'path', 'os', source)(
  describe, test, expect, beforeAll, afterAll, 120_000, captureMs, drainMs, run,
  root, 'free-consensus', (name, ids, body) => { if (ids.includes('review-army-consensus')) describe(name, body); },
  (id, body, outer) => { registrations.push({ id, outer }); test.concurrent(id, body, outer); },
  () => {}, (_collector, _name, _suite, result) => records.push(result.exitReason),
  () => null, () => {}, extractSkillSections, REVIEW_ARMY_E2E_SECTIONS, spawnSync, fs, path, os,
);
afterAll(() => console.log('CONSENSUS_LIFECYCLE=' + JSON.stringify({ attempts, records, registrations, captureOptions })));
`);
    const child = Bun.spawnSync([process.execPath, 'test', '--retry', '1', script], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 8_000,
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, output).toBe(0);
    expect(output).not.toContain('Unhandled error between tests');
    const match = output.match(/CONSENSUS_LIFECYCLE=(\{[^\n]+\})/);
    expect(match, output).not.toBeNull();
    const actual = JSON.parse(match![1]);
    expect(actual.attempts).toBe(2);
    expect(actual.records).toEqual(['timeout', 'success']);
    expect(actual.captureOptions).toEqual([{ timeout: 100, maxTurns: 20 }, { timeout: 100, maxTurns: 20 }]);
    expect(actual.registrations).toEqual([{ id: 'review-army-consensus', outer: 100 + 40 + 5_000 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
