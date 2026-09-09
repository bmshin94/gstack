/** Free ordering regressions for the paid autoplan chain's observed markers. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { corroboratedAutoplanPhases, observedAutoplanPhases, readAutoplanTranscript, reserveAutoplanFilePermission, retainAutoplanFailure, validateAutoplanPhaseOrder } from './helpers/autoplan-phase-order';
import { stripAnsi } from './helpers/claude-pty-runner';
import type { readPlanSkillQuestions, NativePermissionGrant } from './helpers/plan-skill-questions';

describe('autoplan file grants stay inside their owned fixture', () => {
  let root: string;
  let cwd: string;
  let planDir: string;
  let native: ReturnType<typeof readPlanSkillQuestions>;
  let granted: Set<string>;
  let requests: Map<string, NativePermissionGrant>;
  const dialog = (file: string) => `Do you want to create ${file}?\n❯ 1. Yes\n  2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session\n  3. No\nEsc to cancel`;
  const reserve = (file = String(native.permissionRequests[0]?.input.file_path), visible = dialog(file)) =>
    reserveAutoplanFilePermission(native, visible, { cwd, planDir, granted, requests });
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-permission-')));
    cwd = path.join(root, 'project');
    planDir = path.join(root, 'config', 'plans');
    fs.mkdirSync(cwd);
    fs.mkdirSync(planDir, { recursive: true });
    granted = new Set();
    requests = new Map();
    native = { calls: [], ready: false, pendingExitPlanModeIds: [], pendingBytes: 0,
      permissionTools: [], permissionResults: [], permissionRequestCapture: true,
      permissionRequests: [{ requestId: 'owned-write', capturedAtMs: 1, name: 'Write', cwd,
        input: { file_path: path.join(cwd, '.gstack', 'projects', 'fixture', 'restore.md') }, result: 'pending' }] };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('reserves a current fixture-owned restore request only once', () => {
    expect(reserve()).toBe(true);
    expect(reserve()).toBe(false);
    expect([...granted]).toEqual(['request:owned-write']);
  });

  test('allows the launch-owned native plan directory', () => {
    native.permissionRequests[0]!.input.file_path = path.join(planDir, 'review.md');
    expect(reserve()).toBe(true);
  });

  test.each(['outside', 'sibling-prefix', 'dotdot'])('rejects the %s path before reserving', kind => {
    const file = kind === 'outside' ? path.join(root, 'operator-home', '.gstack', 'restore.md')
      : kind === 'sibling-prefix' ? cwd + '-other/restore.md' : path.join(cwd, '..', 'restore.md');
    native.permissionRequests[0]!.input.file_path = file;
    expect(() => reserve()).toThrow('outside its fixture');
    expect(granted.size).toBe(0);
  });

  test.skipIf(process.platform === 'win32')('rejects a symlink that redirects a fixture path outside', () => {
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(cwd, '.gstack'), 'dir');
    expect(() => reserve()).toThrow('symlink');
    expect(granted.size).toBe(0);
  });

  test('rejects a request from another cwd', () => {
    native.permissionRequests[0]!.cwd = root;
    expect(() => reserve()).toThrow('cwd differs');
  });

  test.each(['no-capture', 'no-request', 'partial', 'exit', 'question'])('does not grant with %s evidence', kind => {
    if (kind === 'no-capture') native.permissionRequestCapture = false;
    if (kind === 'no-request') native.permissionRequests = [];
    if (kind === 'partial') native.pendingBytes = 1;
    if (kind === 'exit') native.ready = true;
    if (kind === 'question') native.calls = [{ id: 'question', result: 'pending', questions: [] }];
    expect(reserve(path.join(cwd, 'restore.md'))).toBe(false);
    expect(granted.size).toBe(0);
  });

  test('keeps the shared rejection of a different or ambiguous native owner', () => {
    expect(() => reserve(path.join(cwd, 'other.md'))).toThrow('bound to its pending');
    native.permissionTools = [{ id: 'other', name: 'Bash', input: { command: 'echo other' } }];
    expect(() => reserve()).toThrow('multiple tools are pending');
    expect(granted.size).toBe(0);
  });
});

describe('autoplan announcements from the owned main transcript', () => {
  const sessionId = 'b4a90d12-0134-4ecf-9931-a2d453cc874a';
  const otherSession = '00000000-0000-4000-8000-000000000000';
  let configDir: string;
  const row = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant', isSidechain: false, sessionId,
    message: { role: 'assistant', content }, ...extra,
  }) + '\n';
  const text = (value: string) => [{ type: 'text', text: value }];
  const write = (source: string, project = 'fixture', id = sessionId) => {
    const file = path.join(configDir, 'projects', project, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  beforeEach(() => { configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-transcript-')); });
  afterEach(() => { fs.rmSync(configDir, { recursive: true, force: true }); });

  test('missing transcript stays pending, and an owned config and UUID are required', () => {
    expect(readAutoplanTranscript(configDir, sessionId)).toEqual({ file: null, phases: [], completedLines: 0, pendingBytes: 0 });
    expect(() => readAutoplanTranscript(null, sessionId)).toThrow('owned hermetic');
    expect(() => readAutoplanTranscript(configDir, '../other')).toThrow('UUID');
  });

  test('reads the captured assistant schema and canonical Markdown announcements', () => {
    // Same role/content shape and four lines as ship-phase-render-probe-attempt2.json.
    const file = write(row(text('**Phase 1 complete.**\n**Phase 2 complete.**\n> **Phase 2.5 complete.**\nPhase 3 complete.')));
    const observation = readAutoplanTranscript(configDir, sessionId);
    expect(observation).toEqual({ file, phases: [1, 2, 2.5, 3], completedLines: 1, pendingBytes: 0 });
    const visible = stripAnsi('\x1b[2CPhase\x1b[9G1\x1b[11Gcomplete.\nPhase2complete.\nPhase2.5complete.\nPhase3complete.');
    expect(corroboratedAutoplanPhases(observation.phases, visible)).toEqual([1, 2, 2.5, 3]);
  });

  test('tool inputs/results, thinking, user text, other sessions, and sidechains cannot announce phases', () => {
    const marker = '**Phase 3 complete.**';
    write([
      row([{ type: 'tool_use', input: { content: marker } }, { type: 'thinking', thinking: marker }]),
      row([{ type: 'tool_result', content: marker }]),
      row(text(marker), { type: 'user', message: { role: 'user', content: text(marker) } }),
      row(text(marker), { isSidechain: true }),
      row(text(marker), { parent_tool_use_id: 'child-call' }),
      row(text(marker), { sessionId: otherSession }),
      row(text(marker), { message: { role: 'user', content: text(marker) } }),
      row(text('**Phase 1 complete.**')),
    ].join(''));
    expect(readAutoplanTranscript(configDir, sessionId).phases).toEqual([1]);
  });

  test('quoted future markers and fenced or indented code are not announcements', () => {
    write(row(text([
      'I will print **Phase 3 complete.** later.',
      '"Phase 3 complete."',
      '```markdown', '**Phase 3 complete.**', '```',
      '~~~', 'Phase 4 complete.', '~~~',
      '    Phase 3 complete.',
      '**Phase 1 complete.** Codex: 2 concerns.',
    ].join('\n'))));
    expect(readAutoplanTranscript(configDir, sessionId).phases).toEqual([1]);
  });

  test('reads only the exact UUID in direct project directories, never subagents or other sessions', () => {
    write(row(text('Phase 3 complete.')), 'fixture', otherSession);
    write(row(text('Phase 3 complete.')), `fixture/${sessionId}/subagents`);
    expect(readAutoplanTranscript(configDir, sessionId).file).toBeNull();
    write(row(text('Phase 1 complete.')));
    expect(readAutoplanTranscript(configDir, sessionId).phases).toEqual([1]);
  });

  test('ambiguous exact-session files fail instead of selecting an arbitrary project', () => {
    write(row(text('Phase 1 complete.')), 'one');
    write(row(text('Phase 3 complete.')), 'two');
    expect(() => readAutoplanTranscript(configDir, sessionId)).toThrow('Ambiguous');
  });

  test.skipIf(process.platform === 'win32')('does not follow project or transcript symlinks', () => {
    const external = path.join(configDir, 'outside-projects');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, `${sessionId}.jsonl`), row(text('Phase 3 complete.')));
    const projects = path.join(configDir, 'projects');
    fs.mkdirSync(projects);
    fs.symlinkSync(external, path.join(projects, 'linked-project'), 'dir');
    expect(readAutoplanTranscript(configDir, sessionId).file).toBeNull();
    fs.mkdirSync(path.join(projects, 'fixture'));
    fs.symlinkSync(path.join(external, `${sessionId}.jsonl`), path.join(projects, 'fixture', `${sessionId}.jsonl`));
    expect(() => readAutoplanTranscript(configDir, sessionId)).toThrow('not a regular file');
  });

  test('partial final JSONL remains pending until its newline is written', () => {
    const final = row(text('Phase 3 complete.'));
    const split = Math.floor(final.length / 2);
    const file = write(row(text('Phase 1 complete.')) + final.slice(0, split));
    expect(readAutoplanTranscript(configDir, sessionId).phases).toEqual([1]);
    expect(readAutoplanTranscript(configDir, sessionId).pendingBytes).toBeGreaterThan(0);
    fs.appendFileSync(file, final.slice(split, -1));
    expect(readAutoplanTranscript(configDir, sessionId).phases).toEqual([1]);
    fs.appendFileSync(file, '\n');
    expect(readAutoplanTranscript(configDir, sessionId).phases).toEqual([1, 3]);
  });

  test('malformed completed JSONL fails with file/line diagnostics without exposing contents', () => {
    const file = write(row(text('Phase 1 complete.')) + '{"sensitive-fixture-data":broken}\n');
    expect(() => readAutoplanTranscript(configDir, sessionId)).toThrow(`${file}:2`);
    try { readAutoplanTranscript(configDir, sessionId); } catch (error) {
      expect(String(error)).not.toContain('sensitive-fixture-data');
    }
  });

  test('first assistant observation order and unknown phase errors are preserved', () => {
    write(row(text('Phase 1 complete.\nPhase 2.5 complete.\nPhase 2 complete.\nPhase 1 complete.\nPhase 3 complete.')));
    const phases = readAutoplanTranscript(configDir, sessionId).phases;
    expect(phases).toEqual([1, 2.5, 2, 3]);
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('optional Design (2), optional DX (2.5)');
    write(row(text('Phase 1 complete.\nPhase 4 complete.\nPhase 3 complete.')));
    expect(() => validateAutoplanPhaseOrder(readAutoplanTranscript(configDir, sessionId).phases)).toThrow();
  });

  test('failed chain retains exact owned commands and pending status after native cleanup', () => {
    const command = 'printf "Phase 3 complete."; codex exec "Review the design — café"';
    write(row([
      { type: 'thinking', thinking: 'private-reasoning', signature: 'private-signature' },
      { type: 'tool_use', id: 'design-command', name: 'Bash', input: { command, timeout: 600_000 } },
    ]));
    write(row([{ type: 'tool_use', id: 'foreign', name: 'Bash', input: { command: 'foreign-command' } }]), 'foreign', otherSession);
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-retained-'));
    try {
      const saved = retainAutoplanFailure({ configDir, sessionId, evalDir: destination,
        observation: { outcome: 'timeout', phases: [1] }, raw: () => '\x1b[2JRunning design command', visible: () => 'Running design command' });
      expect(saved).not.toBeNull();
      fs.rmSync(configDir, { recursive: true, force: true });
      const contents = fs.readFileSync(saved!, 'utf8');
      const record = JSON.parse(contents);
      expect(JSON.parse(record.calls[0].inputJson.text)).toEqual({ command, timeout: 600_000 });
      expect(record.calls[0].result).toBe('pending');
      expect(record.pendingIds[0].text).toBe('design-command');
      expect(JSON.parse(record.observation.text)).toEqual({ outcome: 'timeout', phases: [1] });
      expect(contents).not.toContain('private-reasoning');
      expect(contents).not.toContain('private-signature');
      expect(contents).not.toContain('foreign-command');
      expect(fs.statSync(saved!).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(destination, { recursive: true, force: true }); }
  });

  test('diagnostics preserve completed/error tools and mark partial input and native tails explicitly', () => {
    const command = 'x'.repeat(40_000);
    const calls = Array.from({ length: 20 }, (_, index) => ({ type: 'tool_use', id: `call-${index}`, name: 'Bash', input: { command } }));
    write(row(calls) + row([], { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-18', is_error: false },
      { type: 'tool_result', tool_use_id: 'call-19', is_error: true },
    ] } }) + '{"partial":');
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-retained-'));
    try {
      const saved = retainAutoplanFailure({ configDir, sessionId, evalDir: destination,
        observation: { outcome: 'timeout' }, raw: () => '界'.repeat(70_000), visible: () => 'partial input' });
      const record = JSON.parse(fs.readFileSync(saved!, 'utf8'));
      expect(record.pendingBytes).toBeGreaterThan(0);
      expect(record.calls).toHaveLength(16);
      expect(record.callsOmitted).toBe(4);
      expect(record.calls[0].inputJson.truncated).toBe(true);
      expect(record.calls.at(-1).result).toBe('error');
      expect(record.calls.at(-2).result).toBe('completed');
      expect(record.pendingCount).toBe(18);
      expect(record.rawCodeUnits).toBe(70_000);
      expect(record.rawTail.text.length).toBe(65_536);
      expect(record.rawTail.omittedPrefixCodeUnits).toBe(4_464);
      const before = fs.readFileSync(saved!, 'utf8');
      expect(retainAutoplanFailure({ configDir, sessionId, evalDir: destination,
        observation: null, raw: () => '', visible: () => '' })).toBeNull();
      expect(fs.readFileSync(saved!, 'utf8')).toBe(before);
    } finally { fs.rmSync(destination, { recursive: true, force: true }); }
  });

  test('diagnostic observation failure cannot replace the test outcome', () => {
    expect(retainAutoplanFailure({ configDir, sessionId, observation: { outcome: 'timeout' },
      raw: () => { throw new Error('terminal capture failed'); }, visible: () => '' })).toBeNull();
  });
});

describe('rendered corroboration of authoritative assistant announcements', () => {
  test('tool-only markers cannot complete the chain', () => {
    const visible = 'Bash(printf "Phase 1 complete. Phase 3 complete.")';
    expect(observedAutoplanPhases(visible)).toEqual([1, 3]);
    expect(corroboratedAutoplanPhases([], visible)).toEqual([]);
  });

  test('early Eng previews do not establish order or satisfy Eng visibility after CEO', () => {
    const preview = 'Read: Phase3complete.\n';
    expect(corroboratedAutoplanPhases([], preview)).toEqual([]);
    expect(corroboratedAutoplanPhases([1], preview + 'Phase1complete.')).toEqual([1]);
    expect(corroboratedAutoplanPhases([1, 3], preview + 'Phase1complete.')).toEqual([1]);
    expect(corroboratedAutoplanPhases([1, 3], preview + 'Phase1complete.\nPhase3complete.')).toEqual([1, 3]);
  });

  test('every announced optional phase must render, and a visible-only optional phase cannot alter order', () => {
    expect(corroboratedAutoplanPhases([1, 2, 2.5, 3], 'Phase1complete. Phase3complete.')).toEqual([1]);
    expect(corroboratedAutoplanPhases([1, 3], 'Phase2.5complete. Phase1complete. Phase3complete.')).toEqual([1, 3]);
  });

  test('valid-looking tool previews cannot launder a wrong assistant announcement order', () => {
    const assistant = [1, 2.5, 2, 3];
    const visible = 'Phase1complete. Phase2complete. Phase2.5complete. Phase3complete.\n'
      + 'Phase1complete. Phase2.5complete. Phase2complete. Phase3complete.';
    expect(corroboratedAutoplanPhases(assistant, visible)).toEqual(assistant);
    expect(() => validateAutoplanPhaseOrder(assistant)).toThrow();
  });
});

describe('autoplan completion markers from rendered output', () => {
  test('reads actual Claude 2.1.257 cursor-positioned output after ANSI stripping', () => {
    // Reduced from a real PTY capture; its saved assistant response contains
    // all four **Phase N complete.** lines, but the terminal omits the stars.
    const raw = '\x1b[2C\x1b[9BPhase\x1b[9G1\x1b[11Gcomplete.\n'
      + '\x1b[2C\x1b[1BPhase\x1b[9G2\x1b[11Gcomplete.\n'
      + '\x1b[2C\x1b[11BPhase\x1b[9G2.5\x1b[13Gcomplete.\n'
      + '\x1b[2C\x1b[12BPhase\x1b[9G3\x1b[11Gcomplete.';
    const visible = stripAnsi(raw);
    expect(visible).toBe('Phase1complete.\nPhase2complete.\nPhase2.5complete.\nPhase3complete.');
    expect(observedAutoplanPhases(visible)).toEqual([1, 2, 2.5, 3]);
  });

  test.each([
    'Phase 1 complete.\nPhase 3 complete.',
    '**Phase 1 complete.**\n**Phase 3 complete.**',
    '**Phase 1 complete**\n**Phase 3 complete**',
    'Phase1complete. Phase3complete.',
  ])('accepts plain, Markdown, and compacted markers: %s', visible => {
    expect(observedAutoplanPhases(visible)).toEqual([1, 3]);
  });

  test('keeps decimal DX, duplicates, and actual match order within one poll', () => {
    expect(observedAutoplanPhases('Phase2.5complete. Phase 2 complete. Phase2.5complete.'))
      .toEqual([2.5, 2, 2.5]);
  });

  test.each([
    'SubPhase1complete.',
    'pre_Phase 1 complete.',
    'Phase1completed.',
    'Phase 1 completeness.',
    'Phase1complete_more',
    'Phase 1 incomplete.',
    'Phase 3',
    'Phase3 pending completion.',
    'Reply with word Phase, then number 3, then word complete.',
  ])('rejects incomplete markers and unrelated words: %s', visible => {
    expect(observedAutoplanPhases(visible)).toEqual([]);
  });

  test('retains unknown phases for the order validator to reject', () => {
    const phases = observedAutoplanPhases('Phase1complete. Phase4complete. Phase3complete.');
    expect(phases).toEqual([1, 4, 3]);
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow();
  });

  test('extraction does not sort a reversed Design/DX stream into valid order', () => {
    const phases = observedAutoplanPhases('Phase1complete. Phase2.5complete. Phase2complete. Phase3complete.');
    expect(phases).toEqual([1, 2.5, 2, 3]);
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('optional Design (2), optional DX (2.5)');
  });
});

describe('autoplan completion order from the observed stream', () => {
  test('a correctly ordered same-poll batch passes even when timestamps are identical', () => {
    const hits = [1, 2, 2.5, 3].map(phase => ({ phase, ts: 1234 }));
    expect(() => validateAutoplanPhaseOrder(hits.map(hit => hit.phase))).not.toThrow();
  });

  test.each([
    [1, 3],
    [1, 2, 3],
    [1, 2.5, 3],
  ].map(phases => ({ phases })))('optional phases may be absent: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).not.toThrow();
  });

  test.each([
    [],
    [1],
    [3],
    [2, 2.5],
  ].map(phases => ({ phases })))('missing required completion fails: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('requires CEO (1) and Eng (3)');
  });

  test.each([
    [3, 1],
    [2, 1, 3],
    [2.5, 1, 3],
  ].map(phases => ({ phases })))('inverted required or preceding optional phases fail: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow();
  });

  test('Design must precede DX when both completed', () => {
    expect(() => validateAutoplanPhaseOrder([1, 2.5, 2, 3])).toThrow('optional Design (2), optional DX (2.5)');
  });

  test.each([
    [1, 3, 2],
    [1, 3, 2.5],
  ].map(phases => ({ phases })))('Eng cannot precede a later completed phase: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('Eng (3) must complete last');
  });

  test.each([
    [1, 2, 2, 3],
    [1, 4, 3],
  ].map(phases => ({ phases })))('duplicate or unknown first-observation markers fail: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow();
  });
});
