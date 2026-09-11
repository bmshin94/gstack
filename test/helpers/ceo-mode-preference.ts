import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Lexer } from 'marked';
import {
  isNumberedOptionListVisible, isPlanReadyVisible,
  launchClaudePty, MODE_RE, parseNumberedOptions, type ClaudePtySession,
} from './claude-pty-runner';
import { readOwnedClaudeTranscript, type OwnedClaudeTranscript } from './owned-claude-transcript';
import { matchesNativeQuestion, readPlanSkillQuestions, currentBashPermissionCard, reserveNativePermissionGrant, type NativePermissionGrant } from './plan-skill-questions';
import { retainCeoModeEvidence } from './ceo-mode-evidence';
import { readBashEvents, readBashCompletionEvents, readBashPermissionRequestEvents } from './plan-skill-question-events';

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
      // Closing emphasis after punctuation belongs to the preceding sentence.
      // Keep offsets in the original text for the quotation/code mask below.
      for (const sentence of lines[index].split(/(?<=[.!?])(?:\*\*)?\s+/)) {
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
  const tuningFooter = 'Reply `tune: never-ask`, `tune: always-ask`, or free-form to tune this question.';
  const lastLine = lines.findLastIndex(line => line.length > 0);
  const liveFooter = dialogue(text, true).trim().split('\n').at(-1)?.trim() === tuningFooter;
  // Only the exact final tuning footer is metadata. A second choice directive,
  // or a modified or duplicated footer, still makes the directive ambiguous.
  const replies = physical.flatMap((line, index) => /^ {0,3}Reply\b/.test(line)
    && !(index === lastLine && line.trim() === tuningFooter && liveFooter) ? [index] : []);
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
  const letterPrefix = instruction.startsWith('Reply with a letter:');
  const selectorList = (clause: string) => {
    const prefix = letterPrefix ? '^Reply with a letter:\\s+' : '^Reply(?:\\s+with)?\\s+';
    return new RegExp(prefix + clause + '(?:(?:,\\s*|,?\\s+or\\s+)' + clause + '){1,3}[.!]?$');
  };
  if (letterPrefix && !selectorList('(?:[A-D]|`[A-D]`)').test(instruction)) return undefined;
  let inventory = instruction;
  if (!selectorList('(?:[A-D1-4]|`[A-D1-4]`)(?:\\s+to\\s+.+?)?').test(instruction)) {
    const headings = physical.flatMap(line => line.match(/^ {0,3}(?:#{1,6}\s+)?(D[1-9]\d*)\s+[—–-]\s+\S/) ?? [])
      .filter(value => /^D[1-9]\d*$/.test(value));
    if (headings.length !== 1) return undefined;
    // Every qualified selector must name this same current native heading.
    const qualified = headings[0] + ':[ \\t]*[A-D1-4]';
    if (!selectorList('(?:' + qualified + '|`' + qualified + '`)').test(instruction)) return undefined;
    inventory = instruction.replace(new RegExp('\\b' + headings[0] + ':[ \\t]*', 'g'), '');
  }
  const offered = [...inventory.matchAll(/\b([A-D]|[1-4])\b/g)].map(match => match[1]);
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
  // Numeric day/min effort estimates do not qualify the recommendation.
  // Keep other units, ranges, and free-form clauses ambiguous until supported.
  const value = annotation[1].trim().replace(
    /,\s*human\s+~?\d+\s+(?:days?|mins?)\s*\/\s*CC\s+~?\d+\s+(?:days?|mins?)$/i, '',
  );
  if (/^recommended(?:\s*:\s*yes)?$/i.test(value)) return 'positive';
  if (/^(?:not\s+recommended|recommended\s*:\s*no)$/i.test(value)) return 'negative';
  return 'ambiguous';
}

// A bold option heading can share its line with an explanatory paragraph.
// Only recover an unannotated alternative's plain negative description when
// another option already has an explicit positive annotation. This cannot
// manufacture a recommendation or enable the first-option fallback.
function descriptiveNonrecommendation(text: string, option: RegExpMatchArray): boolean {
  const lines = text.split('\n').filter(line => line.replace(/\*\*/g, '').trim() === option[0].trim());
  if (lines.length !== 1) return false;
  const line = lines[0].trim();
  const heading = Lexer.lexInline(line)[0];
  if (heading?.type !== 'strong' || heading.raw !== `**${heading.text}**`
    || heading.tokens?.length !== 1 || heading.tokens[0].type !== 'text'
    || heading.tokens[0].raw !== heading.text || heading.tokens[0].text !== heading.text
    || (!heading.text.startsWith(option[1] + ') ') && !heading.text.startsWith(option[1] + '. '))
    || /recommended/i.test(heading.text)) return false;
  const description = line.slice(heading.raw.length);
  if (!/^ +[A-Za-z]/.test(description)
    || /\b(?:choose|select|pick|reply|answer|instead)\b|\bnot\s+not\b/i.test(description)
    || [...description.matchAll(/recommended/gi)].length !== 1
    || !/\bnot recommended\b/i.test(description)) return false;
  // Reuse the annotation parser's quote/code/nesting/duplicate guards rather
  // than treating a quoted or parenthesized qualifier as a plain description.
  return recommendationPolarity(description.replace(/\bnot recommended\b/i, '(not recommended)')) === 'negative';
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

function liveBriefIntroduction(text: string, visible: string): string | undefined {
  if (noncurrentBriefContext(text)) return undefined;
  const nativeLines = text.split('\n');
  const lines = nativeLines.map(line => line.replace(/\*\*/g, ''));
  const headings = lines.flatMap((line, index) => /^ {0,3}(?:#{1,6}\s+)?D[1-9]\d*\s+[—–-]\s+\S/.test(line) ? [index] : []);
  if (headings.length !== 1) return undefined;
  const before = nativeLines.slice(0, headings[0]);
  if (before.every(line => !line.trim() || /^[-*_]{3,}$/.test(line.trim()))) return '';
  // Only closed, unlabeled top-level context fences may precede a real D1.
  // Keep their entire bodies in the introduction comparison. Quoted requests,
  // nested/labeled fences and code-only leads cannot establish live input.
  let fence = false; let sawFence = false; let prose = false;
  let body: string[] = [];
  for (const line of before) {
    if (/^```[ \t]*$/.test(line)) {
      // Code punctuation/case is content, unlike prose Markdown styling.
      if (fence) {
        const literal = body.join('\n').replace(/\s/g, '');
        // A second copy elsewhere cannot corroborate a changed body here.
        if (!literal || !visible.replace(/\s/g, '').includes(literal)
          || renderedProse(visible).split(renderedProse(literal)).length !== 2) return undefined;
      }
      fence = !fence; sawFence = true; body = []; continue;
    }
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) return undefined;
    if (fence) {
      if (/<gstack-qid:|\b(?:reply|answer|respond|choose|select)\b|\b(?:present|render|ask)\s+(?:(?:the|this|that|a)\s+)?(?:question|decision|brief|request)\b/i.test(line)) return undefined;
      body.push(line); continue;
    }
    if (/^(?: {4}|\t)|^\s*>/.test(line)) return undefined;
    const code = line.trim().replace(/[*_]/g, '').match(/^(`+)(.*)\1$/);
    if (code !== null && !code[2].includes(code[1])) return undefined;
    if (line.trim() && !/^\s*(?:[#*-]|\d+[.)]\s)/.test(line)) prose = true;
  }
  if (fence || sawFence && !prose) return undefined;
  return nativeLines.slice(0, headings[0] + 1).join('\n');
}

// CLI 2.1.263 renders an ordinary Markdown link as "label (URL)" without
// hyperlink support. Preserve both fields; use the parsed plain-text label so
// punctuation is preserved while titles, escaped/nested markup, code, images,
// and other link kinds stay outside this projection.
function renderPlainInlineLinks(value: string): string {
  if (!value.includes('](')) return value;
  return Lexer.lexInline(value).map(token => {
    if (token.type !== 'link' || token.title
      || token.tokens?.length !== 1 || token.tokens[0].type !== 'text'
      || token.tokens[0].raw !== token.text || token.tokens[0].text !== token.text
      // renderedProse removes Markdown markers and rewrites qid delimiters.
      // Preserve literal label identity by declining those ambiguous forms.
      || /[\u0000-\u001f\u007f*#`]|gstack-qid:/i.test(token.text)
      || !/^https?:\/\/[A-Za-z0-9._~:/?#@!$&+,;=%-]+$/.test(token.href)
      || token.raw !== `[${token.text}](${token.href})`
      || token.href === `http://${token.text}` || token.href === `https://${token.text}`) return token.raw;
    return `${token.text} (${token.href})`;
  }).join('');
}

// Compare only plain, unwrapped ASCII tables observed in the native CLI.
// The complete header/body inventory and box geometry must match once, in order;
// preserve all surrounding prose for the existing full-prefix/epoch checks.
function renderPlainPreludeTables(value: string, visible: string): string | undefined {
  if (!value.includes('|')) return undefined;
  const tokens = Lexer.lex(value);
  if (tokens.map(token => token.raw).join('') !== value) return undefined;
  const lines = visible.split('\n');
  let sawTable = false; let previousEnd = -1; let rendered = '';
  for (const token of tokens) {
    if (token.type !== 'table') { rendered += token.raw; continue; }
    const rows = [token.header, ...token.rows];
    const rawLines = token.raw.trimEnd().split('\n');
    if (token.header.length < 2 || !token.rows.length || token.align.some(align => align !== null)
      || rawLines.length !== rows.length + 1
      || rawLines.some(line => !/^\|[^\n]*\|$/.test(line))) return undefined;
    if (rows.some(row => row.length !== token.header.length || row.some(cell =>
      !/^[\x20-\x7e]+$/.test(cell.text) || /[\\|*#`<>&]/.test(cell.text)
      || cell.tokens?.length !== 1 || cell.tokens[0].type !== 'text'
      || cell.tokens[0].raw !== cell.text || cell.tokens[0].text !== cell.text))) return undefined;
    const nativeRows = rawLines.filter((_, index) => index !== 1)
      .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()));
    if (nativeRows.some((row, index) => row.length !== rows[index].length
      || row.some((cell, column) => cell !== rows[index][column].text))) return undefined;
    const matches: { start: number; end: number; text: string }[] = [];
    for (let start = 0; start < lines.length; start++) {
      const top = lines[start].trimEnd().match(/^( *)┌(─+(?:┬─+)+)┐$/);
      if (!top) continue;
      const widths = top[2].split('┬').map(part => part.length);
      if (widths.length !== token.header.length || widths.some(width => width < 3)) continue;
      const rule = (left: string, cross: string, right: string) =>
        top[1] + left + widths.map(width => '─'.repeat(width)).join(cross) + right;
      let matched = true;
      for (let index = 0; index < rows.length; index++) {
        const line = lines[start + 1 + index * 2]?.trimEnd();
        if (!line?.startsWith(top[1] + '│') || !line.endsWith('│')) { matched = false; break; }
        const cells = line.slice(top[1].length + 1, -1).split('│');
        if (cells.length !== widths.length || cells.some((cell, column) =>
          cell.length !== widths[column] || !cell.startsWith(' ') || !cell.endsWith(' ')
          || cell.trim() !== rows[index][column].text)) { matched = false; break; }
        const border = index === rows.length - 1 ? rule('└', '┴', '┘') : rule('├', '┼', '┤');
        if (lines[start + 2 + index * 2]?.trimEnd() !== border) { matched = false; break; }
      }
      if (matched) {
        const end = start + rows.length * 2;
        matches.push({ start, end, text: lines.slice(start, end + 1).join('\n') });
      }
    }
    if (matches.length !== 1 || matches[0].start <= previousEnd) return undefined;
    previousEnd = matches[0].end; sawTable = true;
    rendered += matches[0].text + token.raw.slice(token.raw.trimEnd().length);
  }
  return sawTable ? rendered : undefined;
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
export function inspectCeoModePreference(transcript: OwnedClaudeTranscript, visible: string, questionVisible = visible, inputVisible = questionVisible,
  acknowledgedMessages: ReadonlyMap<string, string> = new Map()): ModePreferenceSignal {
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
      const introduction = liveBriefIntroduction(nativeText, questionVisible);
      if (introduction === undefined) continue;
      const tableIntroduction = renderPlainPreludeTables(introduction, questionVisible);
      const prefixes = [introduction, renderPlainInlineLinks(introduction),
        ...(tableIntroduction === undefined ? [] : [tableIntroduction, renderPlainInlineLinks(tableIntroduction)])]
        .map(renderedProse);
      if (introduction && !prefixes.some(prefix => renderedProse(questionVisible).includes(prefix))) continue;
      if ([...nativeText.matchAll(/<gstack-qid:([a-z0-9-]+)>/g)].length !== 1) continue;
      const selectors = options.map(option => option[1]);
      if (selectors.length < 2 || selectors.length > 4 || new Set(selectors).size !== selectors.length
        || selectors.some(selector => !/^[A-D1-4]$/.test(selector))) continue;
      // Registry IDs identify a question category, so separate proposals may
      // reuse one. The driver supplies only messages with exact owned reply ACKs.
      // Reuse needs the distinct full current brief, never its shared directive.
      const previous = [...messages].filter(([otherId, other]) => otherId !== id
        && other.text.join('\n').includes(`<gstack-qid:${questionIds[0]}>`));
      if (previous.length) {
        const fullBriefs = [...new Set([nativeText, renderPlainInlineLinks(nativeText)].map(renderedProse))];
        if (previous.some(([otherId, other]) => acknowledgedMessages.get(otherId) !== other.text.join('\n') || !other.complete
          || [other.text.join('\n'), renderPlainInlineLinks(other.text.join('\n'))]
            .some(value => fullBriefs.includes(renderedProse(value))))) continue;
        // Cursor show/hide toggles have no text effect. Keep cursor motion,
        // erasure and every other unhandled control sequence in the comparison.
        const currentInput = renderedProse(inputVisible.replace(/\x1b\[\?25[hl]/g, ''));
        const currentFrame = renderedProse(questionVisible);
        if (!fullBriefs.some(brief => brief && currentFrame.split(brief).length === 2
          && currentInput.split(brief).length === 2)) continue;
      }
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
        if (previewText.some(value => prefixes.some(prefix => value.includes(prefix)))) continue;
        // A redraw can repeat either fragment. At least one complete prefix
        // must precede the exact reply within this same input window.
        const current = renderedProse(questionVisible);
        if (!prefixes.some(prefix => {
          const start = current.indexOf(prefix);
          return start >= 0 && (!reply || current.indexOf(signature, start + prefix.length) >= 0);
        })) continue;
      }
      if (!compact(questionVisible).includes(compact(text))
        && (!reply || !renderedProse(questionVisible).includes(signature))) continue;
      const polarities = options.map(option => recommendationPolarity(option[2]));
      if (polarities.includes('ambiguous') && polarities.filter(value => value === 'positive').length === 1) {
        // Descriptions can continue on later lines. Only the already validated
        // exact reply directive is exempt from the recovery's instruction veto.
        const optionBlock = text.replace(/\*\*/g, '').slice(options[0].index)
          .replace(reply?.replace(/\*\*/g, '') ?? '', '');
        if (/\b(?:choose|select|pick|instead)\b|\b(?:answer|reply|use|proceed)\s+(?:with\s+)?(?:option\s+)?[A-D1-4]\b/i.test(optionBlock)) continue;
        const fullBriefs = [nativeText, renderPlainInlineLinks(nativeText)].map(renderedProse);
        const frame = renderedProse(questionVisible);
        const input = renderedProse(inputVisible.replace(/\x1b\[\?25[hl]/g, ''));
        // This description-dependent recovery needs the complete current brief,
        // once in both frame and input epoch; a shared reply is insufficient.
        if (fullBriefs.some(brief => brief && frame.split(brief).length === 2 && input.split(brief).length === 2)) {
          for (let index = 0; index < options.length; index++) {
            if (polarities[index] === 'ambiguous' && descriptiveNonrecommendation(text, options[index])) polarities[index] = 'negative';
          }
        }
      }
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
  const acknowledgedMessages = new Map<string, string>();
  const grantedBash = new Set<string>();
  const grantedRequests = new Map<string, NativePermissionGrant>();
  let pendingBashId: string | null = null;
  let lastScreen: { text: string; rawEnd: number } | null = null;
  let lastScreenInputMark = 0;
  let pendingReply: {
    id: string; questionId: string; answer: string; text: string; nativeText: string;
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
      captureScreen: true, rows: 240, // Keep the complete report, diagrams and choices in view.
      captureQuestionsForSession: sessionId,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'], timeoutMs: opts.timeoutMs,
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
      const nativeBeforeFrame = session.nativeQuestionEvents
        ? readPlanSkillQuestions(session.hermeticConfigDir, sessionId, session.nativeQuestionEvents) : undefined;
      if (now() >= deadline) break;
      // Owned source → decoded frame → same source/output epoch → scoped input.
      if (!session.currentScreen) throw new Error('Mode preference screen capture unavailable');
      const frame = await session.currentScreen();
      lastScreen = frame;
      const afterFrame = readOwnedClaudeTranscript(session.hermeticConfigDir, sessionId);
      if (now() >= deadline) break;
      if (frame.rawEnd !== session.mark() || !isDeepStrictEqual(transcript, afterFrame)
        || nativeBeforeFrame !== undefined && !isDeepStrictEqual(nativeBeforeFrame,
          readPlanSkillQuestions(session.hermeticConfigDir, sessionId, session.nativeQuestionEvents))) continue;
      const currentInput = () => now() < deadline && !session!.exited()
        && frame.rawEnd > lastScreenInputMark && frame.rawEnd === session!.mark()
        && isDeepStrictEqual(transcript, readOwnedClaudeTranscript(session!.hermeticConfigDir, sessionId))
        && (nativeBeforeFrame === undefined || isDeepStrictEqual(nativeBeforeFrame,
          readPlanSkillQuestions(session!.hermeticConfigDir, sessionId, session!.nativeQuestionEvents)));
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
            acknowledgedMessages.set(pendingReply.id, pendingReply.nativeText);
            // Preserve a next question that rendered before this ack poll.
            inputSince = pendingReply.nextInputSince;
            pendingReply = null;
            break;
          }
        }
      }
      if (pendingBashId) {
        // A digit or disappearing card cannot acknowledge execution. A native
        // failed tool may resolve and be handled by the agent; retain its status.
        if (!nativeBeforeFrame?.permissionResults.some(result => result.id === pendingBashId)) continue;
        pendingBashId = null;
      }
      // The mode oracle keeps its whole-review history. Only answering an
      // unrelated question depends on the current decoded viewport.
      const signal = inspectCeoModePreference(transcript, visible, frame.text, session.visibleSince(inputSince), acknowledgedMessages);
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
      if (nativeBeforeFrame && !nativeBeforeFrame.pendingBytes && !nativeBeforeFrame.ready
        && !nativeBeforeFrame.calls.some(call => call.result === 'pending')
        && !nativeBeforeFrame.permissionRequests.some(request => request.result === 'pending')
        && nativeBeforeFrame.permissionTools.length === 1 && nativeBeforeFrame.permissionTools[0].name === 'Bash'
        && currentBashPermissionCard(frame.text)) {
        if (!currentInput()) continue;
        if (!reserveNativePermissionGrant(nativeBeforeFrame, frame.text, grantedBash, grantedRequests)) continue;
        pendingBashId = nativeBeforeFrame.permissionTools[0].id;
        lastScreenInputMark = session.mark(); inputSince = lastScreenInputMark;
        session.send('1\r');
        continue;
      }
      if (signal.kind === 'unrelated' && !answered.has(signal.id)) {
        if (!currentInput()) continue;
        pendingReply = {
          id: signal.id, questionId: signal.questionId, answer: signal.answer,
          text: `For ${signal.questionId}, I choose option ${signal.answer}. Continue the review.`,
          nativeText: [...new Set(transcript.rows.filter(row => row.type === 'assistant'
            && row.message?.role === 'assistant' && row.message.id === signal.id && Array.isArray(row.message.content))
            .flatMap(row => row.message.content).filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text))].join('\n'),
          nativeRowCount: transcript.rows.length, nativePrefixSha256: nativePrefixHash(transcript.rows),
          nextInputSince: session.mark(), textWriteAttempted: false, enterWriteAttempted: false, invalidated: null,
        };
        if (now() >= deadline) break;
        pendingReply.textWriteAttempted = true;
        lastScreenInputMark = session.mark();
        session.send(pendingReply.text);
        continue;
      }
      const native = nativeBeforeFrame ?? readPlanSkillQuestions(session.hermeticConfigDir, sessionId);
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
      if (session.nativeQuestionEvents) capture('bashHooks', () => {
        const source = session!.nativeQuestionEvents!;
        const transcript = readOwnedClaudeTranscript(session!.hermeticConfigDir, sessionId);
        const expected = { configDir: session!.hermeticConfigDir, sessionId, transcriptFile: transcript.file };
        const invocations = readBashEvents(source, expected);
        const resolutions = readBashCompletionEvents(source, expected);
        const ids = new Set([...(pendingBashId ? [pendingBashId] : []),
          ...resolutions.slice().sort((a, b) => b.capturedAtMs - a.capturedAtMs).map(event => event.id),
          ...invocations.slice().sort((a, b) => b.capturedAtMs - a.capturedAtMs).map(event => event.id)].slice(0, 16));
        const selected = invocations.filter(event => ids.has(event.id));
        return { limit: 16, invocationCount: invocations.length, resolutionCount: resolutions.length,
          invocations: selected, resolutions: resolutions.filter(event => ids.has(event.id)),
          permissionRequests: readBashPermissionRequestEvents(source, expected).filter(request => selected.some(event =>
            event.cwd === request.cwd && isDeepStrictEqual(event.input, request.input))).slice(-16),
          chronology: 'Later diagnostic reads only; no input or outcome credit. Background resolution is not command completion.' };
      });
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
          observation, lastSignal, answered: [...answered], pendingReply, pendingBashId, grantedBash: [...grantedBash], snapshot,
        }, { ...process.env, ...opts.env });
        console.log(`CEO mode evidence: ${file}`);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
      'CEO observation evidence/cleanup failed');
  }
}
