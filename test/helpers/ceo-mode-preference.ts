import { randomUUID } from 'node:crypto';
import {
  isAutoDecidedVisible, isNumberedOptionListVisible, isPlanReadyVisible,
  launchClaudePty, MODE_RE, parseNumberedOptions, type ClaudePtySession,
} from './claude-pty-runner';
import { readOwnedClaudeTranscript, type OwnedClaudeTranscript } from './owned-claude-transcript';
import { matchesNativeQuestion, readPlanSkillQuestions } from './plan-skill-questions';

export const CEO_MODE_QUESTION_ID = 'plan-ceo-review-mode';
const compact = (text: string) => text.replace(/[\s*#]/g, '').toLowerCase();
const modeLabels = (text: string) => new Set(text.toUpperCase().match(/HOLD\s+SCOPE|SELECTIVE\s+EXPANSION|SCOPE\s+REDUCTION|SCOPE\s+EXPANSION/g)).size;
function dialogue(text: string, includeIllustrations = false): string {
  // Illustrations can introduce an unfenced example on the next line. Do not
  // discard that context and then treat its contents as a live decision.
  if (!includeIllustrations && /^\s*(?:#{1,6}\s+)?(?:example\b|template\s*:|expected (?:output|annotation)\s*:|(?:here is|this is|the following is) an? (?:example|template)\b)/im.test(text)) return '';
  let fence: { marker: string; length: number } | null = null;
  return text.split('\n').filter(line => {
    const marker = line.trim().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (fence === null) fence = { marker: marker[0], length: marker.length };
      else if (fence.marker === marker[0] && marker.length >= fence.length && line.trim().slice(marker.length).trim() === '') fence = null;
      return false;
    }
    return fence === null && !/^(?: {4}|\t)|^\s*>/.test(line);
  }).join('\n');
}

function automaticModeEvidence(text: string): string | undefined {
  const label = '(?:HOLD\\s+SCOPE|SELECTIVE\\s+EXPANSION|SCOPE\\s+REDUCTION|SCOPE\\s+EXPANSION)';
  const standard = new RegExp('^Auto-decided (?:CEO )?(?:review )?mode(?: selection)?\\s*(?:→|:|—)\\s*' + label + '\\s*\\(your preference\\)[.!]?$', 'i');
  const observed = new RegExp('^(?:Review )?Mode is ' + label + '\\s*\\(auto-decided from plan-tune preference\\)[.!]?$', 'i');
  // Bind the attribution and chosen mode in one affirmative decision sentence.
  // Loose same-paragraph co-occurrence admits negation, examples and future plans.
  return dialogue(text).replace(/\*\*/g, '').split(/\n|(?<=[.!?])\s+/)
    .map(sentence => sentence.trim()).find(sentence => isAutoDecidedVisible(sentence) && (standard.test(sentence) || observed.test(sentence)));
}


/** Corroborate a completed two-choice prose brief through its exact final reply
 * instruction. TUI redraws need not retain the entire paragraph contiguously.
 * The owned heading, question ID and both offered selectors remain required;
 * this never accepts a bare ID, fuzzy option match or an illustrated preview.
 */
function isTwoChoiceReplyVisible(text: string, visible: string, questionId: string, selectors: string[]): boolean {
  if (selectors.length !== 2 || new Set(selectors).size !== 2) return false;
  const lines = text.replace(/\*\*/g, '').split('\n').map(line => line.trim());
  const heading = lines.find(line => line && !/^[-*_]{3,}$/.test(line));
  if (!heading || !/^D[1-9]\d*\s+[—–-]\s+.+\?$/.test(heading)) return false;
  const reply = lines.filter(Boolean).at(-1)!;
  const match = reply.match(/^Reply ([A-D]|[1-4]) to (.+), or ([A-D]|[1-4]) to (.+)\s+`?<gstack-qid:([a-z0-9-]+)>`?$/);
  if (!match || match[5] !== questionId || match[1] === match[3]
    || !selectors.includes(match[1]) || !selectors.includes(match[3])) return false;
  // Inline-code ticks are decoration, and do not survive the terminal renderer.
  return compact(visible).includes(compact(reply.replace(/`/g, '')));
}

export type ModePreferenceSignal =
  | { kind: 'asked'; evidence: string }
  | { kind: 'auto_decided'; evidence: string }
  | { kind: 'unrelated'; id: string; questionId: string; answer: string; evidence: string }
  | { kind: 'working' };

/** Inspect main-assistant text, never Write previews or preference-tool output.
 * A preference for the mode question says nothing about an approach question.
 */
export function inspectCeoModePreference(transcript: OwnedClaudeTranscript, visible: string): ModePreferenceSignal {
  if (transcript.pendingBytes) return { kind: 'working' };
  const messages = new Map<string, { text: string[]; complete: boolean }>();
  let latestAssistantId: string | null = null;
  let userReplied = false;
  for (const row of transcript.rows) {
    const message = row.message;
    if (row.type === 'user' && message?.role === 'user' && (typeof message.content === 'string'
      || Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'text'))) userReplied = true;
    if (row.type !== 'assistant' || message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    latestAssistantId = typeof message.id === 'string' ? message.id : null;
    userReplied = false;
    if (latestAssistantId) {
      const entry = messages.get(latestAssistantId) ?? { text: [], complete: false };
      entry.complete = message.stop_reason === 'end_turn';
      messages.set(latestAssistantId, entry);
    }
    for (const block of message.content) {
      if (block?.type === 'tool_use' && /(?:^|__)AskUserQuestion$/.test(block.name ?? '')) {
        for (const question of block.input?.questions ?? []) {
          if (question.question?.includes(`<gstack-qid:${CEO_MODE_QUESTION_ID}>`)
            || question.options?.filter((option: any) => MODE_RE.test(option.label ?? '')).length >= 2) {
            return { kind: 'asked', evidence: question.question };
          }
        }
      }
      if (block?.type !== 'text' || typeof block.text !== 'string' || typeof message.id !== 'string') continue;
      const entry = messages.get(message.id) ?? { text: [], complete: false };
      if (!entry.text.includes(block.text)) entry.text.push(block.text);
      messages.set(message.id, entry);
    }
  }
  let automatic: ModePreferenceSignal | undefined;
  let unrelated: ModePreferenceSignal | undefined;
  for (const [id, entry] of messages) {
    // Positive decisions/input use the conservative illustration veto below.
    // It must never erase contrary evidence: an explicit rendered mode prompt
    // makes compliance unproven even in a message containing an example. This
    // text is only a failure signal and never authorizes typing an answer.
    const questionText = dialogue(entry.text.join('\n'), true);
    const modeOptions = [...questionText.replace(/\*\*/g, '').matchAll(/^\s*(?:[-+]\s+)?([A-D]|[1-4])[).]\s+([^\n]+)/gm)];
    // Removed quotations can sit between live prose lines on screen. Requiring
    // the remaining prose to be contiguous would hide an actual mode prompt.
    const questionRendered = questionText.split('\n').filter(line => line.trim())
      .every(line => compact(visible).includes(compact(line)));
    if (entry.complete && modeOptions.length >= 2 && questionRendered &&
      (questionText.includes(`<gstack-qid:${CEO_MODE_QUESTION_ID}>`) || modeLabels(modeOptions.map(option => option[2]).join('\n')) >= 2)) {
      return { kind: 'asked', evidence: questionText };
    }
    const text = dialogue(entry.text.join('\n'));
    const annotation = automaticModeEvidence(text);
    if (annotation && compact(visible).includes(compact(annotation))) {
      automatic = { kind: 'auto_decided', evidence: annotation };
    }
    if (!entry.complete) continue; // Never type an answer while the model uses tools.
    const questionIds = [...text.matchAll(/<gstack-qid:([a-z0-9-]+)>/g)].map(match => match[1]);
    const options = [...text.replace(/\*\*/g, '').matchAll(/^\s*(?:[-+]\s+)?([A-D]|[1-4])[).]\s+([^\n]+)/gm)];
    const fullyRendered = compact(visible).includes(compact(text));
    const replyRendered = questionIds.length === 1 && questionIds[0] !== CEO_MODE_QUESTION_ID
      && modeLabels(options.map(option => option[2]).join('\n')) < 2
      && isTwoChoiceReplyVisible(text, visible, questionIds[0], options.map(option => option[1]));
    if (options.length < 2 || (!fullyRendered && !replyRendered)) continue;
    if (questionIds.includes(CEO_MODE_QUESTION_ID) || modeLabels(options.map(option => option[2]).join('\n')) >= 2) {
      return { kind: 'asked', evidence: text };
    }
    if (questionIds.length === 1 && id === latestAssistantId && !userReplied) {
      const recommended = options.find(option => /recommended/i.test(option[2])) ?? options[0];
      unrelated = { kind: 'unrelated', id, questionId: questionIds[0], answer: recommended[1], evidence: text };
    }
  }
  return automatic ?? unrelated ?? { kind: 'working' };
}

/** Launch → owned question/annotation → scoped answer → observe target only.
 * One entry deadline covers boot and polling; previews cannot produce input.
 */
export async function runCeoModePreferenceObservation(opts: {
  cwd: string; env: Record<string, string>; timeoutMs: number;
}, deps: { launch?: typeof launchClaudePty; pause?: (ms: number) => Promise<unknown>; now?: () => number } = {}): Promise<{
  outcome: 'auto_decided' | 'asked' | 'timeout' | 'exited' | 'plan_ready'; evidence: string; answered: string[];
}> {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? Bun.sleep;
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw new Error('Mode preference timeout must be finite and nonnegative');
  const deadline = now() + opts.timeoutMs;
  const sessionId = randomUUID();
  const answered = new Set<string>();
  if (now() >= deadline) return { outcome: 'timeout', evidence: '', answered: [] };
  const session: ClaudePtySession = await (deps.launch ?? launchClaudePty)({
    permissionMode: 'plan', seedSkills: true, cwd: opts.cwd, env: opts.env,
    extraArgs: ['--session-id', sessionId, '--disallowedTools', 'AskUserQuestion'], timeoutMs: opts.timeoutMs,
  });
  const sleep = async (ms: number) => { if (now() < deadline) await pause(Math.min(ms, deadline - now())); };
  let since = session.mark();
  let inputSince = since;
  const result = (outcome: 'auto_decided' | 'asked' | 'timeout' | 'exited' | 'plan_ready', evidence: string) => ({
    outcome: now() >= deadline ? 'timeout' as const : outcome, evidence: evidence.slice(-3000), answered: [...answered],
  });
  try {
    await sleep(8000);
    if (now() >= deadline) return result('timeout', 'Budget expired during boot');
    since = session.mark(); inputSince = since;
    session.send('/plan-ceo-review\r');
    while (now() < deadline) {
      await sleep(2000);
      if (now() >= deadline) break;
      const visible = session.visibleSince(since);
      if (session.exited()) return result('exited', visible);
      const transcript = readOwnedClaudeTranscript(session.hermeticConfigDir, sessionId);
      const signal = inspectCeoModePreference(transcript, visible);
      if (now() >= deadline) break;
      if (signal.kind === 'asked' || signal.kind === 'auto_decided') return result(signal.kind, signal.evidence);
      if (signal.kind === 'unrelated' && !answered.has(signal.id)) {
        answered.add(signal.id); inputSince = session.mark();
        if (now() >= deadline) break;
        session.send(`For ${signal.questionId}, I choose option ${signal.answer}. Continue the review.\r`);
        continue;
      }
      const native = readPlanSkillQuestions(session.hermeticConfigDir, sessionId);
      if (now() >= deadline) break;
      if (native.pendingBytes) continue;
      const pending = native.calls.filter(call => call.result === 'pending');
      if (pending.length > 1) throw new Error('Ambiguous concurrent question in mode-preference fixture');
      const call = pending[0];
      const questionVisible = session.visibleSince(inputSince);
      if (call && !answered.has(call.id) && isNumberedOptionListVisible(questionVisible)) {
        if (call.questions.length !== 1 || call.questions[0].multiSelect) throw new Error('Unsupported unrelated question shape in mode-preference fixture');
        const question = call.questions[0];
        if (matchesNativeQuestion(question, questionVisible, parseNumberedOptions(questionVisible), native.calls.flatMap(call => call.questions))) {
          answered.add(call.id); inputSince = session.mark();
          if (now() >= deadline) break;
          session.send('1\r');
        }
      }
      if (native.ready && isPlanReadyVisible(questionVisible)) return result('plan_ready', visible);
    }
    return result('timeout', session.visibleSince(since));
  } finally { await session.close(); }
}
