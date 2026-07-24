// Copied from yvoke-desktop/tests/computeTools.test.ts alongside the module it covers. A
// security-sensitive expression parser travels with its tests or not at all.
import { describe, expect, it } from 'vitest';
import {
  COMPUTE_TOOLS,
  computeStatistics,
  dateDiff,
  safeCalculate,
} from '../src/agent/computeTools';

describe('safeCalculate', () => {
  it('respects arithmetic precedence and associativity', () => {
    expect(safeCalculate('1 + 2 * 3')).toBe(7);
    expect(safeCalculate('(1 + 2) * 3')).toBe(9);
    expect(safeCalculate('2 ^ 3 ^ 2')).toBe(512); // right-associative: 2^(3^2)
    expect(safeCalculate('2 ** 10')).toBe(1024);
    expect(safeCalculate('10 % 3')).toBe(1);
    expect(safeCalculate('-3 + 5')).toBe(2);
    expect(safeCalculate('.5 * 4')).toBe(2);
    expect(safeCalculate('1e3 + 1')).toBe(1001);
  });

  it('evaluates whitelisted functions and constants', () => {
    expect(safeCalculate('sqrt(16)')).toBe(4);
    expect(safeCalculate('max(1, 2, 3)')).toBe(3);
    expect(safeCalculate('min(4, 2, 8)')).toBe(2);
    expect(safeCalculate('round(3.6)')).toBe(4);
    expect(safeCalculate('abs(-7)')).toBe(7);
    expect(safeCalculate('pow(2, 8)')).toBe(256);
    expect(safeCalculate('PI')).toBeCloseTo(Math.PI);
    expect(safeCalculate('e')).toBeCloseTo(Math.E);
  });

  it('rejects any attempt to reach code / JS internals', () => {
    for (const bad of [
      'require("fs")',
      'process.exit(1)',
      'constructor',
      '__proto__',
      'globalThis',
      'this',
      '1; 2',
      'foo()',
      'x + 1',
      '[].constructor',
      'eval("1")',
      'toString',
    ]) {
      expect(() => safeCalculate(bad), `should reject: ${bad}`).toThrow();
    }
  });

  it('rejects malformed and non-finite results', () => {
    expect(() => safeCalculate('')).toThrow();
    expect(() => safeCalculate('(1 + 2')).toThrow();
    expect(() => safeCalculate('1 +')).toThrow();
    expect(() => safeCalculate('1 / 0')).toThrow(); // Infinity is not a finite result
  });
});

describe('computeStatistics', () => {
  it('summarizes a list of numbers (sample variance/stdev)', () => {
    const s = computeStatistics([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.count).toBe(8);
    expect(s.sum).toBe(40);
    expect(s.mean).toBe(5);
    expect(s.median).toBe(4.5);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.range).toBe(7);
    expect(s.variance).toBeCloseTo(32 / 7, 5);
    expect(s.stdev).toBeCloseTo(2.138, 3);
  });

  it('handles empty and single-element inputs', () => {
    const empty = computeStatistics([]);
    expect(empty.count).toBe(0);
    expect(empty.mean).toBeNull();
    const one = computeStatistics([42]);
    expect(one.mean).toBe(42);
    expect(one.median).toBe(42);
    expect(one.variance).toBeNull();
    expect(one.stdev).toBeNull();
  });

  it('rejects non-finite values', () => {
    expect(() => computeStatistics([1, NaN])).toThrow();
    expect(() => computeStatistics([1, Infinity])).toThrow();
  });
});

describe('dateDiff', () => {
  it('computes signed differences in the requested unit', () => {
    expect(dateDiff('2024-01-01', '2024-01-08', 'days')).toBe(7);
    expect(dateDiff('2024-01-01', '2024-01-08', 'weeks')).toBe(1);
    expect(dateDiff('2024-01-01T00:00:00Z', '2024-01-01T06:00:00Z', 'hours')).toBe(6);
    expect(dateDiff('2024-01-08', '2024-01-01', 'days')).toBe(-7); // signed
    expect(dateDiff('2024-01-01', '2024-01-02')).toBe(1); // defaults to days
  });

  it('rejects invalid dates', () => {
    expect(() => dateDiff('not-a-date', '2024-01-01')).toThrow();
    expect(() => dateDiff('2024-01-01', 'nope')).toThrow();
  });
});

describe('COMPUTE_TOOLS', () => {
  it('are namespaced under mcp__compute__', () => {
    expect(COMPUTE_TOOLS).toContain('mcp__compute__calculate');
    expect(COMPUTE_TOOLS).toContain('mcp__compute__statistics');
    expect(COMPUTE_TOOLS).toContain('mcp__compute__date_diff');
    expect(COMPUTE_TOOLS.every((t) => t.startsWith('mcp__compute__'))).toBe(true);
  });
});
