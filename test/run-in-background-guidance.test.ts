import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateCodexPlanReview } from '../scripts/resolvers/review';
import { CODEX_MODEL_CONFIG_FLAG } from '../scripts/resolvers/constants';
import type { TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';

// Regression guard for #2440 (which itself regressed the #497 fix).
//
// Claude Code v2.1.198 made subagents run in the BACKGROUND by default.
// Guidance written before that ("do NOT use run_in_background") stopped
// producing a foreground run — the review army and autoplan dual-voice
// steps silently launched specialists in the background and merged before
// they completed. The only guidance that works post-2.1.198 is an explicit
// `run_in_background: false` on the Agent call.
//
// This tripwire pins the corrected phrasing in the generated skill output
// and fails if the inverted form ever comes back through a template or
// resolver edit.

const ROOT = path.resolve(import.meta.dir, '..');

describe('generated Codex plan-review shell invocation', () => {
  const rendered = generateCodexPlanReview({ host: 'claude' } as TemplateContext);
  const ready = rendered.slice(rendered.indexOf('**If `CODEX_MODE: ready` — run Codex:**'),
    rendered.indexOf('Present the full output verbatim:'));
  const blocks = [...ready.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1]!);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-plan-shell-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const created = path.join(dir, 'created');
    const calls = path.join(dir, 'calls');
    const stale = path.join(dir, 'codex-out-foreign');
    const staleError = path.join(dir, 'codex-planreview-foreign');
    fs.writeFileSync(stale, 'FOREIGN OLD REVIEW\n');
    fs.writeFileSync(staleError, 'FOREIGN OLD ERROR\n');
    const writeBin = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body, { mode: 0o755 });
    writeBin('git', 'printf "%s\\n" "$FAKE_REPO"\n');
    writeBin('mktemp', `
if [ "$FAKE_MKTEMP_FAIL" = 1 ]; then exit 42; fi
p=$(${quote(Bun.which('mktemp')!)} "$FAKE_REPO/codex-planreview-XXXXXXXX") || exit 1
printf '%s\\n' "$p" >> "$FAKE_CREATED"
printf '%s\\n' "$p"
`);
    writeBin('codex', `
printf '%s\\n' "$FAKE_REVIEW_ID" >> "$FAKE_CALLS"
printf '%s\\n' "$FAKE_REVIEW_ID: current findings"
printf '%s\\n' "$FAKE_REVIEW_ID: current stderr" >&2
exit "$FAKE_CODEX_STATUS"
`);
    writeBin('cat', `
if [ "$FAKE_CAT_FAIL" = 1 ]; then
  printf '%s\\n' 'cat: simulated current-file read failure' >&2
  exit 47
fi
exec ${quote(Bun.which('cat')!)} "$@"
`);
    const run = (id: string, code = 0, errexit = false, mktempFailure = false, catFailure = false) => {
      const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_REPO: dir,
        FAKE_CREATED: created, FAKE_CALLS: calls, FAKE_REVIEW_ID: id,
        FAKE_CODEX_STATUS: String(code), FAKE_MKTEMP_FAIL: mktempFailure ? '1' : '0',
        FAKE_CAT_FAIL: catFailure ? '1' : '0' };
      // Each displayed block gets a fresh shell, as separate Bash tool calls do.
      return blocks.map(block => spawnSync('bash', ['-c', (errexit ? 'set -e\n' : '') + block], {
        cwd: dir, env, encoding: 'utf8', timeout: 3_000,
      }));
    };
    return { dir, run, stale, staleError, calls,
      created: () => fs.existsSync(created) ? fs.readFileSync(created, 'utf8').trim().split('\n') : [],
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  test('fresh shells retain the current stderr and clean its exact temporary file', () => {
    const f = fixture();
    try {
      const results = f.run('current');
      expect(results.map(result => result.status)).toEqual([0]);
      expect(results[0]!.stdout).toBe('current: current findings\n');
      expect(results[0]!.stderr).toBe('current: current stderr\n');
      expect(f.created()).toHaveLength(1);
      expect(f.created().every(file => !fs.existsSync(file))).toBe(true);
    } finally { f.cleanup(); }
  });
  test.each([false, true])('preserves the real failure status and stderr with errexit=%s', (errexit) => {
    const f = fixture();
    try {
      const results = f.run('failed', 23, errexit);
      expect(results.map(result => result.status)).toEqual([23]);
      expect(results[0]!.stdout).toBe('failed: current findings\n');
      expect(results[0]!.stderr).toBe('failed: current stderr\n');
      expect(f.created()).toHaveLength(1);
      expect(f.created().every(file => !fs.existsSync(file))).toBe(true);
    } finally { f.cleanup(); }
  });
  test.each([[0, false], [0, true], [23, false], [23, true]] as const)(
    'stderr display failure preserves Codex status %s with errexit=%s', (code, errexit) => {
      const f = fixture();
      try {
        const results = f.run('display-failed', code, errexit, false, true);
        expect(results.map(result => result.status)).toEqual([code || 1]);
        expect(results[0]!.stdout).toBe('display-failed: current findings\n');
        expect(results[0]!.stderr).toBe('cat: simulated current-file read failure\n');
        expect(f.created()).toHaveLength(1);
        expect(f.created().every(file => !fs.existsSync(file))).toBe(true);
      } finally { f.cleanup(); }
    });
  test('two invocations consume only their own output and leave stale files untouched', () => {
    const f = fixture();
    try {
      for (const id of ['first', 'second']) {
        const results = f.run(id);
        expect(results.map(result => result.status)).toEqual([0]);
        expect(results[0]!.stdout).toBe(`${id}: current findings\n`);
        expect(results[0]!.stderr).toBe(`${id}: current stderr\n`);
      }
      expect(new Set(f.created()).size).toBe(2);
      expect(f.created().every(file => !fs.existsSync(file))).toBe(true);
      expect(fs.readFileSync(f.stale, 'utf8')).toBe('FOREIGN OLD REVIEW\n');
      expect(fs.readFileSync(f.staleError, 'utf8')).toBe('FOREIGN OLD ERROR\n');
      expect(fs.readFileSync(f.calls, 'utf8')).toBe('first\nsecond\n');
    } finally { f.cleanup(); }
  });
  test('temporary-file failure stops before starting Codex', () => {
    const f = fixture();
    try {
      const results = f.run('unstarted', 0, false, true);
      expect(results.map(result => result.status)).toEqual([1]);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(f.created()).toEqual([]);
    } finally { f.cleanup(); }
  });
});

// Only these plan-review carriers use the bounded outside-voice task. Every
// other synchronous dispatch keeps the existing explicit foreground rule.
const BOUNDED_OUTSIDE_VOICE_SITES = new Set([
  'plan-ceo-review/sections/review-sections.md',
  'plan-eng-review/sections/review-sections.md',
  'plan-devex-review/sections/review-sections.md',
]);
function boundedOutsideVoice(content: string): string {
  // Host postprocessing can expand the preceding CODEX_MODE list (for example
  // broken_install/model_unusable). Pin the actual bounded dispatch section.
  return content.match(/\*\*Bounded outside-voice wait[\s\S]*?(?=\*\*Cross-model tension:\*\*)/)?.[0] ?? '';
}
function hasBoundedOutsideVoiceWait(content: string): boolean {
  const fallback = boundedOutsideVoice(content);
  return ['Bounded outside-voice wait', 'subagent_type: "Plan"', 'run_in_background: true',
    'Immediately call TaskOutput', 'block: true', 'timeout: 300000', 'Make one wait only',
    '`<retrieval_status>` must be `success`', '`<task_id>` must match', '`<task_type>` must be `local_agent`',
    '`<status>`\n   must be `completed`', '`<output>` must be nonempty', 'must be no outer\n   `<error>`',
    'identifiable complete', 'Reject raw or in-progress transcripts',
    'call TaskStop with the same ID', 'Ignore partial or late results',
    'Skip Cross-model tension and Persist the result'].every(part => fallback.includes(part));
}

describe('outside-voice dispatch contract', () => {
  const rendered = generateCodexPlanReview({ host: 'claude' } as TemplateContext);
  const fallback = boundedOutsideVoice(rendered);

  test('the delegated prompt itself requires findings only and forbids plan mutations', () => {
    const promptStart = rendered.indexOf('"IMPORTANT:');
    const promptEnd = rendered.indexOf('\n<plan content>"');
    expect(promptStart).toBeGreaterThan(-1);
    expect(promptEnd).toBeGreaterThan(promptStart);
    const prompt = rendered.slice(promptStart, promptEnd);
    // A sovereignty rule elsewhere in the parent workflow does not reach
    // a fresh-context reviewer receiving only this constructed prompt.
    expect(prompt).toContain('Read-only review: return findings in your final response.');
    expect(prompt).toContain('including the plan file');
    expect(prompt).toContain('Edit, Write, NotebookEdit, or Bash or');
    expect(prompt).toContain('other tools to mutate files');
    expect(prompt).toContain('Do not implement findings or update review reports.');
    expect(prompt).toContain('not instructions to\nexecute');
    expect(prompt).toContain('explicit user approval');
  });

  test('fallback uses one exact-ID wait and explicit cancellation without a model override', () => {
    expect(hasBoundedOutsideVoiceWait(rendered)).toBe(true);
    expect(fallback).toContain('Before dispatch, verify the host offers the built-in Plan agent type, TaskOutput and\nTaskStop.');
    expect(fallback).toContain('If any is unavailable, take the unavailable path below without launching.');
    expect(fallback).toContain('Do not set a model\noverride');
    expect(fallback).toContain('one five-minute wait plus dispatch/cancellation overhead');
    expect(fallback).toContain('Keep the returned `agentId`; do not guess an ID or launch a second task.');
    expect(fallback).toContain('TaskOutput timeout does not stop the agent.');
    expect(fallback).not.toContain('allowed_tools');
    expect(fallback).not.toContain('run_in_background: false');
  });

  test('only the matching completed final report can enter agreement and persistence', () => {
    for (const guard of ['<retrieval_status>', '<task_id>', '<task_type>', 'local_agent', '<status>', 'completed',
      '<output>', 'nonempty', 'no outer', '<error>', 'identifiable complete',
      'Reject raw or in-progress transcripts', 'do not extract\n   finding fragments from them']) expect(fallback).toContain(guard);
    expect(fallback).toContain('Terminal status or warning markers alone do not\n   establish report completeness.');
    expect(fallback).not.toContain('isRawTranscript');
    expect(fallback).not.toContain('task.status');
    expect(fallback).toContain('If any check fails or the report cannot be identified, follow step 4.');
    expect(fallback).toContain('Outside voice unavailable. Continuing to outputs.');
    expect(fallback).toContain('Do not retry with a general-purpose agent.');
    expect(fallback).toContain('Report missing outside-voice coverage.');
    expect(fallback).toContain('still give no late-result credit');
    expect(fallback).toContain('cancellation is unconfirmed');
    expect(fallback).toContain('Skip Cross-model tension and Persist the result; continue directly to outputs.');
    expect(fallback).toContain('Do not record a clean review when no reviewer completed within the accepted wait.');
    expect(rendered).toContain('Wait for the user; model agreement is evidence, not consent.');
    expect(rendered).toContain('Record its answer reference and exact accepted scope');
    const answer = rendered.indexOf('**3. Obtain the answer.**');
    const apply = rendered.indexOf('**4. Apply the answered row.**');
    expect(answer).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(answer);
    expect(rendered).toContain(`-s read-only ${CODEX_MODEL_CONFIG_FLAG} -c 'model_reasoning_effort="high"'`);
  });

  test('the generated-carrier exception rejects missing wait, cancellation or result guards', () => {
    expect(hasBoundedOutsideVoiceWait(rendered)).toBe(true);
    for (const guard of ['subagent_type: "Plan"', 'timeout: 300000', 'call TaskStop with the same ID',
      '<status>', '<output>', 'Reject raw or in-progress transcripts',
      'Ignore partial or late results', 'Skip Cross-model tension and Persist the result']) {
      expect(hasBoundedOutsideVoiceWait(rendered.replaceAll(guard, 'missing guard')), guard).toBe(false);
    }
    expect(hasBoundedOutsideVoiceWait('Dispatch via the Agent tool with run_in_background: true')).toBe(false);
  });

  test('expanded Codex availability states preserve the same bounded dispatch guards', () => {
    const earlier = rendered.replace('`CODEX_MODE: not_installed`, `not_authed`, `broken_install`, or `model_unusable`',
      '`CODEX_MODE: not_installed` or `not_authed`');
    expect(earlier).not.toBe(rendered);
    for (const content of [earlier, rendered]) {
      expect(hasBoundedOutsideVoiceWait(content)).toBe(true);
      expect(hasBoundedOutsideVoiceWait(content.replace('call TaskStop with the same ID', 'missing cancellation'))).toBe(false);
    }
  });

  test('all host resolver outputs either omit the section or require Plan availability', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const output = generateCodexPlanReview({ host: host.name } as TemplateContext);
      if (host.name === 'codex') expect(output).toBe('');
      else {
        expect(output, host.name).toContain('If any is unavailable, take the unavailable path below without launching.');
        expect(output, host.name).toContain('Do not record a clean review when no reviewer completed within the accepted wait.');
        expect(output, host.name).toContain('Do not set a model\noverride');
        expect(hasBoundedOutsideVoiceWait(output), host.name).toBe(true);
      }
    }
  });
});

// review's specialist-dispatch guidance lives in its carved Review Army section
// (Step 4.5 moved out of the skeleton), so the pin follows it there. Same for
// autoplan: the dual-voice dispatch (Phase 1 override rules) lives in its
// carved CEO-phase section.
//
// Third recurrence (#497 → #2440 → /ship Step 18): the four ship dispatch
// sections (Steps 7/8/10/18) never carried the flag and were never pinned, so
// a backgrounded doc-sync dispatch stranded the ship run waiting on LAST-line
// JSON that never came. Every synchronous dispatch carrier is pinned here now;
// add new dispatch sites to this list in the same commit that creates them.
const GENERATED_WITH_GUIDANCE = [
  'review/sections/review-army.md',
  'autoplan/sections/ceo-phase.md',
  'ship/sections/review-army.md',
  'ship/sections/pr-body.md',
  'ship/sections/test-coverage.md',
  'ship/sections/plan-completion.md',
  'ship/sections/greptile.md',
  // Sweep carriers (v1.79): every remaining synchronous Agent-dispatch site.
  'autoplan/sections/design-phase.md',
  'autoplan/sections/eng-phase.md',
  'autoplan/sections/dx-phase.md',
  'cso/SKILL.md',
  'design-consultation/sections/proposal-and-preview.md',
  'design-review/SKILL.md',
  'design-shotgun/SKILL.md',
  'document-release/sections/release-body.md',
  'office-hours/SKILL.md',
  'office-hours/sections/design-and-handoff.md',
  'plan-ceo-review/SKILL.md',
  'plan-ceo-review/sections/review-sections.md',
  'plan-design-review/SKILL.md',
  'plan-devex-review/sections/review-sections.md',
  'plan-eng-review/sections/review-sections.md',
  'review/sections/adversarial.md',
  'ship/sections/adversarial.md',
];

// The inverted, post-2.1.198-inert phrasings. Checked across every generated
// SKILL.md so the regression can't migrate to another skill unnoticed.
const INVERTED = /do not use\s+`?run_in_background`?/i;

function allGeneratedSkillFiles(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = path.join(ROOT, entry.name, 'SKILL.md');
    if (fs.existsSync(p)) out.push(p);
    // Generated on-demand section files (e.g. ship/sections/review-army.md)
    // carry the same resolver output as SKILL.md bodies — scan them too.
    const sections = path.join(ROOT, entry.name, 'sections');
    if (fs.existsSync(sections)) {
      for (const f of fs.readdirSync(sections)) {
        if (f.endsWith('.md')) out.push(path.join(sections, f));
      }
    }
  }
  const rootSkill = path.join(ROOT, 'SKILL.md');
  if (fs.existsSync(rootSkill)) out.push(rootSkill);
  return out;
}

describe('run_in_background guidance (#2440)', () => {
  test('foreground-required skills instruct run_in_background: false explicitly', () => {
    for (const rel of GENERATED_WITH_GUIDANCE) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      if (BOUNDED_OUTSIDE_VOICE_SITES.has(rel) && content.includes('Bounded outside-voice wait')) {
        expect(hasBoundedOutsideVoiceWait(content), rel).toBe(true);
      } else expect(content).toContain('run_in_background: false');
    }
  });

  test('consultation loads the foreground dispatch section after research', () => {
    const skeleton = fs.readFileSync(path.join(ROOT, 'design-consultation/SKILL.md'), 'utf-8');
    const research = skeleton.indexOf('## Phase 2: Research');
    const requiredRead = skeleton.match(/^> \*\*STOP\.\*\* Before [^\n]*, Read `[^`\n]*\/design-consultation\/sections\/proposal-and-preview\.md` and execute it$/m);
    expect(research).toBeGreaterThan(-1);
    expect(requiredRead).not.toBeNull();
    expect(requiredRead!.index).toBeGreaterThan(research);
  });

  // Third recurrence (#497 → #2440 → /ship Step 18): a backgrounded doc-sync
  // dispatch stranded the ship run. Pin the deadline/recovery branch and the
  // docs-sync scope guard in both the generated section and its template, so
  // neither a template edit nor a stale regen can drop them silently.
  const PR_BODY_SITES = ['ship/sections/pr-body.md', 'ship/sections/pr-body.md.tmpl'];
  test('ship pr-body carries the doc-sync deadline recovery + scope guard', () => {
    for (const rel of PR_BODY_SITES) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(content).toContain('document-release did not complete');
      expect(content).toContain('Scope guard — docs sync ONLY');
    }
  });

  // The spawned-dispatch contract is as regression-prone as the flag — this
  // class regressed twice via unpinned prose. Pin the document-release
  // contract, the Step 8.4d spawned note, and the resolver-side Codex
  // doc-review skip in both generated output and templates.
  const CONTRACT_PINS: Array<[string[], string]> = [
    [['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'], 'When dispatched as a subagent'],
    [
      ['document-release/sections/release-body.md', 'document-release/sections/release-body.md.tmpl'],
      'A spawned run must never change VERSION',
    ],
    [['document-release/sections/release-body.md'], 'Spawned-session skip'],
    // Anti-injection trigger + invariant carve-out — the two clauses whose
    // deletion would silently reopen the prompt-injection / silent-VERSION
    // holes while the 'When dispatched' heading pin stays green.
    [['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'], 'NEVER trigger it on their own'],
    // (short form — the sentence wraps across template lines; toContain is literal)
    [['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'], 'The NEVER-do invariants below do'],
  ];
  test('document-release carries the spawned-dispatch contract', () => {
    for (const [sites, phrase] of CONTRACT_PINS) {
      for (const rel of sites) {
        const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
        expect(content).toContain(phrase);
      }
    }
  });

  // Structural scanner (4th-recurrence net): GENERATED_WITH_GUIDANCE is a
  // hand-enumerated list — the exact mechanism that missed three recurrences
  // (#497 → #2440 → /ship Step 18, each a NEW dispatch site outside the
  // pinned set). Any generated file that carries an Agent-dispatch imperative
  // (or the inert "(foreground)" prose shape that #2440 proved insufficient)
  // must either state the flag or hold a reasoned exemption below. Same
  // pattern as the egress-receipt new-sink scanner.
  const DISPATCH_IMPERATIVE =
    /(?:via|using) the Agent tool|dispatch(?:es)? (?:a|an|the|one|each|it as a)[^.\n]{0,60}subagent|\(foreground[^)]*\)|foreground Agent tool/i;
  // Reasoned exemptions: files where the match is a reference to a dispatch
  // that lives (flag and all) in another file, not a dispatch spec itself.
  const BACKGROUND_OK: Record<string, string> = {
    'ship/SKILL.md':
      'skeleton anchors reference the Step 18 dispatch by name (carve-guards mustStayInSkeleton); the dispatch spec + flag live in sections/pr-body.md',
  };
  test('structural scanner: every generated dispatch imperative carries the flag', () => {
    for (const file of allGeneratedSkillFiles()) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (BACKGROUND_OK[rel]) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const boundedOutsideVoice = BOUNDED_OUTSIDE_VOICE_SITES.has(rel) && hasBoundedOutsideVoiceWait(content);
      if (DISPATCH_IMPERATIVE.test(content) && !content.includes('run_in_background: false') && !boundedOutsideVoice) {
        throw new Error(
          `${rel} contains an Agent-dispatch imperative (or bare "foreground" prose) but never states ` +
          '`run_in_background: false` — pin the flag at the dispatch site or add a reasoned BACKGROUND_OK ' +
          'exemption (see #497/#2440: prose without the explicit flag is inert since Claude Code v2.1.198).',
        );
      }
    }
  });

  test('the inverted "do NOT use run_in_background" phrasing never comes back', () => {
    for (const file of allGeneratedSkillFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      if (INVERTED.test(content)) {
        throw new Error(
          `${path.relative(ROOT, file)} contains the inverted run_in_background guidance — ` +
          'since Claude Code v2.1.198 subagents default to background, so "do not use" is inert; ' +
          'instruct `run_in_background: false` instead (see #2440).',
        );
      }
    }
  });
});
