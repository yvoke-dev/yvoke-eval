import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Direct MCP access to the server: prompts/list + prompts/get for the SKILL.md playbooks (the Agent
 * SDK exposes server *tools* but not server *prompts*, so we resolve them ourselves). Ported from
 * yvoke-desktop/src/main/agent/McpPrompts.ts, minus the citation-lookup path and cache.
 */
export interface McpPromptInfo {
  name: string;
  title: string;
  description: string;
  tools?: string[];
  codeExecution?: boolean;
  systemPrompt?: string;
  version?: number;
}

export interface McpPromptsOptions {
  serverBaseUrl: string;
  bearer: string;
  transport: 'http' | 'sse';
}

/**
 * What consumers actually need from McpPrompts. Depending on the port rather than the class lets a
 * test supply a plain object and keeps runSuite runnable without a server.
 */
export interface PromptSource {
  list(): Promise<McpPromptInfo[]>;
  getText(name: string, args?: Record<string, string>): Promise<string>;
  serverVersion(): { name?: string; version?: string } | undefined;
  close(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Parses raw MCP prompt payload into McpPromptInfo.
 * Standalone and generic so metadata extraction is unit-testable without a live server.
 */
export function parsePromptInfo(p: unknown): McpPromptInfo {
  const raw = p as {
    name: string;
    title?: string;
    description?: string;
    meta?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  const meta = raw.meta ?? raw._meta;
  const rawPrompt =
    raw._meta?.systemPrompt ??
    raw._meta?.system_prompt ??
    raw.meta?.systemPrompt ??
    raw.meta?.system_prompt;
  const systemPrompt =
    typeof rawPrompt === 'string' && rawPrompt.trim().length > 0 ? rawPrompt.trim() : undefined;
  const rawVersion = raw._meta?.version ?? raw.meta?.version;
  const version =
    typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 1
      ? rawVersion
      : undefined;

  return {
    name: raw.name,
    title: raw.title ?? raw.name,
    description: raw.description ?? '',
    tools: Array.isArray(meta?.tools) ? (meta!.tools as unknown[]).map(String) : undefined,
    codeExecution: typeof meta?.codeExecution === 'boolean' ? (meta.codeExecution as boolean) : undefined,
    systemPrompt,
    version,
  };
}

/**
 * Run an operation on a cached connection, dropping it and reconnecting once if it fails.
 *
 * The server expires idle MCP sessions, and a run leaves this connection idle for the 40-60s the
 * model spends answering each question. Without this, the first expiry poisoned the rest of the run:
 * every later question failed in ~20ms with `Session not found` before reaching the model, so a
 * 7-question category came back 2 PASS / 5 ERROR. Desktop's McpPrompts has always had this; the port
 * dropped it and said so only about the citation path and the cache.
 *
 * Standalone and generic so the retry is unit-testable without a live server.
 */
export async function retryOnce<C, T>(
  op: (client: C) => Promise<T>,
  connect: () => Promise<C>,
  reset: () => Promise<void>,
): Promise<T> {
  try {
    return await op(await connect());
  } catch {
    await reset();
    return op(await connect());
  }
}

export class McpPrompts implements PromptSource {
  private client: Client | null = null;
  private version: { name?: string; version?: string } | undefined;

  constructor(private readonly opts: McpPromptsOptions) {}

  async list(): Promise<McpPromptInfo[]> {
    const res = await this.run((client) => client.listPrompts(undefined, { timeout: REQUEST_TIMEOUT_MS }));
    return res.prompts.map(parsePromptInfo);
  }

  /** The prompt's messages concatenated into a single playbook string. */
  async getText(name: string, args: Record<string, string> = {}): Promise<string> {
    const res = await this.run((client) =>
      client.getPrompt({ name, arguments: args }, { timeout: REQUEST_TIMEOUT_MS }),
    );
    return res.messages
      .map((m) => {
        const c = m.content as { type?: string; text?: string };
        return c && typeof c === 'object' && c.type === 'text' ? String(c.text) : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  serverVersion(): { name?: string; version?: string } | undefined {
    return this.version;
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
  }

  private run<T>(op: (client: Client) => Promise<T>): Promise<T> {
    return retryOnce(op, () => this.connect(), () => this.close());
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const url = new URL(`${this.opts.serverBaseUrl.replace(/\/+$/, '')}/mcp`);
    const headers = { Authorization: `Bearer ${this.opts.bearer}` };
    const client = new Client({ name: 'yvoke-eval', version: '0.1.0' });
    await client.connect(this.buildTransport(url, headers));
    this.version = client.getServerVersion() ?? undefined;
    this.client = client;
    return client;
  }

  private buildTransport(url: URL, headers: Record<string, string>): Transport {
    if (this.opts.transport === 'http') {
      return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    }
    return new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
      },
    });
  }
}
