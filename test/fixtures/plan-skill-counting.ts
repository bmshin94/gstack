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
  const editPermissionCase = scenario.startsWith('permission-edit-');
  const filePermissionCase = scenario.startsWith('permission-final-') || editPermissionCase;
  const previewCase = scenario.startsWith('preview-menu-');
  const viewportCase = scenario.startsWith('viewport-');
  const timing = scenario === 'parenthesized-mode-no-ack' || scenario === 'letter-prefixed-mode-no-ack' || viewportCase || previewCase || filePermissionCase || ['setup-exhausted', 'setup-budget', 'launch-budget', 'late-completion', 'timeout-after-question', 'preview-only', 'no-ack', 'hook-no-ack', 'screen-only-plan-ready'].includes(scenario);
  const caseBudgetMs = viewportCase || previewCase || filePermissionCase ? 60_000 : scenario === 'launch-budget' ? 9_000 : scenario === 'late-completion' ? 12_000 : timing ? 30_000 : 1_500_000;
  const setupMs = scenario === 'setup-exhausted' ? caseBudgetMs + 5_000 : scenario === 'setup-budget' ? 5_000 : 0;
  const reusedOptions = ['reused-options', 'redraw', 'stale-redraw', 'wrong-question', 'multi-question'].includes(scenario);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'counting-pty-fixture-')));
  const plan = '# Payment Processing\nReview the two independent test gaps.\n';
  const sends: string[] = [];
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
  const fileNativeBeforeGrant: boolean[] = [];
  let publishDuringScreen: (() => void) | null = null;
  let raceInjected = false;
  let raceJustInjected = false;
  const originalScreenSnapshot = PtyCurrentScreen.prototype.snapshot;
  if (scenario.endsWith('arrival-race') || scenario === 'permission-final-input-race' || scenario === 'viewport-flush-deadline') PtyCurrentScreen.prototype.snapshot = async function () {
    const frame = await originalScreenSnapshot.call(this);
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
    clock += setupMs;
    process.env.BROWSE_TERMINAL_BINARY = process.execPath;
    process.env.EVALS_HERMETIC = '1';
    Bun.spawn = ((_command: string[], options: any) => {
      launches++;
      if (scenario === 'launch-budget') clock += 2_000;
      const sessionId = _command[_command.indexOf('--session-id') + 1];
      const file = path.join(options.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture', `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const append = (row: Record<string, unknown>) => fs.appendFileSync(file, JSON.stringify({ sessionId, timestamp: new Date(originalNow()).toISOString(), ...row }) + '\n');
      append({ type: 'user', message: { role: 'user', content: 'Review the supplied plan.' } });
      // A real PTY's ONLCR output converts these fixture newlines to CRLF.
      let latestPaint = '';
      const emit = (value: string) => { latestPaint = value; options.terminal.data(null, Buffer.from(value.replace(/(?<!\r)\n/g, '\r\n'))); };
      const longQuestion = 'D1 — Pick a mode\n' + Array.from({ length: 45 }, (_, i) => `Context paragraph ${i}: Review the supplied design carefully.`).join('\n');
      const clipped = 'Clipped native prompt\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
      const complete = '☐ Review mode\n' + longQuestion.slice(0, 2000) + '…\n❯1.HOLD SCOPE\n2.SCOPE EXPANSION\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
      const finding = (number: number) => `\nFinding ${number} — ${number === 1 ? 'Success' : 'Failure'} test\n\n❯ 1. ${reusedOptions ? 'Add test' : number === 1 ? 'Add receipt assertion' : 'Add retry assertion'}\n  2. ${reusedOptions ? 'Skip test' : number === 1 ? 'Skip receipt test' : 'Skip retry test'}\n`;
      let sequence = 0;
      let pendingId: string | null = null;
      let permissionId: string | null = null;
      let permissionInput: Record<string, unknown> | null = null;
      let permissionOperation: 'create' | 'overwrite' = 'create';
      let initialPermissionId: string | null = null;
      let finalPermissionPending = false;
      let finalWriteCount = 0;
      const finalReport = [...Array.from({ length: 516 }, (_, i) => `Report line ${i + 1}`), '## GSTACK REVIEW REPORT', 'VERDICT: APPROVED'].join('\n');
      const fileDialog = (operation: string) => `\x1b[2J\x1b[HDo you want to ${operation} plan.md?\n❯1.Yes\n2.Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel`;
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
        permissionInput = { file_path: path.join(project, scenario === 'permission-final-mismatch' ? 'different.md' : 'plan.md'), content: finalReport + (finalWriteCount ? '\nAnother overwrite' : '') };
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
      return {
        exited: new Promise<number>(resolve => { end = resolve; }),
        terminal: {
          ...(viewportCase ? { resize(cols: number, rows: number) {
            resizes.push([cols, rows]);
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
              if (scenario !== 'preview-menu-stale-focus') { previewFocus = Number(data); showPreview(); }
              return;
            }
            const desired = scenario === 'preview-menu-focused' ? 1 : 2;
            if (data !== '\r' || previewFocus !== desired || !pendingId) { prematureAnswers.push(data); return; }
            if (scenario === 'preview-menu-no-ack' || scenario === 'preview-menu-clipping-ruler-no-ack') return;
            acknowledge(); answer++;
            if (answer === 3) finish(); else nextPreview();
            return;
          }
          if (data.startsWith('/')) {
            seededBeforeSlash = fs.readFileSync(path.join(options.cwd, 'review-input.md'), 'utf8') === plan;
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
            if (filePermissionCase) {
              if (editPermissionCase) {
                fs.writeFileSync(path.join(project, 'plan.md'), 'Draft');
                permissionInput = { file_path: path.join(project, 'plan.md'), old_string: 'Draft', new_string: resolvedParagraph, replace_all: false };
                permissionId = tool('Edit', permissionInput);
                recordFilePermission(permissionInput, 'Edit');
                emit(fileDialog('make this edit to'));
                return;
              }
              permissionInput = { file_path: path.join(project, 'plan.md'), content: plan };
              permissionId = scenario === 'permission-final-first-arrival-race' ? `tool-${++sequence}` : tool('Write', permissionInput);
              initialPermissionId = permissionId;
              emit(fileDialog('create'));
              if (scenario === 'permission-final-first-arrival-race') publishDuringScreen = () => {
                recordFilePermission(permissionInput!); raceInjected = true; raceJustInjected = true;
              };
              else if (scenario === 'permission-final-input-race') publishDuringScreen = () => {
                recordFilePermission({ ...permissionInput, content: 'Changed by an earlier tool hook' }); raceInjected = true; raceJustInjected = true;
              };
              else if (scenario !== 'permission-final-missing-request') recordFilePermission(permissionInput);
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
          } else if (data === '\r' && scenario === 'multi-question' && batchQuestion === 2) {
            acknowledge();
            finish();
          } else if (/^[12]\r?$/.test(data)) {
            if (permissionId) {
              if (data !== '1\r') throw new Error('Permission must select only the current request');
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
                if (finalPermissionPending && scenario !== 'permission-final-native'
                  || !finalPermissionPending && scenario === 'permission-final-first-arrival-race') {
                  append({ type: 'assistant', cwd: options.cwd, message: { id: permissionId, role: 'assistant', stop_reason: 'tool_use',
                    content: [{ type: 'tool_use', id: permissionId, name: 'Write', input: permissionInput }] } });
                }
                if (!(permissionId === initialPermissionId && scenario === 'permission-final-no-prior-ack')
                  && !(finalPermissionPending && scenario === 'permission-final-no-final-ack')) {
                  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: permissionId,
                    ...(permissionId === initialPermissionId && scenario === 'permission-final-error-prior-ack' ? { is_error: true } : {}), content: 'Write complete' }] } });
                }
                fs.writeFileSync(path.join(project, 'plan.md'), permissionInput!.content as string);
                permissionWrites.push(permissionOperation);
                permissionId = null;
                if (finalPermissionPending) {
                  finalWriteCount++;
                  if (scenario === 'permission-final-repeat-overwrite' && finalWriteCount === 1) requestFinalWrite();
                  else finish();
                } else {
                  ask('D1 — Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION']);
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
            answer++;
            if (scenario === 'multi-question' && answer > 1) {
              batchQuestion++;
              emit(batchQuestion === 1 ? finding(2) : '\nReview your answers\nReady to submit your answers?\nSubmit answers\n');
              return;
            }
            if (['letter-prefixed-mode-no-ack', 'parenthesized-mode-no-ack'].includes(scenario) && answer === 1) { emit('\nWORK_IN_PROGRESS\n'); return; }
            if (['no-ack', 'hook-no-ack'].includes(scenario) && answer === 2) { emit('\nWORK_IN_PROGRESS\n'); return; }
            acknowledge();
            if (scenario === 'viewport-ready-no-restore-output') { tool('ExitPlanMode', {}); emit('\nReady to execute?\n'); return; }
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
            } else if (filePermissionCase) requestFinalWrite();
            else finish();
          }
        } },
        kill() { closed = true; end(0); },
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
    let observation;
    let error;
    try { observation = await runPlanSkillCounting({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '',
      cwd: project, isLastStep0AUQ: ceoStep0Boundary, reviewCountCeiling: 4, timeoutMs: helperTimeoutMs,
      defaultPick: previewCase ? scenario === 'preview-menu-focused' ? 1 : 2 : scenario === 'permission-current-create-pick-two' ? 2 : undefined,
      firstAUQPick: scenario === 'first-route' ? () => 2 : undefined,
    }); } catch (cause) {
      if (!viewportCase && !filePermissionCase && !scenario.startsWith('invalid-') && !['multi-select', 'permission-ambiguous', 'permission-owner-change', 'permission-current-create-mismatch', 'repeated-native'].includes(scenario)) throw cause;
      error = String(cause);
    }
    const writtenPlan = fs.existsSync(path.join(project, 'plan.md')) ? fs.readFileSync(path.join(project, 'plan.md'), 'utf8') : '';
    console.log(JSON.stringify({ observation, error, resizes, terminalCloseCount, sends, sendTimes, seededBeforeSlash, closed, launches, redraws, unsolicitedWrites, prematureAnswers, permissionWrites, fileNativeBeforeGrant, raceInjected,
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
