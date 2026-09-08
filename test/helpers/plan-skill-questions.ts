import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as path from 'node:path';

export interface NativeQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}
export interface NativeQuestionCall {
  id: string;
  questions: NativeQuestion[];
  result: 'pending' | 'answered' | 'error';
}
export interface NativePermissionTool { id: string; name: string; input: Record<string, unknown>; cwd?: string }

/** Tool identity comes from complete records in this launch's own transcript.
 * PTY scrollback and tool previews cannot create an invocation or acknowledge it.
 */
export function readPlanSkillQuestions(configDir: string | null, sessionId: string): {
  calls: NativeQuestionCall[];
  ready: boolean;
  permissionTools: NativePermissionTool[];
  pendingBytes: number;
} {
  const transcript = readOwnedClaudeTranscript(configDir, sessionId);
  const calls = new Map<string, NativeQuestionCall>();
  const results = new Map<string, boolean>();
  const ready = new Set<string>();
  const permissionTools = new Map<string, NativePermissionTool>();
  for (const row of transcript.rows) {
    const message = row.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, block.is_error === true);
      }
      if (row.type !== 'assistant' || message.role !== 'assistant' || message.stop_reason !== 'tool_use' || block?.type !== 'tool_use') continue;
      if (block.name === 'ExitPlanMode' && typeof block.id === 'string') ready.add(block.id);
      else if (block.name !== 'AskUserQuestion' && typeof block.id === 'string') permissionTools.set(block.id, {
        id: block.id, name: block.name, input: block.input ?? {},
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
      });
      if (block.name !== 'AskUserQuestion') continue;
      if (typeof block.id !== 'string' || !block.id) throw new Error('Native AskUserQuestion is missing its tool ID');
      const questions = block.input?.questions;
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4 || questions.some(q =>
        typeof q?.question !== 'string' || !q.question.trim() || typeof q.header !== 'string' || !q.header.trim()
        || typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
        || q.options.some((o: any) => typeof o?.label !== 'string' || !o.label.trim() || typeof o.description !== 'string')
      )) throw new Error('Unsupported native AskUserQuestion input shape');
      const prior = calls.get(block.id);
      if (prior && JSON.stringify(prior.questions) !== JSON.stringify(questions)) throw new Error('Native AskUserQuestion changed input for an existing tool ID');
      calls.set(block.id, { id: block.id, questions, result: 'pending' });
    }
  }
  for (const call of calls.values()) {
    if (results.has(call.id)) call.result = results.get(call.id) ? 'error' : 'answered';
  }
  return { calls: [...calls.values()], ready: [...ready].some(id => !results.has(id)), permissionTools: [...permissionTools.values()].filter(tool => !results.has(tool.id)), pendingBytes: transcript.pendingBytes };
}

// Terminal markdown/positioning can remove whitespace and decoration; semantic
// question text and option labels must still match the owned tool input.
const compact = (value: string) => value.replace(/<gstack-qid:[^>]+>/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export function matchesNativeQuestion(question: NativeQuestion, visible: string, options: Array<{ index: number; label: string }>, others: NativeQuestion[] = []): boolean {
  if (others.some(other => other !== question && compact(other.question) === compact(question.question)
    && compact(other.header) === compact(question.header) && JSON.stringify(other.options.map(o => o.label)) === JSON.stringify(question.options.map(o => o.label)))) {
    throw new Error('Indistinguishable repeated native question: current rendering cannot identify a new invocation');
  }
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const prefix = visible.slice(0, cursor.index);
  const box = Math.max(prefix.lastIndexOf('☐'), prefix.lastIndexOf('☑'), prefix.lastIndexOf('✔'));
  // The native box identifies the current prompt region. Match its heading
  // rather than requiring the whole lengthy decision brief to survive a
  // viewport repaint. Classic unboxed fixtures require the entire question.
  const heading = question.question.split(/\r?\n/).find(line => line.trim())!;
  const ambiguousHeading = others.some(other => compact(other.question) !== compact(question.question)
    && compact(other.question.split(/\r?\n/).find(line => line.trim()) ?? '') === compact(heading));
  const promptMatches = box >= 0
    ? compact(prefix).includes(compact(question.header)) && (ambiguousHeading
      ? compact(prefix.slice(box)).endsWith(compact(question.question))
      : compact(prefix.slice(box)).includes(compact(heading)))
    : compact(prefix).endsWith(compact(question.question));
  if (!promptMatches) return false;
  // Rendered choices corroborate the prompt; the complete offered inventory
  // and numeric selection come from native input, even below the viewport.
  return options.filter(rendered => {
    const offered = question.options[rendered.index - 1];
    return offered && compact(rendered.label).startsWith(compact(offered.label));
  }).length >= 2;
}

/** A lone pending tool is insufficient: its command/path must also identify
 * the displayed permission. Unsupported or repeated ambiguous grants fail.
 */
export function currentFilePermissionTarget(visible: string): { operation: 'create' | 'edit'; filePath: string } | null {
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  // Bind the current menu's distinctive CLI controls, not a prose question
  // containing "create" or a stale permission earlier in scrollback.
  const controls = visible.slice(cursor.index).replace(/\s+/g, '');
  if (!/^❯1\.Yes2\.Yes,andswitchtoacceptedits\(auto-approvefileeditsandcommonfilecommands\)forthissession(?:\(shift\+tab\))?3\.No(?:\b|Esc)/.test(controls)) return null;
  const prompt = /Do\s*you\s*want\s*to\s*(create|edit)\s+([^\r\n?]+)\?\s*$/.exec(visible.slice(0, cursor.index));
  return prompt ? { operation: prompt[1] as 'create' | 'edit', filePath: prompt[2]!.trim() } : null;
}

export function nativePermissionKey(tool: NativePermissionTool, visible: string): string {
  const value = tool.name === 'Bash' ? tool.input.command
    : ['Read', 'Write', 'Edit'].includes(tool.name) ? tool.input.file_path : null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Unsupported native permission command or file path');
  const current = currentFilePermissionTarget(visible);
  if (current) {
    const expectedTool = current.operation === 'create' ? 'Write' : 'Edit';
    const displayed = current.filePath;
    const resolved = path.isAbsolute(displayed) ? path.normalize(displayed)
      : tool.cwd && path.isAbsolute(tool.cwd) ? path.resolve(tool.cwd, displayed) : null;
    // A basename alone has no authority. Its exact path must resolve through
    // the cwd on this owned tool record; missing/corrupted names stay errors.
    if (tool.name !== expectedTool || !path.isAbsolute(value) || resolved !== path.normalize(value)) {
      throw new Error('Visible permission cannot be bound to its pending native command or file path');
    }
    return tool.name + ':' + path.normalize(value);
  }
  // Match the request's own labelled field, not a command/path substring
  // elsewhere in a previous dialog (or another tool's command).
  const displayed = tool.name === 'Bash'
    ? [...visible.matchAll(/\bBash\s+command\s+(.+?)\s+requires\s+permission/gis)].at(-1)?.[1]
    : [...visible.matchAll(new RegExp('(?:^|\\n)\\s*' + tool.name + '\\s+to\\s+([^\\n]+)', 'g'))].at(-1)?.[1];
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const unquoted = displayed?.trim().replace(/^`([^`]+)`$/, '$1');
  if (!displayed || (normalize(displayed) !== normalize(value) && normalize(unquoted!) !== normalize(value))) {
    throw new Error('Visible permission cannot be bound to its pending native command or file path');
  }
  return tool.name + ':' + normalize(value);
}

export function isNativeQuestionSubmitVisible(visible: string): boolean {
  const text = compact(visible);
  return text.includes('readytosubmityouranswers') && text.includes('submitanswers');
}
