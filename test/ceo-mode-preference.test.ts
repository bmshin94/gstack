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
  let typed = '';
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
        typed = data;
      } else throw new Error('Unsolicited input: ' + data);
    },
    sendKey(key: string) {
      expect(key).toBe('Enter');
      expect(typed).not.toEndWith('\r');
      append({ type: 'user', message: { role: 'user', content: typed } });
      // Repaint the exact previous question for several polls; no extra input.
      visible += '\n' + approach;
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

test.each([
  'string ack', 'block ack', 'delayed ack', 'partial ack',
  'dropped text', 'dropped Enter', 'wrong user then exact ack', 'nontext user then exact ack', 'assistant then exact ack',
  'old ack', 'foreign ack', 'sidechain ack', 'parent-tool ack', 'tool-result echo', 'reset prefix',
  'same-owner duplicate', 'same-owner thinking',
  'changed same-owner before Enter', 'same-owner tool before Enter', 'incomplete same-owner before Enter',
  'ack before Enter', 'new owner before Enter', 'nontext user before Enter', 'automatic before Enter', 'mode question before Enter',
  'exit before Enter', 'deadline before Enter', 'partial native row before Enter', 'throw on type',
])('prose submission requires a separate Enter and exact owned acknowledgement: %s', async scenario => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-submit-free-'));
  const evidenceRoot = path.join(config, 'evidence');
  const payload = 'For plan-ceo-review-approach-select, I choose option A. Continue the review.';
  const writes: Array<{ text: string; poll: number }> = [];
  let time = 0; let polls = 0; let visible = ''; let file = ''; let sessionId = '';
  let typed = ''; let entered = 0; let enterPoll = -1; let typePoll = -1;
  let closed = false; let exited = false; let progressed = false;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
  const user = (content: any = payload) => ({ type: 'user', message: { role: 'user', content } });
  const finish = () => { append(assistant(automatic, 'end_turn', 'done')); visible += '\n' + automatic; progressed = true; };
  const acknowledge = () => {
    append(user(scenario === 'block ack' ? [{ type: 'text', text: payload }] : payload));
    finish();
  };
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    rawOutput: () => visible, visibleText: () => visible, pid: () => 1, exitCode: () => exited ? 0 : null,
    exited: () => exited, close: async () => { closed = true; },
    send(data: string) {
      writes.push({ text: data, poll: polls });
      if (data.startsWith('/')) {
        if (scenario === 'old ack') append(user());
        append(assistant(approach)); visible += approach;
        return;
      }
      typePoll = polls;
      if (scenario === 'throw on type') throw new Error('Synthetic text transport failure');
      if (scenario === 'dropped text') return;
      // Model the observed CLI: text plus CR in one write can leave editable
      // text without a native user turn. Only a later Enter submits it.
      typed = data.replace(/\r$/, ''); visible += '\n❯ ' + typed;
    },
    sendKey(key: string) {
      expect(key).toBe('Enter'); entered++; enterPoll = polls;
      if (!typed || scenario === 'dropped Enter') return;
      if (scenario === 'delayed ack' || scenario === 'partial ack') {
        if (scenario === 'partial ack') fs.appendFileSync(file, JSON.stringify({ sessionId, ...user() }));
        return;
      }
      if (scenario === 'wrong user then exact ack') { append(user('For another-question, I choose option A.')); acknowledge(); }
      else if (scenario === 'nontext user then exact ack') { append(user([{ type: 'image', source: {} }])); acknowledge(); }
      else if (scenario === 'assistant then exact ack') { append(assistant('Another owner', 'tool_use', 'intervening')); acknowledge(); }
      else if (scenario === 'old ack') finish();
      else if (scenario === 'foreign ack') { append({ ...user(), sessionId: '00000000-0000-4000-8000-000000000001' }); finish(); }
      else if (scenario === 'sidechain ack') { append({ ...user(), isSidechain: true }); finish(); }
      else if (scenario === 'parent-tool ack') { append({ ...user(), parent_tool_use_id: 'child' }); finish(); }
      else if (scenario === 'tool-result echo') { append(user([{ type: 'tool_result', tool_use_id: 'preview', content: payload }])); finish(); }
      else if (scenario === 'reset prefix') { fs.writeFileSync(file, ''); acknowledge(); }
      else acknowledge();
    },
  } as unknown as ClaudePtySession;
  try {
    const promise = runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000, evidenceRoot }, {
      now: () => time,
      launch: async opts => {
        sessionId = opts.extraArgs![1]; file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true }); return session;
      },
      pause: async ms => {
        time += ms; polls++;
        if (typePoll >= 0 && !progressed && (scenario.endsWith('before Enter')
          || scenario === 'same-owner duplicate' || scenario === 'same-owner thinking')) {
          progressed = true;
          if (scenario === 'ack before Enter') acknowledge();
          else if (scenario === 'exit before Enter') exited = true;
          else if (scenario === 'deadline before Enter') time = 30_000;
          else if (scenario === 'partial native row before Enter') fs.appendFileSync(file, '{"type":');
          else if (scenario === 'nontext user before Enter') append(user([{ type: 'image', source: {} }]));
          else if (scenario === 'same-owner duplicate') append(assistant(approach));
          else if (scenario === 'changed same-owner before Enter') append(assistant('The request has changed.'));
          else if (scenario === 'incomplete same-owner before Enter') append(assistant(approach, 'tool_use'));
          else if (scenario === 'same-owner thinking' || scenario === 'same-owner tool before Enter') {
            append({ type: 'assistant', message: { id: 'message-1', role: 'assistant', stop_reason: 'end_turn', content:
              scenario === 'same-owner thinking' ? [{ type: 'thinking', thinking: 'Nonvisible metadata.' }]
                : [{ type: 'tool_use', name: 'Read', id: 'new-tool', input: {} }] } });
          }
          else {
            const value = scenario === 'automatic before Enter' ? automatic
              : scenario === 'mode question before Enter' ? mode : 'A new unrelated owner';
            append(assistant(value, 'end_turn', 'new-owner')); visible += '\n' + value;
          }
        }
        if (!progressed && enterPoll >= 0 && polls >= enterPoll + 2) {
          if (scenario === 'delayed ack') acknowledge();
          if (scenario === 'partial ack') { fs.appendFileSync(file, '\n'); finish(); }
        }
      },
    });
    const accepted = ['string ack', 'block ack', 'delayed ack', 'partial ack', 'ack before Enter',
      'same-owner duplicate', 'same-owner thinking'].includes(scenario);
    if (scenario === 'throw on type') await expect(promise).rejects.toThrow('Synthetic text transport failure');
    else {
      const result = await promise;
      expect(result.outcome).toBe(accepted ? 'auto_decided' : scenario === 'mode question before Enter' ? 'asked' : scenario === 'exit before Enter' ? 'exited' : 'timeout');
      expect(result.answered).toEqual(accepted ? ['message-1'] : []);
    }
    expect(closed).toBe(true);
    expect(writes.filter(write => write.text.startsWith('For ')).map(write => write.text)).toEqual([payload]);
    expect(entered).toBe(scenario.endsWith('before Enter') || scenario === 'throw on type' ? 0 : 1);
    if (entered) expect(enterPoll).toBeGreaterThan(typePoll);
    const saved = JSON.parse(fs.readFileSync(path.join(evidenceRoot, sessionId, 'observation.json'), 'utf8')).evidence;
    expect(saved.answered).toEqual(accepted ? ['message-1'] : []);
    if (accepted) expect(saved.pendingReply).toBeNull();
    else expect(saved.pendingReply).toMatchObject({ id: 'message-1', questionId: 'plan-ceo-review-approach-select', text: payload, textWriteAttempted: true, enterWriteAttempted: entered === 1 });
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

const adjacentMarker = '<gstack-qid:plan-ceo-review-cache-policy>';
const adjacentReply = 'Reply with **A** or **B**.';
const adjacentBrief = `D1 — Cache policy\nA) Reuse (recommended)\nB) Replace\n\n\`${adjacentMarker}\`\n\n${adjacentReply}`;
const adjacentVisible = adjacentMarker + '\nReply with A or B.';

test('an adjacent standalone identity and reply are corroborated in native order', () => {
  for (const text of [adjacentBrief, adjacentBrief.replaceAll('`', ''), adjacentBrief.replace('\n\nReply', '\nReply')]) {
    expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible)).toMatchObject({
      kind: 'unrelated', questionId: 'plan-ceo-review-cache-policy', answer: 'A',
    });
  }
  for (const visible of [
    adjacentVisible.split('\n').reverse().join('\n'),
    adjacentVisible.replace('cache-policy', 'cache-policy-stale'),
    adjacentVisible.replace(' or B', ''),
    adjacentVisible.replace('or B', 'or C'),
    adjacentMarker,
  ]) expect(inspectCeoModePreference(transcript(assistant(adjacentBrief)), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(adjacentBrief)), adjacentVisible, '').kind).toBe('working');
});

test.each(['> quoted interruption', '```text\nexample\n```', '    indented interruption', 'Intervening prose.'])('adjacent identity cannot be manufactured across %s', interruption => {
  const text = adjacentBrief.replace('\n\nReply', '\n' + interruption + '\nReply');
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible).kind).toBe('working');
});

test('adjacent directives retain completion, ownership and recommendation ambiguity guards', () => {
  for (const input of [
    transcript(assistant(adjacentBrief, 'tool_use')),
    { ...transcript(assistant(adjacentBrief)), pendingBytes: 1 },
    transcript(assistant(adjacentBrief), assistant('Still working', 'tool_use', 'newer')),
    transcript(assistant(adjacentBrief), { type: 'user', message: { role: 'user', content: 'Continue' } }),
    transcript(assistant(adjacentBrief, 'end_turn', 'old'), assistant(adjacentBrief, 'end_turn', 'new')),
    transcript(assistant(adjacentBrief.replace('B) Replace', 'B) Replace (recommended for this situation)'))),
    transcript(assistant(adjacentBrief.replace('(recommended)', '(recommended by the default rule, not by context)').replace('B) Replace', 'B) Replace (recommended for this situation)'))),
    transcript(assistant(adjacentBrief.replace('B) Replace', 'A) Replace'))),
    transcript(assistant(adjacentBrief + '\n<gstack-qid:plan-ceo-review-other>')),
    transcript(assistant(adjacentBrief.replace('`' + adjacentMarker + '`', '    ' + adjacentMarker))),
    transcript(assistant(adjacentBrief.replace('Reply with', '    Reply with'))),
    transcript(assistant(adjacentBrief.replace('`' + adjacentMarker + '`', '`' + adjacentMarker))),
  ]) expect(inspectCeoModePreference(input, adjacentVisible).kind).toBe('working');
});

test('split tool previews cannot establish an adjacent rendered question', () => {
  const current = assistant(adjacentBrief, 'end_turn', 'current');
  const preview = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'Write', input: { identity: adjacentMarker, directive: adjacentReply } },
  ] } };
  const result = { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', content: adjacentMarker }, { type: 'tool_result', content: adjacentReply },
  ] } };
  expect(inspectCeoModePreference(transcript(preview, current), adjacentVisible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(result, current), adjacentVisible).kind).toBe('working');
  const reference = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: adjacentMarker }] } };
  expect(inspectCeoModePreference(transcript(reference, current), adjacentVisible).kind).toBe('unrelated');
});

test.each(['I will present this later:', 'Example only; do not answer:', 'If this becomes relevant:', '> Deferred until later'])('full rendering does not authorize a wrapped question: %s', lead => {
  const text = lead + '\n\n' + adjacentBrief;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible).kind).toBe('working');
});

const capturedAdjacent = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-adjacent-render.json'), 'utf8'));
test('captured immediately introduced brief binds its intact adjacent reply without changing the mode oracle', () => {
  const { assistantText, visible } = capturedAdjacent;
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-office-hours-offer', answer: 'B',
  });
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible, '').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible, '<gstack-qid:plan-ceo-review-office-hours-offer>Reply with A or B.').kind).toBe('working');
  const modeText = assistantText.replaceAll('plan-ceo-review-office-hours-offer', 'plan-ceo-review-mode');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
  const ambiguous = assistantText.replace('A) Run /office-hours now', 'A) Run /office-hours now (recommended by the default rule, not by context)');
  expect(inspectCeoModePreference(transcript(assistant(ambiguous)), visible).kind).toBe('working');
});

const capturedContext = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-context-render.json'), 'utf8'));
test('the captured completed question survives a neutral status introduction without changing its recommendation or mode oracle', () => {
  const { assistantText, visible } = capturedContext;
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-office-hours-offer', answer: 'B',
  });
  const ambiguous = assistantText.replace('A) Run /office-hours first', 'A) Run /office-hours first (recommended)');
  expect(ambiguous).not.toBe(assistantText);
  expect(inspectCeoModePreference(transcript(assistant(ambiguous)), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible, '').kind).toBe('working');
  const modeText = assistantText.replaceAll('plan-ceo-review-office-hours-offer', 'plan-ceo-review-mode');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
});

test.each([
  "I'll present the question now.",
  'I will ask this current question before proceeding.',
  'Loaded project config. I will render this brief below.',
  'Missing saved plans, available local tests. I will present the decision brief here.',
  'The repository scan finished. The remaining decision follows.',
  'A brief update: the workspace scan is complete.\n\nOne decision remains.',
  "No design doc.\n\nI'll present the question now.",
  "**I'll present the question now.**",
  '`review-input.md` is loaded. Now presenting the current decision.',
])('a structurally introduced current decision requires its introduction to render: %s', lead => {
  const text = lead + '\n\n---\n\n' + adjacentBrief;
  const visible = lead.replace(/`/g, '') + '\n---\nD1 — Cache policy\n' + adjacentVisible;
  expect(inspectCeoModePreference(transcript(assistant(text)), visible).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible.replace('---', 'interruption')).kind).toBe('working');
});

test.each([
  "I'll present the question later.",
  "If necessary, I'll present the question now.",
  "I won't present the question now.",
  "I'll present the example question now.",
  "I'll present the question now, but do not answer.",
  "No participation expected. I'll present the question now.",
  "Ready rehearsal material. I'll present the question now.",
  "Ready rehearsal report. I'll present the question now.",
  "This is only a rehearsal. I'll present the question now.",
  "> I'll present the question now.",
  "    I'll present the question now.",
  "`I'll present the question now.`",
  '**`Neutral status.`**',
  '_`Neutral status.`_',
  "```text\nI'll present the question now.\n```",
])('a noncurrent or quoted introduction cannot receive input even when fully rendered: %s', lead => {
  const text = lead + '\n\n---\n\n' + adjacentBrief;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(text)), lead + '\n---\nD1 — Cache policy\n' + adjacentVisible).kind).toBe('working');
});

test.each([
  'Do not answer this decision yet.',
  'Do not _answer_ this decision yet.',
  'Do *not* answer this decision yet.',
  'Do not `answer` this decision yet.',
  'Don’t answer this decision yet.',
  'Note: Do not answer this decision yet.',
  'Do not\nanswer this decision yet.',
  '- Do not answer this decision yet.',
  '### Do not answer this decision yet.',
  'Please do not reply to this question.',
  'No participation expected.',
  'Important: No participation expected.',
  '- No participation expected.',
  '* No participation expected.',
  'This question is deferred until later.',
  'This question is hypothetical.',
  'This is only a rehearsal.',
  "Here's an example:",
  'Here’s an example:',
  "If necessary, I'll present the question now.",
])('noncurrent statements veto the entire unrelated brief without erasing mode evidence: %s', statement => {
  for (const question of [adjacentBrief, "I'll present the question now.\n\n---\n\n" + adjacentBrief]) {
    for (const text of [
      statement + '\n\n' + question,
      question.replace('A) Reuse', statement + '\n\nA) Reuse'),
      question.replace('B) Replace', 'B) Replace. ' + statement),
      question + '\n\n' + statement,
    ]) {
      expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
      expect(inspectCeoModePreference(transcript(assistant(text)), question).kind).toBe('working');
      const modeText = text.replaceAll('plan-ceo-review-cache-policy', 'plan-ceo-review-mode');
      expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
    }
  }
});

test('ordinary inline examples and deferred actions do not make the current question hypothetical', () => {
  const text = ('The workspace scan is complete.\n\n' + adjacentBrief)
    .replace('A) Reuse (recommended)', 'For example, compare the cached value with `a,b` and `a"b`. These inline examples describe the formatter.\n\nA) Reuse the example cache (recommended)')
    .replace('B) Replace', 'B) Defer the cache migration until later');
  expect(inspectCeoModePreference(transcript(assistant(text)), text)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test.each([
  'For example, the parser can preserve an example question in history.',
  'The configuration snippet is only a template for the new formatter.',
  'If we choose A, ask QA to verify the CSV example later.',
])('explanations about examples and subsequent work do not defer the current question: %s', explanation => {
  const text = adjacentBrief.replace('A) Reuse', explanation + '\n\nA) Reuse');
  expect(inspectCeoModePreference(transcript(assistant(text)), text)).toMatchObject({ kind: 'unrelated', answer: 'A' });
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test.each([
  'Do not answer cached queries until refreshed',
  'Do not answer iterative queries until refreshed',
  'Render the template question later',
])('an option action does not prohibit input to the current question: %s', option => {
  const text = adjacentBrief.replace('B) Replace', 'B) ' + option);
  expect(inspectCeoModePreference(transcript(assistant(text)), text)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test('a prefaced current question requires an explicit corroborated Reply even when its entire text renders', () => {
  const text = 'The workspace scan is complete.\n\n' + approach;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});

test('the current introduction must precede its reply and cannot come from a tool preview', () => {
  const lead = "I'll present the question now.";
  const introduction = lead + '\n\n---\n\nD1 — Cache policy';
  const text = lead + '\n\n---\n\n' + adjacentBrief;
  const current = assistant(text, 'end_turn', 'current');
  const visible = introduction + '\n' + adjacentVisible;
  expect(inspectCeoModePreference(transcript(current), adjacentVisible + '\n' + introduction).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(current), visible).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(current), adjacentVisible + '\n' + visible).kind).toBe('unrelated');
  const preview = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'Write', input: { content: introduction } },
  ] } };
  const splitPreview = { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', content: lead }, { type: 'tool_result', content: '---\nD1 — Cache policy' },
  ] } };
  for (const input of [transcript(preview, current), transcript(splitPreview, current)]) {
    expect(inspectCeoModePreference(input, visible).kind).toBe('working');
    expect(inspectCeoModePreference(input, text).kind).toBe('working');
  }
  const nextInput = { type: 'user', message: { role: 'user', content: 'Continue the review' } };
  expect(inspectCeoModePreference(transcript(preview, nextInput, current), visible).kind).toBe('unrelated');
});

test.each([false, true])('a previous input-window preview cannot answer a new owned question; fresh render=%s', async showCurrent => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-preference-input-window-'));
  const second = capturedImplementation.assistantText;
  const sends: string[] = [];
  let time = 0; let visible = ''; let file = ''; let sessionId = ''; let polls = 0; let closed = false;
  let typed = ''; let firstAcknowledged = false; let secondRendered = false;
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
        typed = data;
      } else throw new Error('Unsolicited input: ' + data);
    },
    sendKey(key: string) {
      expect(key).toBe('Enter');
      append({ type: 'user', message: { role: 'user', content: typed } });
      if (typed.startsWith('For plan-ceo-review-implementation-approach,')) {
        append(assistant(automatic, 'end_turn', 'done')); visible += '\n' + automatic;
      } else {
        firstAcknowledged = true;
        append(assistant(second, 'end_turn', 'new-question'));
      }
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
        polls++;
        if (firstAcknowledged && !secondRendered && showCurrent) {
          secondRendered = true; visible += '\n' + capturedImplementation.visible;
        }
      },
    });
    expect(closed).toBe(true);
    expect(sends.filter(text => text.startsWith('For '))).toEqual([
      'For plan-ceo-review-approach-select, I choose option A. Continue the review.',
      ...(showCurrent ? ['For plan-ceo-review-implementation-approach, I choose option B. Continue the review.'] : []),
    ]);
    expect(observation.outcome).toBe(showCurrent ? 'auto_decided' : 'timeout');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});
