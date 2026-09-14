// Child-only free control: never launch a provider when discovered by Bun.
import { afterAll, describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AUTOPLAN_CHAIN_BUDGET } from '../helpers/eval-budgets';
import * as runner from '../helpers/claude-pty-runner';
import * as nativeTranscript from '../helpers/plan-count-transcript';

if (process.env.AUTOPLAN_CALLER_SCENARIO) {
  const root = path.resolve(import.meta.dir, '../..');
  const runnerExports = { ...runner };
  const transcriptExports = { ...nativeTranscript };
  const mode = process.env.AUTOPLAN_CALLER_SCENARIO;
  const facts = { inputs: [] as string[], closed: false, startedAt: 0, elapsedMs: 0, approvalStartedAt: 0 };
  let clock = 0;
  let complete = false;
  Date.now = () => clock;
  Bun.sleep = (async (ms: number) => {
    clock += ms;
    if (mode === 'deadline' && facts.startedAt) clock = facts.startedAt + AUTOPLAN_CHAIN_BUDGET.workMs;
  }) as typeof Bun.sleep;
  mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => describe }));
  mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
    ...runnerExports,
    isPlanReadyVisible: () => false,
    isPermissionDialogVisible: (text: string) => text.includes('Permission'),
    isNumberedOptionListVisible: (text: string) => text.includes('1. Yes'),
    selectPtyNumberedOption: async (session: {send(input: string): void}, index: number) => session.send(`${index}\r`),
    launchClaudePty: async (opts: any) => {
      const cwd = fs.realpathSync(opts.cwd);
      const git = (file: string) => execFileSync('git', ['show', `HEAD:${file}`], { cwd, encoding: 'utf8', timeout: 5000 });
      expect(git('.claude/plans/ui-heavy-feature.md')).toBe(fs.readFileSync(path.join(root, 'test/fixtures/plans/autoplan-dashboard.md'), 'utf8'));
      expect(git('CLAUDE.md')).toContain('## Skill routing');
      expect(git('docs/designs/dashboard-context.md')).toContain('## Existing product and application contracts');
      expect(opts).toMatchObject({ permissionMode: 'plan', timeoutMs: AUTOPLAN_CHAIN_BUDGET.sessionMs,
        seedSkills: true, observeScreen: true, observeSetupQuestions: true,
        observeAutoplanArtifacts: true, approveAutoplanArtifactEdits: true });
      return {
        hermeticConfigDir: path.join(cwd, '.native'),
        hermeticSkillStateRoot: opts.env.GSTACK_HOME,
        mark: () => 0, exited: () => false, exitCode: () => null,
        rawOutput: () => '', visibleText: () => '', visibleSince: () => '',
        startAutoplanArtifactEditApproval: (at: number) => { facts.approvalStartedAt = at; },
        currentScreen: async () => {
          if (mode === 'deadline') return 'Permission\n1. Yes\n2. No';
          clock = facts.startedAt + (mode === 'progress' ? 900001 : AUTOPLAN_CHAIN_BUDGET.workMs);
          complete = true;
          return 'Four native reviews have completed.';
        },
        send: (input: string) => {
          facts.inputs.push(input);
          if (input === '/autoplan\r') facts.startedAt = clock;
        },
        close: async () => { facts.closed = true; facts.elapsedMs = clock - facts.startedAt; },
      };
    },
  }));
  mock.module(path.join(root, 'test/helpers/plan-count-transcript.ts'), () => ({
    ...transcriptExports,
    readPlanCountTranscript: () => ({ status: 'ready', calls: [], assistantMessages: complete
      ? [1, 2, 2.5, 3].map((phase, i) => ({sessionId: 'owned', timestamp: new Date(facts.startedAt + i + 1).toISOString(), text: `Phase ${phase} complete.`})) : [] }),
  }));
  mock.module(path.join(root, 'test/helpers/plan-count-pending-question.ts'), () => ({
    readPendingQuestion: () => undefined, pendingQuestionRecorderStatus: () => ({status: 'idle'}),
  }));
  mock.module(path.join(root, 'test/helpers/autoplan-artifact-recorder.ts'), () => ({
    readPendingAutoplanArtifact: () => undefined, autoplanArtifactRecorderStatus: () => ({status: 'idle'}),
    autoplanArtifactApprovalBoundary: () => 'clear',
  }));
  // Method delivery has independent native positive/negative controls. Supply
  // successful delivery here so only the caller's deadline decides acceptance.
  mock.module(path.join(root, 'test/helpers/autoplan-method-read-audit.ts'), () => ({
    auditAutoplanMethodReads: () => complete ? ['ceo', 'design', 'dx', 'eng'].map(phase => ({phase, passed: true})) : [],
    loadAutoplanMethodologyBinding: () => undefined,
  }));
  mock.module(path.join(root, 'test/helpers/plan-count-artifacts.ts'), () => ({createPlanCountSnapshotWriter: () => () => ({})}));
  afterAll(() => fs.writeFileSync(process.env.AUTOPLAN_CALLER_FACTS!, JSON.stringify(facts)));
  await import('../skill-e2e-autoplan-chain.test');
}
