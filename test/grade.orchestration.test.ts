import { describe, it, expect } from 'vitest';
import { gradeOrchestration } from '../src/run/grade';
import type { OrchestrationJudge } from '../src/reviewer/OrchestrationJudge';
import type { Verdict } from '../src/types';
import { mkQuestion, mkBundle, mkTrace, mkDelegation } from './fixtures';

const passJudge: OrchestrationJudge = {
  async review({ orchestrationSignals }) {
    const verdict: Verdict['verdict'] = orchestrationSignals.roundCapRespected ? 'PASS' : 'FAIL';
    return { verdict, dimensions: { delegation_routing: 'PASS' }, reasoning: 'fake', evidence: [] };
  },
};

const CAPS = { maxReviewRounds: 2, orchestratorMaxTurns: 60 };

describe('gradeOrchestration', () => {
  it('assembles an EvalResult with orchestrationSignals + orchestrationVerdict AND a degenerate signals', async () => {
    const bundle = mkBundle({
      answer: 'The clients are Manager and Designer [1].',
      retrievedChunkIds: ['orch-chunk-1'],
      promptTokens: 8000,
      completionTokens: 1200,
      totalTokens: 9200,
      orchestration: mkTrace({
        delegations: [
          mkDelegation({ id: 'd1', subagentType: 'oim-getting-started', order: 0 }),
          mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 1, verdict: 'APPROVED' }),
        ],
        reviewRounds: 1,
        specialistCallCount: 1,
      }),
    });
    const r = await gradeOrchestration(mkQuestion({ expectedSpecialists: ['oim-getting-started'] }), bundle, passJudge, 999, CAPS);

    expect(r.verdict.verdict).toBe('PASS');
    expect(r.orchestrationVerdict?.verdict).toBe('PASS');
    expect(r.orchestrationSignals?.delegatedSpecialists).toEqual(['oim-getting-started']);
    expect(r.orchestrationSignals?.delegatedToExpectedSpecialist).toBe(true);
    // degenerate answer-signals so compare/promote's effectiveVerdict never throws
    expect(r.signals.mustNotIncludePresent).toEqual([]);
    expect(r.signals.retrievedChunkCount).toBe(0);
    expect(r.retrievedChunkIds).toEqual(['orch-chunk-1']);
    expect(r.promptTokens).toBe(8000);
    expect(r.latencyMs).toBe(999);
    expect(r.error).toBeNull();
  });

  it('handles a missing trace (bundle.orchestration undefined) via the empty trace', async () => {
    const r = await gradeOrchestration(mkQuestion(), mkBundle({ answer: 'x' }), passJudge, 1, CAPS);
    expect(r.orchestrationSignals?.delegationCount).toBe(0);
    expect(r.verdict.verdict).toBe('PASS'); // empty trace: roundCapRespected true
  });

  it('never throws — a judge failure yields an ERROR verdict with a degenerate signals', async () => {
    const throwing: OrchestrationJudge = {
      async review() {
        throw new Error('orch judge exploded');
      },
    };
    const r = await gradeOrchestration(mkQuestion(), mkBundle({ answer: 'x', retrievedChunkIds: ['orch-err-chunk-1'] }), throwing, 5, CAPS);
    expect(r.verdict.verdict).toBe('ERROR');
    expect(r.error).toContain('orch judge exploded');
    expect(r.signals.mustNotIncludePresent).toEqual([]);
    expect(r.totalTokens).toBe(0);
    expect(r.retrievedChunkIds).toEqual(['orch-err-chunk-1']);
  });
});

/**
 * Trace persistence. The derived signals cannot distinguish a reviewer that broke its first-line
 * contract from a capture that resolved the wrong text — `reviewer_verdicts_unparsed: 1` says only
 * that the verdict was unreadable. Q2/Q3 of the 3 Sep run hit exactly that and were undiagnosable
 * because the record kept the signals and dropped the trace.
 */
describe('gradeOrchestration — persists the trace the grader was shown', () => {
  const traceWithUnparsedVerdict = mkTrace({
    delegations: [
      mkDelegation({ id: 'd1', subagentType: 'oim-field-qa', order: 0, resultText: 'field answer' }),
      mkDelegation({
        id: 'r1',
        subagentType: 'reviewer',
        isReviewer: true,
        order: 1,
        // No `verdict`: this is the shape that produced reviewer_verdicts_unparsed=1, and the text
        // below is the whole point of persisting — it is what names the cause.
        resultText: 'I reviewed the answer and it looks well supported.\nAPPROVED',
      }),
    ],
    reviewRounds: 1,
    specialistCallCount: 1,
  });

  it('keeps every delegation with its returned text, so an unparsed verdict can be explained', async () => {
    const r = await gradeOrchestration(
      mkQuestion(),
      mkBundle({ answer: 'x', orchestration: traceWithUnparsedVerdict }),
      passJudge,
      1,
      CAPS,
    );
    expect(r.orchestrationSignals?.reviewerVerdictsUnparsed).toBe(1);
    const reviewer = r.orchestration?.delegations.find((d) => d.isReviewer);
    expect(reviewer?.verdict).toBeUndefined();
    // The diagnosis the signals alone cannot give: the verdict was on line 2, not line 1.
    expect(reviewer?.resultText).toContain('APPROVED');
    expect(r.orchestration?.delegations).toHaveLength(2);
  });

  it('persists the trace on the ERROR branch too — a failed grading is when it matters most', async () => {
    const throwing: OrchestrationJudge = {
      async review() {
        throw new Error('boom');
      },
    };
    const r = await gradeOrchestration(
      mkQuestion(),
      mkBundle({ answer: 'x', orchestration: traceWithUnparsedVerdict }),
      throwing,
      1,
      CAPS,
    );
    expect(r.verdict.verdict).toBe('ERROR');
    expect(r.orchestration?.delegations).toHaveLength(2);
  });

  it('survives a JSON round-trip, which is how it reaches results.json', async () => {
    const r = await gradeOrchestration(
      mkQuestion(),
      mkBundle({ answer: 'x', orchestration: traceWithUnparsedVerdict }),
      passJudge,
      1,
      CAPS,
    );
    const back = JSON.parse(JSON.stringify(r));
    expect(back.orchestration.delegations[1].resultText).toContain('APPROVED');
    expect(back.orchestration.reviewRounds).toBe(1);
  });
});
