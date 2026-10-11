import { UserError } from '../types';

/**
 * The base system prompt over the server's REST API — deliberately NOT MCP.
 *
 * MCP `prompts/*` carries the playbooks. The base chat prompt is a separate concern served by
 * `DesktopSyncController` at `/api/chat/v1/prompts/system/{name}`, which is what yvoke-desktop's
 * `SyncClient.getSystemPrompt` calls. The harness used to ask MCP for it and swallow the resulting
 * "unknown prompt" error, so every run — and every baseline — was answered with the SDK default
 * system prompt while production ran with the server's.
 *
 * Same base URL and bearer as MCP: the two Spring filter chains (`/mcp/**` and `/api/chat/**`)
 * require identical authorities, so no extra credential is needed.
 */
export interface SystemPromptClientOptions {
  serverBaseUrl: string;
  bearer: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 15_000;
const API_PREFIX = '/api/chat/v1';

/**
 * The base chat prompt. Not a stored prompt name but an alias: the server resolves it through
 * `getDefaultChatPromptName()` to whichever prompt is currently active, so the eval always tracks
 * the deployed one. Hardcoded rather than configurable — like the endpoint path, it is a yvoke-server
 * convention, not a knowledge-base one.
 */
export const SYSTEM_PROMPT_NAME = 'default-chat';

export class SystemPromptClient {
  private readonly fetchFn: typeof fetch;
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly opts: SystemPromptClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /**
   * The named system prompt, or null when the server has none configured under that name.
   *
   * Null and failure are different answers and are kept apart on purpose. The endpoint answers 200
   * with an empty string for a name it does not know (see the `orElse("")` in the controller), so
   * empty means "no prompt configured" — a legitimate state to run in. Anything else means we could
   * not ask the question, and degrading quietly there would produce a run that is comparable neither
   * to production nor to the baseline.
   */
  async get(name: string): Promise<string | null> {
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    const url = `${this.opts.serverBaseUrl.replace(/\/+$/, '')}${API_PREFIX}/prompts/system/${encodeURIComponent(name)}`;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.opts.bearer}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new UserError(
        `Could not reach the system-prompt endpoint at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!res.ok) {
      throw new UserError(`System-prompt endpoint ${url} returned HTTP ${res.status}.`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      throw new UserError(
        `System-prompt endpoint ${url} returned a non-JSON body: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const prompt = (body as { systemPrompt?: unknown } | null)?.systemPrompt;
    if (typeof prompt !== 'string') {
      throw new UserError(`System-prompt endpoint ${url} returned no "systemPrompt" string.`);
    }

    const result = prompt.trim() ? prompt : null;
    this.cache.set(name, result);
    return result;
  }
}
