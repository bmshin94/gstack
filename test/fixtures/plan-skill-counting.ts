/** Isolated fake PTY: run the real counter without model calls or shared spies. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject } from '../helpers/ceo-finding-fixture';
import { ceoStep0Boundary, runPlanSkillCounting } from '../helpers/claude-pty-runner';
import { PtyCurrentScreen } from '../helpers/pty-current-screen';

// Exact retained native D3 input from the preview pilot; labels stay intact.
const RETAINED_LETTER_PREFIXED_MODE_INPUT = {
  "questions": [
    {
      "question": "D3 — Which review mode should this CEO review run in?\n\nELI10: This plan has a critical SQL injection vulnerability and zero planned tests for new payment code. The plan also bypasses existing safety middleware. We’ve chosen the ideal architecture approach (Approach B), which fixes the root issues. The mode determines how we evaluate the rest of the plan: do we make it bulletproof as-is, or do we also explore what else could be added?\n\nStakes if we pick wrong: SELECTIVE EXPANSION risks spreading attention across new features when the foundation has critical defects. HOLD SCOPE ensures every failure mode, edge case, and security surface gets mapped before shipping.\n\nRecommendation: C (HOLD SCOPE) because critical security defects in payment processing code demand maximum rigor over scope expansion. Get this right before adding features.\nNote: options differ in kind, not coverage — no completeness score.\n\nPros / cons:\nA) SCOPE EXPANSION\n  ✅ Surfaces ambitious improvements and 10x opportunities\n  ❌ Wrong mode when the plan has a SQL injection — expands scope before fixing the foundation\nB) SELECTIVE EXPANSION\n  ✅ Holds baseline scope, cherry-picks improvements individually\n  ❌ Payment processing with active security holes isn’t ready for expansion surfacing\nC) HOLD SCOPE (Recommended)\n  ✅ Maximum rigor: maps every failure mode, test gap, security vector, and edge case\n  ✅ Right posture for payment code with a SQL injection and no test coverage\n  ❌ Does not surface new features or expansions\nD) SCOPE REDUCTION\n  ✅ Strips to the minimum viable change\n  ❌ The current scope (Approach B) is already well-calibrated — reduction would cut necessary fixes\n\nNet: payment processing + SQL injection + no tests = maximum rigor, not more scope.",
      "header": "Review mode",
      "multiSelect": false,
      "options": [
        {
          "label": "C — HOLD SCOPE (Recommended)",
          "description": "Maximum rigor: map every failure mode, security surface, edge case, and test gap. No expansions."
        },
        {
          "label": "B — SELECTIVE EXPANSION",
          "description": "Hold current scope as baseline, surface cherry-pick opportunities for the user to opt into."
        },
        {
          "label": "A — SCOPE EXPANSION",
          "description": "Dream big: propose ambitious additions, present each for opt-in."
        },
        {
          "label": "D — SCOPE REDUCTION",
          "description": "Find the minimum viable version and cut everything else."
        }
      ]
    }
  ]
};

// Exact retained native input: toolu_01KR2ec2WnBuP9vMvXmRFq4N.
const RETAINED_PARENTHESIZED_MODE_INPUT = {
  "questions": [
    {
      "question": "D1 — Which CEO review mode should I run?\n\nProject: CSV export button for settings page | Branch: main\n\nELI10: The mode controls how aggressively I expand the plan’s scope. EXPANSION means I’ll push you to build a bigger, more ambitious version and advocate for it. SELECTIVE EXPANSION holds your current scope but surfaces each possible expansion individually so you can cherry-pick. HOLD SCOPE reviews what you have with maximum rigor and no scope changes. SCOPE REDUCTION cuts the plan to its absolute minimum.\n\nStakes if we pick wrong: A mode that’s too expansive turns a 2-hour feature into a week-long project; a mode that’s too restrictive misses easy wins sitting right next to the change you’re already making.\n\nRecommendation: B (SELECTIVE EXPANSION) because this is an incremental enhancement to an existing page — the baseline is right, but there may be adjacent 30-minute wins (e.g. copy-to-clipboard, JSON alternative) worth surfacing individually so you can opt in.\n\nNote: options differ in kind, not coverage — no completeness score.",
      "header": "Review Mode",
      "options": [
        {
          "label": "A) SCOPE EXPANSION",
          "description": "Dream big. I’ll propose a 10x more ambitious version and advocate enthusiastically for each scope expansion. You approve each one individually. Good for: when you’re open to rethinking the feature’s ceiling."
        },
        {
          "label": "B) SELECTIVE EXPANSION (recommended)",
          "description": "Hold current scope as the baseline, surface each expansion opportunity individually for you to cherry-pick or skip. Neutral posture — I present the option, you decide. Good for: iteration on an existing system where the baseline is right but you want visibility into adjacent opportunities."
        },
        {
          "label": "C) HOLD SCOPE",
          "description": "The scope is right. Maximum rigor review: architecture, security, error paths, edge cases, observability, deployment. No expansions surfaced. Good for: when the plan is already well-defined and you want ruthless QA, not new ideas."
        },
        {
          "label": "D) SCOPE REDUCTION",
          "description": "Cut to the absolute minimum that ships value. Good for: when the plan is overbuilt or you need to ship something smaller and faster than what’s currently planned."
        }
      ],
      "multiSelect": false
    }
  ]
};

async function main() {
  const completion = process.argv[2];
  const scenario = process.argv[3] ?? 'normal';
  const hookAckLag = scenario.startsWith('hook-ack-lag');
  const lateHookCompletion = scenario.startsWith('hook-ack-lag-late-');
  let publishLateQuestionCompletion: (() => void) | null = null;
  let lateCompletionPickedQuestion: string | null = null;
  const retentionCase = scenario.startsWith('retention-');
  const injectedError = new Error('PRIVATE_CALLBACK_ERROR');
  const ceilingCase = scenario.startsWith('ceiling-');
  const multiQuestionCase = scenario === 'multi-question' || scenario.startsWith('question-picker-multi');
  const terminalDiagnosticCase = scenario.startsWith('terminal-diagnostic-');
  const permissionRepaintCase = scenario.startsWith('permission-repaint-');
  const longPermissionCase = scenario.startsWith('permission-long-frame') || permissionRepaintCase;
  const editPermissionCase = scenario.startsWith('permission-edit-');
  const queuedFileQuestionCase = scenario.startsWith('permission-final-queued-question');
  const nativeBashCase = scenario.startsWith('native-bash-');
  const bashHookLag = nativeBashCase && scenario.includes('hook-lag');
  const queuedBashCase = scenario.startsWith('native-bash-queued-');
  const filePermissionCase = scenario.startsWith('permission-final-') || editPermissionCase;
  const previewCase = scenario.startsWith('preview-menu-');
  const viewportCase = scenario.startsWith('viewport-');
  const exitConfirmationCase = scenario.startsWith('exit-confirmation-');
  const timing = nativeBashCase || longPermissionCase || scenario.startsWith('retention-timeout-') || ceilingCase || multiQuestionCase && scenario.endsWith("no-ack") || terminalDiagnosticCase || exitConfirmationCase || scenario === 'parenthesized-mode-no-ack' || scenario === 'letter-prefixed-mode-no-ack' || viewportCase || previewCase || filePermissionCase || ['setup-exhausted', 'setup-budget', 'launch-budget', 'late-completion', 'timeout-after-question', 'preview-only', 'no-ack', 'hook-no-ack', 'screen-only-plan-ready'].includes(scenario);
  const caseBudgetMs = scenario === 'retention-timeout-boot' ? 4_000 : ceilingCase || viewportCase || previewCase || filePermissionCase ? 60_000 : scenario === 'launch-budget' ? 9_000 : scenario === 'late-completion' ? 12_000 : timing ? 30_000 : 1_500_000;
  const setupMs = scenario === 'setup-exhausted' ? caseBudgetMs + 5_000 : scenario === 'setup-budget' ? 5_000 : 0;
  const reusedOptions = multiQuestionCase || ['reused-options', 'redraw', 'stale-redraw', 'wrong-question', 'question-picker-redraw'].includes(scenario);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'counting-pty-fixture-')));
  const plan = '# Payment Processing\nReview the two independent test gaps.\n';
  const evalDir = path.join(project, 'evals');
  if (retentionCase || hookAckLag || bashHookLag) process.env.GSTACK_EVAL_DIR = evalDir;
  let nativeFile = '';
  let retainedBeforeClose = false;
  const sends: string[] = [];
  const pickerCalls: Array<{ question: unknown; isFirst: boolean }> = [];
  const resizes: number[][] = [];
  let terminalCloseCount = 0;
  let viewportSnapshots = 0;
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
  const permissionWrites: string[] = [];
  const permissionGrantIds: string[] = [];
  const permissionAckIds: string[] = [];
  const bashQuestionAckIds: string[] = [];
  let persistedBashUses = 0;
  const hookCompletionIds: string[] = [];
  let persistedQuestionResults = 0;
  const fileNativeBeforeGrant: boolean[] = [];
  let longPermissionFrame = '';
  let publishDuringScreen: (() => void) | null = null;
  let raceInjected = false;
  let raceJustInjected = false;
  let postExitOwnerRaceScreens = 0;
  const originalScreenSnapshot = PtyCurrentScreen.prototype.snapshot;
  let fixtureRawEnd = 0;
  let lastFixtureFrame: { text: string; rawEnd: number } | null = null;
  if (retentionCase) PtyCurrentScreen.prototype.snapshot = async function () {
    const rawEnd = fixtureRawEnd;
    const frame = await originalScreenSnapshot.call(this);
    lastFixtureFrame = { text: frame.text, rawEnd };
    return frame;
  };
  if (longPermissionCase || scenario.endsWith('arrival-race') || scenario === 'terminal-diagnostic-frame-race' || scenario === 'permission-final-input-race' || scenario === 'viewport-flush-deadline') PtyCurrentScreen.prototype.snapshot = async function () {
    if (scenario === 'exit-confirmation-early-owner-arrival-race' && raceInjected) postExitOwnerRaceScreens++;
    const frame = await originalScreenSnapshot.call(this);
    if (longPermissionCase && frame.text.includes(' Create file')) longPermissionFrame = frame.text;
    if (scenario === 'permission-repaint-deadline' && frame.text.includes('pl n.md') && ++viewportSnapshots === 2) clock = caseBudgetMs;
    if (scenario === 'viewport-flush-deadline' && frame.rows === 40 && frame.text.includes('Clipped native prompt') && ++viewportSnapshots === 2) clock = caseBudgetMs;
    const publish = publishDuringScreen;
    publishDuringScreen = null;
    publish?.();
    return frame;
  };
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
    if (scenario === 'retention-write-failure' || scenario === 'retention-timeout-write-failure') fs.writeFileSync(evalDir, 'not a directory');
    clock += setupMs;
    process.env.BROWSE_TERMINAL_BINARY = process.execPath;
    process.env.EVALS_HERMETIC = '1';
    Bun.spawn = ((_command: string[], options: any) => {
      launches++;
      if (scenario === 'launch-budget') clock += 2_000;
      const sessionId = _command[_command.indexOf('--session-id') + 1];
      const file = path.join(options.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture', `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      nativeFile = file;
      const append = (row: Record<string, unknown>) => fs.appendFileSync(file, JSON.stringify({ sessionId, timestamp: new Date(originalNow()).toISOString(), ...row }) + '\n');
      append({ type: 'user', message: { role: 'user', content: 'Review the supplied plan.' } });
      // A real PTY's ONLCR output converts these fixture newlines to CRLF.
      let latestPaint = '';
      const emit = (value: string) => {
        latestPaint = value;
        const rendered = value.replace(/(?<!\r)\n/g, '\r\n');
        fixtureRawEnd += rendered.length;
        options.terminal.data(null, Buffer.from(rendered));
      };
      const longQuestion = 'D1 — Pick a mode\n' + Array.from({ length: 45 }, (_, i) => `Context paragraph ${i}: Review the supplied design carefully.`).join('\n');
      const clipped = 'Clipped native prompt\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
      const complete = '☐ Review mode\n' + longQuestion.slice(0, 2000) + '…\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
      const finding = (number: number) => `\nFinding ${number} — ${number === 1 ? 'Success' : 'Failure'} test\n\n❯ 1. ${reusedOptions ? 'Add test' : number === 1 ? 'Add receipt assertion' : 'Add retry assertion'}\n  2. ${reusedOptions ? 'Skip test' : number === 1 ? 'Skip receipt test' : 'Skip retry test'}\n`;
      let sequence = 0;
      let pendingId: string | null = null;
      const hookQuestionInputs = new Map<string, any>();
      let permissionId: string | null = null;
      let permissionInput: Record<string, unknown> | null = null;
      let permissionOperation: 'create' | 'overwrite' = 'create';
      let initialPermissionId: string | null = null;
      let finalPermissionPending = false;
      let finalWriteCount = 0;
      const finalReport = [...Array.from({ length: 516 }, (_, i) => `Report line ${i + 1}`), '## GSTACK REVIEW REPORT', 'VERDICT: APPROVED'].join('\n');
      const longPermissionPath = permissionRepaintCase ? path.join(project, 'plan.md') : path.join(project, 'gstack-home/projects/gstack-e2e-plan-ceo-paired-fixture/ceo-plans/2026-09-09-payment-test-coverage.md');
      // The retained V5 shape: complete 240-column header, preview and compound
      // option 2. Its full native path must survive classification and binding.
      const longPermissionDialog = () => '\x1b[2J\x1b[H' + '─'.repeat(240) + '\n Create file\n '
        + path.relative(project, longPermissionPath) + '\n' + '╌'.repeat(240) + '\n'
        + Array.from({ length: 8 }, (_, i) => ` ${i + 1} ${'Plan context '.repeat(8)}`).join('\n') + '\n' + '╌'.repeat(240)
        + '\n Do you want to create ' + path.basename(longPermissionPath) + '?\n ❯ 1. Yes\n'
        + '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; Yes, and always allow access to\n      '
        + path.dirname(longPermissionPath) + ' for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend';
      const permissionRepaintDialog = () => longPermissionDialog().replace('; Yes, and always allow access to\n      ' + path.dirname(longPermissionPath) + ' for this session', '');
      const corruptedPermissionDialog = () => scenario.startsWith('permission-repaint-controls')
        ? longPermissionDialog().replace('3. No', '3. Nohift+tab)')
        : permissionRepaintDialog().replace('\n ' + path.relative(project, longPermissionPath) + '\n',
        '\n ' + path.relative(project, longPermissionPath).replace('plan.md', 'pl n.md') + '\n');
      const fileDialog = (operation: string) => {
        const settings = scenario === 'permission-edit-settings';
        const header = settings ? '─'.repeat(240) + '\n Edit file\n plan.md\n' + '╌'.repeat(240) + '\n' : '';
        const option2 = settings ? 'Yes, and allow Claude to edit its own settings for this session'
          : 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)';
        return `\x1b[2J\x1b[H${header}Do you want to ${operation} plan.md?\n❯1.Yes\n2.${option2}\n3.No\nEsc to cancel`;
      };
      const nativeBashInput = { command: 'printf %s ready > probe.txt', description: 'Write the owned marker' };
      // Source-shaped short native card; no legacy "requires permission" sentence.
      const nativeBashDialog = () => '\x1b[2J\x1b[H' + '─'.repeat(240) + '\n Bash command\n\n   '
        + nativeBashInput.command + '\n   ' + nativeBashInput.description
        + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
      const recordBash = (event: string, id: string, input: unknown, extra: Record<string, unknown> = {}) => {
        const settings = JSON.parse(fs.readFileSync(_command[_command.indexOf('--settings') + 1], 'utf8'));
        const recorded = Bun.spawnSync(['bash', '-c', settings.hooks[event][0].hooks[0].command], {
          timeout: 5000, stdin: Buffer.from(JSON.stringify({ hook_event_name: event, session_id: sessionId,
            transcript_path: file, cwd: options.cwd, tool_name: 'Bash', tool_use_id: id, tool_input: input, ...extra })),
          stdout: 'pipe', stderr: 'pipe',
        });
        if (recorded.exitCode !== 0 || recorded.stdout.length) throw new Error(`Bash recorder failed: ${recorded.stderr}`);
      };
      const recordFilePermission = (input: Record<string, unknown>, name = 'Write') => {
        const settings = JSON.parse(fs.readFileSync(_command[_command.indexOf('--settings') + 1], 'utf8'));
        const recorded = Bun.spawnSync(['bash', '-c', settings.hooks.PermissionRequest[0].hooks[0].command], {
          timeout: 5000, stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sessionId,
            transcript_path: file, cwd: options.cwd, tool_name: name, tool_input: input })), stdout: 'pipe', stderr: 'pipe',
        });
        if (recorded.exitCode !== 0 || recorded.stdout.length) throw new Error(`Permission recorder failed: ${recorded.stderr}`);
      };
      const tool = (name: string, input: unknown) => {
        const id = `tool-${++sequence}`;
        if (name === 'Bash' && bashHookLag) {
          recordBash('PreToolUse', id, input, scenario.endsWith('foreign') ? { session_id: '00000000-0000-4000-8000-000000000099' } : {});
          recordBash('PermissionRequest', id, input);
        } else if (name === 'AskUserQuestion' && (scenario.startsWith('hook-') || scenario.startsWith('retention-questions'))) {
          hookQuestionInputs.set(id, input);
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
      // Synthetic full modal from pinned CLI 2.1.257's empty-plan renderer.
      // The failed pilot retained only a truncated suffix, not this full frame.
      const exitConfirmation = () => {
        if (scenario === 'exit-confirmation-early-full-plan') return 'Ready to code?\n\nHere is Claude\'s plan:\n'
          + '# Review complete\n## GSTACK REVIEW REPORT\nVERDICT: APPROVED\n'
          + 'Claude has written up a plan and is ready to execute. Would you like to proceed?\n'
          + '❯ 1. Yes, and use auto mode\n  2. Yes, manually approve edits\n  3. Tell Claude what to change\n';
        const focus = scenario === 'exit-confirmation-no-focus-choice' ? 2 : 1;
        const pointer = scenario === 'exit-confirmation-ascii-fallback' ? '>' : '❯';
        const yes = ['exit-confirmation-ascii-fallback', 'exit-confirmation-short-rule-fallback'].includes(scenario) ? 'Yes'
          : 'Yes, and switch to default (ask each time) for this session';
        let text = '─'.repeat(120) + '\n Exit plan mode?\n\n  Claude wants to exit plan mode\n\n'
          + `  ${focus === 1 ? pointer : ' '} 1. ${yes}\n  ${focus === 2 ? pointer : ' '} 2. No\n`;
        if (scenario === 'exit-confirmation-missing-rule') text = text.slice(text.indexOf('\n') + 1);
        if (scenario === 'exit-confirmation-rounded-rule') text = '╭' + text.slice(1, 119) + '╮' + text.slice(120);
        if (scenario === 'exit-confirmation-short-rule-fallback') text = '─'.repeat(10) + text.slice(120);
        if (scenario === 'exit-confirmation-clipped-no') text = text.replace('2. No', '2.N');
        if (scenario === 'exit-confirmation-wrong-mode') text = text.replace('default (ask each time)', 'accept edits (auto-approve edits)');
        if (scenario === 'exit-confirmation-no-pointer') text = text.replace('❯', ' ');
        if (scenario === 'exit-confirmation-duplicate-pointer') text = text.replace('    2. No', '  ❯ 2. No');
        if (scenario === 'exit-confirmation-duplicate-option') text = text.replace('2. No', '1. No');
        if (scenario === 'exit-confirmation-extra-option') text += '    3. Later\n';
        if (scenario === 'exit-confirmation-invented-footer') text += 'Enter to confirm\n';
        if (scenario === 'exit-confirmation-prose') text = 'The dialog will say Exit plan mode? Claude wants to exit plan mode, with Yes or No.\n';
        if (scenario === 'exit-confirmation-quoted') text = text.split('\n').map(line => '> ' + line).join('\n');
        if (scenario === 'exit-confirmation-fenced') text = '```text\n' + text + '```\n';
        if (scenario === 'exit-confirmation-open-fence') text = '```text\n' + text;
        if (scenario === 'exit-confirmation-history') text = 'Finished writing the report.\n```text\nEarlier example\n```\n' + text;
        return text;
      };
      const requestExitConfirmation = () => {
        let id: string | undefined;
        if (scenario.startsWith('exit-confirmation-early-')) {
          id = `tool-${++sequence}`;
          const input = { plan: finalReport, planFilePath: path.join(project, 'plan.md'), allowedPrompts: [] };
          const settings = JSON.parse(fs.readFileSync(_command[_command.indexOf('--settings') + 1], 'utf8'));
          const recordExit = () => {
            const recorded = Bun.spawnSync(['bash', '-c', settings.hooks.PreToolUse[0].hooks[0].command], {
              timeout: 5000, stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId,
                transcript_path: file, cwd: options.cwd, tool_name: 'ExitPlanMode', tool_use_id: id, tool_input: input })),
              stdout: 'pipe', stderr: 'pipe',
            });
            if (recorded.exitCode !== 0 || recorded.stdout.length) throw new Error(`Exit recorder failed: ${recorded.stderr}`);
          };
          recordExit();
          if (scenario.endsWith('unfinished') || scenario.endsWith('persisted')) append({ type: 'assistant', cwd: options.cwd,
            message: { role: 'assistant', stop_reason: scenario.endsWith('unfinished') ? null : 'tool_use',
              content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input }] } });
          if (scenario.endsWith('pending-bytes')) fs.appendFileSync(file, '{"type":');
          if (scenario.endsWith('owner-arrival-race')) publishDuringScreen = () => {
            raceInjected = true;
            append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } });
            id = `tool-${++sequence}`;
            recordExit();
          };
        } else if (scenario === 'exit-confirmation-unfinished-owner' || scenario === 'exit-confirmation-foreign-owner') {
          id = `tool-${++sequence}`;
          append({ type: 'assistant', ...(scenario.endsWith('foreign-owner') ? { sessionId: '11111111-1111-4111-8111-111111111111' } : {}),
            message: { id, role: 'assistant', stop_reason: scenario.endsWith('unfinished-owner') ? null : 'tool_use',
              content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: {} }] } });
        } else if (scenario === 'exit-confirmation-tool-search') tool('ToolSearch', { query: 'select:ExitPlanMode' });
        else if (scenario !== 'exit-confirmation-no-owner') id = tool('ExitPlanMode', {});
        const completeExit = (isError = false) => append({ type: 'user', message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'Exit request resolved', ...(isError ? { is_error: true } : {}) }] } });
        if (scenario === 'exit-confirmation-completed-owner' || scenario === 'exit-confirmation-error-owner' || scenario === 'exit-confirmation-early-completed' || scenario === 'exit-confirmation-early-error') completeExit(scenario.endsWith('error-owner') || scenario.endsWith('early-error'));
        if (scenario === 'exit-confirmation-pending-question') {
          pendingId = tool('AskUserQuestion', { questions: [{ question: 'Which remaining finding should we address?', header: 'Finding', multiSelect: false,
            options: ['Address it', 'Keep reviewing'].map(label => ({ label, description: label })) }] });
        }
        const pendingWrite = () => tool('Write', { file_path: path.join(project, 'plan.md'), content: plan });
        if (scenario === 'exit-confirmation-pending-write' || scenario === 'exit-confirmation-early-pending-write') pendingWrite();
        if (scenario === 'exit-confirmation-pending-file-request') recordFilePermission({ file_path: path.join(project, 'plan.md'), content: plan });
        if (scenario === 'exit-confirmation-completed-arrival-race' || scenario === 'exit-confirmation-write-arrival-race' || scenario === 'exit-confirmation-early-completed-arrival-race') {
          publishDuringScreen = () => {
            raceInjected = true;
            if (scenario.endsWith('completed-arrival-race')) completeExit(); else pendingWrite();
          };
        }
        if (scenario === 'exit-confirmation-stale-frame') return;
        const text = exitConfirmation();
        if (scenario === 'exit-confirmation-current-frame') {
          emit('\x1b[2J\x1b[H' + text.replace('Exit plan mode?', 'Exit pln mode?'));
          emit('\x1b7\x1b[2;9H\x1b[@a\x1b8');
        } else emit('\x1b[2J\x1b[H' + text);
      };
      const ask = (question: string, labels: string[]) => {
        pendingId = tool('AskUserQuestion', { questions: [{ question, header: question, multiSelect: scenario === 'multi-select', options: labels.map(label => ({ label, description: `Choose ${label}` })) }] });
        if (scenario === 'hook-ack-lag-unsolicited') acknowledge();
      };
      const acknowledge = () => {
        if (hookAckLag) {
          const input = hookQuestionInputs.get(pendingId!);
          const chosen = scenario.endsWith('wrong-answer') && (!lateHookCompletion || answer === 1)
            ? 2 : scenario.endsWith('unsolicited') ? 1 : Number(sends.at(-1));
          const answers = scenario.endsWith('cancel') ? {} : Object.fromEntries(input.questions.map((q: any) =>
            [q.question, q.options[chosen - 1].label]));
          const settings = JSON.parse(fs.readFileSync(_command[_command.indexOf('--settings') + 1], 'utf8'));
          const id = pendingId!;
          const response = { questions: input.questions, answers };
          const publish = () => {
            const recorded = Bun.spawnSync(['bash', '-c', settings.hooks.PostToolUse[0].hooks[0].command], {
              timeout: 5000, stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sessionId,
                transcript_path: file, cwd: options.cwd, tool_name: 'AskUserQuestion', tool_use_id: id,
                tool_input: { ...input, answers }, tool_response: response })),
              stdout: 'pipe', stderr: 'pipe',
            });
            if (recorded.exitCode !== 0 || recorded.stdout.length || recorded.stderr.length) throw new Error('Question completion recorder failed');
            hookCompletionIds.push(id);
          };
          if (lateHookCompletion && answer === 1) {
            const selected = input.questions.map((q: any) => `"${q.question}"="${answers[q.question]}"`).join(', ');
            append({ type: 'user', toolUseResult: response, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
              content: `Your questions have been answered: ${selected}. You can now continue with these answers in mind.` }] } });
            persistedQuestionResults++;
            // The second question picker runs only after the first result has
            // been counted; publish its hook there, not during the same read.
            publishLateQuestionCompletion = publish;
          } else publish();
        } else {
          append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: pendingId, content: 'Answer accepted' }] } });
          persistedQuestionResults++;
        }
        pendingId = null;
      };
      const finish = () => {
        if (scenario !== 'ceiling-null-no-owner') append({ type: 'assistant', message: { id: 'final', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: completion }] } });
        emit('\n' + completion.replace(/\*|#| /g, '') + '\n');
      };
      // Same append shape as the retained final-report Edit: the observer can
      // precede its native invocation, but it cannot supply that invocation's ACK.
      const resolvedParagraph = '### Unresolved Decisions\n\nNone. The review choices were answered.';
      const reportAppend = '\n\n---\n\n## GSTACK REVIEW REPORT\n\n| Review | Runs | Status | Findings |\n| CEO | 1 | CLEAR | Review complete |\n\nVERDICT: APPROVED';
      const requestFinalEdit = () => {
        finalPermissionPending = true;
        permissionInput = { file_path: path.join(project, 'plan.md'), old_string: resolvedParagraph,
          new_string: resolvedParagraph + reportAppend, replace_all: false };
        permissionId = scenario === 'permission-edit-native' ? tool('Edit', permissionInput) : `tool-${++sequence}`;
        const publish = () => recordFilePermission(permissionInput!, 'Edit');
        if (scenario === 'permission-edit-arrival-race') {
          emit(fileDialog('make this edit to'));
          // The hook arrives during the old frame snapshot. No input may be
          // sent on that mixed-source pass, even though the path is unchanged.
          publishDuringScreen = () => {
            publish(); raceInjected = true; raceJustInjected = true;
            emit(fileDialog('make this edit to'));
          };
        } else { publish(); emit(fileDialog('make this edit to')); }
      };
      const requestFinalWrite = () => {
        if (editPermissionCase) { requestFinalEdit(); return; }
        finalPermissionPending = true;
        permissionOperation = 'overwrite';
        permissionInput = { file_path: path.join(project, scenario === 'permission-final-mismatch' ? 'different.md' : 'plan.md'), content: finalReport + (finalWriteCount && scenario !== 'permission-final-repeat-identical' ? '\nAnother overwrite' : '') };
        permissionId = `tool-${++sequence}`;
        if (scenario === 'permission-final-native') append({ type: 'assistant', cwd: options.cwd,
          message: { id: permissionId, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: permissionId, name: 'Write', input: permissionInput }] } });
        const publishPermission = () => {
          // Real local PermissionRequest observer; there is no native ID in
          // this hook payload. The native invocation is deliberately delayed.
          recordFilePermission(permissionInput!);
        };
        if (['permission-final-arrival-race', 'permission-final-completion-arrival-race', 'permission-final-ready-arrival-race'].includes(scenario)) {
          if (scenario === 'permission-final-completion-arrival-race') {
            append({ type: 'assistant', message: { id: 'old-final', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: completion }] } });
            emit('\n' + completion + '\n');
          } else if (scenario === 'permission-final-ready-arrival-race') {
            tool('ExitPlanMode', {});
            emit('\nReady to execute?\n');
          } else emit(fileDialog('create'));
          // A new request arrives after this barrier captured CREATE. This
          // iteration must not grant against that preceding same-path frame.
          publishDuringScreen = () => {
            publishPermission(); raceInjected = true; raceJustInjected = true; emit(fileDialog('overwrite'));
          };
          return;
        }
        if (scenario !== 'permission-final-unowned') publishPermission();
        if (scenario === 'permission-final-old-completion') {
          append({ type: 'assistant', message: { id: 'old-final', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: completion }] } });
        }
        if (scenario === 'permission-final-old-ready') tool('ExitPlanMode', {});
        if (scenario === 'permission-final-stale-create') {
          emit(fileDialog('create'));
          delayedRender = () => emit(fileDialog('overwrite'));
          pendingRedrawSleeps = 3;
        } else emit(fileDialog('overwrite'));
        if (scenario === 'permission-final-old-completion') emit('\n' + completion + '\n');
        if (scenario === 'permission-final-old-ready') emit('\nReady to execute?\n');
      };
      finishLate = () => { lateCompletionSent = true; finish(); };
      showSecondFinding = () => { ask('Finding 2 — Failure test', [reusedOptions ? 'Add test' : 'Add retry assertion', reusedOptions ? 'Skip test' : 'Skip retry test']); emit(finding(2)); };
      let end: (code: number) => void = () => {};
      let answer = 0;
      let batchQuestion = 0;
      let previewFocus = 1;
      let previewQuestion = '';
      let previewLabels: string[] = [];
      const showPreview = () => emit('\x1b[2J\x1b[H' + `☐ ${previewQuestion}\n${previewQuestion}\n`
        + previewLabels.map((label, i) => `${previewFocus === i + 1 ? '❯' : ' '} ${i + 1}. ${label}`.padEnd(40)
          + (i === 0 ? '┌' + '─'.repeat(30) + '┐' : '│' + 'No preview available'.padEnd(30) + '│')).join('\n')
        + (previewFocus === 2 && scenario.startsWith('preview-menu-clipping-ruler')
          ? '\n' + ' '.repeat(40) + (scenario.endsWith('malformed') ? '├─── x ─── 1 lines hidden ' : '├─── ✂ ─── 1 lines hidden ').padEnd(31, '─') + '┤' : '')
        + '\n' + ' '.repeat(40) + '└' + '─'.repeat(30) + '┘'
        + '\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel\n');
      const nextPreview = () => {
        previewFocus = 1;
        previewQuestion = answer === 0 ? 'D1 — Pick a mode' : `Finding ${answer} — Preview choice`;
        previewLabels = answer === 0 ? ['HOLD SCOPE', 'SCOPE EXPANSION'] : [`Add test ${answer}`, `Skip test ${answer}`];
        pendingId = tool('AskUserQuestion', { questions: [{ question: previewQuestion, header: previewQuestion, multiSelect: false,
          options: previewLabels.map((label, i) => ({ label, description: label, ...(i === 0 ? { preview: 'Choice details' } : {}) })) }] });
        showPreview();
      };
      // A native request arriving later cannot reuse this pre-command frame.
      if (scenario === 'exit-confirmation-stale-frame') emit('\x1b[2J\x1b[H' + exitConfirmation());
      if (scenario === 'retention-timeout-stale-frame') emit(fileDialog('create'));
      if (scenario === 'permission-long-frame-stale') emit(longPermissionDialog());
      if (scenario === 'native-bash-stale' || scenario === 'native-bash-queued-stale') emit(nativeBashDialog());
      return {
        exited: new Promise<number>(resolve => { end = resolve; }),
        terminal: {
          ...(viewportCase || permissionRepaintCase ? { resize(cols: number, rows: number) {
            resizes.push([cols, rows]);
            if (permissionRepaintCase) {
              if (scenario === 'permission-repaint-failure') throw new Error('controlled permission resize failure');
              if (scenario === 'permission-repaint-no-output') return;
              if (rows === 40) { emit('\x1b[2J\x1b[H' + latestPaint); return; }
              if (scenario === 'permission-repaint-owner-change') {
                append({ type: 'assistant', cwd: options.cwd, message: { role: 'assistant', stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: permissionId, name: 'Write', input: { ...permissionInput, content: 'Different owner input' } }] } });
              }
              emit(scenario === 'permission-repaint-still-conflicting' || scenario === 'permission-repaint-controls-malformed'
                ? corruptedPermissionDialog() : permissionRepaintDialog());
              return;
            }
            if (scenario === 'viewport-resize-failure') throw new Error('controlled resize failure');
            if (scenario === 'viewport-no-output' || rows === 40 && scenario === 'viewport-ready-no-restore-output') return;
            const paint = rows === 40 ? latestPaint : scenario === 'viewport-cap' ? clipped : complete;
            emit('\x1b[2J\x1b[H' + paint);
          }, close() { terminalCloseCount++; } } : {}),
          write(data: string) {
          sends.push(data);
          sendTimes.push(Date.now() - caseStartedAt);
          if (previewCase) {
            if (data.startsWith('/')) { seededBeforeSlash = fs.readFileSync(path.join(options.cwd, 'review-input.md'), 'utf8') === plan; nextPreview(); return; }
            if (/^[12]$/.test(data)) {
              if (Number(data) === previewFocus) return; // React no-op: no redraw.
              if (!scenario.endsWith('stale-focus')) { previewFocus = Number(data); showPreview(); }
              return;
            }
            const desired = scenario === 'preview-menu-focused' ? 1 : 2;
            if (data !== '\r' || previewFocus !== desired || !pendingId) { prematureAnswers.push(data); return; }
            if (scenario.endsWith('no-ack')) return;
            acknowledge(); answer++;
            if (answer === 3) finish(); else nextPreview();
            return;
          }
          if (data.startsWith('/')) {
            seededBeforeSlash = fs.readFileSync(path.join(options.cwd, 'review-input.md'), 'utf8') === plan;
            if (terminalDiagnosticCase) {
              // The existing full-plan predicate matches this observed footer;
              // only owned native state may authorize a read-only terminal.
              if (!scenario.endsWith('no-owner')) tool('ExitPlanMode', {});
              if (scenario.endsWith('pending-tool')) tool('ToolSearch', { query: 'PRIVATE_DIAGNOSTIC_INPUT' });
              if (scenario.endsWith('pending-auq')) ask('PRIVATE_DIAGNOSTIC_QUESTION', ['PRIVATE_OPTION_ONE', 'PRIVATE_OPTION_TWO']);
              if (scenario.endsWith('pending-file')) recordFilePermission({ file_path: path.join(project, 'plan.md'), content: 'PRIVATE_DIAGNOSTIC_INPUT' });
              if (scenario.endsWith('pending-bytes')) fs.appendFileSync(file, '{"type":"assistant"');
              if (scenario.endsWith('bounded')) for (let i = 0; i < 20; i++) {
                const id = `pending-${i}-` + 'i'.repeat(256);
                append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id,
                  name: 'n'.repeat(128), input: { secret: 'PRIVATE_DIAGNOSTIC_INPUT' } }] } });
              }
              if (scenario.endsWith('frame-race')) {
                const publish = () => { tool('ToolSearch', { query: 'PRIVATE_DIAGNOSTIC_INPUT' }); publishDuringScreen = publish; };
                publishDuringScreen = publish;
              }
              emit('\x1b[2J\x1b[HReady to code?\nHere is Claude\'s plan:\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n❯ 1. Yes, and use auto mode\n  2. Yes, manually approve edits\n  3. Tell Claude what to change\n');
              return;
            }
            if (scenario === 'exit-confirmation-stale-frame') { requestExitConfirmation(); return; }
            if (scenario === 'setup-budget' || scenario === 'launch-budget' || scenario === 'setup-exhausted') {
              emit('WORK_IN_PROGRESS\n');
              return;
            }
            if (viewportCase) {
              pendingId = tool('AskUserQuestion', { questions: [{ question: longQuestion, header: 'Review mode', multiSelect: false,
                options: ['HOLD SCOPE', 'SCOPE EXPANSION'].map(label => ({ label, description: label })) }] });
              emit('\x1b[2J\x1b[H' + clipped); return;
            }
            if (scenario === 'screen-only-plan-ready') {
              tool('ExitPlanMode', {});
              emit('\x1b[2J\x1b[HReay to execute?\n');
              emit('\x1b7\x1b[1;4H\x1b[@d\x1b8');
              return;
            }
            if (longPermissionCase) {
              permissionInput = { file_path: longPermissionPath + (scenario.endsWith('mismatch') ? '.other' : ''), content: plan };
              permissionId = tool('Write', permissionInput);
              recordFilePermission(permissionInput);
              if (scenario.endsWith('ambiguous')) tool('Write', { file_path: path.join(project, 'other.md'), content: 'Other' });
              if (!scenario.endsWith('stale')) emit(permissionRepaintCase ? corruptedPermissionDialog() : longPermissionDialog());
              return;
            }
            if (filePermissionCase) {
              if (editPermissionCase) {
                fs.writeFileSync(path.join(project, 'plan.md'), 'Draft');
                permissionInput = { file_path: path.join(project, 'plan.md'), old_string: 'Draft', new_string: resolvedParagraph, replace_all: false };
                permissionId = tool('Edit', permissionInput);
                recordFilePermission(permissionInput, 'Edit');
                emit(fileDialog('make this edit to'));
                return;
              }
              permissionInput = { file_path: path.join(project, scenario === 'permission-final-queued-question-mismatch' ? 'different.md' : 'plan.md'), content: plan };
              permissionId = scenario === 'permission-final-first-arrival-race' ? `tool-${++sequence}` : tool('Write', permissionInput);
              initialPermissionId = permissionId;
              // Native can persist an AUQ while an earlier Write still owns
              // the modal. The AUQ must remain queued until its own paint.
              if (queuedFileQuestionCase) ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
              if (scenario === 'permission-final-queued-question-ambiguous') tool('Write', { file_path: path.join(project, 'other.md'), content: 'Other' });
              if (scenario !== 'permission-final-queued-question-stale') emit(scenario === 'permission-final-queued-question-malformed'
                ? fileDialog('create').replace('3.No', '3.Maybe') : fileDialog('create'));
              if (scenario === 'permission-final-first-arrival-race') publishDuringScreen = () => {
                recordFilePermission(permissionInput!); raceInjected = true; raceJustInjected = true;
              };
              else if (scenario === 'permission-final-input-race') publishDuringScreen = () => {
                recordFilePermission({ ...permissionInput, content: 'Changed by an earlier tool hook' }); raceInjected = true; raceJustInjected = true;
              };
              else if (!['permission-final-missing-request', 'permission-final-queued-question-missing-request'].includes(scenario)) recordFilePermission(permissionInput);
              return;
            }
            if (scenario.startsWith('permission-current-create') || scenario === 'permission-current-overwrite') {
              const input = { file_path: path.join(project, scenario.endsWith('mismatch') ? 'different.md' : 'plan.md'), content: plan };
              permissionId = tool('Write', input);
              recordFilePermission(input);
              const prompt = `Do you want to ${scenario === 'permission-current-overwrite' ? 'overwrite' : 'create'} pln.md?`;
              emit('\x1b[2J\x1b[H' + prompt + '\n❯1.Yes\n2.Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel');
              // A cursor insertion restores the exact filename on screen. An
              // append-and-strip view still contains the wrong name pln.md.
              emit(`\x1b7\x1b[1;${prompt.indexOf('pln.md') + 3}H\x1b[@a\x1b8`);
              return;
            }
            if (retentionCase && scenario !== 'retention-original-error') {
              append({ type: 'assistant', message: { role: 'assistant', content: [
                { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
                { type: 'tool_use', id: 'completed-tool', name: 'Bash', input: { command: 'PRIVATE_BASH_ENV=secret' } },
              ] } });
              append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'completed-tool', content: 'PRIVATE_RESULT' }] } });
              if (scenario.startsWith('retention-questions')) {
                ask('D4 — Keep scope narrow?', ['Keep scope', 'Expand scope']);
                if (scenario === 'retention-questions-conflict') {
                  append({ type: 'assistant', cwd: options.cwd, message: { role: 'assistant', stop_reason: null,
                    content: [{ type: 'tool_use', id: pendingId, name: 'AskUserQuestion', input: { questions: [{
                      question: 'D4 — A different scope question', header: 'D4 — Keep scope narrow?', multiSelect: false,
                      options: ['Keep scope', 'Expand scope'].map(label => ({ label, description: `Choose ${label}` })),
                    }] } }] } });
                  emit('PRIVATE_SCREEN_PREVIEW');
                  return;
                }
                ask('D5 — Which review mode?', ['HOLD SCOPE', 'SCOPE EXPANSION']);
                emit('D4 — Keep scope narrow?\n❯1.Keep scope\n2.Expand scope\nPRIVATE_SCREEN_PREVIEW');
                return;
              }
              if (scenario.startsWith('retention-queue-')) {
                append({ type: 'queue-operation', operation: scenario.endsWith('operation') ? 'unrecognized' : 'enqueue',
                  content: scenario.endsWith('content') ? { text: 'PRIVATE_QUEUE' } : 'PRIVATE_QUEUE', uuid: 'queue-1' });
                emit('PRIVATE_SCREEN_PREVIEW\n');
                return;
              }
              const input = { file_path: path.join(project, 'plan.md'), content: 'PRIVATE_WRITE_CONTENT' };
              permissionId = tool('Write', input);
              recordFilePermission(input);
              if (scenario.startsWith('retention-timeout-')) {
                if (scenario === 'retention-timeout-stale-frame') return;
                if (scenario === 'retention-timeout-frame-conflict') {
                  const rule = '─'.repeat(240);
                  // Synthetic ambiguous full viewport: the tail has one valid
                  // header but the full frame has two. No authority is granted.
                  emit('\x1b[2J\x1b[H' + rule + '\n Create file\n earlier.md\n'
                    + 'Earlier context '.repeat(120) + '\n' + rule + '\n Create file\n plan.md\n'
                    + fileDialog('create').replace(/^\x1b\[2J\x1b\[H/, ''));
                  return;
                }
                emit(scenario === 'retention-timeout-numbered' ? 'Requested permissions to create plan.md\nPRIVATE_SCREEN_PREVIEW'
                  : 'PRIVATE_SCREEN_PREVIEW\n❯1.Yes\n2.No\n');
                return;
              }
              if (scenario === 'retention-ambiguous') tool('Edit', { file_path: path.join(project, 'other.md'), old_string: 'PRIVATE_OLD', new_string: 'PRIVATE_NEW' });
              emit(fileDialog(scenario === 'retention-binding' ? 'create different.md instead of' : 'create') + '\nPRIVATE_SCREEN_PREVIEW');
              if (scenario === 'retention-write-failure') tool('Edit', { file_path: path.join(project, 'other.md'), old_string: 'PRIVATE_OLD', new_string: 'PRIVATE_NEW' });
              return;
            }
            if (nativeBashCase) {
              permissionId = tool('Bash', scenario === 'native-bash-queued-malformed' ? { ...nativeBashInput, command: null } : nativeBashInput);
              if (scenario === 'native-bash-ambiguous' || scenario === 'native-bash-queued-ambiguous') tool('Read', { file_path: '/fixture' });
              if (scenario === 'native-bash-queued-file') recordFilePermission({ file_path: path.join(project, 'other.md'), content: 'Other pending file' });
              if (scenario === 'native-bash-queued-unknown') tool('ToolSearch', { query: 'tools' });
              if (queuedBashCase) ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
              if (scenario === 'native-bash-stale' || scenario === 'native-bash-queued-stale') return;
              let card = nativeBashDialog();
              if (scenario === 'native-bash-command-mismatch' || scenario === 'native-bash-queued-mismatch' || bashHookLag && scenario.endsWith('mismatch')) card = card.replace('printf %s ready', 'printf %s changed');
              if (scenario === 'native-bash-history') card += '\n❯ New unrelated draft';
              if (scenario === 'native-bash-clipped') card = card.replace(nativeBashInput.command, 'printf %s ready…');
              if (scenario === 'native-bash-wrong-focus') card = card.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No');
              emit(card);
              return;
            }
            if (['permission-redraw', 'permission-ambiguous', 'permission-owner-change'].includes(scenario)) {
              permissionId = tool('Bash', { command: 'true' });
              if (scenario === 'permission-ambiguous') tool('Read', { file_path: '/fixture' });
              emit('Bash command true requires permission\n❯1.Yes\n2.No\n');
              return;
            }
            const previewId = tool('Read', { content: '## GSTACK REVIEW REPORT\nVERDICT: APPROVED' });
            append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: previewId, content: 'Preview read' }] } });
            if (scenario.startsWith('letter-prefixed-mode') || scenario.startsWith('parenthesized-mode')) {
              const input = scenario.startsWith('parenthesized-mode') ? RETAINED_PARENTHESIZED_MODE_INPUT : RETAINED_LETTER_PREFIXED_MODE_INPUT;
              pendingId = tool('AskUserQuestion', input);
              const question = input.questions[0];
              emit(`\x1b[2J\x1b[H☐ ${question.header}\n${question.question.split('\n')[0]}\n`
                + question.options.map((option, i) => `${i === 0 ? '❯' : ''}${i + 1}.${option.label}`).join('\n') + '\n');
              return;
            }
            if (scenario !== 'preview-only') ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
            // Actual failure: a preview in PTY while the assistant still uses tools.
            emit('Read: GSTACK REVIEW REPORT\nVERDICT: APPROVED\n\nD1 — Pick a mode\n\n❯ 1. HOLD SCOPE\n  2. SCOPE EXPANSION\n');
          } else if (data === '\r' && multiQuestionCase && batchQuestion === 2) {
            if (scenario.endsWith('no-ack')) return;
            acknowledge();
            finish();
          } else if (/^[12]\r?$/.test(data)) {
            if (permissionId) {
              if (data !== '1\r') throw new Error('Permission must select only the current request');
              if (nativeBashCase) {
                permissionGrantIds.push(permissionId);
                if (!scenario.endsWith('no-ack')) {
                  if (bashHookLag) {
                    if (scenario.endsWith('failure')) recordBash('PostToolUseFailure', permissionId, nativeBashInput,
                      { error: 'Command failed with exit code 1', is_interrupt: false });
                    else recordBash('PostToolUse', permissionId, nativeBashInput, { tool_response: { stdout: 'ready', stderr: '', interrupted: false,
                      ...(scenario.endsWith('background') ? { backgroundTaskId: 'task-fixture', backgroundedByUser: true } : {}) } });
                  } else append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: permissionId, content: 'Complete' }] } });
                  permissionAckIds.push(permissionId);
                }
                permissionId = null;
                if (queuedBashCase) emit('\x1b[2J\x1b[HD1 — Pick a mode\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\n');
                else if (scenario.endsWith('no-ack') || bashHookLag && scenario.endsWith('timeout')) emit('WORK_IN_PROGRESS\n');
                else finish();
                return;
              }
              if (longPermissionCase) {
                if (scenario === 'permission-repaint-no-ack') { permissionWrites.push('create'); permissionId = null; emit('WORK_IN_PROGRESS\n'); return; }
                append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: permissionId, content: 'Write complete' }] } });
                permissionWrites.push('create'); permissionId = null;
                ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
                emit('\x1b[2J\x1b[HD1 — Pick a mode\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\n');
                return;
              }
              if (filePermissionCase) {
                if (raceJustInjected || finalPermissionPending && pendingRedrawSleeps > 0) prematureAnswers.push(data);
                if (editPermissionCase) {
                  fileNativeBeforeGrant.push(fs.readFileSync(file, 'utf8').trim().split('\n').some(line => {
                    const content = JSON.parse(line).message?.content;
                    return Array.isArray(content) && content.some(block => block.type === 'tool_use' && block.id === permissionId);
                  }));
                  if (finalPermissionPending && scenario !== 'permission-edit-native') {
                    append({ type: 'assistant', cwd: options.cwd, message: { id: permissionId, role: 'assistant', stop_reason: 'tool_use',
                      content: [{ type: 'tool_use', id: permissionId, name: 'Edit', input: permissionInput }] } });
                  }
                  if (!(finalPermissionPending && scenario === 'permission-edit-no-final-ack')) {
                    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: permissionId, content: 'Edit complete' }] } });
                  }
                  const planFile = path.join(project, 'plan.md');
                  const before = fs.readFileSync(planFile, 'utf8');
                  if (!before.includes(permissionInput!.old_string as string)) throw new Error('Edit old_string must match the actual plan');
                  fs.writeFileSync(planFile, before.replace(permissionInput!.old_string as string, permissionInput!.new_string as string));
                  permissionWrites.push('edit');
                  permissionId = null;
                  if (finalPermissionPending) finish();
                  else {
                    const showMode = () => {
                      ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
                      emit('\x1b[2J\x1b[HD1 — Pick a mode\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\n');
                    };
                    if (scenario === 'permission-edit-stale-redraw') {
                      emit(fileDialog('make this edit to'));
                      delayedRender = showMode; pendingRedrawSleeps = 3;
                    } else showMode();
                  }
                  return;
                }
                permissionGrantIds.push(permissionId);
                if (scenario === 'permission-final-queued-question-no-ack') {
                  permissionWrites.push(permissionOperation);
                  permissionId = null;
                  emit('\x1b[2J\x1b[HWORK_IN_PROGRESS\n');
                  return;
                }
                if (finalPermissionPending && scenario !== 'permission-final-native'
                  || !finalPermissionPending && scenario === 'permission-final-first-arrival-race') {
                  append({ type: 'assistant', cwd: options.cwd, message: { id: permissionId, role: 'assistant', stop_reason: 'tool_use',
                    content: [{ type: 'tool_use', id: permissionId, name: 'Write', input: permissionInput }] } });
                }
                if (!(permissionId === initialPermissionId && scenario === 'permission-final-no-prior-ack')
                  && !(finalPermissionPending && scenario === 'permission-final-no-final-ack')) {
                  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: permissionId,
                    ...(permissionId === initialPermissionId && scenario === 'permission-final-error-prior-ack' ? { is_error: true } : {}), content: 'Write complete' }] } });
                  permissionAckIds.push(permissionId);
                }
                fs.writeFileSync(path.join(project, 'plan.md'), permissionInput!.content as string);
                permissionWrites.push(permissionOperation);
                permissionId = null;
                if (finalPermissionPending) {
                  finalWriteCount++;
                  if (['permission-final-repeat-overwrite', 'permission-final-repeat-identical'].includes(scenario) && finalWriteCount === 1) requestFinalWrite();
                  else finish();
                } else {
                  if (!queuedFileQuestionCase) ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
                  emit('\x1b[2J\x1b[HD1 — Pick a mode\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\n');
                }
                return;
              }
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
            if (nativeBashCase) {
              if (!permissionAckIds.length) prematureAnswers.push(data);
              bashQuestionAckIds.push(pendingId);
              acknowledge();
              finish();
              return;
            }
            answer++;
            if (multiQuestionCase && answer > 1) {
              batchQuestion++;
              emit(batchQuestion === 1 ? finding(2) : '\nReview your answers\nReady to submit your answers?\nSubmit answers\n');
              return;
            }
            if (['letter-prefixed-mode-no-ack', 'parenthesized-mode-no-ack'].includes(scenario) && answer === 1) { emit('\nWORK_IN_PROGRESS\n'); return; }
            if (['no-ack', 'hook-no-ack'].includes(scenario) && answer === 2) { emit('\nWORK_IN_PROGRESS\n'); return; }
            if (ceilingCase) {
              if (answer === 7 && scenario.endsWith('no-ack')) { emit('WORK_IN_PROGRESS\n'); return; }
              acknowledge();
              if (answer < 6) {
                const question = `Finding ${answer} — Independent test gap`;
                ask(question, ['Add test', 'Skip test']);
                emit(`\x1b[2J\x1b[H${question}\n❯1.Add test\n2.Skip test\n`);
              } else if (answer === 6) {
                if (scenario.endsWith('timeout')) { emit('WORK_IN_PROGRESS\n'); return; }
                ask('How should we continue after this review?', ['Run eng review now', 'Continue manually']);
                emit('\x1b[2J\x1b[HHow should we continue after this review?\n❯1.Run eng review now\n2.Continue manually\n');
              } else finish();
              return;
            }
            acknowledge();
            if (permissionRepaintCase) { finish(); return; }
            if (scenario === 'viewport-ready-no-restore-output') { tool('ExitPlanMode', {}); emit('\nReady to execute?\n'); return; }
            if (answer === 1) {
              if (multiQuestionCase) {
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
              } else if (scenario === 'redraw' || scenario === 'stale-redraw' || scenario === 'question-picker-redraw') {
                redraws++;
                emit(scenario === 'stale-redraw' ? finding(1).trimEnd() + ' Working frame 2\n' : finding(1));
                // One post-answer pause, then a poll sees the same question;
                // only the next poll receives a genuinely different prompt.
                pendingRedrawSleeps = 3;
                delayedRender = showSecondFinding;
              } else showSecondFinding();
            } else if (exitConfirmationCase) requestExitConfirmation();
            else if (filePermissionCase) requestFinalWrite();
            else finish();
          }
        } },
        kill() {
          if (bashHookLag) persistedBashUses = fs.readFileSync(file, 'utf8').split('\n').filter(line => line && JSON.parse(line).message?.content?.some?.((block: any) => block.type === 'tool_use' && block.name === 'Bash')).length;
          if (retentionCase || hookAckLag || bashHookLag) {
            retainedBeforeClose = fs.existsSync(path.join(evalDir, 'plan-counting', `${sessionId}.json`));
            fs.rmSync(file, { force: true });
          }
          closed = true; end(0);
        },
      };
    }) as typeof Bun.spawn;
    Bun.sleep = (async (ms: number) => {
      raceJustInjected = false;
      if (!closed && ++sleeps > 50) throw new Error('Fake counting session did not converge');
      if (timing) clock += ms;
      if (scenario === 'late-completion' && clock >= caseBudgetMs && !lateCompletionSent) finishLate();
      if (pendingRedrawSleeps > 0 && --pendingRedrawSleeps === 0) delayedRender();
    }) as typeof Bun.sleep;
    const helperTimeoutMs = scenario === 'invalid-nan' ? Number.NaN : scenario === 'invalid-infinity' ? Number.POSITIVE_INFINITY
      : caseBudgetMs - (Date.now() - caseStartedAt);
    const reviewCountCeiling = scenario.startsWith('ceiling-null') ? null
      : scenario === 'invalid-cap-nan' ? Number.NaN : scenario === 'invalid-cap-infinity' ? Number.POSITIVE_INFINITY
      : scenario === 'invalid-cap-negative' ? -1 : scenario === 'invalid-cap-fraction' ? 1.5
      : scenario === 'invalid-cap-unsafe' ? Number.MAX_SAFE_INTEGER + 1 : scenario === 'ceiling-zero' ? 0 : 4;
    let observation;
    let error;
    let sameError = false;
    try { observation = await runPlanSkillCounting({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
      cwd: project, isLastStep0AUQ: ceoStep0Boundary, reviewCountCeiling, timeoutMs: helperTimeoutMs,
      defaultPick: previewCase ? scenario === 'preview-menu-focused' ? 1 : 2 : ['permission-current-create-pick-two', 'permission-final-queued-question-pick-two'].includes(scenario) ? 2 : undefined,
      firstAUQPick: scenario === 'first-route' || scenario === 'question-picker-first' ? () => 2 : undefined,
      questionPick: retentionCase || ceilingCase || lateHookCompletion || scenario.includes('picker') ? (question, isFirst) => {
        if (scenario === 'retention-original-error') throw injectedError;
        if (!isFirst && publishLateQuestionCompletion) {
          lateCompletionPickedQuestion = question.question;
          publishLateQuestionCompletion(); publishLateQuestionCompletion = null;
        }
        pickerCalls.push({ question, isFirst });
        if (previewCase) return 2;
        if (question.question === 'How should we continue after this review?' || multiQuestionCase && question.question.includes('Failure')) return 2;
        return 1;
      } : undefined,
    }); } catch (cause) {
      if (!hookAckLag && !nativeBashCase && !longPermissionCase && !retentionCase && !viewportCase && !filePermissionCase && !scenario.startsWith('invalid-') && !['multi-select', 'permission-ambiguous', 'permission-owner-change', 'permission-current-create-mismatch', 'repeated-native'].includes(scenario)) throw cause;
      error = String(cause);
      sameError = cause === injectedError;
    }
    const writtenPlan = fs.existsSync(path.join(project, 'plan.md')) ? fs.readFileSync(path.join(project, 'plan.md'), 'utf8') : '';
    const diagnosticDirectory = path.join(evalDir, 'plan-counting');
    const diagnosticFiles = fs.existsSync(diagnosticDirectory) ? fs.readdirSync(diagnosticDirectory) : [];
    const diagnostic = diagnosticFiles.length ? JSON.parse(fs.readFileSync(path.join(diagnosticDirectory, diagnosticFiles[0]), 'utf8')) : null;
    console.log(JSON.stringify({ observation, error, persistedBashUses, hookCompletionIds, persistedQuestionResults, lateCompletionPickedQuestion, longPermissionFrame, lastFixtureFrame, diagnostic, diagnosticFiles, retainedBeforeClose, sameError, nativeRemoved: !fs.existsSync(nativeFile), pickerCalls, resizes, terminalCloseCount, sends, sendTimes, seededBeforeSlash, closed, launches, redraws, unsolicitedWrites, prematureAnswers, permissionWrites, permissionGrantIds, permissionAckIds, bashQuestionAckIds, fileNativeBeforeGrant, raceInjected, postExitOwnerRaceScreens,
      writtenPlanLines: writtenPlan ? writtenPlan.split('\n').length : 0, writtenPlanTail: writtenPlan.slice(-100),
      caseBudgetMs, setupMs, helperTimeoutMs, caseElapsedMs: Date.now() - caseStartedAt, lateCompletionSent }));
  } finally {
    Bun.spawn = originalSpawn;
    Bun.sleep = originalSleep;
    Date.now = originalNow;
    PtyCurrentScreen.prototype.snapshot = originalScreenSnapshot;
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
