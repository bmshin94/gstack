import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { OVERLAY_FIXTURES } from './fixtures/overlay-nudges';

describe('periodic fixture dependencies select their behavioral cases', () => {
  const cases: Array<[string, string[]]> = [
    ['test/agent-sdk-runner.test.ts', ['brain-privacy-gate', 'setup-gbrain-remote', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', ...OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`)]],
    ['test/office-hours-writeback-env.test.ts', ['office-hours-brain-writeback']],
    ['test/review-army-budget.test.ts', ['review-army-red-team', 'review-army-consensus']],
    ['test/office-hours-attempt.test.ts', ['office-hours-forcing-energy', 'office-hours-builder-wildness', 'office-hours-brain-writeback', 'plan-ceo-review-format-mode', 'plan-ceo-review-format-approach', 'plan-eng-review-format-coverage', 'plan-eng-review-format-kind', 'plan-ceo-review-prosons-cadence', 'plan-review-prosons-format', 'plan-review-prosons-hardstop-neg', 'plan-review-prosons-neutral-neg', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', 'review-army-red-team']],
    ['test/helpers/setup-gbrain-sandbox.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/helpers/setup-gbrain-fixture-command.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['bin/gstack-paths', ['autoplan-chain-pty']],
    ['test/gstack-paths.test.ts', ['autoplan-chain-pty']],
    ['test/fixtures/autoplan-existing-app/src/auth.ts', ['autoplan-chain-pty']],
    ['test/fixtures/autoplan-existing-app/db/schema.sql', ['autoplan-chain-pty']],
    ['test/fixtures/plans/ui-heavy-feature-design.md', ['autoplan-chain-pty']],
    ['test/fixtures/plans/autoplan-password-visibility.md', ['autoplan-chain-pty']],
    ['test/fixtures/plans/autoplan-password-visibility-design.md', ['autoplan-chain-pty']],
    ['test/helpers/ceo-mode-preference.ts', ['auto-decide-preserved']],
    ['test/helpers/ceo-mode-evidence.ts', ['auto-decide-preserved']],
    ['test/ceo-mode-evidence.test.ts', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-office-hours-render.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-implementation-render.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-adjacent-render.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-mode-preference-context-render.json', ['auto-decide-preserved']],
    ['test/helpers/carve-section-case.ts', ['carve-section-loading']],
    ['test/helpers/carve-plan-fixture.ts', ['carve-section-loading']],
    ['test/carve-plan-fixture.test.ts', ['carve-section-loading']],
    ['test/fixtures/carve-existing-repository/src/repository.ts', ['carve-section-loading']],
    ['test/fixtures/carve-existing-repository/README.md', ['carve-section-loading']],
    ['test/fixtures/carve-existing-repository/example.ts', ['carve-section-loading']],
    ['test/helpers/eng-finding-fixture.ts', ['plan-eng-finding-count']],
    ['test/eng-finding-fixture.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-existing-auth/legacy-auth.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-existing-auth/package.json', ['plan-eng-finding-count']],
    ['test/codex-carve-fixture.test.ts', ['carve-section-loading']],
    ['test/design-html-section-completion.test.ts', ['carve-section-loading']],
    ['test/fixtures/design-html-section-complete.md', ['carve-section-loading']],
    ['test/plan-design-floor-fixture.test.ts', ['plan-design-finding-floor']],
    ['test/devex-finding-fixture.test.ts', ['plan-devex-finding-count']],
    ['test/design-finding-fixture.test.ts', ['plan-design-finding-count']],
    ['test/helpers/ceo-split-question-policy.ts', ['plan-ceo-split-overflow']],
    ['test/ceo-split-question-policy.test.ts', ['plan-ceo-split-overflow']],
    ['test/skill-e2e-plan-ceo-paired-control.test.ts', ['plan-ceo-finding-count']],
    ['test/section-capture-native-tools.test.ts', ['ship-section-loading', 'plan-ceo-section-loading', 'office-hours-section-loading', 'carve-section-loading']],
    ['test/helpers/ceo-paired-fixture.ts', ['plan-ceo-finding-count']],
    ['test/ceo-paired-payment-fixture.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/src/payment.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/contract.test.ts.fixture', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/README.md', ['plan-ceo-finding-count']],
    ...['README.md', 'platform.ts', 'existing-invoice-handler.ts', 'schema.sql', 'contract.test.ts.fixture'].map((file): [string, string[]] =>
      [`test/fixtures/ceo-existing-payment/${file}`, ['plan-ceo-finding-count']]),
    ['test/helpers/plan-mode-evidence.ts', ['plan-design-review-plan-mode', 'plan-eng-review-plan-mode']],
    ['test/plan-mode-evidence.test.ts', ['plan-design-review-plan-mode', 'plan-eng-review-plan-mode']],
    ...['test/helpers/autoplan-phase-order.ts', 'test/autoplan-phase-observation.test.ts'].map((file): [string, string[]] => [file,
      ['autoplan-chain-pty', 'plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
        'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow'],
    ]),
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
  for (const file of ['test/pty-workspace-trust.test.ts', 'test/fixtures/pty-companion-cli.ts', 'test/helpers/pty-current-screen.ts', 'test/pty-current-screen.test.ts', 'test/fixtures/native-viewport.ts',
    'test/helpers/plan-skill-questions.ts', 'test/plan-skill-questions.test.ts',
    'test/helpers/plan-skill-question-events.ts', 'test/plan-skill-question-events.test.ts',
    'test/helpers/plan-skill-question-hook-scope.ts', 'test/plan-skill-question-hook-scope.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
});


test('seed submission dependencies select every seeded caller with its existing tier', () => {
  const expected = ['conductor-prose', 'plan-design-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-mode-no-op'];
  for (const file of ['test/helpers/plan-seed-submission.ts', 'test/plan-seed-submission.test.ts', 'test/fixtures/plan-seed-cli.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
  expect(expected.map(id => E2E_TIERS[id])).toEqual(['periodic', 'periodic', 'periodic', 'gate']);
});
