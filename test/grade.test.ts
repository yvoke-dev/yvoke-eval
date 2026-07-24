import { describe, it, expect } from 'vitest';
import { gradeOne } from '../src/run/grade';
import type { Judge } from '../src/reviewer/Judge';
import type { Verdict } from '../src/types';
import { mkQuestion, mkBundle, GOOD_ANSWER } from './fixtures';

const passJudge: Judge = {
  async review({ signals }) {
    // Deterministic gate honored by the (fake) judge: a fabrication hit is an automatic FAIL.
    const verdict: Verdict['verdict'] = signals.mustNotIncludePresent.length > 0 ? 'FAIL' : 'PASS';
    return { verdict, dimensions: {}, reasoning: 'fake', evidence: [] };
  },
};

describe('gradeOne', () => {
  it('assembles a well-formed EvalResult from a good answer', async () => {
    const r = await gradeOne(GOOD_ANSWER.question, GOOD_ANSWER.bundle, passJudge, 1234);
    expect(r.verdict.verdict).toBe('PASS');
    expect(r.error).toBeNull();
    expect(r.answer).toBe(GOOD_ANSWER.bundle.answer);
    expect(r.signals.retrievedChunkCount).toBe(1);
    expect(r.promptTokens).toBe(1200);
    expect(r.totalTokens).toBe(1500);
    expect(r.latencyMs).toBe(1234);
  });

  it('lets a fabrication hit drive a FAIL via the deterministic signal', async () => {
    const q = mkQuestion({ mustNotInclude: ['SchemaWizard.exe'] });
    const bundle = mkBundle({ answer: 'Use SchemaWizard.exe for schemas.' });
    const r = await gradeOne(q, bundle, passJudge, 10);
    expect(r.signals.mustNotIncludePresent).toEqual(['SchemaWizard.exe']);
    expect(r.verdict.verdict).toBe('FAIL');
  });

  it('never throws — a judge failure yields an ERROR verdict with must_include echoed as missing', async () => {
    const throwingJudge: Judge = {
      async review() {
        throw new Error('judge exploded');
      },
    };
    const q = mkQuestion({ mustInclude: ['Manager', 'Designer'] });
    const r = await gradeOne(q, mkBundle({ answer: 'x' }), throwingJudge, 5);
    expect(r.verdict.verdict).toBe('ERROR');
    expect(r.error).toContain('judge exploded');
    expect(r.signals.mustIncludeMissing).toEqual(['Manager', 'Designer']);
    expect(r.totalTokens).toBe(0);
  });
});
