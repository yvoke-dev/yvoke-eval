/**
 * Delegation trace of a multi-agent (mas) run — the coordination structure that `capture.ts`
 * (answer-quality capture) deliberately discards. Populated by `orchestrationCapture.ts` from the
 * SAME StreamMessage[] and consumed by orchestration eval (Mode 3). Additive: it never touches the
 * AnswerBundle answer/tool/chunk fields used by specialist + MAS eval.
 *
 * Topology note: in the current single-tier orchestrator, ONLY the orchestrator holds the delegation
 * tool (see orchestration.ts — specialists/reviewer are not granted `Task`), so every delegation is
 * issued from the main thread and `parentId` is always undefined. The field is retained for a possible
 * future nested topology, not because the system emits it today.
 *
 * ⚠️ The stream-shape assumptions this is built on (delegation tool_use name, input.subagent_type /
 * input.prompt, reviewer verdict as the first APPROVED/REJECTED line) are grounded in orchestration.ts
 * + the SDK Task schema but NOT yet verified against a recorded real trace — see
 * docs/orchestration-eval-design.md §9.
 */
export interface DelegationInvocation {
  /** The delegation tool_use id (sub-agent messages link back via parent_tool_use_id === this). */
  id: string;
  /** Target agent key = the SDK subagent_type: a specialist playbook name or REVIEWER_SUBAGENT. */
  subagentType: string;
  /** The self-contained task the orchestrator handed the sub-agent (input.prompt), when present. */
  prompt?: string;
  /** Stream-arrival index among all delegations (0-based). Approximates round ordering. */
  order: number;
  /** Always undefined in the single-tier topology (see file note); future-proofing only. */
  parentId?: string;
  /** subagentType === REVIEWER_SUBAGENT. */
  isReviewer: boolean;
  /** The sub-agent's final returned text (main-thread Task tool_result, else last forwarded text). */
  resultText?: string;
  /** For reviewer delegations: the parsed first-line verdict, when readable. */
  verdict?: 'APPROVED' | 'REJECTED';
}

export interface OrchestrationTrace {
  /** All delegations, in stream-arrival order. */
  delegations: DelegationInvocation[];
  /** Count of reviewer delegations (review rounds actually run). */
  reviewRounds: number;
  /** Count of non-reviewer (specialist) delegations. */
  specialistCallCount: number;
  /** The orchestrator called ask_clarifying_question (gated clarify path) at least once. */
  clarifyRequested: boolean;
  /** num_turns from the result message, when present. */
  numTurns?: number;
  /** is_error from the result message — the run errored rather than finishing cleanly. */
  isError?: boolean;
}
