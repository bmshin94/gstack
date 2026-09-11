import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectCeoModePreference, runCeoModePreferenceObservation } from './helpers/ceo-mode-preference';
import { readOwnedClaudeTranscript, type OwnedClaudeTranscript } from './helpers/owned-claude-transcript';
import { stripAnsi, type ClaudePtySession } from './helpers/claude-pty-runner';
import { PtyCurrentScreen } from './helpers/pty-current-screen';

const automatic = 'Mode is HOLD SCOPE (auto-decided from plan-tune preference).';
const scopedAutomatic = '**Auto-decided:** Review mode → **SELECTIVE EXPANSION** (your preference for this question).';
const savedAutomatic = 'Auto-decided review mode → **SELECTIVE EXPANSION** (saved preference).';
const approach = 'D1 — Which implementation approach? <gstack-qid:plan-ceo-review-approach-select>\nA) Reuse the formatter (recommended)\nB) Add a dependency';
const mode = 'D2 — Which review mode? <gstack-qid:plan-ceo-review-mode>\nA) HOLD SCOPE\nB) SCOPE EXPANSION';
const assistant = (text: string, stop_reason = 'end_turn', id = 'message-1') => ({ type: 'assistant', message: { role: 'assistant', id, stop_reason, content: [{ type: 'text', text }] } });
const transcript = (...rows: any[]): OwnedClaudeTranscript => ({ rows, file: null, completedLines: rows.length, pendingBytes: 0 });

const screenBrief = [
  'Audit complete. Before the mode selection and the 11-section review, the workflow needs one decision from you: which implementation approach the plan commits to.',
  '', '## D1 — Which implementation approach for the CSV export?', '',
  'Reply with **A**, **B**, or **C**. `<gstack-qid:plan-ceo-review-approach>`', '',
  'A) Client-side formatter over the existing settings API (recommended)',
  'B) Server-side CSV endpoint', 'C) Client-side formatter behind a serializer seam',
].join('\n');

const linkedIntro = 'Audit complete. Sources: [RFC 4180 guide](https://example.test/rfc-4180) and [CSV escaping rules](https://example.test/csv?format=plain).';
const linkedScreenIntro = 'Audit complete. Sources: RFC 4180 guide (https://example.test/rfc-4180) and CSV escaping rules (https://example.test/csv?format=plain).';
const linkedBrief = linkedIntro + screenBrief.slice(screenBrief.indexOf('\n'));
const linkedScreen = linkedScreenIntro + screenBrief.slice(screenBrief.indexOf('\n'));

test('prose link rendering preserves the complete introduction, labels, and destinations', () => {
  expect(inspectCeoModePreference(transcript(assistant(linkedBrief)), linkedScreen, linkedScreen, linkedScreen))
    .toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach', answer: 'A' });
  expect(inspectCeoModePreference(transcript(assistant(linkedBrief)), linkedBrief).kind).toBe('unrelated');
  for (const screen of [
    linkedScreen.replace('RFC 4180 guide', 'Different guide'),
    linkedScreen.replace('example.test/rfc-4180', 'other.test/rfc-4180'),
    linkedScreen.replace(' (https://example.test/rfc-4180)', ''),
    linkedScreen.slice(linkedScreen.indexOf('## D1')),
  ]) expect(inspectCeoModePreference(transcript(assistant(linkedBrief)), screen).kind).toBe('working');
});

// Native AUTO_DECIDE attempt 71f332d0: the completed approach brief followed
// a source link labelled "OWASP: Testing for CSV Injection". The CLI rendered
// the plain label and destination; punctuation did not turn it into markup.
test.each(['OWASP: Testing for CSV Injection', 'RFC 4180 (CSV)', 'CSV, quotes & commas'])(
  'plain link labels retain punctuation when corroborating the current brief: %s', label => {
    const native = linkedBrief.replace('RFC 4180 guide', label);
    const screen = linkedScreen.replace('RFC 4180 guide', label);
    const owned = transcript(assistant(native));
    expect(inspectCeoModePreference(owned, screen, screen, screen)).toMatchObject({ kind: 'unrelated', answer: 'A' });
    for (const wrong of [screen.replace(label, 'Different source'), screen.replace('example.test/rfc-4180', 'other.test/rfc-4180')]) {
      expect(inspectCeoModePreference(owned, wrong).kind).toBe('working');
    }
    expect(inspectCeoModePreference(owned, screen, screen, '').kind).toBe('working');
    expect(inspectCeoModePreference({ ...owned, pendingBytes: 1 }, screen).kind).toBe('working');
  },
);

// These literal label characters are erased or rewritten by renderedProse's
// Markdown comparison. Do not let that normalization corroborate a different
// source label; keep such links outside this narrow CLI projection.
test.each([
  ['CSV #1', 'CSV 1'], ['CSV*', 'CSV'], ['CSV`', 'CSV'],
  ['gstack-qid:source', '<gstack-qid:source>'],
])('plain link projection rejects ambiguous literal label normalization: %s', (label, changed) => {
  const native = linkedBrief.replace('RFC 4180 guide', label);
  const wrong = linkedScreen.replace('RFC 4180 guide', changed);
  expect(inspectCeoModePreference(transcript(assistant(native)), wrong, wrong, wrong).kind).toBe('working');
});

test('link rendering cannot turn code, images, escaped links, titles, or nested labels into input', () => {
  for (const source of [
    '`[RFC 4180 guide](https://example.test/rfc-4180)`',
    '![RFC 4180 guide](https://example.test/rfc-4180)',
    '\\[RFC 4180 guide](https://example.test/rfc-4180)',
    '[RFC 4180 guide](https://example.test/rfc-4180 "different title")',
    '[**RFC 4180 guide**](https://example.test/rfc-4180)',
  ]) {
    const text = linkedBrief.replace('[RFC 4180 guide](https://example.test/rfc-4180)', source);
    expect(inspectCeoModePreference(transcript(assistant(text)), linkedScreen).kind).toBe('working');
  }
});

test('rendered links retain current-input, preview, and message ownership guards', () => {
  const owned = transcript(assistant(linkedBrief));
  expect(inspectCeoModePreference(owned, linkedScreen, linkedScreen, 'Working...').kind).toBe('working');
  expect(inspectCeoModePreference({ ...owned, pendingBytes: 1 }, linkedScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(linkedBrief, 'tool_use')), linkedScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(linkedBrief), assistant('Working...', 'tool_use', 'next')), linkedScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(linkedBrief, 'end_turn', 'earlier'), assistant(linkedBrief)), linkedScreen).kind).toBe('working');
  for (const preview of [linkedBrief, linkedScreen]) {
    const tool = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Write', input: { content: preview } }] } };
    expect(inspectCeoModePreference(transcript(tool, assistant(linkedBrief)), linkedScreen).kind).toBe('working');
  }
});


// Native AUTO retry 458bab3a rendered the complete prelude's GFM table as
// a box table. Every cell and the surrounding current brief still own the input.
const plainNativeTable = '| ID | Name |\n|----|------|\n| E1 | Alpha |\n| E2 | Beta |';
const plainScreenTable = [
  '┌────┬───────┐', '│ ID │ Name  │', '├────┼───────┤',
  '│ E1 │ Alpha │', '├────┼───────┤', '│ E2 │ Beta  │', '└────┴───────┘',
].join('\n');
const plainTableBrief = 'Audit complete.\n\n' + plainNativeTable + '\n\nScope stays fixed.\n'
  + screenBrief.slice(screenBrief.indexOf('\n'));
const plainTableScreen = plainTableBrief.replace(plainNativeTable, plainScreenTable);

test('plain table rendering corroborates all cells within the complete current introduction', () => {
  const owned = transcript(assistant(plainTableBrief));
  expect(inspectCeoModePreference(owned, plainTableScreen, plainTableScreen, plainTableScreen))
    .toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach', answer: 'A' });
  expect(inspectCeoModePreference(owned, plainTableBrief).kind).toBe('unrelated');
  const native = plainTableBrief.replace('Audit complete.', linkedIntro);
  const screen = plainTableScreen.replace('Audit complete.', linkedScreenIntro);
  expect(inspectCeoModePreference(transcript(assistant(native)), screen).kind).toBe('unrelated');
});

test.each([
  ['changed cell', plainTableScreen.replace('Alpha', 'Omega')],
  ['changed header', plainTableScreen.replace('Name', 'Type')],
  ['reordered rows', plainTableScreen.replace('Alpha', 'TEMP!').replace('Beta ', 'Alpha').replace('TEMP!', 'Beta ')],
  ['missing row', plainTableScreen.replace('│ E1 │ Alpha │\n├────┼───────┤\n', '')],
  ['extra row', plainTableScreen.replace('└────┴───────┘', '├────┼───────┤\n│ E3 │ Gamma │\n└────┴───────┘')],
  ['changed separator', plainTableScreen.replace('├────┼───────┤', '├────┼──────┤')],
  ['wrapped cell', plainTableScreen.replace('│ E1 │ Alpha │', '│ E1 │ Alp   │\n│    │ ha    │')],
  ['duplicate table', plainTableScreen.replace(plainScreenTable, plainScreenTable + '\n' + plainScreenTable)],
  ['missing prelude', plainTableScreen.slice(plainTableScreen.indexOf('## D1'))],
  ['changed prelude', plainTableScreen.replace('Scope stays fixed.', 'Scope may expand.')],
])('plain table projection refuses incomplete or conflicting current rendering: %s', (_, screen) => {
  expect(inspectCeoModePreference(transcript(assistant(plainTableBrief)), screen).kind).toBe('working');
});

test.each([
  plainNativeTable.replace('----', ':---'),
  plainNativeTable.replace('Alpha', '**Alpha**'),
  plainNativeTable.replace('Alpha', '`Alpha`'),
  plainNativeTable.replace('Alpha', '[Alpha](https://example.test)'),
  plainNativeTable.replace('Alpha', 'Alph&#97;'),
  '```\n' + plainNativeTable + '\n```',
  plainNativeTable.replace('| E2 | Beta |', '| E2 |'),
])('plain table projection declines unobserved markup and incomplete native rows: %s', table => {
  expect(inspectCeoModePreference(transcript(assistant(plainTableBrief.replace(plainNativeTable, table))), plainTableScreen).kind)
    .toBe('working');
});

test('plain table rendering retains current-input, ownership, preview and negative guards', () => {
  const owned = transcript(assistant(plainTableBrief));
  expect(inspectCeoModePreference(owned, plainTableScreen, plainTableScreen, '').kind).toBe('working');
  expect(inspectCeoModePreference({ ...owned, pendingBytes: 1 }, plainTableScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(plainTableBrief, 'tool_use')), plainTableScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(plainTableBrief), assistant('Working...', 'tool_use', 'next')), plainTableScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(plainTableBrief, 'end_turn', 'old'), assistant(plainTableBrief)), plainTableScreen).kind).toBe('working');
  for (const preview of [plainTableBrief, plainTableScreen]) {
    const tool = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Write', input: { content: preview } }] } };
    expect(inspectCeoModePreference(transcript(tool, assistant(plainTableBrief)), plainTableScreen).kind).toBe('working');
  }
  for (const replacement of ['(not recommended)', '(recommended, but not now)']) {
    const native = plainTableBrief.replace('(recommended)', replacement);
    expect(inspectCeoModePreference(transcript(assistant(native)), plainTableScreen.replace('(recommended)', replacement)).kind).toBe('working');
  }
  const deferred = plainTableBrief + '\nDo not answer this question yet.';
  expect(inspectCeoModePreference(transcript(assistant(deferred)), plainTableScreen + '\nDo not answer this question yet.').kind).toBe('working');
  const changed = plainTableScreen.replace('Reply with **A**, **B**, or **C**.', 'Reply with **A**, **B**, or **D**.');
  expect(inspectCeoModePreference(owned, changed).kind).toBe('working');
});

// Closed architectural context precedes the actual owned D1. The code body
// remains part of its introduction; only the renderer's delimiters disappear.
const contextBody = '  CURRENT STATE -> THIS PLAN -> IDEAL\n  Settings UI   -> CSV button -> Portable settings';
const contextLead = 'Audit done. The first decision follows.\n\n```\n' + contextBody + '\n```\n\nThe formatter stays client-side.\n';
const contextBrief = contextLead + screenBrief.slice(screenBrief.indexOf('\n'));
const contextScreen = contextBrief.replaceAll('```', '');
const codeReplyBrief = screenBrief.replace('**A**, **B**, or **C**', '`A`, `B`, or `C`');
const qualifiedBrief = codeReplyBrief.replace('`A`, `B`, or `C`', '`D1: A`, `D1: B`, or `D1: C`');

test.each(['D1', 'D12'])('qualified reply selectors bind to the current %s heading', heading => {
  const native = qualifiedBrief.replaceAll('D1', heading);
  const screen = native.replaceAll('`', '').replaceAll('**', '');
  expect(inspectCeoModePreference(transcript(assistant(native)), screen, screen, screen.replace(/\s/g, '')))
    .toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach', answer: 'A' });
  const bare = native.replaceAll('`', '');
  expect(inspectCeoModePreference(transcript(assistant(bare)), screen)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test.each([
  qualifiedBrief.replace('D1: B', 'D2: B'),
  qualifiedBrief.replaceAll('D1:', 'D2:'),
  qualifiedBrief.replace('`D1: B`', '`B`'),
  qualifiedBrief.replace('`D1: A`, `D1: B`, or `D1: C`', 'D1: A to use D2: B, or D1: C'),
  qualifiedBrief.replace('## D1 —', '> D1 —'),
  qualifiedBrief.replace('## D1 — Which implementation approach for the CSV export?', '`D1 — Which implementation approach for the CSV export?`'),
  qualifiedBrief.replace('## D1 —', '## D2 —'),
  qualifiedBrief + '\n## D1 — Another decision',
  qualifiedBrief.replace('## D1 —', '## D01 —'),
])('qualified replies reject mixed, wrong, quoted or ambiguous headings: %#', native => {
  expect(inspectCeoModePreference(transcript(assistant(native)), native).kind).toBe('working');
});

test('qualified replies retain complete-owner, current-input, introduction and preview guards', () => {
  const owner = assistant(qualifiedBrief);
  const frame = qualifiedBrief.replaceAll('`', '');
  for (const native of [
    { ...transcript(owner), pendingBytes: 1 },
    transcript(assistant(qualifiedBrief, 'tool_use')),
    transcript(owner, assistant('Working...', 'tool_use', 'newer')),
    transcript(owner, { type: 'user', message: { role: 'user', content: 'D1: A' } }),
    transcript(assistant(qualifiedBrief, 'end_turn', 'older'), owner),
    transcript({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Write', input: { content: qualifiedBrief } }] } }, owner),
  ]) expect(inspectCeoModePreference(native, frame).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(owner), frame, frame, 'Working...').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(owner), frame, frame.slice(frame.indexOf('## D1')), frame).kind).toBe('working');
});

const tallLead = 'Audit done. The complete current report follows.\n'
  + Array.from({ length: 130 }, (_, index) => `Context row ${index}: the formatter keeps quoting separate from settings.`).join('\n');
const tallBrief = tallLead + screenBrief.slice(screenBrief.indexOf('\n'));

test('closed context body remains fully corroborated before the owned decision', () => {
  expect(inspectCeoModePreference(transcript(assistant(contextBrief)), contextScreen))
    .toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach', answer: 'A' });
  for (const visible of [contextScreen.replace(contextBody, ''), contextScreen.replace('CSV button', 'New API'),
    contextScreen.replace(contextBody, contextBody.split('\n').reverse().join('\n'))]) {
    expect(inspectCeoModePreference(transcript(assistant(contextBrief)), visible).kind).toBe('working');
  }
});

test('context body punctuation stays literal despite prose formatting normalization', () => {
  const body = '  Quoting: input * rows # retained `literal`';
  const text = contextBrief.replace(contextBody, body);
  const visible = text.replaceAll('```', '');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible).kind).toBe('unrelated');
  for (const changed of [body.replace('*', ''), body.replace('#', ''), body.replaceAll('`', ''), body.replace('Quoting', 'QUOTING')]) {
    expect(inspectCeoModePreference(transcript(assistant(text)), visible.replace(body, changed)).kind).toBe('working');
    // A correct copy elsewhere cannot corroborate a changed body in this lead.
    expect(inspectCeoModePreference(transcript(assistant(text)), visible.replace(body, changed) + '\n' + body).kind).toBe('working');
  }
});

test.each([
  '```\n' + contextBody, // Unclosed before D1.
  '```text\n' + contextBody + '\n```', // Only the observed unlabeled top-level form.
  '  ```\n' + contextBody + '\n  ```',
  '````\n' + contextBody + '\n````',
  '```\n```text\n' + contextBody + '\n```\n```',
  '```\nD7 — Cached example?\nA) Yes\nB) No\n```',
  '```\nReply with A or B.\n```',
  '```\n<gstack-qid:plan-ceo-review-approach>\n```',
  "```\nI'll present the question now.\n```",
  '```\nDo not answer this decision yet.\n```',
])('code or question examples cannot authorize the following request: %s', lead => {
  const text = 'Audit complete.\n' + lead + '\n\n' + screenBrief;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});

test('context requires ordinary prose and retains deferred, preview, and current-input guards', () => {
  const onlyCode = '```\n' + contextBody + '\n```' + screenBrief.slice(screenBrief.indexOf('\n'));
  expect(inspectCeoModePreference(transcript(assistant(onlyCode)), onlyCode).kind).toBe('working');
  const owned = transcript(assistant(contextBrief));
  expect(inspectCeoModePreference(owned, contextScreen, contextScreen, '').kind).toBe('working');
  expect(inspectCeoModePreference({ ...owned, pendingBytes: 1 }, contextScreen).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(contextBrief), assistant('New turn', 'tool_use', 'next')), contextScreen).kind).toBe('working');
  for (const lead of ['Example only; do not answer:', 'I will present this later:', '> Quoted request:']) {
    const text = lead + '\n' + contextBrief;
    expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  }
  const heading = contextScreen.indexOf('## D1');
  const reordered = contextScreen.slice(heading) + contextScreen.slice(0, heading) + '## D1 — Which implementation approach for the CSV export?';
  expect(inspectCeoModePreference(owned, reordered).kind).toBe('working');
  for (const preview of [contextBrief, contextScreen]) {
    const tool = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Write', input: { content: preview } }] } };
    expect(inspectCeoModePreference(transcript(tool, assistant(contextBrief)), contextScreen).kind).toBe('working');
  }
});

test('each offered selector may be one exact inline-code atom', () => {
  expect(inspectCeoModePreference(transcript(assistant(codeReplyBrief)), codeReplyBrief.replaceAll('`', '')))
    .toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach', answer: 'A' });
  for (const atom of ['``A``', '`A', 'A`', '`A or B`', '`AB`', '`A extra`', '`D`', '`B`']) {
    const text = codeReplyBrief.replace('`A`', atom);
    expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  }
  expect(inspectCeoModePreference(transcript(assistant(codeReplyBrief)), codeReplyBrief, codeReplyBrief, '').kind).toBe('working');
});

test.each(['redraw', 'stale-frame', 'native-during-frame', 'output-during-frame', 'preview', 'deferred', 'deadline-during-frame']
  .flatMap(scenario => ['plain', 'links', 'tall'].map(layout => [scenario, layout] as const)))(
  'prose input requires a faithful current screen and stable owned source: %s, layout=%s', async (scenario, layout) => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-screen-'));
    let screen: PtyCurrentScreen;
    let raw = ''; let file = ''; let sessionId = ''; let time = 0; let typed = ''; let changed = false; let closed = false;
    const writes: string[] = []; let enters = 0; let launchOptions: any;
    const lead = scenario === 'deferred' ? 'Do not answer this decision yet.\n\n' : '';
    const text = lead + (layout === 'links' ? linkedBrief : layout === 'tall' ? tallBrief : screenBrief);
    const rendered = lead + (layout === 'links' ? linkedScreen : layout === 'tall' ? tallBrief : screenBrief);
    const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ ...row, sessionId }) + '\n');
    const output = (bytes: string) => { raw += bytes; screen.feed(bytes); };
    const session = {
      hermeticConfigDir: config, mark: () => raw.length, visibleSince: (since = 0) => stripAnsi(raw.slice(since)),
      rawOutput: () => raw, visibleText: () => stripAnsi(raw), exited: () => false,
      close: async () => { closed = true; screen.dispose(); },
      currentScreen: async () => {
        const rawEnd = raw.length; const pending = screen.snapshot();
        if (!changed && scenario === 'native-during-frame') {
          changed = true; append(assistant('Another owner is working.', 'tool_use', 'next'));
        }
        const frame = await pending;
        if (!changed && scenario === 'output-during-frame') {
          changed = true; output('\x1b[2J\x1b[HAnother dialog');
        }
        if (scenario === 'deadline-during-frame') time = 30_000;
        return { text: frame.text, rawEnd: scenario === 'stale-frame' ? 0 : rawEnd };
      },
      send(value: string) {
        if (value.startsWith('/')) {
          if (scenario === 'preview') append({ type: 'assistant', message: { id: 'preview', role: 'assistant',
            stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Write', input: { content: text } }] } });
          append(assistant(text));
          // A real cursor overwrite preserves the displayed introduction while
          // ANSI stripping leaves an extra character. No native text is used
          // as a replacement screen in the observation driver.
          const split = rendered.indexOf('\n');
          output('\x1b[2J\x1b[H' + rendered.slice(0, split - 1) + 'X\x1b[D' + rendered[split - 1]
            + rendered.slice(split).replaceAll('\n', '\r\n'));
          return;
        }
        writes.push(value); typed = value; output('\r\n❯ ' + value);
      },
      sendKey(key: string) {
        expect(key).toBe('Enter'); enters++;
        append({ type: 'user', message: { role: 'user', content: typed } });
        append(assistant(automatic, 'end_turn', 'done')); output('\r\n' + automatic);
      },
    } as unknown as ClaudePtySession;
    try {
      const observation = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000 }, {
        now: () => time, pause: async ms => { time += ms; }, launch: async opts => {
          launchOptions = opts; sessionId = opts.extraArgs![1];
          screen = new PtyCurrentScreen({ cols: 120, rows: opts.rows });
          file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
          fs.mkdirSync(path.dirname(file), { recursive: true }); return session;
        },
      });
      expect(closed).toBe(true);
      expect(observation.outcome).toBe(scenario === 'redraw' ? 'auto_decided' : 'timeout');
      expect(writes).toEqual(scenario === 'redraw' ? ['For plan-ceo-review-approach, I choose option A. Continue the review.'] : []);
      expect(enters).toBe(scenario === 'redraw' ? 1 : 0);
      expect(observation.answered).toEqual(scenario === 'redraw' ? ['message-1'] : []);
      expect(launchOptions).toMatchObject({ captureScreen: true, rows: 240, timeoutMs: 30_000 });
      expect(stripAnsi(raw)).not.toContain(text.split('\n')[0]);
    } finally { screen.dispose(); fs.rmSync(config, { recursive: true, force: true }); }
  });

test('mode-only preference does not reject an implementation-approach question', () => {
  expect(inspectCeoModePreference(transcript(assistant(approach)), approach)).toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-approach-select', answer: 'A' });
  expect(inspectCeoModePreference(transcript(assistant(automatic, 'tool_use'), assistant(approach, 'end_turn', 'other')), automatic + '\n' + approach).kind).toBe('auto_decided');
});
test('real mode questions fail, including one asked before a later annotation', () => {
  expect(inspectCeoModePreference(transcript(assistant(mode)), mode).kind).toBe('asked');
  const native = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__conductor__AskUserQuestion', input: { questions: [{ question: mode }] } }] } };
  expect(inspectCeoModePreference(transcript(native, assistant(automatic)), automatic).kind).toBe('asked');
  const mixed = 'Example: this review could cover CSV escaping.\n\nNow choose the review mode. ' + mode;
  expect(inspectCeoModePreference(transcript(assistant(mixed)), mixed).kind).toBe('asked');
  expect(inspectCeoModePreference(transcript(assistant(mixed), assistant(automatic, 'end_turn', 'later')), mixed + '\n' + automatic).kind).toBe('asked');
  const interrupted = 'Context.\n```text\nquoted code\n```\n' + mode;
  expect(inspectCeoModePreference(transcript(assistant(interrupted), assistant(automatic, 'end_turn', 'later')), interrupted + '\n' + automatic).kind).toBe('asked');
});
test('Write previews, tool results, thinking, incomplete lines, and unrendered text are not decisions', () => {
  const payload = { type: 'assistant', message: { role: 'assistant', id: 'write', content: [
    { type: 'tool_use', name: 'Write', input: { content: mode + '\n' + automatic } },
    { type: 'thinking', thinking: automatic },
  ] } };
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: automatic }] } };
  expect(inspectCeoModePreference(transcript(payload, result), mode + automatic).kind).toBe('working');
  expect(inspectCeoModePreference({ ...transcript(assistant(automatic)), pendingBytes: 4 }, automatic).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(automatic)), 'Working...').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(approach, 'tool_use')), approach).kind).toBe('working');
});
test('an unrelated automatic decision cannot establish mode preference compliance', () => {
  const text = 'Auto-decided implementation approach → reuse code (your preference).\n\nReview mode options: HOLD SCOPE or SCOPE EXPANSION.';
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test.each([
  'I have not auto-decided the mode HOLD SCOPE (your preference).',
  'Auto-decided implementation approach → reuse code (your preference). The review mode HOLD SCOPE will be selected later.',
  'Example annotation: Mode is HOLD SCOPE (auto-decided from plan-tune preference).',
  'I will print: Auto-decided review mode → HOLD SCOPE (your preference).',
  '```text\n' + automatic + '\n```',
  '> ' + automatic,
  'Example only, not an actual decision:\n' + automatic,
  '    ' + automatic,
  '````text\n```\n' + automatic + '\n````',
])('non-decisions cannot produce an automatic-mode pass: %s', text => {
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test('a real standard annotation is accepted at sentence level', () => {
  const text = 'Auto-decided review mode → HOLD SCOPE (your preference). Change with /plan-tune.';
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('auto_decided');
});
test('mode annotation punctuation and explicit question attribution preserve the decision meaning', () => {
  expect(inspectCeoModePreference(transcript(assistant(scopedAutomatic, 'tool_use')), scopedAutomatic).kind).toBe('auto_decided');
});
test('retained saved-preference wording is a rendered mode decision even during a tool turn', () => {
  // Completed owned attempt 999c96c7: the lookup returned AUTO_DECIDE and the
  // assistant used this literal attribution; terminal wrapping split it.
  const native = 'No brain context, no prior learnings, Aside unavailable. ' + savedAutomatic
    + ' No design doc found — proceeding with standard review from `review-input.md` directly (the plan is clear and self-contained; /office-hours not needed here).'
    + '\n\nSetting up learnings (first time in this project):';
  const rendered = 'Auto-decided review mode → SELECTIVE EXPANSION (saved\rpreference).';
  expect(inspectCeoModePreference(transcript(assistant(native, 'tool_use')), rendered))
    .toEqual({ kind: 'auto_decided', evidence: savedAutomatic.replaceAll('**', '') });
});
test.each([
  'Auto-decided review mode → SELECTIVE EXPANSION (feature enhancement, default).',
  'Auto-decided review mode → SELECTIVE EXPANSION (saved default).',
  'Auto-decided review mode → SELECTIVE EXPANSION (not saved preference).',
  'Auto-decided review mode → SELECTIVE EXPANSION (saved preference for another question).',
  'Auto-decided review mode → SELECTIVE EXPANSION (saved preference, probably).',
  'Auto-decided review mode → SELECTIVE EXPANSION (saved preference)?',
  'Auto-decided review mode → SELECTIVE EXPANSION (saved preference) if approved.',
  'Auto-decided implementation approach → SELECTIVE EXPANSION (saved preference).',
  'Auto-decided review mode → HOLD SCOPE or SELECTIVE EXPANSION (saved preference).',
])('saved-preference recognition does not accept defaults, uncertainty, or another decision: %s', text => {
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test.each([automatic, 'Auto-decided review mode → HOLD SCOPE (your preference).', scopedAutomatic, savedAutomatic])('future or quote-wrapped mode annotations are not decisions: %s', annotation => {
  for (const text of [
    'I will print this later:\n' + annotation,
    'I will print this later:\n\n' + annotation,
    'If approved, I will print:\n\n' + annotation,
    'If approved:\n' + annotation,
    'When the user confirms:\n\n' + annotation,
    'Expected annotation:\n\n' + annotation,
    'Example only, not an actual decision:\n\n' + annotation,
    '### Example annotation:\n\n' + annotation,
    'Here’s an example:\n\n' + annotation,
    'I will print `this` later:\n\n' + annotation,
    'Expected output:\nSome explanatory prose.\n\n' + annotation,
    'Expected output:\nSome `code` in the explanation.\n\n' + annotation,
    '"\n' + annotation + '\n"',
    '"\n\n' + annotation + '\n\n"',
    '"\n\n' + annotation,
    '“\n' + annotation + '\n”',
    "'\nThe owners' example.\n\n" + annotation + "\n'",
    '‘\nThe owners’ example.\n\n' + annotation + '\n’',
    '"An example. ' + annotation + '"',
    '“An example. ' + annotation + '”',
    "'An example. " + annotation + "'",
    '‘An example. ' + annotation + '’',
    '`' + annotation + '`',
    '**`' + annotation + '`**',
    '```text\n\n' + annotation + '\n\n```',
    '````text\n```\n\n' + annotation + '\n````',
    '> ' + annotation,
    '> quoted example\n' + annotation,
    '    ' + annotation,
    '\t' + annotation,
  ]) expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test.each([
  'Auto-decided: mode → HOLD SCOPE (your preference).',
  'Auto-decided CEO review mode selection: SCOPE REDUCTION (your preference for this question).',
  'Auto-decided: review mode — SCOPE EXPANSION (your preference)!',
  'Review Mode is SELECTIVE EXPANSION (auto-decided from plan-tune preference).',
])('a bounded mode subject and saved preference establish the decision: %s', annotation => {
  expect(inspectCeoModePreference(transcript(assistant(annotation)), annotation).kind).toBe('auto_decided');
});
test.each([automatic, scopedAutomatic, savedAutomatic].flatMap(annotation => [
    "'The owners' example.\n" + annotation + "\n'",
    "'The owners' example.\n\n" + annotation + "\n'",
    "'The owners'\nexample.\n\n" + annotation + "\n'",
    "'The owners'\nquoted context.\n\n" + annotation + "\n'",
    "'The owners' context.\n\n" + annotation + "\n' (illustration)",
    '‘The owners’ example.\n' + annotation + '\n’',
    '‘The owners’ example.\n\n' + annotation + '\n’',
    '‘The owners’\nexample.\n\n' + annotation + '\n’',
    '‘The owners’\nquoted context.\n\n' + annotation + '\n’',
    '‘The owners’ context.\n\n' + annotation + '\n’ (illustration)',
    '"An escaped quote \\".\n' + annotation + '\n"',
    '"An escaped quote \\".\n\n' + annotation + '\n"',
    '### Example\n\n' + annotation,
    'Example only\n' + annotation,
]))('ambiguous native quote spans and example headings cannot expose decisions: %s', text => {
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});
test.each([
  'Auto-decided: implementation approach → HOLD SCOPE (your preference for this question).',
  'Auto-decided: review mode → HOLD SCOPE (your preference for another question).',
  'Auto-decided: review mode → HOLD SCOPE (your preference for this question, probably).',
  'Auto-decided: review mode → HOLD SCOPE (not your preference).',
  'Auto-decided: review mode → HOLD SCOPE (your default).',
  'Auto-decided: review mode → HOLD SCOPE (your preference) if approved.',
  'Auto-decided: review mode → HOLD SCOPE (your preference for this question) if approved.',
  'Auto-decided: review mode → HOLD SCOPE (your preference)?',
  'Auto-decided: review mode → HOLD SCOPE (your preference for this question)?',
  'Auto-decided: review mode → HOLD SCOPE or SELECTIVE EXPANSION (your preference).',
  'Auto-decided: review mode → HOLD SCOPE / SELECTIVE EXPANSION (your preference for this question).',
  'Auto-decided: review mode → UNKNOWN MODE (your preference for this question).',
  'Not auto-decided: review mode → HOLD SCOPE (your preference for this question).',
  'If approved, Auto-decided: review mode → HOLD SCOPE (your preference for this question).',
  'Mode is HOLD SCOPE or SELECTIVE EXPANSION (auto-decided from plan-tune preference).',
  'Mode is HOLD SCOPE (auto-decided from plan-tune preference) if approved.',
  'Mode is HOLD SCOPE (auto-decided from plan-tune preference)?',
  'Mode is not HOLD SCOPE (auto-decided from plan-tune preference).',
])('an incomplete or qualified mode claim is not a decision: %s', annotation => {
  expect(inspectCeoModePreference(transcript(assistant(annotation)), annotation).kind).toBe('working');
});
test.each([automatic, scopedAutomatic, savedAutomatic])('unrelated context cannot erase an affirmative mode decision: %s', annotation => {
  for (const prefix of [
    'I will test the formatter later.',
    'Do not answer the implementation question yet.',
    'The CSV example includes commas and quoted cells.',
    'Here is an example:\n```text\nplaceholder\n```',
    'Here is an example:\n\n```text\nplaceholder\n```',
    'Expected annotation:\n\n"\nplaceholder\n"',
    'Expected annotation:\n\n“\nplaceholder\n”',
    'Expected annotation:\n\n“\nplaceholder\n” (illustration)',
    'Example:\n\n> placeholder',
    'Example:\n\n    placeholder',
    'A quoted "placeholder" is ordinary context.',
    "A quoted 'placeholder' is ordinary context.",
    "Example:\n\n'placeholder'",
    'Example:\n\n‘placeholder’',
    "The owners' implementation needs a formatter.",
    'The owners’ implementation needs a formatter.',
  ]) {
    const text = prefix + '\n\n' + annotation;
    expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('auto_decided');
  }
});
test('distinct affirmative sentences retain their independent evidence', () => {
  const text = automatic + ' ' + scopedAutomatic;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('auto_decided');
  expect(inspectCeoModePreference(transcript(assistant(automatic), assistant(scopedAutomatic, 'end_turn', 'later')), text).kind).toBe('auto_decided');
});
test.each([automatic, scopedAutomatic, savedAutomatic])('contrary questions and native provenance still control mode evidence: %s', annotation => {
  for (const rows of [
    [assistant(mode), assistant(annotation, 'end_turn', 'later')],
    [assistant(annotation), assistant(mode, 'end_turn', 'later')],
    [assistant(annotation + '\n' + mode)],
    [assistant(mode + '\n' + annotation)],
  ]) expect(inspectCeoModePreference(transcript(...rows), annotation + '\n' + mode).kind).toBe('asked');
  expect(inspectCeoModePreference(transcript(assistant(annotation)), 'Working...').kind).toBe('working');
  expect(inspectCeoModePreference({ ...transcript(assistant(annotation)), pendingBytes: 1 }, annotation).kind).toBe('working');
  for (const block of [
    { type: 'tool_use', name: 'Write', input: { content: annotation } },
    { type: 'thinking', thinking: annotation },
  ]) {
    const row = assistant(''); row.message.content = [block as any];
    expect(inspectCeoModePreference(transcript(row), annotation).kind).toBe('working');
  }
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-mode-owner-free-'));
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [
      { ...assistant(annotation), sessionId: '00000000-0000-4000-8000-000000000002' },
      { ...assistant(annotation), sessionId, isSidechain: true },
      { ...assistant(annotation), sessionId, parent_tool_use_id: 'tool' },
    ];
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
    expect(inspectCeoModePreference(readOwnedClaudeTranscript(config, sessionId), annotation).kind).toBe('working');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});
test('quoted templates and previously acknowledged or superseded questions cannot receive an answer', () => {
  const unfenced = 'Example only; do not answer this template yet:\n' + approach;
  expect(inspectCeoModePreference(transcript(assistant(unfenced)), unfenced).kind).toBe('working');
  const text = 'Example only; do not answer this template yet:\n```text\n' + approach + '\n```';
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(approach), assistant('Working...', 'tool_use', 'new')), approach + '\nWorking...').kind).toBe('working');
  const reply = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Choose A' }] } };
  expect(inspectCeoModePreference(transcript(assistant(approach), reply), approach).kind).toBe('working');
});

test.each(['automatic', 'saved-automatic', 'target', 'timeout', 'expired-boot', 'exited'] as const)('driver handles %s without replaying the unrelated answer or accepting a preview', async scenario => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-preference-free-'));
  const sends: string[] = [];
  let typed = '';
  let time = 0; let closed = false; let visible = ''; let file = ''; let sessionId = ''; let polls = 0;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ ...row, sessionId }) + '\n');
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    currentScreen: async () => ({ text: visible, rawEnd: visible.length }),
    exited: () => scenario === 'exited', close: async () => { closed = true; },
    send(data: string) {
      sends.push(data);
      if (data.startsWith('/')) {
        append({ type: 'assistant', message: { id: 'preview', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Write', id: 'w1', input: { content: mode } }] } });
        visible += mode;
      } else if (data.startsWith('For plan-ceo-review-approach-select,')) {
        typed = data; visible += '\n❯ ' + data;
      } else throw new Error('Unsolicited input: ' + data);
    },
    sendKey(key: string) {
      expect(key).toBe('Enter');
      expect(typed).not.toEndWith('\r');
      append({ type: 'user', message: { role: 'user', content: typed } });
      // Repaint the exact previous question for several polls; no extra input.
      visible += '\n' + approach;
    },
  } as unknown as ClaudePtySession;
  try {
    const observation = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: scenario === 'expired-boot' ? 1000 : 30_000 }, {
      now: () => time,
      launch: async opts => {
        sessionId = opts.extraArgs![1];
        file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return session;
      },
      pause: async ms => {
        time += ms;
        if (++polls === 3) { append(assistant(approach)); visible += '\n' + approach; }
        if (polls === 6 && ['automatic', 'saved-automatic', 'target'].includes(scenario)) {
          const text = scenario === 'automatic' ? automatic : scenario === 'saved-automatic' ? savedAutomatic : mode;
          append(assistant(text, 'end_turn', 'last')); visible += '\n' + text;
        }
      },
    });
    expect(closed).toBe(true);
    expect(sends.filter(text => text.startsWith('For ')).length).toBe(['expired-boot', 'exited'].includes(scenario) ? 0 : 1);
    expect(observation.outcome).toBe(['automatic', 'saved-automatic'].includes(scenario) ? 'auto_decided' : scenario === 'target' ? 'asked' : scenario === 'exited' ? 'exited' : 'timeout');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});

test.each([
  'string ack', 'block ack', 'delayed ack', 'partial ack',
  'dropped text', 'dropped Enter', 'wrong user then exact ack', 'nontext user then exact ack', 'assistant then exact ack',
  'old ack', 'foreign ack', 'sidechain ack', 'parent-tool ack', 'tool-result echo', 'reset prefix',
  'same-owner duplicate', 'same-owner thinking',
  'changed same-owner before Enter', 'same-owner tool before Enter', 'incomplete same-owner before Enter',
  'ack before Enter', 'new owner before Enter', 'nontext user before Enter', 'automatic before Enter', 'scoped automatic before Enter', 'mode question before Enter',
  'exit before Enter', 'deadline before Enter', 'partial native row before Enter', 'throw on type',
])('prose submission requires a separate Enter and exact owned acknowledgement: %s', async scenario => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-submit-free-'));
  const evidenceRoot = path.join(config, 'evidence');
  const payload = 'For plan-ceo-review-approach-select, I choose option A. Continue the review.';
  const writes: Array<{ text: string; poll: number }> = [];
  let time = 0; let polls = 0; let visible = ''; let file = ''; let sessionId = '';
  let typed = ''; let entered = 0; let enterPoll = -1; let typePoll = -1;
  let closed = false; let exited = false; let progressed = false;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
  const user = (content: any = payload) => ({ type: 'user', message: { role: 'user', content } });
  const finish = () => { append(assistant(automatic, 'end_turn', 'done')); visible += '\n' + automatic; progressed = true; };
  const acknowledge = () => {
    append(user(scenario === 'block ack' ? [{ type: 'text', text: payload }] : payload));
    finish();
  };
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    currentScreen: async () => ({ text: visible, rawEnd: visible.length }),
    rawOutput: () => visible, visibleText: () => visible, pid: () => 1, exitCode: () => exited ? 0 : null,
    exited: () => exited, close: async () => { closed = true; },
    send(data: string) {
      writes.push({ text: data, poll: polls });
      if (data.startsWith('/')) {
        if (scenario === 'old ack') append(user());
        append(assistant(approach)); visible += approach;
        return;
      }
      typePoll = polls;
      if (scenario === 'throw on type') throw new Error('Synthetic text transport failure');
      if (scenario === 'dropped text') return;
      // Model the observed CLI: text plus CR in one write can leave editable
      // text without a native user turn. Only a later Enter submits it.
      typed = data.replace(/\r$/, ''); visible += '\n❯ ' + typed;
    },
    sendKey(key: string) {
      expect(key).toBe('Enter'); entered++; enterPoll = polls;
      if (!typed || scenario === 'dropped Enter') return;
      if (scenario === 'delayed ack' || scenario === 'partial ack') {
        if (scenario === 'partial ack') fs.appendFileSync(file, JSON.stringify({ sessionId, ...user() }));
        return;
      }
      if (scenario === 'wrong user then exact ack') { append(user('For another-question, I choose option A.')); acknowledge(); }
      else if (scenario === 'nontext user then exact ack') { append(user([{ type: 'image', source: {} }])); acknowledge(); }
      else if (scenario === 'assistant then exact ack') { append(assistant('Another owner', 'tool_use', 'intervening')); acknowledge(); }
      else if (scenario === 'old ack') finish();
      else if (scenario === 'foreign ack') { append({ ...user(), sessionId: '00000000-0000-4000-8000-000000000001' }); finish(); }
      else if (scenario === 'sidechain ack') { append({ ...user(), isSidechain: true }); finish(); }
      else if (scenario === 'parent-tool ack') { append({ ...user(), parent_tool_use_id: 'child' }); finish(); }
      else if (scenario === 'tool-result echo') { append(user([{ type: 'tool_result', tool_use_id: 'preview', content: payload }])); finish(); }
      else if (scenario === 'reset prefix') { fs.writeFileSync(file, ''); acknowledge(); }
      else acknowledge();
    },
  } as unknown as ClaudePtySession;
  try {
    const promise = runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000, evidenceRoot }, {
      now: () => time,
      launch: async opts => {
        sessionId = opts.extraArgs![1]; file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true }); return session;
      },
      pause: async ms => {
        time += ms; polls++;
        if (typePoll >= 0 && !progressed && (scenario.endsWith('before Enter')
          || scenario === 'same-owner duplicate' || scenario === 'same-owner thinking')) {
          progressed = true;
          if (scenario === 'ack before Enter') acknowledge();
          else if (scenario === 'exit before Enter') exited = true;
          else if (scenario === 'deadline before Enter') time = 30_000;
          else if (scenario === 'partial native row before Enter') fs.appendFileSync(file, '{"type":');
          else if (scenario === 'nontext user before Enter') append(user([{ type: 'image', source: {} }]));
          else if (scenario === 'same-owner duplicate') append(assistant(approach));
          else if (scenario === 'changed same-owner before Enter') append(assistant('The request has changed.'));
          else if (scenario === 'incomplete same-owner before Enter') append(assistant(approach, 'tool_use'));
          else if (scenario === 'same-owner thinking' || scenario === 'same-owner tool before Enter') {
            append({ type: 'assistant', message: { id: 'message-1', role: 'assistant', stop_reason: 'end_turn', content:
              scenario === 'same-owner thinking' ? [{ type: 'thinking', thinking: 'Nonvisible metadata.' }]
                : [{ type: 'tool_use', name: 'Read', id: 'new-tool', input: {} }] } });
          }
          else {
            const value = scenario === 'automatic before Enter' ? automatic
              : scenario === 'scoped automatic before Enter' ? scopedAutomatic
              : scenario === 'mode question before Enter' ? mode : 'A new unrelated owner';
            append(assistant(value, 'end_turn', 'new-owner')); visible += '\n' + value;
          }
        }
        if (!progressed && enterPoll >= 0 && polls >= enterPoll + 2) {
          if (scenario === 'delayed ack') acknowledge();
          if (scenario === 'partial ack') { fs.appendFileSync(file, '\n'); finish(); }
        }
      },
    });
    const accepted = ['string ack', 'block ack', 'delayed ack', 'partial ack', 'ack before Enter',
      'same-owner duplicate', 'same-owner thinking'].includes(scenario);
    if (scenario === 'throw on type') await expect(promise).rejects.toThrow('Synthetic text transport failure');
    else {
      const result = await promise;
      expect(result.outcome).toBe(accepted ? 'auto_decided' : scenario === 'mode question before Enter' ? 'asked' : scenario === 'exit before Enter' ? 'exited' : 'timeout');
      expect(result.answered).toEqual(accepted ? ['message-1'] : []);
    }
    expect(closed).toBe(true);
    expect(writes.filter(write => write.text.startsWith('For ')).map(write => write.text)).toEqual([payload]);
    expect(entered).toBe(scenario.endsWith('before Enter') || scenario === 'throw on type' || scenario === 'dropped text' ? 0 : 1);
    if (entered) expect(enterPoll).toBeGreaterThan(typePoll);
    const saved = JSON.parse(fs.readFileSync(path.join(evidenceRoot, sessionId, 'observation.json'), 'utf8')).evidence;
    expect(saved.answered).toEqual(accepted ? ['message-1'] : []);
    if (accepted) expect(saved.pendingReply).toBeNull();
    else expect(saved.pendingReply).toMatchObject({ id: 'message-1', questionId: 'plan-ceo-review-approach-select', text: payload, textWriteAttempted: true, enterWriteAttempted: entered === 1 });
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});

const standardTuningFooter = 'Reply `tune: never-ask`, `tune: always-ask`, or free-form to tune this question.';

test.each(['letter list', 'tuning footer', 'letter list and footer', 'unknown footer', 'duplicate footer',
  'numeric letter list', 'conflicting reply', 'missing selector', 'footer not last', 'fenced footer', 'stale frame', 'wrong ack'])
('native prerequisite prose grammar preserves exact submission and ACK: %s', async scenario => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-prose-grammar-'));
  const payload = 'For plan-ceo-review-approach, I choose option B. Continue the review.';
  let brief = screenBrief.replace('A) Client-side formatter over the existing settings API (recommended)',
    'A) Client-side formatter over the existing settings API').replace('B) Server-side CSV endpoint', 'B) Server-side CSV endpoint (recommended)');
  if (scenario !== 'tuning footer') brief = brief.replace('Reply with **A**, **B**, or **C**.', 'Reply with a letter: A, B, or C.');
  if (scenario !== 'letter list') brief += '\n' + standardTuningFooter;
  if (scenario === 'unknown footer') brief = brief.replace('free-form to tune this question.', 'D to approve all changes.');
  if (scenario === 'duplicate footer') brief += '\n' + standardTuningFooter;
  if (scenario === 'numeric letter list') brief = brief.replace('A, B, or C.', '1, 2, or 3.');
  if (scenario === 'conflicting reply') brief += '\nReply with D.';
  if (scenario === 'missing selector') brief = brief.replace('A, B, or C.', 'A or B.');
  if (scenario === 'footer not last') brief += '\nAnother instruction follows.';
  if (scenario === 'fenced footer') brief = brief.replace('\n' + standardTuningFooter, '\n```text\n' + standardTuningFooter);
  const accepted = ['letter list', 'tuning footer', 'letter list and footer'].includes(scenario);
  let time = 0; let visible = ''; let file = ''; let sessionId = ''; let typed = ''; let closed = false;
  const writes: string[] = []; let entered = 0;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    currentScreen: async () => ({ text: scenario === 'stale frame' ? 'Previous question' : visible, rawEnd: visible.length }),
    rawOutput: () => visible, visibleText: () => visible, pid: () => 1, exitCode: () => null,
    exited: () => false, close: async () => { closed = true; },
    send(text: string) {
      writes.push(text);
      if (text.startsWith('/')) { append(assistant(brief, 'end_turn', 'grammar-question')); visible += brief; }
      else { typed = text; visible += '\n❯ ' + text; }
    },
    sendKey(key: string) {
      expect(key).toBe('Enter'); entered++;
      append({ type: 'user', message: { role: 'user', content: scenario === 'wrong ack' ? 'Another answer' : typed } });
      append(assistant(automatic, 'end_turn', 'finished')); visible += '\n' + automatic;
    },
  } as unknown as ClaudePtySession;
  try {
    const result = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000 }, {
      now: () => time, pause: async ms => { time += ms; }, launch: async opts => {
        sessionId = opts.extraArgs![1]; file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true }); return session;
      },
    });
    expect(closed).toBe(true);
    expect(result.outcome).toBe(accepted ? 'auto_decided' : 'timeout');
    expect(result.answered).toEqual(accepted ? ['grammar-question'] : []);
    expect(writes.filter(text => text.startsWith('For '))).toEqual(accepted || scenario === 'wrong ack' ? [payload] : []);
    expect(entered).toBe(accepted || scenario === 'wrong ack' ? 1 : 0);
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});

const capturedOfficeHours = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-office-hours-render.json'), 'utf8'));
test('owned office-hours reply survives captured terminal redraw without accepting a mode decision', () => {
  const { assistantText, visible } = capturedOfficeHours;
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-office-hours-offer', answer: 'B',
  });
});

test('captured prose reply still requires current complete ownership and both explicit selectors', () => {
  const { assistantText, visible } = capturedOfficeHours;
  const owned = assistant(assistantText);
  for (const input of [
    transcript(assistant(assistantText, 'tool_use')),
    { ...transcript(owned), pendingBytes: 3 },
    transcript(owned, { type: 'user', message: { role: 'user', content: 'Choose B' } }),
    transcript(owned, assistant('Working...', 'tool_use', 'newer')),
    transcript({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'end_turn', content: [
      { type: 'tool_use', name: 'Write', input: { content: assistantText } },
    ] } }),
    transcript(assistant('Example only, not an actual question:\n' + assistantText)),
    transcript(assistant('I will present this later:\n' + assistantText)),
    transcript(assistant(assistantText.split('\n').map((line: string) => '> ' + line).join('\n'))),
  ]) expect(inspectCeoModePreference(input, visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(owned), '<gstack-qid:plan-ceo-review-office-hours-offer>').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(owned), visible.replaceAll('plan-ceo-review-office-hours-offer', 'foreign-question')).kind).toBe('working');
  const mismatched = assistantText.replace('or A to run', 'or C to run');
  expect(inspectCeoModePreference(transcript(assistant(mismatched)), visible.replaceAll('orAtorun', 'orCtorun')).kind).toBe('working');
});

const capturedImplementation = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-implementation-render.json'), 'utf8'));
test('captured three-choice reply uses the rendered marker without relying on damaged redraw prose', () => {
  const { assistantText, rawTerminal, visible } = capturedImplementation;
  expect(stripAnsi(rawTerminal)).toBe(visible);
  expect(rawTerminal).not.toContain('<gstack-qid:'); // CLI markdown already removed the brackets.
  expect(visible.replace(/\s/g, '')).toContain('ReplywithA,B,orC.gstack-qid:plan-ceo-review-implementation-approach');
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-implementation-approach', answer: 'B',
  });
});

test.each([
  { selectors: ['A', 'B'], reply: 'Reply B to keep this scope, or A to add caching.', position: 'last' },
  { selectors: ['A', 'B', 'C'], reply: 'Reply with A, B, or C.', position: 'first' },
  { selectors: ['1', '2', '3', '4'], reply: 'Reply with 1, 2, 3, or 4.', position: 'first' },
])('reply corroboration follows the unique selector inventory: $reply', ({ selectors, reply, position }) => {
  const directive = `${reply} <gstack-qid:plan-ceo-review-cache-policy>`;
  const options = selectors.map((selector, index) => `${selector}) Cache policy ${index}${index === 1 ? ' (recommended)' : ''}`).join('\n');
  const text = `## D3 — Cache policy\n${position === 'first' ? directive + '\n' : ''}The choice determines expiration behavior.\n${options}${position === 'last' ? '\n' + directive : ''}`;
  const visible = directive.replace(/[<>]/g, '').replace(/ /g, '');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible)).toMatchObject({ kind: 'unrelated', answer: selectors[1] });
});

test('captured reply cannot authorize incomplete, ambiguous, stale, quoted or mode questions', () => {
  const { assistantText, visible } = capturedImplementation;
  const owned = assistant(assistantText);
  for (const input of [
    transcript(assistant(assistantText, 'tool_use')),
    { ...transcript(owned), pendingBytes: 1 },
    transcript(owned, { type: 'user', message: { role: 'user', content: 'Choose B' } }),
    transcript(owned, assistant('Working...', 'tool_use', 'newer')),
    transcript(assistant(assistantText, 'end_turn', 'old'), assistant(assistantText, 'end_turn', 'new')),
    transcript(assistant('Example only, not an actual question:\n' + assistantText)),
    transcript(assistant('I will present this later:\n' + assistantText)),
    transcript(assistant('```text\n' + assistantText + '\n```')),
    transcript(assistant(assistantText.split('\n').map((line: string) => '> ' + line).join('\n'))),
    transcript({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'end_turn', content: [
      { type: 'tool_use', name: 'Write', input: { content: assistantText } },
    ] } }),
    transcript(assistant(assistantText.replace('**C)', '**B)'))),
    transcript(assistant(assistantText.replace('**A)', '**A) (recommended)'))),
    transcript(assistant(assistantText + '\n<gstack-qid:plan-ceo-review-other>')),
  ]) expect(inspectCeoModePreference(input, visible).kind).toBe('working');
  for (const render of [
    'gstack-qid:plan-ceo-review-implementation-approach',
    visible.replaceAll('plan-ceo-review-implementation-approach', 'foreign-question'),
    visible.replaceAll('plan-ceo-review-implementation-approach', 'plan-ceo-review-implementation-approach-stale'),
    visible.replaceAll('gstack-qid:plan-ceo-review-implementation-approach', '<gstack-qid:plan-ceo-review-implementation-approach-stale>'),
    visible.replaceAll('orC.', 'orD.'),
    visible.replaceAll('A,B,orC.', 'A,orC.'),
    visible.replaceAll('Reply', 'Repl'),
  ]) expect(inspectCeoModePreference(transcript(owned), render).kind).toBe('working');
  const modeText = assistantText.replaceAll('plan-ceo-review-implementation-approach', 'plan-ceo-review-mode');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), visible.replaceAll('plan-ceo-review-implementation-approach', 'plan-ceo-review-mode')).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
  for (const text of [
    assistantText + '\nD) Add another format\nE) Add a fifth format',
    assistantText.replace('**C)', '**Z)'),
  ]) expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});

test('qid token boundaries survive normalization even before later reply text', () => {
  const text = 'D1 — Cache policy\nReply with A<gstack-qid:plan-ceo-review-cache>, or B.\nA) Reuse (recommended)\nB) Replace';
  const visible = 'Reply with A gstack-qid:plan-ceo-review-cache, or B.';
  expect(inspectCeoModePreference(transcript(assistant(text)), visible).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible.replace('cache,', 'cache-stale,')).kind).toBe('working');
});

test('same-input exact tool directives are ambiguous while ordinary qid references are not', () => {
  const { assistantText, visible } = capturedImplementation;
  const preview = (text: string) => ({ type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'Write', input: { content: text } },
  ] } });
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: assistantText }] } };
  const current = assistant(assistantText, 'end_turn', 'current');
  expect(inspectCeoModePreference(transcript(preview(assistantText), current), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(result, current), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(preview(assistantText), current), assistantText).kind).toBe('working');
  const qidReference = '<gstack-qid:plan-ceo-review-implementation-approach>';
  expect(inspectCeoModePreference(transcript(preview(qidReference), current), visible).kind).toBe('unrelated');
  const nextInput = { type: 'user', message: { role: 'user', content: 'Continue this review' } };
  expect(inspectCeoModePreference(transcript(preview(assistantText), nextInput, current), visible).kind).toBe('unrelated');
});

test('input-window scoping keeps earlier contrary mode and affirmative mode evidence', () => {
  const { assistantText, visible } = capturedImplementation;
  const current = assistant(assistantText, 'end_turn', 'current');
  expect(inspectCeoModePreference(transcript(current), visible, '').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(mode), current), mode + visible, '').kind).toBe('asked');
  expect(inspectCeoModePreference(transcript(assistant(automatic), current), automatic + visible, '').kind).toBe('auto_decided');
});

const adjacentMarker = '<gstack-qid:plan-ceo-review-cache-policy>';
const adjacentReply = 'Reply with **A** or **B**.';
const adjacentBrief = `D1 — Cache policy\nA) Reuse (recommended)\nB) Replace\n\n\`${adjacentMarker}\`\n\n${adjacentReply}`;
const adjacentVisible = adjacentMarker + '\nReply with A or B.';

test.each([false, true])('an explicit negative recommendation does not compete with the positive choice (structural render: %s)', structural => {
  const text = adjacentBrief.replace('A) Reuse (recommended)', 'A) Reuse (recommended: no)')
    .replace('B) Replace', 'B) Replace (recommended)');
  expect(inspectCeoModePreference(transcript(assistant(text)), structural ? adjacentVisible : text))
    .toMatchObject({ kind: 'unrelated', questionId: 'plan-ceo-review-cache-policy', answer: 'B' });
});

// Native AUTO D1 combined its recommendation with numeric day/min effort.
// Qualifiers, quotes, duplicate markers and stale ownership still fail closed.
test.each([
  { marker: '(recommended, human ~1 day / CC ~15 min)', answer: 'B' },
  { marker: '(recommended: yes, human 2 days / CC 20 mins)', answer: 'B' },
  { marker: '(recommended, but not now)' },
  { marker: '(recommended, human ~1 day / CC ~15 min, but not now)' },
  { marker: '(not recommended, human ~1 day / CC ~15 min)' },
  { marker: '(recommended: no, human ~1 day / CC ~15 min)' },
  { marker: '(recommended: maybe, human ~1 day / CC ~15 min)' },
  { marker: '(recommended, human 1-2 days / CC 15 min)' },
  { marker: '(recommended, human half day / CC 15 min)' },
  { marker: '(recommended, human 1 hour / CC 15 min)' },
  { marker: '(recommended, human 1 day / CC 15 min extra)' },
  { marker: '"(recommended, human ~1 day / CC ~15 min)"' },
  { marker: '`(recommended, human ~1 day / CC ~15 min)`' },
  { marker: '(formerly (recommended, human ~1 day / CC ~15 min))' },
  { marker: '(recommended, human ~1 day / CC ~15 min) (recommended)' },
])('numeric effort timing metadata stays polarity-bound: $marker', ({ marker, answer }) => {
  const text = adjacentBrief.replace('A) Reuse (recommended)', 'A) Reuse')
    .replace('B) Replace', `B) Replace ${marker}`);
  const owned = transcript(assistant(text));
  const signal = inspectCeoModePreference(owned, text, text, text);
  if (answer) {
    expect(signal).toMatchObject({ kind: 'unrelated', answer });
    expect(inspectCeoModePreference(owned, text, text, '').kind).toBe('working');
    expect(inspectCeoModePreference({ ...owned, pendingBytes: 1 }, text).kind).toBe('working');
    expect(inspectCeoModePreference(transcript(assistant(text, 'tool_use')), text).kind).toBe('working');
    expect(inspectCeoModePreference(transcript(assistant(text + '\nDo not answer this question yet.')), text).kind).toBe('working');
    expect(inspectCeoModePreference(transcript(assistant(text, 'end_turn', 'old'), assistant(text, 'end_turn', 'new')), text).kind).toBe('working');
    expect(inspectCeoModePreference(owned, text.replace('Reply with **A** or **B**.', 'Reply with **A**.')).kind).toBe('working');
    const ambiguous = text.replace('A) Reuse', 'A) Reuse (recommended)');
    expect(inspectCeoModePreference(transcript(assistant(ambiguous)), ambiguous).kind).toBe('working');
  } else expect(signal.kind).toBe('working');
});

// Native AUTO D1 used closed bold labels followed by inline explanations.
// C's conditional negative description did not compete with B's explicit marker.
const describedAlternative = [
  'D1 — Which implementation approach?',
  '**A) Minimal client-side export.** A small formatter and one button.',
  '**B) Complete client-side export. (recommended)** The same read API, two pure modules, and table-driven tests.',
  '**C) Server-side export endpoint.** A new GET route that streams CSV. Listed for completeness, not recommended unless exports must be audited or settings are too large for the client.',
  '', 'Reply with `D1: A`, `D1: B`, or `D1: C`. `<gstack-qid:plan-ceo-review-approach>`',
].join('\n');

test('an inline negative description cannot compete with another explicitly recommended heading', () => {
  const owned = transcript(assistant(describedAlternative));
  expect(inspectCeoModePreference(owned, describedAlternative, describedAlternative, describedAlternative))
    .toMatchObject({ kind: 'unrelated', answer: 'B', questionId: 'plan-ceo-review-approach' });
  for (const value of [
    describedAlternative.replace('**B) Complete client-side export. (recommended)**', '**B) Complete client-side export.** (recommended)'),
    describedAlternative.replace('** A new GET', '**\nA new GET'),
    describedAlternative + '\nSTOP. Waiting on your D1 answer before mode handoff and the deep review.',
  ]) expect(inspectCeoModePreference(transcript(assistant(value)), value)).toMatchObject({ kind: 'unrelated', answer: 'B' });
  expect(inspectCeoModePreference(owned, describedAlternative, describedAlternative, '').kind).toBe('working');
  const clipped = describedAlternative.replace(' Listed for completeness, not recommended unless exports must be audited or settings are too large for the client.', '');
  expect(inspectCeoModePreference(owned, describedAlternative, clipped, describedAlternative).kind).toBe('working');
  expect(inspectCeoModePreference(owned, describedAlternative, describedAlternative, clipped).kind).toBe('working');
  expect(inspectCeoModePreference(owned, describedAlternative, describedAlternative.repeat(2), describedAlternative).kind).toBe('working');
  expect(inspectCeoModePreference({ ...owned, pendingBytes: 1 }, describedAlternative).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(describedAlternative, 'tool_use')), describedAlternative).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(describedAlternative, 'end_turn', 'old'), assistant(describedAlternative, 'end_turn', 'new')), describedAlternative).kind).toBe('working');
  const preview = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: describedAlternative }] } };
  expect(inspectCeoModePreference(transcript(preview, assistant(describedAlternative)), describedAlternative).kind).toBe('working');
  const deferred = describedAlternative + '\nDo not answer this question yet.';
  expect(inspectCeoModePreference(transcript(assistant(deferred)), deferred).kind).toBe('working');
});

test('heading recovery preserves conditional, contradictory, quoted, and ambiguous refusals', () => {
  for (const value of [
    describedAlternative.replace(' (recommended)', ''),
    describedAlternative.replace('**A) Minimal client-side export.**', '**A) Minimal client-side export. (recommended)**'),
    describedAlternative.replace('**C) Server-side export endpoint.**', '**C) Server-side export endpoint. (not recommended unless necessary)**'),
    describedAlternative.replace('**C) Server-side export endpoint.**', 'C) Server-side export endpoint.'),
    describedAlternative.replace('**C) Server-side export endpoint.**', '**C) Server-side export endpoint.'),
    describedAlternative.replace('not recommended unless', 'recommended unless'),
    describedAlternative.replace('not recommended unless', 'not not recommended unless'),
    describedAlternative.replace('not recommended unless', '(not recommended unless necessary), unless'),
    describedAlternative.replace('not recommended unless', '"not recommended" unless'),
    describedAlternative.replace('not recommended unless', '`not recommended` unless'),
    describedAlternative.replace('not recommended unless', 'not recommended (recommended) unless'),
    describedAlternative.replace('not recommended unless', 'not recommended; choose C instead unless'),
    describedAlternative.replace('not recommended unless', 'not recommended; do not choose B unless'),
    describedAlternative.replace('not recommended unless', 'not recommended; select this option unless'),
    describedAlternative.replace('The same read API,', 'Not recommended unless necessary. The same read API,'),
    describedAlternative.replace('The same read API,', 'Do not choose B. The same read API,'),
    describedAlternative.replace('The same read API,', 'Choose C instead. The same read API,'),
    describedAlternative.replace('The same read API,', '\nDo not choose B.\nThe same read API,'),
    describedAlternative + '\nChoose C instead.',
    describedAlternative + '\nAnswer C.',
    describedAlternative + '\nReply with option C.',
    describedAlternative.replace('**C) Server-side export endpoint.**', 'Do not choose B.\n**C) Server-side export endpoint.**'),
    describedAlternative.replace('** A new GET', '** (recommended: maybe) A new GET'),
    describedAlternative.replace('** A new GET', '** (recommended) A new GET'),
  ]) expect(inspectCeoModePreference(transcript(assistant(value)), value).kind).toBe('working');
});

test.each([
  { a: '', b: '', answer: 'A' },
  { a: '(not recommended)', b: '(recommended)', answer: 'B' },
  { a: '( recommended : NO )', b: '( RECOMMENDED : yes )', answer: 'B' },
  { a: '(recommended: yes)', b: '(recommended: no)', answer: 'A' },
  { a: '', b: '(recommended)', answer: 'B' },
  { a: '(recommended: no)', b: '"CSV" (recommended)', answer: 'B' },
  { a: '(recommended: no)', b: "'CSV' (recommended)", answer: 'B' },
  { a: '(recommended: no)', b: '`csv.ts` (recommended)', answer: 'B' },
  { a: '(recommended: no)', b: "don't rename owners' files (recommended)", answer: 'B' },
  { a: '(recommended)', b: '(recommended)' },
  { a: '(recommended: yes)', b: '(recommended: yes)' },
  { a: '(recommended: no)', b: '' },
  { a: '', b: '(not recommended)' },
  { a: '(not recommended)', b: '(recommended: no)' },
  { a: '(recommended: maybe)', b: '(recommended)' },
  { a: '(not recommended unless necessary)', b: '(recommended)' },
  { a: '(not not recommended)', b: '(recommended)' },
  { a: '(recommended for this situation)', b: '(recommended)' },
  { a: '(recommended by the default rule, not by context)', b: '(recommended)' },
  { a: '(recommended) (not recommended)', b: '' },
  { a: '(recommended) (recommended)', b: '' },
  { a: '(recommended) "(recommended)"', b: '' },
  { a: '(recommended: no)', b: 'recommended' },
  { a: '(recommended: no)', b: '(recommended' },
  { a: '(recommended: no)', b: '((recommended))' },
  { a: '(recommended: no)', b: '(not (recommended))' },
  { a: '(recommended: no)', b: '(formerly (recommended))' },
  { a: '(recommended: no)', b: '(recommended))' },
  { a: '(recommended: no)', b: '(unrecommended)' },
  { a: '(recommended: no)', b: '"(recommended)"' },
  { a: '(recommended: no)', b: '"the (recommended) cache"' },
  { a: '(recommended: no)', b: "Quote 'don't use the (recommended) path'" },
  { a: '(recommended: no)', b: 'Quote ‘don’t use the (recommended) path’' },
  { a: '(recommended: no)', b: "Quote 'owners' (recommended) path'" },
  { a: '(recommended: no)', b: '\\"(recommended)\\"' },
  { a: '(recommended: no)', b: "'(recommended)'" },
  { a: '(recommended: no)', b: '“the (recommended) path”' },
  { a: '(recommended: no)', b: '‘the (recommended) path’' },
  { a: '(recommended: no)', b: '`(recommended)`' },
  { a: '(recommended: no)', b: '``the (recommended) path``' },
  { a: '(recommended: no)', b: '`prefix \\`` (recommended) suffix \\`` end`' },
  { a: '(recommended: no)', b: '"unfinished (recommended)' },
  { a: '(recommended: no)', b: '`unfinished (recommended)' },
  { a: '"(not recommended)"', b: '(recommended)' },
])('option recommendation polarity is explicit and unambiguous: $a / $b', ({ a, b, answer }) => {
  const text = adjacentBrief.replace('A) Reuse (recommended)', `A) Reuse ${a}`)
    .replace('B) Replace', `B) Replace ${b}`);
  for (const visible of [text, adjacentVisible]) {
    const signal = inspectCeoModePreference(transcript(assistant(text)), visible);
    if (answer) expect(signal).toMatchObject({ kind: 'unrelated', answer });
    else expect(signal.kind).toBe('working');
  }
});

test('a Recommendation paragraph is not a new source for choosing an option', () => {
  const text = adjacentBrief.replace('A) Reuse (recommended)', 'Recommendation: B because it is faster.\n\nA) Reuse');
  for (const visible of [text, adjacentVisible]) {
    expect(inspectCeoModePreference(transcript(assistant(text)), visible)).toMatchObject({ kind: 'unrelated', answer: 'A' });
  }
});

test('an adjacent standalone identity and reply are corroborated in native order', () => {
  for (const text of [adjacentBrief, adjacentBrief.replaceAll('`', ''), adjacentBrief.replace('\n\nReply', '\nReply')]) {
    expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible)).toMatchObject({
      kind: 'unrelated', questionId: 'plan-ceo-review-cache-policy', answer: 'A',
    });
  }
  for (const visible of [
    adjacentVisible.split('\n').reverse().join('\n'),
    adjacentVisible.replace('cache-policy', 'cache-policy-stale'),
    adjacentVisible.replace(' or B', ''),
    adjacentVisible.replace('or B', 'or C'),
    adjacentMarker,
  ]) expect(inspectCeoModePreference(transcript(assistant(adjacentBrief)), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(adjacentBrief)), adjacentVisible, '').kind).toBe('working');
});

test.each(['> quoted interruption', '```text\nexample\n```', '    indented interruption', 'Intervening prose.'])('adjacent identity cannot be manufactured across %s', interruption => {
  const text = adjacentBrief.replace('\n\nReply', '\n' + interruption + '\nReply');
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible).kind).toBe('working');
});

test('adjacent directives retain completion, ownership and recommendation ambiguity guards', () => {
  for (const input of [
    transcript(assistant(adjacentBrief, 'tool_use')),
    { ...transcript(assistant(adjacentBrief)), pendingBytes: 1 },
    transcript(assistant(adjacentBrief), assistant('Still working', 'tool_use', 'newer')),
    transcript(assistant(adjacentBrief), { type: 'user', message: { role: 'user', content: 'Continue' } }),
    transcript(assistant(adjacentBrief, 'end_turn', 'old'), assistant(adjacentBrief, 'end_turn', 'new')),
    transcript(assistant(adjacentBrief.replace('B) Replace', 'B) Replace (recommended for this situation)'))),
    transcript(assistant(adjacentBrief.replace('(recommended)', '(recommended by the default rule, not by context)').replace('B) Replace', 'B) Replace (recommended for this situation)'))),
    transcript(assistant(adjacentBrief.replace('B) Replace', 'A) Replace'))),
    transcript(assistant(adjacentBrief + '\n<gstack-qid:plan-ceo-review-other>')),
    transcript(assistant(adjacentBrief.replace('`' + adjacentMarker + '`', '    ' + adjacentMarker))),
    transcript(assistant(adjacentBrief.replace('Reply with', '    Reply with'))),
    transcript(assistant(adjacentBrief.replace('`' + adjacentMarker + '`', '`' + adjacentMarker))),
  ]) expect(inspectCeoModePreference(input, adjacentVisible).kind).toBe('working');
});

test('split tool previews cannot establish an adjacent rendered question', () => {
  const current = assistant(adjacentBrief, 'end_turn', 'current');
  const preview = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'Write', input: { identity: adjacentMarker, directive: adjacentReply } },
  ] } };
  const result = { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', content: adjacentMarker }, { type: 'tool_result', content: adjacentReply },
  ] } };
  expect(inspectCeoModePreference(transcript(preview, current), adjacentVisible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(result, current), adjacentVisible).kind).toBe('working');
  const reference = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: adjacentMarker }] } };
  expect(inspectCeoModePreference(transcript(reference, current), adjacentVisible).kind).toBe('unrelated');
});

test.each(['I will present this later:', 'Example only; do not answer:', 'If this becomes relevant:', '> Deferred until later'])('full rendering does not authorize a wrapped question: %s', lead => {
  const text = lead + '\n\n' + adjacentBrief;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible).kind).toBe('working');
});

const capturedAdjacent = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-adjacent-render.json'), 'utf8'));
test('captured immediately introduced brief binds its intact adjacent reply without changing the mode oracle', () => {
  const { assistantText, visible } = capturedAdjacent;
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-office-hours-offer', answer: 'B',
  });
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible, '').kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible, '<gstack-qid:plan-ceo-review-office-hours-offer>Reply with A or B.').kind).toBe('working');
  const modeText = assistantText.replaceAll('plan-ceo-review-office-hours-offer', 'plan-ceo-review-mode');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
  const ambiguous = assistantText.replace('A) Run /office-hours now', 'A) Run /office-hours now (recommended by the default rule, not by context)');
  expect(inspectCeoModePreference(transcript(assistant(ambiguous)), visible).kind).toBe('working');
});

const capturedContext = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/ceo-mode-preference-context-render.json'), 'utf8'));
test('the captured completed question survives a neutral status introduction without changing its recommendation or mode oracle', () => {
  const { assistantText, visible } = capturedContext;
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible)).toMatchObject({
    kind: 'unrelated', questionId: 'plan-ceo-review-office-hours-offer', answer: 'B',
  });
  const ambiguous = assistantText.replace('A) Run /office-hours first', 'A) Run /office-hours first (recommended)');
  expect(ambiguous).not.toBe(assistantText);
  expect(inspectCeoModePreference(transcript(assistant(ambiguous)), visible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(assistantText)), visible, '').kind).toBe('working');
  const modeText = assistantText.replaceAll('plan-ceo-review-office-hours-offer', 'plan-ceo-review-mode');
  expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
});

test.each([
  "I'll present the question now.",
  'I will ask this current question before proceeding.',
  'Loaded project config. I will render this brief below.',
  'Missing saved plans, available local tests. I will present the decision brief here.',
  'The repository scan finished. The remaining decision follows.',
  'A brief update: the workspace scan is complete.\n\nOne decision remains.',
  "No design doc.\n\nI'll present the question now.",
  "**I'll present the question now.**",
  '`review-input.md` is loaded. Now presenting the current decision.',
])('a structurally introduced current decision requires its introduction to render: %s', lead => {
  const text = lead + '\n\n---\n\n' + adjacentBrief;
  const visible = lead.replace(/`/g, '') + '\n---\nD1 — Cache policy\n' + adjacentVisible;
  expect(inspectCeoModePreference(transcript(assistant(text)), visible).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(text)), visible.replace('---', 'interruption')).kind).toBe('working');
});

test.each([
  "I'll present the question later.",
  "If necessary, I'll present the question now.",
  "I won't present the question now.",
  "I'll present the example question now.",
  "I'll present the question now, but do not answer.",
  "No participation expected. I'll present the question now.",
  "Ready rehearsal material. I'll present the question now.",
  "Ready rehearsal report. I'll present the question now.",
  "This is only a rehearsal. I'll present the question now.",
  "> I'll present the question now.",
  "    I'll present the question now.",
  "`I'll present the question now.`",
  '**`Neutral status.`**',
  '_`Neutral status.`_',
  "```text\nI'll present the question now.\n```",
])('a noncurrent or quoted introduction cannot receive input even when fully rendered: %s', lead => {
  const text = lead + '\n\n---\n\n' + adjacentBrief;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(assistant(text)), lead + '\n---\nD1 — Cache policy\n' + adjacentVisible).kind).toBe('working');
});

test.each([
  'Do not answer this decision yet.',
  'Do not _answer_ this decision yet.',
  'Do *not* answer this decision yet.',
  'Do not `answer` this decision yet.',
  'Don’t answer this decision yet.',
  'Note: Do not answer this decision yet.',
  'Do not\nanswer this decision yet.',
  '- Do not answer this decision yet.',
  '### Do not answer this decision yet.',
  'Please do not reply to this question.',
  'No participation expected.',
  'Important: No participation expected.',
  '- No participation expected.',
  '* No participation expected.',
  'This question is deferred until later.',
  'This question is hypothetical.',
  'This is only a rehearsal.',
  "Here's an example:",
  'Here’s an example:',
  "If necessary, I'll present the question now.",
])('noncurrent statements veto the entire unrelated brief without erasing mode evidence: %s', statement => {
  for (const question of [adjacentBrief, "I'll present the question now.\n\n---\n\n" + adjacentBrief]) {
    for (const text of [
      statement + '\n\n' + question,
      question.replace('A) Reuse', statement + '\n\nA) Reuse'),
      question.replace('B) Replace', 'B) Replace. ' + statement),
      question + '\n\n' + statement,
    ]) {
      expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
      expect(inspectCeoModePreference(transcript(assistant(text)), question).kind).toBe('working');
      const modeText = text.replaceAll('plan-ceo-review-cache-policy', 'plan-ceo-review-mode');
      expect(inspectCeoModePreference(transcript(assistant(modeText)), modeText).kind).toBe('asked');
    }
  }
});

test('ordinary inline examples and deferred actions do not make the current question hypothetical', () => {
  const text = ('The workspace scan is complete.\n\n' + adjacentBrief)
    .replace('A) Reuse (recommended)', 'For example, compare the cached value with `a,b` and `a"b`. These inline examples describe the formatter.\n\nA) Reuse the example cache (recommended)')
    .replace('B) Replace', 'B) Defer the cache migration until later');
  expect(inspectCeoModePreference(transcript(assistant(text)), text)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test.each([
  'For example, the parser can preserve an example question in history.',
  'The configuration snippet is only a template for the new formatter.',
  'If we choose A, ask QA to verify the CSV example later.',
])('explanations about examples and subsequent work do not defer the current question: %s', explanation => {
  const text = adjacentBrief.replace('A) Reuse', explanation + '\n\nA) Reuse');
  expect(inspectCeoModePreference(transcript(assistant(text)), text)).toMatchObject({ kind: 'unrelated', answer: 'A' });
  expect(inspectCeoModePreference(transcript(assistant(text)), adjacentVisible)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test.each([
  'Do not answer cached queries until refreshed',
  'Do not answer iterative queries until refreshed',
  'Render the template question later',
])('an option action does not prohibit input to the current question: %s', option => {
  const text = adjacentBrief.replace('B) Replace', 'B) ' + option);
  expect(inspectCeoModePreference(transcript(assistant(text)), text)).toMatchObject({ kind: 'unrelated', answer: 'A' });
});

test('a prefaced current question requires an explicit corroborated Reply even when its entire text renders', () => {
  const text = 'The workspace scan is complete.\n\n' + approach;
  expect(inspectCeoModePreference(transcript(assistant(text)), text).kind).toBe('working');
});

test('the current introduction must precede its reply and cannot come from a tool preview', () => {
  const lead = "I'll present the question now.";
  const introduction = lead + '\n\n---\n\nD1 — Cache policy';
  const text = lead + '\n\n---\n\n' + adjacentBrief;
  const current = assistant(text, 'end_turn', 'current');
  const visible = introduction + '\n' + adjacentVisible;
  expect(inspectCeoModePreference(transcript(current), adjacentVisible + '\n' + introduction).kind).toBe('working');
  expect(inspectCeoModePreference(transcript(current), visible).kind).toBe('unrelated');
  expect(inspectCeoModePreference(transcript(current), adjacentVisible + '\n' + visible).kind).toBe('unrelated');
  const preview = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'Write', input: { content: introduction } },
  ] } };
  const splitPreview = { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', content: lead }, { type: 'tool_result', content: '---\nD1 — Cache policy' },
  ] } };
  for (const input of [transcript(preview, current), transcript(splitPreview, current)]) {
    expect(inspectCeoModePreference(input, visible).kind).toBe('working');
    expect(inspectCeoModePreference(input, text).kind).toBe('working');
  }
  const nextInput = { type: 'user', message: { role: 'user', content: 'Continue the review' } };
  expect(inspectCeoModePreference(transcript(preview, nextInput, current), visible).kind).toBe('unrelated');
});

test.each([false, true])('a previous input-window preview cannot answer a new owned question; fresh render=%s', async showCurrent => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-preference-input-window-'));
  const second = capturedImplementation.assistantText;
  const sends: string[] = [];
  let time = 0; let visible = ''; let file = ''; let sessionId = ''; let polls = 0; let closed = false;
  let typed = ''; let firstAcknowledged = false; let secondRendered = false;
  const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ ...row, sessionId }) + '\n');
  const session = {
    hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
    currentScreen: async () => ({ text: visible, rawEnd: visible.length }),
    exited: () => false, close: async () => { closed = true; },
    send(data: string) {
      sends.push(data);
      if (data.startsWith('/')) {
        append({ type: 'assistant', message: { id: 'preview', role: 'assistant', stop_reason: 'tool_use', content: [
          { type: 'tool_use', name: 'Write', input: { content: second } },
        ] } });
        append(assistant(approach));
        visible += second + '\n' + approach;
      } else if (data.startsWith('For ')) {
        typed = data; visible += '\n❯ ' + data;
      } else throw new Error('Unsolicited input: ' + data);
    },
    sendKey(key: string) {
      expect(key).toBe('Enter');
      append({ type: 'user', message: { role: 'user', content: typed } });
      if (typed.startsWith('For plan-ceo-review-implementation-approach,')) {
        append(assistant(automatic, 'end_turn', 'done')); visible += '\n' + automatic;
      } else {
        firstAcknowledged = true;
        append(assistant(second, 'end_turn', 'new-question'));
      }
    },
  } as unknown as ClaudePtySession;
  try {
    const observation = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000 }, {
      now: () => time,
      launch: async opts => {
        sessionId = opts.extraArgs![1];
        file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return session;
      },
      pause: async ms => {
        time += ms;
        polls++;
        if (firstAcknowledged && !secondRendered && showCurrent) {
          secondRendered = true; visible += '\n' + capturedImplementation.visible;
        }
        // New bytes do not establish that the old preview still in the
        // viewport was rendered for this input epoch's new native owner.
        if (firstAcknowledged && !showCurrent) visible += '\nWorking…';
      },
    });
    expect(closed).toBe(true);
    expect(sends.filter(text => text.startsWith('For '))).toEqual([
      'For plan-ceo-review-approach-select, I choose option A. Continue the review.',
      ...(showCurrent ? ['For plan-ceo-review-implementation-approach, I choose option B. Continue the review.'] : []),
    ]);
    expect(observation.outcome).toBe(showCurrent ? 'auto_decided' : 'timeout');
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
});


const repeatCategory = 'plan-ceo-review-expansion-proposal';
const firstProposal = 'D2 — Add a provenance row?\nReply with A or B. <gstack-qid:' + repeatCategory + '>\nA) Add provenance (recommended)\nB) Skip';
const nextProposal = 'Recorded the first decision.\n\nD3 — Redact secret values?\nReply with A or B. <gstack-qid:' + repeatCategory + '>\nA) Redact secrets (recommended)\nB) Skip';

test('reused category requires acknowledged unchanged history and the entire distinct current brief', () => {
  const previous = assistant(firstProposal, 'end_turn', 'first');
  const current = assistant(nextProposal, 'end_turn', 'second');
  const owned = transcript(previous, current);
  const acknowledgements = new Map([['first', firstProposal]]);
  const inspect = (rows = owned, frame = nextProposal, input = frame, acks = acknowledgements) =>
    inspectCeoModePreference(rows, frame, frame, input, acks);
  expect(inspect()).toMatchObject({ kind: 'unrelated', id: 'second', questionId: repeatCategory, answer: 'A' });
  expect(inspect(owned, nextProposal, nextProposal.replace('Redact secrets', '\x1b[?25lRedact\x1b[?25h secrets')))
    .toMatchObject({ kind: 'unrelated', id: 'second' });
  for (const acks of [new Map(), new Map([['unrelated', firstProposal]]), new Map([['first', firstProposal + ' changed']])]) {
    expect(inspect(owned, nextProposal, nextProposal, acks).kind).toBe('working');
  }
  for (const frame of [firstProposal, nextProposal.replace('Redact secrets', 'Export secrets'),
    nextProposal.slice(nextProposal.indexOf('Reply')), nextProposal + '\n' + nextProposal]) {
    expect(inspect(owned, frame, nextProposal).kind).toBe('working');
    expect(inspect(owned, nextProposal, frame).kind).toBe('working');
  }
  for (const control of ['\x1b[2J', '\x1b[1D', '\x1b[?1049h']) {
    expect(inspect(owned, nextProposal, nextProposal.replace('Redact secrets', control + 'Redact secrets')).kind).toBe('working');
  }
  for (const rows of [
    { ...owned, pendingBytes: 1 }, transcript(previous, assistant(nextProposal, 'tool_use', 'second')),
    transcript(previous, current, assistant('Working...', 'tool_use', 'later')),
    transcript(previous, assistant(firstProposal, 'end_turn', 'second')),
    transcript(assistant(firstProposal + ' changed', 'end_turn', 'first'), current),
    transcript(previous, assistant(firstProposal, 'end_turn', 'unacknowledged'), current),
  ]) expect(inspect(rows).kind).toBe('working');
  const preview = { type: 'assistant', message: { role: 'assistant', id: 'preview', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'Write', input: { content: nextProposal } }] } };
  expect(inspect(transcript(previous, preview, current)).kind).toBe('working');
  for (const label of ['(not recommended)', '(recommended, but not now)']) {
    const text = nextProposal.replace('(recommended)', label);
    expect(inspect(transcript(previous, assistant(text, 'end_turn', 'second')), text).kind).toBe('working');
  }
});

test.each(['exact ACK', 'missing ACK', 'wrong ACK', 'foreign ACK', 'missing confirmation'])(
  'driver reuses a question category only after its previous exact submitted reply: %s', async scenario => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-repeat-category-free-'));
    let file = '', sessionId = '', visible = '', typed = '', time = 0, entered = 0, closed = false;
    const writes: string[] = [];
    const append = (row: any) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row }) + '\n');
    const render = (text: string, id: string) => { append(assistant(text, 'end_turn', id)); visible += '\n' + text; };
    const session = {
      hermeticConfigDir: config, mark: () => visible.length, visibleSince: (since = 0) => visible.slice(since),
      currentScreen: async () => ({ text: visible, rawEnd: visible.length }),
      exited: () => false, close: async () => { closed = true; },
      send(text: string) {
        if (text.startsWith('/')) { render(firstProposal, 'first'); return; }
        writes.push(text); typed = text; visible += '\n❯ ' + text;
      },
      sendKey(key: string) {
        expect(key).toBe('Enter'); entered++;
        if (scenario !== 'missing ACK') append({ type: 'user',
          ...(scenario === 'foreign ACK' ? { sessionId: '00000000-0000-4000-8000-000000000001' } : {}),
          message: { role: 'user', content: scenario === 'wrong ACK' ? 'Different reply' : typed } });
        if (entered === 1) render(nextProposal, 'second');
        else if (scenario !== 'missing confirmation') render(automatic, 'done');
      },
    } as unknown as ClaudePtySession;
    try {
      const result = await runCeoModePreferenceObservation({ cwd: config, env: {}, timeoutMs: 30_000 }, {
        now: () => time, pause: async ms => { time += ms; },
        launch: async opts => {
          sessionId = opts.extraArgs![1]; file = path.join(config, 'projects', 'fixture', sessionId + '.jsonl');
          fs.mkdirSync(path.dirname(file), { recursive: true }); return session;
        },
      });
      const acknowledged = scenario === 'exact ACK' || scenario === 'missing confirmation';
      expect(closed).toBe(true);
      expect(result.outcome).toBe(scenario === 'exact ACK' ? 'auto_decided' : 'timeout');
      expect(result.answered).toEqual(acknowledged ? ['first', 'second'] : []);
      expect(writes).toEqual(Array(acknowledged ? 2 : 1).fill(`For ${repeatCategory}, I choose option A. Continue the review.`));
      expect(entered).toBe(acknowledged ? 2 : 1);
    } finally { fs.rmSync(config, { recursive: true, force: true }); }
  },
);
