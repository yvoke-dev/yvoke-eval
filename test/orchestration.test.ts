import { describe, it, expect } from 'vitest';
import { mcpTool } from './fixtures';
import {
  buildOrchestrator,
  mapSpecialistTools,
  ORCHESTRATOR_AGENT,
  REVIEWER_SUBAGENT,
  type OrchestratorProfile,
  type OrchestratorTuning,
} from '../src/agent/orchestration';
import type { McpPrompts, McpPromptInfo } from '../src/mcp/McpPrompts';
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
    expect(orch.prompt).toContain('PROMPT(oim-orchestrator)');
    expect(orch.prompt).toContain('oim-getting-started'); // roster
    expect(orch.tools).toContain('Task');
    expect(orch.model).toBe('opus');

    const specialist = r.agents['oim-getting-started'];
    expect(specialist.prompt).toContain('BASE'); // base system prompt layered under the playbook
    expect(specialist.prompt).toContain('PROMPT(oim-getting-started)');
    expect(specialist.model).toBe('sonnet');
    expect(specialist.tools).toContain(mcpTool('search_corpus'));
    expect(specialist.tools).not.toContain('Bash'); // never granted, whatever the playbook says

    expect(r.agents[REVIEWER_SUBAGENT].tools).toEqual([
      mcpTool('verify_citations'),
      mcpTool('get_section'),
    ]);
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
