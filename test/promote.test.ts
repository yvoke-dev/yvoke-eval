import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promote } from '../src/compare/promote';
import { toJson } from '../src/report/ReportWriter';
import type { EvalResult } from '../src/types';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function mkResult(category: string, id: string, verdict: string): EvalResult {
  return {
    question: {
      category, id, question: 'q', playbook: 'p', expect: 'answer', versionTag: '9.3.1', targetTopic: null,
      mustInclude: [], mustNotInclude: [], expectToolCalled: [], bait: null, citationsRequired: true,
      critical: false, rubric: null,
    },
    answer: 'a',
    signals: {
      toolsFired: [], searchCollections: [], retrievedCollections: [], retrievedChunkCount: 0,
      mustIncludeMissing: [], mustNotIncludePresent: [], expectedToolsMissing: [], hasCitations: true,
    },
    verdict: { verdict, dimensions: {}, reasoning: '', evidence: [] },
    promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, error: null,
  };
}

describe('promote', () => {
  it('writes per-category baseline folders + a BASELINE.md index', () => {
    tmp = mkdtempSync(join(tmpdir(), 'yvoke-eval-promote-'));
    const runDir = join(tmp, 'runs', '2026-07-23T00-00-00Z__sonnet__abc');
    mkdirSync(runDir, { recursive: true });
    const results = [mkResult('getting_started', 'Q1', 'PASS'), mkResult('getting_started', 'Q2', 'FAIL')];
    writeFileSync(join(runDir, 'results.json'), toJson(results));
    writeFileSync(join(runDir, 'run_meta.json'), toJson({ answerModel: 'sonnet', reviewerModel: 'opus', gitSha: 'abc', timestamp: '2026-07-23T00-00-00Z' }));

    const baselineDir = join(tmp, 'baseline');
    const res = promote(runDir, baselineDir);

    expect(res.categories).toEqual(['getting_started']);
    const catDir = join(baselineDir, 'getting_started');
    for (const f of ['results.json', 'run_meta.json', 'summary.md', 'eval_getting_started.md']) {
      expect(existsSync(join(catDir, f))).toBe(true);
    }
    // per-category run_meta gets the right questionCount + source run
    const meta = JSON.parse(readFileSync(join(catDir, 'run_meta.json'), 'utf8'));
    expect(meta.questionCount).toBe(2);
    expect(meta.sourceRun).toBe('2026-07-23T00-00-00Z__sonnet__abc');

    const index = readFileSync(join(baselineDir, 'BASELINE.md'), 'utf8');
    expect(index).toContain('| getting_started | 1/2 PASS | `2026-07-23T00-00-00Z__sonnet__abc` |');
    expect(index).toContain('**Total:** 1/2 questions PASS across 1 categories');
  });

  it('honors a category filter for merged runs', () => {
    tmp = mkdtempSync(join(tmpdir(), 'yvoke-eval-promote-'));
    const runDir = join(tmp, 'run');
    mkdirSync(runDir, { recursive: true });
    const results = [mkResult('getting_started', 'Q1', 'PASS'), mkResult('developer_api', 'Q1', 'PASS')];
    writeFileSync(join(runDir, 'results.json'), toJson(results));
    writeFileSync(join(runDir, 'run_meta.json'), toJson({ answerModel: 'sonnet', gitSha: 'abc', timestamp: 'ts' }));

    const baselineDir = join(tmp, 'baseline');
    const res = promote(runDir, baselineDir, ['developer_api']);

    expect(res.categories).toEqual(['developer_api']);
    expect(existsSync(join(baselineDir, 'developer_api', 'results.json'))).toBe(true);
    expect(existsSync(join(baselineDir, 'getting_started'))).toBe(false);
  });

  it('rejects promoting a run that contains ERROR results', () => {
    tmp = mkdtempSync(join(tmpdir(), 'yvoke-eval-promote-'));
    const runDir = join(tmp, 'run');
    mkdirSync(runDir, { recursive: true });
    const errResult = mkResult('getting_started', 'Q1', 'ERROR');
    errResult.error = 'timeout error';
    errResult.question.critical = true;
    errResult.signals.mustIncludeMissing = ['Widget'];
    writeFileSync(join(runDir, 'results.json'), toJson([errResult]));
    writeFileSync(join(runDir, 'run_meta.json'), toJson({ answerModel: 'sonnet', gitSha: 'abc', timestamp: 'ts' }));

    const baselineDir = join(tmp, 'baseline');
    expect(() => promote(runDir, baselineDir)).toThrow(/contains 1 ERROR result/);
  });
});
