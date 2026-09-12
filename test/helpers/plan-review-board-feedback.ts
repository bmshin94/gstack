import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { NativeQuestion } from './plan-skill-questions';
import { pickPlanReviewQuestion } from './plan-review-cases';

// The native picker is synchronous. Keep identity checks and the real board
// submission together in a bounded child; the counting driver still owns the
// subsequent terminal input and requires its native acknowledgment.
const SUBMIT = `
import { readStateFile, verifyIdentity, CMDLINE_MARKER } from ${JSON.stringify(path.resolve(import.meta.dir, '../../design/src/daemon-state.ts'))};
import fs from 'node:fs';
const input = JSON.parse(await Bun.stdin.text());
const state = readStateFile(input.stateFile);
if (!fs.lstatSync(input.stateFile).isFile() || !state
  || !Number.isSafeInteger(state.pid) || state.pid <= 0
  || !Number.isSafeInteger(state.port) || state.port <= 0 || state.port > 65535
  || new URL(input.url).port !== String(state.port)
  || !verifyIdentity(state.pid, CMDLINE_MARKER)) throw new Error('No matching owned design daemon');
const remaining = input.deadlineAt - Date.now();
if (remaining <= 0) throw new Error('Design feedback deadline exhausted');
if (input.alreadySubmitted) {
  const progress = await fetch(input.url + 'api/progress', { redirect: 'error', signal: AbortSignal.timeout(remaining) });
  if (!progress.ok) throw new Error('Design feedback progress HTTP ' + progress.status);
  const state = await progress.json();
  if (state.status === 'done') {
    console.log(JSON.stringify({ received: true, action: 'submitted' }));
    process.exit(0);
  }
  if (state.status !== 'serving') throw new Error('Design board is not ready for feedback');
}
const requestBudget = input.deadlineAt - Date.now();
if (requestBudget <= 0) throw new Error('Design feedback deadline exhausted');
const response = await fetch(input.url + 'api/feedback', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestBudget),
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ preferred: 'A', ratings: {}, comments: {},
    overall: 'Automated review fixture preference: variant A.', regenerated: false }),
});
if (!response.ok) throw new Error('Design feedback HTTP ' + response.status);
const ack = await response.json();
if (ack?.received !== true || ack?.action !== 'submitted') throw new Error('Design feedback submission was not acknowledged');
console.log(JSON.stringify({ received: true, action: 'submitted' }));
`;

/** Simulate the fixture user's board choice before saying it was submitted.
 * Other decisions retain the existing recommended/manual-handoff policy. */
export function createDesignReviewPicker({ cwd, deadlineAt }: { cwd: string; deadlineAt: number }): (question: NativeQuestion) => number {
  const submitted = new Set<string>();
  const stateFile = path.resolve(cwd, '.gstack/design.json');
  return question => {
    const labels = question.options.map(option => option.label.trim()
      .replace(/^(?:[A-E][).:]?|\([A-E]\)|\[[A-E]\])\s+/i, '')
      .replace(/\s*\(recommended\)\s*$/i, '').trim());
    // Bind the one completed action we perform, allowing its subject/aspect
    // and feedback object to vary. Full anchoring excludes negation, future
    // intent, another target, and additional commitments. Unchosen prose does
    // not grant another action; competing submission claims still fail below.
    const submittedAction = /^(?:I(?:['’]ve| have)?\s+)?(?:already\s+)?submitted\s+(?:(?:(?:my\s+)?feedback\s+)?(?:on|to) the (?:comparison )?board|(?:the |my )?(?:comparison )?board feedback)[.!]?$/i;
    const submittedIndex = labels.findIndex(label => submittedAction.test(label));
    const submissionClaims = labels.filter(label => /\bsubmit(?:ted|ting)?\b/i.test(label));
    const boardContext = /\bcomparison board\b/i.test(question.question);
    const claimsAction = submittedIndex >= 0 || boardContext
      && (submissionClaims.length > 0 || labels.some(label => /\bclicked\b/i.test(label)));
    if (!claimsAction) return pickPlanReviewQuestion(question);
    if (!boardContext || question.multiSelect || labels.length !== 3
      || labels.some(label => !label) || new Set(labels.map(label => label.toLowerCase())).size !== 3
      || submittedIndex < 0 || submissionClaims.length !== 1) {
      throw new Error('Design board submission has no unambiguous offered action');
    }
    const urls = [...new Set(question.question.match(/https?:\/\/[^\s<>\[\]()]+/g) ?? [])];
    if (urls.length !== 1 || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/boards\/[A-Za-z0-9_-]+\/$/.test(urls[0]!)) {
      throw new Error('Design board submission requires one exact owned board URL');
    }
    const url = urls[0]!;
    const childDeadline = Math.min(deadlineAt, Date.now() + 2_000);
    if (childDeadline <= Date.now()) throw new Error('Design feedback deadline exhausted');
    const child = spawnSync(process.execPath, ['-e', SUBMIT], {
      input: JSON.stringify({ stateFile, url, deadlineAt: childDeadline, alreadySubmitted: submitted.has(url) }),
      encoding: 'utf8', timeout: Math.max(1, childDeadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
      env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    if (child.error || child.signal || child.status !== 0) {
      throw new Error(`Design feedback failed: ${child.error?.message ?? child.signal ?? `exit ${child.status}`}\n${child.stderr?.slice(-2000) ?? ''}`,
        { cause: child.error });
    }
    const ack = JSON.parse(child.stdout);
    if (ack.received !== true || ack.action !== 'submitted') throw new Error('Design feedback acknowledgment was missing');
    submitted.add(url);
    return submittedIndex + 1;
  };
}
