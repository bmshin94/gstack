import { readOwnedClaudeTranscript } from './owned-claude-transcript';

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
