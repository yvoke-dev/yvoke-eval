import { describe, it, expect } from 'vitest';
import { mcpTool } from './fixtures';
import { buildAllowedTools, buildCanUseTool, builtinTools, type CanUseToolOptions } from '../src/agent/policy';
import { COMPUTE_TOOLS } from '../src/agent/computeTools';

describe('buildAllowedTools', () => {
  it('prefixes playbook tools and appends ToolSearch + the compute tools', () => {
    const a = buildAllowedTools(['search_corpus', 'get_section'], true);
    expect(a).toContain(mcpTool('search_corpus'));
    expect(a).toContain(mcpTool('get_section'));
    expect(a).toContain('ToolSearch');
    expect(a).toEqual(expect.arrayContaining(COMPUTE_TOOLS));
  });

  // Production hard-blocks the shell (desktop AgentService: disallowedTools:['Bash']) so injected
  // corpus content can never reach one. codeExecution grants calculate/statistics/date_diff instead.
  it('never grants Bash, whatever the playbook declares', () => {
    expect(buildAllowedTools(['search_corpus'], true)).not.toContain('Bash');
    expect(buildAllowedTools(undefined, true)).not.toContain('Bash');
    expect(buildAllowedTools(['Bash'], true)).not.toContain('Bash');
  });

  it('withholds the compute tools when the playbook sets codeExecution:false', () => {
    const a = buildAllowedTools(['search_corpus'], false);
    for (const t of COMPUTE_TOOLS) expect(a).not.toContain(t);
  });

  it('excludes ask_clarifying_question so canUseTool can gate + capture it', () => {
    const a = buildAllowedTools(['ask_clarifying_question', 'search_corpus'], false);
    expect(a.some((t) => t.endsWith('ask_clarifying_question'))).toBe(false);
    expect(a).toContain(mcpTool('search_corpus'));
  });

  it('falls back to the default tool set when the playbook declares none', () => {
    const a = buildAllowedTools(undefined, true);
    expect(a).toContain(mcpTool('search_corpus'));
    expect(a).toContain(mcpTool('search_graph_entities'));
  });

  it('does not double-prefix already-qualified tools', () => {
    const a = buildAllowedTools([mcpTool('search_corpus')], true);
    expect(a.filter((t) => t.includes('search_corpus'))).toEqual([mcpTool('search_corpus')]);
  });

  // Playbooks are stored server-side and may predate the current alias. Re-namespacing them (rather
  // than only recognising the current prefix) is what stops a stale name from being prefixed twice
  // into mcp__yvoke__mcp__oim__search_corpus and then silently denied.
  it('re-namespaces a tool qualified under a previous server alias', () => {
    const a = buildAllowedTools(['mcp__oim__search_corpus'], true);
    expect(a.filter((t) => t.includes('search_corpus'))).toEqual([mcpTool('search_corpus')]);
  });

  // undefined = "declares no list" -> defaults. [] = "declares an empty list" -> nothing.
  // mapSpecialistTools used to collapse these, so the same metadata meant opposite things per mode.
  it('distinguishes an undeclared tool list from a declared-empty one', () => {
    expect(buildAllowedTools(undefined, false)).toContain(mcpTool('search_corpus'));
    expect(buildAllowedTools([], false)).toEqual(['ToolSearch']);
  });
});

/**
 * buildCanUseTool is the only thing in the harness that permits or refuses anything at runtime, and
 * it had no tests at all — which is why a blanket `startsWith('mcp__<alias>__') -> allow` survived,
 * voiding every playbook's tool declaration. The tests above only ever covered which tools get
 * PRE-approved, which reads like coverage of a contract it never checked.
 */
describe('buildCanUseTool', () => {
  // A playbook scoped to corpus search, with code execution off.
  const allowed = buildAllowedTools(['search_corpus', 'ask_clarifying_question'], false);
  const ctx = {} as never;

  function policy(opts: CanUseToolOptions = {}) {
    const asked: Array<{ question: string; options: string[] }> = [];
    const canUse = buildCanUseTool(allowed, (question, options) => asked.push({ question, options }), opts);
    return { canUse, asked };
  }

  // CanUseTool is declared as Promise<PermissionResult | null>; ours never returns null, and a
  // null would fail these assertions rather than pass them silently.
  const behaviorOf = async (tool: string, opts: CanUseToolOptions = {}, input: unknown = {}) =>
    (await policy(opts).canUse(tool, input as never, ctx))?.behavior;

  it('allows a tool the playbook declared', async () => {
    expect(await behaviorOf(mcpTool('search_corpus'))).toBe('allow');
  });

  // THE regression. Every knowledge-base tool is offered to the model whatever the playbook says —
  // allowedTools does not hide MCP tools and disallowedTools cannot either — so if this returns
  // allow, the declaration means nothing and a scoped playbook is measuring something else.
  it('denies a knowledge-base tool the playbook did not declare', async () => {
    expect(await behaviorOf(mcpTool('query_json_objects'))).toBe('deny');
    expect(await behaviorOf(mcpTool('get_graph_neighbors'))).toBe('deny');
    expect(await behaviorOf(mcpTool('list_documents'))).toBe('deny');
  });

  it('denies Bash even for a playbook that declares code execution', async () => {
    expect(await behaviorOf('Bash')).toBe('deny');
    const withCompute = buildCanUseTool(buildAllowedTools(['search_corpus'], true), () => {});
    expect((await withCompute('Bash', {} as never, ctx))?.behavior).toBe('deny');
  });

  // The compute tools are always EXPOSED — they come from an MCP server, and those cannot be hidden
  // — so codeExecution can only be honoured here, at the callback.
  it('gates the compute tools on codeExecution', async () => {
    const off = buildCanUseTool(buildAllowedTools(['search_corpus'], false), () => {});
    const on = buildCanUseTool(buildAllowedTools(['search_corpus'], true), () => {});
    for (const t of COMPUTE_TOOLS) {
      expect((await off(t, {} as never, ctx))?.behavior).toBe('deny');
      expect((await on(t, {} as never, ctx))?.behavior).toBe('allow');
    }
  });

  it('denies built-ins the playbook never declared', async () => {
    expect(await behaviorOf('Read')).toBe('deny');
    expect(await behaviorOf('WebFetch')).toBe('deny');
  });

  // Single mode: nothing declares Task, and a sub-agent's tool calls never reach capture there
  // (no forwardSubagentText), so an answer built by delegation grades with an empty tool trace.
  it('denies delegation unless it is part of the design', async () => {
    expect(await behaviorOf('Task')).toBe('deny');
    expect(await behaviorOf('Agent')).toBe('deny');
    expect(await behaviorOf('Task', { allowDelegation: true })).toBe('allow');
    expect(await behaviorOf('Agent', { allowDelegation: true })).toBe('allow');
  });

  it('captures a clarifying question and denies the tool, so the run stops instead of hanging', async () => {
    const p = policy();
    const r = await p.canUse(mcpTool('ask_clarifying_question'), { question: 'which version?', options: ['9.2', '9.3'] } as never, ctx);
    expect(r?.behavior).toBe('deny');
    expect(p.asked).toEqual([{ question: 'which version?', options: ['9.2', '9.3'] }]);
  });

  // Playbooks are stored server-side and may predate the current alias; capture must still fire.
  it('captures the clarify tool under a previous server alias', async () => {
    const p = policy();
    await p.canUse('mcp__oim__ask_clarifying_question', { question: 'q' } as never, ctx);
    expect(p.asked).toHaveLength(1);
  });

  it('grants nothing but ToolSearch to a playbook that declares an empty tool list', async () => {
    const empty = buildCanUseTool(buildAllowedTools([], false), () => {});
    expect((await empty(mcpTool('search_corpus'), {} as never, ctx))?.behavior).toBe('deny');
    expect((await empty('ToolSearch', {} as never, ctx))?.behavior).toBe('allow');
  });
});

/**
 * The availability layer. Without the SDK's `tools` option the model is offered all 33 built-ins —
 * Edit, Write, WebSearch, Task, CronCreate and the rest — on a retrieval eval; canUseTool refuses
 * them, but only after the model has spent a turn discovering that.
 */
describe('builtinTools', () => {
  it('exposes only the built-ins the permission layer already permits', () => {
    expect(builtinTools(buildAllowedTools(['search_corpus'], false))).toEqual(['ToolSearch']);
    // The compute tools are mcp__-prefixed, so they are not built-ins to narrow.
    expect(builtinTools(buildAllowedTools(['search_corpus'], true))).toEqual(['ToolSearch']);
  });

  // `tools` narrows the SDK's own registry only. Verified live: with tools:[] the model was still
  // offered all ten knowledge-base tools, which is why canUseTool has to be the enforcement point.
  it('never withholds knowledge-base tools, since narrowing them is impossible anyway', () => {
    const allowed = buildAllowedTools(['search_corpus', 'get_section'], true);
    expect(builtinTools(allowed).some((t) => t.startsWith('mcp__'))).toBe(false);
  });

  // The orchestrator's only job is delegation, so losing Task here would break mas outright.
  it('keeps Task for a mas session', () => {
    expect(builtinTools(['Task', mcpTool('search_corpus'), 'ToolSearch', COMPUTE_TOOLS[0]!])).toEqual([
      'Task',
      'ToolSearch',
    ]);
  });

  // Exposure ⊆ permission, by construction: both are derived from the same list, so a tool cannot be
  // put in front of the model that canUseTool would then refuse.
  it('cannot expose a built-in that canUseTool would deny', async () => {
    const allowed = buildAllowedTools(['search_corpus'], false);
    const canUse = buildCanUseTool(allowed, () => {});
    for (const t of builtinTools(allowed)) {
      expect((await canUse(t, {} as never, {} as never))?.behavior).toBe('allow');
    }
  });
});
