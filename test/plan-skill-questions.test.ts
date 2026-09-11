import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanSkillQuestions, matchesNativeQuestion, nativeQuestionSelection, isNativeQuestionSubmitVisible, currentFilePermissionTarget, nativePermissionKey, reserveNativePermissionGrant, type NativeQuestion, type NativePermissionGrant } from './helpers/plan-skill-questions';
import { isPermissionDialogVisible, parseNumberedOptions, stripAnsi } from './helpers/claude-pty-runner';
import { setupQuestionEventSource, readPermissionRequestEvents } from './helpers/plan-skill-question-events';

const sessionId = '00000000-0000-4000-8000-000000000001';
const question: NativeQuestion = { question: 'D1 — Which approach?\nMake it reliable. Enforce the delivery policy.', header: 'Approach', multiSelect: false,
  options: ['Extend dispatcher', 'Queue fanout', 'Minimal patch', 'Hold scope'].map(label => ({ label, description: label })) };
let config: string;
let file: string;
const call = (id: string, questions = [question]) => ({ type: 'assistant', sessionId, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const write = (...rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
beforeEach(() => { config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-question-'))); file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true }); });
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

function earlyQuestions() {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  return { source, emit(id: string, input: unknown = { questions: [question] }, toolName = 'AskUserQuestion') {
    const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: file, cwd: config,
      tool_name: toolName, tool_use_id: id, tool_input: input,
    })), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.length).toBe(0);
  } };
}

function filePermissionRequest(input = { file_path: path.join(config, 'plan.md'), content: 'Final report' }) {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
    hook_event_name: 'PermissionRequest', session_id: sessionId, transcript_path: file, cwd: config,
    tool_name: 'Write', tool_input: input,
  })), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.length).toBe(0);
  const [event] = readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file });
  return { source, event: event!, input };
}
const nativeWrite = (id: string, input: unknown, cwd = config, name = 'Write', stop_reason: string | null = 'tool_use') => ({
  type: 'assistant', sessionId, cwd, message: { role: 'assistant', stop_reason, content: [{ type: 'tool_use', id, name, input }] },
});
const nativeWriteResult = (id: string, timestamp?: string, is_error = false) => ({
  type: 'user', sessionId, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'Done' }] },
});

// Normalized execution input: preserve injected plan fields and every extra key.
const exitInput = () => ({ plan: '# Plan\n## GSTACK REVIEW REPORT\n日本語', planFilePath: path.join(config, 'plan.md'),
  allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }], custom: { exact: true } });

test.each([null, 'tool_use'])('early ExitPlanMode coalesces exact %s native input without AUQ or file authority', stopReason => {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Review' } });
  const early = earlyQuestions(), input = exitInput();
  early.emit('early-exit', input, 'ExitPlanMode');
  const initial = readPlanSkillQuestions(config, sessionId, early.source);
  expect(initial.ready).toBe(true);
  expect(initial.pendingExitPlanModeIds).toEqual(['early-exit']);
  expect(initial.calls).toEqual([]); expect(initial.permissionTools).toEqual([]);
  expect(initial.permissionRequests).toEqual([]); expect(initial.permissionResults).toEqual([]);
  write(nativeWrite('early-exit', input, config, 'ExitPlanMode', stopReason));
  expect(readPlanSkillQuestions(config, sessionId, early.source)).toEqual(initial);
  if (stopReason === null) expect(readPlanSkillQuestions(config, sessionId).ready).toBe(false);
});

test.each([false, true])('early ExitPlanMode retires on an owned result including preexisting/error=%s', isError => {
  const early = earlyQuestions(), input = exitInput();
  write(nativeWriteResult('early-exit', undefined, isError));
  early.emit('early-exit', input, 'ExitPlanMode');
  for (let repeat = 0; repeat < 2; repeat++) {
    early.emit('early-exit', input, 'ExitPlanMode');
    const state = readPlanSkillQuestions(config, sessionId, early.source);
    expect(state.ready).toBe(false); expect(state.pendingExitPlanModeIds).toEqual([]);
    expect(state.calls).toEqual([]); expect(state.permissionResults).toEqual([]);
  }
});

test.each(['foreign', 'sidechain', 'child', 'wrong-id'])('early ExitPlanMode ignores a %s native result', variant => {
  const early = earlyQuestions(), input = exitInput();
  const result: any = nativeWriteResult(variant === 'wrong-id' ? 'other-exit' : 'early-exit');
  if (variant === 'foreign') result.sessionId = '00000000-0000-4000-8000-000000000002';
  if (variant === 'sidechain') result.isSidechain = true;
  if (variant === 'child') result.parent_tool_use_id = 'parent';
  write(result); early.emit('early-exit', input, 'ExitPlanMode');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(true);
  fs.appendFileSync(file, JSON.stringify(nativeWriteResult('early-exit')) + '\n');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(false);
});

test.each(['plan', 'path', 'extra', 'nested-schema-extra', 'cwd', 'AskUserQuestion', 'Write', 'Edit', 'Bash'])('early ExitPlanMode rejects unfinished same-ID %s conflicts', variant => {
  write(); const early = earlyQuestions(), input = exitInput();
  early.emit('early-exit', input, 'ExitPlanMode');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(true);
  const changed = structuredClone(input);
  if (variant === 'plan') changed.plan += '\nChanged';
  if (variant === 'path') changed.planFilePath += '.other';
  if (variant === 'extra') changed.custom.exact = false;
  // Deprecated nested keys stripped by CLI schema are conservatively rejected.
  if (variant === 'nested-schema-extra') (changed.allowedPrompts[0] as any).extra = 'not in execution input';
  const name = ['AskUserQuestion', 'Write', 'Edit', 'Bash'].includes(variant) ? variant : 'ExitPlanMode';
  write(nativeWrite('early-exit', changed, variant === 'cwd' ? path.dirname(config) : config, name, null));
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

test('early ExitPlanMode keeps missing transcript, partial bytes and owner changes observable', () => {
  const early = earlyQuestions(), input = exitInput();
  early.emit('exit-one', input, 'ExitPlanMode');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(false);
  write(); const first = readPlanSkillQuestions(config, sessionId, early.source);
  expect(first.ready).toBe(true);
  fs.appendFileSync(file, '{"type":');
  expect(readPlanSkillQuestions(config, sessionId, early.source).pendingBytes).toBeGreaterThan(0);
  write(nativeWriteResult('exit-one'));
  early.emit('exit-two', input, 'ExitPlanMode');
  const second = readPlanSkillQuestions(config, sessionId, early.source);
  expect(second.ready).toBe(true); expect(second.pendingExitPlanModeIds).toEqual(['exit-two']);
  expect(second).not.toEqual(first);
});

test('permission request identity remains separate until an exact later native result completes it', () => {
  write();
  const { source, event, input } = filePermissionRequest();
  const pending = readPlanSkillQuestions(config, sessionId, source);
  expect(pending.permissionTools).toEqual([]);
  expect(pending.permissionRequests).toEqual([{ requestId: event.requestId, capturedAtMs: event.capturedAtMs,
    name: 'Write', cwd: config, input, result: 'pending' }]);
  write(nativeWrite('real-write', input));
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0]).toMatchObject({ result: 'pending', nativeToolId: 'real-write' });
  write(nativeWrite('real-write', input), nativeWriteResult('real-write', new Date(event.capturedAtMs + 1).toISOString()));
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0]).toMatchObject({ requestId: event.requestId, result: 'completed', nativeToolId: 'real-write' });
});

test.each(['old', 'equal', 'invalid', 'missing', 'foreign'])('a %s native result cannot acknowledge a newly captured file request', variant => {
  write();
  const { source, event, input } = filePermissionRequest();
  const time = variant === 'missing' ? undefined : variant === 'invalid' ? 'not-a-date'
    : new Date(event.capturedAtMs + (variant === 'old' ? -1 : variant === 'equal' ? 0 : 1)).toISOString();
  const result = nativeWriteResult('old-write', time);
  if (variant === 'foreign') result.sessionId = '00000000-0000-4000-8000-000000000002';
  write(nativeWrite('old-write', input), result);
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0].result).toBe('pending');
  if (variant !== 'foreign') expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0].nativeToolId).toBeUndefined();
});

test('file request errors and ambiguous full-input matches never become successful completion', () => {
  write();
  const { source, event, input } = filePermissionRequest();
  const timestamp = new Date(event.capturedAtMs + 1).toISOString();
  write(nativeWrite('failed', input), nativeWriteResult('failed', timestamp, true));
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0]).toMatchObject({ result: 'error', nativeToolId: 'failed' });
  write(nativeWrite('first', input), nativeWriteResult('first', timestamp), nativeWrite('second', input));
  expect(() => readPlanSkillQuestions(config, sessionId, source)).toThrow('Indistinguishable');
});

test.each(['content', 'cwd', 'name', 'unfinished'])('late native file %s disagreement refuses the permission request', variant => {
  write();
  const { source, input } = filePermissionRequest();
  write(nativeWrite('changed', variant === 'content' || variant === 'unfinished' ? { ...input, content: 'Changed after permission' } : input,
    variant === 'cwd' ? path.dirname(config) : config, variant === 'name' ? 'Edit' : 'Write', variant === 'unfinished' ? null : 'tool_use'));
  expect(() => readPlanSkillQuestions(config, sessionId, source)).toThrow('changed input');
});

test('a reused real native tool ID cannot change file input or become an AskUserQuestion', () => {
  const input = { file_path: path.join(config, 'plan.md'), content: 'Initial' };
  write(nativeWrite('same', input), nativeWrite('same', { ...input, content: 'Changed' }));
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('changed input');
  write(nativeWrite('same', input), call('same'));
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('changed input');
});

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
test('overflow rejection identifies the native call and option count without disclosing content', () => {
  const privateText = 'private-question-label-description';
  const overflow = { ...question, question: privateText, header: privateText,
    options: Array.from({ length: 5 }, () => ({ label: privateText, description: privateText })) };
  write(call('overflow-call', [overflow]));
  let message = '';
  try { readPlanSkillQuestions(config, sessionId); } catch (error) { message = (error as Error).message; }
  expect(message).toStartWith('Unsupported native AskUserQuestion input shape: toolId="overflow-call"');
  const shape = JSON.parse(message.split(' shape=')[1]);
  expect(shape).toMatchObject({ questionsType: 'array', questionCount: 1, questionsTruncated: false });
  expect(shape.questions[0]).toMatchObject({ optionCount: 5, optionsTruncated: true,
    questionType: 'string', questionNonempty: true, headerType: 'string', headerNonempty: true });
  expect(shape.questions[0].options).toHaveLength(4);
  expect(message).not.toContain(privateText);

  write(call('long-id-'.repeat(100), Array.from({ length: 50 }, () => ({ ...overflow,
    options: Array.from({ length: 50 }, () => overflow.options[0]) }))));
  try { readPlanSkillQuestions(config, sessionId); } catch (error) { message = (error as Error).message; }
  const bounded = JSON.parse(message.split(' shape=')[1]);
  expect(bounded).toMatchObject({ questionCount: 50, questionsTruncated: true });
  expect(bounded.questions).toHaveLength(4);
  expect(bounded.questions.every((q: any) => q.optionCount === 50 && q.options.length === 4)).toBe(true);
  expect(message).toContain(' (truncated) shape=');
  expect(message.length).toBeLessThan(4_000);
  expect(message).not.toContain(privateText);
});
test('missing required option fields remain rejected with types after native defaults apply', () => {
  const { multiSelect, ...defaulted } = question;
  const { description, ...missingDescription } = question.options[0];
  write(call('missing-description', [{ ...defaulted,
    options: [missingDescription, question.options[1]] } as NativeQuestion]));
  let message = '';
  try { readPlanSkillQuestions(config, sessionId); } catch (error) { message = (error as Error).message; }
  expect(message).toStartWith('Unsupported native AskUserQuestion input shape: toolId="missing-description"');
  const shape = JSON.parse(message.split(' shape=')[1]);
  expect(shape.questions[0]).toMatchObject({ multiSelectType: 'boolean', optionCount: 2 });
  expect(shape.questions[0].options[0]).toEqual({ type: 'object', labelType: 'string',
    labelNonempty: true, descriptionType: 'undefined' });
  expect(message).not.toContain(question.question);
  expect(message).not.toContain(missingDescription.label);
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

// Pinned Claude 2.1.263: Mo uses basename in its question, Se uses the
// cwd-relative subtitle, and gs/Gz render title then subtitle above the diff.
const nestedFileDialog = (operation: 'create' | 'edit' | 'overwrite', subtitle: string, basename = path.basename(subtitle)) =>
  '─'.repeat(120) + '\n ' + ({ create: 'Create', edit: 'Edit', overwrite: 'Overwrite' }[operation]) + ' file\n ' + subtitle +
  '\n' + '╌'.repeat(120) + '\n  1 Plan content\n' + '╌'.repeat(120) + '\n ' +
  createDialog(basename).replace('create', operation === 'edit' ? 'make this edit to' : operation);

// Exact option-2 wrapping from the owned Claude 2.1.263 fake-Write capture.
// It advertises a directory grant; the driver still reserves only option 1.
const directoryFileDialog = (operation: 'create' | 'edit' | 'overwrite', subtitle: string, directory: string) =>
  nestedFileDialog(operation, subtitle).replace('for this session (shift+tab)',
    `for this session; Yes, and\n      always allow access to\n      ${directory}\n      for this session (shift+tab)`);

test.each(['create', 'edit', 'overwrite'] as const)('extended %s menu binds the complete header and exact owned parent directory', operation => {
  const filePath = path.join(path.dirname(config), 'private state', 'ceo-plans', 'plan.md');
  const owner = { id: 'file', name: operation === 'edit' ? 'Edit' : 'Write', cwd: config, input: { file_path: filePath } };
  for (const subtitle of [path.relative(config, filePath), filePath]) {
    const dialog = directoryFileDialog(operation, subtitle, path.dirname(filePath));
    expect(currentFilePermissionTarget(dialog)).toEqual({ operation, filePath: subtitle });
    expect(nativePermissionKey(owner, dialog)).toBe(`${owner.name}:${filePath}`);
    expect(nativePermissionKey(owner, dialog.replace(/\n      /g, ' '))).toBe(`${owner.name}:${filePath}`);
    expect(nativePermissionKey(owner, dialog.slice(dialog.indexOf('╌')))).toBe(`${owner.name}:${filePath}`);
  }
});

// Full current-screen capture from the one-Write 120-column CLI diagnostic.
// The selected option is 1; the compound option 2 is never granted here.
test('retained complete outside-directory menu binds its exact native Write', () => {
  const frame = "\n ▐▛███▛█   Claude Code v2.1.263\n▝▜██████▀  Fable 5.1 · API Usage Billing\n  ▝▝ ▝▝    /tmp/gstack-hermetic-3734902-j94Svq/gstack-e2e-plan-ceo-paired-KdquY1\n\n\n❯ Use the Write tool exactly once to create \"/tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstac\n  k-e2e-plan-ceo-paired-KdquY1/ceo-plans/2026-09-09-payment-test-coverage.md\" with exactly this content: \"# Fake CEO\n  plan\\nDiagnostic marker: 6ef6a97d-8eb6-4cae-87df-357ca47565ad\\nNo real project data.\\n\". This is a private\n  permission-dialog diagnostic. Do not use Bash, run a review, or create any other file.\n\n● Creating the diagnostic file now.\n\n● Write(/tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstac…/2026-09-09-payment-test-coverage.md)\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n Create file\n ../permission-state-ZmakWx/projects/gstack-e2e-plan-ceo-paired-KdquY1/ceo-plans/2026-09-09-payment-test-coverage.md\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n  1 # Fake CEO plan\n  2 Diagnostic marker: 6ef6a97d-8eb6-4cae-87df-357ca47565ad\n  3 No real project data.\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create 2026-09-09-payment-test-coverage.md?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; Yes, and\n      always allow access to\n      /tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstack-e2e-plan-ceo-paired-KdquY1/ceo-plans\n      for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend\n                                                                                                     \n\n\n                                                                                                      \n\n\n\n";
  const tool = {
  "id": "toolu_015EevmuskBCGKqz88djcKnM",
  "name": "Write",
  "input": {
    "file_path": "/tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstack-e2e-plan-ceo-paired-KdquY1/ceo-plans/2026-09-09-payment-test-coverage.md",
    "content": "# Fake CEO plan\nDiagnostic marker: 6ef6a97d-8eb6-4cae-87df-357ca47565ad\nNo real project data.\n"
  },
  "cwd": "/tmp/gstack-hermetic-3734902-j94Svq/gstack-e2e-plan-ceo-paired-KdquY1"
};
  expect(currentFilePermissionTarget(frame)).toEqual({ operation: 'create',
    filePath: path.relative(tool.cwd, tool.input.file_path) });
  expect(nativePermissionKey(tool, frame)).toBe('Write:' + tool.input.file_path);
  expect(() => nativePermissionKey({ ...tool, input: { ...tool.input, file_path: tool.input.file_path + '.other' } }, frame)).toThrow();
  expect(() => nativePermissionKey(tool, frame.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes,', ' ❯ 2. Yes,'))).toThrow();
});

test('extended menu refuses mismatched, clipped, wrapped, relative or malformed directory identity', () => {
  const filePath = path.join(path.dirname(config), 'private state', 'ceo-plans', 'plan.md');
  const directory = path.dirname(filePath);
  const owner = { id: 'file', name: 'Write', cwd: config, input: { file_path: filePath } };
  const dialog = directoryFileDialog('create', path.relative(config, filePath), directory);
  for (const invalid of [
    directoryFileDialog('create', path.relative(config, filePath), path.dirname(directory)),
    directoryFileDialog('create', path.relative(config, filePath), directory + '-other'),
    directoryFileDialog('create', path.relative(config, filePath), path.relative(config, directory)),
    directoryFileDialog('create', path.relative(config, filePath), directory.replace('private state', 'privatestate')),
    dialog.replace(directory, directory.replace('ceo-plans', 'ceo-\n      plans')),
    dialog.replace(directory, directory.replace('ceo-plans', '…/ceo-plans')),
    dialog.replace(directory, directory + '\t'),
    dialog.replace('always allow access to', 'always allow access everywhere including'),
    dialog.replace('3.No', '3.Yes\n4.No'),
    dialog.replace(' Do you want to create plan.md?', ' Do you want to create other.md?'),
    dialog.slice(dialog.indexOf('╌')).replace(directory, ''),
  ]) expect(() => nativePermissionKey(owner, invalid)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, name: 'Edit' }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: undefined }, dialog)).toThrow('cannot be bound');
});

test('extended menu reserves the hook-owned Write once and keeps multiple writable owners ambiguous', () => {
  const input = { file_path: path.join(path.dirname(config), 'private-state', 'ceo-plans', 'plan.md'), content: 'Fake plan' };
  write(nativeWrite('owned-write', input));
  const { source, event } = filePermissionRequest(input);
  const native = readPlanSkillQuestions(config, sessionId, source);
  const dialog = directoryFileDialog('create', path.relative(config, input.file_path), path.dirname(input.file_path));
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, dialog, granted, requests)).toBe(false);
  expect([...granted]).toEqual([`request:${event.requestId}`]);
  expect([...requests.keys()]).toEqual([`Write:${input.file_path}`]);
  native.permissionTools.push({ id: 'other-read', name: 'Read', cwd: config, input: { file_path: path.join(config, 'README.md') } });
  expect(reserveNativePermissionGrant(native, dialog, new Set(), new Map())).toBe(true);
  native.permissionRequests.push({ ...native.permissionRequests[0]!, requestId: 'other-write', nativeToolId: undefined });
  const refused = new Set<string>();
  expect(() => reserveNativePermissionGrant(native, dialog, refused, new Map())).toThrow('Ambiguous');
  expect(refused.size).toBe(0);
});

test.each(['create', 'edit', 'overwrite'] as const)('current %s title and subtitle bind a nested basename to its owned file', operation => {
  const relative = path.join('.gstack', 'projects', 'fixture', 'restore.md');
  const filePath = path.join(config, relative);
  const owner = { id: 'file', name: operation === 'edit' ? 'Edit' : 'Write', cwd: config, input: { file_path: filePath } };
  const dialog = nestedFileDialog(operation, relative);
  expect(currentFilePermissionTarget(dialog)).toEqual({ operation, filePath: relative });
  expect(nativePermissionKey(owner, dialog)).toBe(`${owner.name}:${filePath}`);
  expect(nativePermissionKey(owner, dialog.replace('Plan content', 'Example ❯ 1. text'))).toBe(`${owner.name}:${filePath}`);
  expect(() => nativePermissionKey({ ...owner, input: { file_path: path.join(config, 'other', 'restore.md') } }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: undefined }, dialog)).toThrow('cannot be bound');
});

test('nested file binding refuses clipped, conflicting, quoted or ambiguous header evidence', () => {
  const relative = '.gstack/projects/fixture/restore.md';
  const owner = { id: 'file', name: 'Write', cwd: config, input: { file_path: path.join(config, relative) } };
  const dialog = nestedFileDialog('create', relative);
  for (const invalid of [
    createDialog('restore.md'), // basename alone still resolves only at cwd
    dialog.slice(dialog.indexOf('╌')),
    dialog.replace(relative, '…/fixture/restore.md'),
    dialog.replace(relative, '.gstack/projects/other/restore.md'),
    dialog.replace(relative, '.gstack/projects/fixture/other.md'),
    dialog.replace('Create file', 'Edit file'),
    dialog.replace(' Create file', '  1 Create file'),
    dialog.replace(' Create file', '> Create file'),
    dialog.replace('─'.repeat(120), 'quoted header'),
    nestedFileDialog('create', relative) + '\n' + createDialog('restore.md'),
    dialog.replace('\n ' + relative, '\n ' + relative + '\n Create file\n ' + relative),
  ]) expect(() => nativePermissionKey(owner, invalid)).toThrow('cannot be bound');
});

// A current terminal viewport can start at the title, with its leading rule
// scrolled away; the full rule below its subtitle still bounds the same card.
// Native display padding is not part of the owned filesystem path.
function renderedPermissionCard(variant: string, subtitle = 'plan.md') {
  let frame = nestedFileDialog('edit', subtitle);
  if (variant !== 'padding') frame = frame.slice(frame.indexOf('\n') + 1);
  if (variant !== 'clipped-rule') frame = frame.replace('\n ' + subtitle + '\n', '\n ' + subtitle + '   \n');
  return frame;
}

test.each(['clipped-rule', 'padding', 'both'])('current permission card supports native %s with one exact owned grant', variant => {
  const s = earlyFileCompletion(); s.complete(); s.emit('PermissionRequest', s.nextInput);
  const frame = renderedPermissionCard(variant), native = s.read();
  expect(currentFilePermissionTarget(frame)).toEqual({ operation: 'edit', filePath: 'plan.md' });
  expect(reserveNativePermissionGrant(native, frame, s.granted, s.requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, frame, s.granted, s.requests)).toBe(false);
  expect(s.granted.size).toBe(2);
});

test.each(['clipped-rule', 'padding', 'both'])('native %s rendering keeps exact path spaces and rejects another owned filename', variant => {
  const relative = 'notes/approved  plan.md', filePath = path.join(config, relative);
  const frame = renderedPermissionCard(variant, relative);
  const owner = { id: 'edit', name: 'Edit', cwd: config, input: { file_path: filePath } };
  expect(nativePermissionKey(owner, frame)).toBe('Edit:' + filePath);
  for (const wrong of ['notes/approved plan.md', relative + ' ', 'other/approved  plan.md']) {
    expect(() => nativePermissionKey({ ...owner, input: { file_path: path.join(config, wrong) } }, frame)).toThrow('cannot be bound');
  }
});

test.each(['quoted-prelude', 'blank-prelude', 'missing-bottom-rule', 'broken-bottom-rule', 'wrapped-subtitle', 'tab-padding',
  'unicode-padding', 'leading-padding', 'duplicate-header', 'intervening-menu', 'wider-than-rule', 'wrong-operation'])
('current permission card still refuses %s', variant => {
  let frame = renderedPermissionCard('both', 'notes/plan.md');
  if (variant === 'quoted-prelude') frame = 'Example:\n' + frame;
  if (variant === 'blank-prelude') frame = '\n' + frame;
  if (variant === 'missing-bottom-rule') frame = frame.replace('╌'.repeat(120), '');
  if (variant === 'broken-bottom-rule') frame = frame.replace('╌'.repeat(120), '╌'.repeat(119) + 'x');
  if (variant === 'wrapped-subtitle') frame = frame.replace('notes/plan.md', 'notes/\nplan.md');
  if (variant === 'tab-padding') frame = frame.replace('plan.md   \n', 'plan.md\t\n');
  if (variant === 'unicode-padding') frame = frame.replace('plan.md   \n', 'plan.md\u00a0\n');
  if (variant === 'leading-padding') frame = frame.replace('\n notes/plan.md', '\n  notes/plan.md');
  if (variant === 'duplicate-header') frame = frame.replace('  1 Plan content', ' Edit file\n notes/plan.md\n  1 Plan content');
  if (variant === 'intervening-menu') frame = frame.replace('  1 Plan content', ' ❯ 1. Prior choice\n  1 Plan content');
  if (variant === 'wider-than-rule') frame = frame.replace('╌'.repeat(120), '╌'.repeat(10));
  if (variant === 'wrong-operation') frame = frame.replace(' Edit file', ' Create file');
  expect(currentFilePermissionTarget(frame)).toBeNull();
});

test('modern native Edit wording binds its exact owned relative or absolute path', () => {
  // Claude 2.1.257 Io(Edit) + Cwo: "Do you want to make this edit to <fileName>?"
  const filePath = path.join(config, 'plan.md');
  write(nativeWrite('edit', { file_path: filePath, old_string: 'Draft', new_string: 'Final report' }, config, 'Edit'));
  const owner = readPlanSkillQuestions(config, sessionId).permissionTools[0]!;
  for (const displayed of ['plan.md', filePath]) {
    const dialog = createDialog(displayed).replace('create', 'make this edit to');
    expect(currentFilePermissionTarget(dialog)).toEqual({ operation: 'edit', filePath: displayed });
    expect(isPermissionDialogVisible(dialog)).toBe(true);
    expect(nativePermissionKey(owner, dialog)).toBe(`Edit:${filePath}`);
  }
});

test('modern native Edit wording keeps malformed and restricted menus unsupported', () => {
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  for (const malformed of [
    dialog.replace('make this edit to', 'make these edits to'),
    dialog.replace('make this edit to', 'make this edit for'),
    dialog.replace('make this edit to', 'make this edit'),
    dialog.replace('make this edit to', 'write to'),
    dialog.replace('auto-approve file edits and common file commands', 'review this plan'),
    'Do you want to make this edit to plan.md?\n❯1.Yes\n2.No',
  ]) {
    expect(currentFilePermissionTarget(malformed)).toBeNull();
    expect(isPermissionDialogVisible(malformed)).toBe(false);
  }
});

test('modern native Edit wording cannot bind a different path, cwd, tool or later menu', () => {
  const filePath = path.join(config, 'plan.md');
  const owner = { id: 'edit', name: 'Edit', cwd: config, input: { file_path: filePath, old_string: 'Draft', new_string: 'Final' } };
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  expect(() => nativePermissionKey({ ...owner, name: 'Write' }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: path.dirname(config) }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, dialog.replace('plan.md', 'other.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, `${dialog}\n${createDialog('other.md')}`)).toThrow('cannot be bound');
});

test('modern native Edit wording preserves ordinary Write create and overwrite ownership', () => {
  const filePath = path.join(config, 'plan.md');
  const owner = { id: 'write', name: 'Write', cwd: config, input: { file_path: filePath, content: 'Final report' } };
  for (const operation of ['create', 'overwrite'] as const) {
    const dialog = createDialog('plan.md').replace('create', operation);
    expect(currentFilePermissionTarget(dialog)).toEqual({ operation, filePath: 'plan.md' });
    expect(nativePermissionKey(owner, dialog)).toBe(`Write:${filePath}`);
    expect(() => nativePermissionKey({ ...owner, name: 'Edit' }, dialog)).toThrow('cannot be bound');
  }
});

test('modern native Edit wording does not regrant an indistinguishable completed Edit', () => {
  const input = { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: 'Final' };
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  const granted = new Set<string>();
  const requests = new Map<string, NativePermissionGrant>();
  write(nativeWrite('edit-first', input, config, 'Edit'));
  const first = readPlanSkillQuestions(config, sessionId);
  expect(reserveNativePermissionGrant(first, dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(first, dialog, granted, requests)).toBe(false);
  write(nativeWrite('edit-first', input, config, 'Edit'), nativeWriteResult('edit-first'), nativeWrite('edit-again', input, config, 'Edit'));
  expect(() => reserveNativePermissionGrant(readPlanSkillQuestions(config, sessionId), dialog, granted, requests)).toThrow('cannot be distinguished');
});

// The retained cfa50758 PermissionRequest appended GSTACK REVIEW REPORT by
// replacing an existing final paragraph with that paragraph plus the report.
// Reproduce that Edit shape with synthetic content and a launcher-owned hook.
async function scopedEditSequence(variant = 'native') {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const emit = (input: unknown) => {
    const previous = new Set(readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file }).map(event => event.requestId));
    const child = Bun.spawnSync(['bash', '-c', command], { timeout: 5000,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sessionId,
        transcript_path: file, cwd: config, tool_name: 'Edit', tool_input: input })), stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file })
      .find(event => !previous.has(event.requestId))!;
  };
  const old_string = '### Unresolved Decisions\n\nNone. The review choices were answered.';
  const firstInput = { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: old_string, replace_all: false };
  const nextInput = variant === 'same-input' ? firstInput : {
    file_path: path.join(config, variant === 'wrong-path' ? 'other.md' : 'plan.md'), old_string,
    new_string: old_string + '\n\n## GSTACK REVIEW REPORT\n\n| Review | Runs | Status | Findings |\n| CEO | 1 | CLEAR | Review complete |\n\n**VERDICT:** CEO CLEARED\n\nNO UNRESOLVED DECISIONS',
    replace_all: false,
  };
  const first = nativeWrite('scoped-edit-1', firstInput, config, 'Edit');
  write(first);
  const firstEvent = emit(firstInput);
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  const read = () => readPlanSkillQuestions(config, sessionId, variant === 'no-observer' ? undefined : source);
  expect(reserveNativePermissionGrant(read(), dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(read(), dialog, granted, requests)).toBe(false);
  const resultAtMs = firstEvent.capturedAtMs + (variant === 'before-result' ? 60_000 : 1);
  const rows: unknown[] = [variant === 'unfinished-prior' ? nativeWrite('scoped-edit-1', firstInput, config, 'Edit', null) : first];
  if (variant !== 'no-ack') rows.push(nativeWriteResult('scoped-edit-1', new Date(resultAtMs).toISOString(), variant === 'error'));
  if (variant !== 'early') rows.push(nativeWrite(variant === 'changed-id' ? 'scoped-edit-1' : 'scoped-edit-2', nextInput,
    variant === 'wrong-cwd' ? path.dirname(config) : config, 'Edit'));
  if (variant === 'multiple-owner') rows.push(nativeWrite('other-pending', { command: 'true' }, config, 'Bash'));
  if (variant === 'parallel-read') rows.push(nativeWrite('other-pending', { file_path: path.join(config, 'README.md') }, config, 'Read'));
  if (variant === 'parallel-tool-search') rows.push(nativeWrite('other-pending', { query: 'select:AskUserQuestion' }, config, 'ToolSearch'));
  if (variant === 'same-path-owner') rows.push(nativeWrite('other-pending', { ...nextInput, new_string: 'Different pending edit' }, config, 'Edit'));
  write(...rows);
  await Bun.sleep(5);
  const nextEvent = emit(nextInput);
  if (variant === 'equal-result') {
    rows[1] = nativeWriteResult('scoped-edit-1', new Date(nextEvent.capturedAtMs).toISOString());
    write(...rows);
  }
  return { read, dialog, granted, requests, firstEvent, nextEvent, resultAtMs, nextInput };
}

test.each(['native', 'early', 'multiple-owner', 'parallel-read', 'parallel-tool-search'])('fresh scoped Edit can append the terminal report after a completed Edit (%s)', async variant => {
  const sequence = await scopedEditSequence(variant);
  const native = sequence.read();
  const prior = native.permissionRequests.find(item => item.requestId === sequence.firstEvent.requestId)!;
  expect(prior).toMatchObject({ result: 'completed', nativeToolId: 'scoped-edit-1', nativeResultAtMs: sequence.resultAtMs });
  expect(sequence.nextEvent.requestId).not.toBe(sequence.firstEvent.requestId);
  expect(sequence.nextEvent.capturedAtMs).toBeGreaterThan(sequence.resultAtMs);
  expect(native.permissionRequests.find(item => item.requestId === sequence.nextEvent.requestId)).toMatchObject({ result: 'pending', input: sequence.nextInput });
  expect(reserveNativePermissionGrant(native, sequence.dialog, sequence.granted, sequence.requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, sequence.dialog, sequence.granted, sequence.requests)).toBe(false);
  expect(sequence.granted.size).toBe(2);
  expect(sequence.requests.get(`Edit:${path.join(config, 'plan.md')}`)?.requestId).toBe(sequence.nextEvent.requestId);
  if (variant === 'multiple-owner' || variant === 'parallel-read' || variant === 'parallel-tool-search') {
    expect(native.permissionTools.some(tool => tool.id === 'other-pending')).toBe(true);
    expect(sequence.granted.has('other-pending')).toBe(false);
  }
});

test.each(['no-file-owner', 'wrong-file', 'two-file-owners', 'no-observer'])
('parallel ToolSearch cannot authorize a file grant with %s', async variant => {
  const sequence = await scopedEditSequence('parallel-tool-search');
  const native = sequence.read();
  if (variant === 'no-file-owner') {
    native.permissionRequests = [];
    native.permissionTools = native.permissionTools.filter(tool => tool.name === 'ToolSearch');
  }
  if (variant === 'two-file-owners') native.permissionRequests.push({
    ...native.permissionRequests.find(request => request.result === 'pending')!,
    requestId: 'second-edit', nativeToolId: undefined,
  });
  if (variant === 'no-observer') native.permissionRequestCapture = false;
  const dialog = variant === 'wrong-file' ? sequence.dialog.replace('plan.md', 'other.md') : sequence.dialog;
  const grantedBefore = [...sequence.granted], requestsBefore = [...sequence.requests];
  expect(() => reserveNativePermissionGrant(native, dialog, sequence.granted, sequence.requests)).toThrow();
  expect([...sequence.granted]).toEqual(grantedBefore);
  expect([...sequence.requests]).toEqual(requestsBefore);
});

test.each(['no-ack', 'error', 'before-result', 'equal-result', 'unfinished-prior', 'same-input', 'changed-id', 'wrong-path', 'wrong-cwd', 'same-path-owner', 'no-observer'])
('fresh scoped Edit preserves refusal for %s', async variant => {
  const sequence = await scopedEditSequence(variant);
  expect(() => reserveNativePermissionGrant(sequence.read(), sequence.dialog, sequence.granted, sequence.requests))
    .toThrow(/Repeated native permission|Indistinguishable|changed input|cannot be bound|Ambiguous native permission/);
  expect(sequence.granted.size).toBe(1);
});

test.each(['same-path', 'mixed-operation', 'granted-shadow', 'no-observer', 'legacy-file', 'legacy-bash', 'malformed', 'unsupported', 'no-match'])
('a current file dialog with parallel work preserves refusal for %s', async variant => {
  const sequence = await scopedEditSequence('multiple-owner');
  const native = variant === 'no-observer' ? readPlanSkillQuestions(config, sessionId) : sequence.read();
  const owner = native.permissionRequests.find(request => request.requestId === sequence.nextEvent.requestId)!;
  let dialog = sequence.dialog;
  if (variant === 'same-path' || variant === 'granted-shadow') {
    native.permissionRequests.push({ ...owner, requestId: 'distinct-pending-request', nativeToolId: undefined });
    if (variant === 'granted-shadow') sequence.granted.add(`request:${owner.requestId}`);
  }
  if (variant === 'mixed-operation') native.permissionTools.push({
    id: 'same-path-write', name: 'Write', cwd: config,
    input: { file_path: sequence.nextInput.file_path, content: 'Other pending write' },
  });
  if (variant === 'legacy-file') dialog = `Edit to ${sequence.nextInput.file_path}`;
  if (variant === 'legacy-bash') dialog = 'Bash command true requires permission';
  if (variant === 'malformed') native.permissionTools.find(tool => tool.id === 'other-pending')!.input = { command: 42 };
  if (variant === 'unsupported') native.permissionTools.find(tool => tool.id === 'other-pending')!.name = 'Grep';
  if (variant === 'no-match') dialog = dialog.replace('plan.md', 'different.md');
  const grantedBefore = [...sequence.granted], requestsBefore = [...sequence.requests];
  expect(() => reserveNativePermissionGrant(native, dialog, sequence.granted, sequence.requests))
    .toThrow(variant === 'malformed' || variant === 'unsupported' ? 'Unsupported native permission' : 'Ambiguous native permission');
  expect([...sequence.granted]).toEqual(grantedBefore);
  expect([...sequence.requests]).toEqual(requestsBefore);
});

test('modern overwrite permission uses the exact current Write path and controls', () => {
  const filePath = path.join(config, 'plan.md');
  const dialog = createDialog('plan.md').replace('create', 'overwrite');
  const owner = { id: 'overwrite', name: 'Write', cwd: config, input: { file_path: filePath, content: 'Final report' } };
  expect(isPermissionDialogVisible(dialog)).toBe(true);
  expect(nativePermissionKey(owner, dialog)).toBe(`Write:${filePath}`);
  expect(() => nativePermissionKey({ ...owner, name: 'Edit' }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: path.dirname(config) }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, dialog.replace('plan.md', 'other.md'))).toThrow('cannot be bound');
  expect(isPermissionDialogVisible(dialog.replace('auto-approve file edits and common file commands', 'review this plan'))).toBe(false);
  expect(isPermissionDialogVisible('Do you want to overwrite plan.md?\n❯1.Yes\n2.No')).toBe(false);
});

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


const recommendedWrapQuestion: NativeQuestion = {
  header: 'Accessibility', multiSelect: false,
  question: 'D12 — Issue 9: Add the accessibility spec (keyboard, screen reader, contrast, motion) to the plan?',
  options: [
    { label: '9A) Full a11y spec: landmarks, focus order, live regions, contrast targets, reduced motion, test checklist (recommended)', description: 'Rail as nav landmark; visible labels and a manual test checklist.' },
    { label: '9B) Contrast fix only, as the seed plan proposed', description: 'Resolve only the contrast defect.' },
  ],
};
const recommendedWrapFrame = '☐ Accessibility\n' + recommendedWrapQuestion.question
  + '\n❯ 1. ' + recommendedWrapQuestion.options[0]!.label.replace(' (recommended)', '')
  + '\n    (recommended)\n    Rail as nav landmark; visible labels and a manual test checklist.\n  2. '
  + recommendedWrapQuestion.options[1]!.label + '\n    Resolve only the contrast defect.\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel';
const matchRecommendedWrap = (frame: string, owned = recommendedWrapQuestion) =>
  nativeQuestionSelection(owned, frame, parseNumberedOptions(frame));

test('plain owned label accepts its immediately wrapped recommendation suffix', () => {
  expect(parseNumberedOptions(recommendedWrapFrame)[0]!.label).not.toContain('(recommended)');
  expect(matchRecommendedWrap(recommendedWrapFrame)).toEqual({ kind: 'digit' });
  expect(matchRecommendedWrap(recommendedWrapFrame.replaceAll('    ', '').replaceAll('❯ 1. ', '❯1. '))).toEqual({ kind: 'digit' });
  expect(matchRecommendedWrap(recommendedWrapFrame, { ...recommendedWrapQuestion,
    options: recommendedWrapQuestion.options.map(option => ({ ...option, preview: 'Owned preview requires its own frame.' })) })).toBeNull();
});

test.each([
  (frame: string) => frame.replace('\n    (recommended)', ''),
  (frame: string) => frame.replace('(recommended)', '(not recommended)'),
  (frame: string) => frame.replace('(recommended)', '(recommended by the example)'),
  (frame: string) => frame.replace('\n    (recommended)', '\n\n    (recommended)'),
  (frame: string) => frame.replace('\n    (recommended)', '\n    Description first\n    (recommended)'),
  (frame: string) => frame.replace('❯ 1.', '(recommended)\n❯ 1.').replace('\n    (recommended)', ''),
  (frame: string) => frame.replace('test checklist', 'different checklist'),
  (frame: string) => frame.replace('2. 9B)', '2. Other action'),
  (frame: string) => frame.replace('\n    (recommended)', '\n  2. Another menu\n    (recommended)'),
  (frame: string) => frame.replace('D12 — Issue 9:', 'D13 — Different issue:'),
  (frame: string) => frame + '\n☐ Different\nD13 — Another question?\n❯ 1. Other action\n  2. Keep current state',
])('wrapped recommendation cannot bridge missing, changed, stale or interrupted labels %#', change => {
  expect(matchRecommendedWrap(change(recommendedWrapFrame))).toBeNull();
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


// Exact current modal and native input retained from expansion first-attempt
// diagnostic 13288fb0. Preview prose is display content, never choice authority.
const previewInputFrame = {
  "question": {
    "question": "Which implementation approach should anchor the review?",
    "header": "Approach",
    "multiSelect": false,
    "options": [
      {
        "label": "A — Client-side CSV (recommended)",
        "description": "Smallest diff. Reuses settings API response directly in the browser. One formatter util + tests. Completeness: 9/10 — covers the full happy path and edge-case escaping; misses server-auth-gate on export (not needed for settings).",
        "preview": "button onClick → fetch existing API → csvFormatter(data) → Blob URL download\n\nFiles touched: settings page (+button), csvFormatter.ts (new), csvFormatter.test.ts (new)"
      },
      {
        "label": "B — Server-side endpoint",
        "description": "Cleaner for large datasets; adds new route + handler + auth wiring. Completeness: 10/10 — fresh data, proper headers, server auth gate. Over-engineering for a settings page.",
        "preview": "GET /settings/export.csv\n  → auth middleware\n  → settingsService.getAll()\n  → csvSerializer()\n  → stream response\n\nFiles touched: route, handler, serializer, serializer.test, settings page (+button)"
      },
      {
        "label": "C — Client-side CSV + JSON bonus",
        "description": "Near-zero extra cost after A; adds a format dropdown. Completeness: 9/10 — same as A plus programmatic-use JSON format. Minor scope expansion.",
        "preview": "button [Export ▾]\n  ├ CSV → csvFormatter(data) → download\n  └ JSON → JSON.stringify(data, null, 2) → download\n\nSame files as A + dropdown component"
      }
    ]
  },
  "visible": [
    " ☐ Approach  ",
    "    ",
    "Which implementation approach should anchor the review?",
    "             ",
    "❯ 1. A — Client-side CSV          ┌────────────────────────────────────────────────────────────────────────────────────┐",
    "    (recommended)                 │ button onClick → fetch existing API → csvFormatter(data) → Blob URL download       │",
    "  2. B — Server-side endpoint     │                                                                                    │",
    "  3. C — Client-side CSV +        │ Files touched: settings page (+button), csvFormatter.ts (new),                     │",
    "    JSON bonus                    │ csvFormatter.test.ts (new)                                                         │",
    "                                  └────────────────────────────────────────────────────────────────────────────────────┘",
    "",
    "                                  Notes: press n to add notes",
    "                                                                                ",
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"
  ]
};
const currentPreview = previewInputFrame.visible.join('\n');
const previewInput = previewInputFrame.question;
const selectPreview = (visible = currentPreview, input: NativeQuestion = previewInput) =>
  nativeQuestionSelection(input, visible, parseNumberedOptions(visible));
const focusPreview = (index: number) => currentPreview.replace('❯ 1.', '  1.').replace(`  ${index}.`, `❯ ${index}.`);

test('retained preview selection follows its own left-column focus for each native choice', () => {
  expect(selectPreview()).toEqual({ kind: 'preview', focusedIndex: 1 });
  expect(selectPreview(focusPreview(2))).toEqual({ kind: 'preview', focusedIndex: 2 });
  expect(selectPreview(focusPreview(3))).toEqual({ kind: 'preview', focusedIndex: 3 });
});

// Exact clipping row and columns from the retained expansion-mode preview.
const retainedClippingRuler = '                                  ├─── ✂ ─── 1 lines hidden ───────────────────────────────────────────────────────────┤';
const clippedPreview = focusPreview(2).replace(/^( +└)/m, `${retainedClippingRuler}\n$1`);

test.each([1, 12])('preview clipping-ruler preserves owned left-column focus (%i hidden lines)', count => {
  const ruler = `├─── ✂ ─── ${count} lines hidden `.padEnd(85, '─') + '┤';
  const visible = clippedPreview.replace(retainedClippingRuler, ' '.repeat(34) + ruler);
  expect(selectPreview(visible)).toEqual({ kind: 'preview', focusedIndex: 2 });
});

test('preview clipping-ruler supports zero trailing dashes and a left-column label continuation', () => {
  const ruler = '├─── ✂ ─── 1 lines hidden ┤';
  const innerWidth = ruler.length - 2;
  const narrow = clippedPreview.split('\n').map(line => {
    const left = line.slice(0, 34);
    const pane = line.slice(34);
    if (pane.startsWith('├')) return left + ruler;
    if (pane.startsWith('┌')) return left + '┌' + '─'.repeat(innerWidth) + '┐';
    if (pane.startsWith('└')) return left + '└' + '─'.repeat(innerWidth) + '┘';
    if (pane.startsWith('│')) return left + '│' + pane.slice(1, innerWidth + 1).padEnd(innerWidth) + '│';
    return line;
  }).join('\n');
  expect(selectPreview(narrow)).toEqual({ kind: 'preview', focusedIndex: 2 });
  const sharedRow = focusPreview(3).replace(/^    JSON bonus +│[^\n]*│$/m,
    '    JSON bonus'.padEnd(34) + retainedClippingRuler.slice(34));
  expect(selectPreview(sharedRow)).toEqual({ kind: 'preview', focusedIndex: 3 });
});

test.each([
  ['shifted left edge', retainedClippingRuler.slice(1)],
  ['shifted right edge', retainedClippingRuler.replace('─┤', '──┤')],
  ['shortened right edge', retainedClippingRuler.replace('─┤', '┤')],
  ['missing left junction', retainedClippingRuler.replace('├', '│')],
  ['missing right junction', retainedClippingRuler.replace('┤', '│')],
  ['wrong scissors', retainedClippingRuler.replace('✂', 'x')],
  ['wrong delimiter', retainedClippingRuler.replace('✂ ───', '✂ ─ ─')],
  ['tab separator', retainedClippingRuler.replace('✂ ', '✂\t')],
  ['zero count', retainedClippingRuler.replace('1 lines', '0 lines')],
  ['negative count', retainedClippingRuler.replace('1 lines', '-1 lines').replace('──┤', '─┤')],
  ['leading zero', retainedClippingRuler.replace('1 lines', '01 lines').replace('──┤', '─┤')],
  ['wrong wording', retainedClippingRuler.replace('lines hidden', 'lines folded')],
  ['trailing content', retainedClippingRuler + ' x'],
  ['wrapped ruler', retainedClippingRuler.replace('lines hidden', 'lines\nhidden')],
] as const)('preview clipping-ruler rejects malformed frames: %s', (_name, ruler) => {
  expect(selectPreview(clippedPreview.replace(retainedClippingRuler, ruler))).toBeNull();
});

test('preview clipping-ruler must occur once immediately before the bottom border', () => {
  expect(selectPreview(clippedPreview.replace(retainedClippingRuler, `${retainedClippingRuler}\n${retainedClippingRuler}`))).toBeNull();
  expect(selectPreview(clippedPreview.replace(retainedClippingRuler, `${retainedClippingRuler}\n`))).toBeNull();
  const interior = focusPreview(2).replace(/^(    JSON bonus)/m, `${retainedClippingRuler}\n$1`);
  expect(selectPreview(interior)).toBeNull();
});

test('preview clipping-ruler cannot replace label, focus, rectangle, inventory or footer evidence', () => {
  expect(selectPreview(clippedPreview.replace('B — Server-side endpoint', 'B — Foreign-side endpoint'))).toBeNull();
  expect(selectPreview(clippedPreview.replace('  1.', '❯ 1.'))).toBeNull();
  expect(selectPreview(clippedPreview.replace('❯ 2.', '  2.'))).toBeNull();
  expect(selectPreview(clippedPreview.replace('└', ' '))).toBeNull();
  expect(selectPreview(clippedPreview, { ...previewInput, options: previewInput.options.map(({ preview, ...option }) => option) })).toBeNull();
  expect(selectPreview(clippedPreview.replace('Enter to select', 'Enter to confirm'))).toBeNull();
});

test('mixed native preview options retain the preview protocol for an option without preview', () => {
  const mixed = { ...previewInput, options: previewInput.options.map((option, index) => {
    const { preview, ...plain } = option; return index === 0 ? option : plain;
  }) };
  expect(selectPreview(focusPreview(2), mixed)).toEqual({ kind: 'preview', focusedIndex: 2 });
});

test('preview cursor content cannot substitute for missing, duplicate or wrong left-column focus', () => {
  const decoy = currentPreview.replace(/│ button onClick[^\n]*│/, '│ ' + '❯ 2. B — Server-side endpoint'.padEnd(82) + ' │');
  expect(selectPreview(decoy)).toEqual({ kind: 'preview', focusedIndex: 1 });
  expect(selectPreview(decoy.replace('❯ 1.', '  1.'))).toBeNull();
  expect(selectPreview(currentPreview.replace('  2.', '❯ 2.'))).toBeNull();
  expect(selectPreview(focusPreview(2).replace('B — Server-side endpoint', 'B — Foreign-side endpoint'))).toBeNull();
});

test('preview commit requires native inventory, current prompt, rectangle and actual footer', () => {
  const noPreview = { ...previewInput, options: previewInput.options.map(({ preview, ...option }) => option) };
  expect(selectPreview(currentPreview, noPreview)).toBeNull();
  expect(selectPreview(currentPreview.replace('Which implementation approach should anchor the review?', 'An unrelated later question'))).toBeNull();
  expect(selectPreview(currentPreview.replace('└', ' '))).toBeNull();
  expect(selectPreview(currentPreview.replace('Enter to select', 'Enter to confirm'))).toBeNull();
  expect(selectPreview(currentPreview + '\n☐ Different question\nOther prompt\n❯1.First\n2.Second')).toBeNull();
});

test('normal native input retains digit-only selection and preview input in a plain frame waits', () => {
  const noPreview = { ...previewInput, options: previewInput.options.map(({ preview, ...option }) => option) };
  const plain = `☐ ${noPreview.header}\n${noPreview.question}\n`
    + noPreview.options.map((option, i) => `${i === 0 ? '❯' : ' '}${i + 1}. ${option.label}`).join('\n');
  expect(selectPreview(plain, noPreview)).toEqual({ kind: 'digit' });
  expect(selectPreview(plain)).toBeNull();
});

// Exact complete retained 40-row frames and native input from HOLD diagnostic 9a5717f1.
const shortPreviewFrame = {
  "question": {
    "header": "Review mode",
    "multiSelect": false,
    "options": [
      {
        "description": "The plan is good but could be great. Dream big — propose the ambitious version (e.g., CSV + JSON + import/restore + scheduled backups). Every expansion proposed individually for your approval. You opt in to each one.",
        "label": "SCOPE EXPANSION"
      },
      {
        "description": "The CSV export scope is the baseline. Separately surface cherry-pick opportunities (e.g., JSON format option, copy-to-clipboard, column filtering) for you to individually accept or defer. Neutral recommendations — you decide what's worth adding.",
        "label": "SELECTIVE EXPANSION (recommended)",
        "preview": "Baseline: CSV export button + client-side formatting\nCherry-picks surfaced individually:\n  [ ] JSON export option?\n  [ ] Copy-to-clipboard fallback?\n  [ ] Column selection UI?\n  [ ] Download filename with timestamp?"
      },
      {
        "description": "The scope is right. Maximum rigor review only: architecture, security, edge cases (empty settings, special chars, large payloads), observability, deployment. No expansions surfaced.",
        "label": "HOLD SCOPE"
      },
      {
        "description": "Propose the minimum viable version: just the download trigger wired to the existing API, skip the formatter abstraction. Ruthlessly cut everything that isn't strictly necessary to ship the button.",
        "label": "SCOPE REDUCTION"
      }
    ],
    "question": "D2 — Which review mode do you want for this plan?"
  },
  "before": "\n  Read 1 file, ran 1 shell command\n\n● Now let me run the pre-review system audit and check for design docs.\n\n  Ran 4 shell commands\n\n● No design doc, no handoff note, fresh repo. Let me run the premise analysis inline and present the implementation\n  alternatives per the skill workflow.\n\n  Ran 1 shell command\n\n● Updated plan\n  ⎿  /plan to preview\n\n● Pre-review analysis done. Plan is well-framed — no premise issues. The question is how the formatter module connects\n  to the download trigger. Per the skill workflow, I need your call on implementation approach before selecting review\n  mode.\n\n● User answered Claude's questions:\n  ⎿  · D1 — How should the CSV formatter connect to the settings export? (0C-bis: Implementation Approach) → A)\n     Client-side only\n\n● Got it — client-side only, no formatter module. Now the mode selection you asked for.\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ Review mode\n\nD2 — Which review mode do you want for this plan?\n\n❯ 1. SCOPE EXPANSION              ┌──────────────────────────────────────────────────────┐\n  2. SELECTIVE EXPANSION          │ No preview available                                 │\n    (recommended)                 └──────────────────────────────────────────────────────┘\n  3. HOLD SCOPE \n  4. SCOPE REDUCTION              Notes: press n to add notes\n                                                                                \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
  "focused": "\n  Read 1 file, ran 1 shell command\n\n● Now let me run the pre-review system audit and check for design docs.\n\n  Ran 4 shell commands\n\n● No design doc, no handoff note, fresh repo. Let me run the premise analysis inline and present the implementation\n  alternatives per the skill workflow.\n\n  Ran 1 shell command\n\n● Updated plan\n  ⎿  /plan to preview\n\n● Pre-review analysis done. Plan is well-framed — no premise issues. The question is how the formatter module connects\n  to the download trigger. Per the skill workflow, I need your call on implementation approach before selecting review\n  mode.\n\n● User answered Claude's questions:\n  ⎿  · D1 — How should the CSV formatter connect to the settings export? (0C-bis: Implementation Approach) → A)\n     Client-side only\n\n● Got it — client-side only, no formatter module. Now the mode selection you asked for.\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ Review mode\n\nD2 — Which review mode do you want for this plan?\n\n  1. SCOPE EXPANSION              ┌──────────────────────────────────────────────────────┐\n  2. SELECTIVE EXPANSION          │ No preview available                                 │\n    (recommended)                 └──────────────────────────────────────────────────────┘\n❯ 3. HOLD SCOPE \n  4. SCOPE REDUCTION              Notes: press n to add notes\n                                                                                \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"
};
const selectShortPreview = (visible = shortPreviewFrame.focused, input: NativeQuestion = shortPreviewFrame.question) =>
  nativeQuestionSelection(input, visible, parseNumberedOptions(visible));

test('short preview panes retain the complete owned option column below their bottom', () => {
  expect(selectShortPreview(shortPreviewFrame.before)).toEqual({ kind: 'preview', focusedIndex: 1 });
  expect(selectShortPreview()).toEqual({ kind: 'preview', focusedIndex: 3 });
  expect(selectShortPreview(shortPreviewFrame.focused.replace('❯ 3.', '  3.').replace('  4.', '❯ 4.')))
    .toEqual({ kind: 'preview', focusedIndex: 4 });
});

test.each([
  ['changed label below pane', shortPreviewFrame.focused.replace('HOLD SCOPE', 'HOLD OTHER')],
  ['duplicate focus', shortPreviewFrame.focused.replace('  4.', '❯ 4.')],
  ['missing focus', shortPreviewFrame.focused.replace('❯ 3.', '  3.')],
  ['gapped index below pane', shortPreviewFrame.focused.replace('❯ 3.', '❯ 4.')],
  ['clipped final label', shortPreviewFrame.focused.replace('SCOPE REDUCTION', 'SCOPE RED')],
  ['missing label continuation', shortPreviewFrame.focused.replace('    (recommended)', ' '.repeat(17))],
  ['right-column decoy', shortPreviewFrame.focused.replace('Notes: press n to add notes', '❯ 4. SCOPE REDUCTION')],
  ['unknown right-column text', shortPreviewFrame.focused.replace('Notes: press n to add notes', 'HOLD SCOPE confirmed')],
  ['broken bottom corner', shortPreviewFrame.focused.replace('└', ' ')],
  ['changed footer', shortPreviewFrame.focused.replace('Enter to select', 'Enter to confirm')],
] as const)('short preview panes refuse incomplete or ambiguous frames: %s', (_name, visible) => {
  expect(selectShortPreview(visible)).toBeNull();
});

test('a short preview pane cannot own a later menu or substitute for native preview inventory', () => {
  const later = shortPreviewFrame.focused + '\n☐ Other question\nD3 — Choose another action?\n❯ 1. First\n  2. Second';
  expect(selectShortPreview(later)).toBeNull();
  const noPreview = { ...shortPreviewFrame.question, options: shortPreviewFrame.question.options.map(({ preview, ...option }) => option) };
  expect(selectShortPreview(shortPreviewFrame.focused, noPreview)).toBeNull();
  expect(() => nativeQuestionSelection(shortPreviewFrame.question, shortPreviewFrame.focused,
    parseNumberedOptions(shortPreviewFrame.focused), [structuredClone(shortPreviewFrame.question)]))
    .toThrow('Indistinguishable repeated native question');
});


function earlyFileCompletion(toolName: 'Write' | 'Edit' = 'Edit') {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Review' } });
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const firstInput = toolName === 'Edit'
    ? { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: 'Decision D9 approved', replace_all: false }
    : { file_path: path.join(config, 'plan.md'), content: 'Decision D9 approved' };
  const response = toolName === 'Edit'
    ? { filePath: firstInput.file_path, oldString: 'Draft', newString: 'Decision D9 approved', originalFile: 'Draft', structuredPatch: [], userModified: false, replaceAll: false }
    : { type: 'create', filePath: firstInput.file_path, content: 'Decision D9 approved', structuredPatch: [], originalFile: null, userModified: false };
  const emit = (hookEvent: string, input: unknown, extra: Record<string, unknown> = {}) => {
    const child = Bun.spawnSync(['bash', '-c', command], { timeout: 5000,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: hookEvent, session_id: sessionId,
        transcript_path: file, cwd: config, tool_name: toolName, tool_input: input, ...extra })), stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
  };
  const read = () => readPlanSkillQuestions(config, sessionId, source);
  emit('PermissionRequest', firstInput);
  const first = read().permissionRequests[0]!;
  const dialog = toolName === 'Edit' ? createDialog('plan.md').replace('create', 'make this edit to') : createDialog('plan.md');
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(read(), dialog, granted, requests)).toBe(true);
  const complete = (extra: Record<string, unknown> = {}) => emit('PostToolUse', firstInput,
    { tool_use_id: 'unflushed-file-1', tool_response: response, ...extra });
  const nextInput = toolName === 'Edit' ? { ...firstInput, old_string: 'Decision D9 approved', new_string: 'Decision D9 approved\nSecurity review' }
    : { ...firstInput, content: 'Decision D9 approved\nSecurity review' };
  const nextDialog = toolName === 'Edit' ? dialog : dialog.replace('create', 'overwrite');
  return { source, read, emit, first, firstInput, response, complete, nextInput, nextDialog, granted, requests };
}

test.each(['Write', 'Edit'] as const)('owned PostToolUse completes %s before transcript publication and permits one fresh next grant', toolName => {
  const s = earlyFileCompletion(toolName);
  s.complete();
  expect(fs.readFileSync(file, 'utf8')).not.toContain('unflushed-file-1');
  expect(s.read().permissionRequests[0]).toMatchObject({ requestId: s.first.requestId, result: 'completed', nativeToolId: 'unflushed-file-1', completionEvidence: 'PostToolUse' });
  expect(s.read().calls).toEqual([]); expect(s.read().ready).toBe(false);
  s.emit('PermissionRequest', s.nextInput);
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(true);
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(false);
  expect(s.granted.size).toBe(2);
  // Matching later JSONL is corroboration, not a second completion/grant.
  write(nativeWrite('unflushed-file-1', s.firstInput, config, toolName), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: s.response,
  });
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(false);
});


// A report may be created, overwritten after findings, then overwritten again
// after a later section. These are real owned hook events, not inferred grants.
async function repeatedWriteSequence(variant = 'fresh') {
  const s = earlyFileCompletion('Write'); s.complete();
  s.emit('PermissionRequest', s.nextInput);
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(true);
  const second = s.read().permissionRequests.find(item => item.result === 'pending')!;
  const response = { ...s.response, type: 'update', content: s.nextInput.content,
    originalFile: s.firstInput.content };
  if (variant === 'failed-ack') s.emit('PostToolUseFailure', s.nextInput, { tool_use_id: 'unflushed-file-2', error: 'write failed' });
  else if (variant !== 'no-ack') s.emit('PostToolUse', s.nextInput, { tool_use_id: 'unflushed-file-2', tool_response: response });
  await Bun.sleep(5);
  const thirdInput = variant === 'identical-input' ? s.nextInput
    : variant === 'extra-field-only' ? { ...s.nextInput, incidental: true }
    : { ...s.nextInput, content: s.nextInput.content + '\n\n## GSTACK REVIEW REPORT\nCEO review complete.' };
  s.emit('PermissionRequest', thirdInput);
  return { ...s, second, thirdInput };
}

test('owned repeated Write overwrite follows only its prior successful ACK and grants once', async () => {
  const s = await repeatedWriteSequence();
  const native = s.read(), prior = native.permissionRequests.find(item => item.requestId === s.second.requestId)!;
  const current = native.permissionRequests.find(item => item.result === 'pending')!;
  expect(prior).toMatchObject({ result: 'completed', nativeToolId: 'unflushed-file-2', completionEvidence: 'PostToolUse' });
  expect(current.requestId).not.toBe(prior.requestId);
  expect(current.capturedAtMs).toBeGreaterThan(prior.nativeResultAtMs!);
  expect(current.input).toEqual(s.thirdInput);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('unflushed-file-2');
  expect(reserveNativePermissionGrant(native, s.nextDialog, s.granted, s.requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, s.nextDialog, s.granted, s.requests)).toBe(false);
  expect(s.granted.size).toBe(3);
  expect(s.requests.get(`Write:${path.join(config, 'plan.md')}`)?.requestId).toBe(current.requestId);
});

test.each(['no-ack', 'failed-ack', 'identical-input', 'extra-field-only', 'before-ack', 'equal-ack', 'missing-native-id',
  'wrong-cwd', 'wrong-path', 'wrong-tool', 'wrong-frame', 'replayed-request', 'multiple-writers'])
('owned repeated Write overwrite preserves refusal for %s', async variant => {
  const s = await repeatedWriteSequence(variant);
  const before = [...s.granted], requestsBefore = [...s.requests];
  const attempt = () => {
    const native = s.read(), current = native.permissionRequests.find(item => item.result === 'pending' && item.requestId !== s.second.requestId)!;
    const prior = native.permissionRequests.find(item => item.requestId === s.second.requestId)!;
    if (variant === 'before-ack') current.capturedAtMs = prior.nativeResultAtMs! - 1;
    if (variant === 'equal-ack') current.capturedAtMs = prior.nativeResultAtMs!;
    if (variant === 'missing-native-id') delete prior.nativeToolId;
    if (variant === 'wrong-cwd') current.cwd = path.dirname(config);
    if (variant === 'wrong-path') current.input.file_path = path.join(config, 'sibling.md');
    if (variant === 'wrong-tool') current.name = 'Edit';
    if (variant === 'replayed-request') current.requestId = s.second.requestId;
    if (variant === 'multiple-writers') native.permissionRequests.push({ ...current, requestId: 'other-writer' });
    const dialog = variant === 'wrong-frame' ? s.nextDialog.replace('overwrite', 'create') : s.nextDialog;
    if (variant === 'replayed-request') expect(reserveNativePermissionGrant(native, dialog, s.granted, s.requests)).toBe(false);
    else expect(() => reserveNativePermissionGrant(native, dialog, s.granted, s.requests)).toThrow();
  };
  // Duplicate input or a failed native hook is rejected before reservation.
  if (variant === 'identical-input' || variant === 'failed-ack') expect(attempt).toThrow();
  else attempt();
  expect([...s.granted]).toEqual(before); expect([...s.requests]).toEqual(requestsBefore);
});

test.each(['missing', 'foreign-session', 'subagent', 'failure', 'malformed-response', 'wrong-response-path', 'changed-input', 'duplicate-request', 'duplicate-completion-id', 'late-completion'])
('owned PostToolUse cannot retire an unproven request (%s)', variant => {
  const s = earlyFileCompletion();
  if (variant === 'duplicate-request') s.emit('PermissionRequest', s.firstInput);
  if (variant === 'late-completion') s.emit('PermissionRequest', s.nextInput);
  if (variant === 'failure') s.emit('PostToolUseFailure', s.firstInput, { tool_use_id: 'unflushed-file-1', error: 'Failed to write' });
  else if (variant !== 'missing') s.complete(
    variant === 'foreign-session' ? { session_id: '00000000-0000-4000-8000-000000000002' }
      : variant === 'subagent' ? { agent_id: 'other-worker' }
      : variant === 'malformed-response' ? { tool_response: { success: true } }
      : variant === 'wrong-response-path' ? { tool_response: { ...s.response, filePath: '/wrong/plan.md' } }
      : variant === 'changed-input' ? { tool_input: { ...s.firstInput, new_string: 'Not the requested edit' } } : {});
  if (variant === 'duplicate-completion-id') s.complete({ tool_use_id: 'second-completion-for-one-request' });
  if (variant !== 'late-completion') s.emit('PermissionRequest', s.nextInput);
  expect(() => reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toThrow();
  expect(s.granted.size).toBe(1);
});

test.each(['name', 'input', 'cwd', 'unfinished-input', 'error', 'raw-response'])
('owned PostToolUse refuses later native contradiction (%s)', variant => {
  const s = earlyFileCompletion(); s.complete();
  expect(s.read().permissionRequests[0].result).toBe('completed');
  const input = variant.includes('input') ? { ...s.firstInput, new_string: 'Conflicting native edit' } : s.firstInput;
  write(nativeWrite('unflushed-file-1', input, variant === 'cwd' ? path.dirname(config) : config,
    variant === 'name' ? 'Write' : 'Edit', variant === 'unfinished-input' ? null : 'tool_use'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString(), variant === 'error'),
    toolUseResult: variant === 'raw-response' ? { ...s.response, newString: 'Different completed edit' } : s.response,
  });
  expect(s.read).toThrow(/changed input|conflicts with/);
  expect(s.granted.size).toBe(1);
});

test('a duplicate success callback cannot replace its first immutable completion', () => {
  const s = earlyFileCompletion(); s.complete();
  expect(s.read().permissionRequests[0].result).toBe('completed');
  s.complete({ tool_response: { ...s.response, newString: 'A different response' } });
  expect(s.read).toThrow('capture failed');
});

test('unrequested successful file work carries no permission, AUQ or completion-modal authority', () => {
  const s = earlyFileCompletion();
  const other = { ...s.firstInput, file_path: path.join(config, 'auto-allowed.md') };
  s.emit('PostToolUse', other, { tool_use_id: 'auto-allowed', tool_response: { ...s.response, filePath: other.file_path } });
  const native = s.read();
  expect(native.permissionRequests[0].result).toBe('pending');
  expect(native.permissionTools).toEqual([]); expect(native.permissionResults).toEqual([]);
  expect(native.calls).toEqual([]); expect(native.ready).toBe(false);
});

test('native storage may clear large Edit originalFile bytes but no other completion fields', () => {
  const s = earlyFileCompletion(); s.complete();
  write(nativeWrite('unflushed-file-1', s.firstInput, config, 'Edit'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: { ...s.response, originalFile: '' },
  });
  expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
});


test.each(['preserved', 'clearable', 'cleared-mismatch'])('Write update storage preserves the exact native clearing condition (%s)', variant => {
  const s = earlyFileCompletion('Write');
  const response = { ...s.response, type: 'update', originalFile: variant === 'clearable' ? 'Previous plan' : null, structuredPatch: [] };
  s.complete({ tool_response: response });
  const stored = variant === 'preserved' ? response : { ...response, content: '', originalFile: null };
  write(nativeWrite('unflushed-file-1', s.firstInput), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: stored,
  });
  if (variant === 'cleared-mismatch') expect(s.read).toThrow('conflicts with its later result');
  else expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
});

test.each([
  ['small', 'Draft', false],
  ['10000 units', 'a'.repeat(10_000), false],
  ['10001 units', 'a'.repeat(10_001), true],
  ['10000 UTF16 units despite more UTF8 bytes', '😀'.repeat(5_000), false],
  ['10001 UTF16 units', '😀'.repeat(5_000) + 'x', true],
  ['already cleared', '', false],
] as const)('native append storage nulls Edit originalFile only above its exact bound (%s)', (_name, originalFile, accepted) => {
  const s = earlyFileCompletion();
  const response = { ...s.response, originalFile };
  s.complete({ tool_response: response });
  expect(s.read().permissionRequests[0].result).toBe('completed');
  write(nativeWrite('unflushed-file-1', s.firstInput, config, 'Edit'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()),
    toolUseResult: { ...response, originalFile: null },
  });
  if (accepted) expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
  else expect(s.read).toThrow('conflicts with its later result');
  expect(s.granted.size).toBe(1);
});

test.each(['raw', 'tool-specific-stored', 'append-raw', 'append-stored'] as const)
('native append storage composes with exact Write storage (%s)', variant => {
  const s = earlyFileCompletion('Write');
  const response = { ...s.response, type: 'update', originalFile: 'a'.repeat(10_001) };
  s.complete({ tool_response: response });
  const stored = variant === 'tool-specific-stored' || variant === 'append-stored'
    ? { ...response, content: '', originalFile: null }
    : variant === 'append-raw' ? { ...response, originalFile: null } : response;
  write(nativeWrite('unflushed-file-1', s.firstInput), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: stored,
  });
  expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
});

test.each(['changed-field', 'missing-field', 'extra-field', 'error'] as const)
('native append storage preserves every other result conflict (%s)', variant => {
  const s = earlyFileCompletion();
  const response = { ...s.response, originalFile: 'a'.repeat(10_001) };
  s.complete({ tool_response: response });
  const stored: Record<string, unknown> = { ...response, originalFile: null };
  if (variant === 'changed-field') stored.newString = 'Different completed edit';
  if (variant === 'missing-field') delete stored.originalFile;
  if (variant === 'extra-field') stored.unexplained = true;
  write(nativeWrite('unflushed-file-1', s.firstInput, config, 'Edit'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString(), variant === 'error'), toolUseResult: stored,
  });
  expect(s.read).toThrow('conflicts with its later result');
  expect(s.granted.size).toBe(1);
});

// Native Design counting failure, Claude 2.1.263: a 105-line wireframe scrolls
// its title/subtitle off screen. The current basename and complete directory
// in option 2 still identify the one-time option 1 permission exactly.
const clippedDesignFrame = "   76       <div class=\"field invalid\">\n   77         <label for=\"email\">Email</label>                                                                                                         1 file changed                                                                         ✕\n   78         <input id=\"email\" value=\"margarethe@acme\" aria-invalid=\"true\" aria-describedby=\"email-err\">\n   79         <div class=\"error\" id=\"email-err\" role=\"alert\"><span aria-hidden=\"true\">!</span><span>Enter a full email address, like name@company.c    gstack-test-plan-design.md\n      om.</span></div>\n   80       </div>                                                                                                                                     ────────────────────────────────────────────────────────────────────────────────────────\n   81     </section>                                                                                                                                   gstack-test-plan-design.md (untracked)\n   82    C       t   u                                                                                                                                 ────────────────────────────────────────────────────────────────────────────────────────\n   83    P<section id=\"notifications\" aria-labelledby=\"h-notif\">                                                                                       New file not yet staged.\n   84    L  <h2 id=\"h-notif\">Notifications</h2>                                                                                                        Run `git add :/gstack-test-plan-design.md` to see line counts.\n   85       <div class=\"field\">\n   86    F    <label for=\"digest\">Weekly digest email</label>\n   87    C    <input id=\"digest\" value=\"Every Monday, 9:00\"> \n   88    C    <div class=\"help\">Sent in your account timezone.</div>\n   89       </div>\n   90    T</secsion>\n   91  \n   92     <section id=\"api-keys\" aria-labelledby=\"h-keys\">\n   93    P  <h2 id=\"h-keys\">API keys</h2> \n   94       <div class=\"empty\">\n   95         <p>No keys yet. Keys let scripts and integrations act on your behalf.</p>\n   96         <button class=\"btn\">Create your first key</button>\n   97       </div>\n   98     </section>\n   99\n  100     <div class=\"note\">Wireframe only. Designer mockup generation was unavailable (no OpenAI key). Toast below shows the post-save success sta\n      te.</div>\n  101   </main>\n  102 </div>\n  103 <div class=\"toast\" role=\"status\">Saved. Changes are live.</div>\n  104 </body>\n  105 </html>\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create wireframe-desktop.html?\n ❯ 1. Yes \n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; Yes, and always allow access to\n      /home/vercel-sandbox/.gstack/projects/gstack-e2e-plan-design-16ewXN/designs/settings-page-20260910 for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend";
const clippedDesignOwner = {"id": "toolu_01VQSgtivSuKpKci3w9RXzbn", "name": "Write", "cwd": "/tmp/gstack-paid-shard-klXxAu/tmp/gstack-e2e-plan-design-16ewXN", "input": {"file_path": "/home/vercel-sandbox/.gstack/projects/gstack-e2e-plan-design-16ewXN/designs/settings-page-20260910/wireframe-desktop.html"}};
test('clipped native create header binds its fully displayed parent and grants only once', () => {
  const filePath = clippedDesignOwner.input.file_path;
  expect(currentFilePermissionTarget(clippedDesignFrame)).toEqual({ operation: 'create', filePath });
  expect(nativePermissionKey(clippedDesignOwner, clippedDesignFrame)).toBe('Write:' + filePath);
  const native = { permissionTools: [clippedDesignOwner], permissionResults: [], permissionRequestCapture: true,
    permissionRequests: [{ requestId: 'owned-clipped-request', capturedAtMs: 1, name: 'Write' as const,
      input: clippedDesignOwner.input, cwd: clippedDesignOwner.cwd, result: 'pending' as const, nativeToolId: clippedDesignOwner.id }] };
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, clippedDesignFrame, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, clippedDesignFrame, granted, requests)).toBe(false);
  expect([...granted]).toEqual(['request:owned-clipped-request']);
  expect([...requests.keys()]).toEqual(['Write:' + filePath]);
});
test('clipped create permission refuses another basename, parent, malformed directory, or conflicting header', () => {
  const filePath = clippedDesignOwner.input.file_path, directory = path.dirname(filePath);
  for (const invalid of [
    clippedDesignFrame.replace('Do you want to create wireframe-desktop.html?', 'Do you want to create other.html?'),
    clippedDesignFrame.replace(directory, directory + '-sibling'),
    clippedDesignFrame.replace(directory, path.dirname(directory)),
    clippedDesignFrame.replace(directory, directory.replace('/designs/', '/desi…/')),
    clippedDesignFrame.replace(directory, directory.replace('/designs/', '/desi\n      gns/')),
    clippedDesignFrame.replace(directory, 'relative/designs'),
    clippedDesignFrame.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes,', ' ❯ 2. Yes,'),
    ' Create file\n another/wireframe-desktop.html\n' + clippedDesignFrame,
    '─'.repeat(240) + '\n Create file\n another/wireframe-desktop.html\n' + clippedDesignFrame,
    '─'.repeat(240) + '\n Create file\n ' + filePath + '\n Create file\n ' + filePath + '\n' + clippedDesignFrame,
  ]) expect(() => nativePermissionKey(clippedDesignOwner, invalid)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...clippedDesignOwner, input: { file_path: filePath + '.other' } }, clippedDesignFrame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...clippedDesignOwner, name: 'Edit' }, clippedDesignFrame)).toThrow('cannot be bound');
});


// The execution hook contains CLI-validated nested objects; the raw transcript
// can retain undeclared model keys that never reach the permission component.
for (const stopReason of [null, 'tool_use']) {
  test(`owned question execution strips only corroborated nested schema extras (${stopReason})`, () => {
    const native = call('schema-extra', [JSON.parse(JSON.stringify(question))]);
    native.message.stop_reason = stopReason as any;
    (native.message.content[0].input.questions[0] as any).multiSelar = false;
    (native.message.content[0].input.questions[0].options[0] as any).undeclaredPreview = 'not displayed';
    write(native);
    const early = earlyQuestions(); early.emit('schema-extra');
    const pending = readPlanSkillQuestions(config, sessionId, early.source);
    expect(pending.calls).toEqual([{ id: 'schema-extra', questions: [question], result: 'pending' }]);
    fs.appendFileSync(file, JSON.stringify(nativeWriteResult('schema-extra')) + '\n');
    expect(readPlanSkillQuestions(config, sessionId, early.source).calls).toEqual([
      { id: 'schema-extra', questions: [question], result: 'answered' },
    ]);
    expect(pending.permissionRequests).toEqual([]); expect(pending.permissionTools).toEqual([]);
  });
}

test('a raw duplicate question cannot erase nested changes without an owned execution hook', () => {
  const modified = call('raw-extra', [JSON.parse(JSON.stringify(question))]);
  (modified.message.content[0].input.questions[0] as any).multiSelar = false;
  write(call('raw-extra', [JSON.parse(JSON.stringify(question))]), modified);
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('changed input');
});

test.each(['question', 'header', 'multiSelect', 'label', 'description', 'preview', 'kind', 'metadata', 'top-extra'])
('owned nested schema equivalence preserves changed %s refusal', field => {
  const native = call('schema-conflict', [JSON.parse(JSON.stringify(question))]);
  const input: any = native.message.content[0].input;
  input.questions[0].multiSelar = false;
  if (field === 'question' || field === 'header') input.questions[0][field] = 'different';
  else if (field === 'multiSelect') input.questions[0].multiSelect = 'false';
  else if (field === 'label' || field === 'description') input.questions[0].options[0][field] = 'different';
  else if (field === 'preview') input.questions[0].options[0].preview = null;
  else if (field === 'kind') input.questions[0].kind = 'text';
  else input[field] = { changed: true };
  write(native); const early = earlyQuestions(); early.emit('schema-conflict');
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

test('changed execution hooks cannot use the transcript-only schema projection', () => {
  write(); const early = earlyQuestions(); early.emit('hook-conflict');
  early.emit('hook-conflict', { questions: [{ ...question, multiSelar: false }] });
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('Native question event capture failed');
});
