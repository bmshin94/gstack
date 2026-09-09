/** Exercise native mode navigation with no real CLI or model process. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { navigateToModeAskUserQuestion, waitForNativeModePosture } from '../helpers/plan-skill-mode-navigation';
import { setupQuestionEventSource } from '../helpers/plan-skill-question-events';
import { spawnSync } from 'node:child_process';
import type { ClaudePtySession } from '../helpers/claude-pty-runner';

const scenario = process.argv[2];
if (scenario.startsWith('post-')) { await postModeFixture(scenario); process.exit(0); }
const diagnostics = scenario.startsWith('diagnostic-');
const diagnosticRoot = diagnostics ? fs.mkdtempSync(path.join(os.tmpdir(), 'mode-diagnostic-output-')) : null;
if (diagnosticRoot) {
  process.env.GSTACK_EVAL_DIR = diagnosticRoot;
  if (scenario === 'diagnostic-write-failure') {
    process.env.GSTACK_EVAL_DIR = path.join(diagnosticRoot, 'not-a-directory');
    fs.writeFileSync(process.env.GSTACK_EVAL_DIR, 'preserve me');
  }
}
const sessionId = '00000000-0000-4000-8000-000000000001';
const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-native-fixture-'));
const file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const append = (row: unknown) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row as object }) + '\n');
const tool = (id: string, question: string, labels: string[]) => append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, header: question, multiSelect: false, options: labels.map(label => ({ label, description: label })) }] } }] } });
const result = (id: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Answer accepted' }] } });
let buffer = '\nExample modes in a report preview\n❯1.HOLD SCOPE\n2.SELECTIVE EXPANSION\n3.SCOPE REDUCTION\n';
let activeScreen = buffer;
const paint = (text: string) => { activeScreen = text; buffer += text; };
tool('approach', 'Choose architecture', ['Extend dispatcher', 'Queue fanout']);
if (scenario === 'multi-tab') {
  fs.writeFileSync(file, '');
  append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{
    type: 'tool_use', id: 'approach', name: 'AskUserQuestion', input: { questions: [
      { question: 'Choose architecture', header: 'Architecture', multiSelect: false,
        options: ['Extend dispatcher', 'Queue fanout'].map(label => ({ label, description: label })) },
      { question: 'Choose review mode', header: 'Review mode', multiSelect: false,
        options: ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION', 'SCOPE EXPANSION'].map(label => ({ label, description: label })) },
    ] },
  }] } });
}
if (scenario === 'diagnostic-write') {
  fs.writeFileSync(file, '');
  append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write-plan', name: 'Write', input: { file_path: '/fixture/plan.md', content: 'Plan content' } }] } });
}
if (scenario === 'diagnostic-truncation') {
  for (let index = 0; index < 80; index++) append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `write-${index}-` + 'x'.repeat(400), name: 'Write', input: { file_path: '/fixture/plan.md', content: '界'.repeat(1000) } }] } });
}
const sendFailure = new Error('fixture transport failure ' + 'x'.repeat(3000));
let sleeps = 0;
let clock = 0;
let stage = 'preview';
let acknowledged = false;
const sends: string[] = [];
const premature: string[] = [];
const labels = scenario === 'missing' ? ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'] : ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION', 'SCOPE EXPANSION'];
const session = {
  exited: () => false, exitCode: () => null,
  get hermeticConfigDir() {
    if ((scenario === 'read-budget' && stage === 'mode') || (scenario === 'ack-budget' && stage === 'done')) clock = 30_000;
    return config;
  },
  visibleSince: (mark = 0) => buffer.slice(mark), rawOutput: () => buffer,
  ...(scenario === 'multi-tab' ? { currentScreen: async () => ({ text: activeScreen, rawEnd: buffer.length }) } : {}),
  mark: () => { if (scenario === 'write-budget' && stage === 'mode') clock = 30_000; return buffer.length; },
  send(data: string) {
    sends.push(data);
    if (scenario === 'multi-tab') {
      // Installed CLI single-select handles each digit immediately; the next
      // Enter acts on the next tab. Model the actual failed two-tab sequence.
      for (const key of data) {
        if (stage === 'approach' && key === '1') {
          stage = 'mode';
          paint('\nChoose review mode\n❯1.HOLD SCOPE\n2.SELECTIVE EXPANSION\n');
        } else if (stage === 'mode' && key === '\r') {
          stage = 'incomplete-submit';
          paint('\nReview your answers\nYou have not answered all questions\nSubmit answers\n');
        } else if (stage === 'mode' && key === '4') {
          stage = 'submit';
          paint('\nReview your answers\nReady to submit your answers?\nSubmit answers\n');
        } else if (stage === 'submit' && key === '\r') {
          result('approach'); acknowledged = true; stage = 'done';
          paint('\nSCOPE EXPANSION posture\n');
        } else premature.push(key);
      }
      return;
    }
    if (stage === 'approach' && data === '1') {
      if (scenario === 'diagnostic-send-failure') throw sendFailure;
      if (diagnostics) {
        stage = 'unacknowledged-approach';
        buffer += '\n❯ 1\n';
        return;
      }
      result('approach');
      tool('mode', 'Choose review mode', labels);
      stage = 'mode';
      // Native input is authoritative even when the current viewport only
      // renders two choices. The target remains native option four.
      buffer += '\nChoose review mode\n❯1.HOLD SCOPE\n2.SELECTIVE EXPANSION\n';
    } else if (stage === 'mode' && data === '4') {
      if (scenario !== 'unacknowledged') { result('mode'); acknowledged = true; }
      stage = 'done';
      buffer += '\nSCOPE EXPANSION posture\n';
    } else premature.push(data);
  },
  sendKey(key: string) { this.send(key === 'Enter' ? '\r' : ''); },
} as unknown as ClaudePtySession;
const oldSleep = Bun.sleep;
const oldNow = Date.now;
Bun.sleep = (async (ms: number) => {
  clock += ms;
  if (++sleeps === 2 && !['diagnostic-unmatched', 'diagnostic-write', 'diagnostic-truncation', 'diagnostic-write-failure'].includes(scenario)) { stage = 'approach'; paint('\nChoose architecture\n❯1.Extend dispatcher\n2.Queue fanout\n'); }
  if (scenario === 'diagnostic-truncation') buffer += '界'.repeat(70_000);
}) as typeof Bun.sleep;
Date.now = () => clock;
try {
  let navigation;
  let error;
  let originalSendErrorPreserved = false;
  try { navigation = await navigateToModeAskUserQuestion(session, 0, 'SCOPE EXPANSION', { sessionId, budgetMs: scenario === 'invalid-budget' ? Number.NaN : 30_000 }); }
  catch (cause) { error = String(cause); originalSendErrorPreserved = cause === sendFailure; }
  // Native cleanup happens before reading the persisted failure artifact.
  // Retention under GSTACK_EVAL_DIR must survive this exact lifecycle.
  if (diagnostics) fs.rmSync(config, { recursive: true, force: true });
  const diagnosticFile = diagnosticRoot && path.join(diagnosticRoot, 'mode-navigation', `${sessionId}.json`);
  const diagnostic = diagnosticFile && fs.existsSync(diagnosticFile) ? JSON.parse(fs.readFileSync(diagnosticFile, 'utf8')) : null;
  console.log(JSON.stringify({ navigation, error, sends, premature, acknowledged, diagnostic, originalSendErrorPreserved,
    configRemovedBeforeArtifactRead: diagnostics && !fs.existsSync(config),
    diagnosticBytes: diagnosticFile && fs.existsSync(diagnosticFile) ? fs.statSync(diagnosticFile).size : null,
    diagnosticMode: diagnosticFile && fs.existsSync(diagnosticFile) ? fs.statSync(diagnosticFile).mode & 0o777 : null,
    blockedOutputPreserved: scenario === 'diagnostic-write-failure' && fs.readFileSync(process.env.GSTACK_EVAL_DIR!, 'utf8') === 'preserve me' }));
} finally {
  Bun.sleep = oldSleep;
  Date.now = oldNow;
  fs.rmSync(config, { recursive: true, force: true });
  if (diagnosticRoot) fs.rmSync(diagnosticRoot, { recursive: true, force: true });
}

/** The retained HOLD sequence: mode ACK, then Impl Approach blocks posture.
 * Native rows are the authority; the current frame only corroborates them.
 */
async function postModeFixture(scenario: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'post-mode-fixture-')));
  const config = path.join(root, '.claude');
  const cwd = path.join(root, 'project');
  const evalDir = path.join(root, 'eval');
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(cwd);
  process.env.GSTACK_EVAL_DIR = evalDir;
  let clock = 0;
  const append = (row: object) => fs.appendFileSync(file, JSON.stringify({ sessionId, timestamp: new Date(clock).toISOString(), ...row }) + '\n');
  const tool = (id: string, input: object, extra = {}) => append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] }, ...extra });
  const ack = (id: string, is_error = false) => append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'Answer accepted' }] } });
  const question = (header: string, text: string, labels: string[]) => ({ header, question: text, multiSelect: false,
    options: labels.map(label => ({ label, description: label })) });
  const mode = question('Review Mode', 'D1 — Which review mode for this plan?', ['SCOPE EXPANSION', 'SELECTIVE EXPANSION (Recommended)', 'HOLD SCOPE', 'SCOPE REDUCTION']);
  const approach = question('Impl Approach', 'D2 — Which implementation approach should this plan use?',
    ['A — Client-side CSV', 'B — Server formatter module (Recommended)', 'C — Dedicated export endpoint']);
  if (scenario === 'post-no-recommendation') approach.options[1]!.label = 'B — Server formatter module';
  if (scenario === 'post-ambiguous-recommendation') approach.options[0]!.label += ' (Recommended)';
  if (scenario === 'post-multiselect') approach.multiSelect = true;
  const input = { questions: scenario === 'post-repeat-mode' ? [{ ...mode, header: 'Confirm Mode', question: 'D3 — Confirm the review mode for the chosen approach?' }] : scenario === 'post-identical-mode' ? [mode] : scenario === 'post-multi-tab'
    ? [approach, question('Filename', 'Choose CSV filename', ['settings.csv', 'export.csv'])] : [approach] };
  tool('mode', { questions: [mode] });
  if (scenario !== 'post-no-mode-ack') ack('mode');
  let events;
  let earlyWithoutNativeInvocation = false;
  if (scenario === 'post-early-event') {
    const capture = setupQuestionEventSource({ configDir: config, cwd, sessionId, rootDir: root });
    events = capture.source;
    const command = JSON.parse(fs.readFileSync(capture.settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    const child = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId,
      transcript_path: file, cwd, tool_name: 'AskUserQuestion', tool_use_id: 'follow-up', tool_input: input }), encoding: 'utf8', timeout: 5000 });
    if (child.error || child.status || child.stdout || child.stderr) throw new Error('Silent local observer fixture failed');
    earlyWithoutNativeInvocation = !fs.readFileSync(file, 'utf8').includes('follow-up');
  } else if (scenario.startsWith('post-permission')) {
    append({ type: 'assistant', cwd, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: path.join(cwd, 'plan.md'), content: 'Plan' } }] } });
  } else {
    tool('follow-up', input, scenario === 'post-unowned' ? { sessionId: '00000000-0000-4000-8000-000000000002' } : {});
    if (scenario === 'post-concurrent') tool('other-follow-up', input);
  }
  let buffer = '\nHOLD SCOPE selected\n';
  const sincePick = 0;
  let screen = '';
  const paint = (text: string) => { screen = text; buffer += text; };
  let tab = 0;
  let stage = scenario.startsWith('post-permission') ? 'permission' : 'question';
  const show = () => {
    const q = input.questions[tab]!;
    paint(`\n☐ ${q.header}\n${q.question}\n` + q.options.map((o, i) => `${i === 0 ? '❯' : ' '}${i + 1}. ${o.label}`).join('\n') + '\n');
  };
  if (stage === 'permission') paint(`Do you want to create ${scenario === 'post-permission-unowned' ? 'other.md' : 'plan.md'}?\n❯1.Yes\n2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel · Tab to amend`);
  else show();
  if (scenario === 'post-unmatched') paint('\nOther question\n❯1.Unrelated left option\n2.Unrelated right option\n');
  const sends: string[] = [];
  const premature: string[] = [];
  let acknowledged = false;
  let followNumber = 1;
  let followId = 'follow-up';
  let closed = false;
  let diagnosticBeforeClose = false;
  const sendFailure = new Error('post-mode send failed');
  const diagnosticPath = path.join(evalDir, 'mode-navigation', `${sessionId}.json`);
  const session = {
    get hermeticConfigDir() { if (scenario === 'post-read-deadline') clock = 30_000; return config; },
    nativeQuestionEvents: events,
    exited: () => scenario === 'post-exited' || (scenario === 'post-exit-during-pause' && clock > 0), exitCode: () => 9,
    visibleSince: (mark = 0) => buffer.slice(mark), rawOutput: () => buffer,
    currentScreen: async () => ({ text: screen, rawEnd: scenario === 'post-stale' ? 0 : buffer.length }),
    mark: () => { if (scenario === 'post-mark-deadline') clock = 30_000; return buffer.length; },
    send(data: string) {
      sends.push(data);
      if (scenario === 'post-send-failure') throw sendFailure;
      if (stage === 'permission' && data === '1\r') {
        ack('write'); tool('follow-up', input); stage = 'question'; show(); return;
      }
      const expected = scenario === 'post-repeat-mode' ? '3' : tab > 0 || ['post-no-recommendation', 'post-ambiguous-recommendation'].includes(scenario) ? '1' : '2';
      if (stage === 'question' && data === expected) {
        tab++;
        if (scenario === 'post-stale-after-pick') return;
        if (tab < input.questions.length) show();
        else { stage = 'submit'; paint('\nReview your answers\nReady to submit your answers?\nSubmit answers\n'); }
      } else if (stage === 'submit' && data === '\r') {
        if (events) tool('follow-up', input);
        if (scenario !== 'post-no-ack') { ack(followId, scenario === 'post-error-ack'); acknowledged = scenario !== 'post-error-ack'; }
        if (scenario === 'post-many-questions' && followNumber < 13) {
          followId = `follow-up-${++followNumber}`;
          input.questions[0] = { ...approach, header: `Approach ${followNumber}`, question: `D${followNumber + 1} — Confirm implementation approach ${followNumber}?` };
          tool(followId, input); tab = 0; stage = 'question'; show(); return;
        }
        stage = 'done';
        const text = scenario === 'post-wrong-posture' ? 'Dream big with scope expansion.' : 'I will make this plan bulletproof.';
        if (scenario !== 'post-missing-posture') append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        paint(scenario === 'post-not-rendered' ? '\nReview continues\n' : '\n' + text + '\n');
      } else premature.push(data);
    },
    close: async () => { closed = true; diagnosticBeforeClose = fs.existsSync(diagnosticPath); fs.rmSync(config, { recursive: true, force: true }); },
  } as unknown as ClaudePtySession;
  const oldSleep = Bun.sleep, oldNow = Date.now;
  Bun.sleep = (async (ms: number) => { clock += ms; }) as typeof Bun.sleep;
  Date.now = () => clock;
  let error, originalSendErrorPreserved = false;
  try {
    try { await waitForNativeModePosture(session, { modeIndex: 3, sincePick, toolUseId: 'mode' }, 'HOLD SCOPE',
      { sessionId, postureRe: /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i, budgetMs: scenario === 'post-many-questions' ? 240_000 : 30_000 }); }
    catch (cause) { error = String(cause); originalSendErrorPreserved = cause === sendFailure; }
    finally { await session.close(); }
    const diagnostic = fs.existsSync(diagnosticPath) ? JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')) : null;
    console.log(JSON.stringify({ error, sends, premature, acknowledged, earlyWithoutNativeInvocation, originalSendErrorPreserved,
      closed, diagnosticBeforeClose, configRemovedBeforeArtifactRead: !fs.existsSync(config), diagnostic,
      diagnosticMode: diagnostic && (fs.statSync(diagnosticPath).mode & 0o777), elapsed: clock }));
  } finally { Bun.sleep = oldSleep; Date.now = oldNow; fs.rmSync(root, { recursive: true, force: true }); }
}
