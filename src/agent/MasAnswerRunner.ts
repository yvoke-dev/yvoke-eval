import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AnswerBundle } from './AnswerBundle';
import { bundleFromMessages, type StreamMessage } from './capture';
import { orchestrationTraceFromMessages } from './orchestrationCapture';
import type { OrchestrationTrace } from './OrchestrationTrace';
import { buildMcpServers, type McpTarget } from './mcpServers';
import { buildAutoApproveTools, buildCanUseTool, builtinTools } from './policy';
import { thinkingBudget } from './thinking';
import { sanitizedEnv } from './auth';
import {
  needsReviewEnforcement,
  ORCHESTRATOR_AGENT,
  REVIEW_ENFORCEMENT_PROMPT,
  REVIEWER_SUBAGENT,
  type ResolvedOrchestrator,
} from './orchestration';

export interface MasRunnerOptions extends McpTarget {
  sandboxDir: string;
  /** The deployment's web allow-list, injected into every WebSearch so the run matches production. */
  webAllowedDomains?: string[];
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
      // Reduced: web tools are granted but not pre-approved, so canUseTool runs and scopes them.
      allowedTools: buildAutoApproveTools(this.orch.allowedTools),
      // Belt and braces with `tools`, mirroring yvoke-desktop: the shell is hard-blocked so
      // prompt-injected corpus content can never reach one. mcp__compute__* replaces it.
      disallowedTools: ['Bash'],
      tools: builtinTools(this.orch.allowedTools),
      canUseTool: buildCanUseTool(
        this.orch.allowedTools,
        (question, opts) => {
          clarify = { question, options: opts };
        },
        // The orchestrator's whole job is delegating to specialists — but only to THESE ones. The
        // SDK offers its own built-ins (claude, general-purpose, Explore, …) alongside them and has
        // no option to suppress them; see CanUseToolOptions.delegationRoster.
        {
          allowDelegation: true,
          delegationRoster: [...this.orch.specialistNames, REVIEWER_SUBAGENT],
          webAllowedDomains: this.opts.webAllowedDomains,
        },
      ),
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: false,
      model: this.orch.orchestratorModel,
      maxThinkingTokens: thinkingBudget(this.orch.orchestratorThinking),
      maxTurns: this.orch.orchestratorMaxTurns,
      cwd: this.opts.sandboxDir,
      env: sanitizedEnv(),
    };

    const messages: StreamMessage[] = [];
    // The input generator must stay OPEN so a second turn can be pushed after the first result is
    // seen; `onceUser` closed immediately, which is why a skipped review simply ended the run.
    const turns = new UserTurns(modelContent);
    let enforced = false;
    for await (const m of query({ prompt: turns.stream(), options })) {
      const msg = m as unknown as StreamMessage;
      messages.push(msg);
      if (msg.type !== 'result') continue;
      // One shot, matching the client: enforce at most once, then let the run finish either way.
      if (!enforced && needsReviewEnforcement(orchestrationTraceFromMessages(messages))) {
        enforced = true;
        turns.push(REVIEW_ENFORCEMENT_PROMPT);
      } else {
        turns.close();
      }
    }

    const trace: OrchestrationTrace = { ...orchestrationTraceFromMessages(messages), reviewEnforced: enforced };
    return assembleMasBundle(bundleFromMessages(messages), trace, clarify);
  }
}

/**
 * Assemble the final AnswerBundle: attach the orchestration trace, and on the clarify path
 * replace the answer with the clarifying-question marker WHILE keeping the trace. Extracted as a pure
 * function so the trace-preservation contract is unit-tested (run() itself drives query() and is integration-only).
 */
export function assembleMasBundle(
  base: AnswerBundle,
  trace: OrchestrationTrace,
  clarify?: { question: string; options: string[] },
): AnswerBundle {
  const bundle: AnswerBundle = { ...base, orchestration: trace };
  if (clarify) {
    const opts = clarify.options.length > 0 ? `\noptions: ${clarify.options.join(' | ')}` : '';
    return { ...bundle, answer: `<clarifying-question>${clarify.question}${opts}</clarifying-question>` };
  }
  return bundle;
}

/**
 * A user-turn queue whose generator stays open until explicitly closed, so the runner can push a
 * follow-up turn in response to what it saw in the stream. A plain `async function*` that yields
 * once cannot do that: it completes, and the SDK ends the session.
 */
export class UserTurns {
  private readonly queued: string[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  constructor(first: string) {
    this.queued.push(first);
  }

  push(content: string): void {
    this.queued.push(content);
    this.wake?.();
  }

  close(): void {
    this.done = true;
    this.wake?.();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queued.length > 0) {
        yield {
          type: 'user',
          message: { role: 'user', content: this.queued.shift()! },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
