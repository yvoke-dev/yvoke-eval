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
    const r = await gradeOrchestration(mkQuestion(), mkBundle({ answer: 'x' }), throwing, 5, CAPS);
    expect(r.verdict.verdict).toBe('ERROR');
    expect(r.error).toContain('orch judge exploded');
    expect(r.signals.mustNotIncludePresent).toEqual([]);
    expect(r.totalTokens).toBe(0);
  });
});
