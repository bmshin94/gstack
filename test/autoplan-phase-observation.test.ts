/** Free ordering regressions for the paid autoplan chain's observed markers. */
import { describe, expect, test } from 'bun:test';
import { validateAutoplanPhaseOrder } from './helpers/autoplan-phase-order';

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
