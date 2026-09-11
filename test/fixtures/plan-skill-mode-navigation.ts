/** Exercise native mode navigation with no real CLI or model process. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { navigateToModeAskUserQuestion, waitForNativeModePosture } from '../helpers/plan-skill-mode-navigation';
import { setupQuestionEventSource } from '../helpers/plan-skill-question-events';
import { spawnSync } from 'node:child_process';
import { PtyCurrentScreen } from '../helpers/pty-current-screen';
import type { ClaudePtySession } from '../helpers/claude-pty-runner';

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

// Retained clipped modal: no invented header or substring-match authority.
const viewportReplay = {
  "question": {
    "header": "Approach",
    "multiSelect": false,
    "options": [
      {
        "description": "Add a dedicated /settings/export endpoint that streams CSV. Backend owns all formatting and escaping. Complete export from the source of truth, independently testable, and usable as an API.",
        "label": "B — Backend endpoint (recommended)"
      },
      {
        "description": "Generate CSV in the browser from already-loaded settings state. No backend changes. Ships fast. Risk: only exports what’s visible in the UI.",
        "label": "A — Frontend-only generation"
      },
      {
        "description": "Build a multi-format export layer first; CSV export is the first consumer. Maximum future reuse. Risk: premature abstraction when we have exactly one consumer today.",
        "label": "C — Generic export framework"
      }
    ],
    "question": "D2 — Which implementation approach for the CSV export?\n\nProject/branch: CSV export of settings page, branch main.\n\nELI10: There are three distinct ways to build this. Approach A does all the work in the browser (simple, no backend changes). Approach B adds a dedicated backend export endpoint (complete, testable, API-first). Approach C builds a generic export framework first (future-proof but over-engineered for today). The choice locks in the data flow and testability story.\n\nStakes if we pick wrong: Approach A risks exporting only the visible UI subset (missing hidden/advanced settings). Approach C delays shipping by 3-5x for benefits that may never be used.\n\nRecommendation: B (dedicated backend endpoint) because it produces a complete export (not limited to UI state), is independently testable, and creates a real API surface that the 12-month portability vision can build on. Two lines of extra work over Approach A, zero premature abstraction vs Approach C.\n\nCompleteness: A=7/10, B=10/10, C=10/10\n\nPros / cons:\nA) Frontend-only CSV generation (Completeness: 7/10)\n  ✅ Zero backend changes — ships in a single frontend PR, fast\n  ✅ No new endpoint to maintain, auth, or rate-limit\n  ❌ Only exports what the current UI view has loaded — may miss hidden/advanced settings\n  ❌ Escaping tests live in JS, not co-located with the data source; divergence risk\n\nB) Dedicated backend export endpoint + streaming download (Completeness: 10/10) (recommended)\n  ✅ Complete export from source of truth, not UI-rendered snapshot\n  ✅ Backend owns escaping — single test surface, no JS/server divergence\n  ✅ Creates a reusable API endpoint the 12-month portability roadmap builds on\n  ❌ One new endpoint to build, document, and maintain (human: ~half day / CC: ~5 min)\n\nC) Generic multi-format export framework — CSV is first consumer (Completeness: 10/10)\n  ✅ Future JSON/YAML/TOML formats plug in with near-zero code\n  ✅ Clean architecture — settings, audit logs, etc. all share one export layer\n  ❌ Premature abstraction — we have one consumer today; YAGNI until we have two\n  ❌ 3-5x the implementation effort for speculative future benefit (human: ~2 days / CC: ~30 min)\n\nNet: Trading simplicity (A) vs. completeness (B) vs. future reuse (C). B hits the sweet spot — complete without gold-plating."
  },
  "frame": "│ Approach C delays shipping by 3-5x for benefits that may never be used.\n│    \n│ Recommendation: B (dedicated backend endpoint) because it produces a complete export (not limited to UI state), is\n│ independently testable, and creates a real API surface that the 12-month portability vision can build on. Two lines of\n│ extra work over Approach A, zero premature abstraction vs Approach C.\n│    \n│ Completeness: A=7/10, B=10/10, C=10/10\n│\n│ Pros / cons:\n│ A) Frontend-only CSV generation (Completeness: 7/10)\n│   ✅— Zero backend changes — ships in a single frontend PR, fast\n│   ✅ No onew endpoint to maintain, auth, or rate-limit \n│   ❌ Onlyt exports what the current UI view has loaded — may miss hidden/advanced settings\n│   ❌  Escaping tests live in JS, not co-located with the data source; divergence risk\n│\n│ B) Dedicated backend export endpoint + streaming download (Completeness: 10/10) (recommended)\n│   ✅ Complete export from sourcet of truth, not UI-rendered snapshot\n│   ✅  Backend owns escaping — single test surface, no JS/server divergence\n│   ✅— Creates a reusable API endpoint the 12-month portability roadmap builds on\n│   ❌ One new endpoint  to build, document, and maintain (human: ~half day / CC: ~5 min)\n│\n│ C) Generic multi-format export framework — CSV is first consumer (Completeness: 10/10)\n│   ✅ Future JSON/YAML/TOML  formats plug in with near-zero code\n│   ✅ Clean archite cture — settings, audit logs, etc. all share one export layer\n│   …                      \n                                      \n❯ 1. B — Backend endpoint (recommended)                  \n     Add a dedicated /settings/export endpoint that streams CSV. Backend owns all formatting and escaping. Complete\n     export from the source of truth, independently testable, and usable as an API.\n  2. A — Frontend-only generation \n     Generate CSV in the browser from already-loaded settings state. No backend changes. Ships fast. Risk: only exports\n     what’s visible in the UI.\n  3. C — Generic export framework                        \n     Build a multi-format export layer first; CSV export is the first consumer. Maximum future reuse. Risk: premature\n     abstraction when we have exactly one consumer today.\n  4. Type something.                                                            \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel"
};

const scenario = process.argv[2];
if (scenario.startsWith('review-start-')) { await reviewStartFixture(scenario); process.exit(0); }
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
const letterPrefixed = scenario.startsWith('letter-prefixed');
const parenthesized = scenario.startsWith('parenthesized');
const targetMode = scenario === 'parenthesized-hold' ? 'HOLD SCOPE' : 'SCOPE EXPANSION';
const labels = parenthesized ? RETAINED_PARENTHESIZED_MODE_INPUT.questions[0].options.map(option => option.label) : letterPrefixed ? ['C — HOLD SCOPE (Recommended)', 'B — SELECTIVE EXPANSION', 'A — SCOPE EXPANSION', 'D — SCOPE REDUCTION'] : scenario === 'missing' ? ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'] : ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION', 'SCOPE EXPANSION'];
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
      if (parenthesized) append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{
        type: 'tool_use', id: 'mode', name: 'AskUserQuestion', input: RETAINED_PARENTHESIZED_MODE_INPUT,
      }] } });
      else tool('mode', 'Choose review mode', labels);
      stage = 'mode';
      // Native input is authoritative even when the current viewport only
      // renders two choices. The target remains the actual native index.
      const question = RETAINED_PARENTHESIZED_MODE_INPUT.questions[0];
      buffer += parenthesized
        ? `\n☐ ${question.header}\n${question.question.split('\n')[0]}\n` + labels.map((label, i) => `${i === 0 ? '❯' : ''}${i + 1}.${label}`).join('\n') + '\n'
        : `\nChoose review mode\n❯1.${labels[0]}\n2.${labels[1]}\n`;
    } else if (stage === 'mode' && parenthesized && /^[1-4]$/.test(data)) {
      // Any offered digit gets a real native ACK, including the old driver's
      // default 1. Only recognized target selection can finish navigation.
      if (scenario !== 'parenthesized-unacknowledged') { result('mode'); acknowledged = true; }
      stage = 'done';
      buffer += `\n${labels[Number(data) - 1]} posture\n`;
    } else if (stage === 'mode' && data === (letterPrefixed ? '3' : '4')) {
      if (scenario !== 'unacknowledged' && scenario !== 'letter-prefixed-unacknowledged') { result('mode'); acknowledged = true; }
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
  try { navigation = await navigateToModeAskUserQuestion(session, 0, targetMode, { sessionId, budgetMs: scenario === 'invalid-budget' ? Number.NaN : 30_000 }); }
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
async function reviewStartFixture(scenario: string) {
  const seed = await import('../helpers/ceo-finding-fixture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-review-start-'));
  const sid = '00000000-0000-4000-8000-000000000001';
  const file = path.join(root, 'projects', 'fixture', sid + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const append = (row: object) => fs.appendFileSync(file, JSON.stringify({ sessionId: sid, ...row }) + '\n');
  const base = { question: 'D1 — Run /office-hours before this review?', header: 'Prerequisite', multiSelect: false,
    options: ['A) Run /office-hours first', 'B) Skip — standard review (recommended)'].map(label => ({ label, description: label,
      ...(scenario.includes('preview') ? { preview: 'Preview' } : {}) })) };
  if (scenario.includes('plain')) Object.assign(base, { question: 'D1 — No design doc found: run /office-hours before the review?',
    options: ['Run /office-hours now', 'Skip — proceed with review (Recommended)'].map(label => ({ label, description: label })) });
  const later = { ...base, question: 'D2 — Run /office-hours before this review?', header: 'Later prerequisite' };
  const mode = { question: 'Choose review mode', header: 'Mode', multiSelect: false,
    options: ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'].map(label => ({ label, description: label })) };
  const tool = (id: string, questions: typeof base[]) => append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
  const ack = (id: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Answer accepted' }] } });
  let current = scenario.endsWith('mode-first') ? mode : base;
  let id = scenario.endsWith('mode-first') ? 'mode' : 'first';
  let tab = 0, focus = 1, clock = 0, buffer = '', screen = '', calls = 0;
  const sends: string[] = [];
  const preview = scenario.includes('preview');
  const show = () => {
    screen = `☐ ${current.header}\n${current.question}\n`;
    if (preview && id !== 'mode') {
      const left = (value: string) => value.padEnd(62);
      screen += current.options.map((o, i) => left(`${focus === i + 1 ? '❯' : ' '} ${i + 1}. ${o.label}`)
        + (i === 0 ? '┌──────────────────┐' : i === 1 ? '│ Preview          │' : '')).join('\n');
      screen += '\n' + left('') + '└──────────────────┘';
      screen += '\n\n' + left('') + 'Notes: press n to add notes';
    } else screen += current.options.map((o, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${o.label}`).join('\n');
    screen += preview && id !== 'mode' ? '\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel\n'
      : '\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'; buffer += screen;
  };
  if (scenario.endsWith('previous-owner')) { tool('older', [{ ...base, question: 'Earlier setup', header: 'Setup' }]); ack('older'); }
  if (scenario.endsWith('unowned')) {
    append({ sessionId: '00000000-0000-4000-8000-000000000002', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [current] } }] } });
  } else tool(id, scenario.endsWith('tabs') ? [base, later] : [current]);
  show();
  const session = {
    hermeticConfigDir: root, exited: () => false, exitCode: () => null,
    visibleSince: (mark = 0) => buffer.slice(mark), rawOutput: () => buffer, mark: () => buffer.length,
    currentScreen: async () => ({ text: screen, rawEnd: scenario.endsWith('stale') ? 0 : buffer.length }),
    send: (value: string) => {
      sends.push(value);
      if (preview && id !== 'mode' && value !== '\r') { focus = Number(value); show(); return; }
      const pick = preview && id !== 'mode' ? focus : Number(value);
      if (id === 'mode') { if (!scenario.endsWith('no-mode-ack')) ack(id); buffer += '\nMode selected\n'; screen = 'Mode selected'; return; }
      if (id === 'first' && tab === 0 && pick !== 2) { screen = 'Office Hours interview is still running'; buffer += screen; return; }
      if (scenario.endsWith('no-first-ack')) { screen = 'Waiting for native acknowledgement'; buffer += screen; return; }
      if (scenario.endsWith('tabs') && tab++ === 0) { current = later; focus = 1; show(); return; }
      ack(id);
      if (scenario.endsWith('later') && id === 'first') { current = later; id = 'later'; }
      else { current = mode; id = 'mode'; }
      tool(id, [current]); focus = 1; show();
    },
  } as unknown as ClaudePtySession;
  const oldNow = Date.now, oldSleep = Bun.sleep;
  Date.now = () => clock; Bun.sleep = (async (ms: number) => { clock += ms; }) as typeof Bun.sleep;
  let navigation, error;
  try {
    try {
      navigation = await navigateToModeAskUserQuestion(session, 0, 'HOLD SCOPE', { sessionId: sid, budgetMs: 30_000,
        ...(!scenario.endsWith('no-policy') ? { firstAUQPick: (question: any) => {
          calls++;
          return scenario.endsWith('invalid-pick') ? 9 : seed.pickSuppliedCeoModeStart(question);
        } } : {}),
      });
    } catch (cause) { error = String(cause); }
    console.log(JSON.stringify({ navigation, error, sends, calls }));
  } finally { Date.now = oldNow; Bun.sleep = oldSleep; fs.rmSync(root, { recursive: true, force: true }); }
}

async function postModeFixture(scenario: string) {
  const questionPosture = scenario.startsWith('post-question-posture');
  const fileRequestCase = scenario.startsWith('post-permission-request');
  const longPermissionCase = scenario.startsWith('post-permission-request-long');
  const previewCase = scenario.startsWith('post-preview-');
  const shortPreview = scenario.startsWith('post-preview-short');
  const viewportCase = scenario.startsWith('post-viewport-');
  const navigation = scenario === 'post-permission-request-long-navigation' || scenario === 'post-permission-request-navigation' || scenario === 'post-preview-navigation' || shortPreview;
  const wallNow = Date.now;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'post-mode-fixture-')));
  const config = path.join(root, '.claude');
  const cwd = path.join(root, 'project');
  const permissionPath = longPermissionCase ? path.join(root, 'gstack-home/projects/gstack-e2e-plan-ceo-paired-fixture/ceo-plans/2026-09-09-payment-test-coverage.md') : path.join(cwd, 'plan.md');
  const evalDir = path.join(root, 'eval');
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(cwd);
  process.env.GSTACK_EVAL_DIR = evalDir;
  let clock = 0;
  const append = (row: object) => fs.appendFileSync(file, JSON.stringify({ sessionId, timestamp: new Date(fileRequestCase ? wallNow() : clock).toISOString(), ...row }) + '\n');
  const tool = (id: string, input: object, extra = {}) => append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] }, ...extra });
  const ack = (id: string, is_error = false) => append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'Answer accepted' }] } });
  const question = (header: string, text: string, labels: string[]) => ({ header, question: text, multiSelect: false,
    options: labels.map(label => ({ label, description: label })) });
  const mode = question('Review Mode', 'D1 — Which review mode for this plan?', ['SCOPE EXPANSION', 'SELECTIVE EXPANSION (Recommended)', 'HOLD SCOPE', 'SCOPE REDUCTION']);
  const approach = question('Impl Approach', 'D2 — Which implementation approach should this plan use?',
    ['A — Client-side CSV', 'B — Server formatter module (Recommended)', 'C — Dedicated export endpoint']);
  if (questionPosture) approach.question = scenario.endsWith('-wrong-mode')
    ? 'D2 — Shall we dream bigger with a settings comparison view?'
    : 'D2 — Which failure contract makes the current export bulletproof?';
  if (viewportCase) Object.assign(approach, viewportReplay.question);
  if (scenario === 'post-no-recommendation') approach.options[1]!.label = 'B — Server formatter module';
  if (scenario === 'post-ambiguous-recommendation') approach.options[0]!.label += ' (Recommended)';
  if (['post-multiselect', 'post-preview-multiselect'].includes(scenario)) approach.multiSelect = true;
  if (previewCase) {
    Object.assign(approach.options[0]!, { preview: 'Client-side CSV details' });
    Object.assign(mode.options[shortPreview ? 1 : 0]!, { preview: 'Expansion details' });
  }
  const input = { questions: shortPreview ? [mode] : scenario === 'post-preview-navigation' ? [approach, mode] : scenario === 'post-preview-mixed'
    ? [approach, question('Filename', 'Choose CSV filename', ['settings.csv', 'export.csv'])] : scenario === 'post-repeat-mode' ? [{ ...mode, header: 'Confirm Mode', question: 'D3 — Confirm the review mode for the chosen approach?' }] : scenario === 'post-identical-mode' ? [mode] : scenario === 'post-multi-tab'
    ? [approach, question('Filename', 'Choose CSV filename', ['settings.csv', 'export.csv'])] : [approach] };
  if (fileRequestCase) append({ type: 'user', message: { role: 'user', content: 'Review the supplied plan.' } });
  const textDiagnostic = scenario.startsWith('post-diagnostic-text');
  if (textDiagnostic) append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'BEFORE_MODE_TEXT' }] } });
  if (!navigation) {
    tool('mode', { questions: [mode] });
    if (scenario !== 'post-no-mode-ack') ack('mode');
  }
  if (textDiagnostic) {
    append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'EXCLUDED_THINKING' },
      { type: 'redacted_thinking', data: 'EXCLUDED_REDACTED_THINKING' },
      { type: 'tool_use', id: 'other-tool', name: 'Bash', input: { command: 'EXCLUDED_TOOL_INPUT' } },
      { type: 'text', text: 'Normal assistant message after mode reply.' },
    ] } });
    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other-tool', content: 'EXCLUDED_OTHER_RESULT' }] } });
    for (const extra of [{ sessionId: '00000000-0000-4000-8000-000000000002' }, { isSidechain: true }, { parent_tool_use_id: 'child' }]) {
      append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'EXCLUDED_FOREIGN_TEXT' }] }, ...extra });
    }
    if (scenario.endsWith('-limits')) for (let i = 0; i < 40; i++) append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: String(i).padStart(2, '0') + '界'.repeat(20_000) }] } });
  }
  let events;
  let earlyWithoutNativeInvocation = false;
  let publishDuringScreen: (() => void) | null = null;
  let raceInjected = false;
  if (fileRequestCase) {
    const capture = setupQuestionEventSource({ configDir: config, cwd, sessionId, rootDir: root });
    events = capture.source;
    const command = JSON.parse(fs.readFileSync(capture.settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
    const publish = () => {
      const child = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sessionId,
        transcript_path: file, cwd, tool_name: 'Write', tool_input: { file_path: permissionPath, content: 'Plan' } }), encoding: 'utf8', timeout: 5000 });
      if (child.error || child.status || child.stdout || child.stderr) throw new Error('Silent local permission observer fixture failed');
      earlyWithoutNativeInvocation = !fs.readFileSync(file, 'utf8').includes('"name":"Write"');
    };
    if (scenario === 'post-permission-request-arrival-race') {
      append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will make this plan bulletproof.' }] } });
      publishDuringScreen = () => { publish(); raceInjected = true; };
    } else publish();
  } else if (scenario === 'post-early-event') {
    const capture = setupQuestionEventSource({ configDir: config, cwd, sessionId, rootDir: root });
    events = capture.source;
    const command = JSON.parse(fs.readFileSync(capture.settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    const child = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId,
      transcript_path: file, cwd, tool_name: 'AskUserQuestion', tool_use_id: 'follow-up', tool_input: input }), encoding: 'utf8', timeout: 5000 });
    if (child.error || child.status || child.stdout || child.stderr) throw new Error('Silent local observer fixture failed');
    earlyWithoutNativeInvocation = !fs.readFileSync(file, 'utf8').includes('follow-up');
  } else if (scenario.startsWith('post-permission')) {
    append({ type: 'assistant', cwd, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: permissionPath, content: 'Plan' } }] } });
  } else {
    tool('follow-up', input, ['post-unowned', 'post-preview-unowned', 'post-preview-short-unowned'].includes(scenario) ? { sessionId: '00000000-0000-4000-8000-000000000002' } : {});
    if (scenario === 'post-concurrent') tool('other-follow-up', input);
  }
  let buffer = '\nHOLD SCOPE selected\n';
  const sincePick = 0;
  let screen = '';
  const decoder = longPermissionCase ? new PtyCurrentScreen({ cols: 240, rows: 40 }) : null;
  let longPermissionFrame = '';
  const paint = (text: string) => { screen = text; buffer += text; decoder?.feed(Buffer.from('\x1b[2J\x1b[H' + text.replace(/(?<!\r)\n/g, '\r\n'))); };
  let tab = 0;
  let stage = scenario.startsWith('post-permission') ? 'permission' : 'question';
  let focused = scenario === 'post-preview-already-focused' ? 2 : 1;
  let focusWrites = 0;
  let sameFocusWrites = 0;
  let previewFrameReads = 0;
  const show = () => {
    const q = input.questions[tab]!;
    if (shortPreview) {
      const left = q.options.flatMap((option, index) => {
        const [label, recommendation] = option.label.split(' (');
        return [`${index + 1 === focused ? '❯' : ' '} ${index + 1}. ${label}`,
          ...(recommendation ? [`    (${recommendation}`] : [])];
      });
      const right = ['┌' + '─'.repeat(54) + '┐', '│ ' + 'No preview available'.padEnd(53) + '│',
        '└' + '─'.repeat(54) + '┘', '', 'Notes: press n to add notes'];
      paint(`\n☐ ${q.header}\n${q.question}\n` + left.map((row, index) => row.padEnd(34) + right[index]).join('\n')
        + '\n\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel\n');
      return;
    }
    if (previewCase && q.options.some(o => 'preview' in o)) {
      const rows = q.options.map((o, i) => `${i + 1 === focused ? '❯' : ' '} ${i + 1}. ${o.label}`.padEnd(59));
      while (rows.length < 3) rows.push(' '.repeat(59));
      const box = ['┌' + '─'.repeat(35) + '┐', '│' + 'No preview available'.padEnd(35) + '│'];
      while (box.length < rows.length) box.push('│' + ' '.repeat(35) + '│');
      rows.push(' '.repeat(59)); box.push('└' + '─'.repeat(35) + '┘');
      paint(`\n☐ ${q.header}\n${q.question}\n` + rows.map((row, i) => row + box[i]).join('\n')
        + '\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel\n');
      return;
    }
    paint(`\n☐ ${q.header}\n${q.question}\n` + q.options.map((o, i) => `${i === 0 ? '❯' : ' '}${i + 1}. ${o.label}`).join('\n') + '\n');
  };
  if (longPermissionCase) {
    const displayed = permissionPath + (scenario.endsWith('unowned') ? '.other' : '');
    paint('─'.repeat(240) + '\n Overwrite file\n ' + path.relative(cwd, displayed) + '\n' + '╌'.repeat(240) + '\n'
      + Array.from({ length: 8 }, (_, i) => ` ${i + 1} ${'Plan context '.repeat(8)}`).join('\n') + '\n' + '╌'.repeat(240)
      + '\n Do you want to overwrite ' + path.basename(displayed) + '?\n ❯ 1. Yes\n'
      + '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session'
      // The history-only refusal must lack current directory evidence as well as the clipped header.
      + (scenario === 'post-permission-request-long-history' ? '' : '; Yes, and always allow access to\n      ' + path.dirname(displayed) + ' for this session')
      + ' (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend');
  }
  else if (stage === 'permission') paint(`Do you want to ${fileRequestCase ? 'overwrite' : 'create'} ${scenario.endsWith('unowned') ? 'other.md' : 'plan.md'}?\n❯1.Yes\n2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel · Tab to amend`);
  else show();
  if (scenario === 'post-permission-request-arrival-race') paint('\nI will make this plan bulletproof.\n');
  if (viewportCase) paint(viewportReplay.frame);
  if (scenario === 'post-unmatched') paint('\nOther question\n❯1.Unrelated left option\n2.Unrelated right option\n');
  const initialPermissionHistory = longPermissionCase ? buffer : undefined;
  const sends: string[] = [];
  const premature: string[] = [];
  let acknowledged = false;
  let followNumber = 1;
  let followId = 'follow-up';
  let closed = false;
  let diagnosticBeforeClose = false;
  const sendFailure = new Error('post-mode send failed');
  const diagnosticPath = path.join(evalDir, 'mode-navigation', `${sessionId}.json`);
  const resizes: number[] = [];
  const session = {
    ...(viewportCase ? { resizeQuestionViewport: async (rows: number, deadlineAt: number) => {
      if (clock >= deadlineAt) return null;
      if (scenario === 'post-viewport-deadline') { clock = deadlineAt; return null; }
      const before = buffer.length; resizes.push(rows);
      if (scenario === 'post-viewport-resize-failure') throw new Error('controlled PTY resize failure');
      if (rows === 40) {
        if (scenario !== 'post-viewport-no-restore-output') paint('\nRestored normal viewport\n');
        return before;
      }
      if (scenario === 'post-viewport-input-change') { input.questions[0]!.options[0]!.description += ' changed'; tool(followId, input); }
      if (scenario === 'post-viewport-owner-change') { tool('other-call', { questions: [{ ...approach, question: 'Different owned question' }] }); }
      if (scenario === 'post-viewport-no-output') return before;
      if (scenario === 'post-viewport-cap') paint(viewportReplay.frame);
      else {
        const q = input.questions[0]!;
        // Match the CLI's bounded display input, not its undisplayed tail.
        paint(`☐ ${q.header}\n${q.question.slice(0, 2000)}…\n`
          + q.options.map((o, i) => `${i === 0 ? '❯' : ' '}${i + 1}. ${o.label}`).join('\n')
          + '\nEnter to select · ↑/↓ to navigate · Esc to cancel\n');
      }
      return before;
    } } : {}),
    get hermeticConfigDir() { if (scenario === 'post-read-deadline') clock = 30_000; return config; },
    nativeQuestionEvents: events,
    exited: () => scenario === 'post-exited' || (scenario === 'post-exit-during-pause' && clock > 0), exitCode: () => 9,
    visibleSince: (mark = 0) => questionPosture && !scenario.endsWith('-no-frame') ? buffer.slice(mark).replaceAll('bulletproof', 'bulletprof') : buffer.slice(mark), rawOutput: () => buffer,
    currentScreen: async () => {
      const decoded = decoder ? await decoder.snapshot() : null;
      if (decoded && stage === 'permission') longPermissionFrame = decoded.text;
      const frame = { text: decoded?.text ?? screen, rawEnd: scenario === 'post-stale' || scenario === 'post-permission-request-long-stale'
        || scenario === 'post-question-posture-stale' && stage === 'done' ? 0 : buffer.length };
      if (previewCase) {
        previewFrameReads++;
        if (focusWrites && scenario === 'post-preview-deadline') clock = 30_000;
        if (focusWrites && scenario === 'post-preview-input-change') {
          input.questions[tab]!.options[0]!.description = 'Changed native input'; tool(followId, input);
        }
      }
      const publish = publishDuringScreen; publishDuringScreen = null;
      if (publish) { publish(); paint('Do you want to overwrite plan.md?\n❯1.Yes\n2.Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel'); }
      if (scenario === 'post-question-posture-output-after-snapshot' && stage === 'done') buffer += '\nUnobserved terminal output\n';
      return frame;
    },
    mark: () => { if (scenario === 'post-mark-deadline') clock = 30_000; return buffer.length; },
    send(data: string) {
      sends.push(data);
      if (scenario === 'post-send-failure') throw sendFailure;
      if (stage === 'permission' && data === '1\r') {
        if (fileRequestCase) append({ type: 'assistant', cwd, message: { role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: permissionPath, content: 'Plan' } }] } });
        if (scenario !== 'post-permission-request-no-ack') ack('write');
        if (scenario === 'post-permission-request-arrival-race') {
          acknowledged = true; stage = 'done'; paint('\nI will make this plan bulletproof.\n'); return;
        }
        if (navigation) { input.questions = [mode]; followId = 'mode'; }
        tool(followId, input); stage = 'question'; show(); return;
      }
      const expected = viewportCase ? '1' : scenario === 'post-preview-navigation' ? tab === 0 ? '1' : '3' : navigation || scenario === 'post-repeat-mode' ? '3' : tab > 0 || ['post-no-recommendation', 'post-ambiguous-recommendation'].includes(scenario) ? '1' : '2';
      if (previewCase && stage === 'question' && input.questions[tab]!.options.some(o => 'preview' in o)) {
        if (/^[1-4]$/.test(data)) {
          focusWrites++;
          if (focused === Number(data)) sameFocusWrites++;
          else if (scenario === 'post-preview-wrong-focus') show();
          else if (!['post-preview-stale-focus', 'post-preview-short-stale-focus'].includes(scenario)) { focused = Number(data); show(); }
          return;
        }
        if (data !== '\r' || focused !== Number(expected)) { premature.push(data); return; }
        if (scenario === 'post-preview-send-failure') throw sendFailure;
        tab++; focused = 1;
        if (tab < input.questions.length) { show(); return; }
        if (input.questions.length > 1) { stage = 'submit'; paint('\nReview your answers\nReady to submit your answers?\nSubmit answers\n'); return; }
        // LNe commits a one-question call immediately; no second Enter.
        stage = 'submit';
      }
      if (viewportCase && stage === 'question' && data === expected) {
        tab++; stage = 'submit'; data = '\r'; // Plain one-question auto-submit.
      }
      if (stage === 'question' && data === expected) {
        tab++;
        if (scenario === 'post-stale-after-pick') return;
        if (tab < input.questions.length) show();
        else { stage = 'submit'; paint('\nReview your answers\nReady to submit your answers?\nSubmit answers\n'); }
      } else if (stage === 'submit' && data === '\r') {
        if (events && !fileRequestCase) tool('follow-up', input);
        if (!['post-no-ack', 'post-preview-no-ack', 'post-preview-short-no-ack', 'post-viewport-no-ack', 'post-question-posture-no-ack'].includes(scenario)) { ack(followId, ['post-error-ack', 'post-viewport-error-ack'].includes(scenario)); acknowledged = !['post-error-ack', 'post-viewport-error-ack'].includes(scenario); }
        if (scenario === 'post-many-questions' && followNumber < 13) {
          followId = `follow-up-${++followNumber}`;
          input.questions[0] = { ...approach, header: `Approach ${followNumber}`, question: `D${followNumber + 1} — Confirm implementation approach ${followNumber}?` };
          tool(followId, input); tab = 0; stage = 'question'; show(); return;
        }
        stage = 'done';
        if (questionPosture) {
          paint(scenario.endsWith('-unrendered') ? '\nReview continues\n' : '\nUser answered the question:\n' + approach.question + '\n');
          return;
        }
        const text = scenario === 'post-wrong-posture' ? 'Dream big with scope expansion.' : 'I will make this plan bulletproof.';
        if (scenario !== 'post-missing-posture') append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        paint(scenario === 'post-not-rendered' || textDiagnostic ? '\nReview continues\n' : '\n' + text + '\n');
      } else premature.push(data);
    },
    close: async () => { decoder?.dispose(); closed = true; diagnosticBeforeClose = fs.existsSync(diagnosticPath); fs.rmSync(config, { recursive: true, force: true }); },
  } as unknown as ClaudePtySession;
  if (scenario.endsWith('-history') || scenario === 'post-question-posture-no-frame') delete session.currentScreen;
  const oldSleep = Bun.sleep, oldNow = Date.now;
  Bun.sleep = (async (ms: number) => { clock += ms; }) as typeof Bun.sleep;
  Date.now = () => clock;
  let error, originalSendErrorPreserved = false;
  try {
    try {
      if (navigation) await navigateToModeAskUserQuestion(session, 0, 'HOLD SCOPE', { sessionId, budgetMs: 30_000 });
      else await waitForNativeModePosture(session, { modeIndex: 3, sincePick, toolUseId: 'mode' }, 'HOLD SCOPE',
        { sessionId, postureRe: /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i, budgetMs: scenario === 'post-many-questions' ? 240_000 : 30_000 });
    }
    catch (cause) { error = String(cause); originalSendErrorPreserved = cause === sendFailure; }
    finally { await session.close(); }
    const diagnostic = fs.existsSync(diagnosticPath) ? JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')) : null;
    console.log(JSON.stringify({ error, sends, longPermissionFrame, initialPermissionHistory, permissionPath, premature, acknowledged, earlyWithoutNativeInvocation, raceInjected, originalSendErrorPreserved,
      closed, diagnosticBeforeClose, resizes, focusWrites, sameFocusWrites, previewFrameReads, configRemovedBeforeArtifactRead: !fs.existsSync(config), diagnostic,
      diagnosticMode: diagnostic && (fs.statSync(diagnosticPath).mode & 0o777), elapsed: clock }));
  } finally { Bun.sleep = oldSleep; Date.now = oldNow; fs.rmSync(root, { recursive: true, force: true }); }
}
