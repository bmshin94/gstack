/** Isolated fake PTY: run the real counter without model calls or shared spies. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject } from '../helpers/ceo-finding-fixture';
import { ceoStep0Boundary, runPlanSkillCounting } from '../helpers/claude-pty-runner';

async function main() {
  const completion = process.argv[2];
  const scenario = process.argv[3] ?? 'normal';
  const timing = ['setup-exhausted', 'setup-budget', 'launch-budget', 'late-completion', 'timeout-after-question'].includes(scenario);
  const caseBudgetMs = scenario === 'launch-budget' ? 9_000 : scenario === 'late-completion' ? 12_000 : timing ? 30_000 : 1_500_000;
  const setupMs = scenario === 'setup-exhausted' ? caseBudgetMs + 5_000 : scenario === 'setup-budget' ? 5_000 : 0;
  const reusedOptions = scenario === 'reused-options' || scenario === 'redraw';
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'counting-pty-fixture-'));
  const plan = '# Payment Processing\nReview the two independent test gaps.\n';
  const sends: string[] = [];
  const sendTimes: number[] = [];
  let seededBeforeSlash = false;
  let closed = false;
  let launches = 0;
  let sleeps = 0;
  let redraws = 0;
  let clock = 0;
  let pendingRedrawSleeps = 0;
  let lateCompletionSent = false;
  let showSecondFinding = () => {};
  let finishLate = () => {};
  const originalSpawn = Bun.spawn;
  const originalSleep = Bun.sleep;
  const originalNow = Date.now;
  if (timing) Date.now = () => clock;
  const caseStartedAt = Date.now();
  try {
    seedCeoFindingProject(project, plan);
    clock += setupMs;
    process.env.BROWSE_TERMINAL_BINARY = process.execPath;
    process.env.EVALS_HERMETIC = '1';
    Bun.spawn = ((_command: string[], options: any) => {
      launches++;
      if (scenario === 'launch-budget') clock += 2_000;
      const sessionId = _command[_command.indexOf('--session-id') + 1];
      const file = path.join(options.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture', `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const append = (row: Record<string, unknown>) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
      const emit = (value: string) => options.terminal.data(null, Buffer.from(value));
      const finding = (number: number) => `\nFinding ${number} — ${number === 1 ? 'Success' : 'Failure'} test\n\n❯ 1. ${reusedOptions ? 'Add test' : number === 1 ? 'Add receipt assertion' : 'Add retry assertion'}\n  2. ${reusedOptions ? 'Skip test' : number === 1 ? 'Skip receipt test' : 'Skip retry test'}\n`;
      const tool = (name: string, content: unknown) => append({
        type: 'assistant', message: { id: `tool-${sends.length}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input: content }] },
      });
      const finish = () => {
        append({ type: 'assistant', message: { id: 'final', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: completion }] } });
        emit('\n' + completion.replace(/\*|#| /g, '') + '\n');
      };
      finishLate = () => { lateCompletionSent = true; finish(); };
      showSecondFinding = () => { tool('AskUserQuestion', { question: 'Failure test' }); emit(finding(2)); };
      let end: (code: number) => void = () => {};
      let answer = 0;
      return {
        exited: new Promise<number>(resolve => { end = resolve; }),
        terminal: { write(data: string) {
          sends.push(data);
          sendTimes.push(Date.now() - caseStartedAt);
          if (data.startsWith('/')) {
            seededBeforeSlash = fs.readFileSync(path.join(options.cwd, 'review-input.md'), 'utf8') === plan;
            if (scenario === 'setup-budget' || scenario === 'launch-budget' || scenario === 'setup-exhausted') {
              emit('WORK_IN_PROGRESS\n');
              return;
            }
            tool('Read', { content: '## GSTACK REVIEW REPORT\nVERDICT: APPROVED' });
            // Actual failure: a preview in PTY while the assistant still uses tools.
            emit('Read: GSTACK REVIEW REPORT\nVERDICT: APPROVED\n\nD1 — Pick a mode\n\n❯ 1. HOLD SCOPE\n  2. SCOPE EXPANSION\n');
          } else if (data === '1\r') {
            answer++;
            append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Answer accepted' }] } });
            if (answer === 1) {
              tool('AskUserQuestion', { question: 'Success test' });
              emit(finding(1));
            } else if (answer === 2) {
              if (scenario === 'timeout-after-question') emit('\nWORK_IN_PROGRESS\n');
              else if (scenario === 'redraw') {
                redraws++;
                emit(finding(1));
                // One post-answer pause, then a poll sees the same question;
                // only the next poll receives a genuinely different prompt.
                pendingRedrawSleeps = 3;
              } else showSecondFinding();
            } else finish();
          }
        } },
        kill() { closed = true; end(0); },
      };
    }) as typeof Bun.spawn;
    Bun.sleep = (async (ms: number) => {
      if (!closed && ++sleeps > 50) throw new Error('Fake counting session did not converge');
      if (timing) clock += ms;
      if (scenario === 'late-completion' && clock >= caseBudgetMs && !lateCompletionSent) finishLate();
      if (pendingRedrawSleeps > 0 && --pendingRedrawSleeps === 0) showSecondFinding();
    }) as typeof Bun.sleep;
    const helperTimeoutMs = scenario === 'invalid-nan' ? Number.NaN : scenario === 'invalid-infinity' ? Number.POSITIVE_INFINITY
      : caseBudgetMs - (Date.now() - caseStartedAt);
    let observation;
    let error;
    try { observation = await runPlanSkillCounting({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
      cwd: project, isLastStep0AUQ: ceoStep0Boundary, reviewCountCeiling: 4, timeoutMs: helperTimeoutMs,
    }); } catch (cause) {
      if (!scenario.startsWith('invalid-')) throw cause;
      error = String(cause);
    }
    console.log(JSON.stringify({ observation, error, sends, sendTimes, seededBeforeSlash, closed, launches, redraws,
      caseBudgetMs, setupMs, helperTimeoutMs, caseElapsedMs: Date.now() - caseStartedAt, lateCompletionSent }));
  } finally {
    Bun.spawn = originalSpawn;
    Bun.sleep = originalSleep;
    Date.now = originalNow;
    fs.rmSync(project, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();

/** Real Bun test timeout/retry scheduling; only the model process is fake. */
export async function registerDeadlineRetryProbe(receiptFile: string) {
  const { expect, test } = await import('bun:test');
  const workMs = 500;
  const outerMs = 1_500;
  let attempt = 0;
  const record = (event: Record<string, unknown>) => fs.appendFileSync(receiptFile, JSON.stringify(event) + '\n');
  test('inner deadline finalizes before normal retry', async () => {
    const currentAttempt = ++attempt;
    const caseStartedAt = Date.now();
    const originalSpawn = Bun.spawn;
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'counting-retry-fixture-'));
    let closed = false;
    record({ kind: 'start', attempt: currentAttempt, at: caseStartedAt });
    try {
      seedCeoFindingProject(project, '# Review input\nWait for the test driver.\n');
      process.env.BROWSE_TERMINAL_BINARY = process.execPath;
      process.env.EVALS_HERMETIC = '1';
      Bun.spawn = (() => {
        let finish: (code: number) => void = () => {};
        let exitTimer: ReturnType<typeof setTimeout> | undefined;
        return {
          exited: new Promise<number>(resolve => { finish = resolve; }),
          terminal: { write() { throw new Error('Short boot budget must not send model input'); } },
          kill() {
            if (exitTimer) return;
            exitTimer = setTimeout(() => {
              closed = true;
              record({ kind: 'closed', attempt: currentAttempt, at: Date.now() });
              finish(0);
            }, 20);
          },
        };
      }) as typeof Bun.spawn;
      const observation = await runPlanSkillCounting({
        skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
        cwd: project, isLastStep0AUQ: ceoStep0Boundary, reviewCountCeiling: 4,
        timeoutMs: workMs - (Date.now() - caseStartedAt),
      });
      const elapsedMs = Date.now() - caseStartedAt;
      record({ kind: 'returned', attempt: currentAttempt, at: Date.now(), closed, outcome: observation.outcome, elapsedMs, outerMs });
      expect(observation.outcome).toBe('timeout');
      expect(closed).toBe(true);
      expect(elapsedMs).toBeLessThan(outerMs);
      // First attempt fails only after its own timeout result and cleanup.
      // Bun's configured retry must begin with no still-running first attempt.
      expect(currentAttempt).toBe(2);
    } finally {
      Bun.spawn = originalSpawn;
      fs.rmSync(project, { recursive: true, force: true });
      record({ kind: 'finalized', attempt: currentAttempt, at: Date.now() });
    }
  }, outerMs);
}
