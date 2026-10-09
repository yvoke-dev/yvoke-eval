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
    // 3 reviews = 2 re-prompts = exactly the cap. This asserted false while the cap was compared
    // against raw reviewer delegations; that is the arithmetic that failed Q1.
    expect(s.revisionRounds).toBe(2);
    expect(s.roundCapRespected).toBe(true);
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

  it('minReviewRoundsSatisfiable: false only past the reachable ceiling of cap + 1 reviews', () => {
    // minReviewRounds counts REVIEWS; maxReviewRounds budgets RE-PROMPTS. 2 re-prompts make 3
    // reviews reachable, so min=3 is satisfiable — it read as an impossible contract before.
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 3 }), mkTrace(), CAPS).minReviewRoundsSatisfiable).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 4 }), mkTrace(), CAPS).minReviewRoundsSatisfiable).toBe(false); // 4 > 2 + 1
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

/**
 * Delegation shape. Before these, `expected_delegation` was authored on the two questions that exist
 * to prove the parallel-pairing rule landed, was printed into the grader's prompt, and was compared
 * against nothing — the trace carried no concurrency evidence and the rubric covered only `none`.
 */
describe('extractOrchestrationSignals — delegation shape', () => {
  const spec = (id: string, name: string, order: number, batch: number) =>
    mkDelegation({ id, subagentType: name, order, batch });

  it('two specialists in ONE assistant message are parallel; one per message is sequential', () => {
    const together = mkTrace({
      delegations: [spec('d1', 'oim-ts-directory-messaging', 0, 3), spec('d2', 'oim-field-qa', 1, 3)],
      specialistCallCount: 2,
    });
    const apart = mkTrace({
      delegations: [spec('d1', 'oim-ts-directory-messaging', 0, 3), spec('d2', 'oim-field-qa', 1, 5)],
      specialistCallCount: 2,
    });
    expect(extractOrchestrationSignals(mkQuestion(), together, CAPS).delegationPattern).toBe('parallel');
    expect(extractOrchestrationSignals(mkQuestion(), together, CAPS).maxDelegationBatchWidth).toBe(2);
    expect(extractOrchestrationSignals(mkQuestion(), apart, CAPS).delegationPattern).toBe('sequential');
    expect(extractOrchestrationSignals(mkQuestion(), apart, CAPS).maxDelegationBatchWidth).toBe(1);
  });

  it('a fan-out followed by a later round is mixed, and still satisfies expected parallel', () => {
    const trace = mkTrace({
      delegations: [spec('d1', 'a', 0, 2), spec('d2', 'b', 1, 2), spec('d3', 'c', 2, 7)],
      specialistCallCount: 3,
    });
    const s = extractOrchestrationSignals(mkQuestion({ expectedDelegation: 'parallel' }), trace, CAPS);
    expect(s.delegationPattern).toBe('mixed');
    expect(s.maxDelegationBatchWidth).toBe(2);
    expect(s.expectedDelegationSatisfied).toBe(true);
  });

  it('the reviewer is excluded from the shape — a specialist + reviewer is single, not parallel', () => {
    const trace = mkTrace({
      delegations: [
        spec('d1', 'oim-field-qa', 0, 4),
        mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 1, batch: 4, verdict: 'APPROVED' }),
      ],
      reviewRounds: 1,
      specialistCallCount: 1,
    });
    expect(extractOrchestrationSignals(mkQuestion(), trace, CAPS).delegationPattern).toBe('single');
  });

  it('no delegations at all is none, and satisfies an expected none', () => {
    const s = extractOrchestrationSignals(mkQuestion({ expectedDelegation: 'none' }), mkTrace(), CAPS);
    expect(s.delegationPattern).toBe('none');
    expect(s.maxDelegationBatchWidth).toBe(0);
    expect(s.expectedDelegationSatisfied).toBe(true);
  });

  it('expectedDelegationSatisfied is false when the pairing went out one at a time', () => {
    const trace = mkTrace({
      delegations: [spec('d1', 'oim-ts-basics-sync', 0, 1), spec('d2', 'oim-field-qa', 1, 2)],
      specialistCallCount: 2,
    });
    expect(
      extractOrchestrationSignals(mkQuestion({ expectedDelegation: 'parallel' }), trace, CAPS)
        .expectedDelegationSatisfied,
    ).toBe(false);
  });

  it('expectedDelegationSatisfied is null when unset or an unknown token — NA, never a spurious FAIL', () => {
    const trace = mkTrace({ delegations: [spec('d1', 'a', 0, 0)], specialistCallCount: 1 });
    expect(extractOrchestrationSignals(mkQuestion(), trace, CAPS).expectedDelegationSatisfied).toBeNull();
    expect(
      extractOrchestrationSignals(mkQuestion({ expectedDelegation: 'fan-out' }), trace, CAPS)
        .expectedDelegationSatisfied,
    ).toBeNull();
  });
});

/**
 * Round-cap units. `maxReviewRounds` is the client's budget for runtime RE-prompts
 * (`nextReviewAction`: "out of rounds — ship it flagged"), and the orchestrator's first reviewer
 * call is not a re-prompt. Comparing raw reviewer delegations to that cap failed a run that sat
 * exactly on the client's budget — orchestration_ie.Q1, [REJECTED, REJECTED, APPROVED], which the
 * client would have delivered approved and unflagged.
 */
describe('extractOrchestrationSignals — the round cap is counted in revisions, not reviews', () => {
  const withReviews = (n: number) =>
    mkTrace({
      delegations: [
        mkDelegation({ id: 'd1', subagentType: 'oim-field-qa', order: 0, batch: 0 }),
        ...Array.from({ length: n }, (_, i) =>
          mkDelegation({ id: `r${i}`, subagentType: 'reviewer', isReviewer: true, order: i + 1, batch: i + 1 }),
        ),
      ],
      reviewRounds: n,
      specialistCallCount: 1,
    });

  it('three reviewer delegations are TWO revisions — exactly at a cap of 2, so respected', () => {
    const s = extractOrchestrationSignals(mkQuestion(), withReviews(3), CAPS);
    expect(s.reviewRounds).toBe(3);
    expect(s.revisionRounds).toBe(2);
    expect(s.roundCapRespected).toBe(true);
  });

  it('four still trips it — the cap stays fail-closed on a genuine overrun', () => {
    const s = extractOrchestrationSignals(mkQuestion(), withReviews(4), CAPS);
    expect(s.revisionRounds).toBe(3);
    expect(s.roundCapRespected).toBe(false);
  });

  it('a single review is zero revisions, and no reviewer at all is not negative', () => {
    expect(extractOrchestrationSignals(mkQuestion(), withReviews(1), CAPS).revisionRounds).toBe(0);
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace(), CAPS).revisionRounds).toBe(0);
    expect(extractOrchestrationSignals(mkQuestion(), mkTrace(), CAPS).roundCapRespected).toBe(true);
  });

  it('min_review_rounds stays counted in REVIEWS, and its ceiling is the cap plus one', () => {
    // Authored to assert validation happened at all, which the first review satisfies. Against a cap
    // of 2 re-prompts, 3 reviews are reachable — so min=3 is satisfiable, not an impossible contract.
    const s = extractOrchestrationSignals(mkQuestion({ minReviewRounds: 1 }), withReviews(1), CAPS);
    expect(s.minReviewRoundsSatisfied).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 3 }), withReviews(3), CAPS).minReviewRoundsSatisfiable).toBe(true);
    expect(extractOrchestrationSignals(mkQuestion({ minReviewRounds: 4 }), withReviews(3), CAPS).minReviewRoundsSatisfiable).toBe(false);
  });
});

/**
 * numTurns integrity. `terminatedAbnormally` compares numTurns against the turn ceiling, so an
 * under-report fails OPEN — a run truncated at the ceiling reads as a clean finish. Q2/Q3 of the
 * 3 Sep run reported num_turns: 1 while issuing 3 and 2 delegations from separate assistant
 * messages. Cause undetermined (the raw stream is not persisted); these assert only that the
 * contradiction is surfaced rather than silently trusted.
 */
describe('extractOrchestrationSignals — numTurns is checked against the delegating-turn count', () => {
  const threeAcrossThreeMessages = mkTrace({
    delegations: [
      mkDelegation({ id: 'd1', subagentType: 'oim-ts-basics-sync', order: 0, batch: 1 }),
      mkDelegation({ id: 'd2', subagentType: 'oim-field-qa', order: 1, batch: 2 }),
      mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 2, batch: 3 }),
    ],
    reviewRounds: 1,
    specialistCallCount: 2,
    numTurns: 1,
  });

  it('flags num_turns below the number of assistant messages that issued a delegation', () => {
    const s = extractOrchestrationSignals(mkQuestion(), threeAcrossThreeMessages, CAPS);
    expect(s.numTurns).toBe(1); // reported as-is; the extractor never invents a corrected value
    expect(s.numTurnsPlausible).toBe(false);
    expect(s.terminatedAbnormally).toBe(false); // still fails open — hence the flag
  });

  it('is plausible when num_turns is at least the delegating-turn count', () => {
    const s = extractOrchestrationSignals(
      mkQuestion(),
      mkTrace({ ...threeAcrossThreeMessages, numTurns: 3 }),
      CAPS,
    );
    expect(s.numTurnsPlausible).toBe(true);
  });

  it('counts delegating TURNS, not delegations — a parallel fan-out is one turn', () => {
    // Two delegations in one assistant message need only one turn, so num_turns: 1 is consistent.
    const s = extractOrchestrationSignals(
      mkQuestion(),
      mkTrace({
        delegations: [
          mkDelegation({ id: 'd1', subagentType: 'a', order: 0, batch: 0 }),
          mkDelegation({ id: 'd2', subagentType: 'b', order: 1, batch: 0 }),
        ],
        specialistCallCount: 2,
        numTurns: 1,
      }),
      CAPS,
    );
    expect(s.numTurnsPlausible).toBe(true);
  });

  it('an unknown num_turns is not called implausible', () => {
    expect(extractOrchestrationSignals(mkQuestion(), threeAcrossThreeMessages, CAPS).numTurns).toBe(1);
    const unknown = mkTrace({ ...threeAcrossThreeMessages, numTurns: undefined });
    expect(extractOrchestrationSignals(mkQuestion(), unknown, CAPS).numTurnsPlausible).toBe(true);
  });
});

/**
 * Review enforcement. The orchestrator skipped review entirely on 2 of 5 orchestration questions on
 * 3 Sep 2026. The client nudges once (`nextReviewAction` → `enforce`, "one attempt per turn; never
 * loop") and then delivers regardless, so the production question is whether it complies when
 * nudged — which a single-turn harness could not ask. These assert the three states are separable.
 */
describe('extractOrchestrationSignals — volunteered vs enforced review', () => {
  const withReview = (n: number, reviewEnforced?: boolean) =>
    mkTrace({
      delegations: [
        mkDelegation({ id: 'd1', subagentType: 'oim-field-qa', order: 0, batch: 0 }),
        ...Array.from({ length: n }, (_, i) =>
          mkDelegation({ id: `r${i}`, subagentType: 'reviewer', isReviewer: true, order: i + 1, batch: i + 1 }),
        ),
      ],
      reviewRounds: n,
      specialistCallCount: 1,
      ...(reviewEnforced === undefined ? {} : { reviewEnforced }),
    });

  it('a volunteered review is neither enforced nor skipped', () => {
    const s = extractOrchestrationSignals(mkQuestion(), withReview(1), CAPS);
    expect(s.reviewInvoked).toBe(true);
    expect(s.reviewEnforced).toBe(false);
    expect(s.reviewSkippedDespiteEnforcement).toBe(false);
  });

  it('a review that only happened after the nudge is flagged, though review_invoked is still true', () => {
    // The distinction the grader needs: reviewRounds=1 alone cannot tell these two apart.
    const s = extractOrchestrationSignals(mkQuestion(), withReview(1, true), CAPS);
    expect(s.reviewInvoked).toBe(true);
    expect(s.reviewEnforced).toBe(true);
    expect(s.reviewSkippedDespiteEnforcement).toBe(false);
  });

  it('nudged and STILL not reviewed is the case that ships unreviewed', () => {
    const s = extractOrchestrationSignals(mkQuestion(), withReview(0, true), CAPS);
    expect(s.reviewInvoked).toBe(false);
    expect(s.reviewSkippedDespiteEnforcement).toBe(true);
  });

  it('an unenforced run with no review is not reported as skipped-despite-enforcement', () => {
    // e.g. a clarify or refusal, where there was no composed answer worth reviewing.
    const s = extractOrchestrationSignals(mkQuestion(), mkTrace(), CAPS);
    expect(s.reviewEnforced).toBe(false);
    expect(s.reviewSkippedDespiteEnforcement).toBe(false);
  });
});
