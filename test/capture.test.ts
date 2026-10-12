import { describe, it, expect } from 'vitest';
import { mcpTool } from './fixtures';
import { bundleFromMessages, stringifyToolResult, type StreamMessage } from '../src/agent/capture';

const CHUNK = '11111111-1111-1111-1111-111111111111';
const DOC = '99999999-9999-9999-9999-999999999999';

const ID1 = 'e8a26e5b-646a-4913-ba9e-50a06356aa2b';
const ID2 = 'e613e51c-e8a8-4811-bca6-49583fa51e97';
const ID3 = 'de932770-ef6d-402c-81a0-ba43b4e0bee3';
const ID4 = '35bb9a5a-c5e3-490d-9101-a5707900d81d';
const ID5 = '7e6b6fb7-5847-4a02-83c1-304cbcfc3174';

function searchStream(): StreamMessage[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
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

export function fixture45653f2f(): {
  intro: string;
  draft: string;
  final: string;
  stream: StreamMessage[];
} {
  const intro =
    'In One Identity Manager 9.3.1 (default), let me search the configuration parameters and documentation for standard system.'.slice(0, 122); // exactly 122 chars
  const baseDraft =
    `In One Identity Manager 9.3.1 (default), the system configuration parameters control core behavior across standard deployments. ` +
    `Specifically, the application architecture relies on five primary components: authentication [chunk_id=${ID1}], database synchronization [chunk_id=${ID2}], ` +
    `role assignment [chunk_id=${ID3}], workflow automation [chunk_id=${ID4}], and system logging [chunk_id=${ID5}]. ` +
    `To configure these parameters correctly, an administrator must navigate to the Designer application and open the Config tree. ` +
    `Each parameter contains specific flags for activation, default inheritance, and cluster-wide replication. ` +
    `When modifying values, ensure that dependent processes are temporarily stopped to avoid database locking during schema adjustments. `;
  const draft = baseDraft.repeat(4).slice(0, 2202); // exactly 2202 chars

  const baseFinal =
    `In One Identity Manager 9.3.1 (default), verified architecture relies on five key components: ` +
    `authentication services [chunk_id=${ID1}], synchronization agents [chunk_id=${ID2}], role management [chunk_id=${ID3}], ` +
    `workflow engines [chunk_id=${ID4}], and audit logging [chunk_id=${ID5}]. ` +
    `All five configuration parameters must be inspected in Designer under the Configuration Parameters node before activation. ` +
    `Ensure that all changes are committed and verified against staging databases prior to production rollout. `;
  const final = baseFinal.repeat(4).slice(0, 1838); // exactly 1838 chars

  const stream: StreamMessage[] = [
    { type: 'system', subtype: 'init', session_id: '45653f2f-0825-479f-9a8f-3e99e32b36e0' },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: intro }] },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: mcpTool('search_corpus'), input: { query: 'config' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `[chunk_id=${ID1}]` }],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: draft }] },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu2',
            name: mcpTool('verify_citations'),
            input: { citations: [ID1, ID2, ID3, ID4, ID5] },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'verified' }],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: final }] },
    },
    {
      type: 'result',
      subtype: 'success',
      result: final,
      usage: { input_tokens: 2500, output_tokens: 600 },
      is_error: false,
    },
  ];

  return { intro, draft, final, stream };
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
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'd1', name: 'Agent', input: { subagent_type: 'oim-getting-started', prompt: 'clients?' } },
          ],
        },
      },
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
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `The clients are Manager and Designer [chunk_id=${CHUNK}].` }] },
      },
      { type: 'result', result: 'composed', usage: { input_tokens: 5000, output_tokens: 800 }, is_error: false },
    ];
    const b = bundleFromMessages(msgs);
    expect(b.answer).toContain('Manager and Designer');
    expect(b.answer).not.toContain('searching');
    expect(b.toolCalls.map((t) => t.name)).toEqual([mcpTool('search_corpus')]);
    expect(b.retrievedChunkIds).toEqual([CHUNK]);
    expect(b.retrievedChunkIds).not.toContain(DOC);
  });

  it('enforced multi-turn runs: supersedes draft answer prose and sums usage/cost across results', () => {
    const msgs: StreamMessage[] = [
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
      {
        type: 'user',
        message: { role: 'user', content: 'Review enforcement nudge' },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `FINAL: widget is blue [chunk_id=${CHUNK}].` }] },
      },
      {
        type: 'result',
        result: `FINAL: widget is blue [chunk_id=${CHUNK}].`,
        usage: { input_tokens: 20, output_tokens: 7 },
        total_cost_usd: 0.0025,
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
    expect(b.providerMeta.costUsd).toBeCloseTo(0.0025, 4);
    expect(b.providerMeta.numTurns).toBe(2);
    expect(b.retrievedChunkIds).toEqual([CHUNK]);
  });

  // Phase 1: Realistic fixture derived from session 45653f2f
  it('deduplicates paraphrased draft from session 45653f2f fixture with 100% cited UUID overlap', () => {
    const { intro, draft, final, stream } = fixture45653f2f();
    expect(intro.length).toBe(122);
    expect(draft.length).toBe(2202);
    expect(final.length).toBe(1838);

    const b = bundleFromMessages(stream);
    expect(b.answer).toContain(intro);
    expect(b.answer).toContain(final);
    expect(b.answer).not.toContain(draft);
    expect(b.answer).toBe(`${intro}\n\n${final}`);
    expect(b.retrievedChunkIds).toEqual(expect.arrayContaining([ID1, ID2, ID3, ID4, ID5]));
  });

  // Phase 1: Structural guard forbidding mixed text/tool_use blocks (exempting only named mixed test)
  it('structural guard: fixtures do not mix text and tool_use in the same assistant content array', () => {
    const fixtureStreams = [searchStream(), fixture45653f2f().stream];
    for (const stream of fixtureStreams) {
      for (const msg of stream) {
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          const hasText = msg.message.content.some((b) => b.type === 'text');
          const hasTool = msg.message.content.some((b) => b.type === 'tool_use');
          expect(hasText && hasTool).toBe(false);
        }
      }
    }
  });

  // Phase 1: Mixed-shape test
  it('handles mixed assistant message with text and tool_use in the same content array', () => {
    const msgs: StreamMessage[] = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Mixed pre-tool text.' },
            { type: 'tool_use', id: 'tu1', name: mcpTool('search_corpus'), input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `[chunk_id=${CHUNK}]` }] },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Post-tool final response [chunk_id=${CHUNK}].` }],
        },
      },
    ];

    const b = bundleFromMessages(msgs);
    expect(b.toolCalls).toHaveLength(1);
    expect(b.answer).toContain('Mixed pre-tool text.');
    expect(b.answer).toContain('Post-tool final response');
    expect(b.answer).toBe(`Mixed pre-tool text.\n\nPost-tool final response [chunk_id=${CHUNK}].`);
  });

  // Phase 1: Later-floor test (E=250, L=150, ratio 0.6 >= 0.5, but L < 200)
  it('preserves earlier answer when later note is under the 200-char floor despite high ratio and shared citations', () => {
    const earlier = (
      `Initial architectural answer outlining all configuration settings [chunk_id=${ID1}] ` +
      `and logging steps [chunk_id=${ID2}] for deployment. ` +
      `Please ensure database tables and sync processes are monitored during execution.`
    ).padEnd(250, '.').slice(0, 250);
    const later = (
      `Closing note confirming that parameters [chunk_id=${ID1}] and [chunk_id=${ID2}] have completed.`
    ).padEnd(150, '.').slice(0, 150);

    expect(earlier.length).toBe(250);
    expect(later.length).toBe(150);
    expect(later.length / earlier.length).toBe(0.6); // 0.6 >= 0.5

    const msgs: StreamMessage[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: earlier }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: later }] },
      },
    ];

    const b = bundleFromMessages(msgs);
    expect(b.answer).toContain(earlier);
    expect(b.answer).toContain(later);
  });

  // Phase 1: Earlier-floor test (E=149, L=300, E < 200)
  it('preserves earlier block when earlier is under the 200-char floor', () => {
    const earlier = `Short initial block [chunk_id=${ID1}] and [chunk_id=${ID2}] for setup.`.padEnd(149, '.').slice(0, 149);
    const later = (
      `Full restatement expanding all configuration details in depth [chunk_id=${ID1}]. ` +
      `All sync steps are verified [chunk_id=${ID2}]. ` +
      `Please ensure all system logs are inspected carefully before proceeding with migration.`
    ).padEnd(300, '.').slice(0, 300);

    expect(earlier.length).toBe(149);
    expect(later.length).toBe(300);

    const msgs: StreamMessage[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: earlier }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: later }] },
      },
    ];

    const b = bundleFromMessages(msgs);
    expect(b.answer).toContain(earlier);
    expect(b.answer).toContain(later);
  });

  // Phase 1: Length-ratio test (E=2000, L=250, ratio 0.125 < 0.5)
  it('preserves earlier answer when later note fails length ratio threshold', () => {
    const baseEarlier =
      `Comprehensive architectural guide detailing all 5 components: authentication [chunk_id=${ID1}], ` +
      `database synchronization [chunk_id=${ID2}], role management, workflow automation, and logging. ` +
      `Administrators should verify the permissions and ensure strict adherence to change control. `;
    const earlier = baseEarlier.repeat(10).slice(0, 2000);
    const later = (
      `Brief summary note confirming components [chunk_id=${ID1}] and [chunk_id=${ID2}] have been audited successfully.`
    ).padEnd(250, '.').slice(0, 250);

    expect(earlier.length).toBe(2000);
    expect(later.length).toBe(250);
    expect(later.length / earlier.length).toBe(0.125); // < 0.5

    const msgs: StreamMessage[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: earlier }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: later }] },
      },
    ];

    const b = bundleFromMessages(msgs);
    expect(b.answer).toContain(earlier);
    expect(b.answer).toContain(later);
  });

  // Phase 1: Uncited-prose test
  it('deduplicates uncited prose draft when later paraphrase shares >= 50% 5-grams', () => {
    const earlier = (
      'To configure system parameters in One Identity Manager, open the Designer tool and navigate to the Configuration Parameters section. ' +
      'Each parameter defines default values and operational behavior across the entire cluster. ' +
      'Administrators must inspect each setting carefully to avoid replication conflicts during synchronization. ' +
      'Make sure that dependent database jobs are temporarily halted while updating critical schema attributes. ' +
      'Once configuration values are saved, compile the database and restart the relevant service components ' +
      'to ensure all changes take effect immediately across all nodes in the deployment. ' +
      'Always verify the results in staging environments before committing modifications to production systems. ' +
      'Review system event logs for warning messages or connection errors following the update.'
    ).slice(0, 765);

    const later = (
      'To configure system parameters in One Identity Manager, open the Designer tool and navigate to the Configuration Parameters section. ' +
      'Each parameter defines default values and operational behavior across the entire cluster. ' +
      'Administrators must inspect each setting carefully to avoid replication conflicts during synchronization. ' +
      'Make sure that dependent database jobs are temporarily halted while updating critical schema attributes. ' +
      'Once configuration values are saved, compile the database and restart the relevant service components.'
    ).slice(0, 443);

    expect(earlier.length).toBe(765);
    expect(later.length).toBe(443);
    expect(later.length).toBeGreaterThanOrEqual(0.5 * earlier.length);

    const msgs: StreamMessage[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: earlier }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: later }] },
      },
    ];

    const b = bundleFromMessages(msgs);
    expect(b.answer).toBe(later);
    expect(b.answer).not.toContain(earlier);
  });
});
