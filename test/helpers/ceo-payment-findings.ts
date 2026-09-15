import { marked } from 'marked';
import { engSetupAUQ, type AskUserQuestionFingerprint } from './claude-pty-runner';
import type { NativePlanQuestionCall } from './plan-count-transcript';

type Seed = 'dispatcher' | 'lookup' | 'email' | 'tests' | 'orders';
type Finding = { seed: Seed; ledgerId: string; phase: string; signature: string };
const plain = (value: string) => value.replace(/[`*_]/g, '').trim();
const option = (value: string) => plain(value).replace(/^[A-D][).]\s*/, '').replace(/\s*\(recommended\)$/i, '');

// Finite obligations from this fixture's supplied plan. These match the
// behavior under discussion, not decision numbers, option labels, class names
// chosen for a remedy, or a particular generated sentence.
const obligations: Array<{ seed: Seed; subject: RegExp; defect: RegExp; remedy: RegExp }> = [
  { seed: 'dispatcher', subject: /\b(?:dispatcher|WebhookDispatcher|routing)\b/i,
    defect: /\b(?:bypass\w*|skip\w*|separate (?:entry|routing)|second (?:path|front door|routing))\b/i,
    remedy: /\b(?:register\w*|reus\w*|route\w*|single routing|one routing)\b/i },
  { seed: 'lookup', subject: /\b(?:SQL|query|lookup|userId|DB|database|parameter)\b/i,
    defect: /\b(?:raw|concatenat\w*|interpolat\w*|glue\w*|splice\w*)\b/i,
    remedy: /\b(?:bound parameter|bind\w*|parameteriz\w*|prepared statement|ORM|find_by)\b/i },
  { seed: 'email', subject: /\b(?:mail|email|notification|receipt)\b/i,
    defect: /\b(?:no error handling|propagat\w*|escape\w*|unhandled|uncaught|rethrow\w*)\b/i,
    remedy: /\b(?:rescue|catch|handle|isolate|isolation|enqueue|queue|background job)\b/i },
  { seed: 'tests', subject: /\b(?:tests?|coverage|suite)\b/i,
    defect: /\b(?:no (?:automated )?tests?|none planned|never (?:runs|executes)|no (?:automated )?coverage)\b/i,
    remedy: /\b(?:add|write|implement|handler|unit|integration|regression)\b/i },
  { seed: 'orders', subject: /\b(?:orders?|query|queries)\b/i,
    defect: /\b(?:per-order|one query per order|N\+1|(?:fetch\w*|quer\w*)[^.]*loop)\b/i,
    remedy: /\b(?:batch\w*|single (?:orders )?query|one (?:bound-parameter )?query|bulk)\b/i },

];

// Use only current prose. Quoted/code blocks never supply a defect, remedy,
// or ledger. Inline code identifiers retain their literal technical names.
function prose(value: string): string {
  return marked.lexer(value).filter(t => !['code', 'blockquote', 'html'].includes(t.type))
    .map(t => plain(t.raw)).join('\n');
}
function current(value: string): boolean {
  return !/^[\x60\"'“‘]/.test(value.trim()) && !/\bno (?:current )?(?:defect|gap|issue|problem)\b/i.test(value) && !/^(?:example|quoted|historical|source|hypothetical|previously|formerly|if|unless)\b/i.test(value.trim()) &&
    !/\b(?:this|that|the) (?:finding|issue|decision|defect|assessment|remedy) (?:is|was|has been) (?:already |now )?(?:resolved|fixed|withdrawn|retracted|not current|superseded|historical|quoted)\b/i.test(value);
}
const mentions = (text: string, id: string) => text.split(/[^A-Za-z0-9_.-]+/).some(token => token.replace(/[.:]$/, '') === id);

function ownedAnswer(fp: AskUserQuestionFingerprint): NativePlanQuestionCall | null {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
    fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
    (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
    !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
    !Number.isFinite(Date.parse(call.answeredAt ?? '')) || Object.keys(call.answers ?? {}).length !== 1) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
    new Set(q.options.map(o => o.label)).size !== q.options.length ||
    !q.options.some(o => o.label === call.answers?.[q.question]) ||
    fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return null;
  return call;
}

/** Source requires Current/Proposed/Status/evidence and a cited row ID. It
 * does not require heading depth, column order, a Dn(ledger ID) title, or
 * native option wording. Pending is valid: the actual ACK precedes the next Edit. */
export function ceoPaymentFinding(fp: AskUserQuestionFingerprint, seedPlan: string, savedPlan: string): Finding | null {
  const call = ownedAnswer(fp);
  if (!call) return null;
  const q = call.questions[0]!;
  const question = prose(q.question);
  const explanation = /^ELI10:\s*(.+)$/m.exec(question)?.[1] ?? question;
  if (!question.trim() || !current(question) || !current(explanation)) return null;
  const options = q.options.map(o => prose(`${o.label}\n${o.description ?? ''}`)).filter(current);
  const tokens = marked.lexer(savedPlan);
  const namedSourcePlan = tokens.some(t => t.type === 'paragraph' &&
    /(?:^|\n)Source plan:\s*PLAN\.md\b/.test(plain(t.raw)));
  const matches: Finding[] = [];
  for (const table of tokens.filter(t => t.type === 'table')) {
    if (table.type !== 'table') continue;
    const column = (meaning: RegExp) => table.header.map((c, i) => meaning.test(plain(c.text)) ? i : -1).filter(i => i >= 0);
    const fields = { id: column(/^(?:ID|Decision)\b/i), current: column(/^Current\b/i),
      proposed: column(/^Proposed\b/i), status: column(/^Status\b/i), evidence: column(/\b(?:Contract|Evidence)\b/i) };
    if (Object.values(fields).some(indices => indices.length !== 1)) continue;
    for (const cells of table.rows) {
      const read = (key: keyof typeof fields) => plain(cells[fields[key][0]!]!.text);
      const owner = read('id'), id = owner.split(/\s/, 1)[0]!.replace(/[.:]$/, '');
      const sourceBound = /\bPLAN\.md\b/.test(read('evidence')) ||
        (namedSourcePlan && /\bEvidence:\s*plan text\b/i.test(read('evidence')));
      if (!id || !mentions(question, id) || !/^(?:unresolved|approved|reopened|deferred|declined)\b/i.test(read('status')) || !sourceBound) continue;
      // A row can contain its proposals directly or cite a separate saved
      // comparison bearing the same ID. Heading spelling/depth is immaterial.
      const blocks = tokens.map((t, i) => t.type === 'heading' && mentions(plain(t.text), id) ? i : -1).filter(i => i >= 0);
      const proposals: Array<{ body: string; phase: string }> = [{ body: read('proposed'), phase: 'ledger row' }];
      for (const start of blocks) {
        const heading = tokens[start]!;
        if (heading.type !== 'heading') continue;
        let end = start + 1;
        while (end < tokens.length && !(tokens[end]!.type === 'heading' && (tokens[end] as any).depth <= heading.depth)) end++;
        const preceding = tokens.slice(0, start).filter(t => t.type === 'heading' && t.depth < heading.depth).at(-1);
        proposals.push({ body: prose(tokens.slice(start + 1, end).map(t => t.raw).join('')), phase: preceding?.type === 'heading' ? preceding.text : heading.text });
      }
      for (const spec of obligations) {
        const row = `${owner} ${read('evidence')} ${read('current')}`;
        // Current holds existing/approved behavior. A correct baseline can
        // still have a defective pending alternative in Proposed; keep that
        // defect bound to this active row, not a copied comparison elsewhere.
        const pendingDefect = /^(?:unresolved|reopened)\b/i.test(read('status')) &&
          current(read('proposed')) && spec.subject.test(read('proposed')) && spec.defect.test(read('proposed'));
        if (!spec.subject.test(seedPlan) || !spec.defect.test(seedPlan) || !spec.subject.test(row) ||
          !(spec.defect.test(read('current')) || pendingDefect) ||
          !spec.subject.test(question) || !spec.defect.test(explanation)) continue;
        const operative = options.some(o => spec.remedy.test(o) && spec.subject.test(o));
        const proposal = proposals.find(p => current(p.body) && spec.remedy.test(p.body) && spec.subject.test(p.body));
        if (operative && proposal) matches.push({ seed: spec.seed, ledgerId: id, phase: proposal.phase, signature: fp.signature });
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function setupQuestion(fp: AskUserQuestionFingerprint): boolean {
  const call = ownedAnswer(fp);
  if (!call) return false;
  const q = call.questions[0]!;
  const title = prose(q.question).split('\n')[0]!;
  const labels = q.options.map(o => option(o.label));
  if (/\b(?:skill routing|routing rules)\b/i.test(title) && /\bCLAUDE\.md\b/i.test(title))
    return labels.length === 2 && labels.some(l => /\b(?:add|enable|include|append)\b.*\brouting\b/i.test(l)) && labels.some(l => /\b(?:no thanks|skip|manually|manual)\b/i.test(l));
  // Reuse the native scope interaction classifier under ownedAnswer's
  // stricter identity checks; setup needs no working-plan file yet.
  if (prose(q.question).trim() && current(prose(q.question)) && engSetupAUQ(fp)) return true;
  // Preserve the existing label-wrapper contract; the shared predicate
  // expects unnumbered action labels while this older route accepts wrappers.
  if (/\bcross[- ]project learnings\b/i.test(title) && /\b(?:enable|search)\b/i.test(title))
    return labels.length === 2 && labels.some(l => /\benable\b.*\bcross[- ]project\b/i.test(l)) && labels.some(l => /\bproject[- ]scoped\b/i.test(l));
  const modes = labels.map(l => l.match(/\b(?:SCOPE EXPANSION|SELECTIVE EXPANSION|HOLD SCOPE|SCOPE REDUCTION)\b/g));
  if (labels.length === 4 && modes.every(found => found?.length === 1) && new Set(modes.flat()).size === 4) return true;
  if (/\b(?:scope|review target)\b/i.test(title) && labels.some(l => /skip\s+interview|plan\s+immediately/i.test(l))) return true;
  if (/\boffice-hours\b/i.test(title) && labels.length === 2 && labels.some(l => /\brun\b.*office-hours/i.test(l)) && labels.some(l => /^skip\b/i.test(l))) return true;
  const remedyEvidence = obligations.some(spec => spec.subject.test(q.question) && spec.defect.test(q.question) &&
    q.options.some(o => spec.remedy.test(`${o.label} ${o.description ?? ''}`)));
  return !remedyEvidence && /\b(?:which|choose|select)\b.*\bapproach\b/i.test(title) && /^Approach$/i.test(q.header);
}
function todoDecision(fp: AskUserQuestionFingerprint): boolean {
  const q = fp.nativeCall!.questions[0]!;
  return /\bTODO(?:S\.md|s|[- ]\d+)?\b/i.test(q.header + ' ' + q.question.split('\n')[0]) &&
    q.options.some(o => /^(?:add|build|implement|remove|defer|skip)\b/i.test(option(o.label)));
}

/** Count other real choices by their saved decision identity, not a defect
 * vocabulary. A row alone is insufficient: its own complete comparison must
 * bind every offered native option. This grants count credit, not approval. */
function recordedDecision(fp: AskUserQuestionFingerprint, savedPlan: string): { ledgerId: string; phase: string } | null {
  const call = ownedAnswer(fp);
  if (!call) return null;
  const q = call.questions[0]!, question = prose(q.question);
  if (!question.trim() || !current(question)) return null;
  const title = question.split('\n')[0]!;
  const tokens = marked.lexer(savedPlan);
  // A current document may declare its source once and cite that plan's
  // sections in each row. An unrelated mention elsewhere is not provenance.
  const currentContext = (index: number) => {
    const headings: Array<{ depth: number; text: string }> = [];
    for (const token of tokens.slice(0, index)) if (token.type === 'heading') {
      while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
      headings.push({ depth: token.depth, text: plain(token.text) });
    }
    return headings.every(heading => current(heading.text));
  };
  const sourceRecords = tokens.flatMap((token, index) => {
    if (token.type !== 'paragraph' || !currentContext(index) || /^[`"'“‘]/.test(token.raw.trim())) return [];
    const text = plain(token.raw);
    if (!current(text) && !/^Source(?: plan)?:/i.test(text)) return [];
    return [...text.matchAll(/(?:^|[.!?]\s+|\n)(?:Source(?: plan)?|Plan under review|(?:Reviewed|Review target|Input) plan):\s*([\w./-]+)/gi)]
      .map(match => match[1]!.replace(/[.;,]+$/, ''));
  });
  const namedSource = sourceRecords.length === 1 && sourceRecords[0] === 'PLAN.md';
  const inheritedSource = (evidence: string) => namedSource &&
    /\bEvidence:\s*plan text\b|\bplan\s+§\s*\S|\bplan\s+sections?\s+\S|^Plan(?: contract)?:\s*\S/i.test(evidence);
  // The skill requires complete per-option facts, not a GFM option table.
  // Code and quoted children cannot supply a prose/list option's fields.
  const proseOption = (parts: readonly any[]) => {
    const paragraphs = parts.filter(part => part.type === 'paragraph' || part.type === 'text');
    const first = paragraphs[0];
    if (!first) return null;
    const text = paragraphs.map(part => plain(part.raw)).join('\n').trim();
    const label = first.tokens?.[0]?.type === 'strong' ? plain(first.tokens[0].text)
      : /^([A-D][).:]\s+.+?)\s+[—–-]\s+/i.exec(text)?.[1]
        ?? /^([A-D][).:]\s+.+?)[.:]\s+/i.exec(text)?.[1];
    if (!label || !/^[A-D][).:]\s+\S/i.test(label)) return null;
    const details = text.slice(label.length).replace(/^[.:\s—–-]+/, '');
    const facts = [...details.matchAll(/(?:^|[.,;]\s+|\n\s*)(Effort(?: estimate)?|Risk(?: level)?|Pros|Cons)\s*:?\s+/gi)];
    const fields = Object.fromEntries(facts.map((fact, index) => [fact[1]!.split(' ')[0]!.toLowerCase(),
      details.slice(fact.index! + fact[0].length, facts[index + 1]?.index ?? details.length).trim()]));
    const complete = facts.length === 4 && Object.keys(fields).length === 4 && current(text) &&
      ['effort', 'risk', 'pros', 'cons'].every(field => fields[field] && current(fields[field]!)) &&
      /^(?:S|M|L|XL)\b/i.test(fields.effort!) && /^(?:low|medium|high)\b/i.test(fields.risk!);
    return { label, summary: text, bindingText: label + ' ' + details.slice(0, facts[0]?.index ?? details.length), complete };
  };
  const selector = (label: string) => /^([A-D])[.):]\s*/i.exec(plain(label))?.[1]?.toUpperCase();
  const labelWords = (label: string) => (option(label).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])
    .filter(word => !['recommended', 'option', 'only', 'plan', 'planned', 'written', 'keep', 'same', 'full'].includes(word));
  // Terminal punctuation and a status suffix are presentation, not a choice.
  const caption = (value: string) => option(value).replace(/^[A-D]:\s*/i, '').replace(/\s*\((?:plan )?as (?:written|planned)\)\.?$/i, '').replace(/[.:]$/, '').trim();
  const words = (value: string) => caption(value).toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const completeCaption = (offered: string, saved: string, summary: string) => {
    const a = selector(offered), b = selector(saved);
    if (a && a !== b) return false;
    const left = words(offered), right = words(saved + ' ' + summary);
    // Abbreviations may omit detail, but an unlettered saved caption cannot
    // add an action or narrow its scope. A terminal 'in place' is presentation.
    const savedCaption = words(caption(saved).replace(/ in place$/i, ''));
    if (!a && savedCaption.some(word => !left.includes(word))) return false;
    // A lettered grid may abbreviate a terminal "only" qualifier; never
    // discard an action's internal scope or a negation while binding it.
    if (a && left.at(-1) === 'only' && !right.includes('only')) left.pop();
    if (['no', 'not', 'never', 'without'].some(word => left.includes(word) !== right.includes(word))) return false;
    if (!left.length || (!a && left.length < 2) || left[0] !== right[0]) return false;
    let cursor = 0;
    return left.every(word => { const index = right.indexOf(word, cursor); cursor = index + 1; return index >= 0; });
  };
  const sameOption = (offered: string, saved: string, summary: string) => caption(offered).toLowerCase() === caption(saved).toLowerCase() ||
    Boolean(selector(offered) && selector(offered) === selector(saved) &&
      labelWords(offered).some(word => labelWords(saved + ' ' + summary).includes(word))) ||
    (!selector(offered) && completeCaption(offered, saved, summary));
  const matches: Array<{ ledgerId: string; phase: string }> = [];
  for (const table of tokens.filter(t => t.type === 'table')) {
    if (table.type !== 'table') continue;
    const index = (meaning: RegExp) => table.header.flatMap((cell, i) => meaning.test(plain(cell.text)) ? [i] : []);
    const fields = { id: index(/^(?:ID|Decision)\b/i), evidence: index(/\b(?:Contract|Evidence)\b/i),
      current: index(/^Current\b/i), proposed: index(/^Proposed\b/i), status: index(/^Status\b/i) };
    if (Object.values(fields).some(found => found.length !== 1)) continue;
    for (const cells of table.rows) {
      const read = (key: keyof typeof fields) => plain(cells[fields[key][0]!]!.text);
      const id = read('id').split(/\s/, 1)[0]!.replace(/[.:]$/, '');
      if (!id || !mentions(title, id) || !/^(?:unresolved|reopened|approved|deferred|declined)\b/i.test(read('status')) ||
          !read('current') || !read('proposed') || read('current') === read('proposed') ||
          !current(read('evidence')) || !current(read('proposed'))) continue;
      if (!/\bPLAN\.md\b/.test(read('evidence')) && !inheritedSource(read('evidence'))) continue;
      const anchors = tokens.flatMap((t, i) =>
        (t.type === 'heading' && current(plain(t.text)) && mentions(plain(t.text), id)) ||
        (t.type === 'paragraph' && /^(?:Options|Approaches|Comparison)\b/i.test(plain(t.raw)) && mentions(plain(t.raw), id)) ? [i] : []);
      let matchedPhase: string | undefined;
      for (const start of anchors) {
        const anchor = tokens[start]!;
        let end = start + 1;
        while (end < tokens.length && !(tokens[end]!.type === 'heading' &&
          (anchor.type !== 'heading' || (tokens[end] as any).depth <= anchor.depth))) end++;
        const section = tokens.slice(start + 1, end);
        if (currentContext(start) && currentContext(tokens.indexOf(table))) {
          const options = section.flatMap(token => token.type === 'list'
            ? token.items.map(item => proseOption(item.tokens))
            : token.type === 'paragraph' ? [proseOption([token])] : []).filter(option => option !== null);
          const matched = q.options.map(offered => options.flatMap((saved, index) =>
            saved!.complete && sameOption(offered.label, saved!.label, selector(offered.label) ? saved!.summary : saved!.bindingText) ? [index] : []));
          if (options.length === q.options.length && matched.every(found => found.length === 1) &&
              new Set(matched.flat()).size === q.options.length) {
            matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          }
        }
        for (const comparison of tokens.slice(start + 1, end)) {
          if (comparison.type !== 'table') continue;
          const headers = comparison.header.map(c => plain(c.text));
          // The declared commitment grid transposes the option table: each
          // complete alternative is a column. Its saved effort/risk row and
          // behavioral cells bind the owned native pros/cons for that option.
          const commitment = headers.findIndex(h => /^Commitment$/i.test(h));
          const source = headers.findIndex(h => /^Source(?:\b|\/)/i.test(h));
          const baseline = headers.findIndex(h => /^Current$/i.test(h));
          const optionColumns = headers.flatMap((header, index) => selector(header) ? [index] : []);
          if (commitment >= 0 && source >= 0 && baseline >= 0 &&
              currentContext(start) && currentContext(tokens.indexOf(table)) && currentContext(tokens.indexOf(comparison)) &&
              headers.length === q.options.length + 3 &&
              optionColumns.length === q.options.length &&
              new Set(optionColumns.map(i => selector(headers[i]!))).size === q.options.length) {
            // GFM permits a following un-delimited paragraph as a padded row.
            // Only explicit grid rows supply cells; a current prose footer
            // remains context and cannot fill a missing value in a real row.
            const rawRows = comparison.raw.trimEnd().split('\n').slice(2);
            const gridRow = (index: number) => /(^|[^\\])\|/.test(rawRows[index] ?? '');
            const footerCurrent = rawRows.filter((_, index) => !gridRow(index)).every(line => current(plain(line)));
            const rows = comparison.rows.filter((_, index) => gridRow(index)).map(row => row.map(cell => plain(cell.text)));
            const effortRisk = rows.filter(row => /^Effort\s*\/\s*risk$/i.test(row[commitment] ?? ''));
            const behavior = rows.filter(row => !/^Effort\s*\/\s*risk$/i.test(row[commitment] ?? ''));
            const complete = footerCurrent && effortRisk.length === 1 && optionColumns.every(i => /^(?:S|M|L|XL)\s*\/\s*(?:low|medium|high)$/i.test(effortRisk[0]![i] ?? '')) &&
              behavior.length > 0 && behavior.every(row => row.length === headers.length && row[commitment] && row[source] && row[baseline] &&
                current(row[commitment]!) && optionColumns.every(i => row[i] && current(row[i]!))) &&
              behavior.some(row => new Set(optionColumns.map(i => row[i]!.toLowerCase())).size > 1) &&
              q.options.every(o => { const facts = prose(o.description ?? ''); return /✅/.test(facts) && /❌/.test(facts) && current(facts); });
            const matched = q.options.map(offered => optionColumns.filter(i => completeCaption(offered.label, headers[i]!, '')));
            if (complete && matched.every(found => found.length === 1) && new Set(matched.flat()).size === q.options.length)
              matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          }
          const optionColumn = headers.findIndex(h => /^(?:Option|Approach)\b/i.test(h));
          if (optionColumn < 0 || !['effort', 'risk', 'pros', 'cons'].every(h => headers.some(v => v.toLowerCase() === h)) ||
              comparison.rows.length !== q.options.length || comparison.rows.some(row => row.some(cell => !plain(cell.text)))) continue;
          const saved = comparison.rows.map(row => plain(row[optionColumn]!.text));
          const summaryColumn = headers.findIndex(h => /^(?:Summary|Description|Approach)$/i.test(h));
          const matched = q.options.map(offered => saved.flatMap((label, i) => sameOption(offered.label, label,
            summaryColumn < 0 ? '' : plain(comparison.rows[i]![summaryColumn]!.text)) ? [i] : []));
          if (matched.every(found => found.length === 1) && new Set(matched.flat()).size === q.options.length) {
            matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          }
        }
      }
      if (matchedPhase) matches.push({ ledgerId: id, phase: matchedPhase });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Fixture-local metric adapter. It never advances the shared phase boundary.
 * Every real current question, including repeated remedies, still counts
 * toward the original 4–7 band. Unknown decisions fail closed. */
export function createCeoPaymentFindingCounter(seedPlan: string, readPlan: () => string,
  existingFinding: (fp: AskUserQuestionFingerprint) => boolean) {
  const trace: Array<Finding | { signature: string; kind: 'setup' | 'existing-finding' | 'additional-current-decision' } |
    { signature: string; kind: 'recorded-decision'; ledgerId: string; phase: string }> = [];
  return {
    trace,
    isReviewAUQ(fp: AskUserQuestionFingerprint, priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
      if (!ownedAnswer(fp) || priorCalls.some(call => `${call.sessionId}:${call.toolUseId}` === fp.signature))
        throw new Error(`Invalid or duplicated completed native decision: ${fp.signature}`);
      if (setupQuestion(fp)) { trace.push({ signature: fp.signature, kind: 'setup' }); return false; }
      const plan = readPlan();
      const finding = ceoPaymentFinding(fp, seedPlan, plan);
      if (finding) { trace.push(finding); return true; }
      const decision = recordedDecision(fp, plan);
      if (decision) { trace.push({ signature: fp.signature, kind: 'recorded-decision', ...decision }); return true; }
      if (todoDecision(fp)) { trace.push({ signature: fp.signature, kind: 'additional-current-decision' }); return true; }
      if (existingFinding(fp)) { trace.push({ signature: fp.signature, kind: 'existing-finding' }); return true; }
      throw new Error(`Unsupported current CEO decision; cannot exclude it from the 4–7 count: ${fp.signature}`);
    },
  };
}
