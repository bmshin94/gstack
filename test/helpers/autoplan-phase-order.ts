import { currentFilePermissionTarget, type readPlanSkillQuestions } from './plan-skill-questions';
import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** The PTY renders Markdown without stars and may position spaces via ANSI.
 * Keep complete-word bounds and stream order; callers dedupe first observations.
 */
export function observedAutoplanPhases(visible: string): number[] {
  return [...visible.matchAll(/\bPhase\s*(\d+(?:\.\d+)?)\s*complete\b/g)]
    .map(match => Number(match[1]));
}

export interface AutoplanTranscriptObservation {
  file: string | null;
  phases: number[];
  completedLines: number;
  pendingBytes: number;
}

/** Preserve the owned commands needed to investigate a stopped chain before
 * its fixture is deleted. This diagnostic cannot change a phase verdict.
 */
export function retainAutoplanFailure(opts: {
  configDir: string | null; sessionId: string; observation: unknown;
  raw: () => string; visible: () => string; evalDir?: string;
  /** Counting errors retain schemas/ownership only: never tool contents or screen previews. */
  counting?: { native: ReturnType<typeof readPlanSkillQuestions> | null; dialog: string };
}): string | null {
  try {
    const raw = opts.raw();
    const visible = opts.visible();
    const native = readOwnedClaudeTranscript(opts.configDir, opts.sessionId);
    const clip = (text: string, limit = 32_768) => ({
      text: text.slice(0, limit), codeUnits: text.length, truncated: text.length > limit,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    const signature = (value: unknown) => {
      const { text: _omitted, ...digest } = clip(JSON.stringify(value) ?? '');
      return { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, ...digest };
    };
    const safeInput = (name: string, input: any) => ({ ...signature(input),
      ...(['Read', 'Write', 'Edit'].includes(name) && typeof input?.file_path === 'string' ? { filePath: input.file_path.slice(0, 4096) } : {}),
    });
    const calls: Array<{ id: string; name: string; input: unknown; timestamp: unknown; cwd: unknown }> = [];
    const results = new Map<string, boolean>();
    for (const row of native.rows) {
      const message = row.message;
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          results.set(block.tool_use_id, block.is_error === true);
        }
        if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use'
          && typeof block.id === 'string' && typeof block.name === 'string') {
          calls.push({ id: block.id, name: block.name, input: block.input ?? null, timestamp: row.timestamp, cwd: row.cwd });
        }
      }
    }
    const pending = calls.filter(call => !results.has(call.id));
    const queue = native.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.type === 'queue-operation');
    const state = opts.counting?.native;
    const fileTarget = opts.counting ? currentFilePermissionTarget(opts.counting.dialog) : null;
    const counting = opts.counting ? {
      dialog: { ...signature(opts.counting.dialog), currentFileTarget: fileTarget ? { ...fileTarget, filePath: fileTarget.filePath.slice(0, 4096) } : null },
      nativeObserved: state !== null, permissionRequestCapture: state?.permissionRequestCapture ?? null,
      permissionToolCount: state?.permissionTools.length ?? null,
      permissionTools: state?.permissionTools.slice(-16).map(tool => ({ id: clip(tool.id, 256), name: clip(tool.name, 256),
        cwd: typeof tool.cwd === 'string' ? clip(tool.cwd, 4096) : null, input: safeInput(tool.name, tool.input) })) ?? [],
      permissionRequestCount: state?.permissionRequests.length ?? null,
      permissionRequests: state?.permissionRequests.slice(-16).map(request => ({ requestId: clip(request.requestId, 256),
        nativeToolId: request.nativeToolId?.slice(0, 256) ?? null, name: request.name, result: request.result,
        capturedAtMs: request.capturedAtMs, cwd: clip(request.cwd, 4096), input: safeInput(request.name, request.input) })) ?? [],
      queueOperations: { count: queue.length, omitted: Math.max(0, queue.length - 16), rows: queue.slice(-16).map(({ row, index }) => ({
        rowIndex: index, operation: typeof row.operation === 'string' ? clip(row.operation, 64) : signature(row.operation),
        content: signature(row.content), uuid: typeof row.uuid === 'string' ? clip(row.uuid, 256) : null,
        timestamp: typeof row.timestamp === 'string' ? clip(row.timestamp, 256) : null,
      })) },
    } : undefined;
    const record = {
      schemaVersion: 1, sessionId: opts.sessionId, capturedAt: new Date().toISOString(),
      nativeFile: native.file, completedLines: native.completedLines, pendingBytes: native.pendingBytes,
      observation: clip(JSON.stringify(opts.observation)),
      calls: calls.slice(-16).map(call => ({ id: clip(call.id, 256), name: clip(call.name, 256),
        timestamp: clip(String(call.timestamp), 256),
        ...(counting ? { input: safeInput(call.name, call.input), cwd: typeof call.cwd === 'string' ? clip(call.cwd, 4096) : null } : { inputJson: clip(JSON.stringify(call.input)) }),
        result: results.has(call.id) ? results.get(call.id) ? 'error' : 'completed' : 'pending' })),
      callCount: calls.length, callsOmitted: Math.max(0, calls.length - 16),
      pendingIds: pending.slice(-64).map(call => clip(call.id, 256)),
      pendingCount: pending.length, pendingIdsOmitted: Math.max(0, pending.length - 64),
      rawTail: { ...(counting ? signature(raw.slice(-65_536)) : clip(raw.slice(-65_536), 65_536)), omittedPrefixCodeUnits: Math.max(0, raw.length - 65_536) }, rawCodeUnits: raw.length,
      visibleTail: { ...(counting ? signature(visible.slice(-65_536)) : clip(visible.slice(-65_536), 65_536)), omittedPrefixCodeUnits: Math.max(0, visible.length - 65_536) }, visibleCodeUnits: visible.length,
      ...(counting ? { counting } : {}),
      limits: counting ? 'Diagnostic only. Queue content, native inputs and screen text are hashed, never retained. Ownership metadata does not establish permission or completion.' : 'Diagnostic only. Pending tools are not proof of a permission prompt or a failed command. Native thinking, signatures and tool results are omitted; clipped command inputs remain incomplete evidence.',
    };
    const evalDir = opts.evalDir ?? process.env.GSTACK_EVAL_DIR;
    if (!evalDir) throw new Error('GSTACK_EVAL_DIR is not configured');
    const category = counting ? 'plan-counting' : 'autoplan-chain';
    const directory = path.join(evalDir, category);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${opts.sessionId}.json`);
    const serialized = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 8_388_608) throw new Error('Autoplan diagnostic exceeds its 8 MiB bound');
    fs.writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
    console.error(`[${category}] failure diagnostic: ${file}`);
    return file;
  } catch (error) {
    try { console.error(`Autoplan failure diagnostic could not be retained: ${String(error).slice(0, 1024)}`); } catch { /* preserve the original outcome */ }
    return null;
  }
}

function announcedAutoplanPhases(text: string): number[] {
  const phases: number[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(?:> ?)?(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const announcement = line.match(/^ {0,3}(?:> ?)?(?:\*\*)?Phase +(\d+(?:\.\d+)?) +complete\.(?:\*\*)?(?:\s|$)/);
    if (announcement) phases.push(Number(announcement[1]));
  }
  return phases;
}

/** Read only the UUID pinned at launch, directly below a project directory.
 * Tool payloads, user messages, and sidechain responses cannot announce phases.
 */
export function readAutoplanTranscript(configDir: string | null, sessionId: string): AutoplanTranscriptObservation {
  const { file, rows, completedLines, pendingBytes } = readOwnedClaudeTranscript(configDir, sessionId);
  const phases: number[] = [];
  for (const row of rows) {
    if (row.type !== 'assistant' || row.message?.role !== 'assistant') continue;
    if (!Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const phase of announcedAutoplanPhases(block.text)) {
        if (!phases.includes(phase)) phases.push(phase);
      }
    }
  }
  return { file, phases, completedLines, pendingBytes };
}

/** Assistant order is authoritative; rendered previews cannot establish order.
 * Match its prefix in the PTY stream, ignoring unrelated earlier tool previews.
 */
export function corroboratedAutoplanPhases(assistantPhases: readonly number[], visible: string): number[] {
  let count = 0;
  for (const phase of observedAutoplanPhases(visible)) {
    if (phase === assistantPhases[count]) count++;
  }
  return assistantPhases.slice(0, count);
}

/** Validate first-observed completion markers in stream order. Poll timestamps
 * cannot establish order: several phases may first appear in the same batch.
 */
export function validateAutoplanPhaseOrder(phases: readonly number[]): void {
  const observed = phases.join(' -> ') || '(none)';
  if (!phases.includes(1) || !phases.includes(3)) {
    throw new Error(`Autoplan requires CEO (1) and Eng (3) completion; observed: ${observed}`);
  }
  if (phases.at(-1) !== 3) {
    throw new Error(`Autoplan Eng (3) must complete last; observed: ${observed}`);
  }
  const expected = [1, 2, 2.5, 3];
  let previous = -1;
  for (const phase of phases) {
    const position = expected.indexOf(phase);
    if (position <= previous) {
      throw new Error(`Autoplan completion order must be CEO (1), optional Design (2), optional DX (2.5), Eng (3); observed: ${observed}`);
    }
    previous = position;
  }
}
