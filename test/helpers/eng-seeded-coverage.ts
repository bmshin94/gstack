import type { NativePlanQuestionCall, PlanCountTranscript } from './plan-count-transcript';
import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { hasRetainedLegacyCorpus } from './eng-retained-corpus';
import { marked } from 'marked';

/** Evidence for this fixture's four decision seeds; regression coverage is auto-added by the skill. */
export const ENG_DECISION_SEEDS = ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp'] as const;
type Seed = typeof ENG_DECISION_SEEDS[number];

// Ignore displayed examples/code, while retaining inline code identifiers.
function prose(text: string, omitLiteralProse = false): string {
  let fence: string | undefined;
  const lines = text.split('\n').filter(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence && !/^(?: {0,3}>| {4}|\t)/.test(line);
  }).join('\n');
  return (omitLiteralProse ? lines.replace(/`([^`]+)`/g, (span, body: string) => /\s/.test(body) ? '' : span) : lines).replace(/[`*]/g, '');
}

function seedSubjects(q: NativePlanQuestionCall['questions'][number]): Seed[] {
  // The actual issue subject, not cross-references in recommendations or other options,
  // assigns credit. ELI10 can identify what a terse Promise.all title operates on.
  const subject = q.question.split('\n').find(line => line.trim())?.trim() ?? '';
  if (/^(?:>|`{3}|~{3}|example\b|quote\b|["“])|\b(?:no (?:issue|defect)|already (?:fixed|resolved)|hypothetical)\b/i.test(subject)) return [];
  const title = subject.replace(/[`*]/g, '');
  // A concise decision title can name the design choice while its own
  // current explanation states the defect. Keep these three forms bound to
  // that explanation and the same native option's concrete repair.
  const decisionTitle = title.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '');
  const tenantWriters = /^Architecture issue [1-9]\d*: two services write the same tenant-keyed cache with no serialized mutations\. Who owns writes\?$/i.test(decisionTitle);
  const decomposition = /^Reduce the ([2-9]\d*)-component decomposition or proceed as-is\?$/.exec(decisionTitle);
  const rewrittenErrors = /^How should validateAndDispatch\(\) handle errors after the rewrite\?$/.test(decisionTitle);
  const ownedRewriteChoice = Boolean(decomposition || rewrittenErrors);
  if (ownedRewriteChoice && /^`[^`]*`[.?]?$/.test(subject.replace(/^D[1-9]\d*\s*[—–:-]\s*/, ''))) return [];
  const explainedSeed: Seed | undefined = /^Reduce the new-class count before we review the rest\?$/.test(decisionTitle) || decomposition ? 'complexity'
    : /^Who is allowed to write to the auth cache\?$/.test(decisionTitle) || tenantWriters ? 'shared-cache'
    : /^How should validateAndDispatch\(\) handle errors\?$/.test(decisionTitle) || rewrittenErrors ? 'swallowed-errors' : undefined;
  if (explainedSeed) {
    const ordinal = /^D([1-9]\d*)\s*[—–:-]/.exec(title)?.[1];
    const status = '(?:withdrawn|rejected|cancelled|canceled|superseded|resolved|fixed|optional|hypothetical|unproven|not current|no longer current)';
    const owner = `(?:(?:this|the|that) (?:finding|issue|decision|gap|defect|assessment|explanation)${ordinal ? `|D${ordinal}` : ''})`;
    const current = (value: string, option = false) => {
      const subject = option ? `(?:${owner}|(?:this|the|that) (?:option|action|remedy|correction))` : owner;
      const scalar = new RegExp(`((?:^|[.!?;]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?${subject} (?:is|was|has been) )["“'‘\x60](${status})["”'’\x60]`, 'gim');
      const formatted = ownedRewriteChoice ? value.replace(/\*\*/g, '') : value;
      return prose(formatted.replace(scalar, '$1$2'), true).replace(/"[^"\n]*"|“[^”\n]*”|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’/g, '');
    };
    const framed = /(?:^|[.!?;:]\s+|\n)(?:(?:Project\/branch\/task|ELI10):\s*)?(?:Source(?: excerpt| material)?|Quoted(?: source)?|Historical(?: assessment| example)?|If approved|Once approved|When approved|Pending approval|Assuming approval|Provided approval)[,:.]?\s/i;
    const active = (value: string, option = false) => {
      const text = current(value, option), subject = option ? `(?:${owner}|(?:this|the|that) (?:option|action|remedy|correction))` : owner;
      if (ownedRewriteChoice && (/\b(?:if|once|when|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i.test(text) ||
        /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:this|the|that) (?:finding|issue|option|action|remedy|correction) (?:applies|proceeds|will proceed) only if\b/i.test(text))) return false;
      return !framed.test(text) && !new RegExp(`(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?${subject} (?:is|was|has been) ${status}\\b`, 'i').test(text) &&
        !(option && /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw) (?:drop|reduce|inject|flatten|rethrow|make|apply)\b/i.test(text)) &&
        !(ownedRewriteChoice && option && /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw) (?:cut|remove|split|propagate)\b/i.test(text));
    };
    const text = current(q.question), explanations = [...text.matchAll(/^ELI10: (.+)$/gm)];
    // A current correction about the named component/function overrides its
    // earlier defect assertion; quoted history has already been removed.
    if (decomposition && /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:AuthCache (?:now |already )?has independent policy rules|TokenStore (?:now |already )?has a documented independent purpose)\b/i.test(text) ||
        rewrittenErrors && /(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?validateAndDispatch\(\) (?:now |already )?(?:rethrows every error|no longer swallows failures)\b/i.test(text)) return [];
    const prefix = text.slice(text.indexOf('\n') + 1, explanations[0]?.index ?? 0).trim().split('\n').filter(Boolean);
    if (explanations.length !== 1 || (prefix.length !== 1 && !(tenantWriters && prefix.length === 2 && /^\[P[0-3]\]/.test(prefix[1]!))) ||
        !/^Project\/branch\/task: \S/.test(prefix[0]!) || !active(q.question)) return [];
    const explanation = explanations[0]![1]!;
    const options = q.options.filter(o => active(`${o.label}\n${o.description ?? ''}`, true))
      .map(o => ({ label: current(o.label).replace(/^[1-9]\d*[A-D]\s+/, ''), description: current(o.description ?? '') }));
    // A numbered decomposition choice owns its inventory and redundant-wrapper
    // explanation. Keep the cut and injected-adapter remedy in the same option.
    if (decomposition) {
      const inventory = /, ([A-Za-z][\w]*(?: \+ [A-Za-z][\w]*)+)\.$/.exec(prefix[0]!)?.[1]?.split(' + ') ?? [];
      const pieces = /^The plan builds (five|[1-9]\d*) new pieces, but one working cache already does the storing and invalidating\./.exec(explanation);
      return new Set(inventory).size === Number(decomposition[1]) && inventory.length === Number(decomposition[1]) &&
        ['AuthBroker', 'SessionMint', 'AuthCache', 'TokenStore'].every(name => inventory.includes(name)) &&
        pieces && Number(pieces[1] === 'five' ? 5 : pieces[1]) === Number(decomposition[1]) &&
        /\bAuthCache is described as a facade over that adapter with no new rules, and TokenStore is never described at all\./.test(explanation) &&
        options.some(o => {
          const cut = /^(?:[A-D][):.]\s*)?(?:Cut|Drop|Remove) AuthCache \+ TokenStore, keep ([1-9]\d*)\b/.exec(o.label);
          return cut && Number(cut[1]) === inventory.length - 2 &&
            /^(?:✅\s*)?AuthBroker and SessionMint depend on the existing adapter through one small injected interface; no facade, no second store\./.test(o.description);
        }) ? ['complexity'] : [];
    }
    // The future repair concerns a currently swallowing function, established
    // by its own metadata; a general error-handling question is insufficient.
    if (rewrittenErrors) return /\bvalidateAndDispatch\(\) is [1-9]\d* lines with (?:three|[1-9]\d*) nested try\/catch blocks that each swallow a different error class\b/.test(prefix[0]!) &&
      /^When an auth function catches an error and quietly moves on, the request continues as if the check passed or never mattered\./.test(explanation) &&
      options.some(o => /^(?:[A-D][):.]\s*)?Split into validate\(\) \+ dispatch\(\); one typed error boundary, deny-by-default\b/.test(o.label) &&
        /^(?:✅\s*)?Each error class maps to an explicit AuthOutcome \(denied\/retryable\/misconfigured\) with a reason; nothing is swallowed, unknown errors deny\b/.test(o.description) ||
        /^(?:[A-D][):.]\s*)?Keep one function; flatten the three catches into one that logs and rethrows$/.test(o.label) &&
        /\bErrors are no longer silent; every failure is logged and surfaced\./.test(o.description)) ? ['swallowed-errors'] : [];
    if (tenantWriters) return /\bAuthBroker\b/.test(prefix[0]!) && /\bSessionMint\b/.test(prefix[0]!) &&
      /^Two services writing the same cache entry at the same time is a race\./.test(explanation) &&
      !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:the|this) (?:cache|writes|writers) (?:is|are|have been) (?:now ordered|now serialized|no longer shared)\b/i.test(text) &&
      options.some(option => {
        const actors = /\b(AuthBroker|SessionMint) is the only service that writes validated entries;\s*(AuthBroker|SessionMint) reads\b/.exec(option.description);
        return /^[1-9]\d*[A-D][):.]\s*Single writer \+ generation check\b/.test(option.label) && actors && actors[1] !== actors[2] &&
          /\bEach write carries the tenant generation read at validation start; the adapter rejects a write whose generation is stale\b/.test(option.description);
      }) ? ['shared-cache'] : [];
    if (explainedSeed === 'complexity') {
      const wrapper = /^The plan invents a new cache wrapper \(([A-Za-z][\w]*)\) and a new token store on top of a cache adapter that already does tenant keying, expiry, and invalidation\./.exec(explanation);
      return wrapper && options.some(o => /^Reduce\b/.test(o.label) &&
        new RegExp(`\\bdrop ${wrapper[1]}\\/TokenStore classes\\.`).test(o.description)) ? [explainedSeed] : [];
    }
    if (explainedSeed === 'shared-cache') return /\bAuthBroker and SessionMint both mutating one backing cache\b/.test(prefix[0]!) &&
      /^Two services write to the same cache and nothing orders their writes\./.test(explanation) &&
      !/(?:^|[.!?]\s+|\n)(?:Correction:\s*)?(?:the|this) (?:cache|writes|writers) (?:is|are|have been) (?:now ordered|now serialized|no longer shared)\b/i.test(text) &&
      options.some(o => /^Single writer\b/.test(o.label) && /^SessionMint writes\b/.test(o.description) && /\bAuthBroker reads\b/.test(o.description)) ? [explainedSeed] : [];
    return /\bvalidateAndDispatch\(\) is [1-9]\d* lines, (?:three|[1-9]\d*) nested try\/catch blocks, each catch swallows a different error class\b/.test(prefix[0]!) &&
      /^Right now when something goes wrong inside validation, the code catches the problem and keeps going as if nothing happened\./.test(explanation) &&
      options.some(o => /^Flatten \+ typed errors\b/.test(o.label) && /\bLinear pipeline, typed error classes, one fail-closed boundary\b/.test(o.description) ||
        /^Rethrow, one outer catch$/.test(o.label) && /\brethrow typed errors; outer catch denies\b/.test(o.description)) ? [explainedSeed] : [];
  }
  // Scheduling questions name the proposed execution mode in the title. Even
  // when it says "parallel", their current defect and bounded remedy belong
  // to the owned explanation, not the generic direct-action shortcut below.
  if (/^How (?:should|will|do) (?:the )?(?:five|5) (?:IDP|identity provider)(?: validation)? calls? (?:be )?(?:issued|run|executed|scheduled)\b/i.test(decisionTitle)) return explainedSeedSubjects(q);
  // A component-arrangement or rewrite choice owns its explanation even
  // when the title also names the defect. Do not let a failed owned-source
  // check fall through to the legacy title-only shortcuts. Existing compact
  // one-line briefs keep their established direct-assertion route.
  if (q.question.includes('\n') && (/\bTokenStore\b/.test(decisionTitle) && /\bAuthCache\b/.test(decisionTitle) &&
      /\b(?:arrangement|arranged|structure|components?|classes?)\b/i.test(decisionTitle) ||
      /^Rewrite validateAndDispatch\(\)\s+(?:with|using|into|to)\b/i.test(decisionTitle))) return explainedSeedSubjects(q);
  // A whole-candidate scope choice carries the class-count problem in its
  // current explanation; a bare component name cannot own a generic shortcut.
  if (q.question.includes('\n') && /^TokenStore\s*:/.test(decisionTitle) &&
      /\b(?:this|the current) PR\b/i.test(decisionTitle)) return explainedSeedSubjects(q);
  // Current class choices can name keep/remove in the title and put the count
  // in metadata or an explanation. They still require owned source evidence;
  // a title-only shortcut must not rescue a failed comparison.
  if (q.question.includes('\n') && (
      /\bTokenStore\b/.test(decisionTitle) && /\b(?:this|the current) (?:PR|refactor)\b/i.test(decisionTitle) && /\b(?:keep|include|retain|stay)\b/i.test(decisionTitle) && /\b(?:defer(?:red)?|cut|remove|drop)\b/i.test(decisionTitle) ||
      /\bAuthCache\b/.test(decisionTitle) && /\bfacade\b/i.test(decisionTitle) && /\b(?:class(?:es)?|arrangement|structure)\b/i.test(decisionTitle))) return explainedSeedSubjects(q);
  const offered = q.options.map(o => `${o.label} ${o.description ?? ''}`).join('\n');
  const directAction = title.match(/\b(?:should|shall|can|do|would)\s+(?:we|I)\s+([^?]+)\?\s*$/i)?.[1];
  const action = (re: RegExp) => re.test(offered) || Boolean(directAction && new RegExp(`^(?:${re.source})`, re.flags).test(directAction));
  // A shared adapter title may name its cache in the issue's own asserted
  // explanation. Options alone or a neighboring source excerpt cannot do so.
  const adapterPublic = prose(q.question, true);
  const adapterExplanations = [...adapterPublic.matchAll(/^ELI10:\s*(.+)$/gm)];
  const adapterPrefix = adapterPublic.slice(0, adapterExplanations[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
  const adapterMetadata = adapterPrefix.join(' ').replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const adapterExplanation = adapterExplanations.length === 1 && adapterPrefix.every(line => /^(?:Project\/branch\/task:|\[P[0-3]\])/.test(line))
    && !/\b(?:copied|quoted|source|hypothetical|historical)\s+(?:(?:source|quoted)\s+)?(?:example|excerpt|text|material)\b|\b(?:ELI10|assessment|finding)\s+is\s+not\s+(?:a\s+)?current\b/i.test(adapterMetadata)
    ? adapterExplanations[0]![1]! : '';
  const adapterAssessment = adapterPublic.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const sharedAdapter = /\bwrite-after-invalidate race\b/i.test(title)
    && /\bSessionMint\b/.test(title) && /\bAuthBroker\b/.test(title) && /\bshared adapter\b/i.test(title)
    && /^(?:Even after injection,\s*)?(?:both|the two) services (?:write into|mutate) the same cache\./i.test(adapterExplanation)
    && !/\b(?:(?:this|that|the) (?:issue|finding|race)|Issue\s+[1-9]\d*)\s+(?:is|was|has been)\s+(?:withdrawn|retracted|rejected|resolved|fixed)\b|\bno (?:current )?shared-cache race\b/i.test(adapterAssessment);
  const ids: Seed[] = [];
  // The inventory alias needs its own current action; an inline quoted title
  // or actions reproduced only as source material cannot establish this seed.
  const inventoryProse = prose(q.question, true)
    .replace(/(\b(?:this|the) class[ -]inventory decision is )['"“](withdrawn|rejected|cancelled|canceled|resolved)['"”]/gi, '$1$2')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const inventoryAction = q.options.some(o => {
    const label = prose(o.label, true), description = prose(o.description ?? '', true).replace(/"[^"\n]*"|“[^”\n]*”/g, '');
    return /^(?:[A-D][).:—–-]\s*)?(?:reduce|cut|simplify|remove|collapse|merge)\b[^.!?\n]{0,160}\b(?:classes|types|abstractions)\b/i.test(label)
      && !/^(?:source|quoted|historical|example|if approved|hypothetical)\b|\b(?:this|the) (?:option|action|remedy) is (?:withdrawn|rejected|cancelled|canceled)\b/i.test(description);
  });
  const classInventory = /^(?:D[1-9]\d*\s*[—–:-]\s*)?(?:Reduce|Simplify|Trim) the class inventory(?: before building)?\?$/i.test(prose(subject, true))
    && inventoryAction && !/\b(?:this|the) class[ -]inventory decision (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|resolved|not current)\b/i.test(inventoryProse);
  if (classInventory || /\b(?:scope|complexity|classes|types|abstractions)\b/i.test(title) &&
      /\b(?:files|classes|types|abstractions)\b/i.test(title) &&
      action(/\b(?:reduce|cut|simplify|remove|collapse|merge|pure function)\b/i)) ids.push('complexity');
  if ((sharedAdapter || /\b(?:AuthCache|cache)\b/i.test(title) &&
      /\b(?:global|module[ -]level|mutab\w*|both|shar\w*|ownership|writers|same\s+(?:AuthCache|cache))\b/i.test(title)) &&
      action(/\b(?:inject\w*|DI|serializ\w*|single[ -]writer|ownership|composition root)\b/i)) ids.push('shared-cache');
  if (/\b(?:validateAndDispatch|catch\w*)\b/i.test(title) &&
      /\b(?:swallow\w*|nested|silent\w*|hidden|suppres\w*)\b/i.test(title) &&
      action(/\b(?:split|rethrow|typed|flatten|propagat\w*)\b/i)) ids.push('swallowed-errors');
  if (/\b(?:sequential|parallel\w*|Promise\.all(?:Settled)?)\b/i.test(title) &&
      /\b(?:IDP|identity provider)\b/i.test(prose(q.question)) &&
      action(/\b(?:parallel\w*|Promise\.all(?:Settled)?)\b/i)) ids.push('sequential-idp');
  return ids.length ? ids : explainedSeedSubjects(q);
}

/** A decision may put its current defect in its own metadata/ELI10, not its title. */
function explainedSeedSubjects(q: NativePlanQuestionCall['questions'][number]): Seed[] {
  const rawTitle = q.question.split('\n').find(line => line.trim())?.trim() ?? '';
  const ordinal = /^D([1-9]\d*)\b/.exec(rawTitle)?.[1];
  const record = /^D[1-9]\d*\s*\((R[1-9]\d*)\)/.exec(rawTitle)?.[1];
  if (record && !new RegExp(`^${record}\\b`).test(q.header.trim())) return [];
  const owner = `(?:(?:this|the|that) (?:finding|issue|decision|gap|defect|assessment|explanation|option|action|remedy)${ordinal ? `|D${ordinal}` : ''}${record ? `|${record}` : ''})`;
  const inactive = '(?:withdrawn|retracted|rejected|cancelled|canceled|resolved|fixed|superseded|optional|hypothetical|unproven|not current|no longer current)';
  const current = (value: string) => prose(value.replace(/\*\*/g, '').replace(
    new RegExp(`(${owner} (?:is|was|has been) )["“'‘\x60](${inactive})["”'’\x60]`, 'gi'), '$1$2'), true)
    .replace(/"[^"]*"|“[^”]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’]*’/g, '');
  const framed = /(?:^|[.!?;:]\s+|\n)(?:(?:Project\/branch\/task|ELI10):\s*)?(?:source|quoted|historical|example|hypothetical|if approved|once approved|when approved|pending approval|assuming approval|provided approval)\b/i;
  const active = (value: string) => !framed.test(value)
    && !/\b(?:copied|quoted|historical)\s+(?:(?:source|quoted)\s+)?(?:example|excerpt|text|material)\b/i.test(value)
    && !new RegExp(`\\b${owner} (?:is|was|has been) ${inactive}\\b`, 'i').test(value)
    && !/\b(?:if|once|when|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i.test(value)
    && !/(?:^|[.!?;]\s+|\n)(?:Correction:\s*)?(?:do not|don't|never|skip|cancel|withdraw) (?:reduce|cut|remove|keep|flatten|split|map|rethrow|parallelize|run|apply|fold|inline|combine|consolidate|merge|inject|propagate|log|construct|pass)\b/i.test(value);
  // Inline literal sentences and a non-current title cannot own the packet.
  if (/^[`"“>]/.test(rawTitle.replace(/^D[1-9]\d*\s*[—–:-]\s*/, ''))) return [];
  const text = current(q.question), lines = text.split('\n').filter(line => line.trim());
  const explanations = lines.filter(line => /^ELI10:/.test(line));
  const metadata = lines.filter(line => /^Project\/branch\/task:/.test(line));
  const explanationIndex = /^\[P[0-3]\] /.test(lines[2] ?? '') ? 3 : 2;
  if (explanations.length !== 1 || metadata.length !== 1 || lines[1] !== metadata[0] || lines[explanationIndex] !== explanations[0]
      || explanationIndex === 3 && !active(lines[2]!.replace(/^\[P[0-3]\] /, ''))
      || !/^Project\/branch\/task: \S/.test(metadata[0]!) || !active(text)) return [];
  const title = lines[0]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '');
  if (!active(title)) return [];
  const explanation = explanations[0]!, subject = metadata[0] + ' ' + explanation;
  const options = q.options.map(o => current(`${o.label}\n${o.description ?? ''}`)).filter(active);
  const ids: Seed[] = [];
  // A structure-only decision can remove one redundant facade after earlier
  // scope decisions have reduced the inventory. Bind the current inventory,
  // unchanged adapter behavior and both class counts to this one question.
  const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const inventory = /\bplan (?:has|contains|retains|introduces|adds) ([1-9]\d*|one|two|three|four|five|six|seven|eight|nine) new classes:\s*([A-Za-z][\w]*(?:(?:,\s*|\s+and\s+|\s*\+\s*)[A-Za-z][\w]*)+)\./i.exec(explanation);
  const components = inventory?.[2]?.split(/,\s*|\s+and\s+|\s*\+\s*/) ?? [];
  const componentCount = inventory ? (counts[inventory[1]!.toLowerCase()] ?? Number(inventory[1])) : 0;
  const facadeReduction = /\bclass(?:es)?\b/i.test(title) && /\bAuthCache\b/.test(title) && /\bfacade\b/i.test(title)
    && inventory && components.length === componentCount && new Set(components).size === componentCount
    && ['AuthBroker', 'SessionMint', 'AuthCache'].every(name => components.includes(name))
    && /\bAuthCache\b[^\n]{0,160}\bfacade over the existing adapter\b/i.test(explanation)
    && /\b(?:keeps every rule unchanged|adds no behavior|no new behavior)\b/i.test(explanation)
    && /\b(?:pass-through|pure forwarder)\b/i.test(explanation)
    && !/\bAuthCache (?:now |already )?(?:adds|provides|has) (?:independent|distinct|new) (?:behavior|rules|policy)|\bAuthCache is no longer (?:a )?(?:pass-through|pure forwarder)\b/i.test(text)
    && options.some(option => new RegExp(`^(?:[A-D][):.]\\s*)?(?:Drop|Remove|Cut) (?:the |AuthCache )?facade[: ,—–-]+${componentCount - 1} (?:new )?classes\\b`, 'i').test(option)
      && /\bAuthBroker and SessionMint (?:depend on|use) the existing,? (?:tested )?adapter (?:interface )?directly\b/i.test(option))
    && options.some(option => new RegExp(`^(?:[A-D][):.]\\s*)?(?:Keep|Retain) AuthCache facade[: ,—–-]+${componentCount} (?:new )?classes\\b`, 'i').test(option));
  if (facadeReduction) ids.push('complexity');
  // Step 0 may name the complexity decision in its title and put the concrete
  // inventory in its own explanation. The reduction and retained backing
  // store must belong to one current option, opposed by that same inventory.
  if (/^(?:Step 0 )?complexity (?:check|decision):\s*(?:reduce|simplify|trim)\b/i.test(title)) {
    const fileCounts = [...explanation.matchAll(/\b(?:touches|changes|modifies|spans) ([1-9]\d*) files\b/gi)];
    const inventories = [...explanation.matchAll(/\b(?:adds|introduces) ([1-9]\d*) (?:new )?(?:classes|types) \(([^)]+)\)/gi)];
    const names = inventories[0]?.[2]?.split(/,\s*(?:and )?| and /) ?? [];
    const conditional = /\b(?:this|the|that) (?:finding|issue|decision|option|action|remedy) (?:(?:applies|proceeds|will proceed) (?:only )?(?:if|once|when)|(?:is|was|has been) conditional on (?:user )?approval)\b|(?:^|\n|[.!?;]\s+)(?:(?:ELI10|Project\/branch\/task):\s*)?(?:if|once|when|assuming|provided) (?:the )?(?:user|owner|reviewer) (?:approves|agrees|accepts)\b/i;
    const currentOptions = options.filter(o => !conditional.test(o));
    if (fileCounts.length === 1 && inventories.length === 1 && names.length === Number(inventories[0]![1])
        && new Set(names).size === names.length && (Number(fileCounts[0]![1]) >= 8 || names.length >= 2)
        && ['TokenStore', 'SessionMint', 'AuthCache', 'RequestPolicy'].every(name => names.includes(name)) && /\bAuthBroker\b/.test(explanation)
        && /\b(?:existing|current) (?:cache )?adapter (?:already )?keys tokens by tenant\b[^.!?]{0,40}\bevicts?\b[^.!?]{0,40}\binvalidates?\b/i.test(explanation)
        && /\bAuthCache (?:is|remains) (?:just |only )?a facade (?:over (?:it|the (?:existing |current )?(?:cache )?adapter)|for (?:that|the) adapter)\b/i.test(explanation)
        && /\bTokenStore (?:looks like|is|adds) (?:a |another )?(?:second|duplicate) (?:token )?store\b|\bTokenStore duplicates (?:the )?(?:existing |current )?adapter(?:'s)? token storage\b/i.test(explanation)
        && /\bRequestPolicy\b[^.!?]{0,90}\b(?:currently )?(?:has|serves) (?:only )?(?:one|a single) consumer\b/i.test(explanation)
        && !conditional.test(text)
        && !/\bTokenStore (?:now |already )?has (?:a documented )?independent purpose|\bRequestPolicy (?:now |already )?has (?:two|multiple|a second) consumers?\b/i.test(text)
        && currentOptions.some(o => /^(?:[A-D][):.]\s*)?(?:Reduce:\s*)?(?:cut|remove|drop) TokenStore\b/i.test(o)
          && /\b(?:demote|inline|flatten) RequestPolicy\b|\b(?:make|turn) RequestPolicy (?:into )?(?:a )?(?:plain|pure) function\b/i.test(o)
          && /\b(?:one|single|only) (?:(?:token|backing) )?(?:store|storage layer|cache)\b[^.!?\n]{0,80}\b(?:existing|current) (?:cache )?adapter\b|\b(?:existing|current) (?:cache )?adapter (?:as|is|remains|provides) (?:the )?(?:one|single|only) (?:(?:token|backing) )?(?:store|storage layer|cache)\b/i.test(o)
          && /\bAuthCache\b/.test(o))
        && currentOptions.some(o => /^(?:[A-D][):.]\s*)?(?:Proceed as-is|keep|retain)\b/i.test(o)
          && new RegExp(`\\b${inventories[0]![1]} (?:new )?(?:classes|types)\\b`, 'i').test(o)
          && new RegExp(`\\b${fileCounts[0]![1]} files\\b`, 'i').test(o)
          && /\b(?:two|2|separate) invalidation (?:paths|stories)\b/i.test(o))) ids.push('complexity');
  }
  // The overlapping stores, reduced component count and single backing store
  // must be this question's finding and one option's complete repair.
  if (/\b(?:scope|components?|pieces|classes|decomposition)\b/i.test(title)
      && ['AuthBroker', 'SessionMint', 'AuthCache', 'TokenStore'].every(name => subject.includes(name))
      && /\b(?:plan (?:adds|builds)|new)\b/i.test(explanation)
      && /\b(?:all|both) store tokens\b|\b(?:overlapping|redundant|duplicate) (?:token )?(?:stores|caches|storage)\b/i.test(explanation)
      && !/\b(?:now|already) (?:have|has) (?:independent|distinct)|\b(?:no longer|not) (?:overlapping|redundant|duplicate)\b/i.test(text)
      && options.some(o => /^(?:[A-D][):.]\s*)?(?:reduce|cut|remove|drop|fewer|simplify)\b/i.test(o)
        && /\b(?:keep|retain) AuthBroker\b/i.test(o) && /\bSessionMint\b/.test(o)
        && /\binjected AuthCache\b|\binject(?:ed)? (?:the )?(?:existing |shared )?(?:cache )?adapter\b/i.test(o)
        && /\b(?:one|single) (?:backing store|cache|storage layer)\b/i.test(o))) ids.push('complexity');
  if (/\bvalidateAndDispatch\b/.test(title)
      && /\bcatch(?:es)?\b[^.!?]{0,100}\bswallow\w*\b[^.!?]{0,60}\b(?:error|failure)/i.test(subject)
      && /\b(?:quietly|silent|nothing is logged|keeps? going|carries on)\b/i.test(explanation)
      && !/\bvalidateAndDispatch\(\) (?:now |already )?(?:rethrows every error|no longer swallows failures)\b/i.test(text)
      && options.some(o => /\b(?:flatten|split|named helpers)\b/i.test(o)
        && /\b(?:typed (?:error )?boundary|one (?:error )?(?:boundary|catch))\b/i.test(o)
        && /\bmaps?\b[^.!?]{0,140}\b(?:[45]\d\d|response|outcome)/i.test(o)
        && /\brethrows? (?:unknowns|unknown errors)|\bpropagates? (?:unknown|all) (?:errors|failures)\b/i.test(o))) ids.push('swallowed-errors');
  if (/\b(?:IDP|identity provider) calls?\b/i.test(title)
      && /\bsequential\b[^.!?]{0,60}\b(?:IDP|identity provider) calls?\b/i.test(metadata[0]!)
      && /\bindependent\b/i.test(metadata[0]!)
      && /\b(?:at once|parallel\w*|concurrent\w*)\b/i.test(explanation)
      && !/\b(?:calls|requests) (?:are |now |already )*(?:parallel|concurrent|no longer sequential)\b/i.test(text)
      && options.some(o => /\b(?:Promise\.all|paralleliz\w*|concurrent\w*)\b/i.test(o)
        && /\b(?:calls|requests|siblings)\b/i.test(o))) ids.push('sequential-idp');

  // Current native briefs may name a choice in their title and carry the
  // defect in ELI10. Bind source, inventory and repair within that one brief;
  // mentions of other findings in Net or an unchosen option supply no evidence.
  const citations = [...metadata[0]!.matchAll(/(?:^|[\s(,;])([^\s(),;]+\.md)(?::[1-9]\d*(?:[-–][1-9]\d*)?)?(?=[\s),;.]|$)/g)].map(match => match[1]);
  const ownsPlan = citations.length > 0 && citations.every(file => file === 'PLAN.md') &&
    !/\b(?:other|another|different|foreign|historical|quoted|copied) (?:plan|source|review)\b/i.test(metadata[0]!);
  if (ownsPlan) {
    // A concurrency choice can put today's ordering defect in ELI10 while
    // its metadata describes the planned repair. Bind both to these five
    // independent IDP calls; timeout coverage must belong to the same option.
    const idpPending = '(?:reopened|deferred|pending|undecided|not required)';
    const idpCurrent = (raw: string) => current(raw.replace(new RegExp(
      `(${owner} (?:is|was|has been) )["“'‘\\x60](${idpPending})["”'’\\x60]`, 'gi'), '$1$2'));
    const idpActive = (raw: string) => active(idpCurrent(raw)) && !new RegExp(
      `\\b${owner} (?:is|was|has been) ${idpPending}\\b`, 'i').test(idpCurrent(raw));
    const idpCalls = '(?:the )?(?:(?:five|5) )?(?:(?:IDP|identity provider)(?: validation)? )?(?:calls|checks|requests)';
    const changedOrdering = new RegExp(`(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?${idpCalls} (?:are |run |now |already |currently )*(?:concurrent(?:ly)?|parallel|in parallel|no longer sequential|dependent|not independent)\\b`, 'i');
    if (/\b(?:IDP|identity provider)(?: validation)? calls?\b/i.test(title)
        && /\b(?:five|5) independent (?:IDP|identity provider)(?: validation)? calls?\b/i.test(metadata[0]!)
        && /\b(?:today|currently|right now)[,:]? (?:the )?(?:five|5) (?:checks|calls|requests) (?:run|are|execute|are issued|are executed) (?:still )?(?:one after another|sequentially|sequential|in sequence|in series)\b/i.test(explanation)
        && !changedOrdering.test(text) && idpActive(q.question)
        && q.options.filter(o => idpActive(`${o.label}\n${o.description ?? ''}`)).some(o => {
          const option = idpCurrent(`${o.label}\n${o.description ?? ''}`);
          return /\bPromise\.all(?:Settled)?\b|\b(?:run|issue|launch|execute)\b[^.!?\n]*\b(?:concurrently|in parallel)\b/i.test(option)
            && /\bper[- ]call timeout\b|\btimeout (?:for|on) each call\b/i.test(option)
            && !/\b(?:no|without) (?:per[- ]call )?timeouts?\b|\btimeouts? (?:is |are |will be )?(?:disabled|omitted|removed|not enforced)\b/i.test(option)
            && !/\b(?:do not|don't|never) (?:add|use|enforce|set|apply) (?:a )?(?:per[- ]call )?timeout\b/i.test(option)
            && !/\b(?:keep|retain|leave|run|issue|execute)\b[^.!?\n]*\b(?:sequential(?:ly)?|one after another|in series)\b|\b(?:calls|checks|requests) (?:still |will |must )*(?:remain|stay) sequential\b|\b(?:do not|don't|never) (?:use Promise\.all(?:Settled)?|parallelize|parallelise)\b/i.test(option);
        })) ids.push('sequential-idp');
    // A later structure choice can reduce the current inventory again. Its
    // two options must enumerate the same retained services and differ by
    // exactly one unnecessary lifecycle class. Earlier decisions and the
    // cumulative before/after count are context, not evidence for this call.
    const identifiers = '([A-Z][A-Za-z0-9_]*(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*\\+\\s*)[A-Z][A-Za-z0-9_]*)+)';
    const namesIn = (list: string) => list.split(/,\s*(?:and\s+)?|\s+and\s+|\s*\+\s*/);
    const declared = new RegExp(`\\bplan (?:still )?(?:introduces|adds|contains|retains|has) ${identifiers}(?=\\s*(?:[.(;]|$))`, 'i').exec(metadata[0]!);
    const present = declared ? namesIn(declared[1]!) : [];
    const sameNames = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every(name => a.includes(name));
    const unsettled = '(?:reopened|deferred|pending|undecided|not required)';
    const settledStructure = (raw: string) => !new RegExp(`\\b${owner} (?:is|was|has been) ${unsettled}\\b`, 'i').test(current(raw.replace(
      new RegExp(`(${owner} (?:is|was|has been) )["“'‘\\x60](${unsettled})["”'’\\x60]`, 'gi'), '$1$2')));
    const structureOptions = q.options.map(o => `${o.label}\n${o.description ?? ''}`).filter(settledStructure).map(current).filter(active);
    const quotedClassField = q.question.split('\n').some(line => {
      const value = /^(?:ELI10|Project\/branch\/task):\s*(.+)$/.exec(line)?.[1]?.trim();
      return value && [['"','"'],["'","'"],['“','”'],['‘','’']].some(([open,close]) => value.startsWith(open!) && value.endsWith(close!));
    });
    // A structure comparison may spell out its counted alternatives in ELI10
    // and abbreviate the native labels. Join only matching option letters and
    // counts; both the smaller body and its own native option must reuse the
    // existing adapter. Earlier cuts do not supply this decision's reduction.
    const comparisonBodies = [...explanation.matchAll(/(?:^|\s)([A-D])\)\s*([\s\S]*?)(?=\s+[A-D]\)|$)/g)];
    const comparison = structureOptions.flatMap(option => {
      const label = /^([A-D])\)\s*(one|two|three|[1-9]\d*) (?:classes|services?)\b/i.exec(option);
      const bodies = comparisonBodies.filter(body => body[1] === label?.[1]);
      const body = bodies.length === 1 ? bodies[0]![2]! : '';
      const bodyCount = /^(one|two|three|[1-9]\d*) (?:classes|services?)\s*:/i.exec(body)?.[1];
      const number = (value: string) => counts[value.toLowerCase()] ?? Number(value);
      return label && bodyCount && number(label[2]!) === number(bodyCount)
        ? [{ count: number(bodyCount), body, option }] : [];
    });
    if (/\b(?:class|component|module) (?:arrangement|structure)\b/i.test(title) && settledStructure(q.question) &&
        /\b(?:same|unchanged) features\b/i.test(explanation) && /\bheld fixed\b/i.test(explanation) &&
        !/\bAuthCache (?:now |already )?(?:has|provides|adds) (?:independent|distinct|new) (?:behavior|rules|policy)\b|\b(?:smaller|reduced) arrangement changes (?:the )?accepted feature choices\b/i.test(text) &&
        comparison.some(choice => choice.count === 3 && /\bAuthCache facade\b/.test(choice.option.split('\n')[0]!) &&
          ['AuthBroker', 'SessionMint', 'AuthCache'].every(name => new RegExp(`\\b${name}\\b`).test(choice.body)) &&
          /\bAuthCache as (?:the |one )*facade over the existing adapter\b/i.test(choice.body)) &&
        comparison.some(choice => choice.count === 2 && /\b(?:drop|remove|cut) (?:the )?AuthCache facade\b/i.test(choice.body) &&
          /\bboth services (?:call|use) the existing adapter directly\b/i.test(choice.body) &&
          /\bservices (?:use|call) (?:the )?(?:existing )?adapter directly\b/i.test(choice.option) &&
          !/\b(?:keep|retain|restore) (?:the )?AuthCache facade\b|\b(?:do not|don't|never) (?:drop|remove|cut) (?:the |AuthCache )?facade\b|\b(?:replace|remove|drop) the existing adapter\b|\b(?:other|another|foreign|different) (?:function|method|issue|project|remedy)\b/i.test(`${choice.body}\n${choice.option}`))) ids.push('complexity');

    // Flattening can preserve a throwing API: each formerly swallowed class
    // becomes a typed failure and is rethrown. The question owns the current
    // catch defect; exhaustive conversion and propagation belong to one option.
    if (/\bvalidateAndDispatch\(\)/.test(title) && settledStructure(q.question) &&
        /\b(?:three|3) nested (?:try\/catch|catch) blocks\b[^.!?]*\b(?:each|every) catch (?:quietly|silently) (?:eats?|swallows?|suppresses?|discards?) (?:one kind of error|a different error class)\b/i.test(explanation) &&
        !/\bvalidateAndDispatch\(\) (?:now |already )?(?:rethrows every error|no longer swallows failures)\b/i.test(text) &&
        structureOptions.some(option => /^(?:[A-D][):.]\s*)?(?:Flatten|Split)\b/i.test(option) &&
          /\btyped [A-Z][A-Za-z0-9_]*\b/.test(option) && /\b(?:rethrow|propagate)\b/i.test(option.split('\n')[0]!) &&
          /\b(?:Each|Every|All) (?:former |previously )?(?:swallowed )?(?:error |failure )?class(?:es)? (?:becomes?|maps? to) a typed (?:error|failure)\b/i.test(option) &&
          /\b(?:sequential|linear) named steps\b/i.test(option) &&
          !/\b(?:do not|don't|does not|doesn't|never|will not|won't) (?:rethrow|propagate|surface|expose)\b|\b(?:not (?:every|all|each)|only some) (?:(?:known|former|previously|swallowed)\s+)*(?:(?:errors?|failures?)(?: classes?| class)?|classes|class)\b|\b(?:errors?|failures?) (?:are |is |will be |still |silently )*(?:swallowed|ignored|discarded|suppressed|hidden)\b|\b(?:other|another|foreign|different) (?:function|method|issue|project|remedy)\b/i.test(option))) ids.push('swallowed-errors');
    // A current store-consolidation choice may follow a separate feature cut.
    // Its own counted inventory and opposed keep/remove options establish the
    // reduction; neither the earlier approval nor the cumulative count does.
    const inventories = [...explanation.matchAll(new RegExp(`\\bplan (?:still )?(?:adds|contains|retains|has) (one|two|three|four|five|six|seven|eight|nine|[1-9]\\d*) (?:new )?(?:components|classes|things):\\s*${identifiers}\\.`, 'gi'))];
    const currentInventory = inventories.length === 1 ? inventories[0] : undefined;
    const inventoryNames = currentInventory ? namesIn(currentInventory[2]!) : [];
    const inventoryCount = currentInventory ? counts[currentInventory[1]!.toLowerCase()] ?? Number(currentInventory[1]) : 0;
    const ownedStoreChoice = /\b(?:arrangement|arranged|structure|components?|classes?)\b/i.test(title);
    const independentStore = /\bTokenStore (?:now |already )?(?:has|requires|provides) (?:a documented |an? )?(?:independent|distinct|separate) (?:persistence )?(?:purpose|behavior|state|contract)\b|\bTokenStore is (?:no longer|not) (?:redundant|a duplicate)\b/i;
    // Removing one undefined class is also a complexity decision. Its own
    // counted baseline and one complete removal/retained-store alternative
    // establish the reduction, without borrowing a later inventory summary.
    const candidateScope = /\bTokenStore\b/.test(title) && /\b(?:this|the current) (?:PR|refactor)\b/i.test(title) &&
      /\b(?:keep|include|retain|stay)\b/i.test(title) && /\b(?:defer(?:red)?|cut|remove|drop)\b/i.test(title);
    if (candidateScope) {
      if (quotedClassField) return [];
      const listed = /\bplan (?:lists|includes) TokenStore as one of (one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new classes\b/i.exec(explanation);
      const metadataCounts = [...metadata[0]!.matchAll(/\b[1-9]\d* files, (one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new classes\b/gi)];
      const currentCounts = [...(listed ? [listed[1]!] : []), ...metadataCounts.map(m => m[1]!)].map(n => counts[n.toLowerCase()] ?? Number(n));
      const count = metadataCounts.length <= 1 && currentCounts.length && new Set(currentCounts).size === 1 ? currentCounts[0]! : 0;
      const removedAlready = /\bTokenStore (?:is |has been )?(?:already |now )?(?:removed|cut|dropped|deferred|not included|no longer included) (?:from|in) (?:this |the )?(?:PR|refactor)\b/i;
      const alternative = structureOptions.some(option => {
        const [label, ...rest] = option.split('\n'), description = rest.join('\n');
        const countedDrops = [...description.matchAll(/\b(?:removes?|drops?|cuts?) one of (?:the )?(one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new classes\b/gi)];
        const countedDrop = countedDrops[0];
        return /^(?:[A-D][):.]\s*)?(?:Defer|Cut|Remove|Drop)(?: TokenStore)?(?: entirely)?(?: \(recommended\))?$/i.test(label!) &&
          countedDrops.length <= 1 && (!countedDrop || (counts[countedDrop[1]!.toLowerCase()] ?? +countedDrop[1]!) === count) &&
          (/\b(?:removes?|drops?|cuts?) (?:an? undefined |this |the )class from (?:this |the )?PR\b/i.test(description) ||
            /\bone fewer (?:file\/class|class(?: and file)?)\b/i.test(description) || countedDrop && (counts[countedDrop[1]!.toLowerCase()] ?? +countedDrop[1]!) === count) &&
          /\badapter remains the (?:single|only) source of truth for (?:cached )?tokens\b|\btoken storage is the adapter's job\b|\b(?:one|single) token source of truth: (?:the )?retained adapter behind (?:the )?AuthCache facade\b/i.test(description) &&
          !/\b(?:do not|don't|never|does not|doesn't|will not|won't) (?:removes?|drops?|cuts?)\b|\bnot one fewer (?:file\/class|class(?: and file)?)\b/i.test(description) &&
          !/\bTokenStore (?:still |now |will )*(?:remains?|stays?|is retained) in (?:this |the )?(?:PR|refactor)\b|\b(?:keep|retain|include) TokenStore in (?:this |the )?(?:PR|refactor)\b/i.test(option) &&
          !/\b(?:not (?:one|a single)|no single) token source of truth\b|\b(?:replace|remove|drop|change) (?:the )?(?:existing|retained) adapter\b|\b(?:also|then|while|and) (?:add(?:ing)?|creat(?:e|ing)|implement(?:ing)?|install(?:ing)?|enabl(?:e|ing)|disabl(?:e|ing)|deploy(?:ing)?)\b|\b(?:other|another|foreign|different) (?:project|remedy|option)\b/i.test(option);
      });
      return count > 1 && settledStructure(q.question) && !independentStore.test(text) && !removedAlready.test(text) &&
        /\bnever (?:says|states|describes) (?:what it does|its (?:purpose|responsibility|contract))\b|\bhas no (?:stated|defined|documented) (?:purpose|responsibility|contract)\b|\bTokenStore(?: \(PLAN\.md:[1-9]\d*(?:[-–][1-9]\d*)?\))? without (?:saying|stating|describing) what it stores that the adapter does not\b/i.test(explanation) &&
        /\bexisting (?:cache )?adapter (?:already )?(?:stores|holds) tokens\b/i.test(explanation) &&
        (/\bhandles (?:expiry and invalidation|invalidation and expiry)\b/i.test(explanation) || /\bevicts expired\b/i.test(explanation) && /\binvalidates on\b/i.test(explanation)) &&
        structureOptions.some(option => /^(?:[A-D][):.]\s*)?(?:Include|Keep|Retain)(?: TokenStore)?(?: \(recommended\))?\n/i.test(option) &&
          !/\b(?:remove|drop|cut|defer) TokenStore\b/i.test(option.split('\n').slice(1).join('\n'))) && alternative ? ['complexity'] : [];
    }
    // Named service groups are still an explicit inventory: expand only a
    // counted group whose names match its count, then check the total. Keep the
    // smaller count and direct-adapter action in the same offered option.
    const groupedInventories = [...explanation.matchAll(/\bplan (?:still )?(?:adds|introduces|contains|has) (one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new (?:types|classes|components): ([^.]+)\./gi)];
    const grouped = groupedInventories.length === 1 ? groupedInventories[0] : undefined;
    if (grouped && /\bAuthCache\b/.test(title) && /\bfacade\b/i.test(title) && ownedStoreChoice) {
      const total = counts[grouped[1]!.toLowerCase()] ?? +grouped[1]!;
      let valid = true;
      const expanded = grouped[2]!.replace(/(one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) services \(([^)]+)\)/gi, (_, n, list) => {
        const names = namesIn(list); if (names.length !== (counts[n.toLowerCase()] ?? +n) || new Set(names).size !== names.length) valid = false;
        return list;
      });
      const names = namesIn(expanded);
      const independentFacade = /\bAuthCache (?:now |already )?(?:adds|provides|has) (?:independent|distinct|new) (?:behavior|rules|policy)|\bAuthCache is no longer (?:a )?(?:pass-through|pure forwarder|thin wrapper)\b/i;
      const lower = structureOptions.some(option => {
        const [label, ...rest] = option.split('\n'), description = rest.join('\n');
        const deltas = [...description.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new (?:types|classes|components) instead of (one|two|three|four|five|six|seven|eight|nine|[1-9]\d*)\b/gi)], delta = deltas[0];
        return /^(?:[A-D][):.]\s*)?(?:Drop|Remove|Cut) (?:the |AuthCache )?facade, (?:use|call) (?:the )?(?:existing )?adapter directly(?: \(recommended\))?$/i.test(label!) && deltas.length === 1 && delta &&
          (counts[delta[1]!.toLowerCase()] ?? +delta[1]!) === total - 1 && (counts[delta[2]!.toLowerCase()] ?? +delta[2]!) === total &&
          /\badapter's existing tests\b/i.test(description) && /\btwo services\b[^.!?]*\badapter calls\b/i.test(description) &&
          !/\b(?:do not|don't|never|does not|doesn't|will not|won't) (?:drops?|removes?|cuts?|uses?|calls?)\b|\b(?:not|never) (?:one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new (?:types|classes|components)\b|\b(?:keep|retain|restore) (?:the )?(?:AuthCache )?facade\b|\bAuthCache (?:still |now |will )*(?:remains?|stays?|is retained)\b|\b(?:replace|remove|drop|change) (?:the )?(?:existing|retained) adapter\b|\b(?:also|then|while|and) (?:add(?:ing)?|creat(?:e|ing)|implement(?:ing)?|install(?:ing)?|enabl(?:e|ing)|disabl(?:e|ing)|deploy(?:ing)?)\b|\b(?:other|another|foreign|different) (?:project|remedy|option)\b/i.test(option);
      });
      const kept = structureOptions.some(option => {
        if (!/^(?:[A-D][):.]\s*)?(?:Keep|Retain) AuthCache facade(?: \(recommended\))?\n/i.test(option) ||
            /\b(?:drop|remove|cut) (?:the |AuthCache )?facade\b/i.test(option.split('\n').slice(1).join('\n'))) return false;
        const carries = [...option.matchAll(/\bcarrying (one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new (?:ones|types|classes)\b/gi)];
        return carries.every(m => (counts[m[1]!.toLowerCase()] ?? +m[1]!) + (/\bone more type\b/i.test(option) ? 1 : 0) === total);
      });
      if (!quotedClassField && valid && total > 2 && names.length === total && new Set(names).size === total &&
          ['AuthBroker','SessionMint','AuthCache'].every(name => names.includes(name)) && settledStructure(q.question) &&
          /\bAuthCache (?:is |is described as )?(?:a )?facade over the existing (?:cache )?adapter\b/i.test(explanation) &&
          /\b(?:adds no behavior|no new behavior)\b/i.test(explanation) && /\b(?:thin wrapper|pass-through|pure forwarder)\b/i.test(explanation) && !independentFacade.test(text) &&
          kept && lower) ids.push('complexity');
    }
    const repeatedStore = /\bTokenStore (?:is never (?:described|specified|defined)|has no (?:stated|defined|documented) (?:purpose|responsibility|contract))\b/i.test(explanation)
      && /\b(?:its name|TokenStore(?:'s)? (?:name|role)) (?:says it does what the adapter already does|duplicates (?:the )?(?:existing )?adapter's (?:job|role|responsibility))\b/i.test(explanation);
    const changedStore = /\bTokenStore (?:does not|doesn't|no longer) duplicates? (?:the )?(?:existing )?adapter\b/i;
    if (ownedStoreChoice && settledStructure(q.question) && !changedStore.test(text) && inventoryCount === 4 &&
        sameNames(inventoryNames, ['AuthBroker', 'SessionMint', 'AuthCache', 'TokenStore']) &&
        /\bAuthCache (?:is|is described as) a facade over the existing (?:cache )?adapter\b/i.test(explanation) &&
        /\badapter\b[^.!?]*\balready (?:stores tokens|keys, expires and invalidates tokens)\b/i.test(explanation) &&
        (/\bTokenStore (?:is |a |makes |becomes )*(?:a )?(?:third layer doing the adapter's job|redundant (?:token )?store|duplicate (?:token )?store)\b/i.test(explanation) ||
          repeatedStore) &&
        !independentStore.test(text) &&
        structureOptions.some(option => {
          if (new RegExp(`^(?:[A-D][):.]\\s*)?(?:${inventoryCount}|four) (?:components|classes):\\s*(?:keep|retain) TokenStore separate\\b`, 'i').test(option)) return true;
          const kept = new RegExp(`^(?:[A-D][):.]\\s*)?(?:${inventoryCount}|four) (?:components|classes)(?: as planned)?:\\s*${identifiers}(?:\\n|$)`, 'i').exec(option);
          return kept && sameNames(namesIn(kept[1]!), inventoryNames);
        }) &&
        structureOptions.some(option => {
          const head = option.split('\n')[0]!;
          const match = new RegExp(`^(?:[A-D][):.]\\s*)?(three|3) (?:components|classes):\\s*${identifiers}(?:;\\s*(?:drop|remove|fold) TokenStore\\b| \\((?:fold|merge) TokenStore into AuthCache\\)(?: \\((?:recommended|optional)\\))?$)`, 'i').exec(head);
          return match && sameNames(namesIn(match[2]!), ['AuthBroker', 'SessionMint', 'AuthCache']) &&
            (/\bAuthCache facade\s*\+\s*existing adapter is the single token store\b/i.test(option) ||
              /\b(?:Exactly )?one (?:place|facade) owns tenant-key construction and invalidation(?: calls)? (?:on top of|over) the existing adapter\b/i.test(option)) &&
            !/\b(?:never|does not|doesn't|will not|won't) (?:folds?|drops?|removes?|merges?|consolidates?) TokenStore\b|\b(?:replace|remove|drop) the existing adapter\b|\b(?:other|another|foreign|different) (?:function|method|issue|project|remedy)\b/i.test(option) &&
            !/\b(?:no|not a) single (?:place|facade) owns (?:tenant-key construction|invalidation)\b|\b(?:also|then|while|and) (?:add(?:ing)?|creat(?:e|ing)|implement(?:ing)?|install(?:ing)?|enabl(?:e|ing)|disabl(?:e|ing)|deploy(?:ing)?)\b/i.test(option) &&
            !independentStore.test(option) && !/\b(?:keep|retain|leave) TokenStore (?:as )?(?:a )?(?:separate|second|independent) (?:token )?(?:store|class|component)\b/i.test(option) &&
            !/\b(?:do not|don't|never) (?:drop|remove|fold|merge|consolidate) TokenStore\b|\bTokenStore (?:still |now |will )*(?:remains?|stays?|is retained as) (?:a )?(?:separate|second|independent) (?:token )?(?:store|class|component)\b/i.test(option);
        })) ids.push('complexity');

    // The same owned choice can expose known failures as a typed result and
    // propagate unknown failures without prescribing a particular catch layout.
    // Naming an error type alone, or a remedy in another option, is insufficient.
    const eatsErrors = /\b(?:three|3) nested (?:try\/catch|catch) blocks each (?:quietly|silently) (?:eat|swallow|suppress|discard|ignore) (?:one kind of error|one error class|a different error class)\b/i.test(explanation);
    if (/\bvalidateAndDispatch\(\)(?=\s|[.,?!;:]|$)/.test(title) && eatsErrors && settledStructure(q.question) &&
        /\bvalidate\(\) returns a typed result\b/i.test(explanation) &&
        /\bdispatch\(\) branches on that result\b/i.test(explanation) &&
        !/\bvalidateAndDispatch\(\) (?:now |already )?(?:rethrows every error|no longer swallows failures)\b/i.test(text) &&
        structureOptions.some(option => /\b(?:Split|Flatten)\b/i.test(option.split('\n')[0]!) &&
          /\bvalidate\(\)/.test(option) && /\bdispatch\(\)/.test(option) && /\btyped [A-Za-z]\w*\b/.test(option) &&
          /\bEvery known error class becomes a visible outcome\b/i.test(option) &&
          /\bUnknown (?:errors|failures) (?:propagate|are rethrown)\b/i.test(option) &&
          !/\b(?:not (?:every|all|each)|only some) (?:known )?(?:errors?|failures?)(?: classes?| class)?\b|\b(?:errors?|failures?) (?:are |is |will be |still |silently )*(?:swallowed|ignored|discarded|suppressed|hidden)\b|\b(?:do not|don't|never) (?:propagate|rethrow|surface|expose)\b|\b(?:other|another|foreign|different) (?:function|method|issue|project|remedy)\b/i.test(option))) ids.push('swallowed-errors');

    const counted = structureOptions.map(option => {
      const heading = option.split('\n')[0]!;
      const match = new RegExp(`^(?:[A-D][):.]\\s*)?(?:(?:Keep|Retain|Use|Reduce to)\\s+)?(one|two|three|four|five|six|seven|eight|nine|[1-9]\\d*) (?:new )?(?:units|classes|components)(?::\\s*|\\s*\\(\\s*)${identifiers}`, 'i').exec(heading);
      if (!match) return;
      const count = counts[match[1]!.toLowerCase()] ?? Number(match[1]);
      const names = namesIn(match[2]!);
      return count === names.length && new Set(names).size === count ? { option, names, count } : undefined;
    }).filter((choice): choice is { option: string; names: string[]; count: number } => Boolean(choice));
    const lifecycleUnits = ['AuthBroker', 'SessionMint', 'AuthCache'];
    const statefulPolicy = /\bRequestPolicy (?:now |already )?(?:has|requires) (?:its own |an? independent |an? )?(?:lifecycle|mutable state|independent behavior)\b/i;
    if (/\b(?:class(?:es)?|modules?|arrangement|structure|units|components|inventory)\b/i.test(title)
        && sameNames(present, [...lifecycleUnits, 'RequestPolicy'])
        && /\bRequestPolicy\b[^.!?]*\bclass\b[^.!?]*\blifecycle\b/i.test(explanation)
        && /\bclass (?:adds|creates|requires|brings) (?:ceremony|complexity|a lifecycle)\b/i.test(explanation)
        && !statefulPolicy.test(text) && settledStructure(q.question)
        && counted.some(choice => sameNames(choice.names, present) && /\bRequestPolicy class\b/i.test(choice.option))
        && counted.some(choice => sameNames(choice.names, lifecycleUnits)
          && /\bRequestPolicy (?:as|becomes|is expressed as|is replaced (?:by|with)) (?:an? )?(?:(?:plain|immutable|typed|data|value)\s+)+(?:type|value|config)\b/i.test(choice.option)
          && /\bpure function\b/i.test(choice.option)
          && !statefulPolicy.test(choice.option)
          && !/\b(?:do not|don't|never) (?:convert|demote|make|turn|replace)\b|\bnot (?:an? )?(?:plain|immutable|pure|stateless)\b|\bRequestPolicy (?:is |will be |still |now )*(?:remains?|stays?|retains?|requires?) (?:an? |its )?(?:class|lifecycle|mutable state)\b|\bRequestPolicy (?:(?:is|will be|now|still|already|remains|stays)\s+)+(?:an? )?(?:class|stateful|mutable)\b/i.test(choice.option))) ids.push('complexity');
    // Validate subject, current defect and one complete offered remedy as
    // separate facts. Sentence order and a particular result type are not
    // evidence; the native brief's owned PLAN.md references are.
    const namedComponents = ['AuthBroker', 'SessionMint', 'AuthCache', 'TokenStore', 'RequestPolicy'];
    const inventory = /\b(?:plan (?:adds|builds|introduces)|introducing) (one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) new (?:classes|types|units|components|pieces|building blocks)\b/i.exec(explanation);
    const before = inventory ? (counts[inventory[1]!.toLowerCase()] ?? Number(inventory[1])) : 0;
    const tokenOverlap = /\bTokenStore\b[^.!?]*\b(?:second layer|duplicate|redundant)\b/i.test(explanation)
      || /\bTokenStore (?:is )?(?:never described|undefined|has no stated responsibility)\b/i.test(explanation)
        && /\b(?:two|both) (?:new )?(?:things|components|classes|stores)\b[^.!?]*\b(?:same data|token state|store tokens)\b/i.test(explanation);
    if (/\b(?:structure|units|components|classes|decomposition)\b/i.test(title) && before === namedComponents.length &&
        namedComponents.every(name => new RegExp(`\\b${name}\\b`).test(subject)) && tokenOverlap &&
        /\bAuthCache\b[^.!?]*\b(?:one|same|existing|already have)\b[^.!?]*\b(?:backing cache|adapter)\b|\bAuthCache\b[^.!?]*\b(?:backing cache|adapter)\b[^.!?]*\b(?:existing|already have)\b/i.test(explanation) &&
        !/\bTokenStore (?:now |already )?has (?:a documented )?(?:independent|distinct) (?:purpose|behavior|state)\b/i.test(text) &&
        options.some(option => {
          const count = /\b([1-9]\d*) new classes\s*\(([^)]+)\)/.exec(option);
          const retained = count?.[2]?.split(/,\s*/) ?? [];
          const removesStore = /\b(?:Fold|Remove|Drop|Inline|Combine|Merge) TokenStore\b|\bAuthCache\s*\(absorbs TokenStore\)/i.test(option);
          const valuePolicy = /\brequestPolicy(?:\.ts)?\b[^.!?\n]*\bpure functions?\b|\bRequestPolicy (?:as|becomes) (?:a )?(?:typed value|config)\b/i.test(option);
          const oneStore = /\b(?:one|single) token layer over the existing adapter\b|\b(?:one|single) owner for (?:cached )?token state\b[^\n]*\bno second store\b/i.test(option);
          return /^(?:[A-D][):.]\s*)?(?:Fold|Remove|Drop|Inline|Combine|Consolidate|Merge|Reduce)\b/i.test(option) &&
            removesStore && valuePolicy && oneStore &&
            !/\b(?:second|duplicate) (?:token )?store (?:still |now |also )?(?:exists|remains|is retained|will remain)\b/i.test(option) &&
            ['AuthBroker', 'SessionMint', 'AuthCache'].every(name => new RegExp(`\\b${name}\\b`).test(option)) &&
            (!count || Number(count[1]) === before - 2 && retained.length === Number(count[1]) && new Set(retained).size === retained.length &&
              ['AuthBroker', 'SessionMint', 'AuthCache'].every(name => retained.includes(name)));
        })) ids.push('complexity');
    const sharedObject = /\b(?:one|same|shared) cache (?:object|instance)\b/i.test(explanation)
      && /\bboth services\b[^.!?]*\b(?:cache|import|mutate|change)\b/i.test(explanation);
    if (['AuthBroker', 'SessionMint', 'AuthCache'].every(name => title.includes(name)) && sharedObject &&
        /\b(?:top of a module|module[- ]level|global variable)\b/i.test(explanation) &&
        /\b(?:same object|shared mutable state|invisible shared state|can change it)\b/i.test(explanation) &&
        !/\b(?:cache|services|writers) (?:is |are |now |already )*(?:isolated|injected|no longer shared)\b/i.test(text) &&
        options.some(option => /^(?:[A-D][):.]\s*)?(?:Constructor injection|Inject\b)/i.test(option) &&
          /\b(?:one|single) AuthCache\b|\bAuthCache once\b/i.test(option) && /\bcomposition root\b/i.test(option) &&
          /\b(?:passed|injected|pass|inject) to both (?:services|constructors)\b/i.test(option) &&
          /\btests?\b[^.!?\n]*\b(?:fresh|isolated|independent) (?:one|cache|instance|AuthCache)\b/i.test(option) &&
          !/\btests?\b[^.!?\n]*\b(?:(?:do not|don't|never) (?:get|receive|use|create|build) (?:a )?(?:fresh|isolated|independent) (?:one|cache|instance|AuthCache)|share (?:one|the same|a single) (?:cache|instance|AuthCache))\b/i.test(option))) ids.push('shared-cache');
    if (/\bvalidateAndDispatch\b/.test(title) &&
        /\b(?:catch(?:es)?|try\/catch blocks|catch blocks)\b[^.!?]*\b(?:swallows?|eats?|suppresses?|discards?|ignores?)\b[^.!?]*\berrors?\b/i.test(explanation) &&
        /\b(?:without passing it on|no log|silent|nothing is logged|nobody sees a log)\b/i.test(explanation) &&
        !/\bvalidateAndDispatch\(\) (?:now |already )?(?:rethrows every error|no longer swallows failures)\b/i.test(text) &&
        options.some(option => /\bvalidate\(\)/.test(option) && /\bdispatch\(\)/.test(option) &&
          !/\b(?:not (?:every|all|each)|only some) (?:errors?|failures?)(?: classes?)?\b|\b(?:errors?|failures?) (?:are |is |will be |still |silently )*(?:swallowed|ignored|discarded|suppressed)\b/i.test(option) &&
          /\b(?:single|one) (?:(?:try\/)?catch at the boundary|boundary catch)\b/i.test(option) &&
          (/\bAuthError subclasses\b/.test(option) && /\b(?:every|all) errors? (?:is |are )?logged and propagated\b/i.test(option)
            || /\bmap each error class to a typed [A-Za-z]\w*\b/i.test(option) && /\bfail closed\b/i.test(option)
              && /\b(?:every|all) failure class(?:es)?\b[^.!?\n]*\b(?:named|explicit)\b[^.!?\n]*\boutcome\b/i.test(option)
              && /\bnothing is (?:silently )?swallowed\b/i.test(option)))) ids.push('swallowed-errors');
  }
  return [...new Set(ids)];
}

function completedDecision(call: NativePlanQuestionCall, startedAt: number, finishedAt: number): boolean {
  const answeredAt = Date.parse(call.answeredAt ?? '');
  if (!call.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      !Number.isFinite(answeredAt) || answeredAt < startedAt || answeredAt > finishedAt ||
      call.questions.length < 1 || call.questions.length > 4 || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length !== 0) return false;
  return new Set(call.questions.map(q => q.question)).size === call.questions.length &&
    Object.keys(call.answers ?? {}).length === call.questions.length &&
    call.questions.every(q => q.question.trim() && !q.multiSelect && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every(o => o.label.trim()) && new Set(q.options.map(o => o.label)).size === q.options.length &&
    q.options.some(o => call.answers?.[q.question] === o.label));
}

/** The seeded case counts owned, completed native seed decisions. Saved brief
 * formatting belongs to the batching case; final seed/report assertions remain
 * the acceptance gate. No screenshot or arbitrary answered question earns credit. */
export function isEngSeedDecisionAUQ(fp: AskUserQuestionFingerprint,
  priorCalls: readonly NativePlanQuestionCall[] = [], startedAt = 0, finishedAt = Date.now()): boolean {
  const call = fp.nativeCall;
  if (!call || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt > finishedAt ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      priorCalls.some(prior => prior.sessionId !== call.sessionId || prior.toolUseId === call.toolUseId) ||
      !completedDecision(call, startedAt, finishedAt)) return false;
  // nativePlanCallFingerprint retains all answered tabs with per-tab indices.
  // Authenticate that complete shape before allowing one seed per whole call.
  const offered = call.questions.flatMap(q => q.options.map((o, i) => ({ index: i + 1, label: o.label })));
  if (fp.options.length !== offered.length || !fp.options.every((o, i) => o.index === offered[i]!.index && o.label === offered[i]!.label)) return false;
  const seeds = call.questions.flatMap(seedSubjects);
  return seeds.length === 1 && !priorCalls.some(prior => completedDecision(prior, startedAt, finishedAt) &&
    prior.questions.flatMap(seedSubjects).length === 1 && prior.questions.flatMap(seedSubjects)[0] === seeds[0]);
}

/** Structural eligibility for this distinct-issue counter, not seed quality. */
function batchingIssueNumber(call: NativePlanQuestionCall): string | undefined {
  if (!completedDecision(call, 0, Date.now()) || call.questions.length !== 1) return;
  const q = call.questions[0]!;
  const title = q.question.split('\n')[0]!;
  const legacy = /^(?:D[1-9]\d*\s*[—–:-]\s*)?Issue ([1-9]\d*)\s*:\s*\S[^\n]*$/i.exec(title)?.[1];
  let issue = legacy, currentOwner = legacy ? `Issue ${legacy}` : '';
  if (legacy) {
    if (!new RegExp(`^(?:Arch(?:itecture)?|Code quality|Tests?|Testing|Performance|Security)(?: ${legacy})?$`, 'i').test(q.header.trim())) return;
    const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[.):]\s+\S/i.exec(o.label));
    if (optionIds.some(id => id?.[1] !== legacy) || new Set(optionIds.map(id => id![2]!.toUpperCase())).size !== q.options.length) return;
  } else {
    // The current ledger uses stable R IDs and a new D number for each ask.
    // Earlier briefs may instead cite their current finding in task metadata.
    // Bind only that owned identity, never D alone or a later recap of others.
    const decision = /^D([1-9]\d*)\b/.exec(title);
    // D owns this ask. R can be shared by the title/header or live in the
    // header alone when this question names one current source document.
    const recordIds = [...prose(title, true).replace(/"[^"\n]*"|“[^”\n]*”/g, '').matchAll(/\bR[1-9]\d*\b/g)].map(match => match[0]);
    let recordId = recordIds.length === 1 ? recordIds[0] : undefined;
    const lines = prose(q.question, true).split('\n').filter(line => line.trim());
    const metadata = lines[1]?.replace(/"[^"\n]*"|“[^”\n]*”/g, '') ?? '';
    const explanation = (lines[2] ?? '').replace(/"[^"\n]*"|“[^”\n]*”/g, '');
    if (!decision || !/^Project\/branch\/task: \S/.test(metadata) || !/\bPLAN\.md\b/.test(metadata) ||
        lines.filter(line => /^Project\/branch\/task:/.test(line)).length !== 1 ||
        lines.filter(line => /^ELI10:/.test(line)).length !== 1 || !/^ELI10: \S/.test(explanation) ||
        /^ELI10:\s*(?:".*"|“.*”)\s*$/.test(lines[2] ?? '') ||
        /^ELI10: (?:source|quoted|historical|example|hypothetical)\b/i.test(explanation) ||
        /\b(?:copied|quoted|historical)\s+(?:(?:source|quoted)\s+)?(?:example|excerpt|text|material)\b/i.test(metadata) ||
        q.options.some(option => !prose(option.description ?? '', true).trim())) return;
    const finding = /(?:^|[,;]\s*)finding (F[1-9]\d*)\s*\(PLAN\.md:[1-9]\d*(?:[-–][1-9]\d*)?\)/i.exec(metadata)?.[1];
    if (recordIds.length > 1 || /\b(?:copied|quoted|historical|example|hypothetical)\b/i.test(title)) return;
    if (!recordId && !finding) {
      const header = q.header.trim();
      const ids = [...header.matchAll(/\bR[1-9]\d*\b/g)].map(match => match[0]);
      const sources = [...metadata.matchAll(/\b[\w./-]+\.md(?::[1-9]\d*(?:[-–][1-9]\d*)?)?\b/g)].map(match => match[0]);
      // This native form carries the complete tradeoff in each option.
      // Short aliases for a comparison in the question/report must keep using
      // the saved-ledger path; the header cannot replace that authority.
      const completeOptions = q.options.every(option => {
        const description = prose(option.description ?? '', true).replace(/"[^"\n]*"|“[^”\n]*”/g, '').trim();
        const blocks = [...description.matchAll(/([✅❌])\s*([^✅❌]+)/g)];
        return description.startsWith('✅') && blocks.every(block => /[A-Za-z0-9]/.test(block[2]!)) &&
          blocks.filter(block => block[1] === '✅').length >= 2 && blocks.some(block => block[1] === '❌');
      });
      if (!completeOptions || lines.some(line => /^(?:Options?:\s*)?[A-D][).:]\s+\S/.test(line))) return;
      // A bare D number, a quoted/foreign R, or an unrelated source mention
      // cannot supply identity. Native ACK/options and current-status checks
      // below remain the same as the title-owned route.
      if (ids.length !== 1 || !new RegExp(`^${ids[0]}(?:\\s+[A-Za-z]|\\s*[—–:-]\\s*[A-Za-z])`).test(header) ||
          /\bR[1-9]\d*\b/.test(title) || /[\r\n`"“”]/.test(header) ||
          [...title.matchAll(/\bD[1-9]\d*\b/g)].length !== 1 ||
          /\b(?:copied|quoted|historical|history|example|hypothetical|withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|not current|no longer current)\b/i.test(header) ||
          sources.length !== 1 || !/^PLAN\.md(?::[1-9]\d*(?:[-–][1-9]\d*)?)?$/.test(sources[0]!)) return;
      recordId = ids[0];
    }
    if (recordId) {
      const headerIds = [...q.header.matchAll(/\bR[1-9]\d*\b/g)].map(match => match[0]);
      if (!new RegExp(`^${recordId}\\b`).test(q.header.trim()) || headerIds.length !== 1 || headerIds[0] !== recordId) return;
      issue = `record:${recordId}`;
    } else if (finding) issue = `finding:${finding.toUpperCase()}`;
    else return;
    currentOwner = `${recordId ?? finding}|D${decision[1]}`;
  }
  // Owned scalar statuses remain current prose; a whole code example does not.
  const owner = `(?:(?:this|the|that) (?:issue|finding|decision)|${currentOwner})`;
  const statusPrefix = `(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?${owner} (?:is|was|has been) `;
  const scalarOwner = new RegExp(`${statusPrefix}$`, 'i');
  const text = q.question.replace(/`([^`\n]+)`/g, (span, body: string, at: number, source: string) =>
    scalarOwner.test(source.slice(0, at)) ? body : span);
  const inactive = new RegExp(`${statusPrefix}["“'‘]?(?:withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|hypothetical|not current|no longer current)\\b`, 'i');
  return inactive.test(prose(text, true)) ? undefined : issue;
}

/** Batching measures separate native issue decisions; seed quality is checked separately. */
export function isEngBatchingIssueAUQ(fp: AskUserQuestionFingerprint, priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
  const call = fp.nativeCall;
  if (!call || fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      priorCalls.some(prior => prior.sessionId !== call.sessionId || prior.toolUseId === call.toolUseId)) return false;
  const issue = batchingIssueNumber(call);
  if (!issue) return false;
  const q = call.questions[0]!;
  if (fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  // Re-asking an eligible issue cannot inflate the floor; setup and batches do not suppress later separate decisions.
  return !priorCalls.some(prior => batchingIssueNumber(prior) === issue);
}

/** A native brief can use its D number and topic while its stable R identity
 * lives in the required saved ledger. Count that owned choice, not a title
 * spelling. This does not approve the row or validate the implementation. */
function recordedBatchingIssue(call: NativePlanQuestionCall, savedPlan: string): string | undefined {
  const q = call.questions[0]!;
  const text = prose(q.question, true), lines = text.split('\n').filter(line => line.trim());
  const title = lines[0] ?? '', decision = /^D([1-9]\d*(?:\.[1-9]\d*)?)\s*[—–:-]\s+\S/.exec(title);
  const metadata = (lines[1] ?? '').replace(/"[^"\n]*"|“[^”\n]*”/g, ''), explanation = lines[2] ?? '';
  const source = /\bPLAN\.md:([1-9]\d*(?:[-–][1-9]\d*)?)\b/.exec(metadata)?.[1];
  if (!decision || !/^Project\/branch\/task: \S/.test(metadata) ||
      !/^ELI10: \S/.test(explanation) || /^ELI10:\s*(?:".*"|“.*”)\s*$/.test(explanation) ||
      /^(?:ELI10:\s*)?(?:source|quoted|historical|example|hypothetical)\b/i.test(explanation) ||
      lines.filter(line => /^Project\/branch\/task:/.test(line)).length !== 1 ||
      lines.filter(line => /^ELI10:/.test(line)).length !== 1 ||
      /\b(?:copied|quoted|historical|hypothetical)\b/i.test(metadata)) return;
  if (q.options.some(option => !prose(option.description ?? '', true).trim()) ||
      /\b(?:this|the|that) (?:issue|finding|decision) (?:is|was|has been) ["“'‘]?(?:withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|hypothetical|not current|no longer current)\b/i.test(text)) return;
  const clean = (s: string) => s.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  const tokens = marked.lexer(savedPlan);
  const ledgers = tokens.flatMap((t, i) => t.type === 'heading' && /^Decision ledger$/i.test(clean(t.text)) ? [i] : []);
  if (ledgers.length !== 1) return;
  const start = ledgers[0]!, heading = tokens[start]!;
  if (heading.type !== 'heading') return;
  const currentHeading = (at: number) => {
    const ancestors: Array<{ depth: number; text: string }> = [];
    for (const token of tokens.slice(0, at + 1)) if (token.type === 'heading') {
      while (ancestors.length && ancestors.at(-1)!.depth >= token.depth) ancestors.pop();
      ancestors.push(token);
    }
    return !ancestors.some(owner => /\b(?:copied|quoted|historical|history|example|hypothetical|template|archived|withdrawn|superseded)\b/i.test(clean(owner.text)));
  };
  if (!currentHeading(start)) return;
  // A named plan may inherit its file identity only from this report's one
  // current target declaration and matching title, never from quoted examples.
  const sourceNames = [...metadata.matchAll(/\b[\w./-]+\.md\b/g)].map(match => match[0]);
  const rawSourceNames = [...(lines[1] ?? '').matchAll(/\b[\w./-]+\.md\b/g)];
  const directSource = sourceNames.length > 0 && sourceNames.every(name => name === 'PLAN.md') &&
    new Set([...metadata.matchAll(/\bPLAN\.md:([1-9]\d*(?:[-–][1-9]\d*)?)\b/g)].map(match => match[1])).size <= 1;
  const targetName = (s: string) => clean(s).replace(/^Eng(?:ineering)? review:\s*/i, '')
    .replace(/^Plan\s*[:—–-]\s*/i, '').toLowerCase();
  const named = [...(lines[1] ?? '').matchAll(/"(Plan:\s*[^"\n]+)"|“(Plan:\s*[^”\n]+)”/g)]
    .map(match => targetName(match[1] ?? match[2]!));
  const titles = tokens.slice(0, start).filter(token => token.type === 'heading' && token.depth === 1);
  const targetFields = tokens.slice(0, start).flatMap((token, at) => {
    if (token.type !== 'paragraph' || !currentHeading(at)) return [];
    const previous = tokens.slice(0, at).filter(t => t.type !== 'space').at(-1);
    const quotedContext = /\b(?:quoted|copied|historical|example|hypothetical|archived)\b[^\n]*:\s*$/i;
    if (previous?.type === 'paragraph' && quotedContext.test(previous.raw)) return [];
    const parts = token.raw.split('\n');
    return parts.filter((line, i) => /^Reviewed target:/.test(line) &&
      !parts.slice(0, i).some(part => quotedContext.test(part)));
  });
  const namedSource = !rawSourceNames.length && named.length === 1 && titles.length === 1 &&
    titles[0]!.type === 'heading' && currentHeading(tokens.indexOf(titles[0]!)) &&
    /^Eng(?:ineering)? review:\s*Plan\s*[:—–-]/i.test(clean(titles[0]!.text)) &&
    targetName(titles[0]!.text) === named[0] && targetFields.length === 1 &&
    /^Reviewed target:\s*`?PLAN\.md`?(?:\s|$)/.test(targetFields[0]!) &&
    [...targetFields[0]!.matchAll(/\b[\w./-]+\.md\b/g)].length === 1;
  if (!directSource && !namedSource) return;
  const withdrawn = (value: string, owners: string) => new RegExp(
    `(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?(?:${owners}) (?:is|was|has been) ["“'‘]?(?:withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|hypothetical|not current|no longer current)\\b`, 'i').test(prose(value, true));
  const decisionOwner = `D${decision[1].replace('.', '\\.')}`;
  if (withdrawn(q.question, decisionOwner)) return;
  const previous = tokens.slice(0, start).filter(t => t.type !== 'space').at(-1);
  if (previous && /\b(?:copied|quoted|historical|example|hypothetical|template)\b.*[:：]\s*$/i.test(previous.raw)) return;
  // Records may continue in the current Architecture/Code quality/Tests/Performance
  // sections. Their typed fields own the choice; the ledger need not be contiguous.
  const end = tokens.findIndex((token, at) => at > start && token.type === 'heading' && /^GSTACK REVIEW REPORT$/i.test(clean(token.text)));
  const recordEnd = end < 0 ? tokens.length : end;
  const recordSection = (at: number, depth: number) => {
    const owner = tokens.slice(0, at).filter(token => token.type === 'heading' && token.depth < depth).at(-1);
    if (!owner || owner.type !== 'heading') return false;
    const name = clean(owner.text).replace(/^(?:Section\s+)?[1-9]\d*[.:]?\s*/i, '');
    return /^Decision ledger$/i.test(name) || /^(?:Architecture|Code quality|Tests?|Testing|Performance) review$/i.test(name);
  };
  const words = (s: string) => (clean(s).toLowerCase().replace(/\(recommended\)/g, '').match(/[a-z][a-z0-9_]*/g) ?? [])
    .filter(word => !['the', 'a', 'an', 'and', 'or', 'with', 'to', 'of', 'as', 'is', 'it', 'one', 'first', 'now', 'option', 'recommended', 'planned'].includes(word));
  const captionWords = (s: string) => words(s.replace(/['’]s\b/g, '')).filter(word =>
    !['by', 'on', 'at', 'per', 'then', 'only', 'what', 'how', 'should', 'does', 'each', 'every'].includes(word))
    .map(word => word.length > 4 && /ies$/.test(word) ? word.slice(0, -3) + 'y'
      : word.length > 3 && /s$/.test(word) && !/ss$/.test(word) ? word.slice(0, -1) : word);
  const inlineLabelScore = (native: string, saved: string) => {
    const modifiers = (s: string) => s.replace(/\b([a-z][a-z0-9_]*)-keyed\b/gi, 'keyed by $1');
    const left = captionWords(modifiers(native)), right = captionWords(modifiers(saved));
    const negated = (ws: string[]) => ws.some(word => ['no', 'not', 'never', 'without', 'dont'].includes(word));
    // Normalize the keyed modifier, then preserve action/operand order. A
    // caption cannot swap the source and destination of the same operation.
    if (left.length < 2 || right.length < 2 || left[0] !== right[0] || negated(left) !== negated(right)) return 0;
    let cursor = 0;
    for (const word of left) {
      const at = right.indexOf(word, cursor);
      if (at < 0) return 0;
      cursor = at + 1;
    }
    return left.length / right.length;
  };
  const labelScore = (native: string, saved: string) => {
    const normalize = (s: string) => clean(s).replace(/^[A-D][).:]\s+/, '')
      .replace(/\s*\(recommended\)/gi, '').toLowerCase()
      // Both captions defer this choice. An appended implementation action
      // is not part of the equivalence.
      .replace(/^(?:decide at|leave to) implementation(?: time)?$/, 'defer to implementation');
    if (normalize(native) === normalize(saved)) return 3;
    const left = words(normalize(native)), right = words(normalize(saved));
    const negated = (tokens: string[]) => tokens.some(word => ['no', 'not', 'never', 'without', 'dont'].includes(word));
    if (Math.min(left.length, right.length) < 2 || negated(left) !== negated(right)) return 0;
    if (normalize(saved).startsWith(normalize(native) + ' ')) return 2;
    // Native captions may abbreviate the saved caption, but cannot introduce
    // a different action. Every native content word must occur in order in
    // the saved label; a short abbreviation must retain its first letter.
    let cursor = 0, exact = 0;
    for (const word of left) {
      const found = right.findIndex((candidate, at) => at >= cursor && (candidate === word ||
        word.length >= 2 && word.length <= 3 && candidate.length > word.length && candidate[0] === word[0] &&
        new RegExp('^' + [...word].join('.*')).test(candidate)));
      if (found < 0) return 0;
      if (right[found] === word) exact++;
      cursor = found + 1;
    }
    return exact >= 2 ? left.length / right.length : 0;
  };
  const matches: string[] = [];
  for (let i = start + 1; i < recordEnd; i++) {
    const record = tokens[i]!;
    if (record.type !== 'heading') continue;
    const id = /^(R[1-9]\d*):\s+\S/.exec(clean(record.text))?.[1];
    if (!id || !currentHeading(i) || !recordSection(i, record.depth) || withdrawn(q.question, id)) continue;
    let stop = i + 1;
    while (stop < recordEnd && !(tokens[stop]!.type === 'heading' && (tokens[stop] as any).depth <= record.depth)) stop++;
    const body = tokens.slice(i + 1, stop);
    if (withdrawn(body.filter(t => t.type === 'paragraph').map(t => t.raw).join('\n'), `${id}|${decisionOwner}`)) continue;
    const paragraphs = body.filter(t => t.type === 'paragraph').map(t => t.raw);
    const fields = paragraphs.join('\n').split('\n').map(line => line.replace(/\*\*/g, '').trim());
    const field = (name: string) => fields.filter(line => line.startsWith(name + ':')).map(line => line.slice(name.length + 1).trim());
    const finding = field('Finding'), baseline = field('Plan baseline'), state = field('State');
    if (finding.length !== 1 || baseline.length !== 1 || !baseline[0] || state.length !== 1 ||
        !/^(?:pending|approved)$/i.test(state[0]!) ||
        /\b(?:copied|quoted|historical|example|hypothetical|withdrawn|superseded)\b/i.test(finding[0]!)) continue;
    const marker = `Question D${decision[1]}:`;
    const questions = fields.flatMap((line, at) => line.startsWith(marker) ? [at] : []);
    if (questions.length !== 1) continue;
    const inlineBrief = fields[questions[0]!]!.slice(marker.length).trim();
    const inline = Boolean(inlineBrief);
    if (!inline && (namedSource || clean(fields[questions[0]! + 1] ?? '') !== clean(title))) continue;
    const sources = [...finding[0]!.matchAll(/\b([\w./-]+\.md)(?::([1-9]\d*(?:[-–][1-9]\d*)?))?\b/g)];
    if (sources.length !== 1 || sources[0]![1] !== 'PLAN.md' ||
        !inline && !sources[0]![2] || source && sources[0]![2] !== source) continue;
    if (inline) {
      const topic = captionWords(`${record.text} ${inlineBrief.split('Options:')[0]}`);
      const nativeTopic = new Set(captionWords(`${q.header} ${title}`));
      const completeOptions = q.options.every(option => {
        const description = prose(option.description ?? '', true).replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, '').trim();
        const blocks = [...description.matchAll(/([✅❌])\s*([^✅❌]+)/g)];
        return description.startsWith('✅') && blocks.every(block => /[A-Za-z0-9]/.test(block[2]!)) &&
          blocks.filter(block => block[1] === '✅').length >= 2 && blocks.some(block => block[1] === '❌');
      });
      const sameId = tokens.slice(start + 1, recordEnd).filter(token => token.type === 'heading' &&
        new RegExp(`^${id}:`).test(clean(token.text)));
      if (!completeOptions || sameId.length !== 1 || new Set(topic.filter(word => nativeTopic.has(word))).size < 2 ||
          [...title.matchAll(/\bD[1-9]\d*(?:\.[1-9]\d*)?\b/g)].length !== 1 ||
          /["“'‘][^"”'’\n]*\b[\w./-]+\.md\b/.test(finding[0]!) ||
          /^(?:["“'‘`]|quoted\b|copied\b|historical\b|example\b|hypothetical\b)/i.test(inlineBrief)) continue;
    }
    // The source requires the complete brief, not a literal Options field.
    // Read option records only inside this Question block, before answer/history.
    // Code, quotations and foreign blocks never contribute saved option labels.
    const briefLines = body.flatMap(token => token.type === 'paragraph' ? token.raw.split('\n') :
      token.type === 'list' ? token.items.flatMap(item => item.tokens.filter(child => child.type === 'text' || child.type === 'paragraph').flatMap(child => child.raw.split('\n'))) : [])
      .map(line => line.replace(/\*\*/g, '').replace(/^\s*[-*+]\s+(?=[A-D][).:]\s)/, '').trim());
    const questionAt = briefLines.findIndex(line => line.startsWith(marker));
    if (questionAt < 0) continue;
    const remaining = inline ? [inlineBrief.includes('Options:') ? inlineBrief.slice(inlineBrief.indexOf('Options:')) : '',
      ...briefLines.slice(questionAt + 1)] : briefLines.slice(questionAt + 2);
    const boundary = remaining.findIndex(line => /^(?:Question D[1-9]\d*(?:\.[1-9]\d*)?|Finding|Plan baseline|Runtime evidence|State|Actual answer|Accepted scope|History):/.test(line));
    const brief = remaining.slice(0, boundary < 0 ? remaining.length : boundary);
    if (brief.some(line => /^(?:quoted|copied|historical|example|hypothetical|template)(?:\s+[^:]*)?:/i.test(line))) continue;
    const labels: Array<[string, string, string]> = [];
    for (const line of brief) {
      // Compact and expanded briefs use the same A-D records. Descriptions
      // remain prose; their mentions of options cannot define another label.
      const content = line.replace(/^Options:\s*/, '');
      if (!/^[A-D][).:]\s+\S/.test(content)) continue;
      for (const match of content.matchAll(/(?:^|\s)([A-D])[).:]\s+(.+?)(?=\s+[A-D][).:]\s+|$)/g))
        labels.push([match[0], match[1]!, match[2]!]);
    }
    if (labels.length !== q.options.length || labels.some((label, index) => label[1] !== String.fromCharCode(65 + index))) continue;
    const comparisons = body.filter(t => t.type === 'table').filter(table => {
      if (table.type !== 'table') return false;
      const headers = table.header.map(c => clean(c.text));
      const columnIds = headers.slice(2).map(header => /^([A-D])(?:[).:]?\s+\S.*)?$/.exec(header)?.[1]);
      // The role is Current; a baseline-context caption may qualify it. Do
      // not strip arbitrary parenthetical prose: historical/proposed/negated
      // values cannot masquerade as the current baseline column.
      const currentColumn = /^Current(?:\s+\((?:(?:approved|original) )?(?:plan(?: baseline)?|baseline|proposal)\))?$/i.test(headers[1] ?? '');
      if (headers[0] !== 'Choice' || !currentColumn ||
          JSON.stringify(columnIds) !== JSON.stringify(q.options.map((_, at) => String.fromCharCode(65 + at)))) return false;
      // R5a/R5b are dimensions of the one R5 decision, not extra asks. Keep
      // the record boundary and unique row identities; R50 is another issue.
      const rows = table.rows.filter(row => new RegExp(`^${id}(?:[a-z])?\\b`).test(clean(row[0]!.text)));
      const rowIds = rows.map(row => new RegExp(`^(${id}[a-z]?)\\b`).exec(clean(row[0]!.text))![1]);
      if (!rows.length || new Set(rowIds).size !== rowIds.length || rows.some(row => !row.every(cell => clean(cell.text)))) return false;
      const optionColumns = q.options.map(option => {
        const scores = labels.map((label, at) => {
          const direct = labelScore(option.label, label[2]!) || inline && inlineLabelScore(option.label, label[2]!);
          const caption = headers[at + 2]!.replace(/^[A-D][).:]?\s*/, '');
          const captionWords = words(caption), savedWords = words(label[2]!);
          const negated = (tokens: string[]) => tokens.some(word => ['no', 'not', 'never', 'without', 'dont'].includes(word));
          // A descriptive header belongs to its existing A/B/C option. It
          // cannot relabel a contradictory saved choice or lend another
          // column's action to a short native caption.
          const boundCaption = captionWords.filter(word => savedWords.includes(word)).length >= 2 &&
            negated(captionWords) === negated(savedWords);
          if (inline && !boundCaption && !rows.some(row => labelScore(label[2]!, row[at + 2]!.text) ||
              inlineLabelScore(label[2]!, row[at + 2]!.text))) return 0;
          const captionScore = boundCaption ? labelScore(option.label, caption) || inline && inlineLabelScore(option.label, caption) : 0;
          // Extra native detail must also exist in that option's saved grid
          // column; a shared caption cannot authorize an added action.
          const extendsCaption = clean(option.label).toLowerCase().startsWith(clean(label[2]!).toLowerCase() + ' ');
          return direct || captionScore || extendsCaption && Math.max(...rows.map(row => labelScore(option.label, row[at + 2]!.text))) || 0;
        });
        const best = Math.max(...scores);
        return best > 0 && scores.filter(score => score === best).length === 1 ? scores.indexOf(best) : -1;
      });
      return !optionColumns.includes(-1) && new Set(optionColumns).size === q.options.length;
    });
    if (comparisons.length === 1) matches.push(`record:${id}`);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Fixture-local identity memory prevents re-asks from inflating the floor,
 * even after a reopened row replaces its earlier saved question. */
export function createEngBatchingIssueCounter(readPlan: () => string,
  isSetup: (fp: AskUserQuestionFingerprint) => boolean) {
  const seen = new Set<string>();
  const trace: Array<{ signature: string; issue: string; source: 'native' | 'saved-ledger' }> = [];
  return {
    trace,
    isReviewAUQ(fp: AskUserQuestionFingerprint, priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
      const call = fp.nativeCall;
      if (!call || fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
          (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
          priorCalls.some(prior => prior.sessionId !== call.sessionId || prior.toolUseId === call.toolUseId) ||
          !completedDecision(call, 0, Date.now()) || call.questions.length !== 1 || isSetup(fp)) return false;
      const q = call.questions[0]!;
      if (fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
      const native = batchingIssueNumber(call);
      if (native && !isEngBatchingIssueAUQ(fp, priorCalls)) return false;
      const issue = native ?? recordedBatchingIssue(call, readPlan());
      if (!issue || seen.has(issue)) return false;
      seen.add(issue); trace.push({ signature: fp.signature, issue, source: native ? 'native' : 'saved-ledger' });
      return true;
    },
  };
}

/** A named required test can specify characterization without an "Add" prefix. */
function requiredLegacyCharacterization(task: string): boolean {
  const text = task.replace(/\s+/g, ' ');
  return /^legacyAuthFlow(?:\(\))?\s+(?:regression|characterization)\s+tests?\.\s+Before\s+(?:the\s+)?(?:rewrite|refactor|change),\s+(?:capture|pin|record)\s+(?:the\s+)?(?:current|existing|prior)\b[^.;!?]{0,240}\bbehavior\s+of\s+legacyAuthFlow(?:\(\))?\b[^.;!?]*\.\s+The\s+rewritten\s+(?:path|flow|implementation)\s+must\s+pass\s+the\s+same\s+assertions\./i.test(text)
    && !/["“”]|\b(?:not|never|skip\w*|defer\w*|maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(text)
    && !/\bno\s+(?:(?:regression|characterization)\s+)?(?:tests?|fixtures?)\s+(?:are\s+)?(?:needed|required)\b/i.test(text);
}

/** Required suites bind a numbered task to an untouched legacy baseline or parity oracle. */
function declaredLegacyCharacterization(text: string): boolean {
  const sections: Array<{ title: string; body: string[]; asserted: boolean }> = [];
  const owners: Array<{ level: number; asserted: boolean }> = [];
  let preamble = '', sourcePreamble = false;
  const sourceFrame = (body: string) => {
    const text = body.replace(/"[^"\n]*"|“[^”\n]*”/g, '').replace(/\s+/g, ' ');
    return /\b(?:(?:hypothetical|historical) example|unproven hypothesis|(?:source|quoted) (?:material|text) only|(?:are|is) not requirements? of this plan)\b/i.test(text)
      || /^\s*(?:(?:quoted )?source(?: (?:excerpt|text|material))?|(?:historical|earlier|previous) (?:review )?assessment):(?:\s|$)/i.test(text);
  };
  for (const line of prose(text).split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      while (owners.length && owners.at(-1)!.level >= heading[1]!.length) owners.pop();
      if (/^Current reviewed plan$/i.test(heading[2]!) && owners.length === 0) sourcePreamble = false;
      const asserted = !sourcePreamble && owners.every(owner => owner.asserted)
        && !/\b(?:source|example|hypothetical|proposed|optional|quoted|historical|template|unproven)\b/i.test(heading[2]!);
      owners.push({ level: heading[1]!.length, asserted });
      sections.push({ title: heading[2]!, body: [], asserted });
    } else if (sections.length) {
      const section = sections.at(-1)!;
      section.body.push(line);
      if (sourceFrame(section.body.join(' '))) section.asserted = owners.at(-1)!.asserted = false;
    } else {
      preamble += ' ' + line;
      sourcePreamble = sourceFrame(preamble);
    }
  }
  const current = sections.filter(section => section.asserted);
  const mandatory = current.filter(section => /^CRITICAL regression \(mandatory, regression rule\)$/i.test(section.title));
  const declaration = /^legacyAuthFlow(?:\(\))? is (?:existing|current) behavior being (?:modified|refactored)\b[^!?]{0,240}\.\s+(?:A|The) characterization test suite for legacyAuthFlow(?:\(\))? is (?:added|required) as a (?:critical|mandatory) requirement:\s*(?:capture|pin|record) (?:current|existing|prior)\b[^.!?]{1,400}\.\s+This suite runs against the flag-OFF path and is the oracle the new path is compared to during rollout\./i;
  const withdrawn = (body: string, task?: string) => new RegExp(
    `\\b(?:${task ? `${task}|` : ''}(?:this|the|that)\\s+(?:(?:characterization|regression|contract)\\s+)?(?:suite|task|test|requirement)|(?:characterization|regression)\\s+(?:suite|tests?))\\s+(?:(?:is|was|has been)\\s+)?(?:(?:not|no longer)\\s+(?:required|needed)|cancelled|canceled|withdrawn|rejected|deferred|optional)\\b`, 'i').test(body)
    || /\b(?:do not|never|skip|defer|cancel|withdraw)\s+(?:run(?:ning)?\s+)?(?:the|this)\s+(?:characterization\s+)?suite\b/i.test(body);
  const declared = mandatory.some(section => {
    const body = section.body.join(' ').replace(/\s+/g, ' ').trim();
    const claim = declaration.exec(body)?.[0];
    return claim && !/["“”]|\b(?:maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(claim)
      && !withdrawn(body);
  });
  if (declared) for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
    const tasks = section.body.join('\n').split(/\n(?=-\s)/);
    for (const task of tasks) {
      const match = /^\s*-\s+(?:\[[ xX]\]\s*)?(T[1-9]\d*)(?:\s+\([^\n)]*\))?\s+[—–:-]\s+(?:[A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+(?:\s+tests)?\s+[—–]\s+)?CRITICAL regression:\s+characterization suite for legacyAuthFlow(?:\(\))? prior behavior[\t ]*(?:\n|$)/i.exec(task);
      if (!match || withdrawn(task, match[1])) continue;
      const baseline = new RegExp(`^[1-9]\\d*\\. Run the characterization suite \\(${match[1]}\\) against the untouched legacyAuthFlow(?:\\(\\))? first and commit it green\\. This is the baseline\\.`, 'i');
      if (current.some(s => s.title === 'Verification' && baseline.test(s.body.join(' ').replace(/\s+/g, ' ').trim())
        && !withdrawn(s.body.join(' '), match[1]))) return true;
    }
  }
  for (const section of current.filter(s => /^CRITICAL: regression contract test for legacyAuthFlow\(\) \(iron rule, no decision needed\)$/.test(s.title))) {
    const body = section.body.join(' ').replace(/\s+/g, ' ').trim();
    const parity = /^The rewrite modifies existing behavior with no covering test \([^)]{1,120}\)\. Add ([A-Za-z][\w/-]*\.contract\.test\.[jt]s): a fixture table of \(tenant, token, policy\) cases covering [^.!?]{1,300}\. Run each fixture through legacyAuthFlow\(\) and ([A-Za-z][\w]*)\.authenticate\(\) and assert identical ([A-Za-z][\w]*) shape on success and identical error code on failure\. This test is also the gate for flipping any tenant's flag and for TODO [1-9]\d* removal\./.exec(body);
    if (!parity || withdrawn(body) || /["“”]|\b(?:maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(parity[0])) continue;
    const unchanged = current.some(s => {
      if (!s.title.endsWith(`: Per-tenant flag routes legacy vs ${parity[2]}`)
        || !/^Issue [1-9]\d* \(D[1-9]\d*, chose [1-9]\d*[A-D]\): /.test(s.title)) return false;
      const body = s.body.join('\n');
      const release = /(?:^|\n)- A tenant-keyed flag [A-Za-z][\w.]*\[tenantId\] \(default off\) selects the path at the\s+login entry point\. legacyAuthFlow\(\) stays callable and unchanged this release\./.exec(body);
      const prefix = release ? body.slice(0, release.index).trim().split(/\n\s*\n/).at(-1) ?? '' : '';
      return Boolean(release) && !/^(?:if|unless|maybe|perhaps|proposed|optional)\b/i.test(prefix)
        && !/\blegacyAuthFlow(?:\(\))?\s+(?:(?:is|was|will be|has been)\s+)?(?:changed|modified|rewritten|removed|withdrawn|not unchanged|no longer unchanged)\b/i.test(s.body.join(' '));
    });
    if (!unchanged) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      for (const task of tasks.body.join('\n').split(/\n(?=-\s)/)) {
        const match = /^\s*-\s+(?:\[[ xX]\]\s*)?(T[1-9]\d*)(?:\s+\([^\n)]*\))?\s+[—–:-]\s+Tests\s+[—–]\s+CRITICAL regression contract test: same fixtures through legacyAuthFlow\(\) and ([A-Za-z][\w]*), identical ([A-Za-z][\w]*) \/ error codes[\t ]*(?:\n|$)/.exec(task);
        if (!match || match[2] !== parity[2] || match[3] !== parity[3] || withdrawn(task, match[1])) continue;
        const files = /^\s+- Files: ([^\n]+)$/m.exec(task);
        if (files?.[1] === parity[1] && /^\s+- Verify: contract suite green on both paths[\t ]*$/m.test(task)) return true;
      }
    }
  }
  // A mandatory snapshot can state the legacy oracle as a required test
  // list item, then bind it to the numbered task's unchanged-code verification.
  const snapshotSource = prose(text, true).replace(/\s+/g, ' ');
  const unquoted = (body: string) => body.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const suiteWithdrawn = current.some(s => {
    // A named foreign suite owns its generic withdrawal; it cannot cancel
    // the legacy obligation in another section of the same report.
    const namedSuite = /^(.*?)\b(?:regression|characterization)\s+(?:suite|tests?)\b/i.exec(s.title);
    const foreignSuite = Boolean(namedSuite?.[1]?.trim() && !/^(?:legacy(?:AuthFlow(?:\(\))?)?|final|current|updated)[\s:—–-]*$/i.test(namedSuite[1]));
    return unquoted(s.body.join('\n')).split(/\n|[.!?]\s+/).some(statement => {
      const subject = /^(?:Correction:\s*)?(?:the|this|that)\s+(legacy\s+)?(?:regression|characterization)\s+(?:suite|tests?)\b/i.exec(statement.trim());
      return Boolean(subject && (!foreignSuite || subject[1]) && withdrawn(statement));
    });
  });
  // A current test contract may declare its oracle in a paragraph and bind
  // the same decision to a numbered implementation task. Read those atoms
  // independently: legacy target, current outcomes, pre-change green baseline,
  // task ownership and verification. Neighboring tasks cannot fill a gap.
  for (const section of current.filter(s => /^Tests(?: \([^\n]*\))?$/i.test(s.title))) {
    for (const paragraph of section.body.join('\n').split(/\n\s*\n/)) {
      const claim = unquoted(paragraph).replace(/\s+/g, ' ').trim();
      const contract = /^(?:(CRITICAL|mandatory|required) )?regression contract \(([^)]+)\):\s*/i.exec(claim);
      const decisions = contract?.[2]?.match(/\bD[1-9]\d*\b/g) ?? [];
      const records = contract?.[2]?.match(/\bR[1-9]\d*\b/g) ?? [];
      if (!contract || decisions.length !== 1 || records.length > 1 ||
          (!contract[1] && !/\bIron Rule\b/i.test(contract[2]!)) || /\b(?:not|no|optional|proposed)\b/i.test(contract[2]!)) continue;
      const decision = decisions[0]!, record = records[0];
      const outcomeNames = (value: string) => value.split(/[,;]/).map(name => name.trim().toLowerCase().replace(/\btokens\b/g, 'token'));
      const sameOutcomes = (a: string[], b: string[]) => a.length > 1 && a.length === b.length &&
        a.every(name => name && b.includes(name)) && new Set(a).size === a.length && new Set(b).size === b.length;
      const listed = /(?:^|\n)[1-9]\d*[.)]\s+legacyAuthFlow(?:\(\))? characterization suite:\s*(?:golden )?fixtures (?:pinning|recording|capturing) (?:current|existing|prior) outputs for\s+([^.!?]+)[.!?]/i.exec(unquoted(paragraph));
      const listedCases = listed ? outcomeNames(listed[1]!) : [];
      // The selected source-bound ledger owns this outcome inventory. The
      // test list, accepted scope and task count must all retain that inventory.
      const ownedGolden = Boolean(record && listed && current.filter(s => s.title.startsWith(record + ':')).length === 1 && current.some(s => {
        if (!s.title.startsWith(record + ':') || !/\bregression contract\b/i.test(s.title) || !/\blegacyAuthFlow\b/.test(s.title)) return false;
        const body = unquoted(s.body.join('\n'));
        const field = (name: string) => [...body.matchAll(new RegExp(`^${name}: ([^\\n]+(?:\\n(?!\\s*$|[A-Z][\\w ]*:|Question\\b|\\|)[^\\n]+)*)`, 'gm'))].map(m => m[1]!.replace(/\s+/g, ' ').trim());
        const findings = field('Finding'), states = field('State'), answers = field('Actual answer'), scopes = field('Accepted scope');
        const questions = [...body.matchAll(/^Question (D[1-9]\d*):/gm)];
        const preserved = /(?:^|\n)Behavior to preserve \(legacy tenants, flag off\): identical accept\/deny outcome and session shape for ([^.!?]+)[.!?]/i.exec(body);
        const accepted = scopes.length === 1 ? /(?:^|;\s*)\([1-9]\d*\) legacyAuthFlow(?:\(\))? characterization suite with (?:golden )?fixtures for ([^.!?]+?)(?=;\s*\([1-9]\d*\)|$)/i.exec(scopes[0]!) : null;
        const chosen = answers.length === 1 ? new RegExp(`^([A-D]) \\(${decision}\\)$`).exec(answers[0]!)?.[1] : undefined;
        const questionFields = field('Question ' + decision);
        const optionText = questionFields.length === 1 ? (questionFields[0]!.split('Options:')[1] ?? '').trim() : '';
        const offered = [...optionText.matchAll(/(?:^|;\s*)([A-D])\) ([^;]+)/g)];
        const selected = offered.filter(option => option[1] === chosen);
        const selectedCharacterization = offered.length >= 2 && offered.length <= 4 && new Set(offered.map(o => o[1])).size === offered.length &&
          selected.length === 1 && ['characterization', 'parity', 'routing'].every(kind => new RegExp(`\\b${kind}\\b`, 'i').test(selected[0]![2]!)) &&
          !/\b(?:no|not|never|without|optional|if|unless)\b/i.test(selected[0]![2]!);
        const source = findings.length === 1 && /\bCRITICAL\b/.test(findings[0]!) && !/\b(?:not|non)[ -]CRITICAL\b/i.test(findings[0]!) && /(?<![\w./-])PLAN\.md:\d/.test(findings[0]!);
        return source && states.length === 1 && states[0] === 'approved' && questions.length === 1 && questions[0]![1] === decision &&
          selectedCharacterization && preserved && accepted &&
          sameOutcomes(listedCases, outcomeNames(preserved[1]!)) && sameOutcomes(listedCases, outcomeNames(accepted[1]!)) &&
          !sourceFrame(body) && !withdrawn(body, record) && !/\b(?:if approved|pending approval|optional|hypothetical|unproven)\b/i.test(scopes[0]!);
      }));
      const cases = listed ? listedCases : /\bone test per (?:current|existing|prior) outcome:\s*([^.!?]+)[.!?]/i.exec(claim)?.[1]?.split(',').map(value => value.trim()) ?? [];
      const baseline = /\b(?:written and green|written and passing|implemented and green) on ([A-Za-z][\w/-]*) BEFORE (?:the )?(?:Phase [1-9]\d* )?flag (?:wrap|wrapper) (?:lands|is added)\b/i.exec(claim);
      if ((!listed && !baseline) || (listed && !ownedGolden) || !cases.length || cases.some(value => !value) || new Set(cases).size !== cases.length || suiteWithdrawn || withdrawn(claim) ||
          (!listed && !/\bcharacterization suite (?:at|for) (?:the )?legacyAuthFlow\(\)(?: boundary)?\b/i.test(claim)) ||
          /\b(?:maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(claim)) continue;
      for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
        for (const task of tasks.body.join('\n').split(/\n(?=-\s)/)) {
          const body = unquoted(task), first = body.split('\n')[0] ?? '';
          const id = /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(first)?.[1];
          const outcomeCount = /\(([1-9]\d*) (?:outcomes?|golden fixtures)\b/.exec(first)?.[1];
          const verifies = [...body.matchAll(/^\s+- Verify: ([^\n]+)$/gm)];
          const files = [...body.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
          const taskSources = [...body.matchAll(/^\s+- Surfaced by: ([^\n]+)$/gm)];
          const taskDecisions = taskSources.length === 1 ? taskSources[0]![1]!.match(/\bD[1-9]\d*\b/g) ?? [] : [];
          const reviewedTargets = current.flatMap(s => [...unquoted(s.body.join('\n')).matchAll(/^Reviewed target: ([^\n]+)$/gm)]);
          const baselineVerified = listed
            ? /\bCRITICAL\b/.test(first) && !/\b(?:not|non)[ -]CRITICAL\b/i.test(first) && verifies.length === 1 &&
              /^suite (?:green|passing|passes) on (?:unmodified|untouched) main before (?:any|the) (?:refactor|rewrite|change) (?:lands|begins)$/i.test(verifies[0]![1]!) &&
              files.length === 1 && /(?:^|[, ]+)[\w/.-]*legacyAuthFlow\.characterization\.test(?:\.[jt]s)?(?=,|$)/.test(files[0]![1]!) &&
              reviewedTargets.length === 1 && /^PLAN\.md(?:\s|$)[^\n]*\bon main\b/.test(reviewedTargets[0]![1]!) &&
              taskSources.length === 1 && /(?<![\w./-])PLAN\.md:\d/.test(taskSources[0]![1]!) &&
              taskDecisions.length === 1 && taskDecisions[0] === decision &&
              current.filter(s => s.title === 'Implementation Tasks').flatMap(s => s.body.join('\n').split(/\n(?=-\s)/))
                .filter(t => new RegExp(`^- (?:\\[[ xX]\\] )?${id}\\b`).test(t)).length === 1
            : baseline && new RegExp(`\\bland it (?:green|passing) on ${baseline[1]} before (?:any|the) flag (?:wrap|wrapper)\\b`, 'i').test(first) &&
              new RegExp(`^\\s+- Verify: suite passes on unmodified ${baseline[1]}; each of the ${cases.length} outcomes has one test[\\t ]*$`, 'm').test(body);
          if (!id || sourceFrame(body) || withdrawn(body, id) ||
              /\b(?:do not|don't|never|skip|defer|optionally?|if|unless|hypothetical|unproven)\b/i.test(body) ||
              !/\b(?:Write|Add|Implement) (?:the )?legacyAuthFlow(?:\(\))? characterization suite\b/i.test(first) ||
              Number(outcomeCount) !== cases.length ||
              !baselineVerified || !new RegExp(`^\\s+- Surfaced by: [^\\n]*\\b${decision}\\b`, 'm').test(body)) continue;
          const owners = `(?:${id}|${decision}|${record ? record + '|' : ''}(?:this|the|that) (?:(?:legacy|baseline|regression|characterization) )?(?:suite|verification|requirement))`;
          const inactiveStatus = '(?:withdrawn|cancelled|canceled|rejected|deferred|superseded|optional|not current|(?:not|no longer) (?:required|needed))';
          const cancelled = current.some(s => {
            const named = /^(.*?)\b(?:regression|characterization)\s+(?:suite|tests?)\b/i.exec(s.title)?.[1]?.trim();
            const foreign = Boolean(named && !/^(?:(?:current|final|required|updated)\s*)*(?:legacy(?:AuthFlow\(\))?)?[\s:—-]*$/i.test(named));
            if (foreign && !new RegExp(`\\b(?:${id}|${decision}|${record ? record + '|' : ''}legacyAuthFlow)\\b`).test(s.body.join(' '))) return false;
            const raw = s.body.join('\n').replace(new RegExp(`(${owners} (?:is|was|has been) )["“'‘\x60](${inactiveStatus})["”'’\x60]`, 'gi'), '$1$2');
            return unquoted(raw).split(/\n|[.!?;]\s+/).some(line => !sourceFrame(line) &&
              (new RegExp(`\\b${owners} (?:is|was|has been) ${inactiveStatus}\\b`, 'i').test(line) ||
               new RegExp(`(?:do not|don't|never|skip|defer|cancel) (?:run |write |add |verify )?${owners}\\b`, 'i').test(line) ||
               new RegExp(`\\blegacyAuthFlow(?:\\(\\))? (?:is|will be) (?:modified|changed|rewritten) before ${id}\\b`, 'i').test(line)));
          });
          if (!cancelled) return true;
        }
      }
    }
  }
  for (const section of current.filter(s => /^Required tests(?: \([^\n]*\))?$/i.test(s.title))) {
    const body = section.body.join('\n').trim();
    if (!body.startsWith('- ')) continue;
    for (const block of body.split(/\n(?=-\s)/)) {
      const claim = block.replace(/\s+/g, ' ').trim();
      if (suiteWithdrawn || !/^- CRITICAL regression legacyAuthFlow(?:\(\))? snapshot: capture current outputs for [^;.!?]{1,240} BEFORE any change; assert both legacy \(flag OFF\) and new \(flag ON\) paths produce identical observable results\. Mandatory under the coverage-audit regression rule\./.test(claim)
          || !snapshotSource.includes(claim) || withdrawn(unquoted(claim))
          || /["“”]|\b(?:not|never|maybe|might|could|if|unless|optional|hypothetical|unproven)\b/i.test(claim)) continue;
      for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
        const body = tasks.body.join('\n').trim();
        const taskPrefix = body.split(/\n(?=-\s)/)[0]?.trim() ?? '';
        if (!body.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(taskPrefix)
            || /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(taskPrefix))) continue;
        for (const task of body.split(/\n(?=-\s)/)) {
          const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–] [A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+ [—–] Snapshot legacyAuthFlow\(\) behavior as regression tests before any change[\t ]*(?:\n|$)/.exec(task);
          if (!match || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim())
              || !/^\s+- Verify: tests pass against unmodified legacy code, then against flag-OFF route[\t ]*$/m.test(task)
              || withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
          const taskWithdrawal = new RegExp(`\\b${match[1]}\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
          if (!current.some(s => taskWithdrawal.test(unquoted(s.body.join('\n'))))) return true;
        }
      }
    }
  }
  // A mandatory declaration can require capture before touching the legacy
  // function, with a task and ordered verification on both router settings.
  const sourceOwner = (body: string) => sourceFrame(body) ||
    /\b(?:is|was|presents?|represents?)\s+(?:(?:only|just)\s+)?(?:an?\s+)?(?:quoted|hypothetical|historical|example|template)\b/i.test(body);
  const conditionalOwner = (prefix: string) => /^(?:if|unless|maybe|perhaps|proposed|optional)\b/i.test(prefix.trim().split('\n').at(-1)?.trim() ?? '');
  for (const section of current.filter(s => /^REGRESSION \(mandatory rule, no approval needed\) [—–-] CRITICAL$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const declaration = /(?:^|[.!?]\s+)Add a characterization (?:test )?suite for legacyAuthFlow\(\) before (?:touching|changing|refactoring) it:\s*(?:capture|pin|record) current inputs and outputs \([^()!?]{1,300}\) and run the same suite against ([A-Za-z][\w]*) on both flag settings\. A behavior difference between paths is a test failure\b/i.exec(body);
    if (!declaration || suiteWithdrawn || withdrawn(body) ||
        !snapshotSource.includes(declaration[0].trim()) || sourceOwner(body.slice(0, declaration.index)) ||
        /\b(?:if|unless|maybe|might|could|proposed|optional|hypothetical|unproven)\b/i.test(body.slice(0, declaration.index))) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim();
      const taskPrefix = taskBody.split(/\n(?=-\s)/)[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(taskPrefix) ||
          /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(taskPrefix))) continue;
      for (const task of taskBody.split(/\n(?=-\s)/)) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+ [—–-] CRITICAL characterization suite for legacyAuthFlow\(\), run on both router paths[\t ]*(?:\n|$)/i.exec(task);
        const verify = /^\s+- Verify: suite passes on legacy before any refactor; passes on new path before flag enable[\t ]*$/m.exec(task);
        const taskIntro = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || !verify || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            conditionalOwner(taskIntro) || sourceOwner(taskIntro) || conditionalOwner(task.slice(0, verify.index)) || sourceOwner(unquoted(task.slice(0, verify.index))) ||
            withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
        const taskWithdrawal = new RegExp(`\\b${match[1]}\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
        if (current.some(s => taskWithdrawal.test(unquoted(s.body.join('\n'))))) continue;
        for (const verification of current.filter(s => /^Verification(?: \([^\n]*\))?$/i.test(s.title))) {
          const body = unquoted(verification.body.join('\n')).trim();
          const baseline = /^([1-9]\d*)\. Run the characterization suite against legacyAuthFlow\(\) on the unmodified code; it must pass before any refactor lands\.[\t ]*$/m.exec(body);
          const compare = new RegExp(`^([1-9]\\d*)\\. Run the characterization suite through ${declaration[1]} with the flag on new; zero differences\\.[\\t ]*$`, 'm').exec(body);
          if (baseline && compare && Number(baseline[1]) < Number(compare[1]) && baseline.index < compare.index &&
              !conditionalOwner(body.slice(0, baseline.index)) && !conditionalOwner(body.slice(0, compare.index)) &&
              !sourceOwner(body.slice(0, baseline.index)) && !sourceOwner(body.slice(0, compare.index)) &&
              !withdrawn(body.replace(/\b(?:this|that|the)\s+(?:baseline|verification)\b/gi, 'this requirement'), match[1]) &&
              snapshotSource.includes(baseline[0]) && snapshotSource.includes(compare[0])) return true;
        }
      }
    }
  }
  // A golden-master requirement names the existing output oracle, then ties
  // its capture task to an untouched baseline and reruns after later tasks.
  const goldenSourceOwner = (body: string) => sourceOwner(body) || /(?:^|\n)\s*(?:Source|Quoted source) excerpt:\s*(?:\n|$)/i.test(body);
  // A staged refactor can bind its baseline and parity checks to two tasks,
  // with the release labels separate from their task identities.
  const staged = current.filter(s => /^REGRESSION \(CRITICAL, mandatory\)$/i.test(s.title));
  const taskSections = current.filter(s => s.title === 'Implementation Tasks');
  if (!suiteWithdrawn && staged.length === 1 && taskSections.length === 1) {
    const stagedSource = (value: string) => goldenSourceOwner(unquoted(value)) ||
      /(?:^|\n)\s*(?:Source|Quoted source|Earlier review assessment):/i.test(unquoted(value));
    const stagedConditional = (value: string) => conditionalOwner(value) ||
      /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(value));
    const body = unquoted(staged[0]!.body.join(' ')).replace(/\s+/g, ' ').trim();
    const declaration = /^(?:[A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)? [—–-]\s*)?This is existing behavior being modified with no covering test\. (PR[1-9]\d*) adds characterization tests that pin every observable outcome of legacyAuthFlow\(\) \(([^()!?]{1,600})\) before any rewrite\. They run against the legacy path in \1, against both paths in (PR[1-9]\d*), and are folded into pipeline tests in (PR[1-9]\d*)\. Pre-authorized by the regression rule\.$/.exec(body);
    const tasksText = taskSections[0]!.body.join('\n').trim();
    const taskBlocks = tasksText.split(/\n(?=-\s)/);
    const ids = taskBlocks.map(t => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(t)?.[1]).filter(Boolean);
    const taskPrefix = taskBlocks[0]!.startsWith('- ') ? '' : taskBlocks[0]!;
    if (declaration && Number(declaration[1]!.slice(2)) < Number(declaration[3]!.slice(2)) &&
        Number(declaration[3]!.slice(2)) < Number(declaration[4]!.slice(2)) &&
        !withdrawn(body) && !stagedSource(taskPrefix) && !stagedConditional(taskPrefix) &&
        ids.length === new Set(ids).size) {
      const baselinePattern = new RegExp(`^- (?:\\[[ xX]\\] )?(T[1-9]\\d*)(?: \\([^\\n)]*\\))? [—–-] ${declaration[1]} legacy auth [—–-] Write characterization \\(regression\\) tests pinning legacyAuthFlow\\(\\) prior behavior before any rewrite[\\t ]*(?:\\n|$)`);
      for (const baseline of taskBlocks) {
        const task = baselinePattern.exec(baseline);
        const verify = /^\s+- Verify: suite green against unmodified legacy path; ([1-9]\d*) cases recorded as oracle[\t ]*$/m.exec(baseline);
        if (!task || !verify || Number(verify[1]) !== declaration[2]!.split(',').length ||
            stagedSource(baseline) || stagedConditional(baseline.slice(0, verify.index))) continue;
        const parityPattern = new RegExp(`^- (?:\\[[ xX]\\] )?(T[1-9]\\d*)(?: \\([^\\n)]*\\))? [—–-] ${declaration[3]} strangler fig [—–-] Make legacyAuthFlow delegate to the new pipeline behind a feature flag; ${task[1]} characterization tests pass against both paths[\\t ]*(?:\\n|$)`);
        for (const parity of taskBlocks) {
          const rerun = parityPattern.exec(parity);
          const parityVerify = new RegExp(`^[\\t ]+- Verify: ${task[1]} suite green with flag on and off[\\t ]*$`, 'm').exec(parity);
          if (!rerun || task[1] === rerun[1] || !parityVerify || taskBlocks.indexOf(baseline) >= taskBlocks.indexOf(parity) ||
              stagedSource(parity) || stagedConditional(parity.slice(0, parityVerify.index))) continue;
          // Quoted old prose is evidence about history. A quoted status word
          // with a current task/suite subject still cancels its obligation.
          const status = (value: string) => unquoted(value.replace(new RegExp(`((?:${task[1]}|${rerun[1]})(?: (?:verification|baseline verification|rerun))? (?:is|was|has been) |(?:this|the) (?:legacy )?(?:(?:characterization|regression|baseline|unchanged-code) )?(?:suite|requirement|verification) (?:is|was|has been) )["“'](withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)["”']`, 'gi'), '$1$2'));
          const canceled = new RegExp(`\\b(?:${task[1]}|${rerun[1]})(?: (?:verification|baseline verification|rerun))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\\b`, 'i');
          const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${task[1]}\\b`, 'i');
          const noRerun = new RegExp(`\\b${rerun[1]} (?:no longer|does not|will not) (?:re)?runs? ${task[1]}\\b`, 'i');
          const inactive = (value: string) => withdrawn(status(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), task[1]) || canceled.test(status(value)) ||
            /\b(?:this|the) (?:legacy )?(?:(?:characterization|regression|baseline|unchanged-code) )?(?:suite|requirement|verification) (?:is|was|has been) (?:superseded|not current)\b/i.test(status(value));
          if (inactive(body) || inactive(baseline) || inactive(parity) || current.some(s => {
            const assessment = status(s.body.join('\n'));
            return /\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\b/i.test(assessment) ||
              canceled.test(assessment) || noRerun.test(assessment) ||
              assessment.split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim()));
          })) continue;
          return true;
        }
      }
    }
  }
  const goldenWithdrawn = current.some(s => {
    const namedSuite = /^(.*?)\b(?:regression|characterization|golden[ -]master)\s+(?:suite|fixtures?|tests?)\b/i.exec(s.title);
    const foreignSuite = Boolean(namedSuite?.[1]?.trim() && !/^(?:legacy(?:AuthFlow(?:\(\))?)?|final|current|updated)[\s:—–-]*$/i.test(namedSuite[1]));
    return unquoted(s.body.join('\n')).split(/\n|[.!?]\s+/).some(statement => {
      const subject = /^(?:Correction:\s*)?(?:the|this|that)\s+(legacy(?:AuthFlow(?:\(\))?)?\s+)?golden[ -]master\s+(?:suite|fixtures?|tests?)\b/i.exec(statement.trim());
      return Boolean(subject && (!foreignSuite || subject[1]) && withdrawn(statement
        .replace(/golden[ -]master\s+(?:suite|fixtures?|tests?)/i, 'regression suite').replace(/\b(?:are|were|have been)\b/i, 'is')));
    });
  });
  for (const section of current.filter(s => /^Tests(?: \([^\n]*\))?$/i.test(s.title))) {
    const body = unquoted(section.body.join('\n')).split(/\n\s*\n/)
      .map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).join('\n\n');
    const claim = /^CRITICAL \(regression rule, mandatory\): legacyAuthFlow(?:\(\))? golden[ -]master\.\s+(?:Capture|Pin|Record) current outputs for [^.!?]{1,300} BEFORE any change, assert identical behavio[u]?r after the rewrite(?: and after [^.!?]{1,120})?\./im.exec(body);
    if (!claim || suiteWithdrawn || goldenWithdrawn || withdrawn(body) ||
        !snapshotSource.includes(claim[0].replace(/\s+/g, ' ')) ||
        goldenSourceOwner(body.slice(0, claim.index)) || conditionalOwner(body.slice(0, claim.index))) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim();
      const taskPrefix = taskBody.split(/\n(?=-\s)/)[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(taskPrefix) ||
          /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(unquoted(taskPrefix)))) continue;
      for (const task of taskBody.split(/\n(?=-\s)/)) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)* [—–-] Capture golden[ -]master regression fixtures for legacyAuthFlow(?:\(\))? before any change[\t ]*(?:\n|$)/i.exec(task);
        const verify = /^\s+- Verify: fixtures pass against untouched legacy; rerun after every later task[\t ]*$/m.exec(task);
        const taskIntro = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || !verify || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            /\b(?:if|unless|optional|hypothetical|source|quoted|unproven)\b/i.test(match[0]) ||
            conditionalOwner(taskIntro) || goldenSourceOwner(taskIntro) ||
            conditionalOwner(task.slice(0, verify.index)) || goldenSourceOwner(unquoted(task.slice(0, verify.index))) ||
            withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
        const taskWithdrawal = new RegExp(`\\b${match[1]}(?:\\s+rerun)?\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
        if (current.some(s => taskWithdrawal.test(unquoted(s.body.join('\n'))))) continue;
        for (const verification of current.filter(s => /^Verification(?: \([^\n]*\))?$/i.test(s.title))) {
          const body = unquoted(verification.body.join('\n')).trim();
          const baseline = new RegExp(`^([1-9]\\d*)\\. Run ${match[1]} fixtures before touching anything; they must pass\\.[\\t ]*$`, 'm').exec(body);
          const rerun = new RegExp(`^([1-9]\\d*)\\. After each task, rerun the full suite plus ${match[1]} fixtures\\.[\\t ]*$`, 'm').exec(body);
          if (baseline && rerun && Number(baseline[1]) < Number(rerun[1]) && baseline.index < rerun.index &&
              !conditionalOwner(body.slice(0, baseline.index)) && !conditionalOwner(body.slice(0, rerun.index)) &&
              !goldenSourceOwner(body.slice(0, baseline.index)) && !goldenSourceOwner(body.slice(0, rerun.index)) &&
              !withdrawn(body.replace(/\b(?:this|that|the)\s+(?:baseline|verification)\b/gi, 'this requirement'), match[1]) &&
              snapshotSource.includes(baseline[0]) && snapshotSource.includes(rerun[0])) return true;
        }
      }
    }
  }
  // A current-output characterization declaration can bind the same file
  // and pre-rewrite task directly, without a separate Verification heading.
  for (const section of current.filter(s => /^REGRESSION \(mandatory, authorized by the coverage-audit regression rule [—–-] no question asked\)$/i.test(s.title))) {
    const body = unquoted(section.body.join('\n')).trim();
    const split = body.indexOf('\n- ');
    if (split < 0 || suiteWithdrawn) continue;
    const intro = body.slice(0, split).replace(/\s+/g, ' ').trim();
    if (!/^legacyAuthFlow\(\) is existing behavior being rewritten\b[^!?]{1,400}\. CRITICAL requirement added to the plan:$/.test(intro) ||
        goldenSourceOwner(intro) || /\b(?:if|unless|maybe|might|could|proposed|optional|hypothetical|unproven)\b/i.test(intro)) continue;
    const claim = body.slice(split).replace(/\s+/g, ' ').trim();
    const declaration = /^- ([A-Za-z][\w/.-]*\.test\.[jt]s) [—–-] record current outputs for: [^.!?]{1,600}\. Assert the new path \(behind the flag\) produces identical decisions and equivalent error surfaces\. These tests are written BEFORE any rewrite \((T[1-9]\d*)\) and stay green through cut-over\.$/.exec(claim);
    if (!declaration || withdrawn(body) || !snapshotSource.includes(claim) ||
        /\b(?:if|unless|maybe|might|could|proposed|optional|hypothetical|unproven)\b/i.test(claim)) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          /\b(?:if|unless|optional|hypothetical|example|source|quoted|unproven)\b/i.test(unquoted(prefix)))) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Write characterization tests for legacyAuthFlow\(\) before any rewrite[\t ]*(?:\n|$)/.exec(task);
        const file = /^\s+- Files: ([^\n]+)$/m.exec(task);
        const verify = /^\s+- Verify: suite green on current main; re-run after each later task[\t ]*$/m.exec(task);
        const beforeTask = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || match[1] !== declaration[2] || file?.[1] !== declaration[1] || !verify ||
            !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            conditionalOwner(beforeTask) || goldenSourceOwner(beforeTask) ||
            conditionalOwner(task.slice(0, verify.index)) || goldenSourceOwner(unquoted(task.slice(0, verify.index))) ||
            withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), match[1])) continue;
        const cancelledTask = new RegExp(`\\b${match[1]}(?:\\s+(?:rerun|verification|baseline verification))?\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
        const changedBeforeBaseline = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${match[1]}\\b`, 'i');
        const assessment = (body: string) => unquoted(body.replace(new RegExp(`(\\b${match[1]}(?:\\s+(?:rerun|verification|baseline verification))?\\s+(?:is|was|has been)\\s+)["“](withdrawn|rejected|cancelled|canceled)["”]`, 'gi'), '$1$2'));
        if (!current.some(s => cancelledTask.test(assessment(s.body.join('\n'))) ||
            assessment(s.body.join('\n')).split(/\n|[.!?]\s+/).some(statement => changedBeforeBaseline.test(statement.trim())))) return true;
      }
    }
  }
  // The same mandatory characterization can precede a behavior-preserving
  // extraction: its untouched baseline and the extraction's rerun share a task ID.
  const extractionSourceOwner = (body: string) => goldenSourceOwner(body) ||
    /(?:^|\n)\s*(?:(?:quoted )?source(?: (?:excerpt|text|material))?|(?:historical|earlier|previous)(?: review)?(?: assessment)?|(?:hypothetical )?example):\s*(?:\n|$)/i.test(unquoted(body));
  for (const section of current.filter(s => s.title === 'Tests')) {
    const body = unquoted(section.body.join('\n'));
    const claim = /^CRITICAL [—–-] regression rule \(mandatory, not a decision\): (T[1-9]\d*) adds a characterization test for legacyAuthFlow\(\)'s current behavior \([^\n)]{1,300}\) and lands before the ([1-9]\d*[A-D]) extraction\./m.exec(body);
    if (!claim || suiteWithdrawn || withdrawn(body, claim[1]) || !snapshotSource.includes(claim[0]) ||
        extractionSourceOwner(body.slice(0, claim.index)) || conditionalOwner(body.slice(0, claim.index))) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(unquoted(prefix)) || conditionalOwner(prefix))) continue;
      const active = (task: string, id: string, verifyAt: number) => {
        const beforeTask = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        return snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) &&
          !conditionalOwner(beforeTask) && !extractionSourceOwner(beforeTask) &&
          !conditionalOwner(task.slice(0, verifyAt)) && !extractionSourceOwner(unquoted(task.slice(0, verifyAt))) &&
          !withdrawn(unquoted(task).replace(/\b(?:this|that|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement'), id);
      };
      for (const baseline of blocks) {
        const task = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Add characterization\/regression test for legacyAuthFlow\(\) current behavior[\t ]*(?:\n|$)/.exec(baseline);
        const file = /^\s+- Files: ([A-Za-z][\w/.-]*\.test\.[jt]s)$/m.exec(baseline);
        const verify = /^\s+- Verify: test passes against unmodified legacy before any other commit[\t ]*$/m.exec(baseline);
        if (!task || task[1] !== claim[1] || !file || !verify || !active(baseline, task[1], verify.index)) continue;
        for (const extraction of blocks) {
          const task2 = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Extract IDP checks \+ token validation into shared ([A-Za-z][\w]*)\(\); legacy calls it, behavior unchanged[\t ]*(?:\n|$)/.exec(extraction);
          const origin = /^\s+- Surfaced by: Code quality Issue [1-9]\d* \(D[1-9]\d*, ([1-9]\d*[A-D])\)[\t ]*$/m.exec(extraction);
          const rerun = /^\s+- Verify: (T[1-9]\d*) still green; diff to legacy is call-site only[\t ]*$/m.exec(extraction);
          if (!task2 || task2[1] === task[1] || origin?.[1] !== claim[2] || rerun?.[1] !== task[1] || !active(extraction, task2[1], rerun.index)) continue;
          const canceled = new RegExp(`\\b(?:${task[1]}|${task2[1]})(?:\\s+(?:rerun|verification|baseline verification|regression test|characterization test))?\\s+(?:is|was|has been)\\s+(?:cancelled|canceled|withdrawn|rejected|deferred|optional|not required|no longer required)\\b`, 'i');
          const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${task[1]}\\b`, 'i');
          const assessment = (value: string) => unquoted(value.replace(new RegExp(`(\\b(?:${task[1]}|${task2[1]})(?:\\s+(?:rerun|verification|baseline verification|regression test|characterization test))?\\s+(?:is|was|has been)\\s+)["“](withdrawn|rejected|cancelled|canceled)["”]`, 'gi'), '$1$2'));
          const rerunWithdrawn = new RegExp(`\\b${task2[1]} (?:no longer|does not|will not) reruns? ${task[1]}\\b`, 'i');
          if (!current.some(s => canceled.test(assessment(s.body.join('\n'))) || rerunWithdrawn.test(assessment(s.body.join('\n'))) ||
              assessment(s.body.join('\n')).split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim())))) return true;
        }
      }
    }
  }

  // A golden requirement can name its parity oracle in a test-list item,
  // with the same task capturing current outputs on untouched legacy code.
  for (const section of current.filter(s => s.title === 'Test requirements')) {
    const requirements = section.body.join('\n').trim();
    for (const block of requirements.split(/\n(?=-\s)/)) {
      const claim = unquoted(block).replace(/\s+/g, ' ').trim();
      const rule = /^- CRITICAL [—–-] ([A-Za-z][\w/.-]*\/legacyAuthFlow\.regression\.test\.[jt]s) \((T[1-9]\d*), REGRESSION RULE, no approval needed\): golden tests for ([^.!?]{1,300})\./.exec(claim);
      if (!rule || suiteWithdrawn || goldenWithdrawn || !snapshotSource.includes(claim) ||
          !/(?:^|\. )These tests are the parity oracle for the D[1-9]\d* flag-off path\./.test(claim) ||
          extractionSourceOwner(block) || conditionalOwner(block) ||
          extractionSourceOwner(requirements.slice(0, requirements.indexOf(block))) ||
          conditionalOwner(requirements.slice(0, requirements.indexOf(block)))) continue;
      const id = rule[2]!;
      const assessment = (value: string) => value.replace(/"[^"\n]*"|“[^”\n]*”/g,
        (quoted: string, index: number, source: string) =>
          /^(?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)$/i.test(quoted.slice(1, -1)) &&
          new RegExp(`(?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:verification|baseline verification|regression tests?))? (?:is|was|has been)|(?:this|the) (?:(?:unchanged-code|baseline) )?verification (?:is|was|has been)|(?:the|this) legacy golden (?:tests|suite) (?:are|is|were|was|have been|has been)) $`, 'i').test(source.slice(0, index))
            ? quoted.slice(1, -1) : '');
      const inactive = (value: string) => {
        const body = assessment(value).replace(/\b(?:these|the|this)\s+tests\s+(?:are|were|have been)\b/gi, 'this suite is')
          .replace(/\b(?:these|the|this)\s+tests\b/gi, 'this suite')
          .replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
        return withdrawn(body, id) || /\b(?:this|the|that) (?:requirement|suite|test) (?:is|was|has been) (?:not current|no longer current)\b/i.test(body) || new RegExp(`\\b${id}(?: (?:verification|baseline verification|regression tests?))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)\\b`, 'i').test(body);
      };
      if (inactive(block)) continue;
      const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification|regression tests?))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)\\b`, 'i');
      const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow(?:\\(\\))? (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'i');
      if (current.some(s => {
        const body = assessment(s.body.join('\n'));
        return cancelled.test(body) || /\b(?:the|this) legacy golden (?:tests|suite) (?:are|is|were|was|have been|has been) (?:withdrawn|rejected|cancelled|canceled|optional|not current|no longer required)\b/i.test(body) ||
          body.split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim()));
      })) continue;
      const ordering = current.some(s => {
        if (s.title !== 'Implementation steps') return false;
        const body = unquoted(s.body.join('\n'));
        const step = new RegExp(`^[1-9]\\d*\\. Golden regression tests for legacyAuthFlow \\(${id}\\) [—–-] pin current outputs\\s+per input class before any other code moves\\. CRITICAL, lands first\\.`, 'm').exec(body);
        return Boolean(step && !extractionSourceOwner(body.slice(0, step.index)) && !conditionalOwner(body.slice(0, step.index)) &&
          !inactive(body) && snapshotSource.includes(step[0].replace(/\s+/g, ' ')));
      });
      if (!ordering) continue;
      for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
        const body = tasks.body.join('\n').trim();
        for (const task of body.split(/\n(?=-\s)/)) {
          const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] ([A-Za-z][\w/.-]*\/legacyAuthFlow) tests [—–-] CRITICAL golden regression tests, land first[\t ]*(?:\n|$)/.exec(task);
          const file = /^\s+- Files: ([^\n]+)$/m.exec(task);
          const verify = /^\s+- Verify: (one|two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) input classes pinned; suite green against unmodified legacy code before any refactor commit[\t ]*$/m.exec(task);
          const prefix = unquoted(body.slice(0, body.indexOf(task))).trim().split('\n').at(-1) ?? '';
          if (!match || match[1] !== id || file?.[1] !== rule[1] || !verify ||
              !rule[1].startsWith(match[2] + '.regression.test.') ||
              !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
              extractionSourceOwner(prefix) || conditionalOwner(prefix) ||
              extractionSourceOwner(unquoted(task.slice(0, verify.index))) || conditionalOwner(task.slice(0, verify.index)) || inactive(task)) continue;
          const count = /^\d+$/.test(verify[1]!) ? Number(verify[1]) : ['zero','one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(verify[1]!);
          if (count === rule[3]!.split(',').length) return true;
        }
      }
    }
  }


  // A mandatory before-rewrite declaration binds exact captured behavior to
  // the same task file's current-code baseline and flag-on rerun.
  const approvalPending = (value: string) => unquoted(value).split('\n').some(line =>
    /^\s*(?:once|when|pending)\b[^.!?\n]{0,80}\bapprov(?:e[ds]?|al)\b/i.test(line));
  // A required fixture file can own the legacy oracle while its read-only
  // baseline task gates the scheduled task that changes the legacy module.
  for (const section of current.filter(s => /^CRITICAL: regression test for legacyAuthFlow\(\) \(regression rule, mandatory\)$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /(?:^|\. )Before any rewrite: - ([A-Za-z][\w/.-]*\.test(?:\.[jt]s)?) records, for a fixture set of tenants and tokens, the exact claims returned and the exact error for each failure case \(([^()!?]{1,300})\)\. - The same fixture set is the shadow comparator's assertion set and stays as the permanent behavioral spec after legacy is deleted\./.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0].trim()) || withdrawn(body) ||
        extractionSourceOwner(body) || conditionalOwner(body) || approvalPending(body) ||
        !['expired', 'wrong audience', 'wrong issuer', 'suspended tenant', 'revoked token', 'malformed token'].every(kind => rule[2]!.split(',').map(item => item.trim()).includes(kind))) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/), prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || conditionalOwner(prefix) || approvalPending(prefix) || /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] CRITICAL regression test capturing legacyAuthFlow\(\) behavior before any rewrite[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: test passes against unmodified legacy; same fixtures drive shadow compare[\t ]*$/gm)];
        const verify = verifies[0], preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || files.length !== 1 || files[0]![1] !== rule[1] || verifies.length !== 1 ||
            (task.match(/^\s+- Verify:/gm)?.length ?? 0) !== 1 || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index)))) continue;
        const id = match[1]!, status = '(?:withdrawn|rejected|declined|cancelled|canceled|superseded|deferred|optional|not current|no longer current|not required|no longer required)';
        const assessment = (value: string) => unquoted(value.replace(new RegExp(
          `((?:^|[.!?;]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:baseline requirement|verification|baseline verification))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
          .replace(/(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’/g, '')
          .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
        const cancelled = new RegExp(`\\b${id}(?: (?:baseline requirement|verification|baseline verification))? (?:is|was|has been) ${status}\\b`, 'i');
        const inactive = (value: string) => {
          const owned = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
          return withdrawn(owned, id) || cancelled.test(owned) || new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(owned);
        };
        const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
        const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
        if (inactive(body) || inactive(task) || current.some(s => {
          const value = assessment(s.body.join('\n'));
          return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
            new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(value);
        })) continue;
        for (const strategy of current.filter(s => s.title === 'Worktree parallelization strategy')) {
          const schedule = unquoted(strategy.body.join('\n'));
          const rows = [...schedule.matchAll(/^\| (T[1-9]\d*) ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
          if (rows.length !== new Set(rows.map(row => row[1])).size || extractionSourceOwner(schedule) || approvalPending(schedule) || inactive(schedule) ||
              schedule.split('\n').some(line => conditionalOwner(line) || /^\s*(?:assuming|provided)\b/i.test(line))) continue;
          const baseline = rows.find(row => row[1] === id && row[2] === 'legacy regression test' && row[4] === '—');
          const modules = baseline && /^([A-Za-z][\w/-]*) \(read\), ([A-Za-z][\w/-]*)$/.exec(baseline[3]!);
          const writers = modules ? rows.filter(row => row[1] !== id && row[3]!.split(',').map(item => item.trim()).includes(modules[1]!)) : [];
          if (modules && rule[1]!.startsWith(modules[2] + '/') && writers.length > 0 &&
              writers.every(row => row[4]!.split(',').map(item => item.trim()).includes(id)) &&
              snapshotSource.includes(baseline![0].replace(/\s+/g, ' ').trim())) return true;
        }
      }
    }
  }
  for (const section of current.filter(s => s.title === 'REGRESSION RULE (mandatory, no decision required)')) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /^legacyAuthFlow\(\) is existing behavior being rewritten\b[^!?]{1,240}\. CRITICAL: before any rewrite, record a characterization suite in ([A-Za-z][\w/.-]*\.test\.[jt]s): for each supported tenant configuration, capture inputs \([^()!?]{1,300}\) and the exact output \([^()!?]{1,300}\)\. The new path must pass the same suite with the flag on\. This is the parity gate for D[1-9]\d*\.$/.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(body) || withdrawn(body) ||
        /\b(?:if|unless|maybe|might|could|optional|hypothetical|unproven)\b/i.test(body)) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || approvalPending(prefix) || /\b(?:if|unless|assuming|provided|optional|hypothetical|unproven)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Write the legacyAuthFlow\(\) characterization \(regression\) suite before any rewrite[\t ]*(?:\n|$)/.exec(task);
        const file = /^\s+- Files: ([^\n]+)$/m.exec(task);
        const verify = /^\s+- Verify: suite green on current code; green again with flag on after rewrite[\t ]*$/m.exec(task);
        const preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || file?.[1] !== rule[1] || !verify || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify.index)) || conditionalOwner(task.slice(0, verify.index)) || approvalPending(task.slice(0, verify.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify.index)))) continue;
        const id = match[1]!;
        // Preserve a quoted status word on a current subject, while still
        // ignoring quoted historical sentences and foreign suite withdrawals.
        const assessment = (value: string) => unquoted(value.replace(new RegExp(
          `(\\b(?:${id}(?: (?:verification|baseline verification|rerun))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“](withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)["”]`, 'gi'), '$1$2'));
        const inactive = (value: string) => {
          const body = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
          return withdrawn(body, id) || /\b(?:this|the) (?:suite|requirement) (?:is|was|has been) (?:superseded|not current|no longer current)\b/i.test(body);
        };
        const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification|rerun))? (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\\b`, 'i');
        const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'i');
        const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“]?(?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)["”]?\\s*\\|`, 'im');
        if (inactive(task) || current.some(s => {
          const value = assessment(s.body.join('\n'));
          return statusRow.test(s.body.join('\n')) || cancelled.test(value) || /\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer required)\b/i.test(value) ||
            value.split(/\n|[.!?]\s+/).some(line => changedFirst.test(line.trim()));
        })) continue;
        return true;
      }
    }
  }

  // A mandatory current-output baseline can land before all other tasks.
  // This obligation does not imply an identical suite on the flag-on path:
  // a plan may specify its rollout parity check separately.
  for (const section of current.filter(s => /^CRITICAL [—–-] regression \(mandatory, REGRESSION RULE\)$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /^legacyAuthFlow\(\) is (?:live|existing|current) behavior being (?:changed|modified|refactored) with no covering test(?: \([^()!?]{1,120}\))?\. Before any (?:rewrite|refactor|change): ([A-Za-z][\w/.-]*\.test\.[jt]s) (?:records|captures|pins) (?:current|existing) outputs \(including quirks\) for [^.!?]{1,300} inputs\. This suite runs against the legacy path now\b/.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0]) || withdrawn(body) ||
        extractionSourceOwner(body) || approvalPending(body) || /\b(?:if|unless|maybe|might|could|optional|hypothetical|unproven)\b/i.test(body)) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
      const prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || approvalPending(prefix) || /\b(?:if|unless|assuming|provided|optional|hypothetical|unproven)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] CRITICAL regression: characterization suite for legacyAuthFlow\(\) (?:current|existing|prior) behavior[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: ([^\n]+)$/gm)];
        const verify = verifies[0];
        const preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || files.length !== 1 || files[0]![1] !== rule[1] || verifies.length !== 1 ||
            !/^suite green against unmodified legacy before any other task merges[\t ]*$/.test(verify![1]!) ||
            !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index)))) continue;
        const id = match[1]!;
        const status = '(?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer current|not required|no longer required)';
        // Current scalar statuses retain their owner; whole-sentence quoted
        // history and conditional future statuses cannot cancel this baseline.
        const assessment = (value: string) => unquoted(value.replace(new RegExp(
          `((?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:verification|baseline verification))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
          .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
        const inactive = (value: string) => {
          const body = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
          return withdrawn(body, id) || new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(body);
        };
        const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification))? (?:is|was|has been) ${status}\\b`, 'i');
        const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
        const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
        if (inactive(body) || inactive(task) || current.some(s => {
          const value = assessment(s.body.join('\n'));
          return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
            new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(value);
        })) continue;
        return true;
      }
    }
  }

  // A directory-owned characterization task can name changed worktree steps
  // in its baseline check, with the baseline's own lane merging first.
  for (const section of current.filter(s => /^Tests(?: \([^\n)]+\))?$/.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /^CRITICAL regression suite \(mandatory, IRON RULE\)\. legacyAuthFlow\(\) is existing behavior being rewritten and the original plan had no regression coverage\. Before any rewrite, write a characterization suite that pins current behavior: [^.!?]{1,300}\. The suite runs against both the legacy path and the new flow \(via the flag\) for the whole rollout window\./.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0]) || withdrawn(body) ||
        /\b(?:if|unless|maybe|might|could|optional|hypothetical|unproven)\b/i.test(rule[0])) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/), prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) || extractionSourceOwner(prefix) ||
          approvalPending(prefix) || /\b(?:if|unless|assuming|provided|optional|hypothetical|unproven)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] ([A-Za-z][\w/-]*) [—–-] Write the CRITICAL characterization suite for legacyAuthFlow\(\) before any rewrite; run it against legacy and new flow[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: suite green on legacy path before (S[1-9]\d*)\/(S[1-9]\d*) land; green on both paths after[\t ]*$/gm)];
        const verify = verifies[0], preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || files.length !== 1 || files[0]![1] !== `${match[2]}/, router flag stub` || verifies.length !== 1 ||
            (task.match(/^\s+- Verify:/gm)?.length ?? 0) !== 1 || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index)))) continue;
        for (const strategy of current.filter(s => s.title === 'Worktree parallelization strategy')) {
          const schedule = unquoted(strategy.body.join('\n'));
          const steps = [...schedule.matchAll(/^\| (S[1-9]\d*)\b/gm)].map(row => row[1]);
          if (steps.length !== new Set(steps).size) continue;
          const baseline = /^\| (S[1-9]\d*) Regression suite for legacyAuthFlow\(\) \| ([A-Za-z][\w/-]*) \| [—–-] \|$/m.exec(schedule);
          const lanes = baseline ? [...schedule.matchAll(new RegExp(`^\\s*Lane ([A-Z]): ${baseline[1]} \\(independent\\)$`, 'gm'))] : [];
          const lane = lanes.length === 1 ? lanes[0] : undefined;
          const order = lane && new RegExp(`^Execution order: launch [A-Z](?:, [A-Z])+ in parallel worktrees\\. Merge ${lane[1]} first \\(it is\\s+pure tests and gates the rewrite\\)\\.`, 'm').exec(schedule);
          if (!baseline || baseline[2] !== match[2] || !lane || !order || verify![1] === verify![2] ||
              !new RegExp(`^\\| ${verify![1]} AuthBroker \\+ SessionMint \\| [^|]+ \\| [^|]+ \\|$`, 'm').test(schedule) ||
              !new RegExp(`^\\| ${verify![2]} Flattened dispatcher \\+ flag router \\+ fallback \\| [^|]+ \\| [^|]+ \\|$`, 'm').test(schedule) ||
              extractionSourceOwner(schedule.slice(0, order.index)) || conditionalOwner(schedule.slice(0, order.index)) || approvalPending(schedule.slice(0, order.index)) ||
              !snapshotSource.includes(order[0].replace(/\s+/g, ' '))) continue;
          const id = `(?:${match[1]}|${baseline[1]})`, status = '(?:withdrawn|rejected|cancelled|canceled|superseded|optional|not current|no longer current|not required|no longer required)';
          const assessment = (value: string) => unquoted(value.replace(new RegExp(
            `((?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${id}(?: (?:verification|baseline verification))?|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
            .replace(/(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’/g, '')
            .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
          const inactive = (value: string) => {
            const text = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
            return withdrawn(text, id) || new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(text);
          };
          const cancelled = new RegExp(`\\b${id}(?: (?:verification|baseline verification))? (?:is|was|has been) ${status}\\b`, 'i');
          const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
          const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
          if (inactive(body) || inactive(task) || current.some(s => {
            const value = assessment(s.body.join('\n'));
            return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
              new RegExp(`\\b(?:the|this) (?:legacy (?:regression|characterization) (?:suite|tests?|requirement)|(?:baseline|unchanged-code) verification) (?:is|was|has been) ${status}\\b`, 'i').test(value);
          })) continue;
          return true;
        }
      }
    }
  }

  // A blocking declaration can bind its task to the first ordered step:
  // characterize both existing entry points before any implementation changes.
  for (const section of current.filter(s => /^REGRESSION \(CRITICAL, mandatory under the regression rule, no question asked\)$/i.test(s.title))) {
    const body = unquoted(section.body.join(' ')).replace(/\s+/g, ' ').trim();
    const rule = /(?:^|\. )(T[1-9]\d*) is a blocking requirement: before any rewrite, (?:capture|record|pin) the current behavior of legacyAuthFlow\(\) and validateAndDispatch\(\) as a characterization suite: every accepted token shape, every rejected token shape, every error response, for at least (?:two|[2-9]\d*) tenants\. The same suite runs against the AuthBroker path behind the flag and must produce identical outcomes\b/.exec(body);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0].trim()) ||
        extractionSourceOwner(body) || conditionalOwner(body) || approvalPending(body)) continue;
    const id = rule[1]!;
    const status = '(?:withdrawn|rejected|declined|cancelled|canceled|superseded|deferred|optional|not current|no longer current|not required|no longer required)';
    const taskSubject = `${id}(?: (?:baseline requirement|verification|baseline verification|regression tests?))?`;
    const assessment = (value: string) => unquoted(value.replace(new RegExp(
      `((?:^|[.!?]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${taskSubject}|(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization) )?(?:suite|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
      .split(/\n|[.!?]\s+/).filter(line => !conditionalOwner(line) && !approvalPending(line) && !/^\s*(?:assuming|provided)\b/i.test(line)).join('\n');
    const cancelled = new RegExp(`\\b${taskSubject} (?:is|was|has been) ${status}\\b`, 'i');
    const inactive = (value: string) => {
      const owned = assessment(value).replace(/\b(?:this|the)\s+(?:(?:unchanged-code|baseline)\s+)?verification\b/gi, 'this requirement');
      return withdrawn(owned, id) || cancelled.test(owned) ||
        new RegExp(`\\b(?:this|the) (?:suite|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(owned);
    };
    const statusRow = new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im');
    const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'im');
    if (inactive(body) || current.some(s => {
      const value = assessment(s.body.join('\n'));
      return statusRow.test(s.body.join('\n')) || cancelled.test(value) || changedFirst.test(value) ||
        new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|was|has been) ${status}\\b`, 'i').test(value);
    })) continue;
    const baseline = current.some(s => {
      if (s.title !== 'Implementation steps (ordered)') return false;
      const schedule = unquoted(s.body.join('\n')).trim();
      const first = new RegExp(`^1\\. ${id} Characterization suite for legacyAuthFlow\\(\\) and validateAndDispatch\\(\\)\\. Green on current code before anything else changes\\.[\\t ]*(?:\\n|$)`).exec(schedule);
      return Boolean(first && !inactive(schedule) && snapshotSource.includes(first[0].replace(/\s+/g, ' ').trim()));
    });
    if (!baseline) continue;
    for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/), prefix = blocks[0]?.trim() ?? '';
      if (!taskBody.startsWith('- ') && (!/^Synthesized from (?:this|the) review's findings\./.test(prefix) ||
          extractionSourceOwner(prefix) || conditionalOwner(prefix) || approvalPending(prefix) ||
          /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(prefix)))) continue;
      const ids = blocks.map(block => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(block)?.[1]).filter(Boolean);
      if (ids.length !== new Set(ids).size) continue;
      for (const task of blocks) {
        const match = /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] [A-Za-z][\w/-]* [—–-] Write the characterization\/regression suite for legacyAuthFlow\(\) and validateAndDispatch\(\) before any rewrite \(CRITICAL\)[\t ]*(?:\n|$)/.exec(task);
        const files = [...task.matchAll(/^\s+- Files: [^,\n]+, (?:tests?|__tests__)\/[A-Za-z][\w/.-]*[\t ]*$/gm)];
        const verifies = [...task.matchAll(/^\s+- Verify: suite green on current code; later green on both flag states[\t ]*$/gm)];
        const verify = verifies[0], preceding = unquoted(taskBody.slice(0, taskBody.indexOf(task))).trim().split('\n').at(-1) ?? '';
        if (!match || match[1] !== id || files.length !== 1 || verifies.length !== 1 ||
            (task.match(/^\s+- Verify:/gm)?.length ?? 0) !== 1 || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim()) ||
            extractionSourceOwner(preceding) || conditionalOwner(preceding) || approvalPending(preceding) ||
            extractionSourceOwner(task.slice(0, verify!.index)) || conditionalOwner(task.slice(0, verify!.index)) || approvalPending(task.slice(0, verify!.index)) ||
            /(?:^|\n)\s*(?:assuming|provided)\b/i.test(unquoted(task.slice(0, verify!.index))) || inactive(task)) continue;
        return true;
      }
    }
  }

  // A required-test item may own the named legacy oracle while a separate
  // parity item and task preserve its compatibility obligation. Bind these
  // small obligations structurally; unrelated prose cannot complete the chain.
  for (const section of current.filter(s => /^Required tests(?: \([^\n]*\))?$/i.test(s.title))) {
    const blocks = section.body.join('\n').trim().split(/\n\s*\n/);
    for (const block of blocks) {
      const claim = block.replace(/\s+/g, ' ').trim();
      const rule = /^CRITICAL\s*\([^)]*\bmandatory\b[^)]*\):\s*([A-Za-z][\w/.-]*\.test\.[jt]s)\./i.exec(claim);
      if (!rule || /\b(?:not|never|no longer)\s+mandatory\b/i.test(rule[0]) || !/^\s*(?:Pin|Capture|Record) current behavior of legacyAuthFlow\(\) before any (?:change|rewrite|refactor):/i.test(claim.slice(rule[0].length))
          || !/\bThis is the oracle for the parity suite\b/i.test(claim) || !snapshotSource.includes(claim)) continue;
      const quoteFree = (value: string) => value.replace(/"[^"\n]*"|“[^”\n]*”|(?<![\w])'[^'\n]*'(?![\w])|‘[^’\n]*’/g, '');
      const inactiveWords = '(?:withdrawn|rejected|declined|cancelled|canceled|superseded|deferred|optional|proposed|not current|no longer current|not required|no longer required|hypothetical|unproven)';
      const subject = '(?:(?:this|the) (?:(?:legacy|baseline|unchanged-code) )?(?:(?:regression|characterization|parity) )?(?:suite|tests?|requirement|verification|oracle))';
      const currentText = (value: string, ids: string) => quoteFree(value.replace(new RegExp(
        `((?:^|[.!?;]\\s+|\\n)[\\t ]*(?:Correction:\\s*)?(?:${ids}|${subject}) (?:is|are|was|were|has been|have been) )["“'‘](${inactiveWords})["”'’]`, 'gim'), '$1$2'));
      // Input conditions describe asserted behavior, including accepted tokens.
      // An implicit approval or an explicit work/approver subject instead
      // governs whether this work exists.
      const conditionalApproval = /(?:^|[.!?;]\s+|\n)[\t ]*(?:if|unless|assuming|provided|once|when|pending|after)\s+(?:(?:approv\w*|authoriz\w*|consent|confirm\w*|accept\w*|desired|requested|needed)\b|(?:(?:this|the|our) )?(?:work|plan|review|task|baseline|parity|regression|characterization|suite|tests?|requirement|verification|proposal|implementation|T[1-9]\d*|we|you|they|reviewer|owner|user)\b[^.!?;,\n]{0,80}\b(?:approv\w*|authoriz\w*|consent|confirm\w*|accept\w*|desired|requested|needed|proceed)\b)/i;
      const unowned = (value: string) => extractionSourceOwner(value) || /\b(?:proposed|optional|hypothetical|unproven|maybe|might|could)\b/i.test(quoteFree(value)) || conditionalApproval.test(quoteFree(value));
      const inactive = (value: string, ids: string) => unowned(value) || new RegExp(
        `\\b(?:${ids}|${subject}) (?:is|are|was|were|has been|have been) ${inactiveWords}\\b|\\b(?:skip|defer|omit) (?:the |this )?(?:baseline|regression|characterization|parity) (?:test|suite|verification)`, 'i').test(currentText(value, ids));
      if (inactive(block, 'T[1-9]\\d*')) continue;
      for (const parityBlock of blocks) {
        const parity = parityBlock.replace(/\s+/g, ' ').trim();
        const comparison = /^Decision [1-9]\d*[A-D], parity suite:\s*([A-Za-z][\w/.-]*\.test\.[jt]s)\./i.exec(parity);
        if (!comparison || inactive(parityBlock, 'T[1-9]\\d*') || !snapshotSource.includes(parity)
            || !/^\s*(?:One|The same) fixture table, each row run through both paths \(flag off, flag on\), assert identical outcomes?\b/i.test(parity.slice(comparison[0].length))) continue;
        for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
          const taskBody = tasks.body.join('\n').trim(), taskBlocks = taskBody.split(/\n(?=-\s)/);
          const rows = taskBlocks.map(body => ({ body, match: /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] ([^\n]+)(?:\n|$)/.exec(body) })).filter(row => row.match);
          if (rows.length !== new Set(rows.map(row => row.match![1])).size) continue;
          const field = (body: string, name: string) => {
            const found = [...body.matchAll(new RegExp(`^  - ${name}: ([^\\n]+)$`, 'gm'))];
            return found.length === 1 ? found[0]![1] : undefined;
          };
          // Match the asserted action after its component label. A later
          // positive test phrase cannot override a leading "Do not write".
          const taskAction = (title: string) => /^[^\n]*?\s+[—–-]\s+(.+)$/.exec(title)?.[1] ?? title;
          const ownedTask = (body: string) => {
            // Source quotations identify the finding but cannot grant or revoke
            // its separately asserted action or verification.
            const action = body.replace(/^  - Surfaced by:.*$/gm, '');
            const preceding = taskBody.slice(0, taskBody.indexOf(body)).trim().split('\n').at(-1) ?? '';
            return !unowned(action) && !unowned(preceding) && snapshotSource.includes(body.replace(/\s+/g, ' ').trim());
          };
          for (const baseline of rows) {
            const title = baseline.match![2]!, id = baseline.match![1]!;
            if (!/^(?:(?:Write|Add|Create) (?:the )?)?CRITICAL (?:regression|characterization) tests? (?:pinning|capturing|recording) current legacyAuthFlow\(\) behavior before any (?:change|rewrite|refactor)\b/i.test(taskAction(title))
                || field(baseline.body, 'Files') !== rule[1] || !ownedTask(baseline.body)
                || !/^(?:test|suite) passes against (?:unmodified|unchanged|untouched) legacyAuthFlow\(\) (?:first|before any (?:change|rewrite|refactor))$/i.test(field(baseline.body, 'Verify') ?? '')) continue;
            for (const next of rows) {
              const nextId = next.match![1]!;
              if (nextId === id || field(next.body, 'Files') !== comparison[1] || !ownedTask(next.body)
                  || !/^(?:(?:Write|Add|Implement) (?:the )?)?(?:Table-driven )?parity suite running each fixture row through flag-off and flag-on paths\b/i.test(taskAction(next.match![2]!))
                  || !/^suite green for every row\b/i.test(field(next.body, 'Verify') ?? '')) continue;
              const ids = `(?:${id}|${nextId})(?: (?:baseline requirement|baseline verification|verification|rerun))?`;
              if ([block, parityBlock, baseline.body, next.body].some(value => inactive(value.replace(/^  - Surfaced by:.*$/gm, ''), ids))) continue;
              const cancelled = new RegExp(`\\b${ids} (?:is|was|has been) ${inactiveWords}\\b`, 'i');
              const changedFirst = new RegExp(`^(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored) before ${id}\\b`, 'i');
              const withdrawn = current.some(s => {
                if (/\b(?:history|historical|source|quoted|example)\b/i.test(s.title)) return false;
                const body = s.body.join('\n');
                if (new RegExp(`^\\s*\\|\\s*(?:${id}|${nextId})\\s*\\|\\s*["“'‘]?${inactiveWords}["”'’]?\\s*\\|`, 'im').test(body)) return true;
                return currentText(body, ids).split(/\n|[.!?;]\s+/).some(line => !extractionSourceOwner(line) && !/\b(?:if|unless|assuming|provided)\b|\b(?:once|when|pending|after)\b[^.!?\n]{0,50}\bapprov/i.test(line) && (cancelled.test(line) || changedFirst.test(line.trim())
                  || new RegExp(`\\b(?:the|this) legacy (?:regression|characterization) (?:suite|tests?|requirement) (?:is|are|was|were|has been|have been) ${inactiveWords}\\b`, 'i').test(line)));
              });
              if (!withdrawn) return true;
            }
          }
        }
      }
    }
  }

  // A bold inline regression rule may bind two test files through a table
  // and one task: the recorded legacy baseline and its same-fixture parity.
  for (const section of current.filter(s => s.title === 'Tests')) {
    const body = section.body.join('\n');
    const paragraphs = body.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim());
    const rule = paragraphs.map(p => /^REGRESSION RULE \(mandatory, no decision required\): legacyAuthFlow\(\) is existing behavior being modified with no covering test(?: \([^()!?]{1,120}\))?\. A regression test is a CRITICAL requirement of this plan: (?:record|capture|pin) legacyAuthFlow\(\) outputs on a fixture set covering [^.!?]{1,300}, before any rewrite begins\. A parity test then runs the same fixtures through ([A-Za-z][\w]*) and asserts identical results\. Both live until the legacy path is deleted\.$/.exec(p)).find(Boolean);
    if (!rule || suiteWithdrawn || !snapshotSource.includes(rule[0])) continue;
    const conditional = /(?:^|[.!?;]\s+|\n)\s*(?:if|unless|once|when|assuming|provided|pending)\s+(?:(?:approv\w*|authoriz\w*|accept\w*|requested)\b|(?:this work|the requirement|we|you|the reviewer)\b[^.!?;\n]{0,80}\b(?:approv\w*|authoriz\w*|accept\w*)\b)/i;
    const status = '(?:withdrawn|rejected|cancelled|canceled|superseded|deferred|optional|proposed|not current|no longer current|not required|no longer required)';
    const assessment = (value: string, id: string) => unquoted(value.replace(new RegExp(
      `((?:^|[.!?;]\\s+|\\n)\\s*(?:Correction:\\s*)?(?:${id}(?: baseline verification)?|(?:this|the) (?:(?:legacy|baseline) )?(?:(?:regression|parity) )?(?:suite|test|requirement|verification)) (?:is|was|has been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'))
      .replace(/(?<!\w)'[^'\n]*'(?!\w)|‘[^’\n]*’/g, '');
    const inactive = (value: string, id: string, global = false) => {
      const text = assessment(value, id);
      const subject = global ? `${id}(?: baseline verification)?|(?:this|the) legacy (?:regression|parity) (?:suite|test|requirement)`
        : `${id}(?: baseline verification)?|(?:this|the) (?:(?:legacy|baseline) )?(?:(?:regression|parity) )?(?:suite|test|requirement|verification)`;
      return new RegExp(`(?:^|[.!?;]\\s+|\\n)\\s*(?:Correction:\\s*)?(?:${subject}) (?:is|was|has been) ${status}\\b`, 'i').test(text)
        || new RegExp(`(?:^|[.!?;]\\s+|\\n)\\s*(?:Correction:\\s*)?(?:do not|don't|never|skip|defer|cancel|withdraw) (?:run |execute |implement )?(?:${subject})\\b`, 'i').test(text)
        || new RegExp(`^\\s*\\| ${id} \\| ${status} \\|`, 'im').test(text)
        || new RegExp(`(?:^|\\n)(?:Correction:\\s*)?legacyAuthFlow\\(\\) is (?:changed|rewritten|modified) before ${id}\\b`, 'i').test(text);
    };
    const framed = (value: string) => extractionSourceOwner(value) || conditional.test(assessment(value, 'T[1-9]\\d*'));
    if (framed(body) || inactive(body, 'T[1-9]\\d*')) continue;
    for (const table of current.filter(s => s.title === 'Tests to add (every GAP above)')) {
      const text = table.body.join('\n');
      const baseline = /^\| ([A-Za-z][\w/.-]*\.test\.[jt]s) \| unit, CRITICAL \| recorded fixture outputs unchanged \|$/m.exec(text);
      const parity = new RegExp(`^\\| ([A-Za-z][\\w/.-]*\\.test\\.[jt]s) \\| integration, CRITICAL \\| legacy and ${rule[1]} agree on every fixture \\|$`, 'm').exec(text);
      if (!baseline || !parity || framed(text) || inactive(text, 'T[1-9]\\d*') ||
          !snapshotSource.includes(baseline[0]) || !snapshotSource.includes(parity[0])) continue;
      for (const tasks of current.filter(s => s.title === 'Implementation Tasks')) {
        const taskBody = tasks.body.join('\n').trim(), blocks = taskBody.split(/\n(?=-\s)/);
        const ids = blocks.map(b => /^- (?:\[[ xX]\] )?(T[1-9]\d*)\b/.exec(b)?.[1]).filter(Boolean);
        if (ids.length !== new Set(ids).size) continue;
        for (const task of blocks) {
          const match = new RegExp(`^- (?:\\[[ xX]\\] )?(T[1-9]\\d*)(?: \\([^\\n)]*\\))? [—–-] tests [—–-] CRITICAL regression fixtures for legacyAuthFlow\\(\\) and parity test against ${rule[1]}[\\t ]*(?:\\n|$)`).exec(task);
          if (!match) continue;
          const files = [...task.matchAll(/^\s+- Files: ([^\n]+)$/gm)], verifies = [...task.matchAll(/^\s+- Verify: ([^\n]+)$/gm)];
          const names = files[0]?.[1]?.split(', ').sort();
          const before = taskBody.slice(0, taskBody.indexOf(task)).trim().split('\n').at(-1) ?? '';
          if (files.length !== 1 || verifies.length !== 1 || JSON.stringify(names) !== JSON.stringify([baseline[1], parity[1]].sort()) ||
              verifies[0]![1] !== 'both suites green before and after the rewrite' || framed(before) || framed(task) ||
              inactive(task, match[1]!) || !snapshotSource.includes(task.replace(/\s+/g, ' ').trim())) continue;
          if (!current.some(s => inactive(s.body.join('\n'), match[1]!, true))) return true;
        }
      }
    }
  }

  // A required test-table row can own a parity contract through an approved
  // decision and one task. Its lane records the unchanged legacy oracle first,
  // then adds the new implementation; rollout waits for both to pass.
  const fieldValues = (body: string, field: string) => [...body.matchAll(new RegExp(`^${field}: ([^\\n]+)$`, 'gm'))].map(m => m[1]!);
  const outcomes = (value: string) => value.split(',').map(item => item.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/ id$/, ''));
  const sameInventory = (a: string[], b: string[]) => a.length > 1 && a.length === b.length && new Set(a).size === a.length &&
    new Set(b).size === b.length && a.every(item => item && b.includes(item));
  const framedParity = (body: string) => sourceFrame(body) || extractionSourceOwner(body) ||
    /(?:^|[.!?;]\s+|\n)\s*(?:if|unless|assuming|provided|pending)\b/i.test(unquoted(body));
  for (const tests of current.filter(s => /^Tests(?: \([^\n]*\))?$/i.test(s.title))) {
    for (const table of marked.lexer(tests.body.join('\n'))) {
      if (table.type !== 'table') continue;
      const column = (name: string) => table.header.flatMap((cell, index) => cell.text.toLowerCase() === name ? [index] : []);
      const columns = [column('decision'), column('test file'), column('asserts')];
      if (columns.some(indices => indices.length !== 1)) continue;
      for (const row of table.rows) {
        const decision = /^(D[1-9]\d*) CRITICAL$/.exec(row[columns[0]![0]!]!.text)?.[1];
        const file = row[columns[1]![0]!]!.text, assertion = row[columns[2]![0]!]!.text;
        const cases = /^parity suite:\s*([^;]+);/i.exec(assertion)?.[1];
        const target = /\bparameterized over legacyAuthFlow\(\) and ([A-Za-z][\w]*)\b/.exec(assertion)?.[1];
        if (!decision || !cases || !target || !/^[A-Za-z][\w/.-]*\.test\.[jt]s$/.test(file) ||
            !/\basserts outcome \+ cache key written\b/.test(assertion) || !/\bboth green before any tenant is allowlisted\b/.test(assertion) ||
            framedParity(assertion) || withdrawn(assertion)) continue;
        const expected = outcomes(cases), basename = file.split('/').at(-1)!;
        const records = current.filter(s => /^R[1-9]\d*: legacyAuthFlow\(\) regression contract$/.test(s.title) &&
          new RegExp(`^Question ${decision}:`, 'm').test(s.body.join('\n')));
        if (records.length !== 1) continue;
        const record = records[0]!, recordId = record.title.split(':')[0]!, body = unquoted(record.body.join('\n'));
        const finding=fieldValues(body,'Finding'), baseline=fieldValues(body,'Plan baseline'), state=fieldValues(body,'State');
        const answer=fieldValues(body,'Actual answer'), scope=fieldValues(body,'Accepted scope'), question=fieldValues(body,'Question '+decision);
        if ([finding,baseline,state,answer,scope,question].some(values=>values.length!==1) || state[0]!=='approved' ||
            !/\bCRITICAL\b/.test(finding[0]!) || !/(?<![\w./-])PLAN\.md:[1-9]\d*/.test(finding[0]!) ||
            /(?:[\w.-]+\/)+PLAN\.md|(?<![\w./-])(?!PLAN\.md\b)[\w.-]+\.md\b/.test(finding[0]!) ||
            !/\blegacyAuthFlow\(\)/.test(baseline[0]!) || !/\bunchanged code\b/.test(baseline[0]!) ||
            framedParity(body) || withdrawn(body,recordId)) continue;
        const options=question[0]!.split(/\s+\/\s+/).map(label=>label.replace(/\s*\(recommended\)$/, ''));
        const selected=options.filter(label=>answer[0]!.startsWith(label+' '));
        const acceptedCases=/\bscenarios \(([^)]+)\) asserting outcome \+ cache key written\b/.exec(scope[0]!);
        if (options.length<2 || options.length>4 || new Set(options).size!==options.length || selected.length!==1 ||
            !/\bparity suite\b/i.test(selected[0]!) || !answer[0]!.endsWith(`(D${decision.slice(1)})`) ||
            !answer[0]!.includes(`legacy AND ${target}`) || !acceptedCases || !sameInventory(expected,outcomes(acceptedCases[1]!)) ||
            !scope[0]!.startsWith(basename+' with ') || !scope[0]!.includes(`parameterized over legacyAuthFlow() and ${target}.`) ||
            !/\bBoth must pass before any tenant enters [A-Z][A-Z0-9_]*\./.test(scope[0]!) ||
            !/\bIntentional differences: none in this PR\./.test(scope[0]!) || framedParity(scope[0]!)) continue;
        const comparisons=marked.lexer(body).filter(token=>token.type==='table');
        const oracles=comparisons.flatMap(table=>{
          if(table.type!=='table')return [];
          const labels=table.header.filter(header=>/^[A-D]$/.test(header.text)).map(header=>header.text);
          if(labels.length!==options.length||new Set(labels).size!==labels.length)return [];
          const shape=table.rows.filter(row=>row[0]?.text===recordId+' test shape'), assertions=table.rows.filter(row=>row[0]?.text==='Acceptance assertions');
          if(shape.length!==1||assertions.length!==1)return [];
          return table.header.flatMap((header,index)=>/^[A-D]$/.test(header.text)&&
            shape[0]![index]!.text.includes(basename)&&shape[0]![index]!.text.includes(`run against legacyAuthFlow() now and ${target} (both must pass)`)&&
            /^identical outcome \+ identical cache key written for each scenario, both impls$/.test(assertions[0]![index]!.text)?[header.text]:[]);
        });
        if(oracles.length!==1 || oracles[0]!==String.fromCharCode(65+options.indexOf(selected[0]!)))continue;
        for (const tasks of current.filter(s=>s.title==='Implementation Tasks')) {
          const taskBody=tasks.body.join('\n'), blocks=taskBody.split(/\n(?=-\s)/);
          const ids=blocks.flatMap(block=>/^-(?: \[[ xX]\])? (T[1-9]\d*)\b/.exec(block)?.[1]??[]);
          if(new Set(ids).size!==ids.length)continue;
          for(const task of blocks){
            const id=/^-(?: \[[ xX]\])? (T[1-9]\d*)\b/.exec(task)?.[1];
            const first=task.split('\n')[0]!,files=fieldValues(task,'  - Files'),verify=fieldValues(task,'  - Verify'),source=fieldValues(task,'  - Surfaced by');
            const count=verify.length===1?/^(one|two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) scenarios green for both implementations before any tenant is allowlisted$/i.exec(verify[0]!):null;
            const n=count?(/^\d+$/.test(count[1]!)?Number(count[1]):'zero one two three four five six seven eight nine ten'.split(' ').indexOf(count[1]!.toLowerCase())):0;
            if(!id || files.length!==1 || source.length!==1 || !source[0]!.includes(`CRITICAL (${decision})`) || n!==expected.length ||
                !first.endsWith(`Write ${basename} parameterized over legacyAuthFlow() and ${target}`) ||
                !(files[0]===file || new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} \\(or [A-Za-z][\\w/-]*/\\)$`).test(files[0]!)) ||
                framedParity(task) || withdrawn(task,id))continue;
            const ordered=current.some(s=>/\b(?:parallelization|worktree|execution|schedule)\b/i.test(s.title) &&
              s.body.some(line=>{
                const lane=new RegExp(`^- Lane [A-Z]: ${id} parity suite written against legacyAuthFlow\\(\\) \\(independent: [^)]*\\), then parameterized over ${target} after Lane [A-Z]'s (T[1-9]\\d*) merges$`).exec(line);
                return lane&&lane[1]!==id&&blocks.some(dependency=>new RegExp(`^- (?:\\[[ xX]\\] )?${lane[1]}\\b`).test(dependency)&&
                  new RegExp(`\\b${target}\\b`).test(dependency.split('\n')[0]!)&&fieldValues(dependency,'  - Files').some(value=>value.includes(`/${target}.ts`)));
              }) &&
              !framedParity(s.body.join('\n')) && !withdrawn(s.body.join('\n'),id));
            if(!ordered || suiteWithdrawn)continue;
            const status='(?:withdrawn|rejected|cancelled|canceled|superseded|deferred|optional|not current|no longer current|not required|no longer required)';
            const owner=`(?:${id}|${decision}|${recordId}|(?:the|this) legacy (?:parity|regression|characterization) (?:suite|tests?|requirement)|(?:the|this) baseline verification)`;
            const inactive=current.some(s=>{
              const raw=s.body.join('\n').replace(new RegExp(`(${owner} (?:is|are|was|were|has been|have been) )["“'‘](${status})["”'’]`,'gi'),'$1$2');
              return unquoted(raw).split(/\n|[.!?;]\s+/).some(line=>!sourceFrame(line)&&
                (new RegExp(`\\b${owner} (?:is|are|was|were|has been|have been) ${status}\\b`,'i').test(line) ||
                 new RegExp(`\\blegacyAuthFlow\\(\\) (?:is|will be) (?:changed|modified|rewritten) before ${id}\\b`,'i').test(line)));
            });
            if(!inactive)return true;
          }
        }
      }
    }
  }
  return hasRetainedLegacyCorpus(current, snapshotSource)
    || !suiteWithdrawn && hasScheduledLegacyRegression(current, snapshotSource);
}

/** Bind a required test file to its task and a baseline run before changing the legacy code. */
function hasScheduledLegacyRegression(current: ReadonlyArray<{ title: string; body: string[] }>, snapshot: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  const unquoted = (s: string) => s.replace(/"[^"]*"|“[^”]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’]*’/g, '');
  const framed = (s: string) => /(?:^|\n)\s*(?:source|quoted|historical|example|if approved|once approved|when approved|pending approval|assuming approval|provided approval)\b/i.test(unquoted(s));
  const inactive = '(?:withdrawn|rejected|cancelled|canceled|deferred|optional|proposed|hypothetical|unproven|superseded|not current|no longer current|not required|no longer required|conditional on approval)';
  const approval = /\b(?:if|when|once|unless) approved|\b(?:after|pending|assuming|provided) approval\b|(?:^|\n|:\s*)(?:if|when|once|unless) accepted\b/i;
  const owned = (s: string) => snapshot.includes(flat(s)) && !framed(s)
    && !approval.test(unquoted(s))
    && !/\b(?:do not|don\x27t|never|skip|omit|defer) (?:add|write|run|capture|record|pin|implement)\b|\b(?:maybe|might|could|optional|proposed)\b/i.test(unquoted(s));
  const allTasks = current.flatMap(s => {
    const text = s.body.join('\n');
    return text.split(/\n(?=- )/).map(body => ({ body, section: s.title,
      preceding: text.slice(0, text.indexOf(body)).trim().split('\n').at(-1) ?? '',
      match: /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–:-] (.+)(?:\n|$)/.exec(body) }));
  });
  // A source-owned approved row may publish a before-change characterization
  // corpus while its task carries the legacy component, file and green run.
  // Those fields form one requirement; the action need not repeat the target.
  const values = (body: string, name: string) => [...body.matchAll(new RegExp(
    `^${name}:\\s*([^]*?)(?=^(?:  - )?[A-Z][\\w /-]*:|$(?![^]))`, 'gm'))].map(m => flat(m[1]!));
  const number = (value: string) => /^\d+$/.test(value) ? Number(value) : 'zero one two three four five six seven eight nine ten'.split(' ').indexOf(value.toLowerCase());
  for (const record of current) {
    const row = /^([A-Z][1-9]\d*): (?:Regression coverage|Characterization tests?|Regression contract) for legacyAuthFlow\(\)(?: current (?:behavior|outcomes))?$/i.exec(record.title)?.[1];
    if (!row || current.filter(s=>s.title.startsWith(row+':')).length!==1) continue;
    const rawBody=record.body.join('\n'), body = unquoted(rawBody);
    const finding=values(body,'Finding'), state=values(body,'State'), answer=values(body,'Actual answer'), scope=values(body,'Accepted scope');
    const questions=[...body.matchAll(/^Question (D[1-9]\d*):\s*([^]*?)(?=^Actual answer:)/gm)];
    const sourceFinding=values(rawBody,'Finding').join(' ');
    if ([finding,state,answer,scope].some(v=>v.length!==1) || questions.length!==1 || state[0]!=='approved'
        || !/\bCRITICAL\b/.test(finding[0]!) || !/\bcoverage is required\b/i.test(finding[0]!)
        || !/(?<![\w./-])PLAN\.md:[1-9]\d*/.test(finding[0]!)
        || /(?:[\w.-]+\/)+PLAN\.md|(?<![\w./-])(?!PLAN\.md\b)[\w.-]+\.md\b/.test(sourceFinding)
        || framed(body) || !owned(scope[0]!)) continue;
    const decision=questions[0]![1]!, chosen=/^([A-D])\s+[—–-]\s+characterization\b/i.exec(answer[0]!)?.[1];
    const offered=[...flat(questions[0]![2]!).matchAll(/\b([A-D])\) (.*?)(?=;\s*[A-D]\)|\s+Completeness:|$)/g)];
    const selected=offered.filter(m=>m[1]===chosen);
    if (offered.length<2 || offered.length>4 || new Set(offered.map(m=>m[1])).size!==offered.length || selected.length!==1
        || !/\bcharacterization tests?\b/i.test(selected[0]![2]!) || !owned(selected[0]![2]!)
        || !answer[0]!.endsWith(`(${decision} answer)`)) continue;
    const baseline=/(?:^|\(1\) )([A-Za-z][\w/.-]*\.characterization\.test(?:\.[jt]s)?) (?:pins|records|captures) (?:current|existing|prior) outcomes for: (.+?)\. Written against the legacy (?:body|implementation) BEFORE any (?:delegation|change) is added\b/i.exec(scope[0]!);
    if (!baseline || !/(?:^|\/)legacyAuthFlow\.characterization\.test(?:\.[jt]s)?$/.test(baseline[1]!)) continue;
    const cases=baseline[2]!.split(/,\s*(?![^()]*\))/).map(value=>value.trim());
    if(cases.length<2 || cases.some(value=>!value) || new Set(cases).size!==cases.length)continue;
    for(const task of allTasks.filter(t=>t.section==='Implementation Tasks'&&t.match)) {
      const id=task.match![1]!, title=unquoted(task.match![2]!);
      const action=/^([A-Za-z][\w/-]*\/legacyAuthFlow) [—–] (?:Write|Add|Record|Capture) characterization tests for (?:the )?(one|two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*) input classes against (?:the )?(?:current|unchanged) body, before any other change$/i.exec(title);
      const files=values(task.body,'  - Files'),verify=values(task.body,'  - Verify'),source=values(task.body,'  - Surfaced by');
      if(!action || number(action[2]!)!==cases.length || allTasks.filter(t=>t.match?.[1]===id).length!==1
          || files.length!==1 || verify.length!==1 || source.length!==1
          || !source[0]!.includes(`(${row}/${decision})`) || !owned(task.body) || framed(task.preceding)
          || files[0]!==action[1]+'.characterization.test' || !files[0]!.endsWith('/'+baseline[1]!)
          || !/^(?:suite|tests) (?:green|pass(?:es)?) on (?:unmodified|untouched|unchanged) legacy (?:body|implementation)$/i.test(verify[0]!))continue;
      const currentStatus=`(?:${inactive}|reopened|pending approval|not approved)`;
      const owner=`(?:${id}|${row}|${decision}|(?:this|the) (?:(?:legacy|characterization|regression) )?(?:suite|tests?|requirement|baseline verification))`;
      const cancelled=current.some(section=>{
        if(/\b(?:historical|history|example|quoted)\b/i.test(section.title))return false;
        const foreign=/\bregression suite\b/i.test(section.title)&&! /\blegacy\b/i.test(section.title);
        const raw=section.body.join('\n').replace(new RegExp(`(${owner} (?:is|are|was|were|has been|have been) )["“'‘](${currentStatus})["”'’]`,'gi'),'$1$2');
        return unquoted(raw).split(/\n|[.!?;]\s+/).some(line=>!framed(line)&&(!foreign||new RegExp(`\\b(?:${id}|${row}|${decision}|legacyAuthFlow)\\b`).test(line))&&(
          new RegExp(`\\b${owner} (?:is|are|was|were|has been|have been) ${currentStatus}\\b`,'i').test(line)
          || new RegExp(`\\b(?:skip|cancel|withdraw|defer) ${owner}\\b|\\b(?:change|update|rewrite|replace|regenerate) ${owner} (?:assertions|expectations|expected outcomes)\\b`,'i').test(line)
          || new RegExp(`\\blegacyAuthFlow\\(\\) (?:is|will be) (?:changed|modified|rewritten) before ${id}\\b`,'i').test(line)));
      });
      if(!cancelled)return true;
    }
  }
  // Required test lists may give each suite its own inline label instead of
  // a heading. Keep that bullet's body separate from adjacent test requirements.
  const declarations: Array<{ title: string; body: string[]; inlineRequired?: boolean; ledger?: { row: string; question: string; caseCount: number } }> = [...current];
  for (const section of current.filter(s => /\b(?:required|mandatory) tests?\b/i.test(s.title))) {
    const blocks = section.body.join('\n').split(/\n(?=- )/);
    for (const block of blocks) {
      const match = /^- ((?:CRITICAL|MANDATORY|REQUIRED)\b[^\n]*\b(?:regression|characterization)\b[^\n]*)\n([\s\S]+)$/i.exec(block.trim());
      if (match && !framed(section.title) && owned(block) && !new RegExp(`\\b${inactive}\\b`, 'i').test(unquoted(match[1]!)))
        declarations.push({ title: match[1]!, body: [match[1]!, match[2]!], inlineRequired: true });
    }
  }
  // A required ledger row can publish the selected baseline in Accepted scope.
  // Its finding/rule, offered answer and later task remain separate evidence;
  // an unselected comparison-grid column cannot authorize the requirement.
  for (const section of current) {
    const row = /^([A-Za-z][\w.-]*):/.exec(section.title)?.[1];
    if (!row || !/\blegacyAuthFlow\b/.test(section.title) || !/\bREGRESSION RULE\b/i.test(section.title)) continue;
    const body = section.body.join('\n');
    const fields = (name: string) => [...body.matchAll(new RegExp(`^${name}: ([^\\n]+(?:\\n(?!\\s*$|[A-Z][\\w ]*:|Question\\b|\\|)[^\\n]+)*)`, 'gm'))];
    const scopes = fields('Accepted scope'), answers = fields('Actual answer'), states = fields('State');
    const questions = [...body.matchAll(/^Question (D[1-9]\d*):/gm)];
    if (scopes.length !== 1 || answers.length !== 1 || questions.length !== 1
        || !/^Finding: [^\n]*\bCRITICAL\b/m.test(body) || framed(body)
        || states.some(state => new RegExp(`^(?:${inactive})$`, 'i').test(flat(unquoted(state[1]!))))) continue;
    const question = questions[0]![1]!, answer = flat(unquoted(answers[0]![1]!)), scope = flat(unquoted(scopes[0]![1]!));
    const choice = /^([A-D])[,)]?\s/.exec(answer)?.[1];
    const offered = choice ? [...body.matchAll(new RegExp(`^${choice}\\) ([^\\n]+)$`, 'gm'))] : [];
    if (!choice || offered.length !== 1 || !answer.endsWith(`(${question})`) || !owned(scopes[0]![0])
        || !/\bcharacterization\b/i.test(offered[0]![1]!) || !/\bbefore (?:the )?rewrite\b/i.test(offered[0]![1]!)) continue;
    const capture = /^before (?:any|the) (?:rewrite|refactor|change), (?:capture|record|pin) (?:golden|characterization) tests from (?:the )?(?:running|unmodified|untouched|current) legacyAuthFlow\(\) for:\s*([^.!?]+)\./i.exec(scope);
    const cases = capture?.[1]?.split(/;\s*/).map(value => value.trim()) ?? [];
    if (!capture || cases.length < 2 || new Set(cases).size !== cases.length
        || !/\b(?:Assert|Verify|Check) accept\/reject outcome and error class\/(?:HTTP )?status per case\./i.test(scope)
        || !/\b(?:Replay|Run|Execute) the (?:same )?suite against the new path\./i.test(scope)
        || !/\b(?:add|write) one integration test per caller path\b/i.test(scope)) continue;
    declarations.push({ title: section.title, body: [scopes[0]![0]], ledger: { row, question, caseCount: cases.length } });
  }
  for (const declaration of declarations) {
    const requiredRule = Boolean(declaration.ledger) || /\b(?:mandatory|critical|required)\b/i.test(unquoted(declaration.title));
    if (!/\b(?:regression|characterization)\b/i.test(declaration.title) || !requiredRule
        || /\b(?:not|never|no longer) (?:mandatory|critical|required)\b/i.test(declaration.title) || approval.test(unquoted(declaration.title)) || /\b(?:if|when|once|unless) accepted\b/i.test(unquoted(declaration.title))) continue;
    const body = declaration.body.join('\n').trim(), text = flat(unquoted(body));
    const files = [...text.matchAll(/\b([A-Za-z][\w/.-]*\.test(?:\.[jt]s)?)\b/g)].map(m => m[1]!);
    const beforeAndAfter = /\bmust (?:pass|be green) before and after (?:this|the) (?:refactor|rewrite|change)\b/i.test(text);
    if (!owned(body) || !/\blegacyAuthFlow\b/.test(declaration.title + ' ' + text)
        || !beforeAndAfter && !/\bbefore (?:any |the )?(?:rewrite|refactor|change)\b/i.test(text)) continue;
    // A unique task ID can carry the file and verification. The declaration
    // supplies the required old-code corpus and parity; no particular heading
    // or repeated filename/CRITICAL label is needed on the task itself.
    const declaredIds = [...new Set([...text.matchAll(/\bT[1-9]\d*\b/g)].map(m => m[0]))];
    const linkedId = declaredIds.length === 1 && /\bCRITICAL\b/.test(text)
      && current.filter(s => /\bmandatory\b/i.test(s.title) && /\bCRITICAL\b/.test(unquoted(s.body.join(' ')))
        && new RegExp(`\\b${declaredIds[0]}\\b`).test(unquoted(s.body.join(' ')))).length === 1 ? declaredIds[0] : undefined;
    const parityTargets = [...text.matchAll(/\b(?:run|execute|replay) (?:the )?same (?:corpus|suite|fixtures) (?:against|through|on) (?:the )?([A-Za-z][\w]*)(?: path)?[.;]/gi)];
    const linkedTarget = linkedId && parityTargets.length === 1
      && /\b(?:write|add|create) (?:regression|characterization)(?: \(golden\))? tests? for legacyAuthFlow\(\)/i.test(text)
      && /\bBoth must (?:produce|return|have) (?:identical|matching) (?:results|outcomes|outputs)\b/i.test(text) ? parityTargets[0]![1] : undefined;
    const scheduled = files.length === 1 && /\b(?:captures?|capturing|records?|recording|pins?|pinning)\b[^.;:]{0,180}\b(?:behavior|outcomes|outputs)\b/i.test(text);
    const comparisons = [...text.matchAll(/\b(?:asserts?|verifies?|checks?) ([A-Za-z][\w]*) (?:agrees with|matches) (?:it|(?:the )?(?:legacy )?(?:suite|baseline|outputs))\b/gi)];
    const pinnedParity = scheduled && beforeAndAfter && comparisons.length === 1 && comparisons[0]![1] !== 'legacyAuthFlow'
      && /\b(?:captures?|capturing|records?|recording|pins?|pinning) (?:the )?(?:current|prior|existing) (?:outputs|outcomes|behavior)\b/i.test(text);
    const tasks = allTasks.filter(t => linkedTarget || pinnedParity || /^Implementation Tasks$/i.test(t.section));
    for (const task of tasks) {
      if (!task.match) continue;
      const [, id, rawTitle] = task.match, title = unquoted(rawTitle!);
      if (linkedTarget && id !== linkedId) continue;
      if (tasks.filter(t => t.match?.[1] === id).length !== 1 || !/\blegacyAuthFlow\b/.test(title)
          || !/\b(?:regression|characterization)\b/i.test(title)) continue;
      const taskFiles = [...task.body.matchAll(/^  - Files: (.+)$/gm)];
      const verifies = [...task.body.matchAll(/^  - Verify: (.+)$/gm)];
      if (taskFiles.length !== 1 || verifies.length !== 1 || !owned(task.body) || framed(task.preceding)) continue;
      const verify = unquoted(verifies[0]![1]!);
      const runs = verify.split(/;\s*/);
      const linkedBaseline = linkedTarget && linkedTarget !== 'legacyAuthFlow' && id === linkedId
        && /^[A-Za-z][\w/.-]*\.test(?:\.[jt]s)?$/.test(taskFiles[0]![1]!)
        && (files.length === 0 || files.length === 1 && files[0] === taskFiles[0]![1])
        && /\b(?:write|add|create) (?:regression|characterization)(?: \(golden\))? tests? for legacyAuthFlow\(\) before (?:touching (?:it|legacyAuthFlow\(\))|(?:any |the )?(?:rewrite|refactor|change))\b/i.test(title)
        && runs.length === 2 && /^(?:the )?(?:suite|tests?|corpus) (?:passes|is green) (?:against|on) (?:legacy|legacyAuthFlow(?:\(\))?)$/i.test(runs[0]!)
        && new RegExp(`^(?:later|then) (?:passes|is green) unchanged (?:against|on) ${linkedTarget}[.]?$`, 'i').test(runs[1]!);
      const scheduledVerification = scheduled && /\bCRITICAL\b/.test(title) && taskFiles[0]![1] === files[0]
        && /\b(?:pass(?:es)?|green)\b/i.test(verify) && /\bbefore\b[^.;]*\bafter\b|\bbefore\b[^.;]*;[^.;]*\bafter\b/i.test(verify);
      // A task's explicit green baseline on unchanged code before any rewrite
      // commit is already an ordered verification; it need not be repeated in
      // a separate Verification section. The same file pins current outputs
      // in the declaration and supplies the comparison oracle for the new path.
      const committedBaseline = pinnedParity && scheduledVerification
        && tasks.filter(t => new RegExp(`^  - Files: ${files[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(t.body)).length === 1
        && /\b(?:passes?|green) (?:on|against) (?:main|master|(?:the )?(?:unmodified|untouched) (?:code|legacy path)) before (?:any|the) (?:refactor|rewrite|change) commit\b/i.test(verify);
      // The rule, uniquely named file/task and ordered verification together
      // establish the unchanged-code baseline without repeating CRITICAL and
      // "before" on every line of that same requirement.
      const green = (value: string) => /\b(?:pass(?:es)?|green)\b/i.test(value)
        && !/\b(?:not|never|no longer|fail(?:s|ed|ing)?|red)\b/i.test(value);
      const orderedBaseline = requiredRule && scheduled && taskFiles[0]![1] === files[0]
        && /\b(?:write|add|create|implement|record|capture|pin)\b/i.test(title)
        && runs.some(run => green(run) && /\b(?:current|unmodified|untouched) (?:code|implementation|legacy path)\b/i.test(run))
        && runs.some(run => green(run) && /\bafter (?:the )?(?:rewrite|refactor|change)\b/i.test(run))
        && /\b(?:captures?|capturing|records?|recording|pins?|pinning) (?:the )?(?:current|prior|existing) (?:outputs|outcomes|behavior)\b/i.test(text)
        && /\bmust (?:pass|satisfy) (?:the )?same (?:suite|tests|assertions) unchanged\b|\b(?:the )?same (?:suite|tests|assertions) must (?:pass|remain green) unchanged (?:after|across) (?:the )?(?:rewrite|refactor|change)\b/i.test(text)
        && tasks.filter(t => new RegExp(`^  - Files: ${files[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(t.body)).length === 1
        && current.filter(s => /^Verification(?: \([^)]*\))?$/i.test(s.title)).some(s => {
          const steps = s.body.join('\n').trim().split(/\n(?=\d+[.)] )/);
          const first = unquoted(steps[0] ?? '').trim();
          return steps.length >= 2 && owned(steps[0]!) && /^1[.)] (?:run|execute|test|verify)\b/i.test(first)
            && new RegExp(`\\b${id}\\b`).test(first) && /\b(?:unmodified|untouched) (?:code|implementation|legacy path)\b/i.test(first) && green(first)
            && steps.slice(1).some(step => {
              const statement = unquoted(step).trim();
              return owned(step) && /^(?:[2-9]|[1-9]\\d+)[.)] (?:re-run|rerun|run|execute)\b/i.test(statement)
                && new RegExp(`\\b${id}\\b`).test(statement) && /\bafter (?:the )?(?:rewrite|refactor|change)\b/i.test(statement)
                && green(statement) && /\bunchanged\b/i.test(statement);
            });
        });
      const inlineBaseline = declaration.inlineRequired && scheduled && taskFiles[0]![1] === files[0]
        && tasks.filter(t => new RegExp(`^  - Files: ${files[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(t.body)).length === 1
        && [...text.matchAll(/\bT[1-9]\d*\b/g)].every(m => m[0] === id)
        && new RegExp(`\\b${id}\\b`).test(text)
        && /\b(?:run|execute|replay) (?:the )?same fixtures\b/i.test(text)
        && /\bagainst (?:the )?new path\b/i.test(text)
        && /\bassert (?:identical|matching)\b[^.;]*\b(?:outputs?|outcomes?|session shape)\b/i.test(text)
        && /\b(?:rejection|error) (?:class|kind|code)\b/i.test(text)
        && runs.some(run => green(run) && /\bon (?:the )?legacy(?: path)? before (?:any|the) (?:refactor|rewrite|change)(?: commit)?\b/i.test(run))
        && runs.some(run => green(run) && /\bon both paths\b/i.test(run))
        && current.filter(s => /^Verification(?: \([^)]*\))?$/i.test(s.title)).some(s => {
          const first = unquoted(s.body.join('\n').trim().split(/\n(?=\d+[.)] )/)[0] ?? '');
          return owned(first) && /^1[.)] (?:run|execute|test|verify)\b/i.test(first)
            && new RegExp(`\\b${id}\\b`).test(first) && /\b(?:untouched|unmodified) legacy path\b/i.test(first)
            && /\bfirst\b/i.test(first);
        });
      // The selected ledger scope supplies the pre-rewrite golden oracle;
      // the bound task verifies it on legacy/new paths, and a separate removal
      // task explicitly waits for that same suite to replay green.
      const ledger = declaration.ledger;
      const ledgerRow = ledger?.row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ledgerTasks = ledger ? tasks.filter(other => other.match && other.match[1] !== id && owned(other.body)
        && !framed(other.preceding) && new RegExp(`\\bdelete legacyAuthFlow\\(\\) only after ${id} replays green\\b`, 'i').test(unquoted(other.match![2]!))
        && [...other.body.matchAll(/^  - Verify: (.+)$/gm)].length === 1
        && new RegExp(`^  - Verify: ${id} suite \\+ per-caller integration tests green on the new path$`, 'im').test(other.body)) : [];
      const ledgerBaseline = ledger && ledgerTasks.length === 1
        && tasks.filter(other => other.match?.[1] === ledgerTasks[0]!.match![1]).length === 1
        && new RegExp(`\\b(?:Capture|Record|Pin) the ${ledger.caseCount}-case characterization matrix from legacyAuthFlow\\(\\)(?=\\s|$)`).test(title)
        && new RegExp(`^  - Surfaced by: [^\\n]*\\b${ledgerRow}/${ledger.question}\\b`, 'm').test(task.body)
        && /(?:^|,\s*)(?:new\s+)?[A-Za-z][\w/.-]*\.test(?:\.[jt]s|\.(?=,|$))/.test(taskFiles[0]![1]!)
        && runs.length === 2 && /^(?:matrix|suite) green against (?:the )?legacy$/i.test(runs[0]!)
        && /^(?:replayed|rerun) green against (?:the )?new path before (?:swap|replacement|cutover)$/i.test(runs[1]!);
      const scopedBaseline = linkedBaseline || committedBaseline || orderedBaseline || inlineBaseline || ledgerBaseline;
      if (!scopedBaseline && !scheduledVerification) continue;
      // An explicit ordered step provides the old-code oracle; matching a task label alone cannot.
      const baseline = scopedBaseline || current.filter(s => /^Verification(?: \([^)]*\))?$/i.test(s.title)).some(s => {
        const lines = s.body.join('\n').split(/\n(?=\d+\. )/);
        return lines.some(line => {
          const statement = unquoted(line);
          return /^\d+\. (?:Write|Run|Execute|Add|Create)\b/i.test(statement) && owned(line) && new RegExp(`\\b${id}\\b`).test(statement)
            && /\blegacyAuthFlow\b/.test(statement) && /\b(?:untouched|unmodified)\b/.test(statement)
            && /\b(?:must (?:pass|be green)|commit it green)\b/i.test(statement)
            && /\bbefore\b|\bfirst\b/i.test(statement);
        });
      });
      if (!baseline) continue;
      const subject = `(?:${ledgerBaseline ? `${ledgerRow}|${ledger!.question}|${ledgerTasks[0]!.match![1]}|` : ''}${id}(?: (?:baseline )?verification)?|(?:this|the) (?:(?:legacy|baseline) )?(?:(?:regression|characterization) )?(?:suite|test|requirement|verification))`;
      const cancelled = current.some(s => {
        if (/\b(?:history|historical|source|quoted|example)\b/i.test(s.title)) return false;
        const named = /^(.*?)\b(?:regression|characterization)\s+(?:suite|tests?)\b/i.exec(s.title)?.[1]?.trim();
        const foreign = Boolean(named && !/^(?:(?:current|final|critical|required|updated)\s*)*(?:legacy(?:AuthFlow\(\))?)?[\s:—-]*$/i.test(named));
        const raw = s.body.join('\n').replace(new RegExp(`(${subject} (?:is|was|has been) )["“'‘](${inactive})["”'’]`, 'gi'), '$1$2');
        return unquoted(raw).split(/\n|[.!?;]\s+/).some(line => {
          if (framed(line) || /^\s*(?:if|unless|assuming|provided)\b/i.test(line)) return false;
          if (foreign && !new RegExp(`\\b${id}\\b|legacyAuthFlow|\\blegacy (?:regression|characterization)`).test(line)) return false;
          return new RegExp(`\\b${subject} (?:is|was|has been) ${inactive}\\b|^\\s*\\|\\s*${id}\\s*\\|\\s*${inactive}\\s*\\|`, 'i').test(line)
            || new RegExp(`^\\s*(?:Correction:\\s*)?(?:do not|don't|never|skip|defer|cancel|withdraw) (?:run |execute |implement )?${subject}\\b`, 'i').test(line)
            || new RegExp(`\\b(?:run|execute|record|capture) ${id} only after (?:modifying|changing|rewriting|refactoring|removing|deleting) legacyAuthFlow\\b`, 'i').test(line)
            || new RegExp(`\\blegacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored|removed|deleted) before ${id}\\b`, 'i').test(line)
            || Boolean(scopedBaseline && new RegExp(`\\b(?:update|change|replace|regenerate|rewrite) ${subject} (?:expectations|expected (?:results|outputs)|assertions)\\b|\\b${subject} (?:expectations|assertions) (?:are|will be) (?:changed|updated|replaced)\\b`, 'i').test(line));
        });
      });
      if (!cancelled) return true;
    }
  }
  return false;
}

function regressionEvidence(text: string): boolean {
  if (declaredLegacyCharacterization(text)) return true;
  return prose(text).split(/\n\s*\n|\n(?=\s*[-#])/).some(block => {
    let task = block.trim().replace(/^[-+]\s+(?:\[[ xX]\]\s*)?/, '');
    const numbered = /^T\d+(?:\s*\([^\n)]*\))?\s*[—–:-]\s*/.exec(task);
    if (numbered) {
      // A numbered task may place a simple component path before its action.
      // Do not remove arbitrary prose or let this metadata assign the test target.
      task = task.slice(numbered[0].length)
        .replace(/^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*)+[\t ]+[—–][\t ]+/, '');
    }
    if (requiredLegacyCharacterization(task)) return true;
    const legacySubject = /^legacyAuthFlow(?:\(\))?\s*[—–:-]\s*/i;
    const action = task.replace(legacySubject, '');
    const instruction = action.match(/^(?:(?:I|we)\s+)?(?:add(?:ed)?|record(?:ed)?|write|wrote|require(?:d)?|include(?:d)?)\s+((?:(?:a|the|new|required|legacyAuthFlow(?:\(\))?|regression|characterization|baseline|prior-behavior)\s+)*(?:tests?|fixtures?|suites?))\b([^.;\n]*)/i);
    const explicitTarget = instruction && /^\s+(?:for|of|covering|characterizing|pinning)\b/i.test(instruction[2]!);
    const legacyTarget = instruction && (
      /^\s+(?:for|of|covering|characterizing)\s+(?:the\s+)?(?:prior behavior of\s+)?legacyAuthFlow\b/i.test(instruction[2]!) ||
      /^\s+pinning\s+(?:the\s+)?legacyAuthFlow(?:\(\))?(?:'s)?\s+(?:current|existing|prior)\s+behavior\b/i.test(instruction[2]!));
    const target = instruction && (!explicitTarget || legacyTarget) &&
      (legacySubject.test(task) || /\blegacyAuthFlow\b/.test(instruction[1]!) || legacyTarget);
    // An affirmative task or completed addition, not an example, quotation,
    // conditional proposal or an uncertain discussion of whether to add it.
    return Boolean(target) &&
    /\b(?:regression|characterization)\b/i.test(instruction![0]) &&
    /\b(?:before|prior behavior|parity|compatibility|characterization)\b/i.test(instruction![0]) &&
    !/\b(?:no|not|never|skip\w*|defer\w*|maybe|might|could|if|unless|optional)\b/i.test(block);
  });
}

export function evaluateEngSeedCoverage(transcript: PlanCountTranscript, plan: string,
  startedAt: number, finishedAt: number) {
  const decisions: Partial<Record<Seed, string>> = {};
  const problems: string[] = [];
  const sessions = new Set(transcript.calls.map(c => c.sessionId));
  const identities = transcript.calls.map(c => `${c.sessionId}:${c.toolUseId}`);
  const bound = transcript.status === 'ready' && sessions.size === 1 && !sessions.has('') &&
    identities.length === new Set(identities).size && Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) && startedAt <= finishedAt;
  if (!bound) problems.push('missing, ambiguous or unbound native transcript');
  if (bound) for (const call of transcript.calls) {
    if (!completedDecision(call, startedAt, finishedAt)) continue;
    const seeds = call.questions.flatMap(seedSubjects);
    // One combined approval cannot replace separate decisions for independent seeds.
    // An unrelated, separately answered setup tab may accompany the one seed;
    // multiple seeded questions still cannot lend this call ID to several seeds.
    if (seeds.length === 1) decisions[seeds[0]!] ??= `${call.sessionId}:${call.toolUseId}`;
  }
  const missing = ENG_DECISION_SEEDS.filter(seed => !decisions[seed]);
  const regression = regressionEvidence(plan) ? 'plan' : bound && transcript.assistantMessages.some(m =>
    sessions.has(m.sessionId) && Date.parse(m.timestamp) >= startedAt && Date.parse(m.timestamp) <= finishedAt &&
    regressionEvidence(m.text)) ? 'public-narration' : undefined;
  if (!regression) problems.push('mandatory legacy regression coverage absent');
  // The caller also retains the existing fresh owned-path/native completion and D19 checks.
  if (!/^## GSTACK REVIEW REPORT[\t ]*\n\s*\S/m.test(prose(plan))) problems.push('final review report absent or empty');
  return { ok: bound && missing.length === 0 && problems.length === 0, decisions, missing, regression, problems };
}
