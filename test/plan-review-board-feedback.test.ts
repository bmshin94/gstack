import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishBoard, type PublishBoardResult } from '../design/src/daemon-client';
import { CMDLINE_MARKER, readStateFile, verifyIdentity, writeStateFile } from '../design/src/daemon-state';
import { makeBoardHtml, spawnDaemonForTest, type SpawnedDaemon } from '../design/test/daemon-tests-fixtures';
import { createDesignReviewPicker } from './helpers/plan-review-board-feedback';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import captured from './fixtures/design-board-questions.json';

let cwd: string;
let stateFile: string;
let daemon: SpawnedDaemon;
let daemons: SpawnedDaemon[];
let boardNumber: number;

beforeEach(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-board-'));
  stateFile = path.join(cwd, '.gstack', 'design.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  daemons = [];
  boardNumber = 0;
  daemon = await spawnDaemonForTest({ stateFile });
  daemons.push(daemon);
});

afterEach(async () => {
  try {
    for (const owned of daemons) await owned.stop();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

async function board(port = daemon.port): Promise<PublishBoardResult> {
  const directory = path.join(cwd, `board-${++boardNumber}`);
  fs.mkdirSync(directory);
  return publishBoard({ port, html: makeBoardHtml(directory) });
}

function question(url: string, caseIndex = 0): NativeQuestion {
  const result = structuredClone(captured.cases[caseIndex]!.question) as NativeQuestion;
  result.question = result.question.replace(/http:\/\/127\.0\.0\.1:\d+\/boards\/[A-Za-z0-9_-]+\//, url);
  return result;
}

const picker = (deadlineAt = Date.now() + 10_000) => createDesignReviewPicker({ cwd, deadlineAt });
const feedbackPath = (published: PublishBoardResult) => path.join(published.sourceDir, 'feedback.json');
async function expectUnsubmitted(published: PublishBoardResult) {
  expect(fs.existsSync(feedbackPath(published))).toBe(false);
  const response = await fetch(published.url + 'api/progress');
  expect(response.ok).toBe(true);
  expect(await response.json()).toEqual({ status: 'serving' });
}

const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
for (const [caseIndex, retained] of captured.cases.entries()) {
  test(`captured board menu ${retained.nativeToolId}: submits real feedback before answering in every offered order`, async () => {
    const untouched = await board();
    for (const order of orders) {
      const published = await board();
      const menu = question(published.url, caseIndex);
      menu.options = order.map(index => menu.options[index]!);
      const answer = picker()(menu);
      expect(answer).toBe(order.indexOf(0) + 1);
      // Read immediately after the synchronous picker returns: the daemon,
      // rather than the test driver, must have completed this write already.
      const written = JSON.parse(fs.readFileSync(feedbackPath(published), 'utf8'));
      expect(written.preferred).toBe('A');
      expect(written.ratings).toEqual({});
      expect(written.comments).toEqual({});
      expect(written.regenerated).toBe(false);
      expect(written.boardId).toBe(published.id);
      expect(written.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(fs.existsSync(path.join(published.sourceDir, 'feedback-pending.json'))).toBe(false);
    }
    await expectUnsubmitted(untouched);
  });
}

test('a repeated owned board question does not POST a second time', async () => {
  const published = await board();
  const menu = question(published.url);
  const choose = picker();
  expect(choose(menu)).toBe(1);
  const file = feedbackPath(published);
  const contents = fs.readFileSync(file, 'utf8');
  // Give the real response file a distinguishable mtime; another server write
  // would replace it even when the submitted JSON is byte-identical.
  fs.utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  expect(choose(structuredClone(menu))).toBe(1);
  expect(fs.statSync(file).mtimeMs).toBe(1_000_000);
  expect(fs.readFileSync(file, 'utf8')).toBe(contents);
});

test('a regenerating board refuses cached approval, then a reloaded round receives new feedback', async () => {
  const published = await board();
  const menu = question(published.url);
  const choose = picker();
  expect(choose(menu)).toBe(1);
  const file = feedbackPath(published);
  fs.utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  const regenerate = await fetch(published.url + 'api/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred: 'A', regenerated: true }),
  });
  expect(await regenerate.json()).toEqual({ received: true, action: 'regenerate' });
  expect(() => choose(menu)).toThrow('not ready');
  expect(fs.statSync(file).mtimeMs).toBe(1_000_000);

  const html = makeBoardHtml(published.sourceDir, '<p>New round</p>');
  const reload = await fetch(published.url + 'api/reload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  expect(await reload.json()).toEqual({ reloaded: true });
  expect(choose(menu)).toBe(1);
  expect(fs.statSync(file).mtimeMs).not.toBe(1_000_000);
  const feedback = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(feedback.preferred).toBe('A');
  expect(feedback.regenerated).toBe(false);
  expect(feedback.boardId).toBe(published.id);
});

test('foreign host, credentials, route, query, fragment and legacy URL cannot submit', async () => {
  const published = await board();
  const variants = [
    published.url.replace('127.0.0.1', 'localhost'),
    published.url.replace('127.0.0.1', '[::1]'),
    published.url.replace('http:', 'https:'),
    published.url.replace('http://', 'http://fixture@'),
    published.url.replace(`/boards/${published.id}/`, '/'),
    published.url.slice(0, -1),
    published.url + 'api/feedback',
    published.url + '?board=another',
    published.url + '#another-board',
  ];
  for (const url of variants) expect(() => picker()(question(url))).toThrow();
  await expectUnsubmitted(published);
});

test('a real foreign daemon port is refused without changing either board', async () => {
  const published = await board();
  const otherState = path.join(cwd, 'other', '.gstack', 'design.json');
  fs.mkdirSync(path.dirname(otherState), { recursive: true });
  const other = await spawnDaemonForTest({ stateFile: otherState });
  daemons.push(other);
  const foreign = await board(other.port);
  expect(() => picker()(question(foreign.url))).toThrow();
  await expectUnsubmitted(published);
  await expectUnsubmitted(foreign);
});

test('multiple URLs, missing board context, or ambiguous action sets do not submit', async () => {
  const published = await board();
  const other = await board();
  const extraUrl = question(published.url);
  extraUrl.question += '\nAnother board: ' + other.url;
  const noContext = question(published.url);
  noContext.question = 'D2 — Confirm an operation\n' + published.url;
  const duplicate = question(published.url);
  duplicate.options.push({ ...duplicate.options[0]! });
  const extraAction = question(published.url);
  extraAction.options.push({ label: 'Delete the project', description: 'An unrelated action.' });
  const missingAction = question(published.url);
  missingAction.options.pop();
  for (const menu of [extraUrl, noContext, duplicate, extraAction, missingAction]) {
    expect(() => picker()(menu)).toThrow();
  }
  await expectUnsubmitted(published);
  await expectUnsubmitted(other);
});

test('an unrecognized past-submission label fails instead of claiming feedback was sent', async () => {
  const published = await board();
  for (const label of ['Already submitted on the board (recommended)', 'I submitted the board feedback (recommended)']) {
    const menu = question(published.url);
    menu.options[0]!.label = label;
    expect(() => picker()(menu)).toThrow();
  }
  await expectUnsubmitted(published);
});

test('missing or malformed private daemon state cannot submit', async () => {
  const published = await board();
  fs.unlinkSync(stateFile);
  expect(() => picker()(question(published.url))).toThrow();
  fs.writeFileSync(stateFile, '{not-json');
  expect(() => picker()(question(published.url))).toThrow();
  await expectUnsubmitted(published);
});

test('a state file naming a real unrelated process does not confer daemon ownership', async () => {
  const published = await board();
  const state = readStateFile(stateFile)!;
  writeStateFile({ ...state, pid: process.pid, cmdlineMarker: 'bun' }, stateFile);
  expect(() => picker()(question(published.url))).toThrow();
  await expectUnsubmitted(published);
});

test('an expired absolute deadline refuses before HTTP', async () => {
  const published = await board();
  expect(() => picker(Date.now() - 1)(question(published.url))).toThrow();
  await expectUnsubmitted(published);
});

test.skipIf(process.platform === 'win32')('a stalled owned daemon obeys the remaining deadline and leaves no fetch child', async () => {
  const published = await board();
  const owned = readStateFile(stateFile)!;
  expect(owned.pid).toBe(daemon.proc.pid!);
  expect(owned.cmdlineMarker).toBe(CMDLINE_MARKER);
  expect(Number.isFinite(Date.parse(owned.startedAt))).toBe(true);
  expect(daemon.proc.exitCode).toBeNull();
  expect(verifyIdentity(owned.pid, CMDLINE_MARKER)).toBe(true);

  const actualSpawn = childProcess.spawnSync;
  const spawned = spyOn(childProcess, 'spawnSync').mockImplementation(actualSpawn);
  let paused = false;
  try {
    paused = daemon.proc.kill('SIGSTOP');
    expect(paused).toBe(true);
    const remainingMs = 200;
    const deadlineAt = Date.now() + remainingMs;
    const started = performance.now();
    expect(() => picker(deadlineAt)(question(published.url))).toThrow('Design feedback failed');
    const elapsedMs = performance.now() - started;
    // Leave scheduler overhead while rejecting use of the ordinary 2s child
    // budget after the case has only 200ms remaining.
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(remainingMs + 750);
    expect(spawned).toHaveBeenCalledTimes(1);
    const result = spawned.mock.results[0]!.value as childProcess.SpawnSyncReturns<string>;
    expect(result.pid).toBeGreaterThan(0);
    expect(result.status).not.toBe(0);
    let childError: unknown;
    try { process.kill(result.pid, 0); } catch (error) { childError = error; }
    expect(childError).toMatchObject({ code: 'ESRCH' });
    expect(readStateFile(stateFile)).toMatchObject({ pid: owned.pid, startedAt: owned.startedAt });
    console.log('Design feedback deadline:', JSON.stringify({ remainingMs, elapsedMs,
      childExited: true, signal: result.signal, status: result.status }));
  } finally {
    spawned.mockRestore();
    if (paused) daemon.proc.kill('SIGCONT');
  }
  // An in-flight HTTP failure is ambiguous at the server. Do not fabricate a
  // no-write guarantee; the picker must fail, and normal owned cleanup follows.
});

test('an unknown board HTTP error does not produce a submitted answer', async () => {
  const published = await board();
  const unknown = published.url.replace(published.id, published.id + '-missing');
  expect(() => picker()(question(unknown))).toThrow('HTTP 404');
  await expectUnsubmitted(published);
});

test('the real daemon feedback-write error propagates without claiming submission', async () => {
  const published = await board();
  fs.mkdirSync(feedbackPath(published));
  expect(() => picker()(question(published.url))).toThrow('HTTP 500');
  expect(fs.readdirSync(feedbackPath(published))).toEqual([]);
  const response = await fetch(published.url + 'api/progress');
  expect(await response.json()).toEqual({ status: 'serving' });
});

test('a failed child launch retains its original error when stderr is null', async () => {
  const published = await board();
  const failedLaunch = spyOn(childProcess, 'spawnSync').mockReturnValue({
    error: Object.assign(new Error('spawn fixture-bun ENOENT'), { code: 'ENOENT' }),
    pid: 0, status: null, signal: null, output: [null, null, null],
    stdout: null, stderr: null,
  } as unknown as ReturnType<typeof childProcess.spawnSync>);
  try {
    expect(() => picker()(question(published.url))).toThrow('spawn fixture-bun ENOENT');
    expect(failedLaunch).toHaveBeenCalledTimes(1);
  } finally {
    failedLaunch.mockRestore();
  }
  await expectUnsubmitted(published);
});

test('ordinary decisions and manual review handoffs delegate without board side effects', async () => {
  const published = await board();
  const menus: NativeQuestion[] = [
    { header: 'Layout', question: 'Which panel should lead?', multiSelect: false, options: [
      { label: 'Activity', description: 'Show activity first.' },
      { label: 'Notifications (recommended)', description: 'Show notifications first.' },
    ] },
    { header: 'Next steps', question: 'D9 — Next steps?', multiSelect: false, options: [
      { label: 'Run /plan-eng-review next (recommended)', description: 'Continue review.' },
      { label: 'Skip, handle manually', description: 'Handle the next steps later.' },
    ] },
  ];
  for (const menu of menus) expect(picker()(menu)).toBe(pickPlanReviewQuestion(menu));
  await expectUnsubmitted(published);
});
