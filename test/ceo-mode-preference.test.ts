import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectCeoModePreference, runCeoModePreferenceObservation } from './helpers/ceo-mode-preference';
import type { OwnedClaudeTranscript } from './helpers/owned-claude-transcript';
import { stripAnsi, type ClaudePtySession } from './helpers/claude-pty-runner';

const automatic = 'Mode is HOLD SCOPE (auto-decided from plan-tune preference).';
const approach = 'D1 — Which implementation approach? <gstack-qid:plan-ceo-review-approach-select>\nA) Reuse the formatter (recommended)\nB) Add a dependency';
const mode = 'D2 — Which review mode? <gstack-qid:plan-ceo-review-mode>\nA) HOLD SCOPE\nB) SCOPE EXPANSION';
const assistant = (text: string, stop_reason = 'end_turn', id = 'message-1') => ({ type: 'assistant', message: { role: 'assistant', id, stop_reason, content: [{ type: 'text', text }] } });
const transcript = (...rows: any[]): OwnedClaudeTranscript => ({ rows, file: null, completedLines: rows.length, pendingBytes: 0 });

test('mode-only preference does not reject an implementation-approach question', () => {
  expect(inspectCeoModePreference(transcript(assistant(approach)), approach)).toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach-select', answer: 'A' });
  expect(inspectCeoModePreference(transcript(assistant(automatic, 'tool_use'), assistant(approach, 'end_turn', 'other')), automatic + '\n' + approach).kind).toBe('auto_decided');
});
test('real mode questions fail, including one asked before a later annotation', () => {
  expect(inspectCeoModePreference(transcript(assistant(mode)), mode).kind).toBe('asked');
  const native = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__conductor__AskUserQuestion', input: { questions: [{ question: mode }] } }] } };
  expect(inspectCeoModePreference(transcript(native, assistant(automatic)), automatic).kind).toBe('asked');
  const mixed = 'Example: this review could cover CSV escaping.\n\nNow choose the review mode. ' + mode;
  expect(inspectCeoModePreference(transcript(assistant(mixed)), mixed).kind).toBe('asked');
  expect(inspectCeoModePreference(transcript(assistant(mixed), assistant(automatic, 'end_turn', 'later')), mixed + '\n' + automatic).kind).toBe('asked');
  const interrupted = 'Context.\n```text\nquoted code\n```\n' + mode;
  expect(inspectCeoModePreference(transcript(assistant(interrupted), assistant(automatic, 'end_turn', 'later')), interrupted + '\n' + automatic).kind).toBe('asked');
});
test('Write previews, tool results, thinking, incomplete lines, and unrendered text are not decisions', () => {
  const payload = { type: 'assistant', message: { role: 'assistant', id: 'write', content: [
    { type: 'tool_use', name: 'Write', input: { content: mode + '\n' + automatic } },
    { type: 'thinking', thinking: automatic },
  ] } };
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: automatic }] } };
  expect(inspectCeoModePreference(transcript(payload, result), mode + automatic).kind).toBe('working');
  expect(inspectCeoModePreference({ ...transcript(assistant(automatic)), pendingBytes: 4 }, automatic).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(automatic)), 'Working...').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(approach, 'tool_use')), approach).kind).toBe('working');
});
test('an unrelated automatic decision cannot establish mode preference compliance', () => {
  const text = 'Auto-decided implementation approach → reuse code (your preference).\n\nReview mode options: HOLD SCOPE or SCOPE EXPANSION.';
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test.each([
  'I have not auto-decided the mode HOLD SCOPE (your preference).',
  'Auto-decided implementation approach → reuse code (your preference). The review mode HOLD SCOPE will be selected later.',
  'Example annotation: Mode is HOLD SCOPE (auto-decided from plan-tune preference).',
  'I will print: Auto-decided review mode → HOLD SCOPE (your preference).',
  '```text\n' + automatic + '\n```',
  '> ' + automatic,
  'Example only, not an actual decision:\n' + automatic,
  '    ' + automatic,
  '````text\n```\n' + automatic + '\n````',
])('non-decisions cannot produce an automatic-mode pass: %s', text => {
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test('a real standard annotation is accepted at sentence level', () => {
  const text = 'Auto-decided review mode → HOLD SCOPE (your preference). Change with /plan-tune.';
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('auto_decided');
});
test('quoted templates and previously acknowledged or superseded questions cannot receive an answer', () => {
  const unfenced = 'Example only; do not answer this template yet:\n' + approach;
  expect(inspectCeoModePreference(transcript(assistant(unfenced)), unfenced).kind).toBe('working');
  const text = 'Example only; do not answer this template yet:\n```text\n' + approach + '\n```';
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(approach), assistant('Working...', 'tool_use', 'new')), approach + '\nWorking...').kind).toBe('working');
  const reply = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Choose A' }] } };
  expect(inspectCeoModePreference(transcript(assistant(approach), reply), approach).kind).toBe('working');
});

test.each(['automatic', 'target', 'timeout', 'expired-boot', 'exited'] as const)('driver handles %s without replaying the unrelated answer or accepting a preview', async scenario => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-preference-free-'));
  const sends: string[] = [];
  let time = 0; let closed = false; let visible = ''; let file = ''; let sessionId = ''; let polls = 0;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ ...row, sessionId }) + '\n');
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    exited: () => scenario === 'exited', close: async () => { closed = true; },
    send(data: string) {
      sends.push(data);
      if (data.startsWith('/')) {
        append({ type: 'assistant', message: { id: 'preview', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Write', id: 'w1', input: { content: mode } }] } });
        visible += mode;
      } else if (data.startsWith('For plan-ceo-review-approach-select,')) {
        // Repaint the exact previous question for several polls; no extra input.
        visible += '\n' + approach;
      } else throw new Error('Unsolicited input: ' + data);
    },
  } as unknown as ClaudePtySession;
  try {
    const observation = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: scenario === 'expired-boot' ? 1000 : 30_000 }, {
      now: () => time,
      launch: async opts => {
        sessionId = opts.extraArgs![1];
        file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return session;
      },
      pause: async ms => {
        time += ms;
        if (++polls === 3) { append(assistant(approach)); visible += '\n' + approach; }
        if (polls === 6 && ['automatic', 'target'].includes(scenario)) {
          const text = scenario === 'automatic' ? automatic : mode;
          append(assistant(text, 'end_turn', 'last')); visible += '\n' + text;
        }
      },
    });
    expect(closed).toBe(true);
    expect(sends.filter(text => text.startsWith('For ')).length).toBe(['expired-boot', 'exited'].includes(scenario) ? 0 : 1);
    expect(observation.outcome).toBe(scenario === 'automatic' ? 'auto_decided' : scenario === 'target' ? 'asked' : scenario === 'exited' ? 'exited' : 'timeout');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});

const capturedOfficeHours = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-office-hours-render.json'), 'utf8'));
test('owned office-hours reply survives captured terminal redraw without accepting a mode decision', () => {
  const { assistantText, visible } = capturedOfficeHours;
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-office-hours-offer', answer: 'B',
  });
});

test('captured prose reply still requires current complete ownership and both explicit selectors', () => {
  const { assistantText, visible } = capturedOfficeHours;
  const owned = assistant(assistantText);
  for (const input of [
    transcript(assistant(assistantText, 'tool_use')),
    { ...transcript(owned), pendingBytes: 3 },
    transcript(owned, { type: 'user', message: { role: 'user', content: 'Choose B' } }),
    transcript(owned, assistant('Working...', 'tool_use', 'newer')),
    transcript({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'end_turn', content: [
      { type: 'tool_use', name: 'Write', input: { content: assistantText } },
    ] } }),
    transcript(assistant('Example only, not an actual question:\n' + assistantText)),
    transcript(assistant('I will present this later:\n' + assistantText)),
    transcript(assistant(assistantText.split('\n').map((line: string) => '> ' + line).join('\n'))),
  ]) expect(inspectCeoModePreference(input, visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(owned), '<gstack-qid:plan-ceo-review-office-hours-offer>').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(owned), visible.replaceAll('plan-ceo-review-office-hours-offer', 'foreign-question')).kind).toBe('working');
  const mismatched = assistantText.replace('or A to run', 'or C to run');
  expect(inspectCeoModePreference(transcript(assistant(mismatched)), visible.replaceAll('orAtorun', 'orCtorun')).kind).toBe('working');
});

const capturedImplementation = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-implementation-render.json'), 'utf8'));
test('captured three-choice reply uses the rendered marker without relying on damaged redraw prose', () => {
  const { assistantText, rawTerminal, visible } = capturedImplementation;
  expect(stripAnsi(rawTerminal)).toBe(visible);
  expect(rawTerminal).not.toContain('<gstack-qid:'); // CLI markdown already removed the brackets.
  expect(visible.replace(/\s/g, '')).toContain('ReplywithA,B,orC.gstack-qid:plan-ceo-review-implementation-approach');
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-implementation-approach', answer: 'B',
  });
});

test.each([
  { selectors: ['A', 'B'], reply: 'Reply B to keep this scope, or A to add caching.', position: 'last' },
  { selectors: ['A', 'B', 'C'], reply: 'Reply with A, B, or C.', position: 'first' },
  { selectors: ['1', '2', '3', '4'], reply: 'Reply with 1, 2, 3, or 4.', position: 'first' },
])('reply corroboration follows the unique selector inventory: $reply', ({ selectors, reply, position }) => {
  const directive = `${reply} <gstack-qid:plan-ceo-review-cache-policy>`;
  const options = selectors.map((selector, index) => `${selector}) Cache policy ${index}${index === 1 ? ' (recommended)' : ''}`).join('\n');
  const text = `## D3 — Cache policy\n${position === 'first' ? directive + '\n' : ''}The choice determines expiration behavior.\n${options}${position === 'last' ? '\n' + directive : ''}`;
  const visible = directive.replace(/[<>]/g, '').replace(/ /g, '');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible)).toMatchObject({ kind: 'unrelated', answer: selectors[1] });
});

test('captured reply cannot authorize incomplete, ambiguous, stale, quoted or mode questions', () => {
  const { assistantText, visible } = capturedImplementation;
  const owned = assistant(assistantText);
  for (const input of [
    transcript(assistant(assistantText, 'tool_use')),
    { ...transcript(owned), pendingBytes: 1 },
    transcript(owned, { type: 'user', message: { role: 'user', content: 'Choose B' } }),
    transcript(owned, assistant('Working...', 'tool_use', 'newer')),
    transcript(assistant(assistantText, 'end_turn', 'old'), assistant(assistantText, 'end_turn', 'new')),
    transcript(assistant('Example only, not an actual question:\n' + assistantText)),
    transcript(assistant('I will present this later:\n' + assistantText)),
    transcript(assistant('```text\n' + assistantText + '\n```')),
    transcript(assistant(assistantText.split('\n').map((line: string) => '> ' + line).join('\n'))),
    transcript({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'end_turn', content: [
      { type: 'tool_use', name: 'Write', input: { content: assistantText } },
    ] } }),
    transcript(assistant(assistantText.replace('**C)', '**B)'))),
    transcript(assistant(assistantText.replace('**A)', '**A) (recommended)'))),
    transcript(assistant(assistantText + '\n<gstack-qid:plan-ceo-review-other>')),
  ]) expect(inspectCeoModePreference(input, visible).kind).toBe('working');
  for (const render of [
    'gstack-qid:plan-ceo-review-implementation-approach',
    visible.replaceAll('plan-ceo-review-implementation-approach', 'foreign-question'),
    visible.replaceAll('plan-ceo-review-implementation-approach', 'plan-ceo-review-implementation-approach-stale'),
    visible.replaceAll('gstack-qid:plan-ceo-review-implementation-approach', '<gstack-qid:plan-ceo-review-implementation-approach-stale>'),
    visible.replaceAll('orC.', 'orD.'),
    visible.replaceAll('A,B,orC.', 'A,orC.'),
    visible.replaceAll('Reply', 'Repl'),
  ]) expect(inspectCeoModePreference(transcript(owned), render).kind).toBe('working');
  const modeText = assistantText.replaceAll('plan-ceo-review-implementation-approach', 'plan-ceo-review-mode');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), visible.replaceAll('plan-ceo-review-implementation-approach', 'plan-ceo-review-mode')).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
  for (const text of [
    assistantText + '\nD) Add another format\nE) Add a fifth format',
    assistantText.replace('**C)', '**Z)'),
  ]) expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});

test('qid token boundaries survive normalization even before later reply text', () => {
  const text = 'D1 — Cache policy\nReply with A<gstack-qid:plan-ceo-review-cache>, or B.\nA) Reuse (recommended)\nB) Replace';
  const visible = 'Reply with A gstack-qid:plan-ceo-review-cache, or B.';
  expect(inspectCeoModePreference(transcript(assistant(text)), visible).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible.replace('cache,', 'cache-stale,')).kind).toBe('working');
});

test('same-input exact tool directives are ambiguous while ordinary qid references are not', () => {
  const { assistantText, visible } = capturedImplementation;
  const preview = (text: string) => ({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'Write', input: { content: text } },
  ] } });
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: assistantText }] } };
  const current = assistant(assistantText, 'end_turn', 'current');
  expect(inspectCeoModePreference(transcript(preview(assistantText), current), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(result, current), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(preview(assistantText), current), assistantText).kind).toBe('working');
  const qidReference = '<gstack-qid:plan-ceo-review-implementation-approach>';
  expect(inspectCeoModePreference(transcript(preview(qidReference), current), visible).kind).toBe('unrelated');
  const nextInput = { type: 'user', message: { role: 'user', content: 'Continue this review' } };
  expect(inspectCeoModePreference(transcript(preview(assistantText), nextInput, current), visible).kind).toBe('unrelated');
});

test('input-window scoping keeps earlier contrary mode and affirmative mode evidence', () => {
  const { assistantText, visible } = capturedImplementation;
  const current = assistant(assistantText, 'end_turn', 'current');
  expect(inspectCeoModePreference(transcript(current), visible, '').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(mode), current), mode + visible, '').kind).toBe('asked');
  expect(inspectCeoModePreference(transcript(assistant(automatic), current), automatic + visible, '').kind).toBe('auto_decided');
});

test.each([false, true])('a previous input-window preview cannot answer a new owned question; fresh render=%s', async showCurrent => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-preference-input-window-'));
  const second = capturedImplementation.assistantText;
  const sends: string[] = [];
  let time = 0; let visible = ''; let file = ''; let sessionId = ''; let polls = 0; let closed = false;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ ...row, sessionId }) + '\n');
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    exited: () => false, close: async () => { closed = true; },
    send(data: string) {
      sends.push(data);
      if (data.startsWith('/')) {
        append({ type: 'assistant', message: { id: 'preview', role: 'assistant', stop_reason: 'tool_use', content: [
          { type: 'tool_use', name: 'Write', input: { content: second } },
        ] } });
        append(assistant(approach));
        visible += second + '\n' + approach;
      } else if (data.startsWith('For ')) {
        append({ type: 'user', message: { role: 'user', content: data } });
        if (data.startsWith('For plan-ceo-review-implementation-approach,')) {
          append(assistant(automatic, 'end_turn', 'done'));
          visible += '\n' + automatic;
        }
      } else throw new Error('Unsolicited input: ' + data);
    },
  } as unknown as ClaudePtySession;
  try {
    const observation = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000 }, {
      now: () => time,
      launch: async opts => {
        sessionId = opts.extraArgs![1];
        file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return session;
      },
      pause: async ms => {
        time += ms;
        if (++polls === 3) append(assistant(second, 'end_turn', 'new-question'));
        if (polls === 4 && showCurrent) visible += '\n' + capturedImplementation.visible;
      },
    });
    expect(closed).toBe(true);
    expect(sends.filter(text => text.startsWith('For '))).toEqual([
      'For plan-ceo-review-approach-select, I choose option A. Continue the review.\r',
      ...(showCurrent ? ['For plan-ceo-review-implementation-approach, I choose option B. Continue the review.\r'] : []),
    ]);
    expect(observation.outcome).toBe(showCurrent ? 'auto_decided' : 'timeout');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});
