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
 * Tools whose enforcement lives INSIDE canUseTool, so pre-approving them disables it.
 *
 * A bare `allowedTools` entry is auto-approved by the SDK before the callback is consulted (it says so
 * itself: `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). WebSearch's domain restriction is applied by *rewriting
 * the tool input* — `allowed_domains` is injected in canUseTool — so with WebSearch on the bare list
 * the callback never ran, no domains were injected, and every eval that reached the web tier searched
 * the open internet while the config, the README and `webAccess.test.ts` all said two domains. The
 * tests passed because they call `buildCanUseTool` directly; nothing asserted the SDK would call it.
 *
 * Withholding auto-approval does NOT withhold the tool: it still reaches the model via `tools`, and
 * the permission request it now raises is answered by `buildCanUseTool` from the same full grant.
 * Mirrors yvoke-desktop's `buildAutoApproveTools` (src/main/agent/policy.ts), which fixed this in the
 * client first — the harness carried its own copy of the bug, as with the built-in tool prefix (E5).
 */
const NEVER_AUTO_APPROVE = ['WebSearch', 'WebFetch', 'Task', 'Agent'];

/**
 * The SDK's `allowedTools`: the grant minus everything canUseTool must intercept. Pass the FULL grant
 * to `buildCanUseTool` and to `builtinTools` — a tool kept off this list is still granted and still
 * offered, it just has to ask.
 *
 * Note the direction of failure: a tool wrongly kept off this list shows up as web search not working,
 * loudly. The opposite mistake shows up as nothing at all — which is why it is a named function with a
 * test, and why the test asserts what the runners pass, not just what this returns.
 */
export function buildAutoApproveTools(granted: string[]): string[] {
  return granted.filter((tool) => !NEVER_AUTO_APPROVE.includes(tool));
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
  /**
   * The agent names a delegation may target: the specialist roster plus the reviewer.
   *
   * `Options.agents` ADDS custom subagents to the SDK's own; it does not replace them, and no option
   * suppresses the built-ins (`disallowedAgents`, `allowedAgents`, `builtInAgents` and four other
   * spellings do not exist in the SDK's types). So the orchestrator is offered
   * `claude`, `claude-code-guide`, `Explore`, `general-purpose`, `Plan`, `statusline-setup`
   * alongside the fifteen specialists, and on 3 Sep 2026 it used them: Q2 tried `noop` (rejected by
   * the SDK, which helpfully listed the real names) and **Q1 delegated to `claude`, which ran**.
   *
   * Those agents have no playbook, no corpus and no citation discipline, and their output flows into
   * an answer presented as grounded and cited. Nothing else can stop it: `noop` failed only because
   * the SDK rejects unknown names, while `claude` is a legitimate built-in that it accepts. This is
   * the only gate that sees the difference.
   *
   * Required whenever `allowDelegation` is true — an empty roster denies rather than waving
   * everything through, because a missing roster is a configuration error and the fail-open version
   * of it is invisible.
   */
  delegationRoster?: string[];
  /**
   * The deployment's web allow-list, so a web-tier answer is graded under the same restriction it
   * ships with.
   *
   * Without this the harness granted a declared `WebSearch` and let it reach the **open web**, while
   * production injects `allowed_domains` on every call. An eval is only worth its verdict if the
   * answer was produced under the shipped constraints, and search results are precisely where a
   * wider net changes the answer. Empty or absent → refuse rather than search unrestricted, matching
   * the client's fail-closed rule.
   */
  webAllowedDomains?: string[];
}

/** Bare hostname from an allow-list entry, which may carry a scheme, a path or a `*.` prefix. */
function entryHost(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/^\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
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
      if (!opts.allowDelegation) {
        return deny(`The tool "${toolName}" is not available. Answer directly using the knowledge-base tools.`);
      }
      const roster = opts.delegationRoster ?? [];
      if (roster.length === 0) {
        return deny(
          `Delegation is enabled but no specialist roster was supplied to the permission layer; ` +
            `refusing to delegate to an unvalidated agent.`,
        );
      }
      const target = String((input as { subagent_type?: unknown }).subagent_type ?? '');
      if (!roster.includes(target)) {
        return deny(
          `"${target || '(none)'}" is not a specialist in this deployment, so its answer would carry ` +
            `no playbook, no corpus and no citations. Delegate to one of: ${roster.join(', ')}.`,
        );
      }
      return { behavior: 'allow', updatedInput: input };
    }
    if (!allowedSet.has(toolName)) {
      return deny(`The tool "${toolName}" is not allowed for this playbook.`);
    }
    // Web access is restricted the way the client restricts it, so the answer being graded was
    // produced under the shipped constraint rather than against the open web.
    if (toolName === 'WebSearch' || toolName === 'WebFetch') {
      const hosts = [...new Set((opts.webAllowedDomains ?? []).map(entryHost).filter(Boolean))];
      if (hosts.length === 0) {
        return deny(
          `Web access is not configured for this eval (no allowed domains); refusing an ` +
            `unrestricted ${toolName === 'WebSearch' ? 'search' : 'fetch'}.`,
        );
      }
      if (toolName === 'WebSearch') {
        return { behavior: 'allow', updatedInput: { ...(input as object), allowed_domains: hosts } };
      }
      // WebFetch is not granted by any deployed playbook, and the hosts that matter answer an
      // automated client with an empty page. Refusing with the reason keeps a stray call legible in
      // the trace instead of producing a blank document the model may then narrate.
      return deny(
        'WebFetch is not available in this eval: the permitted hosts serve an empty page to ' +
          'automated clients. Use WebSearch and report what the result indicates.',
      );
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
