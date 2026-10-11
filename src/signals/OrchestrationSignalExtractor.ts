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

  // The client's `maxReviewRounds` budgets RE-prompts, not reviews: the first review is not a
  // revision. See OrchestrationSignals.revisionRounds.
  const revisionRounds = Math.max(0, trace.reviewRounds - 1);

  // Distinct assistant messages that issued a delegation — a directly-observed lower bound on the
  // run's main-thread turns. See OrchestrationSignals.numTurnsPlausible.
  const delegatingTurns = new Set(trace.delegations.map((d) => d.batch)).size;

  const { pattern: delegationPattern, maxWidth: maxDelegationBatchWidth } = delegationShape(nonReviewer);
  const expectedDelegationSatisfied = matchesExpectedDelegation(
    question.expectedDelegation ?? null,
    delegationPattern,
  );

  return {
    delegatedSpecialists,
    delegationCount: trace.specialistCallCount,
    reviewRounds: trace.reviewRounds,
    reviewerVerdicts,
    reviewerVerdictsUnparsed: reviewers.length - reviewerVerdicts.length,
    reviewInvoked: trace.reviewRounds > 0,
    reviewEnforced: trace.reviewEnforced === true,
    reviewSkippedDespiteEnforcement: trace.reviewEnforced === true && trace.reviewRounds === 0,
    clarifyRequested: trace.clarifyRequested,
    delegatedToExpectedSpecialist,
    unexpectedSpecialists,
    // duplicate specialist delegations beyond the first per subagent_type (non-reviewer only)
    redundantDelegations: nonReviewer.length - delegatedSpecialists.length,
    delegationPattern,
    maxDelegationBatchWidth,
    expectedDelegationSatisfied,
    revisionRounds,
    roundCapRespected: revisionRounds <= maxReviewRounds,
    numTurns,
    numTurnsPlausible: numTurns == null || numTurns >= delegatingTurns,
    terminatedAbnormally:
      trace.isError === true || (numTurns != null && orchestratorMaxTurns > 0 && numTurns >= orchestratorMaxTurns),
    // Deliberately still counted in REVIEWS, not revisions: `min_review_rounds` is authored to assert
    // that validation happened at all (Q5: "it must pass review"), which the first review satisfies.
    minReviewRoundsSatisfied: minReviewRounds == null ? null : trace.reviewRounds >= minReviewRounds,
    // …which is why the reachable ceiling is one MORE than the revision budget: maxReviewRounds
    // re-prompts allow maxReviewRounds + 1 reviews. Comparing against the bare cap called a
    // perfectly reachable minimum impossible and emitted NA.
    minReviewRoundsSatisfiable: minReviewRounds == null ? true : minReviewRounds <= maxReviewRounds + 1,
  };
}

function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Sequential or parallel, decided mechanically: delegations issued as parallel tool_use blocks of ONE
 * assistant message share a `batch`. Nothing else in the stream distinguishes the two, which is why
 * `expected_delegation` was inert before this — the grader was handed the expectation with no observed
 * value to compare it against, and its rubric only ever covered `none`.
 */
function delegationShape(nonReviewer: { batch: number }[]): {
  pattern: OrchestrationSignals['delegationPattern'];
  maxWidth: number;
} {
  if (nonReviewer.length === 0) return { pattern: 'none', maxWidth: 0 };
  if (nonReviewer.length === 1) return { pattern: 'single', maxWidth: 1 };
  const widths = new Map<number, number>();
  for (const d of nonReviewer) widths.set(d.batch, (widths.get(d.batch) ?? 0) + 1);
  const maxWidth = Math.max(...widths.values());
  if (widths.size === 1) return { pattern: 'parallel', maxWidth };
  return { pattern: maxWidth > 1 ? 'mixed' : 'sequential', maxWidth };
}

/**
 * `parallel` is satisfied by a genuine fan-out even when later rounds follow (`mixed`) — the authored
 * expectation is "these went out together", not "the orchestrator delegated exactly once". `sequential`
 * is deliberately strict: a fan-out is not a sequence.
 */
function matchesExpectedDelegation(
  expected: string | null,
  pattern: OrchestrationSignals['delegationPattern'],
): boolean | null {
  if (expected == null) return null;
  switch (expected) {
    case 'none':
      return pattern === 'none';
    case 'parallel':
      return pattern === 'parallel' || pattern === 'mixed';
    case 'sequential':
      return pattern === 'sequential';
    default:
      return null; // unknown token — NA rather than a spurious FAIL
  }
}
