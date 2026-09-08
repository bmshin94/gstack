/** Isolated fake PTY: run the real counter without model calls or shared spies. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject } from '../helpers/ceo-finding-fixture';
import { ceoStep0Boundary, runPlanSkillCounting } from '../helpers/claude-pty-runner';

async function main() {
  const completion = process.argv[2];
  const scenario = process.argv[3] ?? 'normal';
  const timing = ['setup-exhausted', 'setup-budget', 'launch-budget', 'late-completion', 'timeout-after-question', 'preview-only', 'no-ack', 'hook-no-ack', 'screen-only-plan-ready'].includes(scenario);
  const caseBudgetMs = scenario === 'launch-budget' ? 9_000 : scenario === 'late-completion' ? 12_000 : timing ? 30_000 : 1_500_000;
  const setupMs = scenario === 'setup-exhausted' ? caseBudgetMs + 5_000 : scenario === 'setup-budget' ? 5_000 : 0;
  const reusedOptions = ['reused-options', 'redraw', 'stale-redraw', 'wrong-question', 'multi-question'].includes(scenario);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'counting-pty-fixture-')));
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
  const unsolicitedWrites: string[] = [];
  const prematureAnswers: string[] = [];
  let showSecondFinding = () => {};
  let finishLate = () => {};
  let delayedRender = () => {};
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
      // A real PTY's ONLCR output converts these fixture newlines to CRLF.
      const emit = (value: string) => options.terminal.data(null, Buffer.from(value.replace(/(?<!\r)\n/g, '\r\n')));
      const finding = (number: number) => `\nFinding ${number} — ${number === 1 ? 'Success' : 'Failure'} test\n\n❯ 1. ${reusedOptions ? 'Add test' : number === 1 ? 'Add receipt assertion' : 'Add retry assertion'}\n  2. ${reusedOptions ? 'Skip test' : number === 1 ? 'Skip receipt test' : 'Skip retry test'}\n`;
      let sequence = 0;
      let pendingId: string | null = null;
      let permissionId: string | null = null;
      const tool = (name: string, input: unknown) => {
        const id = `tool-${++sequence}`;
        if (name === 'AskUserQuestion' && scenario.startsWith('hook-')) {
          // Native CLI can show this modal before persisting its tool_use.
          // Exercise the recorder installed by the real launcher.
          const settings = JSON.parse(fs.readFileSync(_command[_command.indexOf('--settings') + 1], 'utf8'));
          const recorded = Bun.spawnSync(['bash', '-c', settings.hooks.PreToolUse[0].hooks[0].command], {
            timeout: 5000,
            stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId,
              transcript_path: file, cwd: options.cwd, tool_name: name, tool_use_id: id, tool_input: input })),
            stdout: 'pipe', stderr: 'pipe',
          });
          if (recorded.exitCode !== 0 || recorded.stdout.length) throw new Error(`Question recorder failed: ${recorded.stderr}`);
          if (scenario === 'hook-omitted-default') {
            const wireInput = { ...(input as any), questions: (input as any).questions.map(({ multiSelect, ...question }: any) => question) };
            append({ type: 'assistant', cwd: options.cwd, message: { id, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: wireInput }] } });
          }
        } else append({ type: 'assistant', cwd: options.cwd, message: { id, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
        return id;
      };
      const ask = (question: string, labels: string[]) => {
        pendingId = tool('AskUserQuestion', { questions: [{ question, header: question, multiSelect: scenario === 'multi-select', options: labels.map(label => ({ label, description: `Choose ${label}` })) }] });
      };
      const acknowledge = () => {
        append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: pendingId, content: 'Answer accepted' }] } });
        pendingId = null;
      };
      const finish = () => {
        append({ type: 'assistant', message: { id: 'final', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: completion }] } });
        emit('\n' + completion.replace(/\*|#| /g, '') + '\n');
      };
      finishLate = () => { lateCompletionSent = true; finish(); };
      showSecondFinding = () => { ask('Finding 2 — Failure test', [reusedOptions ? 'Add test' : 'Add retry assertion', reusedOptions ? 'Skip test' : 'Skip retry test']); emit(finding(2)); };
      let end: (code: number) => void = () => {};
      let answer = 0;
      let batchQuestion = 0;
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
            if (scenario === 'screen-only-plan-ready') {
              tool('ExitPlanMode', {});
              emit('\x1b[2J\x1b[HReay to execute?\n');
              emit('\x1b7\x1b[1;4H\x1b[@d\x1b8');
              return;
            }
            if (scenario.startsWith('permission-current-create')) {
              permissionId = tool('Write', { file_path: path.join(project, scenario.endsWith('mismatch') ? 'different.md' : 'plan.md'), content: plan });
              const prompt = 'Do you want to create pln.md?';
              emit('\x1b[2J\x1b[H' + prompt + '\n❯1.Yes\n2.Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel');
              // A cursor insertion restores the exact filename on screen. An
              // append-and-strip view still contains the wrong name pln.md.
              emit(`\x1b7\x1b[1;${prompt.indexOf('pln.md') + 3}H\x1b[@a\x1b8`);
              return;
            }
            if (['permission-redraw', 'permission-ambiguous', 'permission-owner-change'].includes(scenario)) {
              permissionId = tool('Bash', { command: 'true' });
              if (scenario === 'permission-ambiguous') tool('Read', { file_path: '/fixture' });
              emit('Bash command true requires permission\n❯1.Yes\n2.No\n');
              return;
            }
            tool('Read', { content: '## GSTACK REVIEW REPORT\nVERDICT: APPROVED' });
            if (scenario !== 'preview-only') ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
            // Actual failure: a preview in PTY while the assistant still uses tools.
            emit('Read: GSTACK REVIEW REPORT\nVERDICT: APPROVED\n\nD1 — Pick a mode\n\n❯ 1. HOLD SCOPE\n  2. SCOPE EXPANSION\n');
          } else if (data === '\r' && scenario === 'multi-question' && batchQuestion === 2) {
            acknowledge();
            finish();
          } else if (/^[12]\r?$/.test(data)) {
            if (permissionId) {
              if (data !== '1\r') throw new Error('Permission must select only the current request');
              append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: permissionId, content: 'Complete' }] } });
              permissionId = null;
              if (scenario === 'permission-owner-change') tool('Read', { file_path: '/new-owner-only' });
              emit('Bash command true requires permission\n❯1.Yes\n2.No Redraw\n');
              delayedRender = () => { ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']); emit('\nD1 — Pick a mode\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\n'); };
              pendingRedrawSleeps = 3;
              return;
            }
            if (data.endsWith('\r')) throw new Error('Native question digit already advances; Enter would act on the next tab');
            if (scenario === 'wrong-question' && pendingRedrawSleeps > 0) prematureAnswers.push(data);
            if (!pendingId) { unsolicitedWrites.push(data); return; }
            answer++;
            if (scenario === 'multi-question' && answer > 1) {
              batchQuestion++;
              emit(batchQuestion === 1 ? finding(2) : '\nReview your answers\nReady to submit your answers?\nSubmit answers\n');
              return;
            }
            if (['no-ack', 'hook-no-ack'].includes(scenario) && answer === 2) { emit('\nWORK_IN_PROGRESS\n'); return; }
            acknowledge();
            if (answer === 1) {
              if (scenario === 'multi-question') {
                pendingId = tool('AskUserQuestion', { questions: ['Finding 1 — Success test', 'Finding 2 — Failure test'].map(question => ({
                  question, header: question, multiSelect: false, options: ['Add test', 'Skip test'].map(label => ({ label, description: label })),
                })) });
              } else ask('Finding 1 — Success test', [reusedOptions ? 'Add test' : 'Add receipt assertion', reusedOptions ? 'Skip test' : 'Skip receipt test']);
              if (scenario === 'screen-question-redraw') {
                const rendered = finding(1).trimStart().replace('Success', 'Succss');
                emit('\x1b[2J\x1b[H' + rendered);
                emit(`\x1b7\x1b[1;${rendered.indexOf('Succss') + 5}H\x1b[@e\x1b8`);
              } else emit(finding(1));
            } else if (answer === 2) {
              if (scenario === 'timeout-after-question') emit('\nWORK_IN_PROGRESS\n');
              else if (scenario === 'repeated-native') {
                ask('Finding 1 — Success test', ['Add receipt assertion', 'Skip receipt test']);
                emit(finding(1));
              } else if (scenario === 'wrong-question') {
                ask('Finding 2 — Failure test', ['Add test', 'Skip test']);
                emit(finding(1));
                delayedRender = () => emit(finding(2));
                pendingRedrawSleeps = 3;
              } else if (scenario === 'redraw' || scenario === 'stale-redraw') {
                redraws++;
                emit(scenario === 'stale-redraw' ? finding(1).trimEnd() + ' Working frame 2\n' : finding(1));
                // One post-answer pause, then a poll sees the same question;
                // only the next poll receives a genuinely different prompt.
                pendingRedrawSleeps = 3;
                delayedRender = showSecondFinding;
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
      if (pendingRedrawSleeps > 0 && --pendingRedrawSleeps === 0) delayedRender();
    }) as typeof Bun.sleep;
    const helperTimeoutMs = scenario === 'invalid-nan' ? Number.NaN : scenario === 'invalid-infinity' ? Number.POSITIVE_INFINITY
      : caseBudgetMs - (Date.now() - caseStartedAt);
    let observation;
    let error;
    try { observation = await runPlanSkillCounting({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
      cwd: project, isLastStep0AUQ: ceoStep0Boundary, reviewCountCeiling: 4, timeoutMs: helperTimeoutMs,
      defaultPick: scenario === 'permission-current-create-pick-two' ? 2 : undefined,
      firstAUQPick: scenario === 'first-route' ? () => 2 : undefined,
    }); } catch (cause) {
      if (!scenario.startsWith('invalid-') && !['multi-select', 'permission-ambiguous', 'permission-owner-change', 'permission-current-create-mismatch', 'repeated-native'].includes(scenario)) throw cause;
      error = String(cause);
    }
    console.log(JSON.stringify({ observation, error, sends, sendTimes, seededBeforeSlash, closed, launches, redraws, unsolicitedWrites, prematureAnswers,
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
