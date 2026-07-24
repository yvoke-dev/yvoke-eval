import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { UserError, type ThinkingLevel } from '../types';
import type { PromptSource, McpPromptInfo } from '../mcp/McpPrompts';
import { DEFAULT_KB_TOOLS, MCP_SERVER_NAME, qualifyTool } from './mcpServers';
import { isClarifyTool } from './policy';
import { COMPUTE_TOOLS } from './computeTools';

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** allow-list token that ENABLES delegation is 'Task'; the in-stream tool_use name is 'Agent'. */
export const DELEGATE_ALLOW_TOKEN = 'Task';
export const REVIEWER_SUBAGENT = 'reviewer';
export const ORCHESTRATOR_AGENT = 'orchestrator';

/** Which playbooks compose a multi-agent run. */
export interface OrchestratorProfile {
  orchestratorPlaybook: string;
  reviewerPlaybook: string;
  specialistPlaybooks: string[];
}

export interface RoleConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface OrchestratorTuning {
  orchestrator: RoleConfig;
  reviewer: RoleConfig;
  specialist: RoleConfig;
  maxReviewRounds: number;
  maxSpecialistCalls: number;
  orchestratorMaxTurns: number;
  specialistMaxTurns: number;
}

export interface ResolvedOrchestrator {
  agents: Record<string, AgentDefinition>;
  allowedTools: string[];
  specialistNames: string[];
  orchestratorModel: string;
  orchestratorThinking: ThinkingLevel;
  orchestratorMaxTurns: number;
}

/** thinkingLevel → sub-agent reasoning effort (AgentDefinition has no thinking-budget field). */
function effortFor(level: ThinkingLevel): 'low' | 'medium' | 'high' {
  return level === 'high' ? 'high' : level === 'off' || level === 'low' ? 'low' : 'medium';
}

/**
 * Map a playbook's declared tools to the SDK's fully-qualified allow-list for a specialist.
 *
 * `undefined` vs `[]` is read exactly as buildAllowedTools reads it: undeclared falls back to the KB
 * defaults, declared-empty grants nothing. This used to branch on `length > 0`, so the same
 * `meta.tools: []` granted nothing in single mode and all nine defaults here — a specialist authored
 * to reason over evidence it was handed would have retrieved on its own instead.
 */
export function mapSpecialistTools(info: McpPromptInfo | undefined): string[] {
  const declared = info?.tools;
  const tools = declared !== undefined ? declared.map(qualifyTool) : DEFAULT_KB_TOOLS.map(qualifyTool);
  const out = [...tools, 'ToolSearch'];
  // Safe compute tools, not Bash — see buildAllowedTools.
  if (info?.codeExecution !== false) out.push(...COMPUTE_TOOLS);
  return [...new Set(out)];
}

const REVIEWER_TOOLS = [`${MCP_TOOL_PREFIX}verify_citations`, `${MCP_TOOL_PREFIX}get_section`];

function orchestratorAdapter(roster: string, maxReviewRounds: number, maxSpecialistCalls: number): string {
  return `

---
## Runtime adapter (how your tools work here)

You have NO \`call_specialist\` tool. To consult a specialist, call the **Task** tool with
\`subagent_type\` set to the specialist's name and \`prompt\` set to a fully self-contained question
(include the version/tag and any entity names — the specialist cannot see this conversation). The Task
result is that specialist's grounded, cited answer. You may delegate to several specialists in
parallel. Aim for at most ${maxSpecialistCalls} specialist calls in total.

To have your composed answer validated, call the **Task** tool with \`subagent_type: "${REVIEWER_SUBAGENT}"\`,
passing the original question, your candidate answer, and the evidence the specialists returned. If the
reviewer replies \`REJECTED\`, revise and re-review — but no more than ${maxReviewRounds} review rounds;
after that, deliver your best answer prefixed with a short "⚠️ This answer did not fully pass review" note.

Available specialists (\`subagent_type\` → coverage):
${roster}
`;
}

const REVIEWER_ADAPTER = `

---
## Runtime adapter

There is no \`submit_review\` tool here. End your turn with your verdict as plain text: the FIRST line
must be exactly \`APPROVED\` or \`REJECTED\`, followed by concise, actionable feedback (name any
unsupported or fabricated claims the orchestrator must fix).`;

/**
 * Build the SDK `agents` map + `allowedTools` for orchestrator mode. Ported from
 * yvoke-desktop/src/main/agent/orchestration.ts. Specialists run under the base (default-chat) system
 * prompt with their playbook layered on top; the orchestrator and reviewer use their control playbook
 * as the system prompt. Playbook texts are fetched from MCP.
 */
export async function buildOrchestrator(
  profile: OrchestratorProfile,
  tuning: OrchestratorTuning,
  prompts: PromptSource,
  baseSystemPrompt: string | null,
): Promise<ResolvedOrchestrator> {
  const metadata = await prompts.list();
  const byName = new Map(metadata.map((p) => [p.name, p]));

  const names = [profile.orchestratorPlaybook, profile.reviewerPlaybook, ...profile.specialistPlaybooks];

  // Fail before fetching any prompt. A name with no playbook behind it used to fall through to the
  // `|| name` fallback below and render as a plausible roster entry
  // ("- `oim-standard-search` — oim-standard-search"), so the orchestrator was told a specialist
  // existed when it did not — the committed baseline shipped exactly that, and every run from a
  // clean checkout was one specialist short with no error. A roster that is quietly incomplete
  // still produces confident answers, which is worse than not running at all.
  const unresolved = names.filter((name) => !byName.has(name));
  if (unresolved.length > 0) {
    throw new UserError(
      `Orchestrator profile names ${unresolved.length} playbook(s) that do not exist: ` +
        `${unresolved.join(', ')}.\n` +
        `Available playbooks: ${[...byName.keys()].sort().join(', ')}.\n` +
        `Fix mas.profiles.<profile> in yvoke-eval.yaml (it must match orchestrator_profiles in the database).`,
    );
  }

  const textEntries = await Promise.all(names.map(async (name) => [name, await prompts.getText(name)] as const));
  const textByName = new Map(textEntries);

  const specialistNames = profile.specialistPlaybooks;
  // No `|| name` fallback: every name is known to resolve by now, and reinstating it would let a
  // caller that skips the check above silently regain the bug.
  const roster = specialistNames
    .map((name) => {
      const info = byName.get(name)!;
      return `- \`${name}\` — ${info.description || info.title}`;
    })
    .join('\n');

  const agents: Record<string, AgentDefinition> = {};

  agents[ORCHESTRATOR_AGENT] = {
    description: 'Coordinates specialists and composes one grounded, cited answer.',
    prompt:
      (textByName.get(profile.orchestratorPlaybook) ?? '') +
      orchestratorAdapter(roster, tuning.maxReviewRounds, tuning.maxSpecialistCalls),
    tools: [DELEGATE_ALLOW_TOKEN, `${MCP_TOOL_PREFIX}ask_clarifying_question`],
    model: tuning.orchestrator.model,
    effort: effortFor(tuning.orchestrator.thinkingLevel),
    maxTurns: tuning.orchestratorMaxTurns,
  };

  const specialistToolSets: string[][] = [];
  for (const name of specialistNames) {
    const info = byName.get(name);
    const tools = mapSpecialistTools(info);
    specialistToolSets.push(tools);
    const playbookText = textByName.get(name) ?? '';
    const specialistPrompt = baseSystemPrompt
      ? `${baseSystemPrompt}\n\n---\n\n${playbookText}`
      : playbookText;
    agents[name] = {
      description: info?.description || info?.title || name,
      prompt: specialistPrompt,
      tools,
      model: tuning.specialist.model,
      effort: effortFor(tuning.specialist.thinkingLevel),
      maxTurns: tuning.specialistMaxTurns,
    };
  }

  agents[REVIEWER_SUBAGENT] = {
    description: 'Validates the composed answer against the gathered evidence. Never searches anew.',
    prompt: (textByName.get(profile.reviewerPlaybook) ?? '') + REVIEWER_ADAPTER,
    tools: REVIEWER_TOOLS,
    model: tuning.reviewer.model,
    effort: effortFor(tuning.reviewer.thinkingLevel),
    maxTurns: tuning.specialistMaxTurns,
  };

  // ask_clarifying_question stays OUT of the session allow-list — it is still available to the agents
  // that declare it via AgentDefinition.tools, but a bare allow-list entry is auto-approved before
  // canUseTool runs, so listing it here would silence the capture-and-deny that lets an expect:clarify
  // run stop cleanly. Single mode has always filtered it; mas listed it explicitly and via every
  // specialist's declared tools, which is why the clarify path was only ever verified in single mode.
  const allowedTools = [
    ...new Set(
      [DELEGATE_ALLOW_TOKEN, ...specialistToolSets.flat(), ...REVIEWER_TOOLS].filter((t) => !isClarifyTool(t)),
    ),
  ];

  return {
    agents,
    allowedTools,
    specialistNames,
    orchestratorModel: tuning.orchestrator.model,
    orchestratorThinking: tuning.orchestrator.thinkingLevel,
    orchestratorMaxTurns: tuning.orchestratorMaxTurns,
  };
}
