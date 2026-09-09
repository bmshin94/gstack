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
  write(...rows);
  await Bun.sleep(5);
  const nextEvent = emit(nextInput);
  if (variant === 'equal-result') {
    rows[1] = nativeWriteResult('scoped-edit-1', new Date(nextEvent.capturedAtMs).toISOString());
    write(...rows);
  }
  return { read, dialog, granted, requests, firstEvent, nextEvent, resultAtMs, nextInput };
}

test.each(['native', 'early'])('fresh scoped Edit can append the terminal report after a completed Edit (%s)', async variant => {
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
});

test.each(['no-ack', 'error', 'before-result', 'equal-result', 'unfinished-prior', 'same-input', 'changed-id', 'wrong-path', 'wrong-cwd', 'multiple-owner', 'no-observer'])
('fresh scoped Edit preserves refusal for %s', async variant => {
  const sequence = await scopedEditSequence(variant);
  expect(() => reserveNativePermissionGrant(sequence.read(), sequence.dialog, sequence.granted, sequence.requests))
    .toThrow(/Repeated native permission|Indistinguishable|changed input|cannot be bound|Ambiguous native permission/);
  expect(sequence.granted.size).toBe(1);
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
