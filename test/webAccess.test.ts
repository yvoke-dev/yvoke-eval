import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAutoApproveTools, buildAllowedTools, buildCanUseTool } from '../src/agent/policy';
import { builtinTool, qualifyTool } from '../src/agent/mcpServers';

const noClarify = (): void => {};

/**
 * A playbook declaring `WebSearch` had it rewritten to `mcp__yvoke__WebSearch` — a tool no server
 * serves — so `builtinTools()` dropped it for the `mcp__` prefix, the model was never offered it,
 * and `canUseTool` never saw it. The declaration was inert and the web tier did not exist in an
 * eval, while questions asserting it still passed because nothing checked the tool had fired.
 */
describe('qualifyTool — harness built-ins', () => {
  it('leaves runtime tools unprefixed so they can actually be offered', () => {
    expect(qualifyTool('WebSearch')).toBe('WebSearch');
    expect(qualifyTool('WebFetch')).toBe('WebFetch');
    expect(qualifyTool('ToolSearch')).toBe('ToolSearch');
  });

  it('accepts the casing a playbook author is likely to write', () => {
    expect(builtinTool('websearch')).toBe('WebSearch');
    expect(qualifyTool('websearch')).toBe('WebSearch');
  });

  it('still prefixes a server tool whose name merely resembles one', () => {
    expect(qualifyTool('web_search_corpus')).toBe('mcp__yvoke__web_search_corpus');
  });

  it('puts a declared WebSearch into the allow-list under its bare name', () => {
    const allowed = buildAllowedTools(['search_corpus', 'WebSearch']);
    expect(allowed).toContain('WebSearch');
    expect(allowed).not.toContain('mcp__yvoke__WebSearch');
  });
});

/**
 * The harness had no domain gate at all, so a granted WebSearch reached the open web while
 * production injects `allowed_domains` on every call. A verdict is only worth having if the answer
 * was produced under the constraints that ship — and search results are exactly where a wider net
 * changes the answer.
 */
describe('canUseTool — web access under the deployment allow-list', () => {
  const allowed = buildAllowedTools(['search_corpus', 'WebSearch']);
  const domains = ['support.oneidentity.com', 'www.oneidentity.com/community/'];

  it('injects the configured hosts into every WebSearch call', async () => {
    const canUse = buildCanUseTool(allowed, noClarify, { webAllowedDomains: domains });
    const r = (await canUse('WebSearch', { query: 'defect 4380945' }, {} as never))!;
    expect(r.behavior).toBe('allow');
    // Bare hosts: the API takes domains and cannot express the path an entry may carry.
    expect((r as unknown as { updatedInput: { allowed_domains: string[] } }).updatedInput.allowed_domains).toEqual([
      'support.oneidentity.com',
      'www.oneidentity.com',
    ]);
  });

  it('overrides model-supplied domains rather than trusting them', async () => {
    const canUse = buildCanUseTool(allowed, noClarify, { webAllowedDomains: domains });
    const r = (await canUse('WebSearch', { query: 'x', allowed_domains: ['evil.example'] }, {} as never))!;
    const injected = (r as unknown as { updatedInput: { allowed_domains: string[] } }).updatedInput.allowed_domains;
    expect(injected).not.toContain('evil.example');
  });

  it('fails closed when no domains are configured', async () => {
    const canUse = buildCanUseTool(allowed, noClarify, {});
    const r = (await canUse('WebSearch', { query: 'x' }, {} as never))!;
    expect(r.behavior).toBe('deny');
    expect((r as { message: string }).message).toMatch(/no allowed domains/i);
  });

  it('refuses WebFetch with the reason, rather than returning a blank page to narrate', async () => {
    const withFetch = buildAllowedTools(['search_corpus', 'WebFetch']);
    const canUse = buildCanUseTool(withFetch, noClarify, { webAllowedDomains: domains });
    const r = (await canUse('WebFetch', { url: 'https://support.oneidentity.com/kb/4380945/x' }, {} as never))!;
    expect(r.behavior).toBe('deny');
    expect((r as { message: string }).message).toMatch(/empty page|WebSearch/i);
  });

  it('still denies a web tool the playbook never declared', async () => {
    const corpusOnly = buildAllowedTools(['search_corpus']);
    const canUse = buildCanUseTool(corpusOnly, noClarify, { webAllowedDomains: domains });
    const r = (await canUse('WebSearch', { query: 'x' }, {} as never))!;
    expect(r.behavior).toBe('deny');
    expect((r as { message: string }).message).toMatch(/not allowed for this playbook/i);
  });
});

/**
 * The wiring, not just the function. E6 added the domain gate to canUseTool and `webAccess` tests
 * proved the gate works — while both runners put `WebSearch` on the SDK's bare `allowedTools`, which
 * auto-approves it and skips the callback entirely. Every eval that reached the web tier therefore
 * searched the open internet, and no test noticed, because every test called `buildCanUseTool` itself.
 * These two assert the reduction exists AND that the runners are the ones applying it.
 */
describe('buildAutoApproveTools — web tools are granted but never pre-approved', () => {
  it('strips WebSearch/WebFetch and keeps everything else in order', () => {
    const grant = ['mcp__yvoke__search_corpus', 'WebSearch', 'ToolSearch', 'WebFetch', 'mcp__compute__calculate'];
    expect(buildAutoApproveTools(grant)).toEqual([
      'mcp__yvoke__search_corpus',
      'ToolSearch',
      'mcp__compute__calculate',
    ]);
  });

  it('is what both runners hand the SDK, while canUseTool still gets the full grant', () => {
    // Source-level on purpose: the defect was never in a function's return value, it was in which
    // value reached `Options.allowedTools`. A unit test on the function alone cannot see that.
    for (const file of ['src/agent/SdkAnswerRunner.ts', 'src/agent/MasAnswerRunner.ts']) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(src, `${file}: allowedTools must be the reduced list`).toMatch(
        /allowedTools:\s*buildAutoApproveTools\(/,
      );
      // canUseTool is built from the unreduced grant — that is the list the playbook gate compares.
      expect(src, `${file}: canUseTool must receive the full grant`).not.toMatch(
        /buildCanUseTool\(\s*buildAutoApproveTools/,
      );
    }
  });
});

/**
 * Reachability. The roster check lives in canUseTool, and `Task` was on the SDK's bare `allowedTools`
 * — which auto-approves before the callback runs. So the check would have been dead code, exactly as
 * the WebSearch domain gate was: unit-tested, passing, and never invoked. The SDK said so in the
 * 3 Sep run: "canUseTool will not be invoked for: Task, …".
 */
describe('delegation reaches canUseTool', () => {
  it('keeps Task and Agent off the auto-approved list', () => {
    const grant = ['Task', 'Agent', 'mcp__yvoke__search_corpus', 'ToolSearch', 'WebSearch'];
    const auto = buildAutoApproveTools(grant);
    expect(auto).not.toContain('Task');
    expect(auto).not.toContain('Agent');
    // Still granted and still offered to the model — it just has to ask now.
    expect(auto).toContain('mcp__yvoke__search_corpus');
    expect(auto).toContain('ToolSearch');
  });

  it('the mas runner supplies the roster, so the gate is never a no-op', () => {
    // Source-level for the same reason as the allowedTools assertion above: the defect would be in
    // which value reaches the callback, which a unit test on the policy cannot see. An omitted
    // roster fails closed, so this failing means delegation stops entirely — loudly, not silently.
    const src = readFileSync(new URL('../src/agent/MasAnswerRunner.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/delegationRoster:\s*\[\s*\.\.\.this\.orch\.specialistNames,\s*REVIEWER_SUBAGENT\s*\]/);
  });
});
