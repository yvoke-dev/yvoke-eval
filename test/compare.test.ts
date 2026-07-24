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

function mkResult(id: string, verdict: string, mustNotPresent: string[] = []): EvalResult {
  return {
    question: {
      category: 'basics', id, question: 'q', playbook: 'p', expect: 'answer', versionTag: '1.0',
      targetTopic: null, mustInclude: [], mustNotInclude: [], expectToolCalled: [], bait: null,
      citationsRequired: true, critical: false, rubric: null,
    },
    answer: 'a',
    signals: {
      toolsFired: [], searchCollections: [], retrievedCollections: [], retrievedChunkCount: 0,
      mustIncludeMissing: [], mustNotIncludePresent: mustNotPresent, hasCitations: true,
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
});
