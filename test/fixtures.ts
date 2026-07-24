import type { EvalQuestion, OrchestrationSignals } from '../src/types';
import type { AnswerBundle, ToolInvocation } from '../src/agent/AnswerBundle';
import type { StreamMessage } from '../src/agent/capture';
import type { OrchestrationTrace, DelegationInvocation } from '../src/agent/OrchestrationTrace';
import { MCP_SERVER_NAME } from '../src/agent/mcpServers';

/** Qualify a tool the way the SDK does, so no test hardcodes the server alias. */
export const mcpTool = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

const GS_STANDARD = 'OIM - Manuals - Getting Started - Standard';

export function mkQuestion(partial: Partial<EvalQuestion> = {}): EvalQuestion {
  return {
    category: 'getting_started',
    id: 'Q1',
    question: 'Which One Identity Manager client applications ship?',
    playbook: 'oim-getting-started',
    expect: 'answer',
    versionTag: '9.3.1',
    targetTopic: 'Getting Started',
    mustInclude: [],
    mustNotInclude: [],
    expectToolCalled: [],
    bait: null,
    citationsRequired: true,
    critical: false,
    rubric: null,
    ...partial,
  };
}

export function mkBundle(partial: Partial<AnswerBundle> = {}): AnswerBundle {
  return {
    answer: '',
    toolCalls: [],
    retrievedChunkIds: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    providerMeta: {},
    ...partial,
  };
}

export function searchCorpusCall(collection: string, opts: { error?: boolean } = {}): ToolInvocation {
  return {
    name: mcpTool('search_corpus'),
    argumentsJson: JSON.stringify({ query: 'clients', collection }),
    resultText: opts.error
      ? `Error: Collection '${collection}' does not exist.`
      : `Searched **${collection}** for: _clients_\n\n### Result 1 [chunk_id=11111111-1111-1111-1111-111111111111]\nManager, Designer, Web Portal…`,
    isError: opts.error ?? false,
  };
}

export function getSectionCall(documentId: string): ToolInvocation {
  return {
    name: mcpTool('get_section'),
    argumentsJson: JSON.stringify({ document_id: documentId }),
    resultText: '# Installing the One Identity Manager\n…',
  };
}

/** A good, grounded, cited answer that searched the target collection. */
export const GOOD_ANSWER: { question: EvalQuestion; bundle: AnswerBundle } = {
  question: mkQuestion({ mustInclude: ['Manager'] }),
  bundle: mkBundle({
    answer:
      'The clients are Manager, Designer, Web Portal, and Launchpad [1].\n\n## References\n[1] One Identity Manager tools user interface',
    toolCalls: [searchCorpusCall(GS_STANDARD)],
    retrievedChunkIds: ['11111111-1111-1111-1111-111111111111'],
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
  }),
};

export { GS_STANDARD };

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration eval (Mode 3) fixtures.
//
// ⚠️ ASSUMED STREAM SHAPE — NOT verified against a recorded real SDK mas trace.
// The delegation event fields below (tool_use name 'Agent'; input.subagent_type; input.prompt;
// sub-agent linkage via parent_tool_use_id; reviewer verdict = first APPROVED/REJECTED line) are
// grounded in src/agent/orchestration.ts (orchestrator/reviewer adapters + REVIEWER_SUBAGENT) and the
// SDK Task tool schema, and mirror the MAS fixture in capture.test.ts — but no live trace has been
// recorded yet. Confirm against one real `mas` run before trusting orchestration verdicts
// (docs/orchestration-eval-design.md §9, Increment 13).
// ─────────────────────────────────────────────────────────────────────────────

const D_CHUNK = '11111111-1111-1111-1111-111111111111';

/**
 * A synthetic mas delegation stream: orchestrator → one (or two, parallel) specialist(s) → reviewer.
 * The reviewer sub-agent emits interim narration AND a verify_citations tool call (whose result is
 * deliberately 'REJECTED-LOOKING NOISE') BEFORE its verdict line, so capture is proven to (a) skip
 * sub-agent tool-result text and (b) find the verdict despite the narration.
 */
export function masDelegationStream(
  opts: { reviewer?: string; parallel?: boolean; clarify?: boolean; reviewerViaToolResult?: boolean } = {},
): StreamMessage[] {
  const reviewer = opts.reviewer ?? 'APPROVED';
  const viaToolResult = opts.reviewerViaToolResult ?? true;

  if (opts.clarify) {
    return [
      { type: 'system', subtype: 'init', session_id: 'sess-mas' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: mcpTool('ask_clarifying_question'), input: { question: 'Which version?' } }],
        },
      },
      { type: 'result', result: '', usage: { input_tokens: 100, output_tokens: 10 }, num_turns: 1, is_error: false },
    ];
  }

  const specialistDelegations: unknown[] = [
    { type: 'tool_use', id: 'd1', name: 'Agent', input: { subagent_type: 'oim-getting-started', prompt: 'Which clients ship? (v9.3.1)' } },
  ];
  if (opts.parallel) {
    specialistDelegations.push({ type: 'tool_use', id: 'd2', name: 'Agent', input: { subagent_type: 'oim-access-governance', prompt: 'Governance clients? (v9.3.1)' } });
  }

  const msgs: StreamMessage[] = [
    { type: 'system', subtype: 'init', session_id: 'sess-mas' },
    { type: 'assistant', message: { role: 'assistant', content: specialistDelegations } },
    {
      type: 'assistant',
      parent_tool_use_id: 'd1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'searching the manuals…' },
          { type: 'tool_use', id: 's1', name: mcpTool('search_corpus'), input: { collection: 'OIM - Manuals - Getting Started - Standard' } },
        ],
      },
    },
    {
      type: 'user',
      parent_tool_use_id: 'd1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: `Searched **OIM - Manuals - Getting Started - Standard** for: _clients_\n### m/UI (score=0.9 id=${D_CHUNK})` }] },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd1', content: `The clients are Manager and Designer [chunk_id=${D_CHUNK}].` }] } },
  ];
  if (opts.parallel) {
    msgs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd2', content: 'Access governance is configured in the Manager.' }] } });
  }

  // Reviewer delegation.
  msgs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Agent', input: { subagent_type: 'reviewer', prompt: 'Validate the composed answer.' } }] } });
  // Reviewer sub-agent: interim narration + a verify_citations tool call + its (noise) result + verdict.
  msgs.push({
    type: 'assistant',
    parent_tool_use_id: 'r1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Let me verify the citations before deciding.' }, { type: 'tool_use', id: 'v1', name: mcpTool('verify_citations'), input: { chunk_id: D_CHUNK } }] },
  });
  msgs.push({ type: 'user', parent_tool_use_id: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'v1', content: 'REJECTED-LOOKING NOISE: citation status unknown' }] } });
  msgs.push({ type: 'assistant', parent_tool_use_id: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: `${reviewer}\nThe answer is supported by the cited chunk.` }] } });
  if (viaToolResult) {
    msgs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: `${reviewer}\nThe answer is supported by the cited chunk.` }] } });
  }

  msgs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `The clients are Manager and Designer [chunk_id=${D_CHUNK}].` }] } });
  msgs.push({ type: 'result', result: 'composed', usage: { input_tokens: 8000, output_tokens: 1200 }, num_turns: 6, is_error: false });
  return msgs;
}

export function mkDelegation(partial: Partial<DelegationInvocation> = {}): DelegationInvocation {
  return { id: 'd0', subagentType: 'oim-getting-started', order: 0, isReviewer: false, ...partial };
}

export function mkTrace(partial: Partial<OrchestrationTrace> = {}): OrchestrationTrace {
  return { delegations: [], reviewRounds: 0, specialistCallCount: 0, clarifyRequested: false, ...partial };
}

export function mkOrchestrationSignals(partial: Partial<OrchestrationSignals> = {}): OrchestrationSignals {
  return {
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
    ...partial,
  };
}
