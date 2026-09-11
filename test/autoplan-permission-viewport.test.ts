import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoplanFilePermissionViewport, reserveAutoplanFilePermission } from './helpers/autoplan-phase-order';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import type { readPlanSkillQuestions, NativePermissionGrant } from './helpers/plan-skill-questions';

// Pinned 2.1.263 Edit renderer layout: full relative subtitle above the diff,
// basename below it, and the settings-specific standing option. Only 1 is sent.
let cwd: string, file: string, screen: PtyCurrentScreen;
let native: ReturnType<typeof readPlanSkillQuestions>;
let viewport: AutoplanFilePermissionViewport;
let granted: Set<string>, requests: Map<string, NativePermissionGrant>;
let raw = '', lines = 350, extraWidth = 0, repaint = true, displayPath: string;
let resizes: number[], sends: string[], deadlineAt: number;
const card = () => [
  '─'.repeat(120), ' Edit file', ' ' + displayPath, '╌'.repeat(120),
  ...Array.from({ length: lines }, (_, i) => ` ${i + 1} +ordinary proposed plan line ${i + 1}` + 'x'.repeat(extraWidth)),
  '╌'.repeat(120), ` Do you want to make this edit to ${path.basename(file)}?`,
  ' ❯ 1. Yes', '   2. Yes, and allow Claude to edit its own settings for this session',
  '   3. No', '', ' Esc to cancel · Tab to amend',
].join('\r\n');
const paint = () => { const text = '\x1b[2J\x1b[H' + card(); raw += text; screen.feed(text); };
const sample = async () => ({ text: (await screen.snapshot()).text, rawEnd: raw.length });
const reserve = (frame: { text: string }) => reserveAutoplanFilePermission(native, frame.text,
  { cwd, planDir: path.join(cwd, '.claude', 'plans'), granted, requests });
const tick = async () => {
  const frame = await sample();
  if (viewport.active && await viewport.advance(native, frame)) return;
  try { if (reserve(frame)) sends.push('1\r'); }
  catch (error) { if (!await viewport.recover(error, native, frame)) throw error; }
};
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-card-free-')));
  file = path.join(cwd, '.claude', 'plans', 'review.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'existing plan');
  raw = ''; lines = 350; extraWidth = 0; repaint = true; displayPath = path.relative(cwd, file);
  resizes = []; sends = []; granted = new Set(); requests = new Map(); deadlineAt = Date.now() + 5000;
  native = { calls: [], ready: false, pendingExitPlanModeIds: [], pendingBytes: 0,
    permissionTools: [], permissionResults: [], permissionRequestCapture: true,
    permissionRequests: [{ requestId: 'owned-edit', capturedAtMs: 1, name: 'Edit', cwd,
      input: { file_path: file, old_string: 'existing plan', new_string: 'reviewed plan' }, result: 'pending', nativeToolId: null }] };
  screen = new PtyCurrentScreen({ cols: 120, rows: 120 });
  viewport = new AutoplanFilePermissionViewport({ deadlineAt, granted, session: {
    mark: () => raw.length,
    resizeQuestionViewport: async (rows, deadline) => {
      if (Date.now() >= deadline) return null;
      await screen.snapshot(); const mark = raw.length;
      screen.resize(120, rows); resizes.push(rows);
      if (repaint) paint(); return mark;
    },
  } });
  paint();
});
afterEach(() => { screen.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });

test('a taller-than120 owned Edit needs two fresh native paints, grants once, and restores only after ACK', async () => {
  expect((await sample()).text).not.toContain(' Edit file');
  expect(() => reserve({ text: card().split('\r\n').slice(-120).join('\n') })).toThrow('cannot be bound');
  await tick(); expect(resizes).toEqual([240]); expect(sends).toEqual([]);
  await tick(); expect(resizes).toEqual([240, 480]); expect(sends).toEqual([]);
  expect((await sample()).text).toContain(' Edit file\n .claude/plans/review.md');
  await tick(); await tick();
  expect(sends).toEqual(['1\r']); expect(resizes).toEqual([240, 480]);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeToolId: 'actual-edit', nativeResultAtMs: 2 });
  await tick(); expect(resizes).toEqual([240, 480, 120]); expect(viewport.active).toBe(false);
  expect([...granted]).toEqual(['request:owned-edit']); expect([...requests.keys()]).toEqual(['Edit:' + file]);
});

test('a card still clipped at the finite cap fails with the original identity error and no grant', async () => {
  lines = 600; paint(); await tick(); await tick();
  await expect(tick()).rejects.toThrow('Visible permission cannot be bound');
  expect(resizes).toEqual([240, 480]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test('wrapped physical diff rows recover within the cap without treating logical lines as viewport height', async () => {
  lines = 180; extraWidth = 160; paint();
  expect((await screen.snapshot()).lines.some(line => line.wrapped)).toBe(true);
  expect((await sample()).text).not.toContain(' Edit file');
  await tick(); expect((await sample()).text).not.toContain(' Edit file');
  await tick(); expect((await sample()).text).toContain(' Edit file\n .claude/plans/review.md');
  await tick(); expect(sends).toEqual(['1\r']); expect(resizes).toEqual([240, 480]);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeToolId: 'wrapped-edit', nativeResultAtMs: 2 });
  await tick(); expect(resizes).toEqual([240, 480, 120]);
});

test('the first learned native tool ID cannot change on a later recovery sample', async () => {
  await tick(); native.permissionRequests[0]!.nativeToolId = 'first-known-id';
  await tick(); native.permissionRequests[0]!.nativeToolId = 'other-known-id';
  await expect(tick()).rejects.toThrow('changed ownership or input');
  expect(sends).toEqual([]); expect(resizes).toEqual([240, 480]);
});

test.each(['input', 'request', 'cwd', 'operation', 'time', 'native-id'])('repaint cannot transfer authority to changed %s', async kind => {
  if (kind === 'native-id') native.permissionRequests[0]!.nativeToolId = 'first-id';
  await tick(); const owner = native.permissionRequests[0]!;
  if (kind === 'input') owner.input.new_string = 'different changes';
  if (kind === 'request') owner.requestId = 'different-request';
  if (kind === 'cwd') owner.cwd += '-other';
  if (kind === 'operation') owner.name = 'Write';
  if (kind === 'time') owner.capturedAtMs++;
  if (kind === 'native-id') owner.nativeToolId = 'different-id';
  await expect(tick()).rejects.toThrow('changed ownership or input');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]);
});

test.each(['request', 'tool'])('a competing %s introduced during recovery remains ambiguous', async kind => {
  await tick();
  if (kind === 'request') native.permissionRequests.push({ ...structuredClone(native.permissionRequests[0]!), requestId: 'competing' });
  else native.permissionTools.push({ id: 'competing', name: 'Edit', cwd, input: { file_path: file } });
  await expect(tick()).rejects.toThrow('Ambiguous native permission owner');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]);
});

test('an already ambiguous request cannot start recovery', async () => {
  native.permissionTools.push({ id: 'competing', name: 'Edit', cwd, input: { file_path: file } });
  await expect(tick()).rejects.toThrow('multiple tools are pending');
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('explicit full-path mismatch is an error, not another request to enlarge the viewport', async () => {
  await tick(); lines = 3; displayPath = '.claude/other/review.md'; paint();
  await expect(tick()).rejects.toThrow('cannot be bound');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]);
});

test('a resize without new native output cannot reuse stale text or renew recovery', async () => {
  repaint = false; await tick();
  for (let i = 0; i < 4; i++) await tick();
  expect(resizes).toEqual([240]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test.each(['error', 'missing-ack'])('a %s completion never restores or grants again', async kind => {
  await tick(); await tick(); await tick();
  native.permissionRequests[0]!.result = kind === 'error' ? 'error' : 'completed';
  await expect(tick()).rejects.toThrow(kind === 'error' ? 'returned an error' : 'successful native ACK');
  expect(sends).toEqual(['1\r']); expect(resizes).toEqual([240, 480]);
});

test('a complete initial card uses the unchanged grant without a viewport transaction', async () => {
  lines = 3; paint(); await tick(); await tick();
  expect(sends).toEqual(['1\r']); expect(resizes).toEqual([]); expect(viewport.active).toBe(false);
});

test('existing scope refusal is not a clipping recovery trigger', async () => {
  native.permissionRequests[0]!.input.file_path = path.join(path.dirname(cwd), 'outside', 'review.md');
  await expect(tick()).rejects.toThrow('outside its fixture');
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('a different basename cannot start recovery', async () => {
  native.permissionRequests[0]!.input.file_path = path.join(path.dirname(file), 'different.md');
  await expect(tick()).rejects.toThrow('cannot be bound');
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('a changed raw barrier cannot start recovery from the previous frame', async () => {
  const frame = await sample(); let error: unknown;
  try { reserve(frame); } catch (cause) { error = cause; }
  raw += 'later native output';
  expect(await viewport.recover(error, native, frame)).toBe(false);
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('a recovery deadline causes no viewport mutation or permission input', async () => {
  const expired = new AutoplanFilePermissionViewport({ deadlineAt: Date.now() - 1, granted, session: {
    mark: () => raw.length, resizeQuestionViewport: async (_rows, deadline) => {
      expect(deadline).toBeLessThan(Date.now()); return null;
    },
  } });
  const frame = await sample(); let error: unknown;
  try { reserve(frame); } catch (cause) { error = cause; }
  expect(await expired.recover(error, native, frame)).toBe(true);
  expect(expired.inputMark).toBe(-1); expect(resizes).toEqual([]); expect(sends).toEqual([]);
});
