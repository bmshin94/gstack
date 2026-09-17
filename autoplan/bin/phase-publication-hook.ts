#!/usr/bin/env bun
/** A native parent publication barrier at Autoplan's exact Read boundaries. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { extractImplementationPlan } from '../../bin/gstack-autoplan-snapshot';
import { autoplanPhaseCompletions } from '../../lib/autoplan-phase-publication';
import { readOwnedClaudePublicTranscript, type ClaudeParentPublicEvent } from '../../lib/claude-public-transcript';

const PHASES = ['ceo', 'design', 'dx', 'eng', 'tasks'] as const;
type Phase = typeof PHASES[number];
type Event = ClaudeParentPublicEvent;
type Use = Event & { kind: 'use' };
const number: Record<Phase, number> = { ceo: 1, design: 2, dx: 2.5, eng: 3, tasks: 4 };
const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const ownPath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
class BoundaryError extends Error {}
const fail = (reason: string): never => { throw new BoundaryError(reason); };
export interface PublicationHookInput {
  hook_event_name: 'PreToolUse'; session_id: string; transcript_path: string; cwd: string;
  tool_name: string; tool_use_id: string; tool_input: Record<string, unknown>; agent_id?: string | null;
}
export type PublicationDecision = { allow: true } | { allow: false; reason: string };
interface Invocation { activePlan: string; restorePath: string; originalSha256: string; start: number }

/** Stable, bounded regular bytes; links never establish an artifact identity. */
function read(file: string, immutable = false): string {
  if (!ownPath(file) || fs.realpathSync(file) !== file) fail('Artifact path is unavailable or aliased.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 32n * 1024n * 1024n ||
        (immutable && process.platform !== 'win32' && (before.mode & 0o222n) !== 0n)) fail('Artifact is not immutable bounded data.');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.size !== current.size ||
        before.mtimeNs !== current.mtimeNs || before.size !== BigInt(bytes.length)) fail('Artifact changed during read.');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('Artifact is not complete UTF-8.');
    return text;
  } finally { fs.closeSync(fd); }
}

function phaseName(file: unknown, cwd: string): Phase | undefined {
  if (typeof file !== 'string') return;
  const requested = path.resolve(cwd, file);
  const name = /^((?:ceo|design|dx|eng)-phase|tasks-aggregator)\.md$/.exec(path.basename(requested));
  if (!name || path.basename(path.dirname(requested)) !== 'sections' ||
      path.basename(path.dirname(path.dirname(requested))) !== 'autoplan') return;
  return (name[1] === 'tasks-aggregator' ? 'tasks' : name[1]!.split('-')[0]) as Phase;
}

function driver(file: unknown, cwd: string, root: string): Phase | undefined {
  const phase = phaseName(file, cwd);
  if (!phase) return;
  const requested = path.resolve(cwd, file as string);
  const canonical = path.join(root, 'autoplan', 'sections', path.basename(requested));
  if (fs.realpathSync(requested) !== canonical || fs.realpathSync(canonical) !== canonical)
    fail('Autoplan phase entry belongs to a different or unavailable installation. Restore this invocation’s hook installation before retrying.');
  return phase;
}

function textResult(event: Event): string | undefined {
  if (event.kind !== 'result' || event.isError !== false) return;
  if (typeof event.content === 'string') return event.content;
  if (Array.isArray(event.content) && event.content.length === 1 && event.content[0]?.type === 'text' &&
      typeof event.content[0].text === 'string') return event.content[0].text;
}

/** Only the documented literal init argv, optionally after literal cd. No shell evaluation. */
function initArguments(command: unknown, root: string): string[] | undefined {
  if (typeof command !== 'string') return;
  const literal = String.raw`(?:"[^"\n\r$\x60\\]*"|'[^'\n\r]*'|[^\s"'\\$\x60;&|<>]+)`;
  const normalized = command.replace(/\\\r?\n/g, ' ');
  const match = new RegExp(String.raw`^\s*(?:cd\s+${literal}\s*(?:\n|&&)\s*)?(?:bun|${literal}/bun)\s+(${literal})\s+init\s+(${literal})\s+(${literal})\s+(${literal})\s*$`).exec(normalized);
  if (!match) return;
  const args = match.slice(1).map(x => /^["']/.test(x!) ? x!.slice(1, -1) : x!);
  if (!args.every(ownPath) || fs.realpathSync(args[0]!) !== path.join(root, 'bin', 'gstack-autoplan-snapshot.ts')) return;
  return args.slice(1);
}

function invocation(events: Event[], root: string): Invocation {
  let bound: Invocation | undefined;
  let chosen: Record<string, any> | undefined;
  for (const use of events) {
    if (use.kind !== 'use' || use.name !== 'Bash') continue;
    const args = initArguments(use.input?.command, root);
    if (!args) continue;
    const results = events.filter(x => x.kind === 'result' && x.toolUseId === use.toolUseId && x.order > use.order);
    if (results.length !== 1) fail('Autoplan initialization acknowledgment is unavailable or ambiguous.');
    const text = textResult(results[0]!);
    if (text === undefined) fail('Autoplan initialization did not succeed. Complete the existing init step first.');
    const result = JSON.parse(text);
    if (!object(result) || result.sourcePlan !== fs.realpathSync(args[0]!) || result.activePlan !== args[1] ||
        result.restorePath !== args[2] || typeof result.reused !== 'boolean' || !positive(result.originalBytes) ||
        !/^[a-f0-9]{64}$/.test(result.originalSha256)) fail('Autoplan initialization does not match the successful native request.');
    if (result.reused && bound?.activePlan === result.activePlan && bound.restorePath === result.restorePath) continue;
    chosen = result;
    bound = { activePlan: result.activePlan, restorePath: result.restorePath,
      originalSha256: result.originalSha256, start: results[0]!.order };
  }
  if (!chosen || !bound) fail('Autoplan invocation evidence is unavailable. Complete the existing snapshot init step before phase entry.');
  const restore = read(bound.restorePath, true), active = read(bound.activePlan);
  const reference = JSON.stringify(bound.restorePath).replace(/--/g, '\\u002d\\u002d');
  if (hash(restore) !== bound.originalSha256 || Buffer.byteLength(restore) !== chosen.originalBytes ||
      !active.startsWith(`<!-- /autoplan restore point: ${reference} -->\n`) || bound.activePlan === bound.restorePath)
    fail('Autoplan initialization artifacts do not match this parent invocation.');
  return bound;
}

function delivered(use: Use, result: Event, content: string): { start: number; end: number } | undefined {
  if (result.kind !== 'result' || result.isError !== false || result.order <= use.order || !object(result.file)) return;
  const f = result.file, lines = content.split('\n');
  if (f.filePath !== use.input?.file_path || typeof f.content !== 'string' || !positive(f.startLine) || !positive(f.numLines) ||
      f.totalLines !== lines.length || f.startLine + f.numLines - 1 > lines.length || (use.input?.offset ?? 1) !== f.startLine ||
      (use.input?.limit !== undefined && (!positive(use.input.limit) || f.numLines > use.input.limit)) ||
      f.content !== lines.slice(f.startLine - 1, f.startLine - 1 + f.numLines).join('\n')) return;
  return { start: f.startLine, end: f.startLine + f.numLines - 1 };
}

function closePacket(file: string, phase: Phase, init: Invocation): string {
  const directory = path.dirname(file), stateRoot = path.dirname(init.restorePath);
  if (path.basename(file) !== 'close-packet.md' || path.dirname(directory) !== stateRoot ||
      !path.basename(directory).startsWith(`autoplan-${phase}-`)) fail('Close packet does not belong to the current phase.');
  const content = read(file, true), binding = JSON.parse(/^Binding: (.+)$/m.exec(content)?.[1] ?? 'null');
  const snapshot = JSON.parse(read(path.join(directory, 'snapshot.json'), true));
  if (!object(binding) || binding.phase !== phase || binding.activePlan !== init.activePlan ||
      binding.reviewInputPath !== path.join(directory, `${phase}-implementation.md`) ||
      binding.report?.number !== String(number[phase]) || snapshot.schemaVersion !== 2 || snapshot.phase !== phase ||
      snapshot.activePlan !== init.activePlan || snapshot.snapshotPath !== binding.reviewInputPath ||
      snapshot.sha256 !== binding.reviewInputSha256 || snapshot.sourceSha256 !== binding.sourceSha256 ||
      hash(read(binding.reviewInputPath, true)) !== binding.reviewInputSha256 ||
      snapshot.sourceSnapshotPath !== path.join(directory, 'source-implementation.md') ||
      hash(read(snapshot.sourceSnapshotPath, true)) !== binding.sourceSha256 ||
      hash(extractImplementationPlan(read(init.activePlan))) !== binding.sourceSha256)
    fail('Close packet no longer matches the current phase input. Finish the existing close procedure with a fresh packet.');
  const checkpoint = binding.checkpointPath;
  if (!ownPath(checkpoint) || path.dirname(path.dirname(checkpoint)) !== stateRoot ||
      !path.basename(path.dirname(checkpoint)).startsWith(`autoplan-${phase}-`) || path.basename(checkpoint) !== `${phase}-implementation.md`)
    fail('Close checkpoint is foreign.');
  const prior = JSON.parse(read(path.join(path.dirname(checkpoint), 'snapshot.json'), true));
  if (prior.phase !== phase || prior.activePlan !== init.activePlan || prior.snapshotPath !== checkpoint ||
      prior.sha256 !== hash(read(checkpoint, true))) fail('Close checkpoint identity is unavailable.');
  const methodology = snapshot.methodology;
  if (!object(methodology) || !ownPath(methodology.methodologyPath) ||
      path.dirname(path.dirname(methodology.methodologyPath)) !== stateRoot ||
      !path.basename(path.dirname(methodology.methodologyPath)).startsWith(`autoplan-${phase}-`)) fail('Close methodology is foreign.');
  const manifestBytes = read(path.join(path.dirname(methodology.methodologyPath), 'methodology.json'), true);
  const manifest = JSON.parse(manifestBytes);
  if (hash(manifestBytes) !== methodology.manifestSha256 || manifest.phase !== phase ||
      manifest.restorePath !== init.restorePath || manifest.restoreSha256 !== init.originalSha256 ||
      manifest.methodologyPath !== methodology.methodologyPath || manifest.sha256 !== methodology.sha256 ||
      hash(read(methodology.methodologyPath, true)) !== methodology.sha256) fail('Close methodology belongs to a different invocation.');
  return content;
}

/** Ordered public events only. This does not judge review content or create a report. */
export function evaluateAutoplanPublication(input: PublicationHookInput, root: string, events: Event[]): PublicationDecision {
  try {
    const targetName = phaseName(input.tool_input.file_path, input.cwd);
    if (!targetName || input.agent_id) return { allow: true };
    if (!events.length || events.some((e, i) => e.sessionId !== input.session_id || !Number.isSafeInteger(e.order) ||
        (i > 0 && e.order <= events[i - 1]!.order))) fail('Native parent event order is unavailable. Retry this Read after the journal is available.');
    const identities = new Set<string>();
    for (const event of events) if (event.kind === 'use' || event.kind === 'result') {
      const identity = `${event.kind}:${event.toolUseId}`;
      if (identities.has(identity)) fail('Native tool identity is ambiguous. Restore the current parent evidence before retrying.');
      identities.add(identity);
    }
    const current = events.filter(e => e.kind === 'use' && e.toolUseId === input.tool_use_id);
    if (current.length !== 1 || current[0]!.kind !== 'use' || current[0]!.name !== 'Read' ||
        !isDeepStrictEqual(current[0]!.input, input.tool_input)) fail('Current native Read identity is unavailable. Retry this Read after the journal is available.');
    const before = events.filter(e => e.order < current[0]!.order);
    // Pinned Claude retains skill hooks after end_turn. Only an authenticated
    // later human request can release the old invocation; tool results and
    // compaction never do. A native slash or an actual init re-arms the guard.
    const human = before.filter(e => e.kind === 'user_turn').at(-1);
    const ended = human && before.some(e => e.kind === 'end_turn' && e.order < human.order);
    const laterInit = human && before.some(e => e.kind === 'use' && e.name === 'Bash' && e.order > human.order &&
      initArguments(e.input?.command, root));
    if (ended && !human.autoplan && !laterInit) return { allow: true };
    const target = driver(input.tool_input.file_path, input.cwd, root)!;
    if (human?.autoplan && !before.some(e => e.kind === 'use' && e.name === 'Bash' && e.order > human.order &&
        initArguments(e.input?.command, root))) fail('This Autoplan invocation needs its own successful init before phase entry.');
    const init = invocation(before, root), entered = before.filter(e => e.order > init.start);
    let phase: Phase | undefined, entryOrder = init.start;
    for (const use of entered) {
      if (use.kind !== 'use' || use.name !== 'Read') continue;
      const next = driver(use.input?.file_path, input.cwd, root);
      if (!next) continue;
      const results = entered.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
      if (results.length === 1 && delivered(use, results[0]!, read(fs.realpathSync(path.resolve(input.cwd, use.input!.file_path as string)))) &&
          (!phase || number[next] > number[phase])) { phase = next; entryOrder = results[0]!.order; }
    }
    const pendingEntry = entered.some(e => e.kind === 'use' && e.name === 'Read' &&
      phaseName(e.input?.file_path, input.cwd) && !entered.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId));
    if (pendingEntry) fail('A prior phase-entry Read is still pending. Retry after its native result before requesting another phase.');
    if (!phase || number[target] <= number[phase]) return { allow: true };
    const closeReads = entered.filter((e): e is Use => e.kind === 'use' && e.name === 'Read' && e.order > entryOrder &&
      ownPath(e.input?.file_path) && path.basename(e.input.file_path) === 'close-packet.md' &&
      path.dirname(path.dirname(e.input.file_path)) === path.dirname(init.restorePath) &&
      path.basename(path.dirname(e.input.file_path)).startsWith(`autoplan-${phase}-`));
    if (!closeReads.length) fail(`Finish the existing Phase ${number[phase]} close procedure and Read its complete current close packet before entering the next phase.`);
    const latestPath = closeReads.at(-1)!.input!.file_path as string;
    const content = closePacket(latestPath, phase, init), covered = new Set<number>();
    let closeOrder = -1;
    for (const use of closeReads.filter(e => e.input?.file_path === latestPath)) {
      const results = entered.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
      if (results.length !== 1) continue;
      const range = delivered(use, results[0]!, content);
      if (!range) continue;
      for (let line = range.start; line <= range.end; line++) covered.add(line);
      closeOrder = Math.max(closeOrder, results[0]!.order);
    }
    if (covered.size !== content.split('\n').length) fail(`Read every line of the current Phase ${number[phase]} close packet successfully before entering the next phase.`);
    const changed = entered.some(e => e.kind === 'use' && e.order > closeOrder && ['Write', 'Edit'].includes(e.name ?? '') &&
      e.input?.file_path === init.activePlan && !entered.some(r => r.kind === 'result' && r.toolUseId === e.toolUseId && r.isError === true));
    if (changed) fail('The active plan changed after the close Read. Repeat the existing close procedure before publication.');
    const messages = before.filter((e): e is Event & { kind: 'message' } => e.kind === 'message' && e.order > closeOrder);
    const hits = autoplanPhaseCompletions({ status: 'ready', calls: [], assistantMessages: messages }, 0);
    if (!hits.some(hit => hit.phase === number[phase])) fail(`Publish the filled Phase ${number[phase]} report as your own parent assistant text now, then retry the next-phase Read. The close packet or a saved report does not publish it.`);
    return { allow: true };
  } catch (error) {
    return { allow: false, reason: error instanceof BoundaryError
      ? error.message : 'Autoplan phase evidence is unavailable or changed. Restore the current invocation evidence and retry this Read.' };
  }
}

export function publicationHookOutput(decision: PublicationDecision): object {
  return decision.allow ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `[autoplan] ${decision.reason}` } };
}

/** Claude's pending tool record can flush after hook entry; wait only for that identity. */
export async function runPublicationHook(value: unknown, root: string): Promise<object> {
  try {
    if (!object(value) || value.hook_event_name !== 'PreToolUse' || typeof value.tool_name !== 'string') fail('Invalid native hook input.');
    if (value.tool_name !== 'Read' || value.agent_id) return {};
    if (!ownPath(value.cwd) || !ownPath(value.transcript_path) || typeof value.session_id !== 'string' ||
        typeof value.tool_use_id !== 'string' || !object(value.tool_input)) fail('Native parent hook identity is unavailable.');
    const input = value as PublicationHookInput;
    if (!phaseName(input.tool_input.file_path, input.cwd)) return {};
    const deadline = performance.now() + 2_000;
    do {
      const snapshot = readOwnedClaudePublicTranscript(input.transcript_path, input.cwd, input.session_id);
      if (snapshot.transcript.status === 'ready' && snapshot.events.some(e => e.kind === 'use' && e.toolUseId === input.tool_use_id))
        return publicationHookOutput(evaluateAutoplanPublication(input, root, snapshot.events));
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (performance.now() < deadline);
    fail('Native parent evidence has not reached the journal yet. Retry this Read; no missing-publication conclusion has been made.');
  } catch (error) {
    return publicationHookOutput({ allow: false, reason: error instanceof BoundaryError
      ? error.message : 'Hook installation or native evidence is unavailable. Restore this Autoplan installation before retrying.' });
  }
}

if (import.meta.main) {
  let output: object;
  try {
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const bytes = await Bun.stdin.text();
    if (Buffer.byteLength(bytes) > 64 * 1024) fail('Native hook input exceeds its bound.');
    output = await runPublicationHook(JSON.parse(bytes), root);
  } catch { output = publicationHookOutput({ allow: false, reason: 'Publication hook could not load its native input. Restore the hook and retry.' }); }
  process.stdout.write(JSON.stringify(output) + '\n');
}
