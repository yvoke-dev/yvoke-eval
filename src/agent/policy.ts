import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_KB_TOOLS, qualifyTool } from './mcpServers';
import { COMPUTE_TOOLS } from './computeTools';

const DEFAULT_TOOLS = DEFAULT_KB_TOOLS.map(qualifyTool);

/** The SDK's sub-agent spawn tools. Delegation is the orchestrator's job, nobody else's. */
const DELEGATION_TOOLS = new Set(['Task', 'Agent']);

const CLARIFY_TOOL = 'ask_clarifying_question';

/** True for the clarify tool under any server alias. */
export function isClarifyTool(name: string): boolean {
  return name.endsWith(CLARIFY_TOOL);
}

/**
 * Tools pre-approved for the agent; everything else falls through to canUseTool.
 *
 * `undefined` means the playbook declares no tool list, so the KB defaults apply. `[]` means it
 * declares an empty one, which grants nothing — a meaningful distinction, since a playbook that must
 * not retrieve on its own is authored with an empty array.
 *
 * `codeExecution` grants the safe in-process compute tools, never `Bash`. Production hard-blocks the
 * shell (yvoke-desktop AgentService.ts: `disallowedTools: ['Bash']`) so that prompt-injected corpus
 * content can never reach one, and offers calculate/statistics/date_diff instead. The flag keeps its
 * meaning — may this playbook compute? — with arbitrary code execution off the table.
 */
export function buildAllowedTools(playbookTools?: string[], codeExecution?: boolean): string[] {
  const base = playbookTools !== undefined ? playbookTools.map(qualifyTool) : [...DEFAULT_TOOLS];
  // Excluded from the bare allow-list so it is NOT auto-approved and instead falls through to
  // canUseTool, which denies it and captures the question for expect:clarify grading.
  const allowed = [...base.filter((t) => !isClarifyTool(t)), 'ToolSearch'];
  if (codeExecution !== false) allowed.push(...COMPUTE_TOOLS);
  return [...new Set(allowed)];
}

/**
 * The SDK built-ins to put in front of the model, derived from what the permission layer already
 * permits — so exposure can never exceed permission, and the two cannot drift.
 *
 * Passed as the SDK's `tools` option, which narrows its own tool registry. Without it the model is
 * offered all 33 built-ins — Edit, Write, WebSearch, WebFetch, Task, Workflow, CronCreate and the
 * rest — on a retrieval eval, every one of them advertised context and a chance to go off-task.
 * canUseTool would refuse them, but only after a wasted turn.
 *
 * MCP tools are deliberately left out: `tools` does not narrow them and nothing else can either, so
 * the knowledge base's whole tool set is offered on every run no matter what this returns. That is
 * exactly why canUseTool has to stay the enforcement point.
 *
 * ToolSearch survives the filter although no playbook declares it. It is how the SDK delivers tool
 * schemas it has deferred, not a knowledge-base capability — it retrieves nothing and cannot affect
 * grounding. Dropping it was measured as safe for a ten-tool server, where every tool is offered
 * directly, but on a large enough knowledge base it would silently put declared tools out of reach.
 */
export function builtinTools(allowed: string[]): string[] {
  return allowed.filter((t) => !t.startsWith('mcp__'));
}

export interface ClarifyCapture {
  (question: string, options: string[]): void;
}

export interface CanUseToolOptions {
  /**
   * Whether spawning sub-agents is part of the design. True only for the mas orchestrator; in single
   * mode no playbook declares Task, and a sub-agent there would run knowledge-base tools whose calls
   * never reach capture (SdkAnswerRunner does not set forwardSubagentText), producing an answer that
   * grades with an empty tool trace.
   */
  allowDelegation?: boolean;
}

/**
 * Default-deny permission policy: a tool is permitted iff the playbook declared it.
 *
 * Membership, not prefix. This used to return true for anything named `mcp__<alias>__*`, which voided
 * the declaration entirely — a playbook scoped to graph tools could still call search_corpus, and the
 * run was graded as a successful graph answer. The blanket mattered because it is the only gate there
 * is: `allowedTools` does not hide tools from the model, and an MCP server's tools cannot be hidden at
 * all, so every knowledge-base tool the server advertises is offered on every run regardless of the
 * playbook. Enforcement has to happen here or nowhere.
 *
 * In mas mode `allowed` is the union across orchestrator, specialists and reviewer, because the SDK
 * gives the callback no way to tell which agent is asking. Per-agent scoping there rests on
 * `AgentDefinition.tools`; this is the backstop, and a union-wide one.
 */
export function buildCanUseTool(
  allowed: string[],
  onClarify: ClarifyCapture,
  opts: CanUseToolOptions = {},
): CanUseTool {
  const allowedSet = new Set(allowed);
  const deny = (message: string) => ({ behavior: 'deny' as const, message, interrupt: false });

  return async (toolName, input) => {
    if (isClarifyTool(toolName)) {
      const record = input as { question?: unknown; options?: unknown };
      const question = String(record.question ?? '');
      const options = Array.isArray(record.options) ? record.options.map(String) : [];
      onClarify(question, options);
      return deny('Captured by the eval harness (expect:clarify).');
    }
    if (DELEGATION_TOOLS.has(toolName)) {
      return opts.allowDelegation
        ? { behavior: 'allow', updatedInput: input }
        : deny(`The tool "${toolName}" is not available. Answer directly using the knowledge-base tools.`);
    }
    if (!allowedSet.has(toolName)) {
      return deny(`The tool "${toolName}" is not allowed for this playbook.`);
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
