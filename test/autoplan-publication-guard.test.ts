import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializePlan, prepareMethodology, createSnapshot, preparePhaseClose } from '../bin/gstack-autoplan-snapshot';
import { evaluateAutoplanPublication, runPublicationHook, type PublicationHookInput } from '../autoplan/bin/phase-publication-hook.ts';
import { readOwnedClaudePublicTranscript, type ClaudeParentPublicEvent } from '../lib/claude-public-transcript';
import { prematureAutoplanPhaseEntry } from './helpers/autoplan-method-read-audit';
import captured from './fixtures/autoplan-publication-boundary-361c.json';

const ROOT = fs.realpathSync(path.join(import.meta.dir, '..'));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const phaseNumber = { ceo: 1, design: 2, dx: 2.5, eng: 3 };
type Phase = keyof typeof phaseNumber;
const clock = Date.parse('2026-09-17T04:00:00Z');

function fixture(phase: Phase = 'ceo', next = 'design') {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'autoplan-publication-'))); dirs.push(cwd);
  const source = path.join(cwd, 'source.md'), active = path.join(cwd, 'active.md'), restore = path.join(cwd, 'restore.md');
  fs.writeFileSync(source, '# Current plan\nKeep documented behavior.\n');
  const init = initializePlan(source, active, restore);
  const skill = path.join(cwd, 'SKILL.md');
  fs.writeFileSync(skill, `---\nname: plan-${phase === 'dx' ? 'devex' : phase}-review\n---\n## Review Sections\nApply every current review criterion.\n`);
  const method = prepareMethodology(phase, skill, restore).methodologyPath;
  const checkpoint = createSnapshot(phase, active, restore, method).snapshotPath;
  fs.appendFileSync(active, `<!-- autoplan-accepted:${phase} -->\nNone: retain the current behavior.\n<!-- /autoplan-accepted:${phase} -->\n`);
  const packet = preparePhaseClose(phase, active, checkpoint, restore, method);
  const sessionId = randomUUID(), events: ClaudeParentPublicEvent[] = [];
  const add = (event: any) => {
    const full = { sessionId, timestamp: new Date(clock + events.length).toISOString(), order: events.length, ...event };
    events.push(full); return full;
  };
  const use = (id: string, name: string, input: object) => add({ kind: 'use', toolUseId: id, name, input });
  const result = (id: string, extra: object) => add({ kind: 'result', toolUseId: id, isError: false, ...extra });
  const read = (id: string, file: string, offset = 1, limit?: number) => {
    const text = fs.readFileSync(fs.realpathSync(file), 'utf8'), lines = text.split('\n');
    const count = Math.min(limit ?? lines.length, lines.length - offset + 1);
    use(id, 'Read', { file_path: file, offset, ...(limit === undefined ? {} : { limit }) });
    result(id, { file: { filePath: file, content: lines.slice(offset - 1, offset - 1 + count).join('\n'),
      startLine: offset, numLines: count, totalLines: lines.length } });
  };
  use('init', 'Bash', { command: `cd '${cwd}'\nbun "${ROOT}/bin/gstack-autoplan-snapshot.ts" init \\\n "${source}" "${active}" "${restore}"` });
  result('init', { content: JSON.stringify(init) });
  read('entry', path.join(ROOT, 'autoplan', 'sections', `${phase}-phase.md`));
  read('close', packet.closePacketPath);
  const message = (text = `Phase ${phaseNumber[phase]} complete.`) => add({ kind: 'message', text });
  const target = path.join(ROOT, 'autoplan', 'sections', next === 'tasks' ? 'tasks-aggregator.md' : `${next}-phase.md`);
  const input: PublicationHookInput = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd,
    transcript_path: path.join(cwd, 'config', 'projects', 'fixture', `${sessionId}.jsonl`),
    tool_name: 'Read', tool_use_id: 'next', tool_input: { file_path: target } };
  const current = () => use('next', 'Read', input.tool_input);
  const evaluate = () => evaluateAutoplanPublication(input, ROOT, events);
  const reorder = () => events.forEach((e, i) => { e.order = i; });
  const journal = () => {
    fs.mkdirSync(path.dirname(input.transcript_path), { recursive: true });
    let parent: string | null = null;
    const record = (role: string, content: unknown, extra: object = {}) => {
      const uuid = randomUUID(); const r = { uuid, parentUuid: parent, cwd, sessionId, isSidechain: false,
        timestamp: new Date(clock).toISOString(), type: role, message: { role, content }, ...extra };
      parent = uuid; return r;
    };
    const rows = [record('user', '<command-message>autoplan</command-message>\n<command-name>/autoplan</command-name>',
      { origin: { kind: 'human' }, promptId: randomUUID() })];
    for (const e of events) {
      if (e.kind === 'use') rows.push(record('assistant', [{ type: 'tool_use', id: e.toolUseId, name: e.name, input: e.input }], { timestamp: e.timestamp }));
      else if (e.kind === 'result') rows.push(record('user', [{ type: 'tool_result', tool_use_id: e.toolUseId,
        content: e.content ?? 'Read complete.', is_error: e.isError }], { timestamp: e.timestamp, toolUseResult: { file: e.file } }));
      else if (e.kind === 'message') rows.push(record('assistant', [{ type: 'text', text: e.text }], { timestamp: e.timestamp }));
    }
    fs.writeFileSync(input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    return { rows, record };
  };
  return { cwd, source, active, restore, init, method, checkpoint, packet, sessionId, events, input,
    add, use, result, read, message, current, evaluate, reorder, journal };
}

describe('Autoplan parent publication guard', () => {
  for (const [phase, next] of [['ceo', 'design'], ['design', 'dx'], ['design', 'eng'], ['dx', 'eng'], ['eng', 'tasks']] as const) {
    test(`${phase} closes before ${next}; only the parent publication unlocks entry`, () => {
      const f = fixture(phase, next); f.current();
      expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled') });
      f.events.pop(); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    });
  }

  for (const capture of captured.cases) test(`original ${capture.phase} omission remains a failure through the complete guard adapter`, () => {
    const next = capture.native.next[0] as any, ack = capture.native.next[1] as any;
    const close = capture.native.close[1] as any;
    expect(close.file.startLine).toBe(1); expect(close.file.numLines).toBe(close.file.totalLines);
    const actualTranscript = { status: 'ready' as const, calls: [], assistantMessages: capture.messages };
    expect(prematureAutoplanPhaseEntry([...capture.native.close, ...capture.native.next] as any, actualTranscript,
      [{ phase: capture.nextPhase as any, requiredPhase: phaseNumber[capture.phase as Phase] as any,
        paths: [next.input.file_path], content: ack.file.content }], 0)).toMatchObject({ readToolUseId: next.toolUseId });
    // Explicit adapter: current filesystem identities come from actual snapshot
    // APIs. Every captured parent message remains complete and unchanged; no
    // original artifact or paid outcome is rewritten to manufacture a success.
    const f = fixture(capture.phase as Phase, capture.nextPhase);
    const nativeInit: any = capture.native.init[0], initResult = JSON.parse((capture.native.init[1] as any).content);
    (f.events[0] as any).input.command = nativeInit.input.command
      .replace('/home/vercel-sandbox/gstack/bin/gstack-autoplan-snapshot.ts', `${ROOT}/bin/gstack-autoplan-snapshot.ts`)
      .replace(initResult.sourcePlan, f.source).replace(initResult.activePlan, f.active).replace(initResult.restorePath, f.restore);
    [...capture.native.init, ...capture.native.entry, ...capture.native.close].forEach((e, i) => { f.events[i]!.timestamp = e.timestamp; });
    for (const m of capture.messages) f.add({ kind: 'message', text: m.text, timestamp: m.timestamp });
    f.events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); f.reorder();
    const closeOrder = f.events.find(e => e.kind === 'result' && e.toolUseId === 'close')!.order;
    expect(capture.messages.filter(m => m.timestamp > close.timestamp && m.timestamp < next.timestamp)).toEqual([]);
    f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled') });
    f.events.pop(); f.message(`Phase ${phaseNumber[capture.phase as Phase]} complete.`); f.current();
    expect(f.events.filter(e => e.kind === 'message').at(-1)!.order).toBeGreaterThan(closeOrder);
    expect(f.evaluate()).toEqual({ allow: true }); // Counterfactual recovery only.
    expect(capture.behaviorCredit).toBe(0);
  });

  for (const text of ['Phase 2 complete.', 'Phase 1 will be complete.', 'Phase 1 complete if the reviewer succeeds.',
    '> Phase 1 complete.', '```\nPhase 1 complete.\n```', '    Phase 1 complete.', 'Example:\nPhase 1 complete.',
    'Phase 1 is not complete.', 'Phase 1 complete with all review work finished.\nCorrection: this phase is withdrawn.']) {
    test(`does not use noncurrent publication: ${JSON.stringify(text)}`, () => {
      const f = fixture(); f.message(text); f.current(); expect(f.evaluate().allow).toBe(false);
    });
  }

  for (const mutation of ['no-close', 'partial-close', 'error-close', 'missing-ack', 'foreign-session', 'duplicate-use',
    'pre-close-publication', 'after-current-publication', 'changed-plan', 'mutable-packet', 'aliased-packet', 'wrong-init',
    'failed-init', 'missing-init', 'forged-init-command', 'wrong-restore', 'pending-phase', 'ambiguous-order'] as const) {
    test(`rejects ${mutation}`, () => {
      const f = fixture(); f.message(); f.current();
      if (mutation === 'no-close') f.events.splice(4, 2);
      if (mutation === 'partial-close') (f.events[5] as any).file.numLines--;
      if (mutation === 'error-close') (f.events[5] as any).isError = true;
      if (mutation === 'missing-ack') f.events.splice(5, 1);
      if (mutation === 'foreign-session') f.events[6]!.sessionId = randomUUID();
      if (mutation === 'duplicate-use') f.events.splice(5, 0, structuredClone(f.events[4]!));
      if (mutation === 'pre-close-publication') f.events.splice(4, 0, ...f.events.splice(6, 1));
      if (mutation === 'after-current-publication') f.events.push(...f.events.splice(6, 1));
      if (mutation === 'changed-plan') fs.writeFileSync(f.active, fs.readFileSync(f.active, 'utf8').replace('Keep documented behavior.', 'Change behavior.'));
      if (mutation === 'mutable-packet') fs.chmodSync(f.packet.closePacketPath, 0o644);
      if (mutation === 'aliased-packet') { const alias = path.join(f.cwd, 'packet'); fs.renameSync(f.packet.closePacketPath, alias); fs.symlinkSync(alias, f.packet.closePacketPath); }
      if (mutation === 'wrong-init') (f.events[1] as any).content = JSON.stringify({ ...f.init, activePlan: f.source });
      if (mutation === 'failed-init') (f.events[1] as any).isError = true;
      if (mutation === 'missing-init') f.events.splice(0, 2);
      if (mutation === 'forged-init-command') (f.events[0] as any).input.command = `printf '${JSON.stringify(f.init)}'`;
      if (mutation === 'wrong-restore') { fs.chmodSync(f.restore, 0o600); fs.writeFileSync(f.restore, 'foreign'); fs.chmodSync(f.restore, 0o400); }
      if (mutation === 'pending-phase') f.events.splice(6, 0, { ...(f.events[7] as any), toolUseId: 'parallel' });
      f.reorder(); if (mutation === 'ambiguous-order') f.events[5]!.order = f.events[4]!.order;
      expect(f.evaluate().allow).toBe(false);
    });
  }

  test('split successful close ranges through EOF are sufficient', () => {
    const f = fixture(); f.events.splice(4, 2); f.read('part1', f.packet.closePacketPath, 1, 10);
    f.read('part2', f.packet.closePacketPath, 11); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
  });
  test('a later incomplete close supersedes the earlier complete close and publication', () => {
    const f = fixture(); f.message();
    const newer = preparePhaseClose('ceo', f.active, f.checkpoint, f.restore, f.method);
    f.read('new-close', newer.closePacketPath, 1, 1); f.current(); expect(f.evaluate().allow).toBe(false);
  });
  test('an ordinary foreign close-packet filename cannot supersede the owned phase close', () => {
    const f = fixture(), foreign = path.join(f.cwd, 'project', 'close-packet.md');
    fs.mkdirSync(path.dirname(foreign)); fs.writeFileSync(foreign, 'Ordinary project data.\n');
    f.read('unrelated', foreign); f.message(); f.current(); expect(f.evaluate()).toEqual({ allow: true });
    f.events.splice(4, 2); f.reorder();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Finish the existing Phase 1 close procedure') });
  });
  test('a malformed later packet inside the owned phase still invalidates old publication', () => {
    const f = fixture(); f.message();
    const dir = fs.mkdtempSync(path.join(f.cwd, 'autoplan-ceo-')), packet = path.join(dir, 'close-packet.md');
    fs.writeFileSync(packet, 'Malformed current packet.\n', { mode: 0o444 });
    f.read('malformed-owned', packet); f.current(); expect(f.evaluate().allow).toBe(false);
  });
  for (const outcome of ['success', 'pending', 'failed'] as const) test(`active plan mutation after close: ${outcome}`, () => {
    const f = fixture(); f.message(); f.use('late-edit', 'Edit', { file_path: f.active, old_string: 'current', new_string: 'changed' });
    if (outcome !== 'pending') f.result('late-edit', { isError: outcome === 'failed', content: outcome });
    f.current(); expect(f.evaluate().allow).toBe(outcome === 'failed');
  });
  test('a new initialization excludes earlier phase publications', () => {
    const f = fixture(); f.message();
    // Same initialized plan can be a new source, but a new external restore
    // identity is required by the actual init API. No old completion carries.
    const active = path.join(f.cwd, 'new-active.md'), restore = path.join(f.cwd, 'new-restore.md');
    const init = initializePlan(f.source, active, restore);
    f.use('new-init', 'Bash', { command: `bun "${ROOT}/bin/gstack-autoplan-snapshot.ts" init "${f.source}" "${active}" "${restore}"` });
    f.result('new-init', { content: JSON.stringify(init) });
    f.read('new-entry', path.join(ROOT, 'autoplan/sections/ceo-phase.md')); f.current();
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Finish the existing Phase 1 close procedure') });
  });
  for (const field of ['methodology', 'checkpoint', 'packet-phase'] as const) test(`a ${field} identity from another invocation cannot grant entry`, () => {
    const f = fixture(); f.message(); f.current();
    if (field === 'methodology') {
      const file = path.join(path.dirname(f.method), 'methodology.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.restorePath = f.source; fs.chmodSync(file, 0o644); fs.writeFileSync(file, JSON.stringify(manifest) + '\n'); fs.chmodSync(file, 0o444);
    } else if (field === 'checkpoint') {
      fs.chmodSync(f.checkpoint, 0o644); fs.writeFileSync(f.checkpoint, 'different baseline'); fs.chmodSync(f.checkpoint, 0o444);
    } else {
      const file = f.packet.closePacketPath; fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"phase":"ceo"', '"phase":"design"')); fs.chmodSync(file, 0o444);
    }
    expect(f.evaluate().allow).toBe(false);
  });
  test('same-phase and ordinary methodology reads do not require a close', () => {
    const f = fixture(); f.events.splice(4, 2); f.input.tool_input.file_path = path.join(ROOT, 'autoplan/sections/ceo-phase.md');
    f.current(); expect(f.evaluate()).toEqual({ allow: true });
    f.input.tool_input.file_path = f.method; expect(f.evaluate()).toEqual({ allow: true });
  });
  test('installed symlink identity is accepted, a different installation is denied', () => {
    const f = fixture(); f.message();
    const registry = path.join(f.cwd, 'registry'); fs.mkdirSync(registry); fs.symlinkSync(path.join(ROOT, 'autoplan'), path.join(registry, 'autoplan'));
    f.input.tool_input.file_path = path.join(registry, 'autoplan/sections/design-phase.md'); f.current(); expect(f.evaluate().allow).toBe(true);
    fs.unlinkSync(path.join(registry, 'autoplan')); fs.mkdirSync(path.join(registry, 'autoplan/sections'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'autoplan/sections/design-phase.md'), f.input.tool_input.file_path as string);
    expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('different or unavailable installation') });
  });
  test('an explicit child is outside parent publication authority', () => {
    const f = fixture(); f.current(); f.input.agent_id = 'reviewer-child'; expect(f.evaluate()).toEqual({ allow: true });
  });
  test('same native timestamp still uses append order for report then Read', () => {
    const f = fixture(); f.message(); f.current(); f.events.forEach(e => { e.timestamp = new Date(clock).toISOString(); });
    expect(f.evaluate()).toEqual({ allow: true });
  });
  test('a terminal turn followed by an authenticated new human request releases the old invocation', () => {
    const f = fixture(); f.add({ kind: 'end_turn' }); f.add({ kind: 'user_turn', autoplan: false }); f.current();
    expect(f.evaluate()).toEqual({ allow: true });
    (f.events[7] as any).autoplan = true; expect(f.evaluate().allow).toBe(false);
  });
  test('end_turn alone and metadata-free tool results cannot release the invocation', () => {
    const f = fixture(); f.add({ kind: 'end_turn' }); f.result('other', { content: 'continue' }); f.current();
    expect(f.evaluate().allow).toBe(false);
  });
  test('a real same-restore init re-arms without erasing an outstanding publication', () => {
    const f = fixture(); f.add({ kind: 'end_turn' }); f.add({ kind: 'user_turn', autoplan: false });
    f.use('re-init', 'Bash', (f.events[0] as any).input); f.result('re-init', { content: JSON.stringify({ ...f.init, reused: true }) });
    f.current(); expect(f.evaluate()).toMatchObject({ allow: false, reason: expect.stringContaining('Publish the filled') });
  });

  test('the actual owned native reader and asynchronous hook admit a flushed same-response report', async () => {
    const f = fixture(); f.message(); f.current();
    setTimeout(() => f.journal(), 100);
    expect(await runPublicationHook(f.input, ROOT)).toEqual({});
    const decoded = readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId);
    expect(decoded.transcript.status).toBe('ready');
    const report = decoded.events.find(e => e.kind === 'message')!, current = decoded.events.find(e => e.kind === 'use' && e.toolUseId === 'next')!;
    expect(report.order).toBeLessThan(current.order);
  });
  test('owned reader refuses a symlink and incomplete current record', async () => {
    const f = fixture(); f.message(); f.current(); f.journal();
    const bytes = fs.readFileSync(f.input.transcript_path, 'utf8'); fs.writeFileSync(f.input.transcript_path, bytes.slice(0, -1));
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).events.some(e => e.kind === 'use' && e.toolUseId === 'next')).toBe(false);
    const other = path.join(f.cwd, 'other.jsonl'); fs.renameSync(f.input.transcript_path, other); fs.symlinkSync(other, f.input.transcript_path);
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).transcript.status).toBe('error');
  });

  for (const kind of ['human', 'missing-origin', 'meta', 'tool-result', 'no-end-turn', 'compact-summary'] as const)
    test(`native lifecycle projection: ${kind}`, async () => {
      const f = fixture(), { rows, record } = f.journal();
      if (kind !== 'no-end-turn') rows.push(record('assistant', [{ type: 'text', text: 'Work ended.' }], {
        message: { role: 'assistant', id: 'msg_terminal', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Work ended.' }] },
      }));
      rows.push(record('system', undefined, { type: 'system', subtype: 'turn_duration', message: undefined }));
      const user = record('user', 'Read the driver for a new unrelated task.', {
        origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID(),
      }) as any;
      if (kind === 'missing-origin') delete user.origin;
      if (kind === 'meta') user.isMeta = true;
      if (kind === 'tool-result') { delete user.origin; user.message.content = [{ type: 'tool_result', tool_use_id: 'answer', content: 'Continue' }]; }
      if (kind === 'compact-summary') { delete user.origin; user.isMeta = true; user.message.content = 'Phase 1 complete.'; }
      rows.push(user, record('assistant', [{ type: 'tool_use', id: 'next', name: 'Read', input: f.input.tool_input }]));
      fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
      const decoded = readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId);
      expect(decoded.events.filter(e => e.kind === 'user_turn')).toHaveLength(kind === 'human' || kind === 'no-end-turn' ? 2 : 1);
      const result: any = await runPublicationHook(f.input, ROOT);
      if (kind === 'human') expect(result).toEqual({});
      else expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

  test('compaction keeps real parent ancestry; its summary supplies no publication', async () => {
    const f = fixture(), { rows, record } = f.journal();
    const prior = rows.at(-1)!;
    const boundary: any = record('system', undefined, { type: 'system', subtype: 'compact_boundary', parentUuid: null,
      logicalParentUuid: prior.uuid, message: undefined });
    rows.push(boundary, record('user', 'Phase 1 complete.', { isMeta: true }));
    const current: any = record('assistant', [{ type: 'tool_use', id: 'next', name: 'Read', input: f.input.tool_input }]);
    rows.push(current); fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    const before: any = await runPublicationHook(f.input, ROOT); expect(before.hookSpecificOutput?.permissionDecision).toBe('deny');
    // A real publication follows the retained close ACK, even with compaction.
    const message: any = { ...current, uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'Phase 1 complete.' }] } };
    current.parentUuid = message.uuid; rows.splice(-1, 0, message);
    fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(await runPublicationHook(f.input, ROOT)).toEqual({});
    boundary.logicalParentUuid = randomUUID();
    fs.writeFileSync(f.input.transcript_path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(readOwnedClaudePublicTranscript(f.input.transcript_path, f.cwd, f.sessionId).events.some(e => e.kind === 'use' && e.toolUseId === 'next')).toBe(false);
  });
});
