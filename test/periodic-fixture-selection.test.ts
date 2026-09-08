import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { OVERLAY_FIXTURES } from './fixtures/overlay-nudges';

describe('periodic fixture dependencies select their behavioral cases', () => {
  const cases: Array<[string, string[]]> = [
    ['test/agent-sdk-runner.test.ts', ['brain-privacy-gate', 'setup-gbrain-remote', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', ...OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`)]],
    ['test/helpers/office-hours-attempt.ts', ['office-hours-forcing-energy', 'office-hours-builder-wildness', 'office-hours-brain-writeback']],
    ['test/office-hours-writeback-env.test.ts', ['office-hours-brain-writeback']],
    ['test/helpers/setup-gbrain-sandbox.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/helpers/setup-gbrain-fixture-command.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/helpers/ceo-mode-preference.ts', ['auto-decide-preserved']],
    ['test/helpers/ceo-mode-evidence.ts', ['auto-decide-preserved']],
    ['test/ceo-mode-evidence.test.ts', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-office-hours-render.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-implementation-render.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-adjacent-render.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-context-render.json', ['auto-decide-preserved']],
    ['test/helpers/carve-section-case.ts', ['carve-section-loading']],
    ['test/design-html-section-completion.test.ts', ['carve-section-loading']],
    ['test/fixtures/design-html-section-complete.md', ['carve-section-loading']],
    ['test/plan-design-floor-fixture.test.ts', ['plan-design-finding-floor']],
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

test('shared native input dependencies select every PTY consumer without changing tiers', () => {
  const expected = selectTests(['test/helpers/claude-pty-runner.ts'], E2E_TOUCHFILES).selected.sort();
  expect(expected).toHaveLength(22);
  expect(expected.filter(id => E2E_TIERS[id] === 'gate')).toHaveLength(7);
  expect(expected.filter(id => E2E_TIERS[id] === 'periodic')).toHaveLength(15);
  for (const file of ['test/helpers/pty-current-screen.ts', 'test/pty-current-screen.test.ts',
    'test/helpers/plan-skill-questions.ts', 'test/plan-skill-questions.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
});
