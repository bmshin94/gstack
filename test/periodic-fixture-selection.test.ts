import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { OVERLAY_FIXTURES } from './fixtures/overlay-nudges';

describe('periodic fixture dependencies select their behavioral cases', () => {
  const cases: Array<[string, string[]]> = [
    ['test/fixtures/ceo-onboarding-packet-90f.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-baseline-alternatives-90f.json', ['plan-ceo-finding-count']],
    ['test/fixtures/eng-structure-choice-90f.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-idp-choice-90f.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-legacy-declaration-90f.json', ['plan-eng-finding-count']],
    ['test/fixtures/design-completion-envelope-90f.json', ['plan-design-finding-count']],
    ['test/eng-native-seed-contract.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-native-seed-contract-6f.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-native-packets-b955.json', ['plan-eng-finding-count']],
    ['test/review-count-markdown.test.ts', ['plan-eng-finding-count', 'plan-design-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/review-count-markdown-6f.json', ['plan-eng-finding-count', 'plan-design-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/eng-current-native-seeds.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-current-native-seeds-6714.json', ['plan-eng-finding-count']],
    ['test/plan-count-cropped-wrap.test.ts', ['plan-eng-finding-count', 'plan-ceo-finding-count', 'plan-design-finding-count', 'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow']],
    ['test/fixtures/plan-count-cropped-wrap-6714.json', ['plan-eng-finding-count', 'plan-ceo-finding-count', 'plan-design-finding-count', 'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow']],
    ['test/fixtures/ceo-recorded-decisions-67147822.json', ['plan-ceo-finding-count']],
    ['test/fixtures/eng-batching-expanded-ledger-6714.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-native-review-identities-6714.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/design-count-current-pass.test.ts', ['plan-design-finding-count']],
    ['test/fixtures/design-count-current-pass.json', ['plan-design-finding-count']],
    ['test/eng-test-plan-edit-approval.test.ts', ['autoplan-chain-pty', 'plan-eng-finding-count']],
    ['test/fixtures/eng-test-plan-edit-dacc.json', ['autoplan-chain-pty', 'plan-eng-finding-count']],
    ['test/autoplan-owned-state.test.ts', ['autoplan-chain-pty']],
    ['test/fixtures/eng-current-choice-cab3.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-completed-navigation-cab3.json', ['plan-eng-finding-count']],
    ['test/autoplan-dual-voice-fixture.test.ts', ['autoplan-dual-voice']],
    ['test/fixtures/devex-journey-evidence-cab3.json', ['plan-devex-finding-count']],
    ['test/autoplan-phase-handoff.test.ts', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/autoplan-amend-input.test.ts', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-amend-input-77.json', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-phase-handoff-6714.json', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-owned-state-edit.json', ['autoplan-chain-pty']],
    ['test/eng-finding-retry-budget.test.ts', ['plan-ceo-finding-count', 'plan-ceo-split-overflow', 'plan-design-finding-count', 'plan-devex-finding-count', 'plan-eng-finding-count', 'plan-eng-multi-finding-batching', 'autoplan-chain-pty']],
    ['test/design-count-native-8525.test.ts', ['plan-design-finding-count']],
    ['test/fixtures/design-count-native-8525.json', ['plan-design-finding-count']],
    ['test/fixtures/design-phase-entry-77.json', ['plan-design-finding-count']],
    ['test/fixtures/ceo-expansion-pacing-77.json', ['plan-ceo-mode-routing']],
    ['test/eng-published-navigation.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-published-navigation.json', ['plan-eng-finding-count']],
    ['test/fixtures/disabled-retained-record.json', ['outside-plan-disabled-no-fallback']],
    ['test/ceo-native-ledger-replay.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-native-ledger-8525.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-option-metadata-list-6f6730f4.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-zero-test-absence-6f6730f4.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-recorded-decisions-dacc95ea.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-expansion-posture-kind-dacc.json', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-expansion-pause-6714.json', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-expansion-complete-inventory-6f.json', ['plan-ceo-mode-routing']],
    ['test/ceo-mode-pending-submit.test.ts', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-mode-pending-submit.json', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-fill-lifetime.json', ['plan-ceo-section-loading']],
    ['test/fixtures/eng-current-ledger-seeds.json', ['plan-eng-finding-count']],
    ['test/eng-batching-native-replay.test.ts', ['plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-batching-native-8525.json', ['plan-eng-multi-finding-batching']],
    ['test/eng-batching-saved-ledger.test.ts', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-batching-saved-ledger-dacc.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/plan-design-sdk-fixture.test.ts', ['plan-design-review-plan-mode']],
    ['test/design-count-native-issue-fields.test.ts', ['plan-design-finding-count']],
    ['test/fixtures/design-count-native-issue-fields.json', ['plan-design-finding-count']],
    ['test/helpers/ceo-payment-findings.ts', ['plan-ceo-finding-count']],
    ['test/ceo-payment-findings.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-payment-ledger-decisions.json', ['plan-ceo-finding-count']],
    ['test/setup-gbrain-remote-caller.test.ts', ['setup-gbrain-remote']],
    ['test/skill-fixture.test.ts', ['journey-ideation', 'journey-plan-eng', 'journey-debug', 'journey-qa', 'journey-code-review', 'journey-ship', 'journey-docs', 'journey-retro', 'journey-design-system', 'journey-visual-qa']],
    ['test/agent-sdk-runner.test.ts', ['brain-privacy-gate', 'setup-gbrain-remote', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', ...OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`)]],
    ['test/office-hours-writeback-env.test.ts', ['office-hours-brain-writeback']],
    ['test/review-army-budget.test.ts', ['review-army-red-team', 'review-army-consensus']],
    ['test/helpers/setup-gbrain-sandbox.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', 'setup-gbrain-remote']],
    ['test/helpers/setup-gbrain-fixture-command.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/fixtures/autoplan-caller.fixture.test.ts', ['autoplan-chain-pty']],
    ['test/gstack-paths.test.ts', ['autoplan-chain-pty', 'carve-section-loading', 'design-html-slop-gate']],
    ['test/gstack-brain-context-load.test.ts', ['autoplan-chain-pty', 'plan-ceo-section-loading']],
    ['test/autoplan-permission-viewport.test.ts', ['autoplan-chain-pty']],
    ['test/fixtures/autoplan-settings-overwrite.json', ['autoplan-chain-pty']],
    ['test/fixtures/eng-file-permission-repaint.json', ['plan-eng-multi-finding-batching']],
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
    ['test/fixtures/devex-checkpoint-todos.json', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/README.md', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/docs/getting-started.md', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/docs/feedback.md', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/docs/reference-v1.md', ['plan-devex-finding-count']],
    ['test/design-finding-fixture.test.ts', ['plan-design-finding-count']],
    ['test/helpers/hermetic-env.test.ts', ['plan-ceo-split-overflow']],
    ['test/helpers/ceo-split-question-policy.ts', ['plan-ceo-split-overflow']],
    ['test/ceo-split-question-policy.test.ts', ['plan-ceo-split-overflow']],
    ['docs/askuserquestion-split.md', ['plan-ceo-split-overflow', 'plan-decision-classification', 'plan-devex-peer-comparison-classification']],
    ['test/resolver-ask-user-format.test.ts', ['plan-ceo-split-overflow']],
    ['test/skill-e2e-plan-ceo-finding-count.test.ts', ['plan-ceo-finding-count']],
    ['test/section-capture-native-tools.test.ts', ['ship-section-loading', 'plan-ceo-section-loading', 'office-hours-section-loading', 'carve-section-loading']],
    ['test/helpers/ceo-paired-fixture.ts', ['plan-ceo-finding-count']],
    ['test/ceo-paired-payment-fixture.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-paired-option-values.json', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/src/payment.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/contract.test.ts.fixture', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/README.md', ['plan-ceo-finding-count']],
    ...['README.md', 'platform.ts', 'existing-invoice-handler.ts', 'schema.sql', 'contract.test.ts.fixture'].map((file): [string, string[]] =>
      [`test/fixtures/ceo-existing-payment/${file}`, ['plan-ceo-finding-count']]),
    ...['test/fixtures/webfetch-permission.json', 'test/plan-skill-webfetch-permission.test.ts'].map((file): [string, string[]] => [file,
      ['plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
        'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow'],
    ]),
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

test('shared attempt regressions select periodic callers and the gate report case', () => {
  const periodic = ['plan-design-review-plan-mode', 'office-hours-forcing-energy', 'office-hours-builder-wildness', 'office-hours-brain-writeback', 'plan-ceo-review-format-mode', 'plan-ceo-review-format-approach', 'plan-eng-review-format-coverage', 'plan-eng-review-format-kind', 'plan-ceo-review-prosons-cadence', 'plan-review-prosons-format', 'plan-review-prosons-hardstop-neg', 'plan-review-prosons-neutral-neg', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', 'setup-gbrain-remote', 'review-army-red-team'];
  const result = selectTests(['test/office-hours-attempt.test.ts'], E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  expect(result.selected.sort()).toEqual([...periodic, 'plan-review-report'].sort());
  for (const id of periodic) expect(E2E_TIERS[id]).toBe('periodic');
  expect(E2E_TIERS['plan-review-report']).toBe('gate');
});

test('decision-log CLI and validator select the demonstrated DX consumer without global or quality fanout', () => {
  for (const file of ['bin/gstack-decision-log', 'lib/gstack-decision.ts']) {
    const selected = selectTests([file], E2E_TOUCHFILES);
    expect(selected.reason).toBe('diff');
    expect(selected.selected).toEqual(['plan-devex-finding-count']);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  expect(E2E_TIERS['plan-devex-finding-count']).toBe('periodic');
});

test('native fixture dependencies include the migrated auto-decision caller', () => {
  const expected = [
    'auto-decide-preserved', 'autoplan-chain-pty',
    'plan-ceo-finding-count', 'plan-ceo-finding-floor', 'plan-ceo-mode-routing', 'plan-ceo-split-overflow',
    'plan-design-finding-count', 'plan-design-finding-floor', 'plan-design-with-ui-scope',
    'plan-devex-finding-count', 'plan-devex-finding-floor',
    'plan-eng-finding-count', 'plan-eng-finding-floor', 'plan-eng-multi-finding-batching',
  ];
  for (const file of ['test/helpers/plan-count-fixture.ts', 'test/plan-count-fixture.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  expect(E2E_TIERS['auto-decide-preserved']).toBe('periodic');
});

test('shared native input dependencies select every PTY consumer without changing tiers', () => {
  const expected = selectTests(['test/helpers/claude-pty-runner.ts'], E2E_TOUCHFILES).selected.sort();
  expect(expected).toHaveLength(22);
  expect(expected.filter(id => E2E_TIERS[id] === 'gate')).toHaveLength(7);
  expect(expected.filter(id => E2E_TIERS[id] === 'periodic')).toHaveLength(15);
  for (const file of ['test/plan-count-design-ui-recovery.test.ts', 'test/fixtures/design-ui-boxed-question.json', 'test/pty-workspace-trust.test.ts', 'test/fixtures/pty-companion-cli.ts', 'test/helpers/pty-current-screen.ts', 'test/pty-current-screen.test.ts', 'test/fixtures/native-viewport.ts',
    'test/helpers/plan-skill-questions.ts', 'test/plan-skill-questions.test.ts', 'test/fixtures/design-tasks-bash-permission.json', 'test/fixtures/eng-auq-validation-error.json',
    'test/helpers/plan-skill-question-events.ts', 'test/plan-skill-question-events.test.ts',
    'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts', 'test/plan-skill-question-hook-scope.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
});


test('seed submission dependencies select every seeded caller with its existing tier', () => {
  const expected = ['auto-decide-preserved', 'conductor-prose', 'plan-ceo-review-plan-mode',
    'plan-design-review-plan-mode', 'plan-devex-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-mode-no-op'];
  for (const file of ['test/helpers/fake-plan-seed.ts', 'test/helpers/plan-seed-submission.ts', 'test/plan-seed-submission.test.ts', 'test/fixtures/plan-seed-cli.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
  expect(expected.map(id => E2E_TIERS[id])).toEqual(['periodic', 'periodic', 'gate', 'periodic', 'gate', 'periodic', 'gate']);
});

test('task emission source selects CEO completion consumers', () => {
  const selected = selectTests(['scripts/resolvers/tasks-section.ts'], E2E_TOUCHFILES);
  expect(selected.reason).toBe('diff');
  for (const id of [
    'plan-ceo-finding-count', 'plan-ceo-finding-floor', 'plan-ceo-split-overflow',
    'plan-ceo-section-loading', 'plan-ceo-review-plan-mode', 'autoplan-chain-pty',
  ]) expect(selected.selected).toContain(id);
  expect(selectTests(['scripts/resolvers/tasks-section.ts'], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
});

test('review report resolver selects every periodic completion consumer', () => {
  const required = [
    'plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
    'plan-devex-finding-count', 'plan-ceo-split-overflow', 'autoplan-chain-pty',
    'carve-section-loading', 'plan-ceo-section-loading', 'plan-eng-multi-finding-batching',
  ];
  const result = selectTests(['scripts/resolvers/review.ts'], E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  for (const id of required) {
    expect(result.selected).toContain(id);
    expect(E2E_TIERS[id]).toBe('periodic');
  }
});


test('shared plan question source selects every generated review consumer', () => {
  const source = 'scripts/resolvers/preamble/generate-ask-user-format.ts';
  const renders = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review']
    .map(skill => `${skill}/SKILL.md`);
  for (const map of [E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES]) {
    const expected = selectTests(renders, map);
    const actual = selectTests([source], map);
    expect(expected.reason).toBe('diff');
    expect(actual.reason).toBe('diff');
    expect(expected.selected.length).toBeGreaterThan(0);
    expect(expected.selected.filter(id => !actual.selected.includes(id))).toEqual([]);
  }
});


test('Eng approval-rule source and free contract controls select every declared Eng consumer', () => {
  const expected = [
      'plan-eng-review',
      'plan-eng-review-artifact',
      'plan-review-report',
      'plan-eng-review-plan-mode',
      'plan-mode-no-op',
      'conductor-prose',
      'carve-section-loading',
      'autoplan-chain-pty',
      'plan-eng-finding-count',
      'plan-eng-finding-floor',
      'plan-eng-multi-finding-batching',
      'plan-eng-review-format-coverage',
      'plan-eng-review-format-kind',
      'plan-ceo-review-prosons-cadence',
      'plan-review-prosons-format',
      'codex-offered-eng-review',
      'codex-plan-eng-format-coverage',
      'codex-plan-eng-format-kind',
      'plan-eng-coverage-audit',
      'autoplan-dual-voice'
  ];
  for (const file of ['plan-eng-review/sections/review-sections.md.tmpl', 'scripts/resolvers/review.ts', 'test/plan-review-cases.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    for (const id of expected) expect(result.selected, `${file}: ${id}`).toContain(id);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toContain('plan-eng-review/SKILL.md sections');
  }
});

// This actor is used by the bounded native Design UI case, not the optional
// outside-review evaluations. Its captured inputs must select that same case.
test('Design native-only actor capture selects its gate case', () => {
  const result = selectTests(['test/fixtures/design-outside-voices-question.json'], E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  expect(result.selected).toEqual(['plan-design-with-ui-scope']);
  expect(E2E_TIERS['plan-design-with-ui-scope']).toBe('gate');
});


test('native compact-boundary ancestry selects every consuming callback', () => {
  const expected = [
    'plan-ceo-mode-routing', 'autoplan-chain-pty', 'plan-ceo-finding-count',
    'plan-eng-finding-count', 'plan-design-finding-count', 'plan-devex-finding-count',
    'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow',
    'plan-design-with-ui-scope', 'plan-design-review-plan-mode', 'plan-eng-review-plan-mode',
    'auto-decide-preserved', 'conductor-prose',
  ].sort();
  for (const file of ['test/helpers/plan-count-transcript.ts', 'test/plan-count-session-cwd.test.ts']) {
    const selected = selectTests([file], E2E_TOUCHFILES);
    expect(selected.reason).toBe('diff');
    expect(selected.selected.sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('same-plan expansion disposition replay selects the existing mode helper consumers', () => {
  for (const dependency of ['test/ceo-mode-expansion-disposition.test.ts', 'test/fixtures/ceo-expansion-disposition-77.json']) {
    expect([...selectTests([dependency], E2E_TOUCHFILES).selected].sort()).toEqual(['plan-ceo-finding-count', 'plan-ceo-mode-routing']);
    expect(selectTests([dependency], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('structured auto-decision evidence selects every native observer', () => {
  const expected = ['auto-decide-preserved', 'conductor-prose', 'plan-ceo-review-plan-mode',
    'plan-design-review-plan-mode', 'plan-devex-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-mode-no-op'];
  for (const file of ['test/auto-decide-structured.test.ts', 'test/fixtures/auto-decide-structured-77.json',
    'test/helpers/auto-decision-state.ts', 'test/auto-decision-state.test.ts', 'test/fixtures/auto-decide-state-cab3.json']) {
    expect([...selectTests([file], E2E_TOUCHFILES).selected].sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  for (const file of ['bin/gstack-question-log', 'bin/gstack-question-preference']) {
    const producers = selectTests([file], E2E_TOUCHFILES).selected;
    for (const id of expected) expect(producers).toContain(id);
  }
});
