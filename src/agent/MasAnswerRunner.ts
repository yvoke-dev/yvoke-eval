import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AnswerBundle } from './AnswerBundle';
import { bundleFromMessages, type StreamMessage } from './capture';
import { orchestrationTraceFromMessages } from './orchestrationCapture';
import type { OrchestrationTrace } from './OrchestrationTrace';
import { buildMcpServers, type McpTarget } from './mcpServers';
import { buildCanUseTool, builtinTools } from './policy';
import { thinkingBudget } from './thinking';
import { sanitizedEnv } from './auth';
import { ORCHESTRATOR_AGENT, type ResolvedOrchestrator } from './orchestration';

export interface MasRunnerOptions extends McpTarget {
  sandboxDir: string;
}

/**
 * Multi-agent answer provider: runs a question through the orchestrator + specialists + reviewer
 * (mirrors yvoke-desktop/scripts/spike-mas.ts). The composed answer is the orchestrator's main-thread
 * text; capture pulls tool/chunk signals from the specialist sub-agents (forwardSubagentText).
 */
export class MasAnswerRunner {
  constructor(
    private readonly opts: MasRunnerOptions,
    private readonly orch: ResolvedOrchestrator,
  ) {}

  async run(modelContent: string): Promise<AnswerBundle> {
    let clarify: { question: string; options: string[] } | undefined;

    const options: Options = {
      systemPrompt: '',
      agent: ORCHESTRATOR_AGENT,
      agents: this.orch.agents,
      forwardSubagentText: true,
      mcpServers: buildMcpServers(this.opts),
      allowedTools: this.orch.allowedTools,
      // Belt and braces with `tools`, mirroring yvoke-desktop: the shell is hard-blocked so
      // prompt-injected corpus content can never reach one. mcp__compute__* replaces it.
      disallowedTools: ['Bash'],
      tools: builtinTools(this.orch.allowedTools),
      canUseTool: buildCanUseTool(
        this.orch.allowedTools,
        (question, opts) => {
          clarify = { question, options: opts };
        },
        // The orchestrator's whole job is delegating to specialists.
        { allowDelegation: true },
      ),
      settingSources: [],
      includePartialMessages: false,
      model: this.orch.orchestratorModel,
      maxThinkingTokens: thinkingBudget(this.orch.orchestratorThinking),
      maxTurns: this.orch.orchestratorMaxTurns,
      cwd: this.opts.sandboxDir,
      env: sanitizedEnv(),
    };

    const messages: StreamMessage[] = [];
    for await (const m of query({ prompt: onceUser(modelContent), options })) {
      messages.push(m as unknown as StreamMessage);
    }

    return assembleMasBundle(bundleFromMessages(messages), orchestrationTraceFromMessages(messages), clarify);
  }
}

/**
 * Assemble the final AnswerBundle: attach the orchestration trace, and on the clarify path (empty
 * answer + a captured clarification) replace the answer with the clarifying-question marker WHILE
 * keeping the trace. Extracted as a pure function so the trace-preservation contract is unit-tested
 * (run() itself drives query() and is integration-only).
 */
export function assembleMasBundle(
  base: AnswerBundle,
  trace: OrchestrationTrace,
  clarify?: { question: string; options: string[] },
): AnswerBundle {
  const bundle: AnswerBundle = { ...base, orchestration: trace };
  if (clarify && bundle.answer.trim().length === 0) {
    const opts = clarify.options.length > 0 ? `\noptions: ${clarify.options.join(' | ')}` : '';
    return { ...bundle, answer: `<clarifying-question>${clarify.question}${opts}</clarifying-question>` };
  }
  return bundle;
}

async function* onceUser(content: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}
