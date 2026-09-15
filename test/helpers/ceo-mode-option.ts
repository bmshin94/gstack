/** Match CEO mode labels after the PTY capture strips cursor-spacing escapes. */
import {
  capturePlanCountQuestion,
  createPlanCountPermissionGuard,
  parseQuestionPrompt,
  parseNumberedOptions,
  auqFingerprint,
  classifyPlanCountFrame,
  isNumberedOptionListVisible,
  matchesNativePlanQuestion,
  planCountSubmissionInput,
  planCountPrerequisitePick,
  type AskUserQuestionFingerprint,
} from './claude-pty-runner';
import type { NativePlanQuestionCall, NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

type CeoMode = 'HOLD SCOPE' | 'SCOPE EXPANSION' | 'SELECTIVE EXPANSION' | 'SCOPE REDUCTION';

function modeTitle(label: string): string | undefined {
  const title = label.split(/[│┌\r\n]/, 1)[0]!.trim().replace(/^[A-Z][).:]\s*/i, '').replace(/\s+/g, '').toUpperCase();
  return /^(HOLDSCOPE|SCOPEEXPANSION|SELECTIVEEXPANSION|SCOPEREDUCTION)(?:$|[^A-Z])/.exec(title)?.[1];
}

export function findCeoModeOption(
  options: ReadonlyArray<{ index: number; label: string }>,
  targetMode: CeoMode,
): number | null {
  const modes = options.map(option => {
    // The CLI renders a description pane beside the options. Its text may
    // mention a different mode, so match only the leading option title.
    return { index: option.index, mode: modeTitle(option.label) };
  });
  if (!modes.some(option => option.mode)) return null;
  const recognized = modes.map(option => option.mode).filter(Boolean);
  if (new Set(recognized).size !== recognized.length) {
    throw new Error('Mode AskUserQuestion has duplicate mode choices');
  }

  const target = modes.find(option => option.mode === targetMode.replace(/\s+/g, ''));
  if (!target) {
    throw new Error(
      `Mode AskUserQuestion rendered but target "${targetMode}" not in option labels:\n` +
      options.map(option => `  ${option.index}. ${option.label}`).join('\n'),
    );
  }
  return target.index;
}

type ModeNavigationAction =
  | { kind: 'wait' }
  | { kind: 'permission' | 'submission'; input: string }
  | { kind: 'question'; index: number; question: AskUserQuestionFingerprint }
  | { kind: 'mode'; index: number; question: AskUserQuestionFingerprint };

// Permission state follows the navigation session without entering its AUQ
// dedup set. A file-tool result can reopen an identical permission prompt.
const permissionStates = new WeakMap<Set<string>, {
  file: ReturnType<typeof createPlanCountPermissionGuard>;
  other: Set<string>;
}>();
function ceoPermissionAction(visible: string, seenQuestions: Set<string>, completionHistory = visible): 'grant' | 'handled' | null {
  let state = permissionStates.get(seenQuestions);
  if (!state) {
    state = { file: createPlanCountPermissionGuard(), other: new Set() };
    permissionStates.set(seenQuestions, state);
  }
  const file = state.file(visible, completionHistory);
  if (file !== null) return file;
  if (classifyPlanCountFrame(visible) !== 'permission') return null;
  const signature = auqFingerprint(parseQuestionPrompt(visible), parseNumberedOptions(visible));
  if (state.other.has(signature)) return 'handled';
  state.other.add(signature);
  return 'grant';
}

/** Handle native controls before deduping actual navigation questions. */
export function nextCeoModeNavigation(
  visible: string,
  targetMode: CeoMode,
  seenQuestions: Set<string>,
  pending?: NativePlanQuestionCall,
  completionHistory = visible,
): ModeNavigationAction {
  const permission = pending && matchesNativePlanQuestion(visible, pending) ? null : ceoPermissionAction(visible, seenQuestions, completionHistory);
  if (permission !== null) return permission === 'grant'
    ? { kind: 'permission', input: '1\r' } : { kind: 'wait' };
  const frame = classifyPlanCountFrame(visible);
  const submission = frame === null ? planCountSubmissionInput(visible) : null;
  if (submission !== null) return { kind: 'submission', input: submission };
  if (!isNumberedOptionListVisible(visible)) return { kind: 'wait' };
  const question = capturePlanCountQuestion(visible, seenQuestions, 0, true, pending);
  if (!question) return { kind: 'wait' };
  const index = findCeoModeOption(question.options, targetMode);
  // Preserve the seeded review plan by declining the existing optional
  // office-hours offer. Other navigation questions keep their first choice.
  return index === null
    ? { kind: 'question', index: planCountPrerequisitePick(question) ?? 1, question }
    : { kind: 'mode', index, question };
}

/** Match new assistant prose, never the native mode menu or answer echo. */
export function hasPostAnswerCeoPosture(visible: string, posture: RegExp): boolean {
  let assistant: string[] | null = null;
  const matches = () => {
    if (!assistant?.length) return false;
    const compact = assistant.join('').replace(/\s+/g, '');
    // Tool headings use the same bullet as assistant messages. Their output
    // can quote the selected mode or the skill's posture instructions. Keep
    // word boundaries when detecting a call: ordinary prose can contain parentheses.
    if (/^(?:UseransweredClaude['’]squestions|(?:high|medium|low)·\/effort)/i.test(compact) ||
        /^[A-Za-z][\w.:_-]*[ \t]*\(/.test(assistant[0]!.trim())) return false;
    // A bare selected title gains no evidentiary value when the next terminal
    // update appends a spinner or other chrome to the same captured block.
    const prose = assistant.filter(line =>
      !/^(?:(?:You)?selected(?:option|mode)?[:：]?)?(?:HOLDSCOPE|SCOPEEXPANSION|SELECTIVEEXPANSION|SCOPEREDUCTION)(?:\(recommended\))?\.?$/i.test(line.replace(/\s+/g, '')) &&
      !/^[✶✻✽✢·]/.test(line),
    ).join('\n');
    return prose.search(posture) !== -1;
  };

  for (const line of visible.replace(/\r\n?/g, '\n').split('\n')) {
    const text = line.trim();
    const message = /^[●⏺]\s*(.*)$/.exec(text);
    if (message) {
      if (matches()) return true;
      assistant = message[1] ? [message[1]] : [];
    } else if (/^(?:[☐☒❯⎿│┌└─⏸]|←|\d+[.)]\s*|Enter\s*to\s*select)/i.test(text)) {
      if (matches()) return true;
      assistant = null;
    } else if (assistant && text) {
      assistant.push(text);
    }
  }
  return matches();
}

/** Apply the same echo/quotation exclusions to native prose and decision rationale. */
function hasNativePostureProse(text: string, posture: RegExp): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => {
    if (/^\s*>/.test(line)) return false;
    const plain = line.replace(/[*_`]/g, '').trim().replace(/^#+\s*/, '');
    // A repeated menu or bare confirmation is still only an answer echo.
    if (/^(?:[-+]|\d+[.)]|[A-D][.)])\s*(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(plain)) return false;
    return !/^(?:(?:You\s+)?selected(?:\s+(?:option|mode))?\s*[:：]?\s*)?(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)(?:\s+mode)?(?:\s+confirmed)?(?:\s*\(recommended\))?[.!]?$/i.test(plain);
  }).join('\n');
  return hasPostAnswerCeoPosture(`● ${prose}`, posture);
}

/** Finish the selected native mode packet before waiting for its answer. */
export function ceoModeSubmissionInput(
  visible: string, selected: NativePlanQuestionCall | undefined, targetMode: CeoMode,
  transcript: PlanCountTranscript, submitted: Set<string>,
): string | null {
  if (!selected || selected.answered || selected.failed || !selected.sessionId || !selected.toolUseId ||
      transcript.status !== 'ready' || selected.questions.length < 2 ||
      selected.questions.length > 4 || selected.questions.some(q => q.multiSelect)) return null;
  const id = `${selected.sessionId}:${selected.toolUseId}`;
  const current = transcript.calls.filter(call => `${call.sessionId}:${call.toolUseId}` === id);
  if (submitted.has(id) || current.length !== 1 || current[0]!.answered || current[0]!.failed ||
      JSON.stringify(current[0]!.questions) !== JSON.stringify(selected.questions)) return null;
  const modeQuestions = selected.questions.filter(q => q.options.filter(o => modeTitle(o.label)).length >= 2);
  if (modeQuestions.length !== 1 || findCeoModeOption(modeQuestions[0]!.options.map((o, i) =>
      ({index:i + 1, label:o.label})), targetMode) === null) return null;
  const bar = posturePacketBar(visible);
  if (!bar || !bar.answered.every(Boolean) || JSON.stringify(bar.headers) !== JSON.stringify(
      selected.questions.map(q => q.header.trim().replace(/\s+/g, ' '))) ||
      planCountSubmissionInput(visible) !== '\r') return null;
  const rawBar = [...visible.matchAll(/←[^\r\n]+✔\s*Submit\s*→/g)].at(-1)!;
  const preceding = visible.slice(0, rawBar.index);
  if (/```|~~~|^\s*>|\b(?:example|quoted|source)[^:\n]*:\s*$/im.test(preceding)) return null;
  const compact = (text: string) => text.replace(/\s+/g, '');
  const panel = compact(visible.slice(rawBar.index! + rawBar[0].length)
    .replace(/^[ \t]*[│┃] ?/gm, '').replace(/^[ \t]*[●⏺] ?/gm, ''));
  // Authenticate the complete review panel against native questions and
  // offered answers. An intended keypress or a selected-mode echo is not an ACK.
  let prefixes = ['Reviewyouranswers'];
  for (const question of selected.questions) {
    const choices = question === modeQuestions[0]
      ? question.options.filter(o => modeTitle(o.label) === targetMode.replace(/\s+/g, ''))
      : question.options;
    if (!choices.length || choices.length > 4) return null;
    prefixes = prefixes.flatMap(prefix => choices.map(choice =>
      prefix + compact(question.question) + '→' + compact(choice.label)));
  }
  if (prefixes.filter(prefix => panel === prefix + BARLESS_SUBMIT_END).length !== 1) return null;
  submitted.add(id);
  return '\r';
}

/** Current scope lock + exclusion + hardening can apply HOLD without naming it. */
function hasCurrentHoldScopePosture(text: string, selected: NativePlanQuestionCall): boolean {
  const plain = text.replace(/\*\*/g, '').replace(/’/g, "'").trim();
  // This gate checks adopted review posture, not completed review work. An
  // immediate first-person commitment carries the same scope obligations as
  // a present-tense declaration; deferred or conditional plans still do not.
  const opening = /^[\s\S]*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? '';
  const sentence = opening.replace(/^(?:I'll|I will|We'll|We will) (lock|keep|hold)\b/i,
    (_match, verb: string) => `I am ${{ lock: 'locking', keep: 'keeping', hold: 'holding' }[verb.toLowerCase()]}`);
  if (/\b(?:not|never|won't|can't|don't|isn't|aren't|if|unless|until|may|might|could|would|will|later|tomorrow|eventually|future|example|hypothetical|after|once|when|whenever|following|pending|provided|assuming)\b|\b(?:next (?:week|month|year)|subject to)\b/i.test(sentence)) return false;
  const declaration = /^(?:I'm|I am|We're|We are) (?:locking|keeping|holding) (?:the )?scope (?:to|at) ([^,\n]+),\s*(?:flagging|treating|marking) (?:anything|everything) (?:beyond|outside) that(?: \([^()\n]+\))? as out of scope,? and (?:hunting|checking|looking) for (?:silent )?(?:failure modes|errors|edge cases)\b([^.!?\n]*)\.$/i.exec(sentence);
  const pressureTest = /^(?:I'm|I am|We're|We are) (?:locking|keeping|holding) (?:the )?scope fixed to ([^,\n]+),\s*pressure[- ]testing every stated behavior for failure modes, ([^.!?\n]+?) while deferring (?:anything|everything) extra rather than adding it silently\.$/i.exec(sentence);
  const ambiguityReview = /^(?:I'm|I am|We're|We are) (?:keeping|holding) strictly to (?:the )?(plan|[\w./-]+\.md)'s approved scope(?: \((Approach [A-Z])(?:, [^()\n]+)?\))? and (?:flagging|surfacing|raising) (?:any|the) ambiguities (?:the (?:sketch|plan) leaves undecided|in the (?:plan|sketch)) as targeted questions rather than expanding scope\.$/i.exec(sentence);
  const commitment = declaration ?? pressureTest;
  if (!commitment && !ambiguityReview) return false;
  // A later current correction can withdraw the declaration. Quoted examples
  // cannot; the opening declaration was matched before removing quoted blocks.
  // Only this recognized opening's explicit exclusion is negative expansion;
  // keep later corrections and every other scope statement in the withdrawal check.
  const current = ambiguityReview
    ? opening.replace(/ rather than expanding scope\.$/i, '.') + plain.slice(opening.length) : plain;
  const currentProse = current.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  if (ambiguityReview && (/\b(?:no longer|not)\s+(?:flagging|surfacing|raising)\s+(?:(?:any|the)\s+)?ambiguities\b/i.test(currentProse) ||
      /\b(?:this|the) posture (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|(?:not|no longer) current)\b/i.test(currentProse))) return false;
  if (/\b(?:expand\w*|widen\w*|reduc(?:e|ing)|shrink\w*)\s+(?:the\s+)?scope\b/i.test(currentProse) ||
      /\b(?:add|adding)\b[^.!?\n]*\b(?:to|into)\s+(?:the\s+)?scope\b/i.test(currentProse) ||
      /\b(?:no longer|not)\s+(?:locking|keeping|holding|lock|keep|hold)\s+(?:(?:the\s+)?scope\b|strictly to (?:the )?(?:plan|[\w./-]+\.md)'s approved scope\b)/i.test(currentProse) ||
      /\b(?:previously|formerly) excluded\b[^.!?\n]*\b(?:now )?in scope\b/i.test(currentProse)) return false;
  const context = selected.questions.map(q => /^Project\/branch\/task:([^\n]*)/im.exec(q.question)?.[1] ?? '').join(' ');
  const plans = new Set(context.match(/\b[\w./-]+\.md\b/gi) ?? []);
  if (ambiguityReview) {
    if (plans.size !== 1 || (sentence.match(/\b[\w./-]+\.md\b/gi) ?? []).some(plan => !plans.has(plan))) return false;
    // Parenthetical approach labels must belong to the approved current plan.
    const approach = ambiguityReview[2];
    const approval = approach ? new RegExp(`\\b${approach}\\b[^.!?\\n]*\\bapproved\\b`, 'i') : /\bapproved\b/i;
    return approval.test(context) && !/\b(?:not|no|unapproved|rejected|hypothetical|if|unless|until|after|once|when|whenever|following|pending|provided|assuming)\b|\bsubject to\b/i.test(context);
  }
  const baseline = commitment![1]!.trim();
  const namedPlan = /^(?:the )?(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) )?([\w./-]+\.md) (?:bullets|requirements|scope)(?: from approach [A-Z])?$/i.exec(baseline);
  const possessivePlan = /^(?:the )?([\w./-]+\.md)'s (?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) )?(?:bullets|requirements|scope)( plus the approved schema)?$/i.exec(baseline);
  const plan = namedPlan ?? possessivePlan;
  if (plan ? plans.size !== 1 || !plans.has(plan[1]!)
    : !/^the (?:current|agreed|approved|existing) (?:plan|scope)$/i.test(baseline)) return false;
  if (possessivePlan?.[2] && (!/\bschema\b[^.!?\n]{0,80}\bapproved\b|\bapproved\b[^.!?\n]{0,80}\bschema\b/i.test(context)
    || /\b(?:not|no|unapproved|rejected|hypothetical|if|unless|until|after|once|when|whenever|following|pending|provided|assuming)\b|\bsubject to\b/i.test(context))) return false;
  // Concrete failure surfaces distinguish review rigor from merely retaining scope.
  const hardening = commitment![2]!;
  return [/\bconstraints\b/i, /\b(?:error handling|errors)\b/i, /\bedge cases\b/i,
    /\baccess(?:-rule)? leaks\b/i, /\bsecurity\b/i, /\btest(?:ing|s)\b/i, /\bproduction visibility\b/i]
    .filter(surface => surface.test(hardening)).length >= 2;
}

/** A native successful answer, not the key we intended to send to the menu. */
export function nativeCeoModeAnswer(
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  selectionStartedAt: number,
): NativePlanQuestionCall | null {
  if (transcript.status !== 'ready') return null;
  const choices = transcript.calls.flatMap(call => {
    const at = Date.parse(call.answeredAt ?? '');
    if (!call.answered || call.failed || !Number.isFinite(at) || at < selectionStartedAt) return [];
    return call.questions.flatMap(question => {
      const recognized = question.options.map(option => modeTitle(option.label)).filter(Boolean);
      const modes = new Set(recognized);
      if (modes.size !== recognized.length) return [{ call, at, mode: undefined }];
      const answer = call.answers?.[question.question];
      return modes.size >= 2 && typeof answer === 'string'
        ? [{ call, at, mode: modeTitle(answer) }] : [];
    });
  }).sort((a, b) => b.at - a.at);
  const latest = choices[0];
  return latest?.mode === targetMode.replace(/\s+/g, '') ? latest.call : null;
}

/** An answered AUQ must have one matching native request and successful reply. */
function completedQuestionTimes(call: NativePlanQuestionCall, events: ReadonlyArray<NativePublicToolEvent>) {
  if (!call.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length) return null;
  const own = events.filter(event => event.sessionId === call.sessionId && event.toolUseId === call.toolUseId);
  const requests = own.filter(event => event.kind === 'use');
  const replies = own.filter(event => event.kind === 'result');
  if (requests.length !== 1 || replies.length !== 1) return null;
  const request = requests[0]!;
  const reply = replies[0]!;
  const requestedAt = Date.parse(request.timestamp);
  const answeredAt = Date.parse(reply.timestamp);
  if (request.name !== 'AskUserQuestion' || reply.isError ||
      JSON.stringify(request.input?.questions) !== JSON.stringify(call.questions) ||
      reply.timestamp !== call.answeredAt || !Number.isFinite(requestedAt) ||
      !Number.isFinite(answeredAt) || requestedAt >= answeredAt) return null;
  return { requestedAt, answeredAt };
}

/** New shorthand forms must be one complete decision, not a mode mention or extra question. */
function singleScopeBrief(text: string, descriptions: readonly string[], comparison = true, expansion = false, proposalHeading = false): boolean {
  if ([text, ...descriptions].some(value => /(?:^|[.!?]\s+|\n)\s*(?:Also|Separately|Additionally)\b|\b(?:Please|We must|You must|The plan must)\b/i.test(value))) return false;
  // Query parameter names such as ?view= are not another decision prompt.
  // A quoted user scenario is not a second decision. Keep its original text
  // for all instruction, context and posture checks; remove only its question marks here.
  const questionText = expansion ? text.replace(/"[^"\n]*"|“[^”\n]*”/g,
    quote => quote.replace(/\?/g, '')) : text;
  const questions = questionText.replace(/\?[A-Za-z_][\w-]*=/g, '=').match(/\?/g);
  if ((questions?.length ?? 0) !== (proposalHeading ? 0 : 1) || /```|~~~|^\s*>/m.test(text)) return false;
  const comparisonMarker = expansion
    ? /Completeness:|Note:\s*options differ in kind, not coverage\s*[—–-]\s*no completeness score\./gi
    : /Completeness:/gi;
  const markers = [/Project\/branch\/task:/gi, /ELI10:/gi, /Stakes if (?:we pick )?wrong:/gi,
    /Recommendation:/gi, comparisonMarker, /Net:/gi];
  let previous = -1;
  const complete = markers.every(marker => {
    const matches = [...text.matchAll(marker)];
    if (matches.length !== 1 || matches[0]!.index! <= previous) return false;
    previous = matches[0]!.index!;
    return true;
  });
  // Net closes this decision brief. A following instruction is not part of its
  // comparison; this is not a general classifier of instructions inside prose.
  const net = text.slice(previous + 'Net:'.length).trim();
  if (expansion && /Completeness:/i.test(text)) {
    const scores = /Completeness:([\s\S]*?)Net:/i.exec(text)?.[1] ?? '';
    const ratings = [...scores.matchAll(/\b[A-D]\s*[:=]\s*(\d+)\s*\/\s*10\b/g)];
    if (!ratings.length || ratings.some(score => Number(score[1]) > 10)) return false;
  }
  return complete && (comparison ? /^[^.!?;\n]+ (?:vs|versus) [^.!?;\n]+\.$/.test(net)
    : /^[^.!?;\n]+\.$/.test(net.replace(/\bvs\./gi, 'vs')));
}

/** HOLD can apply its boundary in a completed defer decision, before standalone prose. */
function hasAnsweredHoldPosture(transcript: PlanCountTranscript, selected: NativePlanQuestionCall,
  posture: RegExp, events: ReadonlyArray<NativePublicToolEvent>): boolean {
  const modeTimes = completedQuestionTimes(selected, events);
  if (!modeTimes) return false;
  return transcript.calls.some(call => {
    if (call === selected || call.sessionId !== selected.sessionId || call.questions.length !== 1) return false;
    const times = completedQuestionTimes(call, events);
    if (!times || times.requestedAt <= modeTimes.answeredAt) return false;
    const q = call.questions[0]!;
    // A substantive review decision can apply HOLD in its rationale before
    // standalone prose is published. Metadata and answer echoes do not count.
    // This recognizes posture language; it does not validate every scope choice.
    const context = /Project\/branch\/task:([\s\S]*?)(?=ELI10:)/i.exec(q.question)?.[1] ?? '';
    const rationale = /ELI10:([\s\S]*?)(?=Stakes if (?:we pick )?wrong:)/i.exec(q.question)?.[1]?.trim() ?? '';
    const offered = q.options.map(o => o.label.trim());
    if (!q.multiSelect && q.options.length >= 2 && q.options.length <= 4 && new Set(offered).size === offered.length &&
        offered.includes(call.answers?.[q.question] ?? '') && /\bHOLD SCOPE\b/i.test(context) &&
        !/\b(?:SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(context) &&
        singleScopeBrief(q.question, q.options.map(o => o.description ?? ''), false) &&
        hasNativePostureProse(rationale, posture)) return true;
    if (q.multiSelect || q.options.length !== 3 || !singleScopeBrief(q.question, q.options.map(o => o.description ?? ''))) return false;
    const title = /^D\d+\s*[—–-]\s*Under HOLD SCOPE, keep or defer the (\w+)\b([\s\S]+?)\?\s+Project\/branch\/task:/i.exec(q.question);
    if (!title || !/\bnot in the plan text\b/i.test(title[2]!) ||
        !/\bwritten scope is the baseline\b/i.test(q.question) ||
        !/\bpure additions,\s*not repairs to meet a stated invariant\b/i.test(q.question)) return false;
    const labels = q.options.map(o => o.label.trim().replace(/^[A-C][):.]\s*/i, '')
      .replace(/\s*\(recommended\)\s*$/i, '').toLowerCase());
    const count = title[1]!.toLowerCase();
    const defer = labels.findIndex(label => label === `defer all ${count} to todos` || label === `defer all ${count} to todos.md`);
    const subset = labels.find(label => /^keep .+ only$/.test(label));
    if (new Set(labels).size !== 3 || defer < 0 || !labels.includes(`keep all ${count}`) ||
        !subset || !title[2]!.toLowerCase().includes(subset.slice(5, -5)) ||
        call.answers?.[q.question] !== q.options[defer]!.label) return false;
    return hasPostAnswerCeoPosture(`● ${q.question}`, posture);
  });
}

/** A fourth Hold/Pause control can only defer the decision for discussion. */
function expansionDiscussionControl(label: string, description: string): boolean {
  const title = label.replace(/^[A-D][):.]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '').trim();
  const match = /^(?:hold|pause)\b([\s\S]*)$/i.exec(title);
  if (!match) return false;
  // Parentheses, separators and wrapping describe the same procedural action.
  // A qualifier naming another action is not merely a discussion control.
  const qualifier = match[1]!.toLowerCase().replace(/[()[\]—–:;,.-]/g, ' ').trim();
  const procedural = new Set(['stop', 'pause', 'wait', 'review', 'chain', 'questions', 'proposals',
    'decision', 'decisions', 'discuss', 'discussion', 'talk', 'clarify', 'clarification',
    'first', 'before', 'deciding', 'to', 'the', 'this', 'one', 'through', 'for', 'and']);
  if (qualifier && qualifier.split(/\s+/).some(word => !procedural.has(word))) return false;
  if (!description.trim()) return !qualifier;
  // Quoted assurances cannot establish that this control makes no disposition.
  const prose = description.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’/g, '');
  const noDecision = /\b(?:nothing\s+(?:is\s+)?(?:decided|approved|selected)|no\s+(?:scope\s+)?(?:decision|choice|disposition|approval)\s+(?:is\s+)?(?:made|recorded|granted|selected))\b/gi;
  if (!noDecision.test(prose) || !/\b(?:paus\w*|stop\w*|wait\w*|discuss\w*|talk)\b/i.test(prose)) return false;
  // Keep all remaining text, including quotations, in the effect veto. A
  // no-decision assurance cannot conceal a second action in the same control.
  const effects = `${title}\n${description}`.replace(noDecision, '');
  return !/\b(?:add\w*|includ\w*|approv\w*|accept\w*|reject\w*|skip\w*|cut\w*|implement\w*|ship\w*|deploy\w*|delet\w*|remov\w*|creat\w*|writ\w*|updat\w*|enabl\w*|disabl\w*|chang\w*|select\w*|choos\w*|record\w*|execut\w*|commit\w*|roll\s+back)\b/i.test(effects);
}

/** A named current proposal may state its scope comparison without a question-mark title. */
function concreteExpansionProposal(title: string, text: string): boolean {
  const name = /^(?:Proposal\s+\d+\s+of\s+\d+\s*[:—–-]\s*)?(E[1-9]\d*)\s*[:—–-]\s*\S/i.exec(title);
  if (!name) return false;
  const rationale = /ELI10:([\s\S]*?)(?=Stakes if (?:we pick )?wrong:)/i.exec(text)?.[1] ?? '';
  const prose = rationale.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/"[^"\n]*"|“[^”\n]*”/g, '').trim();
  const baseline = /(?:^|[.!]\s+)(?:Today\b|Currently\b|As written\b|The current plan\b)([^.!\n]+)[.!]/i.exec(prose);
  if (!baseline || !/\b(?:only|each|per|private|personal|limited|without|cannot|can't)\b/i.test(baseline[1]!)) return false;
  // The same native E<n> identity must add a stated capability to that current scope.
  return new RegExp(`(?:^|[.!]\\s+)${name[1]} (?:would |will |proposes to )?(?:add|adds|introduce|introduces|extend|extends) \\S[^.!\\n]+[.!]`, 'i')
    .test(prose.slice(baseline.index! + baseline[0].length).trimStart());
}

/** A concrete, opted-in expansion brief is itself assistant posture evidence. */
function hasAnsweredExpansionPosture(
  transcript: PlanCountTranscript, selected: NativePlanQuestionCall,
  posture: RegExp, events: ReadonlyArray<NativePublicToolEvent>,
): boolean {
  const modeTimes = completedQuestionTimes(selected, events);
  if (!modeTimes) return false;
  return transcript.calls.some(call => {
    if (call === selected || call.sessionId !== selected.sessionId || call.questions.length !== 1) return false;
    const times = completedQuestionTimes(call, events);
    if (!times || times.requestedAt <= modeTimes.answeredAt) return false;
    const question = call.questions[0]!;
    // This is evidence that the selected mode produced a concrete scope
    // decision, not authority to answer it. Numbering and heading names vary.
    const title = question.question.split('\n')[0]!
      .replace(/\s*<gstack-qid:[a-z0-9-]+>\s*$/i, '').replace(/^D\d+(?:\.\d+)*\s*[—–-]\s*/i, '');
    const context = /\nProject\/branch\/task:([^\n]+)/i.exec(question.question)?.[1] ?? '';
    const concreteProposal = concreteExpansionProposal(title, question.question);
    if (question.multiSelect || question.options.length < 3 || question.options.length > 4 ||
        (!/^[\p{L}\p{N}][^?\n]+\?$/u.test(title) && !concreteProposal) ||
        /\b(?:review\s+(?:mode|posture)|(?:selected|confirmed)\s+(?:mode|option))\b/i.test(title) ||
        /^(?:(?:continue|proceed|resume|start|finish)\b[^?]*\b(?:review|questions?|ceremony)|(?:are|should|can|do) (?:we|I|you) (?:continue|proceed|resume)|how\b[^?]*\b(?:decide|batch|split|group))\b/i.test(title) ||
        /\b(?:HOLD SCOPE|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(context) ||
        (!/\b(?:SCOPE\s+EXPANSION|EXPANSION\s+(?:mode|opt[ -]in))\b/i.test(context) && !concreteProposal) ||
        !singleScopeBrief(question.question, question.options.map(o => o.description ?? ''), false, true, concreteProposal && !title.includes('?'))) return false;
    // Equivalent core dispositions demonstrate mode application. A separate
    // discussion control may pause the decision, but its answer supplies no posture credit.
    const dispositions = question.options.map(option => {
      const label = option.label.trim().replace(/^[A-D][):.]\s*/i, '')
        .replace(/\s*\(recommended\)\s*$/i, '').toLowerCase();
      if (/^(?:include|add to (?:(?:this|the) plan['’]s )?scope)$/.test(label)) return 'include';
      if (/^defer to todos(?:\.md)?$/.test(label)) return 'defer';
      if (/^(?:skip|cut)(?: entirely| (?:this proposal|from (?:this |the )?scope))?$/.test(label)) return 'skip';
      if (expansionDiscussionControl(label, option.description ?? '')) return 'pause';
      return null;
    });
    const answer = question.options.findIndex(option => option.label === call.answers?.[question.question]);
    if (dispositions.includes(null) || new Set(dispositions).size !== dispositions.length ||
        !['include', 'defer', 'skip'].every(value => dispositions.includes(value)) ||
        answer < 0 || dispositions[answer] === 'pause') return false;
    // Never search quoted instructions, tool output or a menu for posture.
    const prose = question.question.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^\s*>.*$/gm, '');
    return hasPostAnswerCeoPosture(`● ${prose}`, posture) || (concreteProposal && selected.questions.some(q =>
      (selected.answers?.[q.question] ?? '').search(posture) !== -1));
  });
}

/** Match finalized prose or a completed concrete scope decision after the actual mode answer. */
export function hasNativePostAnswerCeoPosture(
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  posture: RegExp,
  selectionStartedAt: number,
  publicTools: ReadonlyArray<NativePublicToolEvent> = [],
): boolean {
  const selected = nativeCeoModeAnswer(transcript, targetMode, selectionStartedAt);
  if (!selected) return false;
  const answeredAt = Date.parse(selected.answeredAt!);
  return transcript.assistantMessages.some(message => {
    if (message.sessionId !== selected.sessionId || Date.parse(message.timestamp) <= answeredAt) return false;
    return hasNativePostureProse(message.text, posture) ||
      (targetMode === 'HOLD SCOPE' && Number.isFinite(Date.parse(message.timestamp)) &&
        Date.parse(message.timestamp) <= Date.now() &&
        hasCurrentHoldScopePosture(message.text, selected));
  }) || (targetMode === 'SCOPE EXPANSION' && hasAnsweredExpansionPosture(transcript, selected, posture, publicTools)) ||
    (targetMode === 'HOLD SCOPE' && hasAnsweredHoldPosture(transcript, selected, posture, publicTools));
}

type PosturePacket = { headers: string[]; screens: string[]; next: number; nativeId?: string; submitted: boolean };
const postureContinuations = new WeakMap<Set<string>, { modeId: string; packet?: PosturePacket }>();

/** The complete native bar binds delayed-JSONL tabs to one bounded AUQ. */
function posturePacketBar(visible: string): { headers: string[]; answered: boolean[] } | null {
  const bars = [...visible.matchAll(/←([^\r\n]+)✔\s*Submit\s*→/g)];
  const bar = bars.at(-1);
  if (!bar) return null;
  const tabs = [...bar[1]!.matchAll(/([☐☒])\s*([^☐☒]+)/g)];
  if (tabs.length < 2 || tabs.length > 4 || bar[1]!.slice(0, tabs[0]!.index).trim()) return null;
  const headers = tabs.map(tab => tab[2]!.trim().replace(/\s+/g, ' '));
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) return null;
  return { headers, answered: tabs.map(tab => tab[1] === '☒') };
}

const BARLESS_SUBMIT_END = 'Readytosubmityouranswers?❯1.Submitanswers2.Cancel';

/** The barless review must reproduce every observed question and chosen option. */
function barlessPostureSubmit(visible: string, packet: PosturePacket): boolean {
  if (packet.next !== packet.headers.length || packet.screens.length !== packet.next) return false;
  const compact = (text: string) => text.replace(/^[\t │┃]*[●⏺][\t ]*/gm, '')
    .replace(/[│┃\s]/g, '');
  let prefix = '';
  const answers: string[] = [];
  for (const screen of packet.screens) {
    const bar = [...screen.matchAll(/←[^\r\n]+✔\s*Submit\s*→/g)].at(-1);
    const cursor = [...screen.matchAll(/❯\s*1\./g)].at(-1);
    const choice = parseNumberedOptions(screen).find(option => option.index === 1)?.label;
    if (!bar || !cursor || !choice || cursor.index! <= bar.index! + bar[0].length) return false;
    const question = compact(screen.slice(bar.index! + bar[0].length, cursor.index));
    if (!question || /[←☐☒❯]/.test(question)) return false;
    // The caller answers option 1 for each of this one bounded call's tabs.
    answers.push(`${question}→${compact(choice)}`);
    prefix = compact(screen.slice(0, bar.index));
  }
  const panel = compact(visible);
  if (!panel.startsWith(prefix)) return false;
  const body = panel.slice(prefix.length).replace(/^Reviewyouranswers/, '');
  return body === answers.join('') + BARLESS_SUBMIT_END;
}

/** A complete numbered candidate inventory can bind one question per item.
 * This selects a walkthrough only: no candidate receives a scope disposition. */
function completeCandidateSplit(q: NativePlanQuestionCall['questions'][number]): number | null {
  const title = q.question.split('\n')[0]!;
  const count = /\b([1-9]\d*)\s+(?:expansion\s+)?candidates?\b/i.exec(title);
  const rationale = /ELI10:\s*([\s\S]*?)(?=Stakes if (?:we pick )?wrong:)/i.exec(q.question)?.[1] ?? '';
  const inventory = /\b([1-9]\d*)\s+(?:adjacent improvements|candidate expansions|expansion candidates|items|candidates)\s*:\s*([^.!?\n]+)[.!?]/i.exec(rationale);
  if (!count || !inventory || count[1] !== inventory[1] ||
      /\b(?:example|quoted|historical|previously|formerly|if|unless)\b/i.test(rationale.slice(0, inventory.index))) return null;
  const ids = [...inventory[2]!.matchAll(/(?:^|[,;]\s*|\band\s+)([A-Z])([1-9]\d*)\s+/g)];
  const n = Number(count[1]), prefix = ids[0]?.[1];
  if (!Number.isSafeInteger(n) || n < 2 || ids.length !== n || !prefix ||
      ids.some((id, i) => id[1] !== prefix || Number(id[2]) !== i + 1)) return null;
  const options = [...q.question.matchAll(/(?:^|\n)([A-D])[):.]\s+[^\n]+/g)];
  if (options.length !== q.options.length || new Set(options.map(o => o[1])).size !== options.length) return null;
  const netAt = q.question.lastIndexOf('\nNet:');
  if (netAt <= options.at(-1)!.index!) return null;
  const menu = (value: string) => value.replace(/\bAdd\s*\/\s*Defer\s*\/\s*Skip(?:\s*\/\s*Hold)?\b/gi, '');
  const scopeEffect = /\b(?:approv\w*|authori[sz]\w*|accept\w*|commit\w*|adopt\w*|implement\w*|add(?:s|ed|ing)?|includ\w*|remov\w*|delet\w*|drop\w*|cut(?:s|ting)?|skip\w*|defer\w*|merg\w*|ship\w*|deploy\w*|enabl\w*|disabl\w*)\b/i;
  // An unconditional or selected-choice effect cannot hide in another option.
  if (/\b(?:regardless|whichever|choosing|selecting|picking|any choice|every choice)\b[^.!?\n]*\b(?:approv\w*|authori[sz]\w*|commit\w*|add(?:s|ed|ing)?|delet\w*|drop\w*|skip\w*|defer\w*|merg\w*)\b/i.test(q.question)) return null;
  // Feature titles may describe Update or delete behavior. Explicit actor
  // grants, imperative dispositions and current approval status are different:
  // none may hide inside the inventory or its surrounding rationale.
  const premise = menu(q.question.slice(0, options[0]!.index));
  const disposition = '(?:approved|accepted|authorized|authorised|adopted|committed|deferred|skipped|rejected|excluded|in scope|out of scope)';
  if (/\b(?:we|I|you|this (?:answer|choice|selection))\s+(?:(?:now|hereby|already|automatically|will)\s+)*(?:approv\w*|accept\w*|authori[sz]\w*|adopt\w*|commit\w*|defer\w*|skip\w*|reject\w*|exclude\w*|add\w*|include\w*|remove\w*|drop\w*|merge\w*|ship\w*)\b/i.test(premise) ||
      new RegExp(`\\b(?:already|now|hereby|automatically|is|are|was|were|has been|have been)\\s+(?:(?:already|now|hereby|automatically)\\s+)*${disposition}\\b`, 'i').test(premise) ||
      new RegExp(`\\b(?:all|every|these|those)(?:\\s+\\w+){0,3}\\s+${disposition}\\b|[([]\\s*${disposition}\\b`, 'i').test(premise) ||
      /(?:^|[;:.])\s*(?:approve|accept|authorize|authorise|adopt|commit|defer|skip|reject|exclude|add|include|remove|drop|merge|ship)\s+(?:all|every|these|those|[A-Z][1-9]\d*)\b/im.test(premise)) return null;
  const common = menu(q.question.slice(0, options[0]!.index) + q.question.slice(netAt))
    .replace(inventory[0], '')
    .replace(/\bnothing gets (?:cut|dropped|removed|omitted) silently\b/gi, '');
  if (scopeEffect.test(common)) return null;
  const candidates = q.options.flatMap((o, index) => {
    const id = /^([A-D])[):.]\s*/i.exec(o.label)?.[1]?.toUpperCase();
    const label = o.label.replace(/^[A-D][):.]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '');
    const numbers = label.match(/\b\d+\b/g) ?? [];
    const rawDescription = o.description ?? '';
    const description = menu(rawDescription.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '')).trim();
    const option = options.findIndex(option => option[1] === id);
    if (!id || option < 0 || numbers.length !== 1 || Number(numbers[0]) !== n ||
        !/\b(?:full|complete|all)\b/i.test(label) || !/\b(?:split|walkthrough|per[- ]item|one[- ]by[- ]one)\b/i.test(label) ||
        !/\bquestions?\b/i.test(label) ||
        !/\bone\s+question per (?:candidate|item|proposal)\b/i.test(description) ||
        !new RegExp(`\\b${prefix}1\\s*(?:through|to|[-–—])\\s*${prefix}${n}\\b`).test(description)) return [];
    const ownBrief = q.question.slice(options[option]!.index!, options[option + 1]?.index ?? netAt);
    const own = menu(label + '\n' + rawDescription + '\n' + ownBrief);
    if (/```|~~~|^\s*>|\b(?:not|never|without|except|excluding|omit\w*|narrow\w*|batch\w*|subset|shortlist|groups?)\b/im.test(label + '\n' + description) ||
        scopeEffect.test(own)) return [];
    return [index + 1];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Only the full independent walkthrough is navigation; no scope selection is authorized. */
export function ceoExpansionPacingChoice(visible: string, transcript: PlanCountTranscript,
  selectionStartedAt: number, pending?: NativePlanQuestionCall & {source:'pre_tool_use'}) {
  const selected = nativeCeoModeAnswer(transcript, 'SCOPE EXPANSION', selectionStartedAt);
  const waiting = transcript.calls.filter(c => !c.answered && !c.failed);
  const call = waiting[0] ?? pending;
  if (!selected || !call || call.answered || call.failed || call.sessionId !== selected.sessionId ||
      call.toolUseId === selected.toolUseId || !call.questions.length ||
      !matchesNativePlanQuestion(visible, call)) return null;
  const position = transcript.calls.indexOf(call);
  if (position >= 0 && position <= transcript.calls.indexOf(selected)) return null;
  const q = call.questions[0]!;
  const pacing = call.questions.some(q=>/\bhow\b[^?\n]*\b(?:walk|present|review|group|batch|split|decide)\b[^?\n]*\?/i.test(q.question.split('\n')[0]!) &&
    /\b(?:proposals|items|expansions|candidates)\b/i.test(q.question));
  if (!pacing) return null;
  // Index zero is an explicit unsupported pacing outcome, never a request
  // for the caller's generic first-option fallback.
  const refused=()=>({call,index:0,mode:selected});
  if (waiting.length>1 || call.questions.length!==1 || q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
      !/Project\/branch\/task:[^\n]*\bSCOPE EXPANSION\b/i.test(q.question) ||
      !singleScopeBrief(q.question,q.options.map(o=>o.description ?? ''),false,true)) return refused();
  let selectedIndex = completeCandidateSplit(q);
  if (selectedIndex === null) {
    if (!/\beach\b[^.!?\n]*\bseparate (?:scope call|decision)\b/i.test(q.question)) return refused();
    // The question can grant scope even when its selected option sounds like
    // navigation. Future disposition labels are a menu, not an operative grant.
    // Keep quoted text in this veto; it cannot smuggle a second scope effect.
    const questionEffects=q.question.replace(/\bAdd\s*\/\s*Defer\s*\/\s*Skip(?:\s*\/\s*Hold)?\b/gi,'');
    const scopeAction=/\b(?:approv(?:e|es|ed|ing)|authori[sz](?:e|es|ed|ing)|accept(?:s|ed|ing)?|commit(?:s|ted|ting)?|adopt(?:s|ed|ing)?|implement(?:s|ed|ing)?|add(?:s|ed|ing)?|includ(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|drop(?:s|ped|ping)?|cut(?:s|ting)?|skip(?:s|ped|ping)?|defer(?:s|red|ring)?|merg(?:e|es|ed|ing)|ship(?:s|ped|ping)?|deploy(?:s|ed|ing)?|enabl(?:e|es|ed|ing)|disabl(?:e|es|ed|ing))\b/i;
    if (scopeAction.test(questionEffects)) return refused();
    const choices = q.options.map((o,index) => ({o,index:index+1})).filter(({o}) => {
      const label=o.label.replace(/^[A-D][):.]\s*/i,'').replace(/\s*\(recommended\)\s*$/i,'');
      const rawDescription=o.description ?? '';
      const description=rawDescription.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'')
        .replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’/g,'');
      const unchanged=/\bno (?:proposal|item) (?:is )?(?:dropped|removed|skipped) or merged without your (?:say|approval)\b/i;
      if (!/\b(?:per[- ]item|one[- ]by[- ]one|individually|separately)\b/i.test(label) ||
          /\b(?:narrow|batch|cut|skip|defer|subset|shortlist|groups?)\b/i.test(label) ||
          !/\bone per (?:proposal|item)\b|\beach (?:proposal|item) (?:separately|individually)\b/i.test(description) ||
          !unchanged.test(description)) return false;
      const effects=label+'\n'+rawDescription.replace(unchanged,'').replace(/\bAdd\s*\/\s*Defer\s*\/\s*Skip(?:\s*\/\s*Hold)?\b/gi,'');
      // The brief may compare batching/narrowing as unselected pacing options;
      // the chosen full independent walkthrough cannot perform either.
      return !scopeAction.test(effects) && !/\b(?:narrow\w*|batch\w*)\b/i.test(effects);
    });
    if (choices.length !== 1) return refused();
    selectedIndex = choices[0]!.index;
  }
  const rendered=parseNumberedOptions(visible),compact=(s:string)=>s.replace(/\s+/g,'');
  const controls=rendered.slice(q.options.length);
  if (rendered.length<q.options.length || !q.options.every((o,i)=>
      compact(rendered.find(r=>r.index===i+1)?.label ?? '').startsWith(compact(o.label))) ||
      controls.length>2 || !controls.every((o,i)=>o.index===q.options.length+i+1 &&
        (i===0?/^Typesomething\.?$/i:/^Chataboutthis$/i).test(compact(o.label)))) return refused();
  return {call,index:selectedIndex,mode:selected};
}

/** Sending a pacing key never supplies an ACK or consumes the substantive allowance. */
export function ceoExpansionPacingReady(visible: string, transcript: PlanCountTranscript,
  choice: NonNullable<ReturnType<typeof ceoExpansionPacingChoice>>, events: ReadonlyArray<NativePublicToolEvent>): boolean {
  if(choice.index<1)return false;
  const owned=transcript.calls.filter(c=>c.sessionId===choice.call.sessionId&&c.toolUseId===choice.call.toolUseId);
  if(owned.length!==1)return false;
  const call=owned[0]!;
  const times=call&&completedQuestionTimes(call,events);
  if (!call || !times || times.requestedAt <= Date.parse(choice.mode.answeredAt!) ||
      JSON.stringify(call.questions)!==JSON.stringify(choice.call.questions) ||
      call.answers?.[call.questions[0]!.question]!==choice.call.questions[0]!.options[choice.index-1]!.label) return false;
  return !matchesNativePlanQuestion(visible,choice.call);
}

/**
 * Claude can defer persisting assistant prose until the next AUQ resolves.
 * Permit one fresh downstream call, including its remaining tabs and Submit.
 * Native completion still supplies all posture evidence; UI only drives input.
 */
export function nextCeoPostureContinuation(
  visible: string,
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  selectionStartedAt: number,
  seenQuestions: Set<string>,
  alreadyContinued: boolean,
  completionHistory = visible,
  pendingQuestion?: NativePlanQuestionCall & {source:'pre_tool_use'},
): 'permission' | 'question' | 'submission' | null {
  const supplied = pendingQuestion?.source === 'pre_tool_use' && !pendingQuestion.answered && !pendingQuestion.failed &&
    !transcript.calls.some(call => call.sessionId === pendingQuestion.sessionId && call.toolUseId === pendingQuestion.toolUseId)
    ? pendingQuestion : undefined;
  const pending = transcript.calls.find(call => !call.answered && !call.failed) ?? supplied;
  const permission = pending && matchesNativePlanQuestion(visible, pending) ? null : ceoPermissionAction(visible, seenQuestions, completionHistory);
  if (permission !== null) return permission === 'grant' ? 'permission' : null;
  const selected = nativeCeoModeAnswer(transcript, targetMode, selectionStartedAt);
  if (!selected) return null;
  if (pending && pending.sessionId !== selected.sessionId) return null;
  const modeId = `${selected.sessionId}:${selected.toolUseId}`;
  const state = postureContinuations.get(seenQuestions);
  if (state && state.modeId !== modeId) return null;
  const bar = posturePacketBar(visible);
  const packet = state?.packet;
  if (state || alreadyContinued) {
    if (!packet || packet.submitted) return null;
    const barless = !bar && barlessPostureSubmit(visible, packet);
    if (!barless && (!bar || JSON.stringify(bar.headers) !== JSON.stringify(packet.headers) ||
        !bar.answered.every((answered, i) => answered === (i < packet.next)))) return null;
    const sameHeaders = (call: NativePlanQuestionCall) => JSON.stringify(call.questions.map(q =>
      q.header.trim().replace(/\s+/g, ' '))) === JSON.stringify(packet.headers);
    const recorded = transcript.calls.slice(transcript.calls.indexOf(selected) + 1).find(sameHeaders);
    const call = packet.nativeId
      ? transcript.calls.find(call => `${call.sessionId}:${call.toolUseId}` === packet.nativeId) ??
        (pending && `${pending.sessionId}:${pending.toolUseId}` === packet.nativeId ? pending : undefined)
      : pending ?? recorded;
    if (packet.nativeId && !call) return null;
    if (call) {
      if (call.sessionId !== selected.sessionId || call.answered || call.failed ||
          !sameHeaders(call) || (pending && pending !== call) ||
          !packet.screens.every((screen, i) => capturePlanCountQuestion(
            screen, new Set(), 0, false, call)?.nativeQuestionIndex === i)) return null;
      packet.nativeId = `${call.sessionId}:${call.toolUseId}`;
    }
    if (packet.next === packet.headers.length) {
      if (!barless && planCountSubmissionInput(visible) !== '\r') return null;
      packet.submitted = true;
      return 'submission';
    }
  } else if (bar && bar.answered.some(Boolean)) return null;
  // An unbound Submit panel is never a fresh question to answer with option 1.
  if (!bar && visible.replace(/[│┃\s]/g, '').endsWith(BARLESS_SUBMIT_END)) return null;
  // With native metadata present, require the same call and exact displayed
  // tab. Without it, the complete bar, footer and ordered answered transitions
  // are required; another menu cannot spend this call's remaining tab budget.
  if (bar) {
    if (!/Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel/i.test(visible)) return null;
    if (pending && (pending.sessionId !== selected.sessionId ||
        !matchesNativePlanQuestion(visible, pending) ||
        JSON.stringify(pending.questions.map(q => q.header.trim().replace(/\s+/g, ' '))) !== JSON.stringify(bar.headers))) return null;
  }
  const action = nextCeoModeNavigation(visible, targetMode, seenQuestions, pending, completionHistory);
  if (action.kind !== 'question') return null;
  if (bar) {
    const current = packet ?? { headers: bar.headers, screens: [], next: 0, submitted: false };
    if (action.question.nativeCall) {
      const nativeId = `${action.question.nativeCall.sessionId}:${action.question.nativeCall.toolUseId}`;
      if ((current.nativeId && current.nativeId !== nativeId) || action.question.nativeQuestionIndex !== current.next) return null;
      current.nativeId = nativeId;
    }
    current.screens.push(visible);
    current.next++;
    postureContinuations.set(seenQuestions, { modeId, packet: current });
  } else postureContinuations.set(seenQuestions, { modeId });
  return 'question';
}
