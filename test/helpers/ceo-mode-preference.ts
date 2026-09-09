import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  isNumberedOptionListVisible, isPlanReadyVisible,
  launchClaudePty, MODE_RE, parseNumberedOptions, type ClaudePtySession,
} from './claude-pty-runner';
import { readOwnedClaudeTranscript, type OwnedClaudeTranscript } from './owned-claude-transcript';
import { matchesNativeQuestion, readPlanSkillQuestions } from './plan-skill-questions';
import { retainCeoModeEvidence } from './ceo-mode-evidence';

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
  const standard = new RegExp('^Auto-decided(?:\\s*:\\s*|\\s+)(?:CEO )?(?:review )?mode(?: selection)?\\s*(?:→|:|—)\\s*' + label + '\\s*\\((?:your preference(?: for this question)?|saved preference)\\)[.!]?$', 'i');
  const observed = new RegExp('^(?:Review )?Mode is ' + label + '\\s*\\(auto-decided from plan-tune preference\\)[.!]?$', 'i');
  // Presentation wrappers own their following prose even across blank lines.
  // A wrapper introducing a closed code/quotation block owns that block only.
  // Ordinary future work or an unrelated no-input request is not a wrapper.
  const wrapper = /^(?:#{1,6}\s+)?(?:example\b|(?:template|expected (?:output|annotation)|quoted (?:text|annotation)|quotation)\s*:|(?:here is|here['’]s|this is|the following is) an? (?:example|template)\b|(?:if|when|unless)\b[^:\n]*:\s*$|(?:(?:if|when|unless)\b[^\n]*?[,;]\s*)?(?:I|we)(?:\s+will|['’]ll)\s+(?:print|show|display|render|emit|present|write)\b[^\n]*:)/i;
  const closesQuote = (line: string, quote: string) => line.trimStart().startsWith(quote)
    && /^(?:$|\s|[).,;:!?])/.test(line.trimStart().slice(quote.length));
  let fence: { marker: string; length: number } | null = null;
  let quote = ''; let standaloneQuote = ''; let ticks = 0;
  let pendingWrapper = false; let wrappedProse = false;
  const paragraphs = text.split(/\n[ \t]*\n/);
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const lines = paragraph.split('\n');
    const visible: string[] = [];
    const protectedLines: boolean[] = [];
    let quotedParagraph = false;
    for (const [lineIndex, line] of lines.entries()) {
      const marker = !quote && !standaloneQuote && !ticks ? line.trim().match(/^(`{3,}|~{3,})/)?.[1] : undefined;
      if (marker) {
        if (!fence) fence = { marker: marker[0], length: marker.length };
        else if (marker[0] === fence.marker && marker.length >= fence.length && line.trim().slice(marker.length).trim() === '') fence = null;
        visible.push(''); protectedLines.push(true); continue;
      }
      if (fence || quotedParagraph || /^(?: {4}|\t)|^\s*>/.test(line)) {
        quotedParagraph ||= /^\s*>/.test(line);
        visible.push(''); protectedLines.push(!!line.trim()); continue;
      }
      // An explicit quote on its own line encloses complete physical blocks;
      // apostrophes in quoted prose cannot close that delimiter early.
      if (standaloneQuote || !quote && !ticks && /^["'“‘]$/.test(line.trim())) {
        if (standaloneQuote && closesQuote(line, standaloneQuote)) standaloneQuote = '';
        else if (!standaloneQuote) standaloneQuote = line.trim() === '“' ? '”' : line.trim() === '‘' ? '’' : line.trim();
        visible.push(''); protectedLines.push(!!line.trim()); continue;
      }
      let prose = '';
      let protectedContent = false;
      for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (ticks) {
          if (char === '`') {
            const width = line.slice(index).match(/^`+/)![0].length;
            if (width === ticks) ticks = 0;
            prose += ' '.repeat(width); index += width - 1;
          } else prose += ' ';
          protectedContent = true; continue;
        }
        if (quote) {
          if (char === '\\' && line[index + 1] === quote) {
            prose += '  '; index++; protectedContent = true; continue;
          }
          const apostrophe = (char === "'" || char === '’') && /\w/.test(line[index - 1] ?? '') && /\w/.test(line[index + 1] ?? '');
          // An apparent apostrophe close cannot end a plausible multiline
          // quotation ahead of its later standalone closing delimiter.
          const outerClose = (char === "'" || char === '’') && /\w/.test(line[index - 1] ?? '')
            && [...lines.slice(lineIndex + 1), ...paragraphs.slice(paragraphIndex + 1).flatMap(value => value.split('\n'))]
              .some(value => closesQuote(value, quote));
          if (char === quote && !apostrophe && !outerClose) quote = '';
          prose += ' '; protectedContent = true; continue;
        }
        if (char === '`') {
          ticks = line.slice(index).match(/^`+/)![0].length;
          prose += ' '.repeat(ticks); index += ticks - 1; protectedContent = true; continue;
        }
        if (char === '"' || char === '“' || char === '‘' || char === "'" && !/\w/.test(line[index - 1] ?? '')) {
          quote = char === '“' ? '”' : char === '‘' ? '’' : char;
          prose += ' '; protectedContent = true; continue;
        }
        prose += char;
      }
      visible.push(prose);
      protectedLines.push(protectedContent);
    }
    if (!visible.some(line => line.trim())) {
      if (protectedLines.some(Boolean) && !quote && !standaloneQuote && !ticks && !fence) pendingWrapper = false;
      continue;
    }
    let protectedAfterWrapper = false;
    for (const [index, line] of visible.entries()) {
      const normalized = line.replace(/\*\*/g, '').trim();
      if (!normalized) { if (pendingWrapper) protectedAfterWrapper ||= protectedLines[index]; continue; }
      if (wrapper.test(normalized)) { pendingWrapper = true; protectedAfterWrapper = false; continue; }
      if (pendingWrapper) { wrappedProse = true; pendingWrapper = false; }
      if (wrappedProse) continue;
      // Masking quotes must not manufacture a standalone affirmative sentence.
      // Match original physical sentences, then require every character to
      // survive the quotation/code mask at the same position.
      let cursor = 0;
      for (const sentence of lines[index].split(/(?<=[.!?])\s+/)) {
        const start = lines[index].indexOf(sentence, cursor); cursor = start + sentence.length;
        if (line.slice(start, cursor) !== sentence) continue;
        // Single quotes can also contain possessive apostrophes. A plausible
        // outer span in this paragraph remains quoted under either reading.
        const offset = lines.slice(0, index).reduce((sum, value) => sum + value.length + 1, 0) + start;
        const before = paragraph.slice(0, offset); const after = paragraph.slice(offset + sentence.length);
        if (/(?:^|[^\p{L}\p{N}_])'/u.test(before) && /'(?=$|[^\p{L}\p{N}_])/u.test(after)
          || before.includes('‘') && after.includes('’')) continue;
        const value = sentence.replace(/\*\*/g, '').trim();
        if (standard.test(value) || observed.test(value)) return value;
      }
    }
    if (pendingWrapper && protectedAfterWrapper && !quote && !standaloneQuote && !ticks && !fence) pendingWrapper = false;
  }
  return undefined;
}


/** Bind a completed prose brief to its exact rendered reply instruction. The
 * native transcript owns the heading, ID and complete 2–4-choice inventory;
 * the current input window must corroborate the directive and every selector.
 * Markdown may hide qid angle brackets, but letters and wording must survive.
 */
function proseReply(text: string, questionId: string, selectors: string[]): string | undefined {
  if (selectors.length < 2 || selectors.length > 4 || new Set(selectors).size !== selectors.length) return undefined;
  const physical = text.replace(/\*\*/g, '').split('\n');
  const lines = physical.map(line => line.trim());
  const replies = physical.flatMap((line, index) => /^ {0,3}Reply\b/.test(line) ? [index] : []);
  if (replies.length !== 1) return undefined;
  const index = replies[0];
  const reply = lines[index];
  let signature = reply;
  if (!reply.includes(`<gstack-qid:${questionId}>`)) {
    let previous = index - 1;
    while (previous >= 0 && !lines[previous]) previous--;
    const marker = `<gstack-qid:${questionId}>`;
    if (previous < 0 || /^(?: {4}|\t)/.test(physical[previous])) return undefined;
    if (lines[previous] !== marker && lines[previous] !== '`' + marker + '`') return undefined;
    // Inspect physical native lines: filtering a quote/fence/prose interruption
    // must never manufacture adjacency between the identity and directive.
    signature = lines.slice(previous, index + 1).join('\n');
  }
  const instruction = reply.replace(/`?<gstack-qid:[a-z0-9-]+>`?/, '').trim();
  // Parse a selector list, optionally with "to ..." descriptions. This is a
  // structural choice grammar; no question-specific phrasing or fuzzy matching.
  const clause = '[A-D1-4](?:\\s+to\\s+.+?)?';
  if (!new RegExp('^Reply(?:\\s+with)?\\s+' + clause + '(?:(?:,\\s*|,?\\s+or\\s+)' + clause + '){1,3}[.!]?$').test(instruction)) return undefined;
  const offered = [...instruction.matchAll(/\b([A-D]|[1-4])\b/g)].map(match => match[1]);
  if (offered.length !== selectors.length || new Set(offered).size !== offered.length
    || offered.some(selector => !selectors.includes(selector))) return undefined;
  return signature;
}

/** Only explicit, unquoted option annotations establish recommendation
 * polarity. Unknown or conflicting markers never fall back to a choice.
 */
function recommendationPolarity(label: string): 'absent' | 'positive' | 'negative' | 'ambiguous' {
  const markers = [...label.matchAll(/recommended/gi)];
  if (!markers.length) return 'absent';
  const annotations = [...label.matchAll(/\(([^()]*)\)/g)].filter(match => /recommended/i.test(match[1]));
  if (markers.length !== 1 || annotations.length !== 1) return 'ambiguous';
  const annotation = annotations[0];
  const before = label.slice(0, annotation.index);
  const after = label.slice(annotation.index! + annotation[0].length);
  // An internal apostrophe can resemble a closing quote. A plausible outer
  // span around the annotation stays ambiguous regardless of that reading.
  if (/(?:^|[^\p{L}\p{N}_])'/u.test(before) && /'(?=$|[^\p{L}\p{N}_])/u.test(after)
    || before.includes('‘') && after.includes('’')) return 'ambiguous';
  let quote = ''; let ticks = 0; let depth = 0;
  for (let index = 0; index < label.length; index++) {
    const char = label[index];
    if (index === annotation.index && (quote || ticks || depth)) return 'ambiguous';
    if (ticks) {
      // Backslashes are literal inside Markdown code spans; consume whole
      // backtick runs before interpreting escapes outside them.
      if (char === '`') {
        const width = label.slice(index).match(/^`+/)![0].length;
        if (ticks === width) ticks = 0;
        index += width - 1;
      }
      continue;
    }
    if (char === '\\') {
      if (index + 1 === annotation.index || /["'“”‘’`]/.test(label[index + 1] ?? '')) return 'ambiguous';
      index++; continue;
    }
    if (quote) {
      const apostrophe = (char === "'" || char === '’')
        && /[\p{L}\p{N}_]/u.test(label[index - 1] ?? '') && /[\p{L}\p{N}_]/u.test(label[index + 1] ?? '');
      if (char === quote && !apostrophe) quote = '';
      continue;
    }
    if (char === '`') {
      ticks = label.slice(index).match(/^`+/)![0].length;
      index += ticks - 1; continue;
    }
    if (char === '"' || char === '“' || char === '‘'
      || char === "'" && !/[\p{L}\p{N}_]/u.test(label[index - 1] ?? '')) {
      quote = char === '“' ? '”' : char === '‘' ? '’' : char; continue;
    }
    if (char === '(') depth++;
    if (char === ')' && --depth < 0) return 'ambiguous';
  }
  if (quote || ticks || depth) return 'ambiguous';
  const value = annotation[1].trim();
  if (/^recommended(?:\s*:\s*yes)?$/i.test(value)) return 'positive';
  if (/^(?:not\s+recommended|recommended\s*:\s*no)$/i.test(value)) return 'negative';
  return 'ambiguous';
}

/** Veto statements that make this request noncurrent, wherever they occur in
 * the owned turn. Ordinary option actions and inline examples are not such
 * statements. This applies only to unrelated input, never to the mode oracle.
 */
function noncurrentBriefContext(text: string): boolean {
  // Keep option contents: a request-level contradiction can follow its label.
  // Normalize emphasis/punctuation only for this veto, never for ownership.
  const context = text.replace(/[*_`]/g, '').replace(/[‘’]/g, "'")
    .replace(/^\s*(?:[-+]\s+)?(?:[A-Z]|\d+)[).]\s+/gm, '');
  // Labels and line wrapping do not hide a statement; incidental words inside
  // an explanation are not statements about whether to answer this request.
  const statement = (pattern: string) => new RegExp('(?:(?:^|[.!?;:\\n])\\s*(?:(?:[-+]|>+|#{1,6})\\s+)?|,\\s*(?:but\\s+)?)' + pattern, 'i').test(context);
  const noun = '(?:question|decision|brief|request)';
  const current = '(?:(?:this|the|that)\\s+' + noun + '|this|that|it)\\b';
  const presentation = '(?:present|render|ask)\\s+(?:(?:(?:this|the|that|an?)\\s+)?' + noun + '|this|that|it)\\b';
  const planned = "(?:I|we)(?:'ll|\\s+will)\\s+";
  return statement("(?:please\\s+)?(?:do\\s+not|don't|must\\s+not|should\\s+not)\\s+(?:answer|reply|respond|choose|select)(?:\\s+(?:(?:to\\s+)?" + current + '|yet\\b|now\\b|until\\b|before\\b)|(?=\\s*(?:[.!?;:\\n]|$)))')
    || statement('no\\s+(?:participation|input|answer|response|reply)\\s+(?:is\\s+)?(?:expected|requested|required|needed)\\b')
    || statement(current + '\\s+(?:is|remains|has been|will be)\\s+(?:deferred|postponed|hypothetical|(?:(?:only|just)\\s+)?(?:an?\\s+)?(?:example|template|rehearsal))\\b')
    || statement("(?:I|we)\\s+(?:will\\s+not|won't|cannot|can't)\\s+" + presentation)
    || statement(planned + presentation + '[^.!?;\\n]*\\b(?:later|tomorrow|next time)\\b')
    || statement('(?:if|unless)\\b[^.!?;]*\\b' + planned + presentation)
    || statement(planned + '(?:present|render|ask)\\s+(?:(?:this|the|that|an?)\\s+)?(?:example|template)\\s+' + noun + '\\b')
    || statement("(?:here is|here's|this is|the following is)\\s+an?\\s+(?:example|template)\\b")
    || statement('(?:if|when|unless)\\s+(?:this|that|it)\\s+(?:becomes?|is|were|was)\\s+(?:relevant|necessary|needed)\\b')
    || statement('(?:(?:only|just)\\s+(?:an?\\s+)?(?:example|template|rehearsal)|(?:ready\\s+)?rehearsal (?:material|report))\\s*[:—-]?(?=[.!?;\\n]|$)');
}

function liveBriefIntroduction(text: string): string | undefined {
  if (noncurrentBriefContext(text)) return undefined;
  const nativeLines = text.split('\n');
  const lines = nativeLines.map(line => line.replace(/\*\*/g, ''));
  const headings = lines.flatMap((line, index) => /^ {0,3}(?:#{1,6}\s+)?D[1-9]\d*\s+[—–-]\s+\S/.test(line) ? [index] : []);
  if (headings.length !== 1) return undefined;
  const before = nativeLines.slice(0, headings[0]);
  if (before.every(line => !line.trim() || /^[-*_]{3,}$/.test(line.trim()))) return '';
  // A lead is provenance to corroborate, not an authorization vocabulary.
  // Keep its physical quotation/code context instead of manufacturing a live
  // introduction by filtering those lines. Bold and multiple plain paragraphs
  // are harmless; the explicit owned Reply below establishes the request.
  if (before.some(line => {
    if (/^(?: {4}|\t)|^\s*(?:>|`{3,}|~{3,})/.test(line)) return true;
    const code = line.trim().replace(/[*_]/g, '').match(/^(`+)(.*)\1$/);
    return code !== null && !code[2].includes(code[1]);
  })) return undefined;
  return nativeLines.slice(0, headings[0] + 1).join('\n');
}

// Tokenize before dropping whitespace: a bare qid ends at CR/space, while a
// suffix such as "-stale" remains part of that distinct identifier.
const renderedProse = (value: string) => compact(value.replace(/`/g, '')
  .replace(/<?(gstack-qid:[a-z0-9-]+)>?/g, '<$1>'));

export type ModePreferenceSignal =
  | { kind: 'asked'; evidence: string }
  | { kind: 'auto_decided'; evidence: string }
  | { kind: 'unrelated'; id: string; questionId: string; answer: string; evidence: string }
  | { kind: 'working' };

/** Inspect main-assistant text, never Write previews or preference-tool output.
 * A preference for the mode question says nothing about an approach question.
 * A decoded question viewport still needs its reply in the current raw input
 * window; newly arriving bytes do not make retained viewport text current.
 */
export function inspectCeoModePreference(transcript: OwnedClaudeTranscript, visible: string, questionVisible = visible, inputVisible = questionVisible): ModePreferenceSignal {
  if (transcript.pendingBytes) return { kind: 'working' };
  const messages = new Map<string, { text: string[]; complete: boolean }>();
  let latestAssistantId: string | null = null;
  let userReplied = false;
  let toolText: string[] = [];
  const collectToolText = (value: unknown): void => {
    if (typeof value === 'string') toolText.push(value);
    else if (Array.isArray(value)) value.forEach(collectToolText);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectToolText);
  };
  for (const row of transcript.rows) {
    const message = row.message;
    if (row.type === 'user' && message?.role === 'user' && (typeof message.content === 'string'
      || Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'text'))) {
      userReplied = true; toolText = [];
    }
    if (row.type === 'user' && message?.role === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === 'tool_result') collectToolText(block.content);
    }
    if (row.type !== 'assistant' || message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    latestAssistantId = typeof message.id === 'string' ? message.id : null;
    userReplied = false;
    if (latestAssistantId) {
      const entry = messages.get(latestAssistantId) ?? { text: [], complete: false };
      entry.complete = message.stop_reason === 'end_turn';
      messages.set(latestAssistantId, entry);
    }
    for (const block of message.content) {
      if (block?.type === 'tool_use') collectToolText(block.input);
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
    const nativeText = entry.text.join('\n');
    const text = dialogue(nativeText);
    const annotation = automaticModeEvidence(nativeText);
    if (annotation && compact(visible).includes(compact(annotation))) {
      automatic = { kind: 'auto_decided', evidence: annotation };
    }
    if (!entry.complete) continue; // Never type an answer while the model uses tools.
    const questionIds = [...text.matchAll(/<gstack-qid:([a-z0-9-]+)>/g)].map(match => match[1]);
    const options = [...text.replace(/\*\*/g, '').matchAll(/^\s*(?:[-+]\s+)?([A-Z]|\d+)[).]\s+([^\n]+)/gm)];
    const isModeQuestion = questionIds.includes(CEO_MODE_QUESTION_ID) || modeLabels(options.map(option => option[2]).join('\n')) >= 2;
    // Contrary mode evidence keeps the whole-review observation window.
    if (options.length >= 2 && isModeQuestion && compact(visible).includes(compact(text))) {
      return { kind: 'asked', evidence: text };
    }
    if (questionIds.length === 1 && !isModeQuestion && id === latestAssistantId && !userReplied) {
      // The envelope applies to full-text corroboration too: a fully rendered
      // deferred/example brief is still not a request for current input.
      const introduction = liveBriefIntroduction(nativeText);
      if (introduction === undefined || introduction && !renderedProse(questionVisible).includes(renderedProse(introduction))) continue;
      if ([...nativeText.matchAll(/<gstack-qid:([a-z0-9-]+)>/g)].length !== 1) continue;
      const selectors = options.map(option => option[1]);
      if (selectors.length < 2 || selectors.length > 4 || new Set(selectors).size !== selectors.length
        || selectors.some(selector => !/^[A-D1-4]$/.test(selector))) continue;
      // Reused IDs across native messages cannot identify which prompt an old
      // rendering belongs to. Fail closed, even if the selectors are identical.
      if ([...messages].some(([otherId, other]) => otherId !== id
        && other.text.join('\n').includes(`<gstack-qid:${questionIds[0]}>`))) continue;
      const reply = proseReply(nativeText, questionIds[0], selectors);
      if (introduction && !reply) continue;
      const signature = renderedProse(reply ?? text);
      // A current viewport can retain an old preview after new output. Its
      // directive must also have rendered within this exact input epoch.
      if (!renderedProse(inputVisible).includes(signature)) continue;
      const previewText = [...toolText, toolText.join('\n')].map(renderedProse);
      // A same-input tool preview/result can display the identical directive.
      // Its rendering cannot establish that this later native question is on
      // screen. Exact repeats are ambiguous; mere qid/plan references are not.
      if (previewText.some(value => value.includes(signature))) continue;
      if (introduction) {
        const prefix = renderedProse(introduction);
        if (previewText.some(value => value.includes(prefix))) continue;
        // A redraw can repeat either fragment. At least one complete prefix
        // must precede the exact reply within this same input window.
        const current = renderedProse(questionVisible);
        const start = current.indexOf(prefix);
        if (start < 0 || reply && current.indexOf(signature, start + prefix.length) < 0) continue;
      }
      if (!compact(questionVisible).includes(compact(text))
        && (!reply || !renderedProse(questionVisible).includes(signature))) continue;
      const polarities = options.map(option => recommendationPolarity(option[2]));
      if (polarities.includes('ambiguous')) continue;
      const recommended = options.filter((_, index) => polarities[index] === 'positive');
      if (recommended.length > 1 || !recommended.length && polarities.some(value => value !== 'absent')) continue;
      unrelated = { kind: 'unrelated', id, questionId: questionIds[0], answer: (recommended[0] ?? options[0])[1], evidence: text };
    }
  }
  return automatic ?? unrelated ?? { kind: 'working' };
}

/** Launch → owned question/annotation → scoped answer → observe target only.
 * Before cleanup: snapshot owned evidence → close → retain the final outcome.
 * One entry deadline covers boot and polling; previews cannot produce input.
 */
export async function runCeoModePreferenceObservation(opts: {
  cwd: string; env: Record<string, string>; timeoutMs: number; evidenceRoot?: string;
}, deps: { launch?: typeof launchClaudePty; pause?: (ms: number) => Promise<unknown>; now?: () => number } = {}): Promise<{
  outcome: 'auto_decided' | 'asked' | 'timeout' | 'exited' | 'plan_ready'; evidence: string; answered: string[];
}> {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? Bun.sleep;
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw new Error('Mode preference timeout must be finite and nonnegative');
  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  const sessionId = randomUUID();
  const answered = new Set<string>();
  let lastScreen: { text: string; rawEnd: number } | null = null;
  let lastScreenInputMark = 0;
  let pendingReply: {
    id: string; questionId: string; answer: string; text: string;
    nativeRowCount: number; nativePrefixSha256: string; nextInputSince: number;
    textWriteAttempted: boolean; enterWriteAttempted: boolean; invalidated: string | null;
  } | null = null;
  const nativePrefixHash = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  let session: ClaudePtySession | undefined;
  let failure: unknown;
  let observation: { outcome: string; evidence: string; answered: string[] } | undefined;
  let lastSignal: ModePreferenceSignal = { kind: 'working' };
  const sleep = async (ms: number) => { if (now() < deadline) await pause(Math.min(ms, deadline - now())); };
  let since = 0;
  let inputSince = 0;
  const result = (outcome: 'auto_decided' | 'asked' | 'timeout' | 'exited' | 'plan_ready', evidence: string) => {
    const value = { outcome: now() >= deadline ? 'timeout' as const : outcome,
      evidence: evidence.slice(-3000), answered: [...answered] };
    observation = value;
    return value;
  };
  try {
    if (now() >= deadline) return result('timeout', 'Budget expired before launch');
    session = await (deps.launch ?? launchClaudePty)({
      permissionMode: 'plan', seedSkills: true, cwd: opts.cwd, env: opts.env,
      captureScreen: true, rows: 120, // Keep a full prose introduction and choices in view.
      extraArgs: ['--session-id', sessionId, '--disallowedTools', 'AskUserQuestion'], timeoutMs: opts.timeoutMs,
    });
    since = session.mark(); inputSince = since;
    await sleep(8000);
    if (now() >= deadline) return result('timeout', 'Budget expired during boot');
    since = session.mark(); inputSince = since;
    lastScreenInputMark = since;
    session.send('/plan-ceo-review\r');
    while (now() < deadline) {
      await sleep(2000);
      if (now() >= deadline) break;
      const visible = session.visibleSince(since);
      if (session.exited()) return result('exited', visible);
      const transcript = readOwnedClaudeTranscript(session.hermeticConfigDir, sessionId);
      if (now() >= deadline) break;
      // Owned source → decoded frame → same source/output epoch → scoped input.
      if (!session.currentScreen) throw new Error('Mode preference screen capture unavailable');
      const frame = await session.currentScreen();
      lastScreen = frame;
      const afterFrame = readOwnedClaudeTranscript(session.hermeticConfigDir, sessionId);
      if (now() >= deadline) break;
      if (frame.rawEnd !== session.mark() || !isDeepStrictEqual(transcript, afterFrame)) continue;
      const currentInput = () => now() < deadline && !session!.exited()
        && frame.rawEnd > lastScreenInputMark && frame.rawEnd === session!.mark()
        && isDeepStrictEqual(transcript, readOwnedClaudeTranscript(session!.hermeticConfigDir, sessionId));
      if (pendingReply && !pendingReply.invalidated && !transcript.pendingBytes) {
        // A write is only an attempt. Bind the acknowledgement to this exact
        // owned prefix; reset/truncation or an intervening owner cannot ack it.
        if (transcript.rows.length < pendingReply.nativeRowCount
          || nativePrefixHash(transcript.rows.slice(0, pendingReply.nativeRowCount)) !== pendingReply.nativePrefixSha256) {
          pendingReply.invalidated = 'Owned transcript prefix changed before reply acknowledgement';
        } else {
          for (const row of transcript.rows.slice(pendingReply.nativeRowCount)) {
            const message = row.message;
            if (row.type === 'assistant' && message?.role === 'assistant') {
              const originalText = new Set(transcript.rows.slice(0, pendingReply.nativeRowCount)
                .filter(original => original.type === 'assistant' && original.message?.role === 'assistant'
                  && original.message.id === pendingReply!.id)
                .flatMap(original => original.message.content ?? [])
                .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
                .map((block: any) => block.text));
              // Native rows can supplement the same completed message. Exact
              // repeats and nonvisible thinking do not introduce another turn.
              if (message.id === pendingReply.id && message.stop_reason === 'end_turn'
                && Array.isArray(message.content) && message.content.every((block: any) =>
                  block?.type === 'thinking' || block?.type === 'redacted_thinking'
                  || block?.type === 'text' && originalText.has(block.text))) continue;
              pendingReply.invalidated = 'Owned assistant advanced before reply acknowledgement';
              break;
            }
            if (row.type !== 'user' || message?.role !== 'user') continue;
            const content = message.content;
            if (Array.isArray(content) && content.length > 0
              && content.every((block: any) => block?.type === 'tool_result')) continue;
            // Tool results are not submitted input. Every other owned user
            // message must match exactly, including nontext or mixed content.
            const text = typeof content === 'string' ? content
              : Array.isArray(content) && content.length > 0
                && content.every((block: any) => block?.type === 'text' && typeof block.text === 'string')
                ? content.map((block: any) => block.text).join('\n') : undefined;
            if (text !== pendingReply.text) {
              pendingReply.invalidated = 'Different owned user input preceded reply acknowledgement';
              break;
            }
            answered.add(pendingReply.id);
            // Preserve a next question that rendered before this ack poll.
            inputSince = pendingReply.nextInputSince;
            pendingReply = null;
            break;
          }
        }
      }
      // The mode oracle keeps its whole-review history. Only answering an
      // unrelated question depends on the current decoded viewport.
      const signal = inspectCeoModePreference(transcript, visible, frame.text, session.visibleSince(inputSince));
      lastSignal = signal;
      if (now() >= deadline) break;
      if (signal.kind === 'asked' || signal.kind === 'auto_decided' && !pendingReply) return result(signal.kind, signal.evidence);
      if (pendingReply) {
        // The next existing poll separates typing from Enter. Never submit to
        // another owner, replay the text, or count a missing ack as a success.
        if (!pendingReply.invalidated && !transcript.pendingBytes && pendingReply.textWriteAttempted
          && !pendingReply.enterWriteAttempted && signal.kind === 'unrelated'
          && signal.id === pendingReply.id && signal.questionId === pendingReply.questionId
          && signal.answer === pendingReply.answer) {
          if (!currentInput()) continue;
          pendingReply.enterWriteAttempted = true;
          lastScreenInputMark = session.mark();
          session.sendKey('Enter');
        }
        continue;
      }
      if (signal.kind === 'unrelated' && !answered.has(signal.id)) {
        if (!currentInput()) continue;
        pendingReply = {
          id: signal.id, questionId: signal.questionId, answer: signal.answer,
          text: `For ${signal.questionId}, I choose option ${signal.answer}. Continue the review.`,
          nativeRowCount: transcript.rows.length, nativePrefixSha256: nativePrefixHash(transcript.rows),
          nextInputSince: session.mark(), textWriteAttempted: false, enterWriteAttempted: false, invalidated: null,
        };
        if (now() >= deadline) break;
        pendingReply.textWriteAttempted = true;
        lastScreenInputMark = session.mark();
        session.send(pendingReply.text);
        continue;
      }
      const native = readPlanSkillQuestions(session.hermeticConfigDir, sessionId);
      if (now() >= deadline) break;
      if (native.pendingBytes) continue;
      const pending = native.calls.filter(call => call.result === 'pending');
      if (pending.length > 1) throw new Error('Ambiguous concurrent question in mode-preference fixture');
      const call = pending[0];
      const questionVisible = frame.text;
      if (call && !answered.has(call.id) && isNumberedOptionListVisible(questionVisible)) {
        if (call.questions.length !== 1 || call.questions[0].multiSelect) throw new Error('Unsupported unrelated question shape in mode-preference fixture');
        const question = call.questions[0];
        if (matchesNativeQuestion(question, questionVisible, parseNumberedOptions(questionVisible), native.calls.flatMap(call => call.questions))) {
          if (!currentInput()) continue;
          answered.add(call.id); inputSince = session.mark();
          if (now() >= deadline) break;
          lastScreenInputMark = session.mark();
          session.send('1\r');
        }
      }
      if (native.ready && isPlanReadyVisible(questionVisible)) return result('plan_ready', visible);
    }
    return result('timeout', session.visibleSince(since));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    const snapshot: Record<string, unknown> = {};
    if (opts.evidenceRoot && session) {
      // One broken source must not erase the other evidence before close().
      const capture = (field: string, read: () => unknown) => {
        try { snapshot[field] = read(); }
        catch (error) {
          errors.push(new Error(`CEO evidence capture failed: ${field}`, { cause: error }));
          snapshot[field] = { captureError: error instanceof Error ? error.message : String(error) };
        }
      };
      capture('rawTerminal', () => session!.rawOutput());
      capture('visibleTerminal', () => session!.visibleText());
      capture('observationVisible', () => session!.visibleSince(since));
      capture('inputVisible', () => session!.visibleSince(inputSince));
      snapshot.currentScreen = lastScreen;
      capture('transcript', () => readOwnedClaudeTranscript(session!.hermeticConfigDir, sessionId));
      capture('process', () => ({ pid: session!.pid(), exited: session!.exited(), exitCode: session!.exitCode() }));
    }
    try { await session?.close(); } catch (error) { errors.push(error); }
    if (opts.evidenceRoot) {
      try {
        const describe = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const file = retainCeoModeEvidence(opts.evidenceRoot, sessionId, {
          startedAt, finishedAt: now(), timeoutMs: opts.timeoutMs,
          outcome: failure || errors.length ? 'harness_error' : observation?.outcome,
          failure: failure ? describe(failure) : null, finalizationErrors: errors.map(describe),
          observation, lastSignal, answered: [...answered], pendingReply, snapshot,
        }, { ...process.env, ...opts.env });
        console.log(`CEO mode evidence: ${file}`);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
      'CEO observation evidence/cleanup failed');
  }
}
