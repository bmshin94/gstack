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
}): string | null {
  try {
    const raw = opts.raw();
    const visible = opts.visible();
    const native = readOwnedClaudeTranscript(opts.configDir, opts.sessionId);
    const clip = (text: string, limit = 32_768) => ({
      text: text.slice(0, limit), codeUnits: text.length, truncated: text.length > limit,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    const calls: Array<{ id: string; name: string; input: unknown; timestamp: unknown }> = [];
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
          calls.push({ id: block.id, name: block.name, input: block.input ?? null, timestamp: row.timestamp });
        }
      }
    }
    const pending = calls.filter(call => !results.has(call.id));
    const record = {
      schemaVersion: 1, sessionId: opts.sessionId, capturedAt: new Date().toISOString(),
      nativeFile: native.file, completedLines: native.completedLines, pendingBytes: native.pendingBytes,
      observation: clip(JSON.stringify(opts.observation)),
      calls: calls.slice(-16).map(call => ({ id: clip(call.id, 256), name: clip(call.name, 256),
        timestamp: clip(String(call.timestamp), 256), inputJson: clip(JSON.stringify(call.input)),
        result: results.has(call.id) ? results.get(call.id) ? 'error' : 'completed' : 'pending' })),
      callCount: calls.length, callsOmitted: Math.max(0, calls.length - 16),
      pendingIds: pending.slice(-64).map(call => clip(call.id, 256)),
      pendingCount: pending.length, pendingIdsOmitted: Math.max(0, pending.length - 64),
      rawTail: { ...clip(raw.slice(-65_536), 65_536), omittedPrefixCodeUnits: Math.max(0, raw.length - 65_536) }, rawCodeUnits: raw.length,
      visibleTail: { ...clip(visible.slice(-65_536), 65_536), omittedPrefixCodeUnits: Math.max(0, visible.length - 65_536) }, visibleCodeUnits: visible.length,
      limits: 'Diagnostic only. Pending tools are not proof of a permission prompt or a failed command. Native thinking, signatures and tool results are omitted; clipped command inputs remain incomplete evidence.',
    };
    const evalDir = opts.evalDir ?? process.env.GSTACK_EVAL_DIR;
    if (!evalDir) throw new Error('GSTACK_EVAL_DIR is not configured');
    const directory = path.join(evalDir, 'autoplan-chain');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${opts.sessionId}.json`);
    const serialized = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 8_388_608) throw new Error('Autoplan diagnostic exceeds its 8 MiB bound');
    fs.writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
    console.error(`[autoplan-chain] failure diagnostic: ${file}`);
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
