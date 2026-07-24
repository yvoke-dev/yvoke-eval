// Core eval records. Field names and order mirror the Java records in
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
  /** Reviewer verdicts in order, for the rounds whose verdict was readable. */
  reviewerVerdicts: ('APPROVED' | 'REJECTED')[];
  /** Reviewer delegations whose verdict could not be parsed (ran, but verdict unreadable). */
  reviewerVerdictsUnparsed: number;
  /** reviewRounds > 0. */
  reviewInvoked: boolean;
  /** The orchestrator called ask_clarifying_question at least once. */
  clarifyRequested: boolean;
  /** true if every expectedSpecialist was delegated to; false on a miss; null when unauthored (→ NA). */
  delegatedToExpectedSpecialist: boolean | null;
  /** Delegated specialists not in expectedSpecialists — [] when expectedSpecialists is unset. */
  unexpectedSpecialists: string[];
  /** Duplicate specialist delegations beyond the first per subagent_type (non-reviewer only). */
  redundantDelegations: number;
  /** reviewRounds <= the configured maxReviewRounds cap. */
  roundCapRespected: boolean;
  /** num_turns of the run, or null when unknown. */
  numTurns: number | null;
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
}
