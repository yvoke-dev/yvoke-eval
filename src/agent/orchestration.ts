import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { UserError, type ThinkingLevel } from '../types';
import type { PromptSource, McpPromptInfo } from '../mcp/McpPrompts';
import { DEFAULT_KB_TOOLS, MCP_SERVER_NAME, qualifyTool } from './mcpServers';
import { isClarifyTool } from './policy';
import { COMPUTE_TOOLS } from './computeTools';
import { resolvePlaybookSystemPrompt } from './buildTask';
import type { SystemPromptClient } from '../server/SystemPromptClient';

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** allow-list token that ENABLES delegation is 'Task'; the in-stream tool_use name is 'Agent'. */
export const DELEGATE_ALLOW_TOKEN = 'Task';
export const REVIEWER_SUBAGENT = 'reviewer';
export const ORCHESTRATOR_AGENT = 'orchestrator';

/**
 * Delegation must be SYNCHRONOUS: the orchestrator needs the specialist's answer before it can
 * compose, and the reviewer's verdict before it can ship.
 *
 * The Task tool's default flipped between SDK versions — 0.3.170 says
 * `run_in_background: true runs the agent asynchronously`, 0.3.218 says
 * `Subagents run in the background by default`. On 0.3.218 the orchestration eval of 3 Sep 2026
 * got launch receipts instead of answers ("Async agent launched successfully… agentId: …", 802
 * chars) and every downstream signal degraded: the orchestrator re-delegated blind, the reviewer's
 * own verdict was unparseable because its result was a receipt, and reviewers APPROVED answers
 * while stating they had been given no evidence. Nothing failed loudly.
 *
 * Declared here rather than left to the prompt because a default that changes under you is not
 * something an instruction can be trusted to survive.
 */
export const SYNCHRONOUS_DELEGATION = false;

/** Which playbooks compose a multi-agent run. */
export interface OrchestratorProfile {
  orchestratorPlaybook: string;
  reviewerPlaybook: string;
  specialistPlaybooks: string[];
}

export interface RoleConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
  configuredModel?: string;
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

/**
 * `verify_citations` and nothing else — matching what the client actually grants
 * (`yvoke-desktop/src/main/agent/orchestration.ts`) and what the reviewer playbook tells the model it
 * has: *"That is your only tool. You cannot search, and you can no longer open a section or
 * document."*
 *
 * `get_section` was granted here too, so an orchestration eval graded a reviewer holding a capability
 * production withholds. The playbook names the harm itself: the tool returns the whole section around
 * a passage, so the reviewer judges claims against neighbouring text no specialist ever retrieved —
 * defeating cite-scoping — and granting a tool the prompt denies invites it to go looking when the
 * prompt says an unsettled claim is a finding to report. A reviewer eval is only meaningful if the
 * reviewer is the deployed one.
 */
const REVIEWER_TOOLS = [`${MCP_TOOL_PREFIX}verify_citations`];

/**
 * Headings the SERVER orchestrator playbook keys its behaviour off — it has a
 * "Handling reviewer feedback (revision rounds)" section that triggers on the feedback heading, and
 * the web harness renders the reviewer's task with the evidence heading. Keep these strings
 * byte-identical to the server's — they are the contract, not decoration.
 */
export const EVIDENCE_HEADING = '## Evidence gathered by the specialists (the ONLY basis for validation)';

function orchestratorAdapter(roster: string, maxReviewRounds: number, maxSpecialistCalls: number): string {
  return `

---
## Runtime adapter (how your tools work here)

You have NO \`call_specialist\` tool. To consult a specialist, call the **Task** tool with
\`subagent_type\` set to the specialist's name and \`prompt\` set to a fully self-contained question
(include the version/tag and any entity names — the specialist cannot see this conversation). The Task
result is that specialist's grounded, cited answer. You may delegate to several specialists in
parallel. Aim for at most ${maxSpecialistCalls} specialist calls in total.

**Delegate synchronously.** If the Task tool offers \`run_in_background\`, pass \`false\` — you need the
specialist's answer in hand to compose, and a backgrounded call returns a launch receipt
("Async agent launched successfully… agentId: …") rather than an answer. Treat such a receipt as a
FAILED call: do not compose from it, do not paste it as evidence, and do not treat it as the
specialist having answered.

To have your composed answer validated, call the **Task** tool with \`subagent_type: "${REVIEWER_SUBAGENT}"\`
and a prompt containing all three of:
1. \`## Original question\` — the user's question.
2. \`## Candidate answer\` — your composed answer in full.
3. \`${EVIDENCE_HEADING}\` — each specialist's answer verbatim, citation markers intact: the bare
   \`[<uuid>]\` ids specialists now write, plus \`[chunk_id=…]\`, \`[document_id=…]\` and \`[N]\` where
   one still uses the older form. The evidence is filtered down to the sources the answer cites, so
   an id you drop here takes its source out of the reviewer's view.

The reviewer cannot see this conversation and validates ONLY against what you paste under (3); a review
request without that section will be rejected for missing evidence.

If the reviewer replies \`REJECTED\`, revise and re-review — but no more than ${maxReviewRounds} review rounds;
after that, deliver your best answer prefixed with a short "⚠️ This answer did not fully pass review" note.
Do not argue with the reviewer — fix the answer.

To ask a clarifying question on an ambiguous query or invalid version/pair, call the **\`ask_clarifying_question\`**
tool directly (it is granted to you). Do not delegate to specialists when the question is ambiguous or requests
an invalid version/entity — halt and call \`ask_clarifying_question\` instead.

Available specialists (\`subagent_type\` → coverage):
${roster}
`;
}

/**
 * Sent when a run ends with specialist delegations but no reviewer call, mirroring the client's
 * `REVIEW_ENFORCEMENT_PROMPT` (yvoke-desktop orchestration.ts) and its ONE-SHOT contract:
 * `nextReviewAction` returns `enforce` once per turn — "one attempt per turn; never loop" — and
 * delivers whatever comes back next, reviewed or not.
 *
 * Ported because the harness could not otherwise measure the thing that reaches users. On 3 Sep 2026
 * the orchestrator skipped review on 2 of 5 orchestration questions; production nudges it once and
 * then ships regardless, so the production-relevant question is not "did it remember?" but "does it
 * comply when nudged?" — which a single-turn harness cannot ask.
 */
export const REVIEW_ENFORCEMENT_PROMPT = `⚠️ Runtime check: you ended your turn without having the answer reviewed, which this deployment requires.

Call the **Task** tool now with \`subagent_type: "${REVIEWER_SUBAGENT}"\`, passing the user's original question, your candidate answer in full, and — under the heading \`${EVIDENCE_HEADING}\` — each specialist's answer verbatim (keep every source id exactly as written — the bare \`[<uuid>]\` markers, and the older \`[chunk_id=…]\` / \`[document_id=…]\` form where a specialist used it). The reviewer validates only against that section.

Then deliver the final answer:
- reviewer says \`APPROVED\` → restate the answer in full;
- reviewer says \`REJECTED\` → fix the claims it flagged, then give the corrected answer in full.

Your earlier draft has been discarded, so whatever you write now is exactly what the user sees. Do not mention this notice.`;

/**
 * Does this finished run need the enforcement nudge? True only when the orchestrator delegated to
 * specialists but never to the reviewer — the client's `outcome: 'skipped'` case.
 *
 * A run with NO delegations at all is left alone: it is a clarify or a direct refusal, and there is
 * no composed answer worth reviewing. A run that already reviewed needs nothing.
 * Errored runs are left alone: there is no composed answer worth reviewing (matches desktop nextReviewAction).
 */
export function needsReviewEnforcement(trace: {
  reviewRounds: number;
  specialistCallCount: number;
  isError?: boolean;
}): boolean {
  if (trace.isError) return false;
  return trace.specialistCallCount > 0 && trace.reviewRounds === 0;
}

const REVIEWER_ADAPTER = `

---
## Runtime adapter — read this over the playbook's "## Verdict" section

**This runtime has no \`submit_review\` tool.** The playbook's "## Verdict" section is written around
one: ignore that call, and its claim that ending the turn without it "is read as a rejection". Use the
plain-text form below. Everything else in the playbook stands unchanged — what you check, and what
counts as approvable, are exactly as written there.

Your reply must BEGIN with the verdict word, alone on the first line, before any prose, heading or
table:

\`APPROVED\`  or  \`REJECTED\`

Then, as ordinary prose beneath it, the feedback the playbook asks for: concise, actionable, naming
every unsupported or fabricated claim the orchestrator must fix. What the playbook itemises as
\`feedback\`, \`unsupported_claims\` and \`citation_fixes\` all simply go there, in that order, with the
same care about which category a defect belongs to.

Do **not** open with a summary of what you checked ("All N citation ids were checked and are REAL…")
or with a citation table. A verdict that arrives after other text cannot be read, and an unreadable
verdict is treated as a rejection with no feedback — which costs the run a whole round and repairs
nothing. If you want to tabulate the ids you verified, put the table below the feedback.`;

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
  promptClient?: SystemPromptClient,
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

  const resolveDesignated = async (playbookName: string, fallback: string | null): Promise<string | null> => {
    const raw = byName.get(playbookName)?.systemPrompt;
    return (await resolvePlaybookSystemPrompt(raw, promptClient, fallback)).text;
  };

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

  // The orchestrator writes the user-facing answer, so it needs the base prompt's output contract
  // (bare-id citations, mermaid/KaTeX delimiters) exactly as the specialists do.
  // It previously got the control playbook alone — the one agent that never saw the contract it was
  // expected to honour. Playbook last, so its role-specific rules win on any conflict.
  // Falls back to baseSystemPrompt if no custom prompt is designated, if not found (404), or if empty.
  const customOrchPrompt = await resolveDesignated(profile.orchestratorPlaybook, baseSystemPrompt);
  const orchestratorBase = customOrchPrompt ?? baseSystemPrompt;
  const orchestratorPlaybookText = textByName.get(profile.orchestratorPlaybook) ?? '';
  const orchestratorPrompt = orchestratorBase
    ? `${orchestratorBase}\n\n---\n\n${orchestratorPlaybookText}`
    : orchestratorPlaybookText;

  const orchestratorTools = [
    DELEGATE_ALLOW_TOKEN,
    `${MCP_TOOL_PREFIX}ask_clarifying_question`,
    `${MCP_TOOL_PREFIX}verify_citations`,
  ];

  agents[ORCHESTRATOR_AGENT] = {
    description: 'Coordinates specialists and composes one grounded, cited answer.',
    prompt:
      orchestratorPrompt +
      orchestratorAdapter(roster, tuning.maxReviewRounds, tuning.maxSpecialistCalls),
    tools: orchestratorTools,
    background: SYNCHRONOUS_DELEGATION,
    model: tuning.orchestrator.model,
    effort: effortFor(tuning.orchestrator.thinkingLevel),
    maxTurns: tuning.orchestratorMaxTurns,
  };

  const specialistToolSets: string[][] = [];
  for (const name of specialistNames) {
    const info = byName.get(name);
    const tools = mapSpecialistTools(info);
    specialistToolSets.push(tools);
    const customSpecPrompt = await resolveDesignated(name, baseSystemPrompt);
    const specialistBase = customSpecPrompt ?? baseSystemPrompt;
    const playbookText = textByName.get(name) ?? '';
    const specialistPrompt = specialistBase
      ? `${specialistBase}\n\n---\n\n${playbookText}`
      : playbookText;
    agents[name] = {
      description: info?.description || info?.title || name,
      prompt: specialistPrompt,
      tools,
      background: SYNCHRONOUS_DELEGATION,
      model: tuning.specialist.model,
      effort: effortFor(tuning.specialist.thinkingLevel),
      maxTurns: tuning.specialistMaxTurns,
    };
  }

  // The reviewer runs on its playbook alone (deliberately: no baseSystemPrompt).
  // If a custom designated system prompt is specified and loads successfully, it is layered on top.
  // If absent, not found (404), or empty, it falls back to empty string (playbook alone, NO baseSystemPrompt).
  const customRevPrompt = await resolveDesignated(profile.reviewerPlaybook, null);
  const reviewerBase = customRevPrompt ? `${customRevPrompt}\n\n---\n\n` : '';

  agents[REVIEWER_SUBAGENT] = {
    description: 'Validates the composed answer against the gathered evidence. Never searches anew.',
    prompt: reviewerBase + (textByName.get(profile.reviewerPlaybook) ?? '') + REVIEWER_ADAPTER,
    tools: REVIEWER_TOOLS,
    background: SYNCHRONOUS_DELEGATION,
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
      [...orchestratorTools, ...specialistToolSets.flat(), ...REVIEWER_TOOLS].filter((t) => !isClarifyTool(t)),
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
