import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanSkillCompletion } from './helpers/plan-skill-completion';
import { stripAnsi } from './helpers/claude-pty-runner';

describe('owned assistant plan review completion', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  let config: string;
  let file: string;
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    type: 'assistant', sessionId, isSidechain: false,
    message: { id: 'message-1', role: 'assistant', content, stop_reason: 'end_turn', ...message }, ...extra,
  });
  const text = (value: string) => [{ type: 'text', text: value }];
  const write = (...rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  beforeEach(() => {
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-completion-'));
    file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  });
  afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

  test.each(['## GSTACK REVIEW REPORT', '## Completion Summary', '**VERDICT: APPROVED**', 'Status: clean', '**DONE**', 'DONE_WITH_CONCERNS — remaining risks'])('completed assistant %s is a valid chat terminal', marker => {
    write(assistant(text(marker)), { type: 'cost-state', sessionId });
    const visible = stripAnsi('\x1b[2C' + marker.replace(/\*|#| /g, ''));
    expect(readPlanSkillCompletion(config, sessionId, visible)).not.toBeNull();
    expect(readPlanSkillCompletion(config, sessionId, 'Still working')).toBeNull();
  });

  test('Write previews and tool results cannot complete a review', () => {
    const marker = '## GSTACK REVIEW REPORT\nVERDICT: APPROVED';
    write(assistant([{ type: 'tool_use', name: 'Write', input: { content: marker } }], {}, { stop_reason: 'tool_use' }));
    expect(readPlanSkillCompletion(config, sessionId, marker)).toBeNull();
    write({ type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', content: marker }] } });
    expect(readPlanSkillCompletion(config, sessionId, marker)).toBeNull();
  });

  test('text preceding a tool call is not a completed assistant turn', () => {
    write(assistant(text('DONE'), {}, { stop_reason: 'tool_use' }));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(assistant(text('DONE')), assistant([{ type: 'tool_use', name: 'Write' }]));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test.each([
    { type: 'user', message: { role: 'user', content: 'Continue the review' } },
    { type: 'attachment', attachment: { prompt: 'Review this other plan' } },
    { type: 'assistant', message: { id: 'message-2', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] } },
  ])('later conversation activity invalidates an earlier completion (%j)', later => {
    write(assistant(text('DONE')), { sessionId, ...later });
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test('actual queued input must be consumed before a new assistant completion can finish', () => {
    const enqueue = { type: 'queue-operation', sessionId, operation: 'enqueue', content: 'Review the supplied payment plan' };
    const remove = { ...enqueue, operation: 'remove', reason: 'absorbed_mid_turn' };
    const done = assistant(text('DONE'));
    write(done, enqueue);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, done);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, done, remove);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, done, remove, assistant(text('DONE'), {}, { id: 'after-consumption' }));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });

  test('removing one duplicate queued input does not consume the other', () => {
    const enqueue = { type: 'queue-operation', sessionId, operation: 'enqueue', content: 'Continue' };
    const remove = { ...enqueue, operation: 'remove' };
    write(enqueue, enqueue, remove, assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, enqueue, remove, remove, assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });

  test('quoted, fenced, indented, and future-example markers cannot complete a review', () => {
    write(assistant(text('I will print DONE later.\n> DONE\n    DONE\n\tDONE\n```md\n## GSTACK REVIEW REPORT\n```\n~~~\nVERDICT: APPROVED\n~~~')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE GSTACK REVIEW REPORT VERDICT: APPROVED')).toBeNull();
  });

  test('foreign sessions, sidechains, thinking, and user text are not assistant completion', () => {
    write(
      assistant(text('DONE'), { sessionId: '00000000-0000-4000-8000-000000000002' }),
      assistant(text('DONE'), { isSidechain: true }),
      assistant(text('DONE'), { parent_tool_use_id: 'child' }),
      assistant(text('DONE'), { type: 'user' }),
      assistant([{ type: 'thinking', thinking: 'DONE' }]),
    );
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test('an unfinished record or missing end_turn stays pending', () => {
    write(assistant(text('DONE'), {}, { stop_reason: null }));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(assistant(text('DONE')));
    fs.appendFileSync(file, '{"type":"user"');
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test('missing ownership fails honestly; missing transcript remains pending', () => {
    expect(() => readPlanSkillCompletion(null, sessionId, 'DONE')).toThrow('owned hermetic');
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });
});
