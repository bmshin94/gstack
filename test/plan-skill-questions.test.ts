import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanSkillQuestions, matchesNativeQuestion, isNativeQuestionSubmitVisible, nativePermissionKey, type NativeQuestion } from './helpers/plan-skill-questions';
import { isPermissionDialogVisible, parseNumberedOptions, stripAnsi } from './helpers/claude-pty-runner';
import { setupQuestionEventSource } from './helpers/plan-skill-question-events';

const sessionId = '00000000-0000-4000-8000-000000000001';
const question: NativeQuestion = { question: 'D1 — Which approach?\nMake it reliable. Enforce the delivery policy.', header: 'Approach', multiSelect: false,
  options: ['Extend dispatcher', 'Queue fanout', 'Minimal patch', 'Hold scope'].map(label => ({ label, description: label })) };
let config: string;
let file: string;
const call = (id: string, questions = [question]) => ({ type: 'assistant', sessionId, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const write = (...rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
beforeEach(() => { config = fs.mkdtempSync(path.join(os.tmpdir(), 'native-question-')); file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true }); });
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

function earlyQuestions() {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  return { source, emit(id: string, input: unknown = { questions: [question] }) {
    const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: file, cwd: config,
      tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: input,
    })), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.length).toBe(0);
  } };
}

test('a pre-transcript native question is pending until its exact owned result arrives', () => {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Begin the review' } });
  const early = earlyQuestions();
  early.emit('early');
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([]);
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls.map(c => [c.id, c.result])).toEqual([['early', 'pending']]);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: '00000000-0000-4000-8000-000000000002',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'early' }] } }) + '\n');
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls[0].result).toBe('pending');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'early', content: 'Answer accepted' }] } }) + '\n');
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls[0].result).toBe('answered');
});

test('early and persisted invocations coalesce, and any changed input fails', () => {
  write(call('same'));
  const early = earlyQuestions();
  early.emit('same');
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls).toHaveLength(1);
  write(call('same', [{ ...question, question: 'A different question?' }]));
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

for (const stopReason of [null, 'tool_use']) {
  test(`the hook's false multiSelect default matches an omitted transcript field (${stopReason})`, () => {
    const { multiSelect, ...omittedDefault } = question;
    const native = call('defaulted');
    native.message.stop_reason = stopReason as any;
    native.message.content[0].input.questions = [omittedDefault as NativeQuestion];
    write(native);
    const early = earlyQuestions();
    early.emit('defaulted');
    const pending = readPlanSkillQuestions(config, sessionId, early.source);
    expect(pending.calls).toEqual([{ id: 'defaulted', questions: [question], result: 'pending' }]);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'defaulted', content: 'Answer accepted' }] } }) + '\n');
    expect(readPlanSkillQuestions(config, sessionId, early.source).calls[0].result).toBe('answered');
  });
}

test('a completed native invocation without an event uses the same false default', () => {
  const { multiSelect, ...omittedDefault } = question;
  write(call('native-default', [omittedDefault as NativeQuestion]));
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([
    { id: 'native-default', questions: [question], result: 'pending' },
  ]);
});

for (const multiSelect of [true, null, 'false']) {
  test(`default equivalence still rejects changed multiSelect ${JSON.stringify(multiSelect)}`, () => {
    write(call('changed-default', [{ ...question, multiSelect } as NativeQuestion]));
    const early = earlyQuestions();
    early.emit('changed-default');
    expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
  });
}

test('default equivalence preserves comparison of other input fields', () => {
  const { multiSelect, ...omittedDefault } = question;
  const native = call('other-input', [omittedDefault as NativeQuestion]);
  (native.message.content[0].input as any).metadata = { changed: true };
  write(native);
  const early = earlyQuestions();
  early.emit('other-input');
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

test('early native input uses the existing validator and never supplies a successful result', () => {
  write(call('valid'));
  const early = earlyQuestions();
  early.emit('invalid', { questions: [] });
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('Unsupported native');
});

test('an error result for an early question stays failed and partial transcript records stay visible', () => {
  write({ type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'early', is_error: true }] } });
  const early = earlyQuestions();
  early.emit('early');
  fs.appendFileSync(file, '{"type":"user"');
  const state = readPlanSkillQuestions(config, sessionId, early.source);
  expect(state.calls[0].result).toBe('error');
  expect(state.pendingBytes).toBeGreaterThan(0);
});

test('owned calls retain distinct IDs, all question tabs, and exact matching results', () => {
  write(call('first', [question, { ...question, question: 'D2 — Which next step?' }]), call('second'),
    { type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first', content: 'Answer accepted' }] } });
  const state = readPlanSkillQuestions(config, sessionId);
  expect(state.calls.map(c => [c.id, c.result, c.questions.length])).toEqual([['first', 'answered', 2], ['second', 'pending', 1]]);
});
test('foreign, sidechain, previews and unfinished calls are not native prompts', () => {
  write({ ...call('foreign'), sessionId: '00000000-0000-4000-8000-000000000002' }, { ...call('side'), isSidechain: true },
    { ...call('unfinished'), message: { ...call('unfinished').message, stop_reason: null } },
    { type: 'assistant', sessionId, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { content: JSON.stringify(call('preview')) } }] } });
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([]);
  fs.appendFileSync(file, '{"type":"assistant"');
  expect(readPlanSkillQuestions(config, sessionId).pendingBytes).toBeGreaterThan(0);
});
test('errors and malformed native input never become successful acknowledgements', () => {
  write(call('failed'), { type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'failed', is_error: true }] } });
  expect(readPlanSkillQuestions(config, sessionId).calls[0].result).toBe('error');
  write(call('bad', []));
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('Unsupported native');
  expect(() => readPlanSkillQuestions(null, sessionId)).toThrow('owned hermetic');
});
test('a native box heading tolerates wrapped/repainted body and below-viewport choices', () => {
  const visible = stripAnsi('☐ Approach\nD1 — Which\x1b[2Capproach?\nMak it reliable. Enforce the delivery policy.\n❯1.Extend dispatcher\n2.Queue fanout\n');
  expect(matchesNativeQuestion(question, visible, parseNumberedOptions(visible))).toBe(true);
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([]);
});
test('a stale menu with identical options cannot match a new question or nearby report preview', () => {
  const wrong = 'D1 — Which approach?\n☐ Approach\nD2 — Which next step?\n❯1.Extend dispatcher\n2.Queue fanout\n';
  expect(matchesNativeQuestion(question, wrong, parseNumberedOptions(wrong))).toBe(false);
  const differentOptions = '☐ Approach\nD1 — Which approach?\n❯1.Delete data\n2.Keep data\n';
  expect(matchesNativeQuestion(question, differentOptions, parseNumberedOptions(differentOptions))).toBe(false);
  const sibling = { ...question, question: 'D1 — Which approach?\nA different delivery policy.' };
  const sameHeading = '☐ Approach\n' + sibling.question + '\n❯1.Extend dispatcher\n2.Queue fanout\n';
  expect(matchesNativeQuestion(question, sameHeading, parseNumberedOptions(sameHeading), [sibling])).toBe(false);
});
test('a final submit needs the native confirmation text, not an ordinary option or report', () => {
  expect(isNativeQuestionSubmitVisible('Review your answers\nReady to submit your answers?\nSubmit answers')).toBe(true);
  expect(isNativeQuestionSubmitVisible('Submit answers in the report')).toBe(false);
  expect(isNativeQuestionSubmitVisible('Ready to submit your answers?\nYou have not answered all questions\nSubmit answers')).toBe(false);
});
test('permission binding rejects command prefixes and matching paths in another tool kind', () => {
  const bash = { id: 'new', name: 'Bash', input: { command: 'git status' } };
  expect(() => nativePermissionKey(bash, 'Bash command git status --porcelain requires permission')).toThrow('cannot be bound');
  expect(nativePermissionKey(bash, 'Bash command git status requires permission')).toBe('Bash:git status');
  expect(nativePermissionKey(bash, 'Bash command `git status` requires permission to run.')).toBe('Bash:git status');
  expect(nativePermissionKey({ id: 'edit', name: 'Edit', input: { file_path: '~/.gstack/config.yaml' } }, 'Edit to ~/.gstack/config.yaml\nDo you want to proceed?\n❯1.Yes\n2.Yes, allow all edits')).toBe('Edit:~/.gstack/config.yaml');
  expect(() => nativePermissionKey({ id: 'read', name: 'Read', input: { file_path: '/project/README.md' } }, 'Bash command cat /project/README.md requires permission')).toThrow('cannot be bound');
});

const createDialog = (target: string) => `Do you want to create ${target}?\n❯1.Yes\n2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel · Tab to amend`;

test('current create-file permission controls are recognized without treating an ordinary decision as permission', () => {
  // Exact controls retained from the CEO finding-count timeout. Its clipped
  // basename is evidence for classification only, never path authorization.
  expect(isPermissionDialogVisible(createDialog('gstck-test-plan-co.md').replace('Do you', 'Doyou'))).toBe(true);
  expect(isPermissionDialogVisible('Do you want to create plan.md?\n❯1.Yes\n2.No')).toBe(false);
  expect(isPermissionDialogVisible(createDialog('plan.md').replace('auto-approve file edits and common file commands', 'review the recommendation'))).toBe(false);
});

test('current file permissions resolve the exact displayed relative path against the owned native cwd', () => {
  const cwd = path.join(config, 'project');
  const filePath = path.join(cwd, 'plan.md');
  write({ type: 'assistant', sessionId, cwd, message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: filePath, content: 'Plan' } }] } });
  const owner = readPlanSkillQuestions(config, sessionId).permissionTools[0]!;
  expect(nativePermissionKey(owner, createDialog('plan.md'))).toBe(`Write:${filePath}`);
  expect(nativePermissionKey(owner, createDialog(filePath))).toBe(`Write:${filePath}`);
  expect(() => nativePermissionKey({ ...owner, cwd: path.join(config, 'different') }, createDialog('plan.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: undefined }, createDialog('plan.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, name: 'Read' }, createDialog(filePath))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, createDialog('pln.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, `${createDialog(filePath)}\n${createDialog('other.md')}`)).toThrow('cannot be bound');
});

// Sanitized retained native frame: preceding assistant prose omitted; modal rows unchanged.
const wrappedPreviewFixture = {
  "questions": [
    {
      "header": "Approach",
      "multiSelect": false,
      "options": [
        {
          "description": "PreToolUse hook captures AUQ before transcript write; transcript confirms result status. Race-proof, injection-hardened, tests the real rendering path. Completeness: 9/10.",
          "label": "B: Hook + transcript (current approach) (recommended)",
          "preview": "APPROACH B: Hook + transcript cross-reference\n  Captures: early events (hook) + result status (transcript)\n  Race-proof: yes — hook fires synchronously before tool result\n  Injection-safe: nonce + scope + FIFO rejection + path validation\n  Tests real rendering path: yes\n  Completeness: 9/10"
        },
        {
          "description": "Poll readOwnedClaudeTranscript until question appears. Simpler but flaky under CI load. Completeness: 5/10.",
          "label": "A: Transcript-only with retry",
          "preview": "APPROACH A: Transcript-only with retry\n  Captures: result status only (not pre-transcript events)\n  Race-proof: no — timing depends on CI load\n  Flaky risk: high\n  Completeness: 5/10"
        },
        {
          "description": "Replace AUQ at the harness level with canned answers. Avoids timing entirely but misses rendering bugs. Completeness: 6/10.",
          "label": "C: Question injection/mock",
          "preview": "APPROACH C: Question injection\n  Captures: nothing real — bypasses AUQ entirely\n  Race-proof: yes (trivially)\n  Tests real rendering: no\n  Completeness: 6/10"
        }
      ],
      "question": "D1 — Which implementation approach does this branch use, and do you want to proceed with it?"
    },
    {
      "header": "Review mode",
      "multiSelect": false,
      "options": [
        {
          "description": "This is test infrastructure — make it bulletproof. Catch failure modes, edge cases, security assumptions. No expansions surfaced. Right for infra/fix work.",
          "label": "HOLD SCOPE (recommended)",
          "preview": "HOLD SCOPE\n  Focus: correctness, security, edge cases\n  Expansions: none surfaced\n  Right for: bug fixes, infra improvements"
        },
        {
          "description": "Hold the current scope as baseline, but surface cherry-pick opportunities: extend to other skills, auto-answer hints, better error messages when unanswered.",
          "label": "SELECTIVE EXPANSION",
          "preview": "SELECTIVE EXPANSION\n  Focus: correctness + cherry-pick opportunities\n  Expansions: each presented individually\n  Right for: solid work that might have natural adjacent wins"
        },
        {
          "description": "Dream big — what would a 10x eval system look like? Rethink the whole approach. Right if you want to question premises, not just validate them.",
          "label": "SCOPE EXPANSION",
          "preview": "SCOPE EXPANSION\n  Focus: ambitious re-imagining\n  Expansions: enthusiastically recommended\n  Right for: early-stage or uncertain direction"
        }
      ],
      "question": "D2 — Which review mode?"
    }
  ],
  "visible": [
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "←  ☐ Approach  ☐ Review mode  ✔ Submit  →",
    "",
    "│ D1 — Which implementation approach does this branch use, and do you want to proceed with it?",
    "",
    "❯ 1. B: Hook + transcript         ┌────────────────────────────────────────────────────────────────────┐",
    "    (current approach)            │ APPROACH B: Hook + transcript cross-reference                      │",
    "    (recommended)                 │   Captures: early events (hook) + result status (transcript)       │",
    "  2. A: Transcript-only with      │   Race-proof: yes — hook fires synchronously before tool result    │",
    "    retry                         │   Injection-safe: nonce + scope + FIFO rejection + path validation │",
    "  3. C: Question                  │   Tests real rendering path: yes                                   │",
    "    injection/mock                │   Completeness: 9/10                                               │",
    "                                  └────────────────────────────────────────────────────────────────────┘",
    "",
    "                                  Notes: press n to add notes",
    "                                                                                ",
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
  ].join("\n")
};
const wrappedQuestion = wrappedPreviewFixture.questions[0]!;
const wrappedModeQuestion = wrappedPreviewFixture.questions[1]!;
const matchesWrapped = (visible: string, offered: NativeQuestion = wrappedQuestion) =>
  matchesNativeQuestion(offered, visible, parseNumberedOptions(visible), wrappedPreviewFixture.questions);

test('the retained preview menu corroborates physical label continuations', () => {
  expect(matchesWrapped(wrappedPreviewFixture.visible)).toBe(true);
  expect(matchesWrapped(wrappedPreviewFixture.visible, wrappedModeQuestion)).toBe(false);
});

test('plain wrapped menus retain the existing parser behavior', () => {
  const visible = '☐ Approach\n' + wrappedQuestion.question + '\n❯ 1. B: Hook + transcript\n    (current approach)\n    (recommended)\n  2. A: Transcript-only with\n    retry\n';
  expect(matchesWrapped(visible)).toBe(false);
});

test('two complete native labels still corroborate when the last visible choice is clipped', () => {
  const visible = '☐ Approach\n' + wrappedQuestion.question + '\n❯ 1. B: Hook + transcript (current approach) (recommended)\n  2. A: Transcript-only with retry\n  3. C: Question';
  expect(matchesWrapped(visible)).toBe(true);
  expect(matchesWrapped(visible + '\n\n')).toBe(true);
});

test('a complete preview frame permits a valid clipped final label but rejects a changed prefix', () => {
  const visible = wrappedPreviewFixture.visible.replace('    injection/mock', ' '.repeat('    injection/mock'.length));
  expect(matchesWrapped(visible)).toBe(true);
  expect(matchesWrapped(visible.replace('C: Question', 'C: Changed!'))).toBe(false);
});

test('preview text cannot supply missing or changed left-column labels', () => {
  const preview = wrappedPreviewFixture.visible.replace(/│ APPROACH B:[^\n]*│/, `│ ${wrappedQuestion.options[0]!.label.padEnd(66)} │`);
  const missing = preview.replace('    (current approach)', ' '.repeat('    (current approach)'.length));
  expect(matchesWrapped(missing)).toBe(false);
  const changed = preview.replace('B: Hook + transcript', 'B: Different choice'.padEnd('B: Hook + transcript'.length));
  expect(matchesWrapped(changed)).toBe(false);
});

test('preview text containing a cursor cannot become the active option list', () => {
  const decoy = '❯ 1. ' + wrappedQuestion.options[0]!.label;
  const visible = wrappedPreviewFixture.visible.replace(/│ APPROACH B:[^\n]*│/, `│ ${decoy.padEnd(66)} │`);
  expect(matchesWrapped(visible)).toBe(true);
  expect(matchesWrapped(visible.replace('A: Transcript-only with', 'A: Unrelated choice'.padEnd('A: Transcript-only with'.length)))).toBe(false);
});

test('physical label continuation cannot jump a blank row or a menu boundary', () => {
  const visible = wrappedPreviewFixture.visible.replace('    (current approach)', ' '.repeat('    (current approach)'.length));
  expect(matchesWrapped(visible)).toBe(false);
  const decoy = wrappedPreviewFixture.visible.replace('    (current approach)', '    ──────────────────');
  expect(matchesWrapped(decoy)).toBe(false);
});

test('malformed preview borders and duplicate numbered rows remain refused', () => {
  expect(matchesWrapped(wrappedPreviewFixture.visible.replace('└', ' '))).toBe(false);
  expect(matchesWrapped(wrappedPreviewFixture.visible.replace('┐', ' '))).toBe(false);
  expect(matchesWrapped(wrappedPreviewFixture.visible.replace('  2. A:', '  1. A:'))).toBe(false);
});

test('a stale wrapped menu cannot corroborate the following current question', () => {
  const stale = wrappedPreviewFixture.visible + '\n☐ Another question\nD3 — Pick a different action?\n❯ 1. B: Hook + transcript (current approach) (recommended)\n  2. A: Transcript-only with retry\n';
  expect(matchesWrapped(stale)).toBe(false);
});

test('a later inline menu supersedes an older physical preview menu', () => {
  const current: NativeQuestion = { question: 'D3 — Pick a different action?', header: 'Another question', multiSelect: false,
    options: ['Keep current files', 'Inspect evidence'].map(label => ({ label, description: label })) };
  const visible = wrappedPreviewFixture.visible + '\n☐ Another question\nD3 — Pick a different action? ❯1. Keep current files 2. Inspect evidence\n';
  expect(matchesWrapped(visible)).toBe(false);
  expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible), [wrappedQuestion])).toBe(true);
});

test('an inline list beginning at the physical line start retains stream parsing', () => {
  const current: NativeQuestion = { question: 'Which?', header: 'Mode', multiSelect: false,
    options: ['Hold', 'Expand'].map(label => ({ label, description: label })) };
  for (const menu of ['❯1. Hold 2. Expand', '❯1.Hold2.Expand']) {
    const visible = '☐ Mode\nWhich?\n' + menu;
    expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible))).toBe(true);
  }
});

test('plain option glyphs do not create a side-preview frame', () => {
  for (const label of ['Keep │ pipes', 'Render ┌ corners', 'Render ┐ corners', 'Draw ┌──┐', 'Draw  ┌──┐']) {
    const current: NativeQuestion = { question: 'Which?', header: 'Mode', multiSelect: false,
      options: [label, 'Another choice'].map(label => ({ label, description: label })) };
    const visible = '☐ Mode\nWhich?\n❯1. ' + label + '\n  2. Another choice\n';
    expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible))).toBe(true);
  }
});

test('missing preview corners cannot promote right-column decoy labels', () => {
  const current: NativeQuestion = { question: 'Which?', header: 'Mode', multiSelect: false,
    options: ['Hold', 'Expand'].map(label => ({ label, description: label })) };
  const border = '┌' + '─'.repeat(28) + '┐';
  for (const top of [border, border.replace('┌', ' '), border.replace('┐', ' '), border.replace(/[┌┐]/g, ' ')]) {
    const visible = '☐ Mode\nWhich?\n' + '❯1. Wrong'.padEnd(24) + top + '\n'
      + '  2. Also wrong'.padEnd(24) + '│ ' + '❯1. Hold 2. Expand'.padEnd(26) + ' │\n'
      + ' '.repeat(24) + '└' + '─'.repeat(28) + '┘';
    expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible))).toBe(false);
  }
});
