import { describe, it, expect } from 'vitest';
import { cleanWebTranscript, bundleFromWebTrace, type WebMessageTraceDto } from '../src/agent/webCapture';
import { FatalRunError } from '../src/types';

describe('cleanWebTranscript (parity with AssistantTranscript.toModelText)', () => {
  it('returns empty string for empty input', () => {
    expect(cleanWebTranscript('')).toBe('');
  });

  it('removes multiple balanced <think> blocks non-greedily without eating text between them', () => {
    const raw =
      '<think>First reasoning\nmultiline</think>Paragraph one.\n\n<think>Second reasoning</think>Paragraph two.';
    expect(cleanWebTranscript(raw)).toBe('Paragraph one.\n\nParagraph two.');
  });

  it('truncates unclosed <think> at the end of a cancelled stream when no </think follows', () => {
    const raw = 'Introductory text.\n<think>Unfinished reasoning after stop...';
    expect(cleanWebTranscript(raw)).toBe('Introductory text.');
  });

  it('does not truncate prose after <think> if a malformed </think > follows', () => {
    const raw = '<think>some thought</think >Real answer prose that must be kept.';
    expect(cleanWebTranscript(raw)).toContain('Real answer prose that must be kept.');
  });

  it('removes stray </think> closing tags', () => {
    const raw = ' orphaned thoughts</think>\n\nActual answer.';
    expect(cleanWebTranscript(raw)).toBe('orphaned thoughts\n\nActual answer.');
  });

  it('removes 🔧 tool banners and mojibake ?? tool banners while keeping normal ?? prose and markdown tables', () => {
    const raw = [
      '<think>Searching the corpus...</think>',
      '🔧 *Calling tool:* `search_corpus`',
      '  🔧 Calling tool: get_section',
      '?? *Calling tool:* `search_corpus`',
      '?? Calling tool: list_collections',
      '?? Why does this happen? Because of X.',
      '',
      '| Column A | Column B |',
      '|----------|----------|',
      '| Value 1  | Value 2  |',
    ].join('\n');

    expect(cleanWebTranscript(raw)).toBe(
      ['?? Why does this happen? Because of X.', '', '| Column A | Column B |', '|----------|----------|', '| Value 1  | Value 2  |'].join(
        '\n',
      ),
    );
  });

  it('preserves <clarifying-question> XML in cleanWebTranscript', () => {
    const raw = [
      '<think>Need to clarify version</think>',
      '<clarifying-question>',
      '  <question>Which version are you using?</question>',
      '  <option>9.2</option>',
      '  <option>9.3</option>',
      '</clarifying-question>',
    ].join('\n');

    expect(cleanWebTranscript(raw)).toBe(
      [
        '<clarifying-question>',
        '  <question>Which version are you using?</question>',
        '  <option>9.2</option>',
        '  <option>9.3</option>',
        '</clarifying-question>',
      ].join('\n'),
    );
  });
});

describe('bundleFromWebTrace — FatalRunError detection when APP_CHAT_TRACE_TOOL_CALLS=false', () => {
  it('throws FatalRunError when toolCalls is empty/null but content has 🔧 banner', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: '🔧 *Calling tool:* `search_corpus`\n\nHere is the answer.',
      toolCalls: [],
      retrievedChunkIds: [],
    };
    expect(() => bundleFromWebTrace(trace)).toThrow(FatalRunError);
    expect(() => bundleFromWebTrace(trace)).toThrow(/APP_CHAT_TRACE_TOOL_CALLS=true/);
  });

  it('throws FatalRunError when toolCalls is null and content has mojibake tool banner', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: '?? *Calling tool:* `search_corpus`\n\nHere is the answer.',
      toolCalls: null,
      retrievedChunkIds: null,
    };
    expect(() => bundleFromWebTrace(trace)).toThrow(FatalRunError);
  });

  it('does NOT throw FatalRunError when toolCalls is empty and content has <clarifying-question> alone, synthesizing via XML fallback and flagging providerMeta', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content:
        '<clarifying-question>\n  <question>Which module?</question>\n  <option>Sync</option>\n  <option>Attestation</option>\n</clarifying-question>',
      toolCalls: [],
      retrievedChunkIds: [],
    };
    const bundle = bundleFromWebTrace(trace);
    expect(bundle.answer).toBe('<clarifying-question>Which module?\noptions: Sync | Attestation</clarifying-question>');
    expect(bundle.providerMeta?.clarifyingXmlWithoutToolCall).toBe(true);
  });

  it('does NOT set clarifyingXmlWithoutToolCall when <clarifying-question> only appears inside a <think> block', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: '<think>Should I use <clarifying-question>?</think>Direct answer',
      toolCalls: [],
      retrievedChunkIds: [],
    };
    const bundle = bundleFromWebTrace(trace);
    expect(bundle.answer).toBe('Direct answer');
    expect(bundle.providerMeta?.clarifyingXmlWithoutToolCall).toBeUndefined();
  });

  it('still throws FatalRunError when toolCalls is empty and content has BOTH 🔧 banner and <clarifying-question>', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content:
        '🔧 *Calling tool:* `search_corpus`\n<clarifying-question>\n  <question>Which module?</question>\n</clarifying-question>',
      toolCalls: [],
      retrievedChunkIds: [],
    };
    expect(() => bundleFromWebTrace(trace)).toThrow(FatalRunError);
  });

  it('throws FatalRunError when toolCalls is empty and retrievedChunkIds is non-empty', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: 'Answer with citations.',
      toolCalls: [],
      retrievedChunkIds: ['11111111-2222-3333-4444-555555555555'],
    };
    expect(() => bundleFromWebTrace(trace)).toThrow(FatalRunError);
  });

  it('does not throw when toolCalls is null/empty and no tool activity occurred (pure direct response)', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: '<think>Direct refusal</think>I cannot help with that topic.',
      toolCalls: null,
      retrievedChunkIds: null,
    };
    const bundle = bundleFromWebTrace(trace);
    expect(bundle.answer).toBe('I cannot help with that topic.');
    expect(bundle.toolCalls).toEqual([]);
    expect(bundle.retrievedChunkIds).toEqual([]);
  });
});

describe('bundleFromWebTrace — clarifying question normalization', () => {
  it('normalizes <clarifying-question> XML and ask_clarifying_question tool call into canonical format', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: [
        '<think>Ambiguous question</think>',
        '<clarifying-question>',
        '  <question>Which environment &amp; version (&lt;9.3&gt;)?</question>',
        '  <option>On-prem &amp; 9.2</option>',
        '  <option>Cloud &gt; 9.3</option>',
        '</clarifying-question>',
      ].join('\n'),
      toolCalls: [
        {
          seq: 1,
          id: 'tc-1',
          name: 'ask_clarifying_question',
          arguments: JSON.stringify({
            question: 'Which environment & version (<9.3>)?',
            options: ['On-prem & 9.2', 'Cloud > 9.3'],
          }),
          result: 'Clarifying question presented to user.',
          isError: false,
        },
      ],
    };

    const bundle = bundleFromWebTrace(trace, { expect: 'clarify' });
    expect(bundle.answer).toBe(
      '<clarifying-question>Which environment & version (<9.3>)?\noptions: On-prem & 9.2 | Cloud > 9.3</clarifying-question>',
    );
    expect(bundle.rawAnswer).toContain('<question>');
  });

  it('falls back to parsing XML when ask_clarifying_question tool arguments are malformed, unescaping XML entities', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: [
        '<clarifying-question>',
        '  <question>Use A &amp; B or &lt;C&gt;?</question>',
        '  <option>Option A &amp; B</option>',
        '  <option>Option &lt;C&gt;</option>',
        '</clarifying-question>',
      ].join('\n'),
      toolCalls: [
        {
          seq: 1,
          id: 'tc-1',
          name: 'ask_clarifying_question',
          arguments: '{not-valid-json',
          result: '',
          isError: false,
        },
      ],
    };

    const bundle = bundleFromWebTrace(trace, { expect: 'answer' });
    expect(bundle.answer).toBe(
      '<clarifying-question>Use A & B or <C>?\noptions: Option A & B | Option <C></clarifying-question>',
    );
  });

  it('preserves rawAnswer when expect === clarify and model emitted extra prose around clarifying question', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content:
        'Before answering, I need one detail.\n<clarifying-question>\n  <question>Which connector?</question>\n  <option>AD</option>\n  <option>LDAP</option>\n</clarifying-question>',
      toolCalls: [
        {
          seq: 1,
          id: 'tc-1',
          name: 'ask_clarifying_question',
          arguments: JSON.stringify({ question: 'Which connector?', options: ['AD', 'LDAP'] }),
          result: 'ok',
        },
      ],
    };

    const bundle = bundleFromWebTrace(trace, { expect: 'clarify' });
    expect(bundle.answer).toBe('<clarifying-question>Which connector?\noptions: AD | LDAP</clarifying-question>');
    expect(bundle.rawAnswer).toContain('Before answering, I need one detail.');
  });

  it('keeps full prose when expect !== clarify and non-clarify prose exists', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: 'Here is the complete answer based on the defaults.',
      toolCalls: [
        {
          seq: 1,
          id: 'tc-1',
          name: 'ask_clarifying_question',
          arguments: JSON.stringify({ question: 'Which connector?', options: ['AD'] }),
          result: 'ok',
        },
      ],
    };

    const bundle = bundleFromWebTrace(trace, { expect: 'answer' });
    expect(bundle.answer).toBe('Here is the complete answer based on the defaults.');
    expect(bundle.rawAnswer).toBeUndefined();
  });
});

describe('bundleFromWebTrace — chunk IDs, tokens, and providerMeta', () => {
  it('produces lowercased deduplicated union of trace.retrievedChunkIds and tool/answer chunk IDs, and maps tokens & providerMeta', () => {
    const idFromTrace = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    const idFromSearch = '11111111-2222-3333-4444-555555555555';
    const idFromChunkMarker = '99999999-8888-7777-6666-555555555555';

    const trace: WebMessageTraceDto = {
      mode: 'single',
      messageId: 'msg-123',
      conversationId: 'conv-456',
      status: 'done',
      model: 'gemini-3.8-flash',
      playbook: 'oim-full',
      playbookVersion: 4,
      content: [
        '<think>Thinking...</think>',
        '🔧 *Calling tool:* `search_corpus`',
        `Answer citing [chunk_id=${idFromChunkMarker.toUpperCase()}] and [chunk_id=${idFromTrace.toLowerCase()}].`,
      ].join('\n'),
      retrievedChunkIds: [idFromTrace],
      toolCalls: [
        {
          seq: 1,
          id: 'call-1',
          name: 'search_corpus',
          arguments: '{"query":"sync"}',
          result: `### doc/title (score=0.91 id=${idFromSearch.toUpperCase()} doc_id=FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF)`,
          isError: false,
        },
      ],
      tokens: {
        prompt: 1200,
        completion: 300,
        total: 1850, // includes 350 thought tokens
        cached: 400,
        thought: 350,
      },
    };

    const bundle = bundleFromWebTrace(trace);
    expect(bundle.answer).toBe(
      `Answer citing [chunk_id=${idFromChunkMarker.toUpperCase()}] and [chunk_id=${idFromTrace.toLowerCase()}].`,
    );
    expect(bundle.retrievedChunkIds).toEqual([
      idFromTrace.toLowerCase(),
      idFromSearch.toLowerCase(),
      idFromChunkMarker.toLowerCase(),
    ]);
    expect(bundle.promptTokens).toBe(1200);
    expect(bundle.completionTokens).toBe(300);
    expect(bundle.totalTokens).toBe(1850);
    expect(bundle.providerMeta).toEqual({
      resolvedModel: 'gemini-3.8-flash',
      cachedTokens: 400,
      thoughtTokens: 350,
      playbook: 'oim-full',
      playbookVersion: 4,
      messageId: 'msg-123',
      conversationId: 'conv-456',
    });
  });

  it('falls back to promptTokens + completionTokens when trace.tokens.total is 0 or absent', () => {
    const trace: WebMessageTraceDto = {
      status: 'done',
      content: 'Simple answer',
      tokens: { prompt: 100, completion: 50, total: 0 },
    };
    const bundle = bundleFromWebTrace(trace);
    expect(bundle.promptTokens).toBe(100);
    expect(bundle.completionTokens).toBe(50);
    expect(bundle.totalTokens).toBe(150);
  });
});
