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
    expect(r.retrievedChunkIds).toEqual(GOOD_ANSWER.bundle.retrievedChunkIds);
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

  it('never throws — a judge failure yields an ERROR verdict without echoing must_include', async () => {
    const throwingJudge: Judge = {
      async review() {
        throw new Error('judge exploded');
      },
    };
    const q = mkQuestion({ mustInclude: ['Manager', 'Designer'] });
    const r = await gradeOne(q, mkBundle({ answer: 'x', retrievedChunkIds: ['err-chunk-1'] }), throwingJudge, 5);
    expect(r.verdict.verdict).toBe('ERROR');
    expect(r.error).toContain('judge exploded');
    expect(r.signals.mustIncludeMissing).toEqual([]);
    expect(r.totalTokens).toBe(0);
    expect(r.retrievedChunkIds).toEqual(['err-chunk-1']);
  });

  it('preserves judge ERROR verdict on critical question without overwriting to FAIL', async () => {
    const errorJudge: Judge = {
      async review() {
        return { verdict: 'ERROR', dimensions: {}, reasoning: 'quota limit reached', evidence: [] };
      },
    };
    const q = mkQuestion({ critical: true, mustInclude: ['MustBePresent'] });
    const r = await gradeOne(q, mkBundle({ answer: 'nothing here' }), errorJudge, 5);
    expect(r.verdict.verdict).toBe('ERROR');
    expect(r.error).toBe('quota limit reached');
  });

  it('omits webConversationId and webMessageId on SDK bundles and preserves them on web bundles (normal & error paths)', async () => {
    const sdkRes = await gradeOne(GOOD_ANSWER.question, GOOD_ANSWER.bundle, passJudge, 100);
    expect('webConversationId' in sdkRes).toBe(false);
    expect('webMessageId' in sdkRes).toBe(false);

    const webBundle = mkBundle({
      answer: GOOD_ANSWER.bundle.answer,
      providerMeta: {
        conversationId: 'conv-uuid-123',
        messageId: 'msg-uuid-456',
      },
    });
    const webRes = await gradeOne(GOOD_ANSWER.question, webBundle, passJudge, 100);
    expect(webRes.webConversationId).toBe('conv-uuid-123');
    expect(webRes.webMessageId).toBe('msg-uuid-456');

    const throwingJudge: Judge = {
      async review() {
        throw new Error('judge boom');
      },
    };
    const webErrRes = await gradeOne(GOOD_ANSWER.question, webBundle, throwingJudge, 50);
    expect(webErrRes.verdict.verdict).toBe('ERROR');
    expect(webErrRes.webConversationId).toBe('conv-uuid-123');
    expect(webErrRes.webMessageId).toBe('msg-uuid-456');
  });
});
