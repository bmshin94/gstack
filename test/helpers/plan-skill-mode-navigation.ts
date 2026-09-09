import { isNumberedOptionListVisible, isPermissionDialogVisible, parseNumberedOptions, MODE_RE, findModeOption, TAIL_SCAN_BYTES, type ClaudePtySession } from './claude-pty-runner';
import { readPlanSkillQuestions, matchesNativeQuestion, isNativeQuestionSubmitVisible, reserveNativePermissionGrant, type NativePermissionGrant } from './plan-skill-questions';
import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** Answer prior native invocations, then select and acknowledge the requested
 * mode. A rendered preview cannot supply either prompt identity or inventory.
 */
type ModeSelection = { modeIndex: number; sincePick: number; toolUseId: string };
type ModeTarget = 'HOLD SCOPE' | 'SCOPE EXPANSION';

export async function navigateToModeAskUserQuestion(
  session: ClaudePtySession, since: number, targetMode: ModeTarget,
  opts: { sessionId: string; maxNav?: number; budgetMs?: number },
): Promise<ModeSelection> {
  return driveModeQuestions(session, since, targetMode, opts);
}

/** A legitimate implementation-approach question can follow the mode ACK.
 * Continue that owned interaction; only the original downstream posture oracle
 * can pass this phase. Answered follow-ups must receive their native ACK first.
 */
export async function waitForNativeModePosture(
  session: ClaudePtySession, selection: ModeSelection, targetMode: ModeTarget,
  opts: { sessionId: string; postureRe: RegExp; budgetMs?: number },
): Promise<void> {
  await driveModeQuestions(session, selection.sincePick, targetMode, {
    sessionId: opts.sessionId, budgetMs: opts.budgetMs ?? 240_000,
    postMode: { ...selection, postureRe: opts.postureRe },
  });
}

async function driveModeQuestions(
  session: ClaudePtySession,
  since: number,
  targetMode: ModeTarget,
  opts: { sessionId: string; maxNav?: number; budgetMs?: number;
    postMode?: ModeSelection & { postureRe: RegExp } },
): Promise<ModeSelection> {
  const maxNav = opts.maxNav ?? 12;
  const budgetMs = opts.budgetMs ?? 420_000;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Native mode navigation budgetMs must be finite and nonnegative');
  const deadline = Date.now() + budgetMs;
  const postMode = opts.postMode;
  let downstreamSnapshot = '';
  let questionSince = since;
  let priorAnswered = 0;
  let selected: { id: string; modeIndex: number; sincePick: number } | null = postMode
    ? { id: postMode.toolUseId, modeIndex: postMode.modeIndex, sincePick: postMode.sincePick } : null;
  const answered = new Map<string, { questions: number; submitted: boolean; counted: boolean }>();
  const granted = new Set<string>();
  const grantedRequests = new Map<string, NativePermissionGrant>();
  let lastNative: ReturnType<typeof readPlanSkillQuestions> | null = null;
  let lastVisible = '';
  let lastSend: { data: string; inputMark: number; visibleBefore: string;
    status: 'attempted' | 'returned' | 'threw'; failure?: string;
    rawCodeUnitsBefore: number | null; rawCodeUnitsAfter: number | null } | null = null;
  // Diagnostics observe the existing state; they never authorize input or
  // change an outcome. Persist before the caller closes and deletes its CLI.
  const retainFailure = (cause: unknown) => {
    const tail = (value: string) => ({ text: value.slice(-16_384), codeUnits: value.length, truncated: value.length > 16_384 });
    try {
      const observationErrors: string[] = [];
      const observe = <T>(label: string, read: () => T, fallback: T): T => {
        try { return read(); }
        catch (error) { observationErrors.push(`${label}: ${String(error)}`.slice(0, 1024)); return fallback; }
      };
      const configDir = observe('config directory', () => session.hermeticConfigDir, null);
      const raw = observe('raw terminal', () => session.rawOutput(), '');
      const visible = observe('current input window', () => session.visibleSince(questionSince), '');
      let nativeFresh = false;
      const native = observe('owned native questions', () => {
        const value = readPlanSkillQuestions(configDir, opts.sessionId, session.nativeQuestionEvents);
        nativeFresh = true;
        return value;
      }, lastNative);
      const identity = (value: string) => ({ text: value.slice(0, 256), codeUnits: value.length, truncated: value.length > 256 });
      const error = String(cause);
      const calls = native?.calls ?? [];
      const permissions = native?.permissionTools ?? [];
      const permissionRequests = native?.permissionRequests ?? [];
      const diagnostic = {
        schemaVersion: 1, sessionId: opts.sessionId, configDir: configDir && tail(configDir), targetMode, budgetMs,
        error: error.slice(0, 1024), errorCodeUnits: error.length, errorTruncated: error.length > 1024,
        since, questionSince, capturedAt: new Date().toISOString(),
        ...(postMode ? { phase: 'posture', modeToolUseId: identity(postMode.toolUseId), downstream: tail(downstreamSnapshot) } : {}),
        selected: selected && { ...selected, id: identity(selected.id) }, priorAnswered,
        answered: [...answered].slice(-64).map(([id, state]) => ({ id: identity(id), ...state })),
        answeredCount: answered.size, answeredOmitted: Math.max(0, answered.size - 64),
        granted: [...granted].slice(-64).map(identity),
        grantedCount: granted.size, grantedOmitted: Math.max(0, granted.size - 64),
        grantedRequestCount: grantedRequests.size,
        nativeSummary: {
          available: native !== null, freshRead: nativeFresh, pendingBytes: native?.pendingBytes ?? null, ready: native?.ready ?? null,
          calls: calls.slice(-64).map(call => ({ id: identity(call.id), result: call.result, questionCount: call.questions.length })),
          callCount: calls.length, callsOmitted: Math.max(0, calls.length - 64),
          permissionTools: permissions.slice(-64).map(tool => ({ id: identity(tool.id), name: identity(tool.name),
            filePath: typeof tool.input.file_path === 'string' ? tail(tool.input.file_path) : null })),
          permissionCount: permissions.length, permissionToolsOmitted: Math.max(0, permissions.length - 64),
          permissionRequests: permissionRequests.slice(-64).map(request => ({ requestId: identity(request.requestId),
            capturedAtMs: request.capturedAtMs, name: request.name, result: request.result,
            nativeToolId: request.nativeToolId ? identity(request.nativeToolId) : null,
            filePath: typeof request.input.file_path === 'string' ? tail(request.input.file_path) : null })),
          permissionRequestCount: permissionRequests.length, permissionRequestsOmitted: Math.max(0, permissionRequests.length - 64),
        },
        native: tail(JSON.stringify(native)), raw: tail(raw), inputRaw: tail(raw.slice(questionSince)),
        inputVisible: tail(visible), lastObservedVisible: tail(lastVisible),
        lastSend: lastSend && { data: lastSend.data.slice(0, 32), inputMark: lastSend.inputMark, status: lastSend.status,
          failure: lastSend.failure?.slice(0, 1024), failureTruncated: (lastSend.failure?.length ?? 0) > 1024,
          rawCodeUnitsBefore: lastSend.rawCodeUnitsBefore, rawCodeUnitsAfter: lastSend.rawCodeUnitsAfter,
          visibleBefore: tail(lastSend.visibleBefore), rawBefore: tail(raw.slice(0, lastSend.inputMark)) },
        observationErrors,
        limits: 'Diagnostic only. A normally returned send proves neither delivery nor acknowledgement. Text/IDs and arrays have explicit clipping metadata. Marks count raw UTF-16 code units. No thinking or native transcript rows are copied.',
      };
      const evalDir = process.env.GSTACK_EVAL_DIR;
      if (!evalDir) throw new Error('GSTACK_EVAL_DIR is not configured');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(opts.sessionId)) throw new Error('Diagnostic session ID is not a UUID');
      const directory = path.join(evalDir, 'mode-navigation');
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${opts.sessionId}.json`);
      const serialized = JSON.stringify(diagnostic, null, 2) + '\n';
      if (Buffer.byteLength(serialized) > 1_048_576) throw new Error('Diagnostic exceeds the 1 MiB retention bound');
      fs.writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
      console.error(`[mode-navigation] failure diagnostic: ${file}`);
    } catch (error) {
      // Secondary diagnostics must not replace the actual navigation failure.
      try { console.error(`Mode navigation diagnostic could not be retained: ${String(error).slice(0, 1024)}`); } catch { /* preserve cause */ }
    }
  };
  const send = (data: string) => {
    if (Date.now() >= deadline) return false;
    lastSend = { data, inputMark: questionSince, visibleBefore: lastVisible, status: 'attempted',
      rawCodeUnitsBefore: null, rawCodeUnitsAfter: null };
    try { lastSend.rawCodeUnitsBefore = session.rawOutput().length; } catch { /* diagnostic only */ }
    try {
      session.send(data);
      lastSend.status = 'returned';
    } catch (cause) {
      lastSend.status = 'threw';
      try { lastSend.failure = String(cause); } catch { lastSend.failure = 'Unprintable thrown value'; }
      throw cause;
    } finally {
      try { lastSend.rawCodeUnitsAfter = session.rawOutput().length; } catch { /* diagnostic only */ }
    }
    return true;
  };
  const pause = async (ms: number) => {
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(ms, remaining));
  };
  try {
  while (Date.now() < deadline) {
    if (session.exited()) throw new Error(postMode
      ? `claude exited (code=${session.exitCode()}) after mode pick.\nDownstream:\n${session.visibleSince(postMode.sincePick).slice(-2000)}`
      : `claude exited (code=${session.exitCode()}) during native mode navigation`);
    await pause(2000);
    if (Date.now() >= deadline) break;
    if (postMode && session.exited()) throw new Error(
      `claude exited (code=${session.exitCode()}) after mode pick.\nDownstream:\n${session.visibleSince(postMode.sincePick).slice(-2000)}`,
    );
    const native = readPlanSkillQuestions(session.hermeticConfigDir, opts.sessionId, session.nativeQuestionEvents);
    const frame = await session.currentScreen?.();
    const afterFrame = readPlanSkillQuestions(session.hermeticConfigDir, opts.sessionId, session.nativeQuestionEvents);
    const visible = frame
      ? frame.rawEnd > questionSince ? frame.text : ''
      : session.visibleSince(questionSince);
    lastVisible = visible;
    lastNative = native;
    if (Date.now() >= deadline) break;
    // A new permission or ACK during the async screen barrier invalidates
    // this pair for counting, completion and input alike.
    if (!isDeepStrictEqual(native, afterFrame)) continue;
    if (native.pendingBytes) continue;
    for (const call of native.calls) {
      const state = answered.get(call.id);
      if (!state || state.counted || call.result === 'pending') continue;
      if (call.result === 'error') throw new Error(`Native AskUserQuestion ${call.id} returned an error during mode navigation`);
      if (state.questions !== call.questions.length) throw new Error('Native question completed before every question tab was answered');
      state.counted = true;
      if (!postMode && selected?.id === call.id) {
        if (Date.now() >= deadline) break;
        return { modeIndex: selected.modeIndex, sincePick: selected.sincePick, toolUseId: selected.id };
      }
      priorAnswered++;
    }
    if (Date.now() >= deadline) break;
    if (postMode) {
      const modeCall = native.calls.find(call => call.id === postMode.toolUseId);
      if (modeCall?.result === 'error') throw new Error('Selected native mode returned an error before posture');
      if (modeCall?.result !== 'answered') continue;
      downstreamSnapshot = session.visibleSince(postMode.sincePick);
      const posture = readNativeModePosture(session.hermeticConfigDir, opts.sessionId, postMode.toolUseId,
        downstreamSnapshot, postMode.postureRe);
      if (Date.now() >= deadline) break;
      if (posture && [...answered.values()].every(state => state.counted) && !native.permissionTools.length
        && !native.permissionRequests.some(request => request.result === 'pending')) return postMode;
    }
    const pending = native.calls.filter(call => call.result === 'pending');
    if (pending.length > 1) throw new Error('Concurrent native AskUserQuestion calls are unsupported during mode navigation');
    const call = pending[0];
    if (!call && isNumberedOptionListVisible(visible) && isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      if (!reserveNativePermissionGrant(native, visible.slice(-TAIL_SCAN_BYTES), granted, grantedRequests)) continue;
      questionSince = session.mark();
      if (!send('1\r')) break;
      await pause(1500);
      continue;
    }
    if (!call) continue;
    let state = answered.get(call.id);
    if (state?.questions === call.questions.length) {
      if (!state.submitted && isNativeQuestionSubmitVisible(visible)) {
        state.submitted = true;
        questionSince = session.mark();
        if (!send('\r')) break;
      }
      continue;
    }
    const question = call.questions[state?.questions ?? 0]!;
    if (question.multiSelect) throw new Error('Native multiSelect AskUserQuestion requires unsupported checkbox navigation');
    if (!isNumberedOptionListVisible(visible) || !matchesNativeQuestion(question, visible, parseNumberedOptions(visible), native.calls.flatMap(call => call.questions))) continue;
    const options = question.options.map((option, index) => ({ index: index + 1, label: option.label }));
    const isMode = options.some(option => MODE_RE.test(option.label));
    const target = isMode ? findModeOption(options, targetMode) : null;
    if (isMode && !target) throw new Error(`Native mode AskUserQuestion does not offer requested "${targetMode}"`);
    if (!postMode && !isMode && selected?.id !== call.id && priorAnswered >= maxNav) throw new Error(`Navigated ${maxNav} prior AskUserQuestions without reaching the mode AskUserQuestion`);
    if (!state) { state = { questions: 0, submitted: false, counted: false }; answered.set(call.id, state); }
    state.questions++;
    questionSince = session.mark();
    if (target && !postMode) selected = { id: call.id, modeIndex: target.index, sincePick: questionSince };
    // A recommendation is a native option label, never text from the preview.
    // Ambiguous or absent recommendation keeps the existing first-option default.
    const recommended = postMode ? options.filter(option => /\(\s*recommended\s*\)\s*$/i.test(option.label)) : [];
    const pick = target?.index ?? (recommended.length === 1 ? recommended[0]!.index : 1);
    // A digit already selects and advances the native single-select menu.
    // Final submit is a separate action after all owned tabs are answered.
    if (!send(String(pick))) break;
    await pause(2000);
  }
  if (postMode) throw new Error(
    `Mode "${targetMode}" routing FAILED: no posture match for ${postMode.postureRe.source}.\n` +
    `--- downstream visible since mode pick (last 3KB) ---\n` + downstreamSnapshot.slice(-3000),
  );
  if (selected) throw new Error(`Selected native mode was not acknowledged within ${budgetMs}ms`);
  throw new Error(`Mode AskUserQuestion not reached within ${budgetMs}ms`);
  } catch (cause) {
    retainFailure(cause);
    throw cause;
  }
}

/** Mode acknowledgement and its echoed label are not downstream posture.
 * Read only assistant text after that result; corroborate the actual matched
 * phrase in the rendered output, excluding thinking and tool payloads.
 */
export function readNativeModePosture(configDir: string | null, sessionId: string, toolUseId: string, visible: string, posture: RegExp): string | null {
  const transcript = readOwnedClaudeTranscript(configDir, sessionId);
  if (transcript.pendingBytes) return null;
  let acknowledged = false;
  let resultTime: string | null = null;
  for (const row of transcript.rows) {
    const message = row.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && block.tool_use_id === toolUseId) {
        if (block.is_error) return null;
        acknowledged = true;
        resultTime = typeof row.timestamp === 'string' ? row.timestamp : null;
      }
      if (!acknowledged || row.type !== 'assistant' || message.role !== 'assistant' || block?.type !== 'text' || typeof block.text !== 'string') continue;
      if (resultTime && typeof row.timestamp === 'string' && row.timestamp < resultTime) continue;
      const found = new RegExp(posture.source, posture.flags.replace(/[gy]/g, '')).exec(block.text)?.[0];
      const compact = (text: string) => text.replace(/[\s*#]/g, '').toLowerCase();
      if (found && compact(visible).includes(compact(found))) return found;
    }
  }
  return null;
}
