import { describe, it, expect, vi } from 'vitest';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentSdkStructuredModel } from '../src/reviewer/AgentSdkStructuredModel';

interface CapturedCall {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}

const capturedCalls: CapturedCall[] = [];
let queryYields: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (args: CapturedCall) => {
      capturedCalls.push(args);
      return (async function* () {
        for (const item of queryYields) {
          yield item;
        }
      })();
    },
  };
});

describe('AgentSdkStructuredModel', () => {
  it('forwards abortController and configuration to SDK options', async () => {
    capturedCalls.length = 0;
    queryYields = [
      { type: 'system', subtype: 'init', model: 'claude-3-5-sonnet-20241022' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '{"verdict":"PASS","dimensions":{},"reasoning":"ok"}' }],
        },
      },
    ];

    const model = new AgentSdkStructuredModel({ sandboxDir: '/tmp/test-sandbox' });
    const ac = new AbortController();

    const res = await model.complete({
      system: 'RUBRIC',
      user: 'QUESTION',
      model: 'opus',
      temperature: 0,
      maxTokens: 1024,
      toolName: 'record_verdict',
      schema: {},
      abortController: ac,
    });

    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.options.abortController).toBe(ac);
    expect(call.options.systemPrompt).toBe('RUBRIC');
    expect(call.options.model).toBe('opus');
    expect(call.options.cwd).toBe('/tmp/test-sandbox');
    expect(call.options.tools).toEqual([]);
    expect(call.options.maxTurns).toBe(4);

    expect(model.resolvedModel).toBe('claude-3-5-sonnet-20241022');
    expect(res).toEqual({ verdict: 'PASS', dimensions: {}, reasoning: 'ok' });
  });

  it('extracts JSON from result message when assistant content is empty', async () => {
    capturedCalls.length = 0;
    queryYields = [
      {
        type: 'result',
        result: '```json\n{"verdict":"FAIL","dimensions":{},"reasoning":"failed"}\n```',
      },
    ];

    const model = new AgentSdkStructuredModel({ sandboxDir: '/tmp/test-sandbox' });
    const res = await model.complete({
      system: 'RUBRIC',
      user: 'QUESTION',
      model: 'opus',
      temperature: 0,
      maxTokens: 1024,
      toolName: 'record_verdict',
      schema: {},
    });

    expect(res).toEqual({ verdict: 'FAIL', dimensions: {}, reasoning: 'failed' });
  });
});
