import { describe, it, expect, vi } from 'vitest';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EvalTask } from '../src/agent/AnswerBundle';
import { SdkAnswerRunner } from '../src/agent/SdkAnswerRunner';
import { mkQuestion } from './fixtures';

interface CapturedQueryCall {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}

const capturedCalls: CapturedQueryCall[] = [];
let mockQueryStream: ((options: Options) => AsyncIterable<unknown>) | undefined;

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (args: CapturedQueryCall) => {
      capturedCalls.push(args);
      if (mockQueryStream) {
        return mockQueryStream(args.options);
      }
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Answer' }],
          },
        };
      })();
    },
  };
});


describe('SdkAnswerRunner — Prompt Assembly & Clean User Message', () => {
  it('passes the combined prompt to options.systemPrompt and only q.question to prompt user message', async () => {
    capturedCalls.length = 0;
    const runner = new SdkAnswerRunner({
      serverBaseUrl: 'http://localhost:8080',
      bearer: 'tok',
      transport: 'http',
      sandboxDir: '/tmp/sandbox',
      maxTurns: 5,
    });

    const question = mkQuestion({
      category: 'basics',
      id: 'Q1',
      question: 'What is a widget?',
      playbook: 'demo-basics',
    });

    const task: EvalTask = {
      question,
      modelContent: 'What is a widget?',
      answerModel: 'claude-3-5-sonnet',
      systemPrompt: 'GROUNDING RULES\n\n---\n\nPLAYBOOK TEXT',
      thinkingLevel: 'low',
      codeExecution: true,
    };

    const bundle = await runner.run(task);
    expect(bundle.answer).toBe('Answer');

    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;

    // options.systemPrompt receives the combined prompt
    expect(call.options.systemPrompt).toBe('GROUNDING RULES\n\n---\n\nPLAYBOOK TEXT');

    // SDK prompt message receives only q.question
    const userMessages: SDKUserMessage[] = [];
    for await (const msg of call.prompt) {
      userMessages.push(msg);
    }
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.message.content).toBe('What is a widget?');
    expect(userMessages[0]!.message.content).not.toContain('PLAYBOOK TEXT');
  });

  it('passes empty string as systemPrompt when task.systemPrompt is null', async () => {
    capturedCalls.length = 0;
    const runner = new SdkAnswerRunner({
      serverBaseUrl: 'http://localhost:8080',
      bearer: 'tok',
      transport: 'http',
      sandboxDir: '/tmp/sandbox',
      maxTurns: 5,
    });

    const question = mkQuestion({
      category: 'basics',
      id: 'Q2',
      question: 'Plain question?',
      playbook: null,
    });

    const task: EvalTask = {
      question,
      modelContent: 'Plain question?',
      answerModel: 'claude-3-5-sonnet',
      systemPrompt: null,
      thinkingLevel: 'low',
      codeExecution: true,
    };

    await runner.run(task);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.systemPrompt).toBe('');
  });

  it('passes task.abortController to options.abortController', async () => {
    capturedCalls.length = 0;
    const runner = new SdkAnswerRunner({
      serverBaseUrl: 'http://localhost:8080',
      bearer: 'tok',
      transport: 'http',
      sandboxDir: '/tmp/sandbox',
      maxTurns: 5,
    });

    const ac = new AbortController();
    const task: EvalTask = {
      question: mkQuestion(),
      modelContent: 'Plain question?',
      answerModel: 'claude-3-5-sonnet',
      systemPrompt: null,
      thinkingLevel: 'low',
      codeExecution: true,
      abortController: ac,
    };

    await runner.run(task);
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.options.abortController).toBe(ac);
  });
});

describe('SdkAnswerRunner — Clarify Override', () => {
  it('overrides post-denial prose with <clarifying-question> when expect is clarify', async () => {
    mockQueryStream = async function* (options) {
      if (options.canUseTool) {
        await options.canUseTool(
          'mcp__yvoke__ask_clarifying_question',
          {
            question: 'Which version?',
            options: ['9.3', '10.0'],
          },
          { signal: new AbortController().signal, toolUseID: 'call-1', requestId: 'req-1' },
        );
      }
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Post-denial prose' }],
        },
      };
    };

    const runner = new SdkAnswerRunner({
      serverBaseUrl: 'http://localhost:8080',
      bearer: 'tok',
      transport: 'http',
      sandboxDir: '/tmp/sandbox',
      maxTurns: 5,
    });

    const task: EvalTask = {
      question: mkQuestion({ expect: 'clarify' }),
      modelContent: 'Ambiguous question?',
      answerModel: 'claude-3-5-sonnet',
      systemPrompt: null,
      thinkingLevel: 'low',
      codeExecution: true,
    };

    const bundle = await runner.run(task);
    expect(bundle.answer).toBe('<clarifying-question>Which version?\noptions: 9.3 | 10.0</clarifying-question>');
    expect(bundle.rawAnswer).toBe('Post-denial prose');
    mockQueryStream = undefined;
  });

  it('preserves answer prose and does NOT override when expect is answer and answer is non-empty', async () => {
    mockQueryStream = async function* (options) {
      if (options.canUseTool) {
        await options.canUseTool(
          'mcp__yvoke__ask_clarifying_question',
          {
            question: 'Which version?',
            options: ['9.3', '10.0'],
          },
          { signal: new AbortController().signal, toolUseID: 'call-2', requestId: 'req-2' },
        );
      }
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Genuine answer prose' }],
        },
      };
    };

    const runner = new SdkAnswerRunner({
      serverBaseUrl: 'http://localhost:8080',
      bearer: 'tok',
      transport: 'http',
      sandboxDir: '/tmp/sandbox',
      maxTurns: 5,
    });

    const task: EvalTask = {
      question: mkQuestion({ expect: 'answer' }),
      modelContent: 'Standard question?',
      answerModel: 'claude-3-5-sonnet',
      systemPrompt: null,
      thinkingLevel: 'low',
      codeExecution: true,
    };

    const bundle = await runner.run(task);
    expect(bundle.answer).toBe('Genuine answer prose');
    expect(bundle.rawAnswer).toBeUndefined();
    mockQueryStream = undefined;
  });

  it('overrides with <clarifying-question> when answer is empty regardless of expect value', async () => {
    mockQueryStream = async function* (options) {
      if (options.canUseTool) {
        await options.canUseTool(
          'mcp__yvoke__ask_clarifying_question',
          {
            question: 'Which version?',
            options: [],
          },
          { signal: new AbortController().signal, toolUseID: 'call-3', requestId: 'req-3' },
        );
      }
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
        },
      };
    };

    const runner = new SdkAnswerRunner({
      serverBaseUrl: 'http://localhost:8080',
      bearer: 'tok',
      transport: 'http',
      sandboxDir: '/tmp/sandbox',
      maxTurns: 5,
    });

    const task: EvalTask = {
      question: mkQuestion({ expect: 'answer' }),
      modelContent: 'Standard question?',
      answerModel: 'claude-3-5-sonnet',
      systemPrompt: null,
      thinkingLevel: 'low',
      codeExecution: true,
    };

    const bundle = await runner.run(task);
    expect(bundle.answer).toBe('<clarifying-question>Which version?</clarifying-question>');
    expect(bundle.rawAnswer).toBeUndefined();
    mockQueryStream = undefined;
  });
});


