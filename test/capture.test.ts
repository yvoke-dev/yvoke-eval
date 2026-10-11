import { describe, it, expect } from 'vitest';
import { mcpTool } from './fixtures';
import { bundleFromMessages, stringifyToolResult, type StreamMessage } from '../src/agent/capture';

const CHUNK = '11111111-1111-1111-1111-111111111111';
const DOC = '99999999-9999-9999-9999-999999999999';

function searchStream(): StreamMessage[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search the manuals.' },
          {
            type: 'tool_use',
            id: 'tu1',
            name: mcpTool('search_corpus'),
            input: { query: 'clients', collection: 'OIM - Manuals - Getting Started - Standard' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content:
              'Searched **OIM - Manuals - Getting Started - Standard** for: _clients_\n\n' +
              `### manual/UI  (score=0.812  id=${CHUNK}  doc_id=${DOC})\nManager, Designer…`,
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `The clients are Manager and Designer [chunk_id=${CHUNK}].\n\n## References\n[1] [chunk_id=${CHUNK}]`,
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'The clients are Manager and Designer.',
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 },
      total_cost_usd: 0.012,
      num_turns: 2,
      is_error: false,
    },
  ];
}

describe('bundleFromMessages', () => {
  it('captures answer, tool calls, chunk ids, and tokens from a search run', () => {
    const b = bundleFromMessages(searchStream());
    expect(b.answer).toContain('Manager and Designer');
    expect(b.toolCalls).toHaveLength(1);
    expect(b.toolCalls[0].name).toBe(mcpTool('search_corpus'));
    expect(JSON.parse(b.toolCalls[0].argumentsJson).collection).toBe(
      'OIM - Manuals - Getting Started - Standard',
    );
    expect(b.toolCalls[0].resultText).toContain('Searched **OIM');
    expect(b.toolCalls[0].isError).toBe(false);
    expect(b.promptTokens).toBe(1200);
    expect(b.completionTokens).toBe(300);
    expect(b.totalTokens).toBe(1500);
    expect(b.providerMeta.sessionId).toBe('sess-1');
    expect(b.providerMeta.numTurns).toBe(2);
  });

  it('extracts the retrieved chunk id, dedups, and excludes doc_id', () => {
    const b = bundleFromMessages(searchStream());
    expect(b.retrievedChunkIds).toEqual([CHUNK]); // header id ∪ [chunk_id=] markers, deduped
    expect(b.retrievedChunkIds).not.toContain(DOC);
  });

  it('ignores forwarded sub-agent messages (parent_tool_use_id set)', () => {
    const msgs: StreamMessage[] = [
      {
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent chatter' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'main answer' }] },
      },
      { type: 'result', result: 'main answer', usage: {}, is_error: false },
    ];
    const b = bundleFromMessages(msgs);
    expect(b.answer).toBe('main answer');
    expect(b.answer).not.toContain('sub-agent');
  });

  it('falls back to the result text when there are no assistant text blocks', () => {
    const msgs: StreamMessage[] = [
      { type: 'result', result: 'final only', usage: { input_tokens: 1, output_tokens: 2 }, is_error: false },
    ];
    expect(bundleFromMessages(msgs).answer).toBe('final only');
  });

  it('stringifyToolResult flattens text-block arrays', () => {
    expect(stringifyToolResult('plain')).toBe('plain');
    expect(stringifyToolResult([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });

  it('MAS: answer is the orchestrator text; tools come from specialist sub-agents; delegation excluded', () => {
    const msgs: StreamMessage[] = [
      // Orchestrator delegates to a specialist (delegation tool_use — must be excluded from toolCalls).
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'd1', name: 'Agent', input: { subagent_type: 'oim-getting-started', prompt: 'clients?' } },
          ],
        },
      },
      // Specialist (sub-agent) runs the real retrieval — messages carry parent_tool_use_id.
      {
        type: 'assistant',
        parent_tool_use_id: 'd1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'searching…' },
            { type: 'tool_use', id: 't1', name: mcpTool('search_corpus'), input: { collection: 'OIM - Manuals - Getting Started - Standard' } },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: 'd1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: `Searched **OIM - Manuals - Getting Started - Standard** for: _x_\n### m/UI (score=0.9 id=${CHUNK} doc_id=${DOC})` },
          ],
        },
      },
      // Orchestrator composes the final answer on the main thread.
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `The clients are Manager and Designer [chunk_id=${CHUNK}].` }] },
      },
      { type: 'result', result: 'composed', usage: { input_tokens: 5000, output_tokens: 800 }, is_error: false },
    ];
    const b = bundleFromMessages(msgs);
    expect(b.answer).toContain('Manager and Designer');
    expect(b.answer).not.toContain('searching'); // sub-agent chatter excluded
    expect(b.toolCalls.map((t) => t.name)).toEqual([mcpTool('search_corpus')]); // delegation excluded, specialist tool kept
    expect(b.retrievedChunkIds).toEqual([CHUNK]);
    expect(b.retrievedChunkIds).not.toContain(DOC);
  });

  it('enforced multi-turn runs: supersedes draft answer prose and sums usage/cost across results', () => {
    const msgs: StreamMessage[] = [
      // Turn 1 draft
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'DRAFT: widget is red.' }] },
      },
      {
        type: 'result',
        result: 'DRAFT: widget is red.',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
        num_turns: 1,
        is_error: false,
      },
      // Turn 2 nudge user turn
      {
        type: 'user',
        message: { role: 'user', content: 'Review enforcement nudge' },
      },
      // Turn 2 final answer
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `FINAL: widget is blue [chunk_id=${CHUNK}].` }] },
      },
      {
        type: 'result',
        result: `FINAL: widget is blue [chunk_id=${CHUNK}].`,
        usage: { input_tokens: 20, output_tokens: 7 },
        total_cost_usd: 0.002,
        num_turns: 1,
        is_error: false,
      },
    ];

    const b = bundleFromMessages(msgs);
    expect(b.answer).toBe(`FINAL: widget is blue [chunk_id=${CHUNK}].`);
    expect(b.answer).not.toContain('DRAFT');
    expect(b.promptTokens).toBe(30);
    expect(b.completionTokens).toBe(12);
    expect(b.totalTokens).toBe(42);
    expect(b.providerMeta.costUsd).toBeCloseTo(0.003);
    expect(b.providerMeta.numTurns).toBe(2);
    expect(b.retrievedChunkIds).toEqual([CHUNK]);
  });
});

