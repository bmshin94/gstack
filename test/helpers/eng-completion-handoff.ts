import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import type { NativePlanQuestionCall } from './plan-count-transcript';

/** Count a completed review-navigation choice separately; never choose pending input. */
export function isEngCompletionHandoff(fp: AskUserQuestionFingerprint, reviewedPlan: string,
  priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      Object.keys(call.answers ?? {}).length !== 1 || !Number.isFinite(Date.parse(call.answeredAt ?? ''))) return false;
  if (isPublishedTaskPauseNavigation(fp, reviewedPlan, priorCalls) || isCurrentLedgerNavigation(fp, reviewedPlan, priorCalls) || isApprovedInvestigationRecap(fp, reviewedPlan, priorCalls) || isPublishedReadyNavigation(fp, reviewedPlan) || isApprovedMaintenanceRecap(fp, reviewedPlan, priorCalls) || isPublishedPrerequisiteHandoff(fp, reviewedPlan)) return true;
  const q = call.questions[0]!;
  if (q.multiSelect || q.header.trim() !== 'Next steps' || q.options.length !== 2 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question]) || /<gstack-qid/i.test(q.question)) return false;
  const body = q.question.trim().replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length !== 4 ||
      !/^Next steps: Eng Review is CLEAR\. This is a backend auth refactor with no UI scope, so \/plan-design-review does not apply\. No CEO review exists, but the plan changes no product direction\. What next\?$/.test(lines[0]!) ||
      !/^Recommendation: [1-9]\d*[A-Z] because the plan is implementation-ready and a CEO review would add little to a pure infrastructure refactor\.$/.test(lines[1]!) ||
      !/^Note: options differ in kind, not coverage [—–-] no completeness score\.$/.test(lines[2]!) ||
      !/^Net: start building now versus one more optional review pass on scope\.$/.test(lines[3]!)) return false;
  const label = (s: string) => s.trim().replace(/^[1-9]\d*[A-Z]\)\s*/, '').replace(/\s*\(recommended\)$/, '');
  const ready = q.options.find(o => /^Ready to implement [—–-] run \/ship when done$/.test(label(o.label)));
  const ceo = q.options.find(o => label(o.label) === 'Run /plan-ceo-review first');
  if (!ready || !ceo) return false;
  const task = /^Exit plan mode with the reviewed plan; implement T([1-9]\d*)[–-]T([1-9]\d*) \(record T([1-9]\d*) regression fixtures first\)\. ✅ All required reviews complete and logged\. ✅ Tasks JSONL and QA test plan are already written for \/autoplan and \/qa\. ❌ No second-opinion pass since codex reviews are disabled\.$/.exec(ready.description ?? '');
  // Bind implementation references to the published reviewed task catalog.
  // A new task or a newly proposed regression step is still substantive work.
  if (!task || Number(task[1]) !== 1 || Number(task[2]) < Number(task[3]) || Number(task[3]) < Number(task[1])) return false;
  const tasks = [...reviewedPlan.matchAll(/^- \[ \] \*\*T([1-9]\d*)\b[^\n]+$/gm)];
  const ids = tasks.map(t => Number(t[1])).sort((a, b) => a - b);
  if (ids.length !== Number(task[2]) || ids.some((id, i) => id !== i + 1)) return false;
  const regression = tasks.find(t => t[1] === task[3])?.[0] ?? '';
  if (!/ [—–] Record regression(?: characterization)? fixtures before\b/i.test(regression)) return false;
  return ceo.description === 'Optional scope and strategy pass before implementing. ✅ Catches product-level questions the eng review does not ask. ✅ Adds a CEO row to the dashboard. ❌ Little product surface here; likely confirms the current scope.';
}

/** A completed report can retain critical implementation gaps (ISSUES OPEN).
 * Its current decision states, actual earlier answers and published task order
 * must still agree. This route supplies navigation credit only. */
function isCurrentLedgerNavigation(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s.replace(/\*\*/g, '')).replace(/^(?:[1-9]\d*)?[A-Z]\s*[).:—–-]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  const currentText = (s: string) => s.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(q.header.trim()) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo || call.answers?.[q.question] !== ready.label) return false;
  const context = currentText([q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n'));
  const positive = context.replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’/g, '');
  const status = context.replace(/["“”'‘’]/g, '');
  const badStatus = /\b(?:review|decisions?(?: [A-Z][1-9]\d*)?|readiness|state|accepted scope)\s*(?:(?:is|are|remains?|has been)\s+|:\s*)?(?:now |still )?(?:incomplete|unfinished|pending|unanswered|unresolved|reopened|withdrawn|superseded|cancelled|canceled|rejected|revoked|denied|unapproved|(?:not|no longer) (?:complete|completed|done|finished|approved|answered|settled))\b|\b(?:not all|not every) decisions?\b|\b[1-9]\d* unresolved decisions?\b/i;
  if (badStatus.test(status) || /`{3}|~{3}|(?:^|\n)\s*>/.test(context) ||
      !/\breview (?:is |has been )?(?:complete[d]?|done|finished)\b/i.test(positive) ||
      !/\bwhat next\b|\bnext steps?\b/i.test(positive) ||
      !/\b(?:every decision is|all decisions are) (?:answered|settled)\b/i.test(positive) ||
      /\breview\b[^.!?;\n]{0,60}\b(?:will|would|may|might|could|should) (?:be )?(?:complete|done|finished)\b|\breview\b[^.!?;\n]{0,60}\b(?:complete|done|finished)\b[^.!?;\n]{0,60}\b(?:if|when|once|unless|provided|assuming|after)\b|\b(?:if|when|once|unless|provided|assuming)\b[^.!?;\n]{0,60}\breview\b[^.!?;\n]{0,60}\b(?:complete|done|finished)\b/i.test(status)) return false;

  // Fences, quoted lines and explicitly historical sections cannot establish a
  // current owner. Keep the heading hierarchy so an archived parent is inert.
  const lines: string[] = [], headings: { depth: number; inactive: boolean }[] = [];
  let fence: string | undefined;
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (fence || /^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) {
      while (headings.at(-1) && headings.at(-1)!.depth >= h[1]!.length) headings.pop();
      headings.push({ depth: h[1]!.length, inactive: /\b(?:history|historical|archived?|withdrawn|superseded|example|quoted|template)\b/i.test(h[2]!) });
    }
    if (!headings.some(h => h.inactive)) lines.push(line);
  }
  if (fence) return false;
  const current = currentText(lines.join('\n'));
  const section = (name: string) => {
    const starts = lines.flatMap((line, i) => new RegExp(`^#{2,3} ${escape(name)}$`, 'i').test(line) ? [i] : []);
    if (starts.length !== 1) return undefined;
    const start = starts[0]!, depth = /^#+/.exec(lines[start]!)![0].length;
    const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${depth}} `).test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const titles = [...current.matchAll(/^# (?:Plan: )?(.+?)(?: \(reviewed\))?$/gm)];
  const targets = [...current.matchAll(/^Reviewed target: `([^`\n]+\.md)` \("([^"]+)"\)[^\n]*, branch `([^`\n]+)`[^\n]*$/gm)];
  if (titles.length !== 1 || targets.length !== 1 ||
      compact(titles[0]![1]!) !== compact(targets[0]![2]!.replace(/^Plan: /i, ''))) return false;
  const source = targets[0]![1]!, branch = targets[0]![3]!;
  const metadata = q.question.split('\n').filter(s => /^Project\/branch\/task:/.test(s));
  if (metadata.length !== 1 || !new RegExp(`^Project/branch/task: ${escape(branch)}; /plan-eng-review of ${escape(source)} (?:finished|completed|done),`).test(metadata[0]!)) return false;
  const ledger = section('Decision ledger'), tasks = section('Implementation Tasks'), lanes = section('Worktree parallelization strategy'), report = section('GSTACK REVIEW REPORT');
  if (!ledger || !tasks || !lanes || !report || badStatus.test(currentText(report).replace(/["“”'‘’]/g, '')) ||
      report.trim().split('\n').at(-1) !== 'NO UNRESOLVED DECISIONS') return false;
  const reportRows = report.split('\n').filter(s => /^\| Eng Review \|/.test(s));
  const verdicts = report.split('\n').filter(s => /^(?:- )?\*\*VERDICT:\*\*/.test(s));
  const gaps = reportRows.length === 1 ? /\| (CLEAR|ISSUES OPEN) \|[^\n]*\b(\d+) critical gaps\b/.exec(reportRows[0]!) : null;
  if (!gaps || verdicts.length !== 1 || !new RegExp(`\\bEng Review (?:is )?${gaps[1]}\\b`, 'i').test(verdicts[0]!) ||
      !/\b0 unresolved decisions\b/.test(verdicts[0]!) || (gaps[1] === 'CLEAR') !== (+gaps[2]! === 0) ||
      !new RegExp(`\\b${gaps[2]} critical gaps\\b`).test(metadata[0]!)) return false;

  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  if (!prior.length || new Set(identities).size !== prior.length || prior.some(c => c.sessionId !== call.sessionId ||
      !c.toolUseId || c.toolUseId === call.toolUseId || c.answered !== true || c.failed !== false ||
      !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
      !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length || c.questions.length !== 1 ||
      Object.keys(c.answers ?? {}).length !== 1 || c.questions[0]!.multiSelect ||
      new Set(c.questions[0]!.options.map(o => o.label)).size !== c.questions[0]!.options.length ||
      !c.questions[0]!.options.some(o => o.label === c.answers?.[c.questions[0]!.question]))) return false;
  const approvals = prior.map(c => ({ call: c, q: c.questions[0]!, id: /^(D[1-9]\d*)\s*[—–:-]/.exec(c.questions[0]!.question)?.[1], selected: label(c.answers![c.questions[0]!.question]!) }));
  const finalId = /^(D[1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
  if (!finalId || approvals.some(a => !a.id || a.id === finalId) || new Set(approvals.map(a => a.id)).size !== approvals.length) return false;
  const rows = ledger.split(/\n(?=### )/).filter(s => /^### /.test(s.trim()));
  const rowIds = rows.map(s => /^### ([A-Z][1-9]\d*):/.exec(s.trim())?.[1]);
  const states = [...ledger.matchAll(/^State: (.+)$/gm)];
  const owned = new Map<string, string>();
  if (!rows.length || rowIds.some(id => !id) || new Set(rowIds).size !== rows.length || states.length !== rows.length || states.some(s => s[1] !== 'approved')) return false;
  for (const row of rows) {
    const field = (name: string) => { const matches = [...row.matchAll(new RegExp(`^${name}: (.+)$`, 'gm'))]; return matches.length === 1 ? matches[0]![1]! : undefined; };
    const answer = field('Actual answer'), scope = field('Accepted scope');
    const question = [...row.matchAll(/^Question (D[1-9]\d*): (.+)$/gm)];
    if (field('State') !== 'approved' || !answer || !scope || question.length !== 1 || badStatus.test(currentText(row).replace(/["“”'‘’]/g, ''))) return false;
    const id = question[0]![1]!, a = approvals.find(a => a.id === id);
    if (!a || owned.has(id) || !answer.endsWith(`(${id})`) || label(answer.slice(0, -id.length - 3)) !== a.selected) return false;
    const meta = a.q.question.split('\n').filter(s => /^Project\/branch\/task:/.test(s));
    if (meta.length !== 1 || !new RegExp(`^Project/branch/task: ${escape(branch)}; [^;\n]*\\bon ${escape(source)}(?=[ ,;])`).test(meta[0]!) ||
        /\b(?:compare|comparison|historical|archived?|withdrawn|superseded)\b/i.test(meta[0]!.split(`on ${source}`)[0]!) ||
        [...meta[0]!.split(`on ${source}`)[0]!.matchAll(/[\w./-]+\.md\b/g)].some(m => m[0] !== 'TODOS.md')) return false;
    const owner = /^### ([A-Z][1-9]\d*):/.exec(row)![1]!;
    const changed = new RegExp(`\\b(?:${owner}|${id})\\b(?: (?:decision|scope|state|approval))?\\s*(?::|is|was|has been|remains)?\\s*(?:now |still )?(?:pending|withdrawn|superseded|reopened|cancelled|canceled|rejected|revoked|denied|unapproved|not approved|no longer approved)\\b`, 'i');
    if (changed.test(currentText(row).replace(/["“”'‘’]/g, '')) || prior.some(c => Date.parse(c.answeredAt!) > Date.parse(a.call.answeredAt!) && changed.test(currentText(c.questions[0]!.question).replace(/["“”'‘’]/g, '')))) return false;
    owned.set(id, row);
  }
  const readiness = ledger.split('\n').filter(s => /^Approval readiness:/.test(s));
  const readyRefs = readiness.length === 1 ? [...readiness[0]!.matchAll(/\b([A-Z][1-9]\d*) \((D[1-9]\d*)\)/g)] : [];
  if (readiness.length !== 1 || !/^Approval readiness: PASS\b/.test(readiness[0]!) ||
      readyRefs.length !== rows.length || new Set(readyRefs.map(r => r[2])).size !== rows.length ||
      readyRefs.some(r => !owned.get(r[2]!)?.startsWith(`### ${r[1]}:`))) return false;
  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]+/gm)];
  const ids = entries.map(e => e[1]!);
  if (!ids.length || new Set(ids).size !== ids.length) return false;
  for (const ref of context.matchAll(/\bT([1-9]\d*)(?:\s*(?:[–-]|through|to)\s*T([1-9]\d*))?\b/g)) {
    const first = +ref[1]!, last = +(ref[2] ?? ref[1])!;
    if (last < first || last - first >= ids.length) return false;
    for (let n = first; n <= last; n++) if (!ids.includes(`T${n}`)) return false;
  }
  const taskBody = (id: string) => { const e = entries.find(e => e[1] === id); return e ? tasks.slice(e.index!, entries.find(v => v.index! > e.index!)?.index ?? tasks.length) : ''; };
  if (/\bT[1-9]\d*\b[^.!?\n]*\b(?:withdrawn|cancelled|canceled|rejected|not approved|pending approval)\b/i.test(currentText(tasks).replace(/["“”'‘’]/g, ''))) return false;
  const count = /\bimplement (?:the )?(\d+) tasks\b/i.exec(positive);
  if (!count || +count[1]! !== ids.length) return false;
  const laneIds = [...lanes.matchAll(/\bLane ([A-Z]):/g)].map(m => m[1]!);
  const execution = lanes.split('\n').filter(s => /^Execution(?: order)?:/.test(s));
  const menuOrder = [...context.matchAll(/\blane order \(([^)]+)\)/gi)];
  const groups = (text: string) => text.split(/,?\s*then\s+|\s*→\s*/i).map(s => s.trim().replace(/\s+parallel$|\s+sequential(?:ly)?$/i, '').split(/\s*\+\s*|\s+and\s+/).sort());
  const publishedGroups = execution.length === 1 ? [...execution[0]!.matchAll(/\b(?:launch|then) ([A-Z](?:\s*(?:\+|and)\s*[A-Z])*)(?: in parallel(?: worktrees)?| sequentially)?(?=[.,]|$)/gi)].map(m => groups(m[1]!)[0]!) : [];
  if (!laneIds.length || new Set(laneIds).size !== laneIds.length || !publishedGroups.length || menuOrder.length !== 1 ||
      JSON.stringify(groups(menuOrder[0]![1]!)) !== JSON.stringify(publishedGroups) ||
      JSON.stringify(publishedGroups.flat().sort()) !== JSON.stringify([...laneIds].sort())) return false;

  // Strip only already-owned implementation/navigation recaps before applying
  // the established action veto. Approval references are read from this packet.
  let actions = context.replace(/\bimplement (?:the )?\d+ tasks in the lane order given\b/gi, '')
    .replace(/\bimplement T[1-9]\d*[-–]T[1-9]\d* in lane order \([^)]+\)/gi, '');
  const maintenance = /(?:First two edits after exit|Post-exit|After exiting): ((?:append|add) (?:gstack )?routing rules to CLAUDE\.md) \((D[1-9]\d*)\) and ((?:create|write) TODOS\.md) \((D[1-9]\d*)\)\./i.exec(actions);
  if (maintenance) {
    const routing = approvals.find(a => a.id === maintenance[2]), todo = approvals.find(a => a.id === maintenance[4]);
    const sameTask = entries.some(e => { const b = taskBody(e[1]!); return /\bCLAUDE\.md\b/.test(b) && /\bTODOS\.md\b/.test(b) && [maintenance[2], maintenance[4]].every(id => new RegExp(`\\b${id}\\b`).test(b)); });
    if (!routing || !todo || routing.q.header !== 'Routing' || !/^(?:Add|Append) (?:gstack )?routing rules(?: to CLAUDE\.md)?$/i.test(routing.selected) ||
        !/\bCLAUDE\.md\b/.test(routing.q.question) || !/^TODO(?: [1-9]\d*)?$/.test(todo.q.header) || todo.selected !== 'Add to TODOS.md' || !owned.has(todo.id!) || !sameTask ||
        !new RegExp(`^Project/branch/task: ${escape(branch)}(?: branch|;)`).test(routing.q.question.split('\n')[1] ?? '')) return false;
    for (const a of [routing, todo]) {
      const withdrawn = new RegExp(`\\b${a.id}\\b(?: (?:decision|scope|state|approval))?\\s*(?::|is|was|has been|remains)?\\s*(?:now |still )?(?:pending|withdrawn|superseded|reopened|cancelled|canceled|rejected|revoked|denied|unapproved|not approved|no longer approved)\\b`, 'i');
      if (withdrawn.test(current.replace(/["“”'‘’]/g, '')) || prior.some(c => Date.parse(c.answeredAt!) >= Date.parse(a.call.answeredAt!) && withdrawn.test(currentText(c.questions[0]!.question).replace(/["“”'‘’]/g, '')))) return false;
    }
    actions = actions.replace(maintenance[0], '');
  }
  actions = actions.replace(/\bAdds? a scope\/strategy pass(?: and a (?:written )?([a-z]+(?: [a-z]+)+) the plan currently lacks \((T[1-9]\d*)\))?(?=[.!?]|$)/gi, (whole, noun, id) =>
    !noun || new RegExp(`\\b${escape(noun)}\\b`, 'i').test(taskBody(id).split('\n')[0] ?? '') ? '' : whole);
  const action = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:adds?|adding|append(?:s|ing)?|remov(?:e|es|ing)|delet(?:e|es|ing)|cut(?:s|ting)?|drop(?:s|ping)?|replac(?:e|es|ing)|rewrit(?:e|es|ing)|chang(?:e|es|ing)|alter(?:s|ing)?|modif(?:y|ies|ying)|enabl(?:e|es|ing)|disabl(?:e|es|ing)|implement(?:s|ing)?|install(?:s|ing)?|introduc(?:e|es|ing)|build(?:s|ing)?|writ(?:e|es|ing)|record(?:s|ing)?|captur(?:e|es|ing)|creat(?:e|es|ing)|switch(?:es|ing)?|migrat(?:e|es|ing)|externaliz(?:e|es|ing)|refactor(?:s|ing)?|expand(?:s|ing)?|reduc(?:e|es|ing)|deploy(?:s|ing)?|approv(?:e|es|ing))\b/i;
  return !action.test(actions) && !/\brun\s+(?!\/(?:ship|plan-ceo-review)\b)|\b(?:new|additional|extra) (?:work|task|requirement|dependency|feature)\b|\b(?:must|shall|should|needs? to|required to)\s+[a-z]/i.test(actions);
}

/** A ready menu may recap one previously approved investigation. The completed
 * native answer, current ledger and published task jointly own that exception;
 * it never supplies seed credit or replaces the runner's report/exit checks. */
function isApprovedInvestigationRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s).replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(q.header.trim()) || q.options.length < 2 || q.options.length > 3 ||
      fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      new Set(q.options.map(o => label(o.label))).size !== q.options.length) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^(?:CEO review \(\/plan-ceo-review\)|Run \/plan-ceo-review(?: first)?)$/i.test(label(o.label)));
  const design = q.options.find(o => /^Design review \(\/plan-design-review\)$/i.test(label(o.label)));
  if (!ready || !ceo || q.options.length === 3 && !design || call.answers?.[q.question] !== ready.label) return false;
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const body = compact(q.question.replace(/"[^"\n]*"|“[^”\n]*”/g, ''));
  const issue = /\b(?:follow-up|investigation)\s*\((R[1-9]\d*)\)/i.exec(body)?.[1];
  const task = /\b(?:follow-up|investigation) task\s*\((T[1-9]\d*)\)\s*,?\s*(?:is )?not a blocker\b/i.exec(body)?.[1];
  if (!issue || !task || !/^D[1-9]\d*\s*[—–:-]\s*Next steps? after this eng(?:ineering)? review\?/i.test(body) ||
      !/\b(?:eng(?:ineering)? review|review) is (?:done|complete[d]?|finished)\b/i.test(body) ||
      !/\b(?:every|all) P1 (?:fix(?:es)?|remed(?:y|ies)) (?:is|are) approved and specified\b/i.test(body) ||
      !/\bremaining choice is whether another review pass\b|\bonly (?:remaining )?choice is (?:the )?next (?:review|workflow)\b/i.test(body) ||
      !/\b(?:one|1) (?:\w+ )?(?:follow-up|investigation)\b/i.test(body) ||
      design && !/\bno UI\b[\s\S]*\bdesign review does not apply\b/i.test(body) ||
      /(?:^|\n)\s*>|`{3}|~{3}|\b(?:Example|Historical|Quoted)\s*:/i.test(context)) return false;
  // Descriptions can explain existing work. New commands, including commands
  // hidden in quoted/conjoined prose, are not navigation on either option.
  const action = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|cut(?:ting)?|drop(?:ping)?|replac(?:e|ing)|rewrit(?:e|ing)|chang(?:e|ing)|alter(?:ing)?|modif(?:y|ying)|enabl(?:e|ing)|disabl(?:e|ing)|implement(?:ing)?|install(?:ing)?|introduc(?:e|ing)|build(?:ing)?|writ(?:e|ing)|record(?:ing)?|captur(?:e|ing)|creat(?:e|ing)|switch(?:ing)?|migrat(?:e|ing)|externaliz(?:e|ing)|refactor(?:ing)?|expand(?:ing)?|reduc(?:e|ing)|deploy(?:ing)?|approv(?:e|ing))\b/i;
  const statusText = (s: string) => s.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '').replace(/["“”'‘’]/g, '');
  const eng = String.raw`(?:(?:the |this )?(?:eng(?:ineering)? review|eng gate)|this review|the review|the verdict|all required reviews)`;
  const complete = String.raw`(?:clear(?:ed)?|complete[d]?|done|finished)`;
  const invalidCompletion = (s: string) => {
    const v = statusText(s);
    return new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b(?:incomplete|unfinished|pending|withdrawn|superseded|cancelled|canceled|reopened|rejected|not (?:done|complete|completed|clear|cleared|finished))\b`, 'i').test(v) ||
      new RegExp(String.raw`\b${eng}\s+(?:will|would|may|might|can|could|should)\s+(?:be |become )?${complete}\b`, 'i').test(v) ||
      new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b${complete}\b[^.!?;\n]{0,100}\b(?:if|when|once|unless|provided|assuming|after)\b`, 'i').test(v) ||
      new RegExp(String.raw`\b(?:if|when|once|unless|provided|assuming)\b[^.!?;\n]{0,100}\b${eng}\b[^.!?;\n]{0,60}\b${complete}\b`, 'i').test(v) ||
      /\bnot (?:all|every) P1 (?:fix(?:es)?|remed(?:y|ies))\b|\bP1 (?:fix(?:es)?|remed(?:y|ies))\b[^.!?;\n]{0,80}\b(?:not approved|unapproved|pending|reopened|withdrawn|superseded|cancelled|canceled|rejected)\b/i.test(v);
  };
  const changedInvestigation = (s: string, owner = `${issue}|${task}|(?:the |this )?(?:investigation|follow-up|open item|pending item)`, genericApproval = true) => {
    const v = statusText(s).replace(/\bnot a blocker\b|\bNo (?:[\w-]+ )*implementation approved\./gi, '');
    return new RegExp(String.raw`\b(?:${owner})\b(?: (?:task|decision|requirement|status|implementation))?\s*(?::|is|was|has been|remains)?\s*(?:now |still )?(?:a blocker|blocking|withdrawn|cancelled|canceled|rejected|reopened|superseded|not (?:required|approved)|no longer (?:optional|approved|nonblocking)|required before (?:implementation|building|work)|implementation (?:is )?(?:now )?approved)\b`, 'i').test(v) ||
      genericApproval && /\bimplementation (?:is |now |is now )?approved\b/i.test(v);
  };
  const allowedReask = new RegExp(`\\b${issue}(?: (?:stays|remains) (?:open|unresolved) and)? must be re-asked after ${task}\\b`, 'gi');
  const actions = context.replace(allowedReask, '');
  if (invalidCompletion(context) || changedInvestigation(context) || action.test(actions) || /\brun\s+(?!\/(?:ship|plan-ceo-review|plan-design-review)\b)/i.test(actions) || /\bimplementation (?:is |now |is now )?approved\b/i.test(actions) || /\b(?:new|additional|extra) (?:work|task|requirement|dependency|feature)\b|\b(?:must|shall|should|needs? to|required to)\s+[a-z]/i.test(actions) ||
      /\b(?:review|P1 (?:fixes|remedies))\b[^.!?;\n]*\b(?:not done|not complete|not approved|pending approval|reopened|withdrawn)\b/i.test(context)) return false;

  const published: string[] = [];
  let fence: string | undefined;
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (!fence && !/^(?: {0,3}>| {4}|\t)/.test(line)) published.push(line);
  }
  if (fence) return false;
  const current = published.filter(line => !/^(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/i.test(line)).join('\n');
  const section = (heading: RegExp): string | undefined => {
    const hits = published.flatMap((line, i) => heading.test(line) ? [i] : []);
    if (hits.length !== 1) return undefined;
    const start = hits[0]!, before = published.slice(0, start).filter(s => s.trim()).at(-1) ?? '';
    if (/[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(before)) return undefined;
    const end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const titles = [...current.matchAll(/^# Plan: (.+?)(?: \(reviewed\))?$/gm)];
  const targets = [...current.matchAll(/^Reviewed target: `([^`]+\.md)` on `([^`]+)`.*$/gm)];
  const sourceLines = q.question.split('\n').filter(line => /^Project\/branch\/task:/.test(line));
  if (titles.length !== 1 || targets.length !== 1 || sourceLines.length !== 1) return false;
  const title = titles[0]![1]!, source = targets[0]![1]!, branch = targets[0]![2]!;
  if (!new RegExp(`^Project/branch/task: [\\w.-]+ on ${escape(branch)}, ${escape(title)}(?: plan)?[.;]`).test(sourceLines[0]!)) return false;
  const ledger = section(/^## Decision ledger$/i), tasks = section(/^## Implementation Tasks$/), lanes = section(/^## Worktree parallelization strategy$/i), report = section(/^## GSTACK REVIEW REPORT$/);
  if (!ledger || !tasks || !lanes || !report) return false;
  const rows = ledger.split(/\n(?=### )/).filter(s => /^### /.test(s.trim()));
  const owned = rows.filter(s => new RegExp(`^### ${issue}: `).test(s.trim()));
  if (owned.length !== 1 || [...ledger.matchAll(/^State: pending\b/gmi)].length !== 1) return false;
  const row = owned[0]!;
  const field = (name: string) => { const found = [...row.matchAll(new RegExp(`^${name}: (.+)$`, 'gm'))]; return found.length === 1 ? found[0]![1]! : undefined; };
  const finding = field('Finding'), state = field('State'), answer = field('Actual answer'), scope = field('Accepted scope');
  if (!finding || !new RegExp(`(?:^|[ ,])${escape(source)}:\\d+\\b`).test(finding) ||
      [...finding.matchAll(/[\w./-]+\.md:\d+/g)].some(m => !m[0].startsWith(source + ':')) ||
      !/^pending \(Investigate\)$/i.test(state ?? '') || !answer || !scope ||
      !/^bounded investigation only:/i.test(scope) || !/\bNo (?:[\w-]+ )*implementation approved\./i.test(scope) ||
      !new RegExp(`\\b${issue} remains unresolved until re-asked\\b`, 'i').test(scope)) return false;
  const scopeRemainder = scope.replace(/\bNo (?:[\w-]+ )*implementation approved\./gi, '');
  if (changedInvestigation(row) || action.test(scopeRemainder) || /\bimplementation (?:is |now |is now )?approved\b|\brun\s+/i.test(scopeRemainder)) return false;
  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  if (!prior.length || new Set(identities).size !== prior.length || prior.some(c => c.sessionId !== call.sessionId ||
      !c.toolUseId || c.toolUseId === call.toolUseId || c.answered !== true || c.failed !== false ||
      !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
      !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length || !c.questions.length ||
      Object.keys(c.answers ?? {}).length !== c.questions.length || new Set(c.questions.map(v => v.question)).size !== c.questions.length ||
      c.questions.some(v => v.multiSelect || v.options.length < 2 || v.options.length > 4 ||
        new Set(v.options.map(o => o.label)).size !== v.options.length || !v.options.some(o => o.label === c.answers?.[v.question])))) return false;
  const approvals = prior.flatMap(c => c.questions.map(v => ({call:c, question:v}))).filter(({question:v}) =>
    new RegExp(`^D[1-9]\\d*\\s*[—–:-]\\s*${issue}:`).test(v.question));
  if (approvals.length !== 1) return false;
  const approved = approvals[0]!, priorQuestion = approved.question, selected = approved.call.answers![priorQuestion.question]!;
  const decision = /^(D[1-9]\d*)\s*[—–:-]/.exec(priorQuestion.question)![1]!;
  if (prior.some(c => Date.parse(c.answeredAt!) > Date.parse(approved.call.answeredAt!) && c.questions.some(v => {
    const text = statusText(v.question);
    return new RegExp(`\\b${issue}\\b`).test(text) && changedInvestigation(text, issue, false);
  }))) return false;
  const priorTitle = priorQuestion.question.split('\n')[0]!.replace(new RegExp(`^${decision}\\s*[—–:-]\\s*${issue}:\\s*`), '');
  const priorSource = priorQuestion.question.split('\n').filter(line => /^Project\/branch\/task:/.test(line));
  const savedQuestions = [...row.matchAll(/^Question (D[1-9]\d*): "([^"\n]+)" Options: .+$/gm)];
  if (!/^Investigate before choosing$/i.test(label(selected)) || priorSource.length !== 1 ||
      !new RegExp('^Project/branch/task: `' + escape(branch) + '`, ' + escape(source) + ' ' + escape(title) + ';').test(priorSource[0]!) ||
      savedQuestions.length !== 1 || savedQuestions[0]![1] !== decision || savedQuestions[0]![2] !== priorTitle ||
      label(answer.replace(new RegExp(` \\(${decision}\\)$`), '')) !== label(selected) || !answer.endsWith(`(${decision})`)) return false;
  const approvedDescription = priorQuestion.options.find(o => o.label === selected)?.description ?? '';
  if (!/\bre-asked\b/i.test(approvedDescription) || action.test(approvedDescription) || /\brun\s+|\bimplementation (?:is |now |is now )?approved\b/i.test(approvedDescription)) return false;

  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]+$/gm)];
  const ids = entries.map(m => m[1]!);
  const target = entries.filter(m => m[1] === task);
  const count = /\b([1-9]\d*) tasks\b/i.exec(ready.description ?? '');
  const laneCount = /\b([1-9]\d*) (?:parallel )?lanes\b/i.exec(ready.description ?? '');
  const laneIds = [...lanes.matchAll(/\bLane ([A-Z]):/g)].map(m => m[1]);
  if (!entries.length || new Set(ids).size !== ids.length || target.length !== 1 || !count || +count[1]! !== ids.length ||
      !laneCount || +laneCount[1]! !== laneIds.length || new Set(laneIds).size !== laneIds.length) return false;
  for (const ref of context.matchAll(/\b(T[1-9]\d*)(?:\s*[-–]\s*(T[1-9]\d*))?\b/g)) {
    const first = +ref[1]!.slice(1), last = +(ref[2] ?? ref[1]!).slice(1);
    if (last < first || last - first >= ids.length) return false;
    for (let id = first; id <= last; id++) if (!ids.includes(`T${id}`)) return false;
  }
  const start = target[0]!.index!, end = entries.find(m => m.index! > start)?.index ?? tasks.length;
  const taskLines = tasks.slice(start, end).trim().split('\n').filter(s => s.trim() && !/^_/.test(s));
  const taskBody = taskLines.join('\n');
  const taskField = (name: string) => { const found = taskLines.filter(line => line.startsWith(`  - ${name}: `)); return found.length === 1 ? found[0] : undefined; };
  const surfaced = taskField('Surfaced by'), files = taskField('Files'), verify = taskField('Verify');
  if (taskLines.length !== 4 || !/ — plan — (?:Enumerate|List|Inventory|Document)\b/i.test(taskLines[0]!) ||
      !surfaced || !new RegExp(`^  - Surfaced by: .*\\b${issue} / ${decision}\\b`).test(surfaced) ||
      !files || !/^  - Files: this plan, /i.test(files) || !verify || !new RegExp(`^  - Verify: .+; ${issue} re-asked$`, 'i').test(verify) ||
      action.test(taskBody) || /\b(?:implement|build|deploy|delete|add|approve)\b/i.test(taskBody)) return false;
  const table = /\bin (?:the|this) plan's "([^"\n]+)" table\./i.exec(scope)?.[1];
  if (!table || !files.includes('"' + table + '" table') ||
      !new RegExp(`\\b${issue}\\b`).test(taskLines[0]!) || !/\b(?:enumerate|list|inventory|document)\b/i.test(taskLines[0]!)) return false;
  const status = new RegExp(`\\b(?:${issue}|${decision}|${task})\\b(?: (?:task|decision|requirement|status))?\\s*(?::|is|was|has been|remains)?\\s*(?:now |still )?(?:withdrawn|cancelled|canceled|rejected|reopened|superseded|not (?:required|approved)|implementation approved)\\b`, 'i');
  if (status.test(current.replace(/["“”]/g, '')) || changedInvestigation(current, `${issue}|${decision}|${task}`, false) || invalidCompletion(report)) return false;
  const unresolved = report.split(/\*\*UNRESOLVED DECISIONS:\*\*/);
  if (unresolved.length !== 2 || !/\bEng Review ISSUES OPEN \(1 unresolved decision, 0 critical gaps\)/.test(report) ||
      !/\b(?:All|Every) P1 (?:remedies|fixes) (?:are|is) approved and specified\b/i.test(report) ||
      !/\bnot a blocker\b/i.test(report)) return false;
  const remaining = unresolved[1]!.trim().split('\n').filter(s => s.trim());
  return remaining.length === 1 && new RegExp(`^- ${issue} / ${decision} [—–-] .+: Investigate; re-ask .+\\(${task}\\)$`, 'i').test(remaining[0]!);
}

function hasCompleteEarlierNativeAnswers(call: NativePlanQuestionCall,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  return !!prior.length && new Set(identities).size === prior.length && !prior.some(c => c.sessionId !== call.sessionId ||
    c.toolUseId === call.toolUseId || !c.toolUseId || c.answered !== true || c.failed !== false ||
    !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
    !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length ||
    !c.questions.length || c.questions.length > 4 || Object.keys(c.answers ?? {}).length !== c.questions.length ||
    new Set(c.questions.map(q => q.question)).size !== c.questions.length ||
    c.questions.some(q => q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
      new Set(q.options.map(o => o.label)).size !== q.options.length ||
      !q.options.some(o => o.label === c.answers?.[q.question])));
}

function introducesSourceContext(line: string): boolean {
  return /[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(line);
}

/** Navigation may repeat already-approved post-review bookkeeping, but cannot
 * authorize it afresh or hide new implementation work behind a completion label. */
function isApprovedMaintenanceRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  if (isRecordedMaintenanceRecap(fp, plan, prior)) return true;
  const call = fp.nativeCall!, q = call.questions[0]!;
  const label = (s: string) => s.replace(/^[1-9]\d*[A-Z]\)\s*/, '').replace(/\s*\(recommended\)$/, '').trim();
  const current = (s: string) => !/^(?:\s*>|\s*`{3,}|\s*~{3,})|(?:^|\n)\s*(?:source|example|historical|quoted)\b|["“”]|\b(?:withdrawn|cancelled|canceled|rejected|superseded|no longer current|not approved|no longer approved|pending approval|if approved|once approved|assuming approval|provided approval)\b/i.test(s);
  if (q.multiSelect || !/^Next steps?$/i.test(q.header) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !/^D[1-9]\d*\s*[—–:-]\s*Next steps?[.:]/i.test(q.question) ||
      !/\bEng(?:ineering)? review is (?:clear(?:ed)?|complete[d]?)\b/i.test(q.question) ||
      !/\bno UI scope\b/i.test(q.question) || !/\bCEO review is optional\b/i.test(q.question) ||
      /\b(?:add|implement|rewrite|build|require|if|unless|assuming|provided|pending)\b/i.test(q.question) ||
      !current([q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n'))) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo || call.answers?.[q.question] !== ready.label) return false;
  const recap = /^Exit plan mode with the reviewed plan\. (?:Post-exit|After exiting): (.+)\.$/i.exec(ready.description ?? '');
  const actions = recap?.[1]?.split(/\s+and\s+|;\s*/);
  if (!actions || actions.length !== 2) return false;
  const routing = actions.filter(a => /^(?:append|add) (?:the )?(?:gstack )?routing rules to CLAUDE\.md$/i.test(a));
  const todos = actions.map(a => /^(?:create|write) TODOS\.md with (?:the )?(one|two|three|four|five|six|seven|eight|nine|[1-9]) accepted items?$/i.exec(a)).filter(Boolean);
  if (routing.length !== 1 || todos.length !== 1) return false;
  const count = Number(todos[0]![1]) || ['one','two','three','four','five','six','seven','eight','nine'].indexOf(todos[0]![1]!.toLowerCase()) + 1;
  if (!hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const approved = prior.flatMap(c => c.questions.map(q => ({ q, selected: label(c.answers![q.question]!) })));
  const routingCalls = approved.filter(({q}) => q.header === 'Routing');
  if (routingCalls.length !== 1 || routingCalls.filter(({q, selected}) => current(q.question) &&
      /\bskill routing rules\b/.test(q.question) && /CLAUDE\.md/.test(q.question) &&
      /^(?:Add|Append) (?:gstack )?routing rules to CLAUDE\.md$/.test(selected)).length !== 1) return false;
  const accepted = approved.filter(({q, selected}) => /^TODO [1-9]\d*$/.test(q.header) &&
    selected === 'Add to TODOS.md' && current(q.question) &&
    /\bCaptured in the plan's TODOS section now\b/.test(q.options.find(o => label(o.label) === selected)?.description ?? ''));
  if (accepted.length !== count || approved.filter(({q}) => /^TODO [1-9]\d*$/.test(q.header)).length !== count ||
      new Set(accepted.map(a => a.q.header)).size !== count) return false;
  // Only current, unfenced TODO headings in the published report bind the recap.
  let fence: string | undefined;
  const lines = plan.split(/\r?\n/).filter(line => {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; return false; }
    return !fence && !/^(?: {0,3}>| {4}|\t)/.test(line);
  });
  if (fence) return false;
  const starts = lines.flatMap((line, i) => /^## TODOS?(?:\.md)?\b/i.test(line) ? [i] : []);
  if (starts.length !== 1 || !current(lines[starts[0]!]!) || /:\s*$/.test(lines.slice(0, starts[0]).filter(s => s.trim()).at(-1) ?? '')) return false;
  const tail = lines.slice(starts[0]! + 1), end = tail.findIndex(line => /^## /.test(line));
  const blocks = (end < 0 ? tail : tail.slice(0, end)).join('\n').trim().split(/\n(?=### )/);
  return blocks.length === count && accepted.every(({q}) => {
    const subjects = q.question.split('\n')[0]!.match(/\b(?:[a-z]+|[A-Z][a-z]+)(?:[A-Z][A-Za-z0-9]*)+\b/g) ?? [];
    return subjects.length === 1 && blocks.filter(b => /^### /.test(b) && current(b) &&
      new RegExp(`\\b${subjects[0]}\\b`).test(b.split('\n')[0]!)).length === 1;
  });
}

/** Reference-bearing navigation can repeat approved post-exit maintenance and
 * the published first task. Bind each D/T reference to the current report and
 * actual earlier native answers; this never supplies report or exit evidence. */
function isRecordedMaintenanceRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => s.trim().replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '')
    .replace(/\s*\((?:recommended|optional|soft(?:: optional)?)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(q.header.trim()) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      Date.parse(call.answeredAt!) > Date.now()) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo || call.answers?.[q.question] !== ready.label || !/^Optional (?:strategy|scope)/i.test(ceo.description ?? '')) return false;
  const recap = /^Exit plan mode[.;] (?:start|begin) with (T[1-9]\d*) (?:fixtures|characterization tests), then (?:write|create) CLAUDE\.md routing rules \((D[1-9]\d*)\) and TODOS\.md \((D[1-9]\d*(?:\/D[1-9]\d*)*)\)\.$/i.exec(ready.description ?? '');
  if (!recap) return false;
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const positive = q.question.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const eng = '(?:(?:the |this )?eng(?:ineering)? review|the review|this review)';
  const completed = '(?:clear(?:ed)?|complete[d]?|done|finished)';
  const invalid = new RegExp(`\\b${eng}\\b[^.!?;\\n]{0,100}\\b(?:not|never|incomplete|unfinished|pending|withdrawn|superseded|cancelled|canceled|reopened)\\b|\\b${eng}\\s+(?:will|would|may|might|could|should) (?:be )?${completed}\\b|\\b${eng}\\b[^.!?;\\n]{0,100}\\b${completed}\\b[^.!?;\\n]{0,80}\\b(?:if|when|once|unless|provided|assuming|after)\\b|\\b(?:if|when|once|unless|provided|assuming)\\b[^.!?;\\n]{0,80}\\b${eng}\\b`, 'i');
  if (!/\b(?:where next|next steps?)\b/i.test(positive) ||
      !new RegExp(`\\b${eng} (?:is |has been )?${completed}\\b`, 'i').test(positive) ||
      !/\b(?:every finding has an approved fix|all decisions (?:are )?(?:answered|settled))\b/i.test(positive) ||
      !/\b(?:remaining|only) choice is whether\b/i.test(positive) ||
      invalid.test(context) || /(?:^|\n)\s*>|`{3}|~{3}|\b(?:example|quoted|historical)\s*:/i.test(context) ||
      /\b(?:not every finding|not all decisions|unanswered|unresolved|unapproved|pending approval)\b/i.test(context)) return false;
  // Only the already-bound selected recap may contain implementation commands.
  const actions = context.replace(ready.description!, '');
  // A new obligation is substantive whether phrased as a command, a need,
  // a dependency or a declared requirement. Only the bound recap is exempt.
  const obligation = /\b(?:must|shall|should|requires?|needs?)\s+\S|\b(?:depends on|required to)\s+\S|\b(?:is|are|becomes?|remains?)\s+(?:now |still )?(?:required|mandatory|a prerequisite)\b/i;
  if (/(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while)\s+)(?:please\s+)?(?:add|remove|delete|replace|rewrite|change|alter|modify|enable|disable|implement|install|introduce|build|write|record|capture|create|switch|migrate|refactor|expand|reduce|deploy|approve)\b/i.test(actions) ||
      /\brun\s+(?!\/(?:ship|plan-ceo-review)\b)|\b(?:new|additional|extra) (?:work|implementation|scope|task|requirement|dependency|feature|datastore|database|cache|test|prerequisite)\b/i.test(actions) || obligation.test(actions)) return false;

  const published: string[] = [], hierarchy: { depth: number; inactive: boolean }[] = [];
  let fence: string | undefined, preceding = '';
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (fence || /^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) { while (hierarchy.at(-1) && hierarchy.at(-1)!.depth >= h[1]!.length) hierarchy.pop(); hierarchy.push({depth:h[1]!.length,inactive:introducesSourceContext(preceding) || /\b(?:history|historical|archived?|example|quoted|template|withdrawn|superseded)\b/i.test(h[2]!)}); }
    // Keep the preceding visible line even in an inactive section, so source
    // context follows its heading's descendants and ends at the next sibling.
    if (line.trim()) preceding = line;
    if (!hierarchy.some(h => h.inactive)) published.push(line);
  }
  if (fence) return false;
  const current = published.join('\n'), titles = [...current.matchAll(/^# Plan: (.+) \(reviewed\)$/gm)];
  const owners = [...current.matchAll(/^(?:<!-- )?Reviewed target: ([\w./-]+\.md) \("Plan: ([^"\n]+)"\) in (\/[\w./-]+), branch ([\w./-]+), commit [a-f0-9]+\./gm)];
  const metadata = [...q.question.matchAll(/^Project\/branch\/task: ([\w.-]+) @ ([\w./-]+) [—–-] ([^,\n]+),/gm)];
  if (titles.length !== 1 || owners.length !== 1 || metadata.length !== 1 || titles[0]![1] !== owners[0]![2] ||
      metadata[0]![1] !== owners[0]![3]!.split('/').at(-1) || metadata[0]![2] !== owners[0]![4] || metadata[0]![3] !== titles[0]![1]) return false;
  const source = owners[0]![1]!, branch = owners[0]![4]!;
  const section = (heading: RegExp) => {
    const hits = published.flatMap((line, i) => heading.test(line) ? [i] : []);
    if (hits.length !== 1) return undefined;
    const start = hits[0]!, end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const report = section(/^## GSTACK REVIEW REPORT$/), ledger = section(/^## Decision ledger$/), tasks = section(/^## Implementation Tasks$/), todos = section(/^## Accepted TODOs(?: \([^\n]*\))?$/);
  if (!report || !ledger || !tasks || !todos || report.trim().split('\n').at(-1) !== 'NO UNRESOLVED DECISIONS' ||
      !/^\| Eng Review \|[^\n]*\| CLEAR \|[^\n]*\b0 critical gaps\b/m.test(report) ||
      !/^- \*\*VERDICT:\*\* ENG CLEARED\b/m.test(report) || invalid.test(report) ||
      !/^Approval readiness: PASS\b/m.test(ledger)) return false;
  if (!hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const answers = prior.flatMap(c => c.questions.map(q => ({q,id:/^(D[1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1],selected:c.answers![q.question]!})));
  if (answers.some(a => !a.id) || new Set(answers.map(a => a.id)).size !== answers.length) return false;
  const withdrawn = /\b(?:approval|decision|scope|task|TODO|routing rules)\s*(?:is|was|has been|:)?\s*(?:now )?(?:withdrawn|revoked|rejected|cancelled|canceled|reopened|superseded|not approved|pending approval)\b/i;
  if (withdrawn.test(context) || withdrawn.test(current) || answers.some(a => withdrawn.test(a.q.question))) return false;
  const rows = ledger.split(/\n(?=### )/).filter(row => /^### R[1-9]\d*:/.test(row.trim()));
  const bound = new Set<string>();
  for (const row of rows) {
    const states = [...row.matchAll(/^State: (.+)$/gm)], decision = [...row.matchAll(/^Question (D[1-9]\d*):/gm)];
    const selected = [...row.matchAll(/^Actual answer: ([A-Z]) [—–-] (D[1-9]\d*) answer "([^"\n]+)"$/gm)];
    if (states.length !== 1 || states[0]![1] !== 'approved' || decision.length !== 1 || selected.length !== 1 || decision[0]![1] !== selected[0]![2]) return false;
    const answer = answers.find(a => a.id === decision[0]![1]);
    if (!answer || bound.has(answer.id!) || selected[0]![3] !== answer.selected ||
        answer.q.options.findIndex(o => o.label === answer.selected) !== selected[0]![1]!.charCodeAt(0) - 65 ||
        !new RegExp(`^Project/branch/task: ${escape(branch)}[,;] ${escape(source)}\\b`, 'm').test(answer.q.question)) return false;
    bound.add(answer.id!);
  }
  if (!rows.length || [...ledger.matchAll(/^State: /gm)].length !== rows.length) return false;
  const routing = answers.find(a => a.id === recap[2]), todoIds = recap[3]!.split('/');
  if (!routing || routing.q.header !== 'Routing' || label(routing.selected) !== 'Add routing rules to CLAUDE.md' ||
      !new RegExp(`^Project/branch/task: ${escape(branch)} branch[^\\n]*\\b${escape(source)}\\b`, 'm').test(routing.q.question) ||
      !new RegExp(`\\b${recap[2]} \\(CLAUDE\\.md routing rules, setup, answered A;`).test(ledger) || new Set(todoIds).size !== todoIds.length) return false;
  const blocks = todos.split(/\n(?=### )/).filter(block => /^### TODO [1-9]\d*:/.test(block.trim()));
  if (blocks.length !== todoIds.length) return false;
  for (const id of todoIds) {
    const a = answers.find(a => a.id === id), number = a && new RegExp(`^Project/branch/task: ${escape(branch)}, ${escape(source)} ${escape(titles[0]![1]!)}, TODO ([1-9]\\d*) of ([1-9]\\d*)\\b`, 'm').exec(a.q.question);
    if (!a || a.q.header !== 'TODO' || label(a.selected) !== 'Add to TODOS.md' || !number || +number[2]! !== todoIds.length ||
        blocks.filter(block => block.trim().startsWith(`### TODO ${number[1]}:`)).length !== 1 ||
        !new RegExp(`\\b${id}/A\\b`).test(ledger) || !new RegExp(`\\b${id}\\b`).test(tasks)) return false;
  }
  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]+/gm)];
  if (!entries.length || new Set(entries.map(e => e[1])).size !== entries.length) return false;
  for (const ref of context.matchAll(/\bT([1-9]\d*)(?:[–-]T([1-9]\d*))?\b/g)) {
    const first = +ref[1]!, last = +(ref[2] ?? ref[1])!;
    if (last < first || last - first >= entries.length) return false;
    for (let n = first; n <= last; n++) if (!entries.some(e => e[1] === `T${n}`)) return false;
  }
  const firstTask = entries.filter(e => e[1] === recap[1]);
  return firstTask.length === 1 && /\bRecord\b[^\n]*\bcharacterization fixtures\b[^\n]*\bbefore any rewrite\b/.test(firstTask[0]![0]) &&
    new RegExp(`^1\\. Record characterization fixtures[^\\n]*\\(${recap[1]}\\)\\. Commit\\.$`, 'm').test(current);
}

/** A finished backend review may recap an already-published author prerequisite.
 * This classifies only its completed navigation; the runner still independently
 * requires the owned report, fresh modifying decisions and a later native exit.
 */
function isPublishedPrerequisiteHandoff(fp: AskUserQuestionFingerprint, reviewedPlan: string): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  if (q.multiSelect || q.header.trim() !== 'Next' || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question]) || /<gstack-qid/i.test(q.question)) return false;
  const lines = q.question.trim().split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length !== 7 || !/^D[1-9]\d* [—–-] Next step after this eng review\?$/.test(lines[0]!) ||
      !/^Project\/branch\/task: [\w.-]+ on [\w./-]+, reviewed plan written to gstack-test-plan-eng\.md\.$/.test(lines[1]!) ||
      lines[2] !== 'ELI10: The eng review is the only gate that blocks shipping and it is clear. No UI is touched, so a design review does not apply. A CEO review is optional and normally for product-direction changes; this is a backend auth refactor, so it is a soft mention only.' ||
      lines[3] !== 'Stakes if we pick wrong: Low either way; the CEO review would cost time on a change with no product-facing scope decision left open.' ||
      lines[5] !== 'Note: options differ in kind, not coverage — no completeness score.' ||
      lines[6] !== 'Net: start implementing versus an optional strategy pass on a backend refactor.') return false;
  const recommendation = /^Recommendation: ([A-Z]) because all required reviews are complete and the plan's remaining blocker is the author confirming the Context section, not another review\.$/.exec(lines[4]!);
  const ready = q.options.find(o => /^[A-Z]\) Ready to implement \(recommended\)$/.test(o.label));
  const ceo = q.options.find(o => /^[A-Z]\) Run \/plan-ceo-review$/.test(o.label));
  if (!recommendation || !ready || !ceo || ready.label[0] !== recommendation[1] || ready.label[0] === ceo.label[0]) return false;
  const task = /^✅ All relevant reviews complete; run \/ship when the work is done\. ✅ The first task is the author confirming Context, then T([1-9]\d*) characterization tests\. ❌ No second strategic opinion on whether the refactor is the right thing to build now\.$/.exec(ready.description ?? '');
  if (!task || ceo.description !== '✅ Adds a scope-and-strategy pass before any code is written. ✅ Useful if the refactor\'s business motivation is contested. ❌ Backend-only refactor with no product-direction choice; likely low yield for the time.') return false;

  // Only the published Context and Implementation Tasks sections own the
  // references. Quoted or fenced examples cannot supply a prerequisite/task.
  const published: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of reviewedPlan.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1]![0] !== '`' || !open[2]!.includes('`'))) {
      fence = { marker: open[1]![0]!, length: open[1]!.length }; continue;
    }
    if (!/^(?: {4}|\t| {0,3}>)/.test(line)) published.push(line);
  }
  if (fence) return false;
  const section = (heading: string): string | undefined => {
    const hits = published.flatMap((line, i) => line === `## ${heading}` ? [i] : []);
    if (hits.length !== 1) return undefined;
    const start = hits[0]!;
    const preceding = published.slice(0, start).filter(s => s.trim()).at(-1) ?? '';
    if (introducesSourceContext(preceding)) return undefined;
    const end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const context = section('Context'), tasks = section('Implementation Tasks');
  if (!context || !tasks) return false;
  const prerequisite = /^### Prerequisite P(\d+) \(decision D[1-9]\d* → [1-9]\d*[A-Z]\)\nImplementation does not start until the author confirms or edits the Problem, Goal,\nInvariants and Latency target above\./m.exec(context);
  if (!prerequisite || !context.includes(`author must confirm — see Prerequisite P${prerequisite[1]} below`)) return false;
  const entries = [...tasks.matchAll(/^- \[ \] \*\*T([1-9]\d*)\b[^\n]+$/gm)];
  const referenced = entries.filter(t => t[1] === task[1]);
  if (referenced.length !== 1 || !/ — auth\/legacy — Write characterization tests for `legacyAuthFlow\(\)` before any rewrite$/.test(referenced[0]![0])) return false;
  const prerequisiteTail = context.slice(prerequisite.index!);
  const nextPrerequisiteHeading = prerequisiteTail.indexOf('\n### ', 1);
  const prerequisiteOwner = nextPrerequisiteHeading < 0 ? prerequisiteTail : prerequisiteTail.slice(0, nextPrerequisiteHeading);
  const taskStart = referenced[0]!.index!;
  const nextTask = entries.find(entry => entry.index! > taskStart)?.index ?? tasks.length;
  // A later correction inside the same owner can withdraw its earlier rule.
  // Unrelated prerequisite/task bodies cannot supply or revoke this reference.
  const withdrawn = (owner: string, id: string) => new RegExp(
    `\\b(?:Prerequisite )?${id}\\b(?: (?:requirement|task))? (?:is |was |has been )?(?:cancelled|canceled|withdrawn|rejected|not (?:required|needed|necessary))\\b`, 'i').test(owner);
  return !withdrawn(prerequisiteOwner, `P${prerequisite[1]}`) &&
    !/\b(?:the )?author no longer needs to confirm Context\b|\bContext confirmation is (?:not required|cancelled|withdrawn)\b/i.test(prerequisiteOwner) &&
    !withdrawn(tasks.slice(taskStart, nextTask), `T${task[1]}`) &&
    !/\bno characterization tests (?:are )?required\b|\bcharacterization tests are (?:not required|cancelled|withdrawn)\b/i.test(tasks.slice(taskStart, nextTask));
}

/** A completed ready/optional-review menu may recap the already-published task
 * and lane catalog. This classifies administration; the runner still proves the
 * owned, fresh report and the later native ExitPlanMode independently. */
function isPublishedReadyNavigation(fp: AskUserQuestionFingerprint, reviewedPlan: string): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const label = (s: string) => compact(s).replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(q.header.trim()) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo) return false;
  // Only the current prose can assert completion; quoted examples cannot.
  const body = compact(q.question.replace(/"[^"]*"|“[^”]*”/g, '')).replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  // Keep raw instructions for vetoes: quoted commands cannot disappear merely
  // because quoted text cannot establish positive completion evidence.
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const statusContext = context.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '').replace(/["“”'‘’]/g, '');
  if (/\bnot (?:all|every) decisions?\b|\bdecisions?\s+(?:(?:is|are|remains?)\s+|status:\s*)?(?:still\s+)?(?:unanswered|unresolved|pending|reopened|not answered|not settled|open)\b/i.test(statusContext)) return false;
  // These are assertions about a finished review and an action-only next-step
  // choice, not a required seven-line transcript or a particular risk sentence.
  const eng = String.raw`(?:(?:the |this )?(?:eng(?:ineering)? review|eng gate)|this review|the review|the verdict|all required reviews)`;
  const complete = String.raw`(?:clear(?:ed)?|complete[d]?|done|finished)`;
  const explicitNavigation = /\b(?:navigation|routing) only\b|\bonly (?:selects?|chooses?|changes?) (?:the )?next (?:step|workflow|review)\b/i.test(body) &&
    /\b(?:approves?|authorizes?|adds?|makes?) no (?:new )?(?:implementation|scope) (?:changes?|work)\b|\b(?:does not|doesn't|will not|won't|neither) (?:authorize|approve|add|change|alter|modify)(?: nor (?:authorize|approve|add|change|alter|modify))? (?:any )?(?:new )?(?:implementation|scope|requirements?|work)\b|\bwithout (?:any )?(?:new )?(?:implementation|scope) changes?\b/i.test(body);
  // A completed two-route menu need not repeat a no-change disclaimer. Its
  // settled decisions, sole remaining workflow choice and named reviewed plan
  // supply the same boundary; task ownership and new-work vetoes still apply.
  const metadata = [...q.question.matchAll(/^Project\/branch\/task: ([^\n]+)$/gm)];
  const currentScope = metadata.length === 1 ? /^([^\s,;]+), (PLAN\.md) ["“]([^"”\n]+)["”](?:;|$)/.exec(metadata[0]![1]!) : null;
  const catalogMenu = /\b(?:0|no) unresolved decisions\b/i.test(body)
    && /\b(?:navigation|routing) only\b/i.test(body)
    && /\bnothing (?:here )?(?:changes|alters|modifies) (?:the|this) plan (?:or|and) (?:its|the) tasks\b|\b(?:the|this) plan and its tasks remain unchanged\b/i.test(body);
  if (catalogMenu && !currentScope) return false;
  const catalogChoice = Boolean(catalogMenu && currentScope);
  if (catalogChoice && (
      [...metadata[0]![1]!.matchAll(/[^\s,;"“”]+\.md\b/g)].some(m=>m[0]!=='PLAN.md')
      || /\b(?:review|eng gate|verdict) (?:is |has been |remains? )?(?:no longer|not) (?:clear|complete|done|finished)\b|\b[1-9]\d* unresolved decisions\b/i.test(statusContext)
      || /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|while)\s+)(?:approve|deploy)(?:ing)?\b/i.test(statusContext))) return false;
  const completedChoice = Boolean(catalogChoice) || /\b(?:all decisions (?:are )?(?:answered|settled)|every decision (?:is )?(?:answered|settled))\b/i.test(body) &&
    /\b(?:the only question left is whether to (?:start building|implement) or (?:first )?get (?:a )?(?:strategy-level second look|strategy review)|only the next (?:step|workflow) remains: implementation or an optional strategy review)\b/i.test(body);
  const namedPlans = [...q.question.matchAll(/\breviewed\s+[\w./-]+\.md\s+["“]([^"”\n]+)["”]/gi)];
  if (!/\b(?:what(?:['’]s| is)? (?:the )?next|next steps?|where (?:do|should) we go)\b/i.test(body) ||
      !new RegExp(String.raw`\b${eng}\s+(?:(?:is|are|has been|have been)\s+)?(?:now\s+)?${complete}\b`, 'i').test(body) ||
      !(explicitNavigation || completedChoice && (namedPlans.length === 1 || catalogChoice))) return false;
  if (/`{3}|~{3}|(?:^|\n)\s*>|\b(?:example|sample|quoted|historical)\s*:/i.test(context) ||
      new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b(?:not|never|incomplete|unfinished|pending|withdrawn|superseded|cancelled|canceled|reopened)\b`, 'i').test(context) ||
      new RegExp(String.raw`\b${eng}\s+(?:will|would|may|might|can|could|should)\s+(?:be |become )?${complete}\b`, 'i').test(context) ||
      new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b${complete}\b[^.!?;\n]{0,100}\b(?:if|when|once|unless|provided|assuming|after)\b`, 'i').test(context) ||
      new RegExp(String.raw`\b(?:if|when|once|unless|provided|assuming)\b[^.!?;\n]{0,100}\b${eng}\b[^.!?;\n]{0,60}\b${complete}\b`, 'i').test(context)) return false;
  // Finite offered actions are navigation. Descriptions may explain their
  // tradeoffs, but cannot append a new implementation command or obligation.
  const proposedWork = /\b(?:new|additional|extra)\s+(?:implementation|scope|requirement|task|dependency|feature|datastore|database|cache|test|prerequisite)\b|\b(?:must|shall|should|needs? to|have to|has to|required to)\s+(?!run \/plan-ceo-review\b|run \/ship\b)[a-z]/i;
  const implementationAction = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|cut(?:ting)?|drop(?:ping)?|replac(?:e|ing)|rewrit(?:e|ing)|chang(?:e|ing)|alter(?:ing)?|modif(?:y|ying)|enabl(?:e|ing)|disabl(?:e|ing)|implement(?:ing)?|install(?:ing)?|introduc(?:e|ing)|build(?:ing)?|writ(?:e|ing)|record(?:ing)?|captur(?:e|ing)|creat(?:e|ing)|switch(?:ing)?|migrat(?:e|ing)|externaliz(?:e|ing)|refactor(?:ing)?|expand(?:ing)?|reduc(?:e|ing))\b/i;
  // An explicit negative is inert only within its clause; appended work after
  // a conjunction or punctuation remains subject to the same action checks.
  const actionContext=context.replace(/\b(?:approves?|authorizes?|adds?|makes?) no (?:new )?(?:implementation|scope) (?:changes?|work)\b/gi,'')
    .replace(/\b(?:does not|doesn't|will not|won't|neither) (?:authorize|approve|add|change|alter|modify)(?: nor (?:authorize|approve|add|change|alter|modify))? (?:any )?(?:new )?(?:implementation|scope|requirements?|work)(?: changes?)?\b/gi,'')
    .replace(/\bwithout (?:any )?(?:new )?(?:implementation|scope) changes?\b/gi,'');
  if(proposedWork.test(actionContext)||implementationAction.test(actionContext)||/\brun\s+(?!\/(?:ship|plan-ceo-review)\b)/i.test(actionContext))return false;
  const taskRefs=[...context.matchAll(/\bT([1-9]\d*)(?:\s*(?:[–-]|through|to)\s*T([1-9]\d*))?\b/g)];
  if(!taskRefs.length)return false;
  const laneRefs=[...context.matchAll(/\b[Ll]anes?\s+([A-Z](?:\s*\+\s*[A-Z])*(?:(?:,?\s*then\s+|\s*→\s*)[A-Z](?:\s*\+\s*[A-Z])*)*)/g)];
  if(!laneRefs.length && !completedChoice)return false;
  // Only active, unfenced sections own a recap. A copied report/task list cannot.
  const published: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of reviewedPlan.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1]![0] !== '`' || !open[2]!.includes('`'))) { fence = {marker:open[1]![0]!,length:open[1]!.length}; continue; }
    if (!/^(?: {4}|\t| {0,3}>)/.test(line)) published.push(line);
  }
  if (fence) return false;
  if (!explicitNavigation || catalogChoice) {
    const titles = published.filter(line => /^# /.test(line));
    const named = catalogChoice ? currentScope![3]! : namedPlans[0]![1]!;
    if (titles.length !== 1 || compact(titles[0]!.replace(/^# (?:Plan: )?/i, '').replace(/\s+\(reviewed\)$/i, '')) !== compact(named)) return false;
    if (catalogChoice) {
      const targets = published.filter(line => /^Reviewed target:/.test(line));
      const target = targets.length === 1 ? /^Reviewed target: `?([\w./-]+\.md)`? \(repo root, branch `?([^`\s)]+)`?\)/.exec(targets[0]!) : null;
      if (!target || target[1] !== currentScope![2] || target[2] !== currentScope![1]) return false;
    }
  }
  const section = (heading: string) => {
    const starts=published.flatMap((line,i)=>line.toLowerCase()===`## ${heading}`.toLowerCase()?[i]:[]);
    if(starts.length!==1)return undefined;
    const start=starts[0]!;
    if(/[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(published.slice(0,start).filter(s=>s.trim()).at(-1)??''))return undefined;
    const end=published.findIndex((line,i)=>i>start&&/^#{1,2} /.test(line));
    return published.slice(start+1,end<0?undefined:end).join('\n');
  };
  const tasks=section('Implementation Tasks'), lanes=section('Worktree parallelization strategy'), report=section('GSTACK REVIEW REPORT');
  if(!tasks||!lanes||!report||!/\| Eng Review \|[^\n]*\| CLEAR(?: \([^\n|]*\))? \|/.test(report)||
      !/^(?:[-*] )?(?:\*\*)?VERDICT:(?:\*\*)? ENG CLEARED\b/m.test(report)||
      report.trim().split('\n').at(-1)!=='NO UNRESOLVED DECISIONS')return false;
  const entries=[...tasks.matchAll(/^- \[ \] \*\*T([1-9]\d*)\b[^\n]+/gm)];
  for(const ref of taskRefs) {
    const first=Number(ref[1]),last=Number(ref[2]??ref[1]);
    if(last<first||last-first+1>entries.length)return false;
    for(let id=first;id<=last;id++) {
      const own=entries.filter(e=>Number(e[1])===id);
      if(own.length!==1)return false;
      const end=entries.find(e=>e.index!>own[0]!.index!)?.index??tasks.length;
      if(new RegExp(`\\bT${id}\\b[^.!?\\n]*\\b(?:withdrawn|cancelled|canceled|rejected|not approved|pending approval)\\b`,'i').test(tasks.slice(own[0]!.index!,end)))return false;
    }
  }
  const groups=(text:string)=>[...text.matchAll(/\b[A-Z](?:\s*\+\s*[A-Z])*\b/g)].map(m=>m[0].replace(/\s/g,''));
  const execution=lanes.split('\n').filter(line=>/^Execution:/.test(line));
  return execution.length===1 && /\bLane [A-Z]:/.test(lanes) && laneRefs.every(ref=>
    JSON.stringify(groups(execution[0]!))===JSON.stringify(groups(ref[1]!)) &&
    groups(ref[1]!).flatMap(s=>s.split('+')).every(id=>new RegExp(`\\bLane ${id}:`).test(lanes)));
}

/** A completed implementation-or-pause menu can recap a published task graph
 * and previously answered bookkeeping. It grants navigation credit only. */
function isPublishedTaskPauseNavigation(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s.replace(/\*\*/g, '')).replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  if (q.multiSelect || !/^Next steps?$/i.test(q.header.trim()) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) || !hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const ready = q.options.find(o => /^Ready to implement(?:\s*[,—–-]\s*run \/ship when done)?$/i.test(label(o.label)));
  const pause = q.options.find(o => /^Pause here(?:, no further action this session)?$/i.test(label(o.label)));
  if (!ready || !pause || !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const currentText = (s: string) => s.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '');
  const status = currentText(context).replace(/["“”'‘’]/g, '');
  const positive = currentText(q.question).replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const eng = '(?:(?:the |this )?(?:eng(?:ineering)? review|eng gate)|the review|this review|all required reviews)';
  const complete = '(?:clear(?:ed)?|complete[d]?|done|finished)';
  const incomplete = new RegExp(`\\b${eng}\\b[^.!?;\\n]{0,100}\\b(?:not|never|incomplete|unfinished|pending|withdrawn|revoked|superseded|cancelled|canceled|reopened)\\b|\\b${eng}\\s+(?:will|would|may|might|could|should) (?:be )?${complete}\\b|\\b${eng}\\b[^.!?;\\n]{0,100}\\b${complete}\\b[^.!?;\\n]{0,80}\\b(?:if|when|once|unless|provided|assuming|after)\\b|\\b(?:if|when|once|unless|provided|assuming)\\b[^.!?;\\n]{0,80}\\b${eng}\\b`, 'i');
  if (!/^D[1-9]\d*\s*[—–:-]\s*Next steps? after this eng(?:ineering)? review\?/i.test(positive) ||
      !new RegExp(`\\b${eng} (?:is |has been )?${complete}\\b`, 'i').test(positive) ||
      !/\b(?:every decision is|all decisions are) (?:answered|settled)\b/i.test(positive) ||
      !/\b(?:navigation|routing) only\b/i.test(positive) ||
      !/\b(?:this question|this choice) (?:approves?|authorizes?) no (?:new )?implementation changes?\b/i.test(positive) ||
      /(?:^|\n)\s*>|`{3}|~{3}|\b(?:example|sample|quoted|historical)\s*:/i.test(context) || incomplete.test(status) ||
      /\bnot (?:all|every) decisions?\b|\bdecisions?\s+(?:(?:is|are|remains?)\s+|status:\s*)?(?:still )?(?:unanswered|unresolved|pending|reopened|not answered|not settled|open)\b/i.test(status)) return false;

  const published: string[] = [], hierarchy: { depth: number; inactive: boolean }[] = [];
  let fence: string | undefined, preceding = '';
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (fence || /^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) { while (hierarchy.at(-1) && hierarchy.at(-1)!.depth >= h[1]!.length) hierarchy.pop(); hierarchy.push({depth:h[1]!.length,inactive:introducesSourceContext(preceding) || /\b(?:history|historical|archived?|example|quoted|template|withdrawn|superseded)\b/i.test(h[2]!)}); }
    if (line.trim()) preceding = line;
    if (!hierarchy.some(h => h.inactive)) published.push(line);
  }
  if (fence) return false;
  const current = published.join('\n');
  const titles = [...current.matchAll(/^# Plan: (.+) \(reviewed\)$/gm)];
  const owners = [...current.matchAll(/^Reviewed target: `([^`\n]+\.md)` \("Plan: ([^"\n]+)"\) in repo `([^`\n]+)`, branch `([^`\n]+)`, commit `[a-f0-9]+`\.$/gm)];
  if (titles.length !== 1 || owners.length !== 1 || titles[0]![1] !== owners[0]![2]) return false;
  const metadata = `Project/branch/task: ${owners[0]![3]} on ${owners[0]![4]}, reviewing ${owners[0]![1]} (${owners[0]![2]}).`;
  const sameOwner = (text: string) => { const found = text.split('\n').filter(s => /^Project\/branch\/task:/.test(s)); return found.length === 1 && found[0] === metadata; };
  if (!sameOwner(q.question) || prior.some(c => c.questions.length !== 1 || !sameOwner(c.questions[0]!.question))) return false;
  const section = (heading: RegExp) => {
    const starts = published.flatMap((line, i) => heading.test(line) ? [i] : []);
    if (starts.length !== 1) return undefined;
    const start = starts[0]!, end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const ledger = section(/^## Decision ledger$/), tasks = section(/^## Implementation Tasks$/), graph = section(/^## Worktree parallelization strategy$/), report = section(/^## GSTACK REVIEW REPORT$/);
  if (!ledger || !tasks || !graph || !report || report.trim().split('\n').at(-1) !== 'NO UNRESOLVED DECISIONS' || incomplete.test(report) || /\b[1-9]\d* unresolved decisions?\b/i.test(report) ||
      report.split('\n').filter(s => /^\| Eng Review \|/.test(s)).length !== 1 ||
      !/^\| Eng Review \|[^\n]*\| CLEAR \|[^\n]*\b0 critical gaps\b/m.test(report) ||
      report.split('\n').filter(s => /^(?:- )?\*\*VERDICT:\*\*/.test(s)).length !== 1 ||
      !/^(?:- )?\*\*VERDICT:\*\* ENG CLEARED\b/m.test(report)) return false;
  const finalId = /^(D[1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
  const approvals = prior.map(c => ({call:c,q:c.questions[0]!,id:/^(D[1-9]\d*)\s*[—–:-]/.exec(c.questions[0]!.question)?.[1],selected:c.answers![c.questions[0]!.question]!}));
  if (!finalId || approvals.some(a => !a.id || a.id === finalId) || new Set(approvals.map(a => a.id)).size !== approvals.length) return false;
  const selectedLetter = (a: typeof approvals[number]) => {
    const explicit = /^(?:[1-9]\d*)?([A-Z])[).:]\s/.exec(a.selected)?.[1];
    const named = [...a.q.question.matchAll(/^([A-Z])\) (.+)$/gm)].filter(m => label(m[2]!.replace(/\s+\(human:.*$/, '')) === label(a.selected));
    const recommendation = [...a.q.question.matchAll(/^Recommendation: ([A-Z]) because\b/gm)];
    return explicit ?? (named.length === 1 ? named[0]![1]! : /\(recommended\)$/i.test(a.selected) &&
      a.q.options.filter(o => /\(recommended\)$/i.test(o.label)).length === 1 && recommendation.length === 1 ? recommendation[0]![1] : undefined);
  };
  if (approvals.some(a => !selectedLetter(a))) return false;
  const revoked = /\b(?:[DRT][1-9]\d*|approval|decision|scope|task|TODO|routing rules)(?: (?:decision|scope|state|approval|task))?\s*(?::|is|was|has been|remains)?\s*(?:now |still )?(?:withdrawn|revoked|cancelled|canceled|rejected|reopened|superseded|not approved|no longer approved|pending approval|pending|unanswered|unresolved)\b/i;
  if ([status, currentText(current), ...approvals.map(a => currentText(a.q.question))].some(s => revoked.test(s.replace(/["“”'‘’]/g, '')))) return false;
  const rows = ledger.split(/\n(?=### )/).filter(s => /^### R[1-9]\d*:/.test(s.trim()));
  const rowIds = rows.map(s => /^### (R[1-9]\d*):/.exec(s.trim())![1]!);
  if (!rows.length || new Set(rowIds).size !== rows.length ||
      [...ledger.matchAll(/^State:/gm)].length !== rows.reduce((n, row) => n + [...row.matchAll(/^State:/gm)].length, 0)) return false;
  const owned = new Map<string, string>();
  for (const row of rows) {
    const states = [...row.matchAll(/^State: (.+)$/gm)], ids = [...row.matchAll(/^Question (D[1-9]\d*):$/gm)];
    // An explicit past dispatch annotation can accompany exactly one current
    // state. Duplicate current states and contradictory updates stay invalid.
    if (states.filter(s => s[1] === 'approved').length !== 1 || states.length > 2 ||
        states.some(s => s[1] !== 'approved' && s[1] !== 'approved (was pending at dispatch; see Actual answer)') || ids.length !== 1) return false;
    const id = ids[0]![1]!, a = approvals.find(a => a.id === id);
    const answers = [...row.matchAll(/^Actual answer: \*\*([A-Z]) [—–-] (.+)\*\* \((D[1-9]\d*) answer\)\.$/gm)];
    if (!a || owned.has(id) || answers.length !== 1 || answers[0]![1] !== selectedLetter(a) || answers[0]![3] !== id || label(answers[0]![2]!) !== label(a.selected) ||
        row.split(a.q.question).length !== 2 || row.split('\n').filter(s => /^Accepted scope: \S/.test(s)).length !== 1) return false;
    owned.set(id, rowIds[rows.indexOf(row)]!);
  }
  const readiness = ledger.split('\n').filter(s => /^(?:\*\*)?Approval readiness:/.test(s));
  if (readiness.length !== 1 || !/^\*\*Approval readiness: PASS\.\*\*/.test(readiness[0]!)) return false;
  for (const ref of readiness[0]!.matchAll(/\b(D[1-9]\d*) → ([A-Z])/g)) {
    const a = approvals.find(a => a.id === ref[1]);
    if (!a || selectedLetter(a) !== ref[2]) return false;
  }
  const readyRows = [...readiness[0]!.matchAll(/\b(R[1-9]\d*) \((D[1-9]\d*) → ([A-Z])\)/g)];
  if (readyRows.length !== rows.length || new Set(readyRows.map(r => r[1])).size !== rows.length ||
      readyRows.some(r => owned.get(r[2]!) !== r[1] || selectedLetter(approvals.find(a => a.id === r[2])!) !== r[3])) return false;

  const maintenance = /Routing rules \((D[1-9]\d*)\) and TODOS\.md \((D[1-9]\d*)\) still need writing once plan mode exits/i.exec(context);
  if (!maintenance) return false;
  const routing = approvals.find(a => a.id === maintenance[1]), todo = approvals.find(a => a.id === maintenance[2]);
  if (!routing || !todo || routing.q.header !== 'Routing' || label(routing.selected) !== 'Add routing rules to CLAUDE.md' ||
      todo.q.header !== 'TODO' || label(todo.selected) !== 'Add to TODOS.md' ||
      !new RegExp(`^- \\*\\*${routing.id}\\*\\* routing rules in CLAUDE\\.md → ${selectedLetter(routing)} \\(add\\)\\.`, 'm').test(ledger)) return false;
  const todos = section(/^## TODOS\.md \(not persisted in plan mode; write after exit\)$/);
  const todoRows = ledger.split(/\n(?=### )/).filter(s => new RegExp(`^### ${todo.id}: TODO [—–-]`).test(s.trim()));
  const subject = /^D[1-9]\d*\s*[—–:-]\s*Capture "([^"\n]+)" as a TODO\?/.exec(todo.q.question)?.[1];
  if (!todos || !subject || todoRows.length !== 1 || !new RegExp(`^Actual answer: \\*\\*${selectedLetter(todo)} [—–-] Add to TODOS\\.md\\.\\*\\*`, 'm').test(todoRows[0]!) ||
      !new RegExp(`^- \\*\\*${escape(subject)}\\*\\* \\(${todo.id} → ${selectedLetter(todo)}\\)$`, 'mi').test(todos)) return false;
  // Setup/scope answers that lack an R row still have a unique saved selector.
  for (const a of approvals.filter(a => !owned.has(a.id!) && a !== todo)) {
    const saved = [...ledger.matchAll(new RegExp(`^- \\*\\*${a.id}\\*\\* [^\\n]*?→ (?:\\*\\*)?([A-Z])(?=[ :(.])`, 'gm'))];
    if (saved.length !== 1 || saved[0]![1] !== selectedLetter(a)) return false;
  }

  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]*?\*\* [—–-] (.+?) [—–-] (.+)$/gm)];
  const ids = entries.map(e => e[1]!);
  if (!entries.length || new Set(ids).size !== ids.length) return false;
  for (const ref of context.matchAll(/\bT([1-9]\d*)(?:\s*(?:[–-]|through|to)\s*T([1-9]\d*))?\b/g)) {
    const first = +ref[1]!, last = +(ref[2] ?? ref[1])!;
    if (last < first || last - first >= ids.length) return false;
    for (let n = first; n <= last; n++) if (!ids.includes(`T${n}`)) return false;
  }
  const orders = [...context.matchAll(/\b(?:order the plan specifies|published task order) \(([^)]+)\)/gi)];
  if (orders.length !== 1) return false;
  const groups: string[][] = [];
  for (const raw of orders[0]![1]!.split(/,?\s*then\s+|\s*→\s*|\s*->\s*/i)) {
    const group = raw.trim().replace(/,?\s+(?:(?:in )?parallel|last)$/i, '');
    if (!/^T[1-9]\d*(?:\s*[+/]\s*T[1-9]\d*)*$/.test(group)) return false;
    groups.push(group.split(/\s*[+/]\s*/));
  }
  const ordered = groups.flat(), included = new Set(ordered);
  if (!ordered.length || included.size !== ordered.length || ids.slice(0, ordered.length).some(id => !included.has(id))) return false;
  const bodyFor = (i: number) => tasks.slice(entries[i]!.index!, entries[i + 1]?.index ?? tasks.length);
  // Auxiliary catalog entries remain obligations: a prerequisite explicitly tied
  // to a recapped task, or work in each implementation commit, is not dropped.
  if (entries.slice(ordered.length).some((e, j) => {
    const body = bodyFor(ordered.length + j), before = /^  - Verify: .+ before (T[1-9]\d*) merges$/m.exec(body);
    return !(before && included.has(before[1]!)) && !/^  - Verify: .+ in the same commit$/m.test(body);
  })) return false;
  const steps = [...graph.matchAll(/^\| (S[1-9]\d*) ([^|\n]+) \| ([^|\n]+) \| ([^|\n]+) \|$/gm)];
  const stepIds = steps.map(s => s[1]!);
  if (!steps.length || new Set(stepIds).size !== steps.length || !/^\| Step \| Modules touched \| Depends on \|$/m.test(graph)) return false;
  const module = (s: string) => compact(s.replace(/`/g, '').replace(/\s*\([^)]*\)/g, '')).replace(/\/$/, '');
  const stepModules = steps.map(s => s[3]!.split(',').map(module));
  const deps = steps.map(s => /^[—–-]$/.test(s[4]!) ? [] : s[4]!.split(/,\s*/));
  if (deps.some((d, i) => new Set(d).size !== d.length || d.some(id => !stepIds.includes(id) || stepIds.indexOf(id) >= i))) return false;
  // Task/module and step/module fields bind the two independently numbered
  // catalogs. Require a unique contiguous partition; shared paths alone cannot
  // choose between ambiguous steps. No semantic caption guessing is involved.
  const mappings: number[][] = [];
  const assign = (at: number, step: number, mapping: number[]) => {
    if (mappings.length > 1) return;
    if (at === ordered.length) { if (step === steps.length - 1) mappings.push(mapping); return; }
    for (const next of at === 0 ? [0] : [step, step + 1]) {
      if (next >= steps.length || !entries[at]![2]!.split(/\s+\+\s+/).map(module).every(m => stepModules[next]!.includes(m))) continue;
      assign(at + 1, next, [...mapping, next]);
    }
  };
  assign(0, 0, []);
  if (mappings.length !== 1) return false;
  const mapped = new Map(ids.slice(0, ordered.length).map((id, i) => [id, mappings[0]![i]!]));
  const positions = steps.map(() => [] as number[]);
  for (let i = 0; i < groups.length; i++) {
    const members = groups[i]!.map(id => mapped.get(id)!);
    if (new Set(members).size !== members.length) return false;
    for (const s of members) positions[s]!.push(i);
  }
  if (deps.some((d, i) => d.some(id => Math.max(...positions[stepIds.indexOf(id)]!) >= Math.min(...positions[i]!)))) return false;
  for (let i = 0; i < ordered.length; i++) {
    const id = ids[i]!, pos = groups.findIndex(g => g.includes(id));
    for (const m of bodyFor(i).matchAll(/\bafter (T[1-9]\d*) (?:is )?green\b/gi)) if (!included.has(m[1]!) || groups.findIndex(g => g.includes(m[1]!)) >= pos) return false;
  }
  let actions = currentText(context).replace(orders[0]![0], '').replace(maintenance[0], '')
    .replace(/\b(?:this question|this choice) (?:approves?|authorizes?) no (?:new )?implementation changes?\b/gi, '');
  const action = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:adds?|adding|append(?:s|ing)?|remov(?:e|es|ing)|delet(?:e|es|ing)|cut(?:s|ting)?|drop(?:s|ping)?|replac(?:e|es|ing)|rewrit(?:e|es|ing)|chang(?:e|es|ing)|alter(?:s|ing)?|modif(?:y|ies|ying)|enabl(?:e|es|ing)|disabl(?:e|es|ing)|implement(?:s|ing)?|install(?:s|ing)?|introduc(?:e|es|ing)|build(?:s|ing)?|writ(?:e|es|ing)|record(?:s|ing)?|captur(?:e|es|ing)|creat(?:e|es|ing)|switch(?:es|ing)?|migrat(?:e|es|ing)|externaliz(?:e|es|ing)|refactor(?:s|ing)?|expand(?:s|ing)?|reduc(?:e|es|ing)|deploy(?:s|ing)?|approv(?:e|es|ing))\b/i;
  return !action.test(actions) && !/\brun\s+(?!\/ship\b)|\b(?:new|additional|extra) (?:work|implementation|scope|task|requirement|dependency|feature|datastore|database|cache|test|prerequisite)\b|\b(?:must|shall|should|needs? to|required to|depends on)\s+\S|\b(?:only|skip|drop|omit) (?:the )?tasks?\b/i.test(actions);
}
