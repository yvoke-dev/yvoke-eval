import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StructuredModel } from './Judge';
import { extractJsonObject } from './jsonExtract';
import { sanitizedEnv } from '../agent/auth';
import { thinkingBudget } from '../agent/thinking';

export interface AgentSdkModelOptions {
  sandboxDir: string;
}

/**
 * StructuredModel backed by the Claude Agent SDK — subscription auth (~/.claude), no API key, same
 * plane as the answer path. Tool-less, no MCP; the grader is instructed to return raw JSON, which we
 * parse defensively (the SDK exposes neither responseSchema nor temperature/seed, so determinism
 * rests on temperature-0-by-default-prompting + the constrained rubric — a documented tradeoff of
 * subscription auth vs the old Gemini responseSchema judge).
 */
export class AgentSdkStructuredModel implements StructuredModel {
  constructor(private readonly opts: AgentSdkModelOptions) {}

  async complete(input: {
    system: string;
    user: string;
    model: string;
    temperature: number;
    maxTokens: number;
    toolName: string;
    schema: unknown;
  }): Promise<unknown> {
    const options: Options = {
      systemPrompt: input.system,
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
      includePartialMessages: false,
      model: input.model,
      maxThinkingTokens: thinkingBudget('low'),
      // A cushion above 1: low thinking consumes a turn before the final text, so maxTurns=1 cuts the
      // response off ("Reached maximum number of turns"). No tools here, so it cannot loop.
      maxTurns: 4,
      cwd: this.opts.sandboxDir,
      env: sanitizedEnv(),
    };

    const parts: string[] = [];
    let finalText = '';
    for await (const m of query({ prompt: onceUser(input.user), options })) {
      const msg = m as unknown as {
        type: string;
        result?: string;
        message?: { content?: unknown };
      };
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content as Array<{ type?: string; text?: string }>) {
          if (b.type === 'text' && b.text) parts.push(b.text);
        }
      } else if (msg.type === 'result' && typeof msg.result === 'string') {
        finalText = msg.result;
      }
    }

    const text = parts.join('\n').trim() || finalText;
    return extractJsonObject(text);
  }
}

async function* onceUser(content: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
