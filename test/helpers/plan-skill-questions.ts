import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readQuestionEvents, type QuestionEventSource } from './plan-skill-question-events';

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

function questionInputWithDefaults(input: any): any {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) return input;
  // The CLI hook supplies this default while its transcript can omit it.
  // Preserve every other field so actual input changes still fail comparison.
  return { ...input, questions: input.questions.map((question: any) =>
    question && typeof question === 'object' && !Array.isArray(question) && !Object.hasOwn(question, 'multiSelect')
      ? { ...question, multiSelect: false } : question) };
}

/** The launch's native PreToolUse event can precede transcript persistence.
 * Both sources must agree; only an owned transcript result acknowledges input.
 * PTY scrollback and tool previews supply neither invocation nor acknowledgement.
 */
export function readPlanSkillQuestions(configDir: string | null, sessionId: string, events?: QuestionEventSource): {
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
  const inputs = new Map<string, unknown>();
  const addQuestion = (id: unknown, input: any) => {
    if (typeof id !== 'string' || !id) throw new Error('Native AskUserQuestion is missing its tool ID');
    input = questionInputWithDefaults(input);
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4 || questions.some(q =>
      typeof q?.question !== 'string' || !q.question.trim() || typeof q.header !== 'string' || !q.header.trim()
      || typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
      || q.options.some((o: any) => typeof o?.label !== 'string' || !o.label.trim() || typeof o.description !== 'string')
    )) throw new Error('Unsupported native AskUserQuestion input shape');
    if (inputs.has(id) && !isDeepStrictEqual(inputs.get(id), input)) {
      throw new Error('Native AskUserQuestion changed input for an existing tool ID');
    }
    inputs.set(id, input);
    calls.set(id, { id, questions, result: 'pending' });
  };
  if (events) {
    for (const event of readQuestionEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      addQuestion(event.id, event.input);
    }
  }
  for (const row of transcript.rows) {
    const message = row.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, block.is_error === true);
      }
      // An unfinished assistant record cannot introduce a call, but it can
      // invalidate conflicting early evidence before any input is sent.
      if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use' && inputs.has(block.id)
        && (block.name !== 'AskUserQuestion' || !isDeepStrictEqual(inputs.get(block.id), questionInputWithDefaults(block.input)))) {
        throw new Error('Native AskUserQuestion changed input for an existing tool ID');
      }
      if (row.type !== 'assistant' || message.role !== 'assistant' || message.stop_reason !== 'tool_use' || block?.type !== 'tool_use') continue;
      if (block.name === 'ExitPlanMode' && typeof block.id === 'string') ready.add(block.id);
      else if (block.name !== 'AskUserQuestion' && typeof block.id === 'string') permissionTools.set(block.id, {
        id: block.id, name: block.name, input: block.input ?? {},
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
      });
      if (block.name !== 'AskUserQuestion') continue;
      addQuestion(block.id, block.input);
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

/** Read only a physical side-preview frame. Other layouts retain the existing
 * parser; preview text never supplies label characters. */
function previewQuestionOptions(question: NativeQuestion, menu: string): Array<{ index: number; label: string }> | null {
  let lines = menu.split(/\r?\n/);
  // A glyph in an offered label is not a preview. Require a separated border
  // band corroborated by an aligned right-column body or bottom row.
  const apparentPreview = lines.slice(1).some(line => {
    const body = / {2,}(│.*│|└─+┘)[ \t]*$/.exec(line);
    if (!body) return false;
    const column = body.index + body[0].indexOf(body[1]!);
    const band = lines[0]!.slice(column);
    return column >= 6 && / {2}$/.test(lines[0]!.slice(0, column))
      && /^[┌┐─ \t]+$/.test(band) && /[┌┐─]/.test(band);
  });
  if (!apparentPreview) return null;
  const top = /┌─+┐[ \t]*$/.exec(lines[0]!);
  if (!top) return [];
  const column = top.index;
  const edge = column + top[0].trimEnd().length - 1;
  if (column < 6 || !/ {2}$/.test(lines[0]!.slice(0, column))) return [];
  let bottom = -1;
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!;
    if (row[column] === '└') {
      if (row[edge] !== '┘' || !/^─+$/.test(row.slice(column + 1, edge)) || row.slice(edge + 1).trim()) return [];
      bottom = i;
      break;
    }
    if (row[column] !== '│' || row[edge] !== '│' || row.slice(edge + 1).trim()) return [];
  }
  if (bottom < 0) return [];
  // Only cursor tokens inside a verified preview are decorative. A later
  // menu after this frame restores the existing latest-menu selection.
  for (const match of menu.matchAll(/❯\s*1\./g)) {
    if (match.index === lines[0]!.indexOf('❯')) continue;
    const before = menu.slice(0, match.index);
    const row = before.split('\n').length - 1;
    const cursorColumn = match.index - (before.lastIndexOf('\n') + 1);
    if (row > bottom) return null;
    if (row < 1 || row >= bottom || cursorColumn <= column
      || cursorColumn + match[0].length > edge || /[\r\n]/.test(match[0])) return [];
  }
  lines = lines.slice(0, bottom + 1).map(line => line.slice(0, column).trimEnd());
  const found: Array<{ index: number; label: string }> = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    const numbered = /^[ \t]*(?:❯[ \t]*)?([1-9])\.[ \t]*(\S.*)$/.exec(line);
    if (numbered) {
      const index = Number(numbered[1]);
      if (index > question.options.length) break; // Native Other/Chat controls.
      if (index !== found.length + 1) return [];
      const previous = found.at(-1);
      if (previous && !compact(previous.label).startsWith(compact(question.options[previous.index - 1]!.label))) return [];
      found.push({ index, label: numbered[2]! });
    } else {
      const previous = found.at(-1);
      if (!previous) return [];
      const complete = compact(previous.label).startsWith(compact(question.options[previous.index - 1]!.label));
      if (!/^ {4,}\S/.test(line)) {
        if (!complete && lines.slice(row).some(tail => tail.trim())) return [];
        break;
      }
      if (complete) continue; // A description is not another offered label.
      previous.label += ' ' + line.trim();
    }
    const current = found.at(-1)!;
    const offered = compact(question.options[current.index - 1]!.label);
    const rendered = compact(current.label);
    if (!rendered || (!offered.startsWith(rendered) && !rendered.startsWith(offered))) return [];
  }
  // The final choice may extend below the viewport. Its prefix is validated
  // above; the caller still requires two other complete offered labels.
  return found;
}

export function matchesNativeQuestion(question: NativeQuestion, visible: string, options: Array<{ index: number; label: string }>, others: NativeQuestion[] = []): boolean {
  if (others.some(other => other !== question && compact(other.question) === compact(question.question)
    && compact(other.header) === compact(question.header) && JSON.stringify(other.options.map(o => o.label)) === JSON.stringify(question.options.map(o => o.label)))) {
    throw new Error('Indistinguishable repeated native question: current rendering cannot identify a new invocation');
  }
  const physicalCursor = [...visible.matchAll(/^[ \t]*❯[ \t]*1\./gm)].at(-1);
  const physicalOptions = physicalCursor ? previewQuestionOptions(question, visible.slice(physicalCursor.index)) : null;
  const cursor = physicalOptions === null ? [...visible.matchAll(/❯\s*1\./g)].at(-1) : physicalCursor;
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
  const renderedOptions = physicalOptions ?? options;
  return renderedOptions.filter(rendered => {
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
  return text.includes('readytosubmityouranswers') && text.includes('submitanswers')
    && !text.includes('youhavenotansweredallquestions');
}
