import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readQuestionEvents, readExitPlanModeEvents, readPermissionRequestEvents, type QuestionEventSource } from './plan-skill-question-events';

export interface NativeQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}
export interface NativeQuestionCall {
  id: string;
  questions: NativeQuestion[];
  result: 'pending' | 'answered' | 'error';
}
export interface NativePermissionTool { id: string; name: string; input: Record<string, unknown>; cwd?: string }
export interface NativeFilePermissionRequest {
  requestId: string;
  capturedAtMs: number;
  name: 'Write' | 'Edit';
  input: Record<string, unknown>;
  cwd: string;
  result: 'pending' | 'completed' | 'error';
  nativeToolId?: string;
  nativeResultAtMs?: number;
}
export interface NativePermissionGrant { nativeId?: string; requestId?: string; operation?: 'create' | 'edit' | 'overwrite' }

function questionInputWithDefaults(input: any): any {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) return input;
  // The CLI hook supplies this default while its transcript can omit it.
  // Preserve every other field so actual input changes still fail comparison.
  return { ...input, questions: input.questions.map((question: any) =>
    question && typeof question === 'object' && !Array.isArray(question) && !Object.hasOwn(question, 'multiSelect')
      ? { ...question, multiSelect: false } : question) };
}

/** Bounded schema diagnostics only; never include question or option content. */
function questionInputShape(input: any): string {
  const type = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();
  const questions = input?.questions;
  return JSON.stringify({
    inputType: type(input), questionsType: type(questions),
    questionCount: Array.isArray(questions) ? questions.length : null,
    questionsTruncated: Array.isArray(questions) && questions.length > 4,
    questions: Array.isArray(questions) ? questions.slice(0, 4).map(q => ({
      type: type(q), questionType: type(q?.question), questionNonempty: nonempty(q?.question),
      headerType: type(q?.header), headerNonempty: nonempty(q?.header),
      multiSelectType: type(q?.multiSelect), optionsType: type(q?.options),
      optionCount: Array.isArray(q?.options) ? q.options.length : null,
      optionsTruncated: Array.isArray(q?.options) && q.options.length > 4,
      options: Array.isArray(q?.options) ? q.options.slice(0, 4).map((o: any) => ({
        type: type(o), labelType: type(o?.label), labelNonempty: nonempty(o?.label),
        descriptionType: type(o?.description),
      })) : [],
    })) : [],
  });
}

/** The launch's native PreToolUse event can precede transcript persistence.
 * Both sources must agree; only an owned transcript result acknowledges input.
 * PTY scrollback and tool previews supply neither invocation nor acknowledgement.
 */
export function readPlanSkillQuestions(configDir: string | null, sessionId: string, events?: QuestionEventSource): {
  calls: NativeQuestionCall[];
  ready: boolean;
  /** Keeps pending exit identity in the native/frame stability comparison. */
  pendingExitPlanModeIds: string[];
  permissionTools: NativePermissionTool[];
  permissionResults: Array<{ id: string; result: 'completed' | 'error' }>;
  permissionRequests: NativeFilePermissionRequest[];
  permissionRequestCapture: boolean;
  pendingBytes: number;
} {
  const transcript = readOwnedClaudeTranscript(configDir, sessionId);
  const calls = new Map<string, NativeQuestionCall>();
  const results = new Map<string, boolean>();
  const resultTimes = new Map<string, number>();
  const ready = new Set<string>();
  const earlyExits = new Map<string, { input: Record<string, unknown>; cwd: string }>();
  const permissionTools = new Map<string, NativePermissionTool>();
  const inputs = new Map<string, unknown>();
  const permissionInputs = new Map<string, NativePermissionTool>();
  const unfinishedFileInputs: NativePermissionTool[] = [];
  const addQuestion = (id: unknown, input: any) => {
    if (typeof id !== 'string' || !id) throw new Error('Native AskUserQuestion is missing its tool ID');
    if (permissionInputs.has(id)) throw new Error('Native tool changed input or name for an existing tool ID');
    input = questionInputWithDefaults(input);
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4 || questions.some(q =>
      typeof q?.question !== 'string' || !q.question.trim() || typeof q.header !== 'string' || !q.header.trim()
      || typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
      || q.options.some((o: any) => typeof o?.label !== 'string' || !o.label.trim() || typeof o.description !== 'string')
    )) throw new Error(`Unsupported native AskUserQuestion input shape: toolId=${JSON.stringify(id.slice(0, 128))}${id.length > 128 ? ' (truncated)' : ''} shape=${questionInputShape(input)}`);
    if (inputs.has(id) && !isDeepStrictEqual(inputs.get(id), input)) {
      throw new Error('Native AskUserQuestion changed input for an existing tool ID');
    }
    inputs.set(id, input);
    calls.set(id, { id, questions, result: 'pending' });
  };
  const addPermission = (tool: NativePermissionTool) => {
    const previous = permissionInputs.get(tool.id);
    if (inputs.has(tool.id) || previous && (previous.name !== tool.name || !isDeepStrictEqual(previous.input, tool.input)
      || previous.cwd !== undefined && tool.cwd !== undefined && previous.cwd !== tool.cwd)) {
      throw new Error('Native tool changed input, name or cwd for an existing tool ID');
    }
    const bound = previous?.cwd !== undefined ? { ...tool, cwd: previous.cwd } : tool;
    if (['Write', 'Edit'].includes(tool.name)) permissionInputs.set(tool.id, bound);
    permissionTools.set(tool.id, bound);
  };
  if (events) {
    for (const event of readQuestionEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      addQuestion(event.id, event.input);
    }
    for (const event of readExitPlanModeEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      if (inputs.has(event.id)) throw new Error('Native ExitPlanMode changed input or name for an existing tool ID');
      earlyExits.set(event.id, { input: event.input, cwd: event.cwd });
      ready.add(event.id);
    }
  }
  for (const row of transcript.rows) {
    const message = row.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, block.is_error === true);
        resultTimes.set(block.tool_use_id, typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN);
      }
      // Exit's PreToolUse input is already normalized by the CLI. Preserve
      // injected plan fields; even unfinished persisted conflicts fail closed.
      const earlyExit = earlyExits.get(block?.id);
      if (earlyExit && row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use'
        && (block.name !== 'ExitPlanMode' || !isDeepStrictEqual(earlyExit.input, block.input)
          || typeof row.cwd === 'string' && row.cwd !== earlyExit.cwd)) {
        throw new Error('Native ExitPlanMode changed input, name or cwd for an existing tool ID');
      }
      // An unfinished assistant record cannot introduce a call, but it can
      // invalidate conflicting early evidence before any input is sent.
      if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use' && inputs.has(block.id)
        && (block.name !== 'AskUserQuestion' || !isDeepStrictEqual(inputs.get(block.id), questionInputWithDefaults(block.input)))) {
        throw new Error('Native AskUserQuestion changed input for an existing tool ID');
      }
      if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use' && permissionInputs.has(block.id)) {
        addPermission({ id: block.id, name: block.name, input: block.input ?? {},
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) });
      }
      if (row.type === 'assistant' && message.role === 'assistant' && message.stop_reason !== 'tool_use'
        && block?.type === 'tool_use' && ['Write', 'Edit'].includes(block.name)) {
        unfinishedFileInputs.push({ id: block.id, name: block.name, input: block.input ?? {},
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) });
      }
      if (row.type !== 'assistant' || message.role !== 'assistant' || message.stop_reason !== 'tool_use' || block?.type !== 'tool_use') continue;
      if (block.name === 'ExitPlanMode' && typeof block.id === 'string') ready.add(block.id);
      else if (block.name !== 'AskUserQuestion' && typeof block.id === 'string') addPermission({
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
  const permissionRequests: NativeFilePermissionRequest[] = [];
  if (events) {
    for (const event of readPermissionRequestEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      // PermissionRequest has no native tool ID. Its observer requestId is
      // separate; only a unique, exact native invocation/result can finish it.
      const candidates = [...permissionInputs.values()].filter(tool => tool.name === event.toolName
        && tool.cwd === event.cwd && isDeepStrictEqual(tool.input, event.input));
      if (candidates.length > 1 || permissionRequests.some(request => request.name === event.toolName
        && request.cwd === event.cwd && isDeepStrictEqual(request.input, event.input))) {
        throw new Error('Indistinguishable repeated native file permission request');
      }
      const native = candidates[0];
      const resultAfterRequest = native && results.has(native.id) && Number.isFinite(resultTimes.get(native.id))
        && resultTimes.get(native.id)! > event.capturedAtMs;
      const pendingInputs = resultAfterRequest ? []
        : [...permissionInputs.values(), ...unfinishedFileInputs].filter(tool => !results.has(tool.id));
      for (const tool of pendingInputs) {
        if (tool.input.file_path === event.input.file_path && (tool.name !== event.toolName
          || tool.cwd !== event.cwd || !isDeepStrictEqual(tool.input, event.input))) {
          throw new Error('Native file permission changed input, name or cwd');
        }
      }
      permissionRequests.push({ requestId: event.requestId, capturedAtMs: event.capturedAtMs, name: event.toolName, input: event.input, cwd: event.cwd,
        result: resultAfterRequest ? results.get(native!.id) ? 'error' : 'completed' : 'pending',
        ...(resultAfterRequest ? { nativeResultAtMs: resultTimes.get(native!.id)! } : {}),
        ...(native && (!results.has(native.id) || resultAfterRequest) ? { nativeToolId: native.id } : {}) });
    }
  }
  const pendingExitPlanModeIds = [...ready].filter(id => !results.has(id));
  return { calls: [...calls.values()], ready: pendingExitPlanModeIds.length > 0, pendingExitPlanModeIds,
    permissionTools: [...permissionTools.values()].filter(tool => !results.has(tool.id)),
    permissionResults: [...permissionTools.keys()].filter(id => results.has(id)).map(id => ({ id, result: results.get(id) ? 'error' : 'completed' })),
    permissionRequests,
    permissionRequestCapture: events !== undefined,
    pendingBytes: transcript.pendingBytes };
}

// Terminal markdown/positioning can remove whitespace and decoration; semantic
// question text and option labels must still match the owned tool input.
const compact = (value: string) => value.replace(/<gstack-qid:[^>]+>/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** Read only a physical side-preview frame. Other layouts retain the existing
 * parser; preview text never supplies label characters. */
function previewQuestionOptions(question: NativeQuestion, menu: string): { options: Array<{ index: number; label: string }>; focusedIndex: number } | null {
  const invalid = { options: [], focusedIndex: 0 };
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
  if (!top) return invalid;
  const column = top.index;
  const edge = column + top[0].trimEnd().length - 1;
  if (column < 6 || !/ {2}$/.test(lines[0]!.slice(0, column))) return invalid;
  let bottom = -1;
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!;
    if (row[column] === '└') {
      if (row[edge] !== '┘' || !/^─+$/.test(row.slice(column + 1, edge)) || row.slice(edge + 1).trim()) return invalid;
      bottom = i;
      break;
    }
    // Native clipping adds one ruler immediately before the bottom. The
    // independent left column may still contain an option or continuation.
    if (row[column] === '├') {
      if (row[edge] !== '┤' || !/^├─── ✂ ─── [1-9]\d* lines hidden ─*┤$/.test(row.slice(column, edge + 1))
        || row.slice(edge + 1).trim() || lines[i + 1]?.[column] !== '└') return invalid;
      continue;
    }
    if (row[column] !== '│' || row[edge] !== '│' || row.slice(edge + 1).trim()) return invalid;
  }
  if (bottom < 0) return invalid;
  // The option column can be taller than the preview (including its empty
  // state). Continue only inside that same column; the native Notes hint is
  // the sole supported right-column content below the verified rectangle.
  let optionEnd = bottom + 1;
  let notes = false;
  for (; optionEnd < lines.length; optionEnd++) {
    const row = lines[optionEnd]!;
    const left = row.slice(0, column).trimEnd();
    if (!/^[ \t]*(?:❯[ \t]*)?[1-9]\.[ \t]*\S/.test(left) && !/^ {4,}\S/.test(left)) break;
    const right = row.slice(column).trimEnd();
    if (right.trim()) {
      if (notes || right !== 'Notes: press n to add notes' || !/ {2}$/.test(row.slice(0, column))) return invalid;
      notes = true;
    }
  }
  // Only cursor tokens inside a verified preview are decorative. A later
  // menu after this frame restores the existing latest-menu selection.
  let focusedIndex = 0;
  for (const match of menu.matchAll(/❯\s*([1-9])\./g)) {
    const before = menu.slice(0, match.index);
    const row = before.split('\n').length - 1;
    const cursorColumn = match.index - (before.lastIndexOf('\n') + 1);
    if (row >= optionEnd) return null;
    if (cursorColumn < column && /^[ \t]*❯[ \t]*[1-9]\./.test(lines[row]!)) {
      if (focusedIndex || /[\r\n]/.test(match[0])) return invalid;
      focusedIndex = Number(match[1]);
      continue;
    }
    if (row < 1 || row >= bottom || cursorColumn <= column
      || cursorColumn + match[0].length > edge || /[\r\n]/.test(match[0])) return invalid;
  }
  lines = lines.slice(0, optionEnd).map(line => line.slice(0, column).trimEnd());
  const found: Array<{ index: number; label: string }> = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    const numbered = /^[ \t]*(?:❯[ \t]*)?([1-9])\.[ \t]*(\S.*)$/.exec(line);
    if (numbered) {
      const index = Number(numbered[1]);
      if (index > question.options.length) break; // Native Other/Chat controls.
      if (index !== found.length + 1) return invalid;
      const previous = found.at(-1);
      if (previous && !compact(previous.label).startsWith(compact(question.options[previous.index - 1]!.label))) return invalid;
      found.push({ index, label: numbered[2]! });
    } else {
      const previous = found.at(-1);
      if (!previous) return invalid;
      const complete = compact(previous.label).startsWith(compact(question.options[previous.index - 1]!.label));
      if (!/^ {4,}\S/.test(line)) {
        if (!complete && lines.slice(row).some(tail => tail.trim())) return invalid;
        break;
      }
      if (complete) continue; // A description is not another offered label.
      previous.label += ' ' + line.trim();
    }
    const current = found.at(-1)!;
    const offered = compact(question.options[current.index - 1]!.label);
    const rendered = compact(current.label);
    if (!rendered || (!offered.startsWith(rendered) && !rendered.startsWith(offered))) return invalid;
  }
  // Extending below the pane requires the complete owned option inventory,
  // not an unbounded continuation or a second menu joined to this frame.
  if (optionEnd > bottom + 1 && (found.length !== question.options.length || found.some(option =>
    !compact(option.label).startsWith(compact(question.options[option.index - 1]!.label))))) return invalid;
  // The final choice may extend below the viewport. Its prefix is validated
  // above; the caller still requires two other complete offered labels.
  return { options: found, focusedIndex };
}

export function matchesNativeQuestion(question: NativeQuestion, visible: string, options: Array<{ index: number; label: string }>, others: NativeQuestion[] = []): boolean {
  if (others.some(other => other !== question && compact(other.question) === compact(question.question)
    && compact(other.header) === compact(question.header) && JSON.stringify(other.options.map(o => o.label)) === JSON.stringify(question.options.map(o => o.label)))) {
    throw new Error('Indistinguishable repeated native question: current rendering cannot identify a new invocation');
  }
  const physicalCursor = [...visible.matchAll(/^[ \t]*(?:❯[ \t]*)?1\./gm)].at(-1);
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
  const renderedOptions = physicalOptions?.options ?? options;
  return renderedOptions.filter(rendered => {
    const offered = question.options[rendered.index - 1];
    return offered && compact(rendered.label).startsWith(compact(offered.label));
  }).length >= 2;
}

/** Normal single-select digits commit immediately. The CLI's preview menu
 * instead focuses with a digit and commits the rendered focus with Enter.
 * Require both native preview inventory and its current physical controls;
 * accessible/plain rendering of preview input is deliberately unsupported.
 */
export function nativeQuestionSelection(question: NativeQuestion, visible: string,
  options: Array<{ index: number; label: string }>, others: NativeQuestion[] = []):
  { kind: 'digit' } | { kind: 'preview'; focusedIndex: number } | null {
  if (question.multiSelect || !matchesNativeQuestion(question, visible, options, others)) return null;
  const first = [...visible.matchAll(/^[ \t]*(?:❯[ \t]*)?1\./gm)].at(-1);
  const frame = first ? previewQuestionOptions(question, visible.slice(first.index)) : null;
  const preview = question.options.some(option => option.preview !== undefined);
  if (!preview && frame === null) return { kind: 'digit' };
  if (!preview || !frame || !frame.focusedIndex) return null;
  const focused = frame.options.find(option => option.index === frame.focusedIndex);
  const offered = question.options[frame.focusedIndex - 1];
  if (!focused || !offered || !compact(focused.label).startsWith(compact(offered.label))) return null;
  if (!/^Enter to select · ↑\/↓ to navigate · n to add notes(?: · Tab to switch questions)? · Esc to cancel$/.test(visible.trim().split('\n').at(-1)!.trim())) return null;
  return { kind: 'preview', focusedIndex: frame.focusedIndex };
}

/** A lone pending tool is insufficient: its command/path must also identify
 * the displayed permission. Unsupported or repeated ambiguous grants fail.
 */
export function currentFilePermissionTarget(visible: string): { operation: 'create' | 'edit' | 'overwrite'; filePath: string } | null {
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  // Bind the current menu's distinctive CLI controls, not a prose question
  // containing "create" or a stale permission earlier in scrollback.
  const controls = visible.slice(cursor.index).replace(/\s+/g, '');
  if (!/^❯1\.Yes2\.Yes,andswitchtoacceptedits\(auto-approvefileeditsandcommonfilecommands\)forthissession(?:\(shift\+tab\))?3\.No(?:\b|Esc)/.test(controls)) return null;
  const prompt = /Do\s*you\s*want\s*to\s*(create|edit|overwrite|make\s+this\s+edit\s+to)\s+([^\r\n?]+)\?\s*$/.exec(visible.slice(0, cursor.index));
  return prompt ? { operation: prompt[1]!.startsWith('make') ? 'edit' : prompt[1] as 'create' | 'edit' | 'overwrite', filePath: prompt[2]!.trim() } : null;
}

export function nativePermissionKey(tool: NativePermissionTool | NativeFilePermissionRequest, visible: string): string {
  const value = tool.name === 'Bash' ? tool.input.command
    : ['Read', 'Write', 'Edit'].includes(tool.name) ? tool.input.file_path : null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Unsupported native permission command or file path');
  const current = currentFilePermissionTarget(visible);
  if (current) {
    const expectedTool = current.operation === 'edit' ? 'Edit' : 'Write';
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

/** Reserve one current grant. Observer request IDs never stand in for native
 * tool IDs; only an exact later native result can retire the prior request. */
export function reserveNativePermissionGrant(
  native: Pick<ReturnType<typeof readPlanSkillQuestions>, 'permissionTools' | 'permissionResults' | 'permissionRequests' | 'permissionRequestCapture'>,
  visible: string, granted: Set<string>, requests: Map<string, NativePermissionGrant>,
): boolean {
  const pending = native.permissionRequests.filter(request => request.result === 'pending');
  const owners = [...pending, ...native.permissionTools.filter(tool => !pending.some(request => request.nativeToolId === tool.id))];
  if (!owners.length) return false;
  if (owners.length > 1) throw new Error('Ambiguous native permission owner: multiple tools are pending');
  const owner = owners[0]!;
  if (native.permissionRequestCapture && !('requestId' in owner) && ['Write', 'Edit'].includes(owner.name)) return false;
  const key = 'requestId' in owner ? `request:${owner.requestId}` : owner.id;
  if (granted.has(key)) return false;
  const request = nativePermissionKey(owner, visible);
  const operation = currentFilePermissionTarget(visible)?.operation;
  const prior = requests.get(request);
  if (prior) {
    const completedRequest = prior.requestId
      ? native.permissionRequests.find(item => item.requestId === prior.requestId && item.result === 'completed' && item.nativeToolId)
      : undefined;
    const completed = prior.requestId
      ? completedRequest !== undefined
      : native.permissionResults.some(item => item.id === prior.nativeId && item.result === 'completed');
    // The new source event can arrive after the screen barrier. Wait while
    // its same-path CREATE predecessor is still visible; never regrant it.
    if (completed && prior.operation === 'create' && operation === 'create') return false;
    // A distinct observer after Edit1's exact successful ACK can own Edit2
    // at this same cwd/path before Edit2's native invocation is persisted.
    // The caller still brackets the current one-time menu with source reads.
    const nextEdit = completedRequest?.name === 'Edit' && prior.operation === 'edit' && operation === 'edit'
      && owner.name === 'Edit' && 'requestId' in owner && owner.requestId !== completedRequest.requestId
      && Number.isFinite(completedRequest.nativeResultAtMs) && owner.capturedAtMs > completedRequest.nativeResultAtMs!
      && owner.cwd === completedRequest.cwd && owner.input.file_path === completedRequest.input.file_path
      && !isDeepStrictEqual(owner.input, completedRequest.input);
    if (!completed || !(prior.operation === 'create' && operation === 'overwrite') && !nextEdit) {
      throw new Error('Repeated native permission request cannot be distinguished from stale rendering');
    }
  }
  granted.add(key);
  requests.set(request, { ...('requestId' in owner ? { requestId: owner.requestId } : { nativeId: owner.id }), operation });
  return true;
}

export function isNativeQuestionSubmitVisible(visible: string): boolean {
  const text = compact(visible);
  return text.includes('readytosubmityouranswers') && text.includes('submitanswers')
    && !text.includes('youhavenotansweredallquestions');
}
