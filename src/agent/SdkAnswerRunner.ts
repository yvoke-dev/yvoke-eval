import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AnswerBundle, EvalTask } from './AnswerBundle';
import { bundleFromMessages, type StreamMessage } from './capture';
import { buildMcpServers, type McpTarget } from './mcpServers';
import { buildAllowedTools, buildAutoApproveTools, buildCanUseTool, builtinTools } from './policy';
import { thinkingBudget } from './thinking';
import { sanitizedEnv } from './auth';

export interface SdkRunnerOptions extends McpTarget {
  sandboxDir: string;
  /** The deployment's web allow-list, injected into every WebSearch so the run matches production. */
  webAllowedDomains?: string[];
  maxTurns: number;
}

/** The single-mode answer producer, as runSuite consumes it. */
export interface AnswerRunner {
  run(task: EvalTask): Promise<AnswerBundle>;
}

/**
 * Single-agent answer provider: drives one question through the Claude Agent SDK against the yvoke
 * MCP server (subscription auth), and folds the stream into an AnswerBundle. Mirrors the desktop's
 * AgentService wiring, headless and one-shot.
 */
export class SdkAnswerRunner implements AnswerRunner {
  constructor(private readonly opts: SdkRunnerOptions) {}

  async run(task: EvalTask): Promise<AnswerBundle> {
    const allowedTools = buildAllowedTools(task.playbookTools, task.codeExecution);
    let clarify: { question: string; options: string[] } | undefined;

    const options: Options = {
      systemPrompt: task.systemPrompt ?? '',
      mcpServers: buildMcpServers(this.opts),
      // Reduced: web tools are granted but not pre-approved, so canUseTool runs and scopes them.
      allowedTools: buildAutoApproveTools(allowedTools),
      // Belt and braces with `tools`, mirroring yvoke-desktop: the shell is hard-blocked so
      // prompt-injected corpus content can never reach one. mcp__compute__* replaces it.
      disallowedTools: ['Bash'],
      tools: builtinTools(allowedTools),
      canUseTool: buildCanUseTool(
        allowedTools,
        (question, opts) => {
          clarify = { question, options: opts };
        },
        { webAllowedDomains: this.opts.webAllowedDomains },
      ),
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: false,
      model: task.answerModel,
      maxThinkingTokens: thinkingBudget(task.thinkingLevel),
      maxTurns: this.opts.maxTurns,
      cwd: this.opts.sandboxDir,
      env: sanitizedEnv(),
    };

    const messages: StreamMessage[] = [];
    for await (const m of query({ prompt: onceUser(task.modelContent), options })) {
      messages.push(m as unknown as StreamMessage);
    }

    const bundle = bundleFromMessages(messages);

    // A captured clarifying question → synthesize the production STOP block so
    // stop_rule / routing grade identically to prod without failing on post-denial prose.
    if (clarify) {
      const opts = clarify.options.length > 0 ? `\noptions: ${clarify.options.join(' | ')}` : '';
      return { ...bundle, answer: `<clarifying-question>${clarify.question}${opts}</clarifying-question>` };
    }
    return bundle;
  }
}

async function* onceUser(content: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
