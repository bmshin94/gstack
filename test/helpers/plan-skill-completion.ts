import { readOwnedClaudeTranscript } from './owned-claude-transcript';

/** A report preview is not completion. Require the latest owned conversation
 * turn to finish without tools, then corroborate its own completion text.
 */
export function readPlanSkillCompletion(configDir: string | null, sessionId: string, visible: string): string | null {
  const transcript = readOwnedClaudeTranscript(configDir, sessionId);
  if (transcript.pendingBytes) return null;
  const queued = new Map<string, number>();
  let latest: { id: string | null; text: string[]; stop: unknown; tools: boolean } | null = null;
  for (const row of transcript.rows) {
    if (row.type === 'queue-operation') {
      latest = null;
      if (typeof row.content !== 'string' || !['enqueue', 'remove'].includes(row.operation)) {
        throw new Error('Unsupported queue operation in owned Claude transcript');
      }
      const count = queued.get(row.content) ?? 0;
      if (row.operation === 'enqueue') queued.set(row.content, count + 1);
      else if (count > 1) queued.set(row.content, count - 1);
      else queued.delete(row.content);
      continue;
    }
    if (row.type === 'user' || (row.type === 'attachment' && typeof row.attachment?.prompt === 'string')) {
      latest = null;
      continue;
    }
    if (row.type !== 'assistant' || row.message?.role !== 'assistant') continue;
    const message = row.message;
    const id = typeof message.id === 'string' ? message.id : null;
    if (!latest || !id || latest.id !== id) latest = { id, text: [], stop: null, tools: false };
    latest.stop = message.stop_reason;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') latest.text.push(block.text);
      if (block?.type === 'tool_use') latest.tools = true;
    }
  }
  if (queued.size || !latest || latest.stop !== 'end_turn' || latest.tools) return null;
  let fence: string | null = null;
  const compact = (value: string) => value.replace(/[\s*#]/g, '').toLowerCase();
  for (const line of latest.text.join('\n').split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}| {0,3}\t)|^\s*>/.test(line)) continue;
    const text = line.replace(/^ {0,3}(?:#{1,6}\s+)?/, '').replace(/\*\*/g, '').trim();
    const marker = /^(?:GSTACK REVIEW REPORT|Completion Summary)$/i.test(text)
      || /^VERDICT:\s*\S/.test(text)
      || /^Status:\s*(?:clean|issues_open)\b/i.test(text)
      || /^(?:STATUS:\s*)?DONE(?:_WITH_CONCERNS)?(?:\s|[—:.-]|$)/.test(text);
    if (marker && compact(visible).includes(compact(text))) return text;
  }
  return null;
}
