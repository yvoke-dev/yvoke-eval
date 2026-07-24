import { describe, it, expect } from 'vitest';
import { extractOrchestrationSignals } from '../src/signals/OrchestrationSignalExtractor';
import { mkQuestion, mkTrace, mkDelegation } from './fixtures';

const CAPS = { maxReviewRounds: 2, orchestratorMaxTurns: 60 };

describe('extractOrchestrationSignals', () => {
  it('lists distinct non-reviewer specialists and excludes the reviewer', () => {
    const trace = mkTrace({
      delegations: [
        mkDelegation({ id: 'd1', subagentType: 'oim-getting-started', order: 0 }),
        mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 1, verdict: 'APPROVED' }),
      ],
      reviewRounds: 1,
      specialistCallCount: 1,
    });
    const s = extractOrchestrationSignals(mkQuestion(), trace, CAPS);
    expect(s.delegatedSpecialists).toEqual(['oim-getting-started']);
    expect(s.delegationCount).toBe(1);
    expect(s.reviewRounds).toBe(1);
    expect(s.reviewInvoked).toBe(true);
  });

  it('delegatedToExpectedSpecialist: true on subset, false on miss, null when unauthored/empty', () => {
    const trace = mkTrace({ delegations: [mkDelegation({ subagentType: 'oim-getting-started' })], specialistCallCount: 1 });
    expect(extractOrchestrationSignals(mkQuestion({ expectedSpecialists: ['oim-getting-started'] }), trace, CAPS).delegatedToExpectedSpecialist).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion({ expectedSpecialists: ['oim-access-governance'] }), trace, CAPS).delegatedToExpectedSpecialist).toBe(false);
    expect(extractOrchestrationSignals(mkQuestion(), trace, CAPS).delegatedToExpectedSpecialist).toBeNull();
    expect(extractOrchestrationSignals(mkQuestion({ expectedSpecialists: [] }), trace, CAPS).delegatedToExpectedSpecialist).toBeNull();
  });

  it('computes unexpectedSpecialists only when expected is authored', () => {
    const trace = mkTrace({
      delegations: [mkDelegation({ subagentType: 'oim-getting-started' }), mkDelegation({ id: 'd2', subagentType: 'oim-developer-api', order: 1 })],
      specialistCallCount: 2,
    });
    expect(extractOrchestrationSignals(mkQuestion({ expectedSpecialists: ['oim-getting-started'] }), trace, CAPS).unexpectedSpecialists).toEqual(['oim-developer-api']);
    expect(extractOrchestrationSignals(mkQuestion(), trace, CAPS).unexpectedSpecialists).toEqual([]);
  });

  it('reviewerVerdicts in order; reviewerVerdictsUnparsed counts unreadable rounds; cap uses the arg', () => {
    const trace = mkTrace({
      delegations: [
        mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 0, verdict: 'REJECTED' }),
        mkDelegation({ id: 'r2', subagentType: 'reviewer', isReviewer: true, order: 1 }), // unparsed
        mkDelegation({ id: 'r3', subagentType: 'reviewer', isReviewer: true, order: 2, verdict: 'APPROVED' }),
      ],
      reviewRounds: 3,
      specialistCallCount: 0,
    });
    const s = extractOrchestrationSignals(mkQuestion(), trace, CAPS);
    expect(s.reviewerVerdicts).toEqual(['REJECTED', 'APPROVED']);
    expect(s.reviewerVerdictsUnparsed).toBe(1);
    expect(s.roundCapRespected).toBe(false); // 3 > maxReviewRounds 2
  });

  it('terminatedAbnormally: true on an errored run OR when numTurns hits the orchestrator ceiling', () => {
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace({ isError: true }), CAPS).terminatedAbnormally).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace({ numTurns: 60 }), CAPS).terminatedAbnormally).toBe(true);
    const clean = extractOrchestrationSignals(mkQuestion(), mkTrace({ numTurns: 6 }), CAPS);
    expect(clean.terminatedAbnormally).toBe(false);
    expect(clean.numTurns).toBe(6);
  });

  it('minReviewRoundsSatisfied: null when unset, true when met, false when short of the minimum', () => {
    const oneRound = mkTrace({ delegations: [mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, verdict: 'APPROVED' })], reviewRounds: 1 });
    expect(extractOrchestrationSignals(mkQuestion(), oneRound, CAPS).minReviewRoundsSatisfied).toBeNull();
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 1 }), oneRound, CAPS).minReviewRoundsSatisfied).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 2 }), oneRound, CAPS).minReviewRoundsSatisfied).toBe(false);
  });

  it('minReviewRoundsSatisfiable: false when the required minimum exceeds the round cap', () => {
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 3 }), mkTrace(), CAPS).minReviewRoundsSatisfiable).toBe(false); // 3 > cap 2
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 2 }), mkTrace(), CAPS).minReviewRoundsSatisfiable).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace(), CAPS).minReviewRoundsSatisfiable).toBe(true); // unset ⇒ satisfiable
  });

  it('redundantDelegations counts duplicate specialists (non-reviewer only)', () => {
    const trace = mkTrace({
      delegations: [
        mkDelegation({ id: 'd1', subagentType: 'oim-getting-started', order: 0 }),
        mkDelegation({ id: 'd2', subagentType: 'oim-getting-started', order: 1 }),
        mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 2, verdict: 'APPROVED' }),
      ],
      reviewRounds: 1,
      specialistCallCount: 2,
    });
    const s = extractOrchestrationSignals(mkQuestion(), trace, CAPS);
    expect(s.delegatedSpecialists).toEqual(['oim-getting-started']);
    expect(s.redundantDelegations).toBe(1);
  });

  it('reflects clarifyRequested from the trace', () => {
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace({ clarifyRequested: true }), CAPS).clarifyRequested).toBe(true);
  });

  it('empty trace ⇒ all-empty / false / null', () => {
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace(), CAPS)).toMatchObject({
      delegatedSpecialists: [],
      delegationCount: 0,
      reviewRounds: 0,
      reviewerVerdicts: [],
      reviewerVerdictsUnparsed: 0,
      reviewInvoked: false,
      clarifyRequested: false,
      delegatedToExpectedSpecialist: null,
      unexpectedSpecialists: [],
      redundantDelegations: 0,
      roundCapRespected: true,
      numTurns: null,
      terminatedAbnormally: false,
      minReviewRoundsSatisfied: null,
      minReviewRoundsSatisfiable: true,
    });
  });
});
