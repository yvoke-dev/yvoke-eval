import type { StreamMessage } from './capture';
import { stringifyToolResult } from './capture';
import { REVIEWER_SUBAGENT } from './orchestration';
import type { OrchestrationTrace, DelegationInvocation } from './OrchestrationTrace';

/**
 * Folds the SAME SDK message stream `bundleFromMessages` sees into an OrchestrationTrace — keeping the
 * delegation structure that answer-quality capture (capture.ts) deliberately discards. Pure and
 * fixture-testable. Used only on the orchestration eval (Mode 3) path.
 *
 * capture.ts is intentionally NOT edited: its `DELEGATE_NAMES` is private, so it is re-declared here.
 * Only `REVIEWER_SUBAGENT` (genuinely exported) and `stringifyToolResult` are imported.
 */
const DELEGATE_NAMES = new Set(['Agent', 'Task']);
const CLARIFY_TOOL = 'ask_clarifying_question';
// Reviewer verdict contract (orchestration.ts REVIEWER_ADAPTER): the FIRST line is APPROVED|REJECTED.
// Scanned with /m so interim narration on earlier lines never masks the verdict line.
const VERDICT_LINE = /^(APPROVED|REJECTED)\b/m;

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface Attribution {
  text: string[];
  toolResult?: string;
}

export function orchestrationTraceFromMessages(messages: StreamMessage[]): OrchestrationTrace {
  const delegations: DelegationInvocation[] = [];
  const byId = new Map<string, DelegationInvocation>();
  const attribution = new Map<string, Attribution>();
  let clarifyRequested = false;
  let numTurns: number | undefined;
  let isError = false;
  // Counts MAIN-THREAD assistant messages only, so a sub-agent's own turns never advance the batch of
  // a later orchestrator fan-out.
  let assistantBatch = -1;

  for (const msg of messages) {
    const isSubAgent = msg.parent_tool_use_id != null;
    const parentId = msg.parent_tool_use_id ?? undefined;
    const content = Array.isArray(msg.message?.content) ? (msg.message!.content as Block[]) : [];

    if (msg.type === 'assistant') {
      if (!isSubAgent) assistantBatch += 1;
      for (const b of content) {
        if (b.type === 'tool_use') {
          const name = String(b.name);
          if (!isSubAgent && DELEGATE_NAMES.has(name)) {
            const input = (b.input ?? {}) as Record<string, unknown>;
            const subagentType = String(input.subagent_type ?? '');
            const inv: DelegationInvocation = {
              id: String(b.id),
              subagentType,
              prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
              order: delegations.length,
              batch: assistantBatch,
              parentId: undefined, // single-tier topology: delegations are main-thread only
              isReviewer: subagentType === REVIEWER_SUBAGENT,
            };
            delegations.push(inv);
            byId.set(inv.id, inv);
          } else if (!isSubAgent && stripPrefix(name) === CLARIFY_TOOL) {
            clarifyRequested = true;
          }
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text && isSubAgent && parentId) {
          // Forwarded sub-agent text → attribute to its delegation. Sub-agent tool calls/results are
          // ignored, so reviewer verify_citations/get_section output never pollutes the verdict scan.
          const a = attribution.get(parentId) ?? { text: [] };
          a.text.push(b.text);
          attribution.set(parentId, a);
        }
      }
    } else if (msg.type === 'user' && !isSubAgent) {
      // Main-thread tool_result = a delegation's final returned text (the Task result).
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const id = String(b.tool_use_id);
        if (!byId.has(id)) continue;
        const a = attribution.get(id) ?? { text: [] };
        a.toolResult = stringifyToolResult(b.content);
        attribution.set(id, a);
      }
    } else if (msg.type === 'result') {
      numTurns = msg.num_turns;
      isError = msg.is_error === true;
    }
  }

  // Resolve each delegation's final text + (for reviewers) its verdict. Prefer the main-thread Task
  // result; else the LAST forwarded text block (the sub-agent's final turn). Never a sub-agent
  // tool-result (those were never attributed).
  for (const d of delegations) {
    const a = attribution.get(d.id);
    // Use the main-thread Task result only when NON-EMPTY; an empty string must fall through to the
    // last forwarded text (`??` would retain '' and hide a verdict present in the forwarded text).
    const source =
      a?.toolResult && a.toolResult.length > 0
        ? a.toolResult
        : a && a.text.length > 0
          ? a.text[a.text.length - 1]
          : undefined;
    d.resultText = source;
    if (d.isReviewer && source) {
      const m = VERDICT_LINE.exec(source);
      if (m) d.verdict = m[1] as 'APPROVED' | 'REJECTED';
    }
  }

  const reviewRounds = delegations.filter((d) => d.isReviewer).length;
  const specialistCallCount = delegations.length - reviewRounds;

  return { delegations, reviewRounds, specialistCallCount, clarifyRequested, numTurns, isError };
}

function stripPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}
