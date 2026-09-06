/** Free ordering regressions for the paid autoplan chain's observed markers. */
import { describe, expect, test } from 'bun:test';
import { observedAutoplanPhases, validateAutoplanPhaseOrder } from './helpers/autoplan-phase-order';
import { stripAnsi } from './helpers/claude-pty-runner';

describe('autoplan completion markers from rendered output', () => {
  test('reads actual Claude 2.1.257 cursor-positioned output after ANSI stripping', () => {
    // Reduced from a real PTY capture; its saved assistant response contains
    // all four **Phase N complete.** lines, but the terminal omits the stars.
    const raw = '\x1b[2C\x1b[9BPhase\x1b[9G1\x1b[11Gcomplete.\n'
      + '\x1b[2C\x1b[1BPhase\x1b[9G2\x1b[11Gcomplete.\n'
      + '\x1b[2C\x1b[11BPhase\x1b[9G2.5\x1b[13Gcomplete.\n'
      + '\x1b[2C\x1b[12BPhase\x1b[9G3\x1b[11Gcomplete.';
    const visible = stripAnsi(raw);
    expect(visible).toBe('Phase1complete.\nPhase2complete.\nPhase2.5complete.\nPhase3complete.');
    expect(observedAutoplanPhases(visible)).toEqual([1, 2, 2.5, 3]);
  });

  test.each([
    'Phase 1 complete.\nPhase 3 complete.',
    '**Phase 1 complete.**\n**Phase 3 complete.**',
    '**Phase 1 complete**\n**Phase 3 complete**',
    'Phase1complete. Phase3complete.',
  ])('accepts plain, Markdown, and compacted markers: %s', visible => {
    expect(observedAutoplanPhases(visible)).toEqual([1, 3]);
  });

  test('keeps decimal DX, duplicates, and actual match order within one poll', () => {
    expect(observedAutoplanPhases('Phase2.5complete. Phase 2 complete. Phase2.5complete.'))
      .toEqual([2.5, 2, 2.5]);
  });

  test.each([
    'SubPhase1complete.',
    'pre_Phase 1 complete.',
    'Phase1completed.',
    'Phase 1 completeness.',
    'Phase1complete_more',
    'Phase 1 incomplete.',
    'Phase 3',
    'Phase3 pending completion.',
    'Reply with word Phase, then number 3, then word complete.',
  ])('rejects incomplete markers and unrelated words: %s', visible => {
    expect(observedAutoplanPhases(visible)).toEqual([]);
  });

  test('retains unknown phases for the order validator to reject', () => {
    const phases = observedAutoplanPhases('Phase1complete. Phase4complete. Phase3complete.');
    expect(phases).toEqual([1, 4, 3]);
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow();
  });

  test('extraction does not sort a reversed Design/DX stream into valid order', () => {
    const phases = observedAutoplanPhases('Phase1complete. Phase2.5complete. Phase2complete. Phase3complete.');
    expect(phases).toEqual([1, 2.5, 2, 3]);
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('optional Design (2), optional DX (2.5)');
  });
});

describe('autoplan completion order from the observed stream', () => {
  test('a correctly ordered same-poll batch passes even when timestamps are identical', () => {
    const hits = [1, 2, 2.5, 3].map(phase => ({ phase, ts: 1234 }));
    expect(() => validateAutoplanPhaseOrder(hits.map(hit => hit.phase))).not.toThrow();
  });

  test.each([
    [1, 3],
    [1, 2, 3],
    [1, 2.5, 3],
  ].map(phases => ({ phases })))('optional phases may be absent: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).not.toThrow();
  });

  test.each([
    [],
    [1],
    [3],
    [2, 2.5],
  ].map(phases => ({ phases })))('missing required completion fails: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('requires CEO (1) and Eng (3)');
  });

  test.each([
    [3, 1],
    [2, 1, 3],
    [2.5, 1, 3],
  ].map(phases => ({ phases })))('inverted required or preceding optional phases fail: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow();
  });

  test('Design must precede DX when both completed', () => {
    expect(() => validateAutoplanPhaseOrder([1, 2.5, 2, 3])).toThrow('optional Design (2), optional DX (2.5)');
  });

  test.each([
    [1, 3, 2],
    [1, 3, 2.5],
  ].map(phases => ({ phases })))('Eng cannot precede a later completed phase: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow('Eng (3) must complete last');
  });

  test.each([
    [1, 2, 2, 3],
    [1, 4, 3],
  ].map(phases => ({ phases })))('duplicate or unknown first-observation markers fail: %j', ({ phases }) => {
    expect(() => validateAutoplanPhaseOrder(phases)).toThrow();
  });
});
