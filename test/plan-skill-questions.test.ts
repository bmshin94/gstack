import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanSkillQuestions, matchesNativeQuestion, isNativeQuestionSubmitVisible, nativePermissionKey, type NativeQuestion } from './helpers/plan-skill-questions';
import { isPermissionDialogVisible, parseNumberedOptions, stripAnsi } from './helpers/claude-pty-runner';

const sessionId = '00000000-0000-4000-8000-000000000001';
const question: NativeQuestion = { question: 'D1 — Which approach?\nMake it reliable. Enforce the delivery policy.', header: 'Approach', multiSelect: false,
  options: ['Extend dispatcher', 'Queue fanout', 'Minimal patch', 'Hold scope'].map(label => ({ label, description: label })) };
let config: string;
let file: string;
const call = (id: string, questions = [question]) => ({ type: 'assistant', sessionId, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const write = (...rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
beforeEach(() => { config = fs.mkdtempSync(path.join(os.tmpdir(), 'native-question-')); file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true }); });
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

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
