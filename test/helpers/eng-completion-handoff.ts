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
  if (isApprovedInvestigationRecap(fp, reviewedPlan, priorCalls) || isPublishedReadyNavigation(fp, reviewedPlan) || isApprovedMaintenanceRecap(fp, reviewedPlan, priorCalls) || isPublishedPrerequisiteHandoff(fp, reviewedPlan)) return true;
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

/** Navigation may repeat already-approved post-review bookkeeping, but cannot
 * authorize it afresh or hide new implementation work behind a completion label. */
function isApprovedMaintenanceRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
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
  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  if (!prior.length || new Set(identities).size !== prior.length || prior.some(c => c.sessionId !== call.sessionId ||
      c.toolUseId === call.toolUseId || !c.toolUseId || c.answered !== true || c.failed !== false ||
      !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
      !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length ||
      !c.questions.length || c.questions.length > 4 || Object.keys(c.answers ?? {}).length !== c.questions.length ||
      new Set(c.questions.map(q => q.question)).size !== c.questions.length ||
      c.questions.some(q => q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
        new Set(q.options.map(o => o.label)).size !== q.options.length ||
        !q.options.some(o => o.label === c.answers?.[q.question])))) return false;
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
    if (/[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(preceding)) return undefined;
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
  const completedChoice = /\b(?:all decisions (?:are )?(?:answered|settled)|every decision (?:is )?(?:answered|settled))\b/i.test(body) &&
    /\b(?:the only question left is whether to (?:start building|implement) or (?:first )?get (?:a )?(?:strategy-level second look|strategy review)|only the next (?:step|workflow) remains: implementation or an optional strategy review)\b/i.test(body);
  const namedPlans = [...q.question.matchAll(/\breviewed\s+[\w./-]+\.md\s+["“]([^"”\n]+)["”]/gi)];
  if (!/\b(?:what(?:['’]s| is)? (?:the )?next|next steps?|where (?:do|should) we go)\b/i.test(body) ||
      !new RegExp(String.raw`\b${eng}\s+(?:(?:is|are|has been|have been)\s+)?(?:now\s+)?${complete}\b`, 'i').test(body) ||
      !(explicitNavigation || completedChoice && namedPlans.length === 1)) return false;
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
  if (!explicitNavigation) {
    const titles = published.filter(line => /^# /.test(line));
    if (titles.length !== 1 || compact(titles[0]!.replace(/^# (?:Plan: )?/i, '').replace(/\s+\(reviewed\)$/i, '')) !== compact(namedPlans[0]![1]!)) return false;
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
