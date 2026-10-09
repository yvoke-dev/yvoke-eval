import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportWriter, toJson, newRunId, formatModelDisplay } from '../src/report/ReportWriter';
import type { EvalResult } from '../src/types';

const evalDir = fileURLToPath(new URL('./fixtures/eval', import.meta.url));
const baselineResults = join(evalDir, 'baseline', 'basics', 'results.json');

const RESULT_KEYS = [
  'question',
  'answer',
  'signals',
  'verdict',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'latencyMs',
  'error',
];
const QUESTION_KEYS = [
  'category',
  'id',
  'question',
  'playbook',
  'expect',
  'versionTag',
  'targetTopic',
  'mustInclude',
  'mustNotInclude',
  'expectToolCalled',
  'bait',
  'citationsRequired',
  'critical',
  'rubric',
];
const SIGNALS_KEYS = [
  'toolsFired',
  'searchCollections',
  'retrievedCollections',
  'retrievedChunkCount',
  'mustIncludeMissing',
  'mustNotIncludePresent',
  'hasCitations',
];
const VERDICT_KEYS = ['verdict', 'dimensions', 'reasoning', 'evidence'];

describe('ReportWriter — results.json schema parity (golden)', () => {
  const original = JSON.parse(readFileSync(baselineResults, 'utf8')) as EvalResult[];

  it('a baseline on disk matches our EvalResult field set exactly', () => {
    expect(original.length).toBeGreaterThan(0);
    for (const r of original) {
      expect(Object.keys(r).sort()).toEqual([...RESULT_KEYS].sort());
      expect(Object.keys(r.question).sort()).toEqual([...QUESTION_KEYS].sort());
      expect(Object.keys(r.signals).sort()).toEqual([...SIGNALS_KEYS].sort());
      // verdict may omit optional `evidence`; require at least the mandatory keys.
      for (const k of ['verdict', 'dimensions', 'reasoning']) {
        expect(r.verdict).toHaveProperty(k);
      }
      for (const k of Object.keys(r.verdict)) {
        expect(VERDICT_KEYS).toContain(k);
      }
    }
  });

  it('round-trips those results through our serializer losslessly', () => {
    const reparsed = JSON.parse(toJson(original)) as EvalResult[];
    expect(reparsed).toEqual(original);
  });
});

describe('ReportWriter — run folder', () => {
  it('writes the canonical artifact set with a correct run id + meta and detailed summary', () => {
    const results = JSON.parse(readFileSync(baselineResults, 'utf8')) as EvalResult[];
    const meta = {
      answerModel: 'test-model',
      reviewerModel: 'test-judge',
      thinkingLevel: 'low',
      systemPromptName: 'default-chat',
      gitSha: 'testsha',
    };
    const overviewPath = join(evalDir, 'runs', 'OVERVIEW.md');
    const { runDir, runId } = new ReportWriter().write(evalDir, meta, results);
    try {
      const files = readdirSync(runDir);
      expect(files).toContain('run_meta.json');
      expect(files).toContain('results.json');
      expect(files).toContain('summary.md');
      expect(files).toContain('eval_basics.md');

      const rm = JSON.parse(readFileSync(join(runDir, 'run_meta.json'), 'utf8'));
      expect(rm.questionCount).toBe(results.length);
      expect(rm.gitSha).toBe('testsha');
      expect(rm.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
      expect(runId).toContain('__test-model__testsha');

      const summary = readFileSync(join(runDir, 'summary.md'), 'utf8');
      expect(summary).toContain('### Detailed Results');
      expect(summary).toContain('test-model');
      expect(summary).toContain('test-judge');

      expect(readFileSync(overviewPath, 'utf8')).toContain('Evaluation Benchmark Overview');
      expect(readFileSync(overviewPath, 'utf8')).toContain(runId);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(overviewPath, { force: true });
    }
  });

  // Regression: per-category writes used to derive runId from `new Date()` INSIDE write(), so every
  // category in a `merge: false` loop landed in the same second → same folder → results.json clobbered.
  it('keeps per-category writes in separate folders when given distinct run ids', () => {
    const results = JSON.parse(readFileSync(baselineResults, 'utf8')) as EvalResult[];
    const meta = { answerModel: 'test-model', gitSha: 'testsha' };
    const base = newRunId('test-model', 'testsha');
    const dirs: string[] = [];
    const overviewPath = join(evalDir, 'runs', 'OVERVIEW.md');
    try {
      for (const cat of ['cat_a', 'cat_b', 'cat_c']) {
        dirs.push(new ReportWriter().write(evalDir, { ...meta }, results, `${base}__${cat}`).runDir);
      }
      expect(new Set(dirs).size).toBe(3);
      for (const d of dirs) {
        const rm = JSON.parse(readFileSync(join(d, 'run_meta.json'), 'utf8'));
        expect(rm.questionCount).toBe(results.length);
        expect(rm.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
      }
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      rmSync(overviewPath, { force: true });
    }
  });

  it('formats model aliases with resolved versions in summary and overview', () => {
    const results = JSON.parse(readFileSync(baselineResults, 'utf8')) as EvalResult[];
    const meta = {
      answerModel: 'sonnet',
      resolvedAnswerModel: 'claude-sonnet-5',
      reviewerModel: 'opus',
      resolvedReviewerModel: 'claude-opus-4-8',
      gitSha: 'testsha',
    };
    const overviewPath = join(evalDir, 'runs', 'OVERVIEW.md');
    const { runDir } = new ReportWriter().write(evalDir, meta, results);
    try {
      const summary = readFileSync(join(runDir, 'summary.md'), 'utf8');
      expect(summary).toContain('sonnet (claude-sonnet-5)');
      expect(summary).toContain('opus (claude-opus-4-8)');

      const overview = readFileSync(overviewPath, 'utf8');
      expect(overview).toContain('sonnet (claude-sonnet-5)');
      expect(overview).toContain('opus (claude-opus-4-8)');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(overviewPath, { force: true });
    }
  });
});

describe('formatModelDisplay', () => {
  it('returns — for empty or —', () => {
    expect(formatModelDisplay('')).toBe('—');
    expect(formatModelDisplay('—')).toBe('—');
  });

  it('returns bare alias when resolved is undefined, empty, or identical', () => {
    expect(formatModelDisplay('sonnet')).toBe('sonnet');
    expect(formatModelDisplay('sonnet', '')).toBe('sonnet');
    expect(formatModelDisplay('claude-sonnet-5', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('combines alias and resolved version when different', () => {
    expect(formatModelDisplay('sonnet', 'claude-sonnet-5')).toBe('sonnet (claude-sonnet-5)');
    expect(formatModelDisplay('haiku', 'claude-haiku-4-5-20251001')).toBe('haiku (claude-haiku-4-5-20251001)');
  });
});
