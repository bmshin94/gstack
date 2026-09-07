import * as fs from 'node:fs';
import * as path from 'node:path';

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
  if (!configDir) throw new Error('Autoplan requires an owned hermetic transcript directory');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('Autoplan transcript session ID must be a UUID');
  }
  const pending = { file: null, phases: [], completedLines: 0, pendingBytes: 0 };
  const projects = path.join(configDir, 'projects');
  let directories: fs.Dirent[];
  try {
    directories = fs.readdirSync(projects, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pending;
    throw error;
  }
  const files: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue; // Never follow project symlinks.
    const file = path.join(projects, directory.name, `${sessionId}.jsonl`);
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error(`Autoplan transcript is not a regular file: ${file}`);
      files.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (files.length === 0) return pending;
  if (files.length !== 1) throw new Error(`Ambiguous autoplan transcript for session ${sessionId}`);
  const file = files[0];
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pending;
    throw error;
  }
  const boundary = source.lastIndexOf('\n') + 1;
  const lines = source.slice(0, boundary).split('\n').slice(0, -1);
  const phases: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected a JSON object');
    } catch {
      // Do not include the raw record: it may contain tool output or secrets.
      throw new Error(`Malformed autoplan transcript JSON at ${file}:${index + 1}`);
    }
    if (row.type !== 'assistant' || row.message?.role !== 'assistant'
      || row.sessionId !== sessionId || row.isSidechain === true || row.parent_tool_use_id != null) continue;
    if (!Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const phase of announcedAutoplanPhases(block.text)) {
        if (!phases.includes(phase)) phases.push(phase);
      }
    }
  }
  return { file, phases, completedLines: lines.length, pendingBytes: Buffer.byteLength(source.slice(boundary)) };
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
