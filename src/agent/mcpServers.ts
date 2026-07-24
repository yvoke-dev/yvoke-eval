import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { buildComputeServer } from './computeServer';
import { COMPUTE_SERVER_NAME } from './computeTools';

export interface McpTarget {
  serverBaseUrl: string;
  bearer: string;
  transport: 'http' | 'sse';
}

/**
 * Alias for the MCP connection, which becomes the `mcp__<name>__` prefix on every tool the SDK
 * exposes. It names the PRODUCT's MCP server, not a knowledge base: every knowledge base is served
 * by the same /mcp endpoint and selected by collection and playbook, so this is deliberately not
 * per-KB configuration. Keep it a single token — clients strip the prefix with `mcp__[^_]+__`.
 */
export const MCP_SERVER_NAME = 'yvoke';

const QUALIFIED = /^mcp__[^_]+__/;

/**
 * Qualify a playbook-declared tool name with the current server prefix.
 *
 * Playbooks are stored server-side and may name tools bare (`search_corpus`) or already qualified
 * under whatever alias was current when they were written (`mcp__oim__search_corpus`). Re-namespace
 * rather than testing for the current prefix only: a stale prefix would otherwise fail the test, get
 * prefixed a second time into `mcp__yvoke__mcp__oim__search_corpus`, and be silently denied.
 */
export function qualifyTool(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool.replace(QUALIFIED, '')}`;
}

/**
 * Knowledge-base tools granted when a playbook declares none. Stored bare and qualified at use, so
 * the list cannot drift out of sync with the server prefix. Single source of truth for both the
 * single-agent allow-list (policy.ts) and specialist allow-lists (orchestration.ts) — keeping two
 * copies is what let the desktop client's two lists diverge.
 */
export const DEFAULT_KB_TOOLS = [
  'query_json_objects',
  'get_section',
  'get_graph_neighbors',
  'verify_citations',
  'list_documents',
  'get_toc',
  'search_graph_entities',
  'get_json_schema',
  'search_corpus',
];

/**
 * The Agent SDK mcpServers config (ported from desktop): the yvoke MCP endpoint, plus the in-process
 * compute server that stands in for `Bash`.
 *
 * Registering compute unconditionally is deliberate, and matches how every other tool works here: an
 * MCP server's tools cannot be hidden from the model, so availability is not the gate — canUseTool
 * is. A playbook with `codeExecution: false` sees the compute tools and is refused when it calls one.
 */
export function buildMcpServers(target: McpTarget): Record<string, McpServerConfig> {
  const url = `${target.serverBaseUrl.replace(/\/+$/, '')}/mcp`;
  return {
    [MCP_SERVER_NAME]: {
      type: target.transport,
      url,
      headers: { Authorization: `Bearer ${target.bearer}` },
    },
    [COMPUTE_SERVER_NAME]: buildComputeServer(),
  };
}
