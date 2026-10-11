import { describe, it, expect } from 'vitest';
import { SystemPromptClient, SYSTEM_PROMPT_NAME } from '../src/server/SystemPromptClient';
import { UserError } from '../src/types';

/** A fetch stub that records the call and replies with whatever the test hands it. */
function stubFetch(reply: Response | (() => never)): { fetchFn: typeof fetch; calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init ?? {}]);
    if (typeof reply === 'function') reply();
    return reply;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(reply: Response | (() => never), serverBaseUrl = 'http://localhost:8080') {
  const { fetchFn, calls } = stubFetch(reply);
  return { c: new SystemPromptClient({ serverBaseUrl, bearer: 'tok', fetchFn }), calls };
}

describe('SystemPromptClient', () => {
  it('calls the REST endpoint, not MCP, and returns the prompt', async () => {
    const { c, calls } = client(json({ systemPrompt: 'You are grounded.' }));
    await expect(c.get(SYSTEM_PROMPT_NAME)).resolves.toBe('You are grounded.');

    const [url, init] = calls[0]!;
    expect(url).toBe('http://localhost:8080/api/chat/v1/prompts/system/default-chat');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('caches successful resolutions in memory to avoid repeated requests', async () => {
    const { c, calls } = client(json({ systemPrompt: 'cached prompt' }));
    await expect(c.get('cached-prompt')).resolves.toBe('cached prompt');
    await expect(c.get('cached-prompt')).resolves.toBe('cached prompt');
    expect(calls).toHaveLength(1);
  });

  it('does not double up slashes on a base url with a trailing slash', async () => {
    const { c, calls } = client(json({ systemPrompt: 'x' }), 'http://localhost:8080/');
    await c.get('a-name');
    expect(calls[0]![0]).toBe('http://localhost:8080/api/chat/v1/prompts/system/a-name');
  });

  // The server answers 200 + "" for a name it does not know, so empty is "none configured" —
  // a legitimate state — while every other failure means we could not ask at all.
  it('returns null when the server has no such prompt', async () => {
    const { c } = client(json({ systemPrompt: '' }));
    await expect(c.get(SYSTEM_PROMPT_NAME)).resolves.toBeNull();
  });

  it('treats a whitespace-only prompt as none configured', async () => {
    const { c } = client(json({ systemPrompt: '   \n ' }));
    await expect(c.get(SYSTEM_PROMPT_NAME)).resolves.toBeNull();
  });

  it('fails loudly on an HTTP error rather than silently degrading', async () => {
    const { c } = client(json({}, 401));
    await expect(c.get(SYSTEM_PROMPT_NAME)).rejects.toThrow(UserError);
    await expect(c.get(SYSTEM_PROMPT_NAME)).rejects.toThrow(/HTTP 401/);
  });

  it('fails loudly when the server is unreachable', async () => {
    const { c } = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(c.get(SYSTEM_PROMPT_NAME)).rejects.toThrow(UserError);
    await expect(c.get(SYSTEM_PROMPT_NAME)).rejects.toThrow(/Could not reach.*fetch failed/s);
  });

  it('fails loudly on a non-JSON body', async () => {
    const { c } = client(new Response('<html>nope</html>', { status: 200 }));
    await expect(c.get(SYSTEM_PROMPT_NAME)).rejects.toThrow(/non-JSON body/);
  });

  it('fails loudly when the payload has no systemPrompt string', async () => {
    const { c } = client(json({ prompt: 'wrong key' }));
    await expect(c.get(SYSTEM_PROMPT_NAME)).rejects.toThrow(/no "systemPrompt" string/);
  });
});
