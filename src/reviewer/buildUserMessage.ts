import type { EvalQuestion, Signals } from '../types';
import type { ToolEvidence } from '../agent/AnswerBundle';

/**
 * The grader's user message: question meta + the deterministic signals (presented as pre-verified
 * evidence the judge should trust) + the model answer + the verbatim tool evidence. Ported from the
 * Java ReviewerService.buildUserMessage; the trailing evidence block is additive (P6).
 *
 * The evidence block is deliberately framed OUTSIDE the "already verified — trust these" section:
 * signals are computed and trustworthy, whereas tool output is raw model input the judge must read
 * critically (a result that merely echoes the query is not evidence for the thing queried).
 */
export function buildUserMessage(
  q: EvalQuestion,
  answer: string,
  s: Signals,
  evidence?: ToolEvidence[],
): string {
  const out: string[] = [];
  out.push('## Question under test');
  out.push(`category: ${q.category}  id: ${q.id}`);
  out.push(`playbook: ${q.playbook}`);
  out.push(`question: ${q.question}`);
  out.push(`expected_behavior: ${q.expect}   (answer|clarify|redirect|refuse)`);
  out.push(`critical: ${q.critical}`);
  if (q.targetTopic != null) out.push(`expected_collection_contains: ${q.targetTopic}`);
  if (q.bait != null) out.push(`fabrication_bait (MUST NOT be described as real): ${q.bait}`);
  out.push(`citations_required: ${q.citationsRequired}`);
  if (q.rubric != null) out.push(`rubric: ${q.rubric}`);

  out.push('');
  out.push('## Deterministic signals (already verified — trust these)');
  out.push(`tools_fired: ${fmtList(s.toolsFired)}`);
  out.push(`search_collections: ${fmtList(s.searchCollections)}`);
  out.push(`retrieved_collections: ${fmtList(s.retrievedCollections)}`);
  out.push(`retrieved_chunk_count: ${s.retrievedChunkCount}`);
  out.push(`must_include_missing: ${fmtList(s.mustIncludeMissing)}`);
  out.push(`must_not_include_present: ${fmtList(s.mustNotIncludePresent)}`);
  out.push(`expected_tools_missing: ${fmtList(s.expectedToolsMissing)}`);
  out.push(`answer_has_citations: ${s.hasCitations}`);
  if (s.unverifiedCitations && s.unverifiedCitations.length > 0) {
    out.push(`unverified_citations (cited UUIDs never returned by any tool): ${fmtList(s.unverifiedCitations)}`);
  }

  out.push('');
  out.push('## Model answer to grade');
  out.push(answer && answer.length > 0 ? answer : '(no answer produced)');

  if (evidence && evidence.length > 0) {
    out.push('');
    out.push('## Tool evidence (verbatim tool output the model received — NOT pre-verified)');
    out.push(
      'Resolve the answer\'s factual claims against this. Read it critically: a result that merely ' +
        'echoes the query back, or reports no match, is NOT evidence for the thing queried.',
    );
    evidence.forEach((e, i) => {
      out.push('');
      out.push(`### [${i + 1}] ${e.name}  args=${e.argumentsJson}`);
      out.push(e.resultText);
    });
  }

  return out.join('\n');
}

/** Match Java List.toString: `[a, b]`, `[]` when empty. */
function fmtList(xs: string[]): string {
  return `[${xs.join(', ')}]`;
}
