import type { EvalQuestion, OrchestrationSignals } from '../types';
import type { OrchestrationTrace } from '../agent/OrchestrationTrace';

/** The runtime coordination budgets (cfg.mas.tuning), plumbed in from runSuite — NOT read from the
 *  question — so cap/ceiling checks reflect the orchestrator's actual limits. */
export interface OrchestrationCaps {
  maxReviewRounds: number;
  orchestratorMaxTurns: number;
}

/**
 * Deterministic, LLM-free facts about the orchestration PROCESS (Mode 3), derived from the delegation
 * trace + the question's authored expectations. Parallel to SignalExtractor; never touches Signals.
 *
 * Fail-closed: an unauthored `expectedSpecialists` yields `delegatedToExpectedSpecialist = null` (→ the
 * routing dimension emits NA), never a vacuous PASS. `min_review_rounds` satisfaction is computed here
 * (not left to the LLM), and an impossible `minReviewRounds > maxReviewRounds` contract is flagged
 * (`minReviewRoundsSatisfiable=false`) so the grader can emit NA instead of a spurious FAIL.
 */
export function extractOrchestrationSignals(
  question: EvalQuestion,
  trace: OrchestrationTrace,
  caps: OrchestrationCaps,
): OrchestrationSignals {
  const { maxReviewRounds, orchestratorMaxTurns } = caps;
  const nonReviewer = trace.delegations.filter((d) => !d.isReviewer);
  const reviewers = trace.delegations.filter((d) => d.isReviewer);

  const delegatedSpecialists = distinct(nonReviewer.map((d) => d.subagentType));

  const reviewerVerdicts = reviewers
    .map((d) => d.verdict)
    .filter((v): v is 'APPROVED' | 'REJECTED' => v === 'APPROVED' || v === 'REJECTED');

  const expected = question.expectedSpecialists;
  const hasExpected = Array.isArray(expected) && expected.length > 0;
  const delegatedToExpectedSpecialist = hasExpected
    ? expected.every((s) => delegatedSpecialists.includes(s))
    : null;
  const unexpectedSpecialists = hasExpected
    ? delegatedSpecialists.filter((s) => !expected.includes(s))
    : [];

  const minReviewRounds = question.minReviewRounds ?? null;
  const numTurns = trace.numTurns ?? null;

  return {
    delegatedSpecialists,
    delegationCount: trace.specialistCallCount,
    reviewRounds: trace.reviewRounds,
    reviewerVerdicts,
    reviewerVerdictsUnparsed: reviewers.length - reviewerVerdicts.length,
    reviewInvoked: trace.reviewRounds > 0,
    clarifyRequested: trace.clarifyRequested,
    delegatedToExpectedSpecialist,
    unexpectedSpecialists,
    // duplicate specialist delegations beyond the first per subagent_type (non-reviewer only)
    redundantDelegations: nonReviewer.length - delegatedSpecialists.length,
    roundCapRespected: trace.reviewRounds <= maxReviewRounds,
    numTurns,
    terminatedAbnormally:
      trace.isError === true || (numTurns != null && orchestratorMaxTurns > 0 && numTurns >= orchestratorMaxTurns),
    minReviewRoundsSatisfied: minReviewRounds == null ? null : trace.reviewRounds >= minReviewRounds,
    minReviewRoundsSatisfiable: minReviewRounds == null ? true : minReviewRounds <= maxReviewRounds,
  };
}

function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
