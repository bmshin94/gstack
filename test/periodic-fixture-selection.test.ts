import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { OVERLAY_FIXTURES } from './fixtures/overlay-nudges';

describe('periodic fixture dependencies select their behavioral cases', () => {
  const cases: Array<[string, string[]]> = [
    ['test/helpers/office-hours-attempt.ts', ['office-hours-forcing-energy', 'office-hours-builder-wildness', 'office-hours-brain-writeback']],
    ['test/office-hours-writeback-env.test.ts', ['office-hours-brain-writeback']],
    ['test/helpers/setup-gbrain-sandbox.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/helpers/setup-gbrain-fixture-command.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/helpers/ceo-mode-preference.ts', ['auto-decide-preserved']],
    ['test/helpers/carve-section-case.ts', ['carve-section-loading']],
    ['test/skill-e2e-plan-ceo-paired-control.test.ts', ['plan-ceo-finding-count']],
    ...['overlay-measurement', 'overlay-workspace', 'overlay-attempt', 'overlay-case', 'overlay-case-policy', 'overlay-lifecycle'].map((helper): [string, string[]] => [
      `test/helpers/${helper}.ts`, OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`),
    ]),
  ];

  for (const file of ['test/overlay-sdk-cancel-eof.test.ts', 'test/overlay-recording-order.test.ts', 'test/paid-overlay-scheduling.test.ts', 'test/fixtures/overlay-admission-child.ts']) {
    cases.push([file, OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`)]);
  }

  for (const fixture of OVERLAY_FIXTURES) {
    cases.push([`test/skill-e2e-overlay-harness-${fixture.id}.test.ts`, [`overlay-harness-${fixture.id}`]]);
  }

  for (const [file, expected] of cases) {
    test(file, () => {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.reason).toBe('diff');
      expect(result.selected.sort()).toEqual([...expected].sort());
      for (const id of expected) expect(E2E_TIERS[id]).toBe('periodic');
    });
  }
});
