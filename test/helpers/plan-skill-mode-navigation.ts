import { isNumberedOptionListVisible, isPermissionDialogVisible, parseNumberedOptions, MODE_RE, findModeOption, TAIL_SCAN_BYTES, type ClaudePtySession } from './claude-pty-runner';
import { readPlanSkillQuestions, matchesNativeQuestion, isNativeQuestionSubmitVisible, nativePermissionKey } from './plan-skill-questions';
import { readOwnedClaudeTranscript } from './owned-claude-transcript';

/** Answer prior native invocations, then select and acknowledge the requested
 * mode. A rendered preview cannot supply either prompt identity or inventory.
 */
export async function navigateToModeAskUserQuestion(
  session: ClaudePtySession,
  since: number,
  targetMode: 'HOLD SCOPE' | 'SCOPE EXPANSION',
  opts: { sessionId: string; maxNav?: number; budgetMs?: number },
): Promise<{ modeIndex: number; sincePick: number; toolUseId: string }> {
  const maxNav = opts.maxNav ?? 12;
  const budgetMs = opts.budgetMs ?? 420_000;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Native mode navigation budgetMs must be finite and nonnegative');
  const deadline = Date.now() + budgetMs;
  let questionSince = since;
  let priorAnswered = 0;
  let selected: { id: string; modeIndex: number; sincePick: number } | null = null;
  const answered = new Map<string, { questions: number; submitted: boolean; counted: boolean }>();
  const granted = new Set<string>();
  const grantedRequests = new Set<string>();
  const send = (data: string) => {
    if (Date.now() >= deadline) return false;
    session.send(data);
    return true;
  };
  const pause = async (ms: number) => {
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(ms, remaining));
  };
  while (Date.now() < deadline) {
    if (session.exited()) throw new Error(`claude exited (code=${session.exitCode()}) during native mode navigation`);
    await pause(2000);
    if (Date.now() >= deadline) break;
    const visible = session.visibleSince(questionSince);
    const native = readPlanSkillQuestions(session.hermeticConfigDir, opts.sessionId);
    if (Date.now() >= deadline) break;
    if (native.pendingBytes) continue;
    for (const call of native.calls) {
      const state = answered.get(call.id);
      if (!state || state.counted || call.result === 'pending') continue;
      if (call.result === 'error') throw new Error(`Native AskUserQuestion ${call.id} returned an error during mode navigation`);
      if (state.questions !== call.questions.length) throw new Error('Native question completed before every question tab was answered');
      state.counted = true;
      if (selected?.id === call.id) {
        if (Date.now() >= deadline) break;
        return { modeIndex: selected.modeIndex, sincePick: selected.sincePick, toolUseId: selected.id };
      }
      priorAnswered++;
    }
    if (Date.now() >= deadline) break;
    const pending = native.calls.filter(call => call.result === 'pending');
    if (pending.length > 1) throw new Error('Concurrent native AskUserQuestion calls are unsupported during mode navigation');
    const call = pending[0];
    if (!call && native.permissionTools.length && isNumberedOptionListVisible(visible) && isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      if (native.permissionTools.length > 1) throw new Error('Ambiguous native permission owner: multiple tools are pending');
      const owner = native.permissionTools[0]!;
      if (granted.has(owner.id)) continue;
      const request = nativePermissionKey(owner, visible.slice(-TAIL_SCAN_BYTES));
      if (grantedRequests.has(request)) throw new Error('Repeated native permission request cannot be distinguished from stale rendering');
      granted.add(owner.id);
      grantedRequests.add(request);
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
    if (!isMode && selected?.id !== call.id && priorAnswered >= maxNav) throw new Error(`Navigated ${maxNav} prior AskUserQuestions without reaching the mode AskUserQuestion`);
    if (!state) { state = { questions: 0, submitted: false, counted: false }; answered.set(call.id, state); }
    state.questions++;
    questionSince = session.mark();
    if (target) selected = { id: call.id, modeIndex: target.index, sincePick: questionSince };
    if (!send(`${target?.index ?? 1}\r`)) break;
    await pause(2000);
  }
  if (selected) throw new Error(`Selected native mode was not acknowledged within ${budgetMs}ms`);
  throw new Error(`Mode AskUserQuestion not reached within ${budgetMs}ms`);
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
