/** Exercise native mode navigation with no real CLI or model process. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { navigateToModeAskUserQuestion } from '../helpers/plan-skill-mode-navigation';
import type { ClaudePtySession } from '../helpers/claude-pty-runner';

const scenario = process.argv[2];
const sessionId = '00000000-0000-4000-8000-000000000001';
const config = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-native-fixture-'));
const file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const append = (row: unknown) => fs.appendFileSync(file, JSON.stringify({ sessionId, ...row as object }) + '\n');
const tool = (id: string, question: string, labels: string[]) => append({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, header: question, multiSelect: false, options: labels.map(label => ({ label, description: label })) }] } }] } });
const result = (id: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Answer accepted' }] } });
let buffer = '\nExample modes in a report preview\n❯1.HOLD SCOPE\n2.SELECTIVE EXPANSION\n3.SCOPE REDUCTION\n';
tool('approach', 'Choose architecture', ['Extend dispatcher', 'Queue fanout']);
let sleeps = 0;
let clock = 0;
let stage = 'preview';
let acknowledged = false;
const sends: string[] = [];
const premature: string[] = [];
const labels = scenario === 'missing' ? ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'] : ['HOLD SCOPE', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION', 'SCOPE EXPANSION'];
const session = {
  exited: () => false, exitCode: () => null,
  get hermeticConfigDir() {
    if ((scenario === 'read-budget' && stage === 'mode') || (scenario === 'ack-budget' && stage === 'done')) clock = 30_000;
    return config;
  },
  visibleSince: (mark = 0) => buffer.slice(mark), rawOutput: () => buffer,
  mark: () => { if (scenario === 'write-budget' && stage === 'mode') clock = 30_000; return buffer.length; },
  send(data: string) {
    sends.push(data);
    if (stage === 'approach' && data === '1\r') {
      result('approach');
      tool('mode', 'Choose review mode', labels);
      stage = 'mode';
      // Native input is authoritative even when the current viewport only
      // renders two choices. The target remains native option four.
      buffer += '\nChoose review mode\n❯1.HOLD SCOPE\n2.SELECTIVE EXPANSION\n';
    } else if (stage === 'mode' && data === '4\r') {
      if (scenario !== 'unacknowledged') { result('mode'); acknowledged = true; }
      stage = 'done';
      buffer += '\nSCOPE EXPANSION posture\n';
    } else premature.push(data);
  },
  sendKey(key: string) { this.send(key === 'Enter' ? '\r' : ''); },
} as unknown as ClaudePtySession;
const oldSleep = Bun.sleep;
const oldNow = Date.now;
Bun.sleep = (async (ms: number) => {
  clock += ms;
  if (++sleeps === 2) { stage = 'approach'; buffer += '\nChoose architecture\n❯1.Extend dispatcher\n2.Queue fanout\n'; }
}) as typeof Bun.sleep;
Date.now = () => clock;
try {
  let navigation;
  let error;
  try { navigation = await navigateToModeAskUserQuestion(session, 0, 'SCOPE EXPANSION', { sessionId, budgetMs: scenario === 'invalid-budget' ? Number.NaN : 30_000 }); }
  catch (cause) { error = String(cause); }
  console.log(JSON.stringify({ navigation, error, sends, premature, acknowledged }));
} finally {
  Bun.sleep = oldSleep;
  Date.now = oldNow;
  fs.rmSync(config, { recursive: true, force: true });
}
