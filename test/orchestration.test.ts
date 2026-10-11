import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { mcpTool } from './fixtures';
import {
  buildOrchestrator,
  mapSpecialistTools,
  ORCHESTRATOR_AGENT,
  REVIEWER_SUBAGENT,
  EVIDENCE_HEADING,
  REVIEW_ENFORCEMENT_PROMPT,
  needsReviewEnforcement,
  type OrchestratorProfile,
  type OrchestratorTuning,
} from '../src/agent/orchestration';
import type { McpPrompts, McpPromptInfo } from '../src/mcp/McpPrompts';
import type { SystemPromptClient } from '../src/server/SystemPromptClient';
import { buildAllowedTools } from '../src/agent/policy';
import { DEFAULT_KB_TOOLS } from '../src/agent/mcpServers';

const infos: McpPromptInfo[] = [
  { name: 'oim-orchestrator', title: 'Orchestrator', description: 'coordinates', tools: [], codeExecution: false },
  { name: 'oim-orchestrator-reviewer', title: 'Reviewer', description: 'validates', tools: [], codeExecution: false },
  { name: 'oim-getting-started', title: 'Getting Started', description: 'onboarding', tools: ['search_corpus', 'get_section'], codeExecution: false },
  { name: 'oim-developer-api', title: 'Dev API', description: 'apis', tools: ['search_graph_entities'], codeExecution: false },
];

const fakePrompts = {
  list: async () => infos,
  getText: async (name: string) => `PROMPT(${name})`,
} as unknown as McpPrompts;

const profile: OrchestratorProfile = {
  orchestratorPlaybook: 'oim-orchestrator',
  reviewerPlaybook: 'oim-orchestrator-reviewer',
  specialistPlaybooks: ['oim-getting-started', 'oim-developer-api'],
};

const tuning: OrchestratorTuning = {
  orchestrator: { model: 'opus', thinkingLevel: 'high' },
  reviewer: { model: 'opus', thinkingLevel: 'high' },
  specialist: { model: 'sonnet', thinkingLevel: 'medium' },
  maxReviewRounds: 2,
  maxSpecialistCalls: 8,
  orchestratorMaxTurns: 60,
  specialistMaxTurns: 20,
};

describe('buildOrchestrator', () => {
  it('builds agents for orchestrator, specialists, and reviewer', async () => {
    const r = await buildOrchestrator(profile, tuning, fakePrompts, 'BASE');
    expect(Object.keys(r.agents).sort()).toEqual(
      [ORCHESTRATOR_AGENT, REVIEWER_SUBAGENT, 'oim-getting-started', 'oim-developer-api'].sort(),
    );
    expect(r.specialistNames).toEqual(['oim-getting-started', 'oim-developer-api']);
    expect(r.orchestratorModel).toBe('opus');

    const orch = r.agents[ORCHESTRATOR_AGENT];
    expect(orch.prompt).toContain('BASE'); // orchestrator layers base system prompt
    expect(orch.prompt).toContain('PROMPT(oim-orchestrator)');
    expect(orch.prompt).toContain('oim-getting-started'); // roster
    expect(orch.tools).toContain('Task');
    expect(orch.tools).toContain(mcpTool('verify_citations'));
    expect(orch.model).toBe('opus');

    const specialist = r.agents['oim-getting-started'];
    expect(specialist.prompt).toContain('BASE'); // base system prompt layered under the playbook
    expect(specialist.prompt).toContain('PROMPT(oim-getting-started)');
    expect(specialist.model).toBe('sonnet');
    expect(specialist.tools).toContain(mcpTool('search_corpus'));
    expect(specialist.tools).not.toContain('Bash'); // never granted, whatever the playbook says

    // Exactly what the client grants and what the reviewer playbook says it has — "that is your
    // only tool". `get_section` used to be granted here as well, which graded a reviewer holding a
    // capability production withholds: it returns the whole section around a passage, so claims get
    // judged against neighbouring text no specialist retrieved.
    expect(r.agents[REVIEWER_SUBAGENT].prompt).not.toContain('BASE'); // reviewer deliberately gets no base prompt
    expect(r.agents[REVIEWER_SUBAGENT].prompt).toContain('PROMPT(oim-orchestrator-reviewer)');
    expect(r.agents[REVIEWER_SUBAGENT].tools).toEqual([mcpTool('verify_citations')]);
    expect(r.agents[REVIEWER_SUBAGENT].tools).not.toContain(mcpTool('get_section'));
  });

  it('allowedTools unions delegation + specialist tools + reviewer tools', async () => {
    const r = await buildOrchestrator(profile, tuning, fakePrompts, null);
    expect(r.allowedTools).toContain('Task');
    expect(r.allowedTools).toContain(mcpTool('search_corpus'));
    expect(r.allowedTools).toContain(mcpTool('search_graph_entities'));
    expect(r.allowedTools).toContain(mcpTool('verify_citations'));
  });

  // A bare allow-list entry is auto-approved before canUseTool runs, so listing the clarify tool
  // here would silence the capture-and-deny that lets an expect:clarify run stop cleanly. It stays
  // available to the agents that declare it via AgentDefinition.tools. Single mode always filtered
  // it; mas listed it explicitly AND inherited it from every specialist's declared tools, which is
  // why the clarify path was only ever verified in single mode.
  it('keeps ask_clarifying_question out of the session allow-list so the capture still fires', async () => {
    const r = await buildOrchestrator(profile, tuning, fakePrompts, null);
    expect(r.allowedTools).not.toContain(mcpTool('ask_clarifying_question'));
    expect(r.agents[ORCHESTRATOR_AGENT].tools).toContain(mcpTool('ask_clarifying_question'));
  });

  it('mapSpecialistTools falls back to defaults when a playbook declares none', () => {
    const t = mapSpecialistTools(undefined);
    expect(t).toContain(mcpTool('search_corpus'));
    expect(t).toContain('ToolSearch');
  });

  // The single-agent and specialist allow-lists used to be two hand-maintained copies of the same
  // nine tools. In the desktop client those copies diverged — search_corpus was added to one and not
  // the other, so single-agent chat silently could not search the corpus. Both now derive from
  // DEFAULT_KB_TOOLS; this asserts they cannot drift apart again.
  it('grants the same default knowledge-base tools to single agents and specialists', () => {
    const expected = DEFAULT_KB_TOOLS.map(mcpTool);
    const single = buildAllowedTools(undefined, true);
    const specialist = mapSpecialistTools(undefined);
    for (const tool of expected) {
      expect(single).toContain(tool);
      expect(specialist).toContain(tool);
    }
    expect(single.filter((t) => t.startsWith('mcp__')).sort()).toEqual(
      specialist.filter((t) => t.startsWith('mcp__')).sort(),
    );
  });
});

describe('roster resolution', () => {
  // The committed baseline named `oim-standard-search`, which does not exist. Nothing checked it:
  // the roster line falls back to `|| name`, so a missing specialist renders as a plausible entry
  // ("- `oim-standard-search` — oim-standard-search") and the orchestrator is told it exists.
  it('rejects a specialist that resolves to no playbook, naming it and the available ones', async () => {
    const bad: OrchestratorProfile = {
      ...profile,
      specialistPlaybooks: [...profile.specialistPlaybooks, 'oim-standard-search'],
    };

    await expect(buildOrchestrator(bad, tuning, fakePrompts, null)).rejects.toThrow(
      /oim-standard-search/,
    );
    await expect(buildOrchestrator(bad, tuning, fakePrompts, null)).rejects.toThrow(
      /oim-getting-started/, // the available list, so the fix needs no second lookup
    );
  });

  it('rejects an unresolvable orchestrator or reviewer, not just specialists', async () => {
    await expect(
      buildOrchestrator({ ...profile, reviewerPlaybook: 'oim-nope' }, tuning, fakePrompts, null),
    ).rejects.toThrow(/oim-nope/);
  });

  it('accepts a fully resolvable roster', async () => {
    await expect(buildOrchestrator(profile, tuning, fakePrompts, null)).resolves.toBeDefined();
  });
});

/**
 * SDK-upgrade guard. The Task tool's default flipped between 0.3.170 (`run_in_background: true runs
 * the agent asynchronously` — opt-in) and 0.3.218 (`Subagents run in the background by default`). On
 * 0.3.218 every delegation returned an 802-character launch receipt instead of an answer, and the
 * whole orchestration surface degraded silently: blind re-delegation, an unparseable reviewer verdict
 * (its result was a receipt too), and reviewers approving answers while stating they had no evidence.
 * These assert the declaration is present so a future bump fails here rather than in an eval run.
 */
describe('buildOrchestrator — every agent delegates synchronously', () => {
  it('declares background: false on the orchestrator, every specialist, and the reviewer', async () => {
    const resolved = await buildOrchestrator(profile, tuning, fakePrompts, 'BASE');
    const names = Object.keys(resolved.agents);
    expect(names.length).toBeGreaterThan(2); // orchestrator + specialists + reviewer
    for (const name of names) {
      expect(resolved.agents[name].background, `${name} must not be backgrounded`).toBe(false);
    }
  });

  it('tells the orchestrator to delegate synchronously and to reject a launch receipt', async () => {
    const resolved = await buildOrchestrator(profile, tuning, fakePrompts, 'BASE');
    const adapter = resolved.agents[ORCHESTRATOR_AGENT].prompt as string;
    expect(adapter).toContain('run_in_background');
    expect(adapter).toContain('Async agent launched successfully');
    // A receipt must be read as a failed call, not as the specialist having answered.
    expect(adapter).toMatch(/FAILED call/i);
  });
});

/**
 * The reviewer's prompt is playbook + adapter, and the shared playbook's "## Verdict" section is
 * written around a `submit_review` TOOL that neither this harness nor the client provides (the
 * server product does). So the reviewer used to be told to call a tool that does not exist, then
 * told two sentences later to emit plain text — and on 3 Sep 2026 it obeyed the playbook's shape,
 * rendering its payload as prose ("All 5 citation ids were checked… | citation | status |") with no
 * verdict token anywhere. Parsed correctly on only 1 of 3 reviews.
 *
 * The adapter must therefore CANCEL the playbook's instruction by name, not merely offer a rival
 * one. The playbook itself is deliberately left alone: it is correct for the server surface.
 */
describe('REVIEWER_ADAPTER — cancels the playbook’s submit_review contract', () => {
  it('names submit_review and the playbook section it overrides', async () => {
    const r = await buildOrchestrator(profile, tuning, fakePrompts, 'BASE');
    const prompt = r.agents[REVIEWER_SUBAGENT].prompt as string;
    expect(prompt).toContain('submit_review');
    expect(prompt).toContain('## Verdict');
    expect(prompt).toMatch(/no .submit_review. tool/i);
  });

  it('keeps the rest of the playbook in force rather than discarding it wholesale', async () => {
    const r = await buildOrchestrator(profile, tuning, fakePrompts, 'BASE');
    const prompt = r.agents[REVIEWER_SUBAGENT].prompt as string;
    expect(prompt).toMatch(/Everything else in the playbook stands unchanged/i);
    // The playbook text itself is still there — the adapter overrides, it does not replace.
    expect(prompt).toContain('PROMPT(oim-orchestrator-reviewer)');
  });

  it('states the consequence of an unreadable verdict, matching how the runtime treats it', () => {
    // The client turns an unparseable verdict into a revision round, so this is not a scare tactic.
    const src = readFileSync(new URL('../src/agent/orchestration.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/cannot be read/i);
    expect(src).toMatch(/rejection with no feedback/i);
  });
});

describe('buildOrchestrator — designated system prompt resolution', () => {
  it('layers designated system prompts for orchestrator, specialists, and reviewer', async () => {
    const promptsWithMeta: McpPromptInfo[] = [
      { name: 'oim-orchestrator', title: 'Orchestrator', description: 'desc', tools: [], codeExecution: false, systemPrompt: 'custom-orch' },
      { name: 'oim-orchestrator-reviewer', title: 'Reviewer', description: 'desc', tools: [], codeExecution: false, systemPrompt: 'custom-rev' },
      { name: 'oim-getting-started', title: 'Getting Started', description: 'desc', tools: ['search_corpus'], codeExecution: false, systemPrompt: 'custom-spec' },
      { name: 'oim-developer-api', title: 'Dev API', description: 'desc', tools: ['search_graph_entities'], codeExecution: false },
    ];
    const source = {
      list: async () => promptsWithMeta,
      getText: async (name: string) => `PROMPT(${name})`,
    } as unknown as McpPrompts;

    const mockClient = {
      get: async (name: string) => {
        if (name === 'custom-orch') return 'ORCHESTRATOR CUSTOM PROMPT';
        if (name === 'custom-rev') return 'REVIEWER CUSTOM PROMPT';
        if (name === 'custom-spec') return 'SPECIALIST CUSTOM PROMPT';
        return null;
      },
    } as unknown as SystemPromptClient;

    const r = await buildOrchestrator(profile, tuning, source, 'DEFAULT_BASE', mockClient);
    expect(r.agents[ORCHESTRATOR_AGENT].prompt).toContain('ORCHESTRATOR CUSTOM PROMPT');
    expect(r.agents['oim-getting-started'].prompt).toContain('SPECIALIST CUSTOM PROMPT');
    expect(r.agents['oim-developer-api'].prompt).toContain('DEFAULT_BASE');
    expect(r.agents[REVIEWER_SUBAGENT].prompt).toContain('REVIEWER CUSTOM PROMPT');
  });

  it('reviewer runs on playbook alone when no designated prompt, even when promptClient returns default-chat', async () => {
    const promptsWithMeta: McpPromptInfo[] = [
      { name: 'oim-orchestrator', title: 'Orchestrator', description: 'desc', tools: [], codeExecution: false },
      { name: 'oim-orchestrator-reviewer', title: 'Reviewer', description: 'desc', tools: [], codeExecution: false },
      { name: 'oim-getting-started', title: 'Getting Started', description: 'desc', tools: ['search_corpus'], codeExecution: false },
      { name: 'oim-developer-api', title: 'Dev API', description: 'desc', tools: ['search_graph_entities'], codeExecution: false },
    ];
    const source = {
      list: async () => promptsWithMeta,
      getText: async (name: string) => `PROMPT(${name})`,
    } as unknown as McpPrompts;

    const mockClient = {
      get: async (name: string) => {
        if (name === 'default-chat') return 'DEFAULT CHAT BASE';
        return null;
      },
    } as unknown as SystemPromptClient;

    const r = await buildOrchestrator(profile, tuning, source, 'DEFAULT_BASE', mockClient);
    expect(r.agents[ORCHESTRATOR_AGENT].prompt).toContain('DEFAULT_BASE');
    expect(r.agents[REVIEWER_SUBAGENT].prompt).not.toContain('DEFAULT CHAT BASE');
    expect(r.agents[REVIEWER_SUBAGENT].prompt).not.toContain('DEFAULT_BASE');
    expect(r.agents[REVIEWER_SUBAGENT].prompt).toContain('PROMPT(oim-orchestrator-reviewer)');
  });

  it('reviewer layers default-chat if explicitly designated in prompt metadata', async () => {
    const promptsWithMeta: McpPromptInfo[] = [
      { name: 'oim-orchestrator', title: 'Orchestrator', description: 'desc', tools: [], codeExecution: false },
      { name: 'oim-orchestrator-reviewer', title: 'Reviewer', description: 'desc', tools: [], codeExecution: false, systemPrompt: 'default-chat' },
      { name: 'oim-getting-started', title: 'Getting Started', description: 'desc', tools: ['search_corpus'], codeExecution: false },
      { name: 'oim-developer-api', title: 'Dev API', description: 'desc', tools: ['search_graph_entities'], codeExecution: false },
    ];
    const source = {
      list: async () => promptsWithMeta,
      getText: async (name: string) => `PROMPT(${name})`,
    } as unknown as McpPrompts;

    const mockClient = {
      get: async (name: string) => {
        if (name === 'default-chat') return 'DEFAULT CHAT BASE';
        return null;
      },
    } as unknown as SystemPromptClient;

    const r = await buildOrchestrator(profile, tuning, source, 'DEFAULT_BASE', mockClient);
    expect(r.agents[REVIEWER_SUBAGENT].prompt).toContain('DEFAULT CHAT BASE');
  });
});

describe('needsReviewEnforcement', () => {
  it('returns false when isError is true, preventing enforcement nudges on failed turns', () => {
    expect(needsReviewEnforcement({ specialistCallCount: 2, reviewRounds: 0, isError: true })).toBe(false);
    expect(needsReviewEnforcement({ specialistCallCount: 2, reviewRounds: 0, isError: false })).toBe(true);
    expect(needsReviewEnforcement({ specialistCallCount: 2, reviewRounds: 0 })).toBe(true);
    expect(needsReviewEnforcement({ specialistCallCount: 0, reviewRounds: 0, isError: false })).toBe(false);
    expect(needsReviewEnforcement({ specialistCallCount: 2, reviewRounds: 1, isError: false })).toBe(false);
  });
});

describe('EVIDENCE_HEADING and contractual review prompts', () => {
  it('injects the exact contractual EVIDENCE_HEADING into the adapter and enforcement prompt', () => {
    expect(EVIDENCE_HEADING).toBe('## Evidence gathered by the specialists (the ONLY basis for validation)');
    expect(REVIEW_ENFORCEMENT_PROMPT).toContain(EVIDENCE_HEADING);
    const src = readFileSync(new URL('../src/agent/orchestration.ts', import.meta.url), 'utf8');
    expect(src).toContain(EVIDENCE_HEADING);
  });
});

