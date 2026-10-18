import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  compareRunToBaseline,
  groupByCategory,
  loadResults,
  loadBaseline,
} from '../src/compare/BaselineComparator';
import { effectiveVerdict, verdictRank } from '../src/compare/verdict';
import type { EvalResult } from '../src/types';

const baselineDir = fileURLToPath(new URL('./fixtures/eval/baseline', import.meta.url));

function mkResult(id: string, verdict: string, mustNotPresent: string[] = [], critical = false): EvalResult {
  return {
    question: {
      category: 'basics', id, question: 'q', playbook: 'p', expect: 'answer', versionTag: '1.0',
      targetTopic: null, mustInclude: [], mustNotInclude: [], expectToolCalled: [], bait: null,
      citationsRequired: true, critical, rubric: null,
    },
    answer: 'a',
    signals: {
      toolsFired: [], searchCollections: [], retrievedCollections: [], retrievedChunkCount: 0,
      mustIncludeMissing: [], mustNotIncludePresent: mustNotPresent, expectedToolsMissing: [], hasCitations: true,
    },
    verdict: { verdict, dimensions: {}, reasoning: '', evidence: [] },
    promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, error: null,
  };
}

describe('verdict helpers', () => {
  it('ranks verdicts and applies the deterministic fabrication gate', () => {
    expect(verdictRank('PASS')).toBeGreaterThan(verdictRank('FAIL'));
    expect(effectiveVerdict(mkResult('Q1', 'PASS'))).toBe('PASS');
    expect(effectiveVerdict(mkResult('Q1', 'PASS', ['FakeTool.exe']))).toBe('FAIL'); // fabrication → FAIL
  });
});

describe('compareRunToBaseline', () => {
  const base = [mkResult('Q1', 'PASS'), mkResult('Q2', 'PASS'), mkResult('Q3', 'PARTIAL')];

  it('reports no regression when the run matches the baseline', () => {
    const report = compareRunToBaseline('run-x', new Map([['basics', base]]), new Map([['basics', base]]));
    expect(report.gated).toBe(false);
    expect(report.hardRegressions).toHaveLength(0);
    expect(report.categories[0].runPass).toBe(report.categories[0].basePass);
  });

  it('flags a hard regression (PASS → FAIL) and fails the gate', () => {
    const run = [mkResult('Q1', 'FAIL'), mkResult('Q2', 'PASS'), mkResult('Q3', 'PARTIAL')];
    const report = compareRunToBaseline('run-x', new Map([['basics', run]]), new Map([['basics', base]]));
    expect(report.gated).toBe(true);
    expect(report.hardRegressions.map((r) => r.id)).toEqual(['Q1']);
  });

  it('treats PASS → PARTIAL as a soft regression that does NOT fail the gate', () => {
    const run = [mkResult('Q1', 'PARTIAL'), mkResult('Q2', 'PASS'), mkResult('Q3', 'PARTIAL')];
    const report = compareRunToBaseline('run-x', new Map([['basics', run]]), new Map([['basics', base]]));
    expect(report.gated).toBe(false);
    expect(report.softRegressions.map((r) => r.id)).toEqual(['Q1']);
  });

  it('a fabrication hit is a hard regression even if the judge said PASS', () => {
    const run = [mkResult('Q1', 'PASS', ['GhostTool.exe']), mkResult('Q2', 'PASS'), mkResult('Q3', 'PARTIAL')];
    const report = compareRunToBaseline('run-x', new Map([['basics', run]]), new Map([['basics', base]]));
    expect(report.gated).toBe(true);
    expect(report.hardRegressions[0].runVerdict).toBe('FAIL');
  });

  it('self-compares a baseline on disk with zero regressions', () => {
    const results = loadResults(join(baselineDir, 'basics'));
    const byCat = groupByCategory(results);
    const baseByCat = loadBaseline(baselineDir, [...byCat.keys()]);
    const report = compareRunToBaseline('self', byCat, baseByCat);
    expect(report.gated).toBe(false);
    expect(report.hardRegressions).toHaveLength(0);
    expect(report.categories[0].runPass).toBe(3);
  });

  it('distinguishes critical from non-critical hard regressions', () => {
    const nonCritBase = [mkResult('Q1', 'PASS', [], false)];
    const nonCritRun = [mkResult('Q1', 'FAIL', [], false)];
    const rep1 = compareRunToBaseline('r1', new Map([['basics', nonCritRun]]), new Map([['basics', nonCritBase]]));
    expect(rep1.gated).toBe(true);
    expect(rep1.hardRegressions).toHaveLength(1);
    expect(rep1.criticalHardRegressions).toHaveLength(0);

    const critBase = [mkResult('Q1', 'PASS', [], true)];
    const critRun = [mkResult('Q1', 'FAIL', [], true)];
    const rep2 = compareRunToBaseline('r2', new Map([['basics', critRun]]), new Map([['basics', critBase]]));
    expect(rep2.gated).toBe(true);
    expect(rep2.hardRegressions).toHaveLength(1);
    expect(rep2.criticalHardRegressions).toHaveLength(1);
  });
});

describe('effectiveVerdict', () => {
  it('preserves ERROR verdict even on critical questions with missing tokens', () => {
    const r = mkResult('Q1', 'ERROR', [], true);
    r.signals.mustIncludeMissing = ['MissingToken'];
    expect(effectiveVerdict(r)).toBe('ERROR');
  });

  it('preserves ERROR when error string is present', () => {
    const r = mkResult('Q1', 'PASS', [], true);
    r.error = 'timeout error';
    expect(effectiveVerdict(r)).toBe('ERROR');
  });

  it('derives FAIL when must_not_include is present', () => {
    const r = mkResult('Q1', 'PASS', ['Bait.exe'], false);
    expect(effectiveVerdict(r)).toBe('FAIL');
  });

  it('derives FAIL when critical question misses must_include', () => {
    const r = mkResult('Q1', 'PASS', [], true);
    r.signals.mustIncludeMissing = ['MissingToken'];
    expect(effectiveVerdict(r)).toBe('FAIL');
  });

  it('does not derive FAIL on non-critical question missing must_include', () => {
    const r = mkResult('Q1', 'PARTIAL', [], false);
    r.signals.mustIncludeMissing = ['MissingToken'];
    expect(effectiveVerdict(r)).toBe('PARTIAL');
  });
});
