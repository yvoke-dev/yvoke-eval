// Core eval records. Field names and order mirror the Java records in
import type { OrchestrationTrace } from './agent/OrchestrationTrace';

// de.palsoftware.yvoke.eval so the results.json / run_meta.json artifact schema stays compatible
// with the existing baseline (the content repo's graders/ + eval/baseline/).

/**
 * An expected, actionable error: bad arguments, missing config, nothing matched. The CLI prints its
 * message alone, since a stack trace here is noise that buries the part the reader must act on.
 * Anything else keeps its stack — a stack is the point when the fault is ours.
 */
export class UserError extends Error {
  override readonly name = 'UserError';
}

export type Expect = 'answer' | 'clarify' | 'redirect' | 'refuse';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export type VerdictValue = 'PASS' | 'PARTIAL' | 'FAIL' | 'ERROR';

/** One eval question: prose from eval_<category>.md merged with its spec from eval_specs.yaml. */
export interface EvalQuestion {
  category: string;
  id: string;
  question: string;
  playbook: string | null;
  expect: string; // Expect, kept lenient to mirror the Java parse
  /** Product version this question is scoped to, from the spec's `version_tag`. Null when unset —
   *  there is no sensible default, since versioning schemes are per knowledge base. */
  versionTag: string | null;
  targetTopic: string | null;
  mustInclude: string[];
  mustNotInclude: string[];
  expectToolCalled: string[];
  bait: string | null;
  citationsRequired: boolean;
  critical: boolean;
  rubric: string | null;
  // Orchestration-eval (Mode 3) expectations — OPTIONAL, opt-in per question. Absent for specialist /
  // MAS eval; the parser omits absent keys so a non-opt-in question's serialized shape is unchanged.
  expectedSpecialists?: string[];
  expectedDelegation?: string | null;
  minReviewRounds?: number | null;
}

/** Deterministic, LLM-free facts extracted from an answer run. */
export interface Signals {
  toolsFired: string[];
  searchCollections: string[];
  retrievedCollections: string[];
  retrievedChunkCount: number;
  mustIncludeMissing: string[];
  mustNotIncludePresent: string[];
  /**
   * Tools the question's spec required that never fired.
   *
   * `expect_tool_called` was parsed into the question and then used by nothing — no signal, no line
   * in the judge's message, no check. Every assertion written with it was silently vacuous, which is
   * how questions demanding `WebSearch` or `get_section` passed without either being called.
   */
  expectedToolsMissing: string[];
  hasCitations: boolean;
}

/**
 * Deterministic, LLM-free facts about the ORCHESTRATION PROCESS of a mas run (Mode 3), derived from
 * the delegation trace. Parallel to Signals — never replaces it. Only populated on the orchestration
 * eval path; specialist / MAS eval leave it undefined.
 */
export interface OrchestrationSignals {
  /** Distinct non-reviewer subagent_types the orchestrator delegated to. */
  delegatedSpecialists: string[];
  /** Number of specialist (non-reviewer) delegations. */
  delegationCount: number;
  /** Number of reviewer delegations (review rounds run). */
  reviewRounds: number;
  /**
   * Reviewer delegations MINUS the first — the client's unit for `maxReviewRounds`.
   *
   * The client budgets *revision* rounds: the orchestrator reviews once, ends its turn, and the
   * runtime re-prompts it with the feedback while `revisionRounds < maxReviewRounds`
   * (yvoke-desktop `nextReviewAction`). So N reviewer delegations ending in APPROVED is N-1
   * revisions, and the initial review is not one. Comparing raw `reviewRounds` to the cap graded a
   * run that sat exactly ON the client's budget as having blown through it.
   */
  revisionRounds: number;
  /** Reviewer verdicts in order, for the rounds whose verdict was readable. */
  reviewerVerdicts: ('APPROVED' | 'REJECTED')[];
  /** Reviewer delegations whose verdict could not be parsed (ran, but verdict unreadable). */
  reviewerVerdictsUnparsed: number;
  /** reviewRounds > 0. */
  reviewInvoked: boolean;
  /**
   * The run ended with specialists consulted and no reviewer, and the harness nudged it — the
   * client's one-shot `enforce`. Changes how `reviewRounds` reads: 1 review WITH this set means the
   * orchestrator did not review on its own initiative.
   */
  reviewEnforced: boolean;
  /**
   * Nudged and still never reviewed. This is the case that reaches a real user unreviewed, because
   * the client enforces once and then delivers whatever comes back.
   */
  reviewSkippedDespiteEnforcement: boolean;
  /** The orchestrator called ask_clarifying_question at least once. */
  clarifyRequested: boolean;
  /** true if every expectedSpecialist was delegated to; false on a miss; null when unauthored (→ NA). */
  delegatedToExpectedSpecialist: boolean | null;
  /** Delegated specialists not in expectedSpecialists — [] when expectedSpecialists is unset. */
  unexpectedSpecialists: string[];
  /** Duplicate specialist delegations beyond the first per subagent_type (non-reviewer only). */
  redundantDelegations: number;
  /**
   * Observed shape of the SPECIALIST fan-out, from which assistant message each delegation arrived in:
   * `none` (0 calls) · `single` (1) · `parallel` (all in one message) · `sequential` (each in its own)
   * · `mixed` (some fan-out plus later rounds).
   */
  delegationPattern: 'none' | 'single' | 'parallel' | 'sequential' | 'mixed';
  /** Most specialist delegations issued in a single assistant message — the widest fan-out observed. */
  maxDelegationBatchWidth: number;
  /** question.expectedDelegation met: null when unset, else compared against delegationPattern. */
  expectedDelegationSatisfied: boolean | null;
  /** revisionRounds <= the configured maxReviewRounds cap — like compared with like. */
  roundCapRespected: boolean;
  /** num_turns of the run, or null when unknown. */
  numTurns: number | null;
  /**
   * Whether `numTurns` is consistent with what the stream directly shows.
   *
   * Every delegation was issued from a main-thread assistant message, so the number of DISTINCT
   * assistant messages that issued one is a hard lower bound on the run's turns. `numTurns` below
   * that bound is self-contradictory and the signal cannot be trusted — measured 3 Sep 2026 on
   * orchestration_ie Q2/Q3, which reported `num_turns: 1` while issuing three and two delegations
   * across separate messages (their `output_tokens` agreed with the low count, so the two SDK
   * numbers are consistent with each other and inconsistent with the trace; the raw stream is not
   * persisted, so the cause is undetermined).
   *
   * This matters because `terminatedAbnormally` compares `numTurns` against the turn ceiling: an
   * under-report fails OPEN, so a run truncated at the ceiling would be graded a clean finish. The
   * flag does not guess at a corrected value — it tells the grader not to read clean termination
   * out of a number that is demonstrably wrong.
   */
  numTurnsPlausible: boolean;
  /** The run errored (is_error) or hit the orchestrator turn ceiling — truncated, not a clean finish. */
  terminatedAbnormally: boolean;
  /** question.minReviewRounds met: null when unset, else reviewRounds >= minReviewRounds. */
  minReviewRoundsSatisfied: boolean | null;
  /** false when minReviewRounds exceeds the runtime cap (impossible contract → grade NA, not FAIL). */
  minReviewRoundsSatisfiable: boolean;
}

/** The grader's structured judgement for one question. */
export interface Verdict {
  verdict: VerdictValue | string;
  dimensions: Record<string, string>;
  reasoning: string;
  evidence: string[];
}

export function errorVerdict(reason: string): Verdict {
  return { verdict: 'ERROR', dimensions: {}, reasoning: reason, evidence: [] };
}

/** One fully-graded question: question, produced answer, signals, verdict, tokens, timing. */
export interface EvalResult {
  question: EvalQuestion;
  answer: string | null;
  signals: Signals;
  verdict: Verdict;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  error: string | null;
  // Orchestration eval (Mode 3) — OPTIONAL, present only on the orchestration path. Appended so the
  // specialist / MAS results.json shape is unchanged (absent → omitted by JSON.stringify).
  orchestrationSignals?: OrchestrationSignals;
  orchestrationVerdict?: Verdict;
  /**
   * The raw delegation trace the grader was shown — every delegation with its prompt, its returned
   * text and (for reviewers) the parsed verdict.
   *
   * Persisted because the derived signals are lossy in exactly the place that needs explaining: a
   * `reviewer_verdicts_unparsed: 1` says the reviewer's first line was not APPROVED/REJECTED but not
   * what it *was*, so there is no way to tell a reviewer breaking its contract from
   * `orchestrationCapture` resolving the wrong text — two different bugs with two different fixes.
   * That happened on Q2 and Q3 of the 3 Sep run and could not be diagnosed at any price short of
   * re-running mas questions, which is the expensive thing this record exists to avoid.
   *
   * Written on the error branch too: a run that failed grading is precisely one whose trace matters.
   */
  orchestration?: OrchestrationTrace;
}
