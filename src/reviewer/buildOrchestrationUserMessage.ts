import type { EvalQuestion, OrchestrationSignals } from '../types';
import type { OrchestrationTrace } from '../agent/OrchestrationTrace';

/**
 * The orchestration grader's user message: question meta + authored expectations + the deterministic
 * orchestration signals (presented as pre-verified evidence) + an ordered delegation list + the
 * composed answer (for context only — the grader must NOT re-grade its grounding/citations; Mode 2
 * owns that). Parallel to buildUserMessage; the specialist grader path is untouched.
 */
export function buildOrchestrationUserMessage(
  q: EvalQuestion,
  answer: string,
  s: OrchestrationSignals,
  trace: OrchestrationTrace,
): string {
  const out: string[] = [];
  out.push('## Question under test');
  out.push(`category: ${q.category}  id: ${q.id}`);
  out.push(`question: ${q.question}`);
  out.push(`expected_behavior: ${q.expect}   (answer|clarify|redirect|refuse)`);
  out.push(`expected_specialists: ${fmtList(q.expectedSpecialists ?? [])}${q.expectedSpecialists && q.expectedSpecialists.length > 0 ? '' : '   (UNAUTHORED — routing is NA)'}`);
  if (q.expectedDelegation != null) out.push(`expected_delegation: ${q.expectedDelegation}   (none|sequential|parallel)`);
  if (q.minReviewRounds != null) out.push(`min_review_rounds: ${q.minReviewRounds}`);

  out.push('');
  out.push('## Orchestration trace (already verified — trust these)');
  out.push(`delegated_specialists: ${fmtList(s.delegatedSpecialists)}`);
  out.push(`delegation_count: ${s.delegationCount}`);
  out.push(`unexpected_specialists: ${fmtList(s.unexpectedSpecialists)}`);
  out.push(`redundant_delegations: ${s.redundantDelegations}`);
  out.push(`delegated_to_expected_specialist: ${s.delegatedToExpectedSpecialist === null ? 'NA (unauthored)' : s.delegatedToExpectedSpecialist}`);
  out.push(`clarify_requested: ${s.clarifyRequested}`);
  out.push(`review_rounds: ${s.reviewRounds}`);
  out.push(`review_invoked: ${s.reviewInvoked}`);
  out.push(`reviewer_verdicts: ${fmtList(s.reviewerVerdicts)}`);
  out.push(`reviewer_verdicts_unparsed: ${s.reviewerVerdictsUnparsed}`);
  out.push(`round_cap_respected: ${s.roundCapRespected}`);
  out.push(`num_turns: ${s.numTurns ?? 'unknown'}`);
  out.push(`terminated_abnormally: ${s.terminatedAbnormally}`);
  out.push(`min_review_rounds_satisfied: ${s.minReviewRoundsSatisfied === null ? 'NA (unset)' : s.minReviewRoundsSatisfied}`);
  out.push(`min_review_rounds_satisfiable: ${s.minReviewRoundsSatisfiable}`);

  out.push('');
  out.push('## Delegation order (order · subagent_type · isReviewer · verdict)');
  if (trace.delegations.length === 0) {
    out.push('(no delegations)');
  } else {
    for (const d of trace.delegations) {
      const v = d.isReviewer ? `  verdict=${d.verdict ?? 'UNPARSED'}` : '';
      const task = d.prompt ? `  task="${truncate(d.prompt, 100)}"` : '';
      out.push(`${d.order}. ${d.subagentType}  isReviewer=${d.isReviewer}${v}${task}`);
    }
  }

  out.push('');
  out.push('## Composed answer (context only — do NOT re-grade grounding/citations; Mode 2 owns that)');
  out.push(answer && answer.length > 0 ? answer : '(no answer produced)');
  return out.join('\n');
}

function fmtList(xs: string[]): string {
  return `[${xs.join(', ')}]`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
