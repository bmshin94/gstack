import { expect, test } from 'bun:test';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import capture from './fixtures/auto-decide-explanatory-mode-043a.json';
import annotations from './fixtures/native-auto-decide-ag.json';

const clone = () => structuredClone(capture) as any;
const declaration = (f: any) => f.transcript.assistantMessages.find((m: any) =>
  m.text.startsWith('**Review mode: HOLD SCOPE** —'));
const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);

function witnessed() {
  const f = clone();
  const use = f.tools.find((e: any) => e.input?.command?.includes('gstack-question-log'));
  // Synthetic owned-file witness from the exact literal request. The original
  // file was not retained; its failed paid attempt remains failed.
  const record = JSON.parse(/gstack-question-log '(\{[^\n]*\})'/.exec(use.input.command)![1]!);
  record.source = 'agent';
  record.ts = f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === use.toolUseId).timestamp;
  f.options.stateEvidence = { questionId: 'plan-ceo-review-mode', preference: 'never-ask', records: [record] };
  return f;
}

test('original public events alone cannot authenticate the unretained owned append', () => {
  expect(decide(clone())).toBeNull();
});

test('exact completed announcement agrees with an authenticated owned append', () => {
  const f = witnessed();
  const result = decide(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.annotation).toBe(declaration(f).text);
  expect(result?.stateRecord).toEqual(f.options.stateEvidence.records[0]);
  expect(result?.questionLogToolUseId).toBeUndefined();
});

const separators = ['. ', ', ', '; ', ': ', ' — ', ' – ', ' - '];
for (const separator of separators) {
  test(`complete mode with separated explanation ${JSON.stringify(separator)}`, () => {
    const f = witnessed();
    declaration(f).text = `Review mode: HOLD SCOPE${separator}selected from the saved preference.`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
  test(`same later completed mode retains its explanation ${JSON.stringify(separator)}`, () => {
    const f = witnessed();
    declaration(f).text += `\n\nMode decision completed: HOLD SCOPE${separator}selected from the saved preference.`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
  test(`different later completed mode withdraws the choice ${JSON.stringify(separator)}`, () => {
    const f = witnessed();
    declaration(f).text += `\n\nCorrection: Mode: SCOPE EXPANSION${separator}selected from the saved preference.`;
    expect(decide(f)).toBeNull();
  });
  test(`conditional explanation never completes the mode ${JSON.stringify(separator)}`, () => {
    const f = witnessed();
    declaration(f).text = `Review mode: HOLD SCOPE${separator}if approved.`;
    expect(decide(f)).toBeNull();
  });
  test(`later conditional explanation withdraws the choice ${JSON.stringify(separator)}`, () => {
    const f = witnessed();
    declaration(f).text += `\n\nMode: HOLD SCOPE${separator}pending approval.`;
    expect(decide(f)).toBeNull();
  });
}

for (const value of ['HOLD SCOPELESS', 'HOLD SCOPE SCOPE EXPANSION', 'HOLD SCOPE / SCOPE EXPANSION',
  'HOLD SCOPE?', 'HOLD SCOPE selected from my preference', 'HOLD SCOPE—if approved', 'HOLD SCOPE - ']) {
  test(`incomplete or ambiguous mode is not a declaration: ${value}`, () => {
    const f = witnessed(); declaration(f).text = `Mode: ${value}`;
    expect(decide(f)).toBeNull();
  });
  test(`incomplete current field retracts a previous mode: ${value}`, () => {
    const f = witnessed(); declaration(f).text += `\n\nMode: ${value}`;
    expect(decide(f)).toBeNull();
  });
}

for (const [name, mutate] of Object.entries({
  'missing append': (f: any) => { f.options.stateEvidence.records = []; },
  'foreign session': (f: any) => { f.options.stateEvidence.records[0].session_id = 'foreign'; },
  'different logged mode': (f: any) => { f.options.stateEvidence.records[0].user_choice = 'SCOPE EXPANSION'; },
  'native question': (f: any) => { f.transcript.calls.push({ sessionId: f.options.sessionId }); },
  'unfinished declaration': (f: any) => { declaration(f).text = 'Mode decision pending: HOLD SCOPE — saved preference.'; },
  'withdrawn decision': (f: any) => { declaration(f).text += '\n\nI withdraw this decision.'; },
  'quoted declaration': (f: any) => { declaration(f).text = '> Mode: HOLD SCOPE — saved preference.'; },
  'example declaration': (f: any) => { declaration(f).text = 'Example:\nMode: HOLD SCOPE — saved preference.'; },
})) test(`explanatory announcement still rejects ${name}`, () => {
  const f = witnessed(); mutate(f); expect(decide(f)).toBeNull();
});

test('quoted historical correction does not withdraw the current completed mode', () => {
  const f = witnessed();
  declaration(f).text += '\n\n> Mode: SCOPE EXPANSION — a historical example.';
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});

test('generic Skill annotations retain their existing non-CEO mode vocabulary', () => {
  const f = structuredClone(annotations.attempts[0]) as any;
  f.options.skillName = 'office-hours';
  f.tools.find((e: any) => e.kind === 'use' && e.name === 'Skill').input.skill = 'office-hours';
  const message = f.transcript.assistantMessages.find((m: any) => m.text.startsWith('Auto-decided'));
  message.text = 'Auto-decided workflow → **Builder** (your preference). Change with /plan-tune.\n\nMode: Builder (saved preference).';
  expect(decide(f)?.option).toBe('Builder');
  message.text += '\n\nMode: Startup (saved preference).';
  expect(decide(f)).toBeNull();
});

test('retained retry messages alone cannot authenticate missing tool and file evidence', () => {
  const retry = capture.retryObservation;
  expect(findNativeAutoDecision(retry.transcript, [], retry.options)).toBeNull();
});

test('exact retry prose accepts the optional decision label in an owned context', () => {
  const f = witnessed();
  // Only the text is replayed. Session/time and owned witness belong to the
  // first fixture; this is not a reconstruction or promotion of the retry.
  declaration(f).text = capture.retryObservation.transcript.assistantMessages.find(m =>
    m.text.startsWith('**Mode decision:'))!.text;
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});

for (const field of ['Mode', 'Mode decision', 'Review mode', 'Review mode decision']) {
  test(`a completed field does not require a separate status word: ${field}`, () => {
    const f = witnessed(); declaration(f).text = `${field}: HOLD SCOPE (saved preference).`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
  test(`a later matching field does not withdraw its choice: ${field}`, () => {
    const f = witnessed(); declaration(f).text += `\n\n${field}: HOLD SCOPE (saved preference).`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
  test(`a conflicting later field still withdraws its choice: ${field}`, () => {
    const f = witnessed(); declaration(f).text += `\n\n${field}: SCOPE EXPANSION (saved preference).`;
    expect(decide(f)).toBeNull();
  });
}
