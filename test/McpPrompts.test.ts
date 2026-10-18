import { describe, it, expect } from 'vitest';
import { retryOnce, parsePromptInfo } from '../src/mcp/McpPrompts';

/**
 * The server expires idle MCP sessions, and a run leaves this connection idle for the 40-60s the
 * model spends on each question. Before this retry existed, the first expiry poisoned the rest of
 * the run: a 7-question category came back 2 PASS / 5 ERROR, every failure `Session not found` in
 * ~20ms against the same dead session id, never reaching the model.
 */
describe('retryOnce', () => {
  /** connect() hands out a new client id each time, so a test can see WHICH one the op ran on. */
  function harness(failUntilCall: number) {
    const events: string[] = [];
    let connections = 0;
    const connect = async () => {
      connections++;
      events.push(`connect#${connections}`);
      return `client#${connections}`;
    };
    const reset = async () => {
      events.push('reset');
    };
    let calls = 0;
    const op = async (client: string) => {
      calls++;
      events.push(`op(${client})`);
      if (calls <= failUntilCall) throw new Error('Session not found: dead');
      return `ok on ${client}`;
    };
    return { events, connect, reset, op };
  }

  it('runs on the cached connection and does not reconnect when the op succeeds', async () => {
    const h = harness(0);
    await expect(retryOnce(h.op, h.connect, h.reset)).resolves.toBe('ok on client#1');
    expect(h.events).toEqual(['connect#1', 'op(client#1)']);
  });

  // The heart of it: the retry must run against a FRESH client. Retrying on the same dead session
  // would reproduce the bug while looking like a fix.
  it('drops the dead connection and retries on a new one', async () => {
    const h = harness(1);
    await expect(retryOnce(h.op, h.connect, h.reset)).resolves.toBe('ok on client#2');
    expect(h.events).toEqual(['connect#1', 'op(client#1)', 'reset', 'connect#2', 'op(client#2)']);
  });

  it('gives up after one retry rather than looping', async () => {
    const h = harness(Number.MAX_SAFE_INTEGER);
    await expect(retryOnce(h.op, h.connect, h.reset)).rejects.toThrow('Session not found');
    expect(h.events.filter((e) => e.startsWith('op('))).toHaveLength(2);
    expect(h.events.filter((e) => e === 'reset')).toHaveLength(1);
  });
});

describe('parsePromptInfo — metadata parsing', () => {
  it('parses systemPrompt from _meta.systemPrompt', () => {
    const info = parsePromptInfo({
      name: 'playbook-1',
      title: 'Playbook 1',
      description: 'Desc',
      _meta: { systemPrompt: 'coding-chat' },
    });
    expect(info.systemPrompt).toBe('coding-chat');
  });

  it('parses systemPrompt from _meta.system_prompt', () => {
    const info = parsePromptInfo({
      name: 'playbook-2',
      _meta: { system_prompt: 'coding-chat' },
    });
    expect(info.systemPrompt).toBe('coding-chat');
  });

  it('parses systemPrompt from meta.systemPrompt and meta.system_prompt', () => {
    const info1 = parsePromptInfo({
      name: 'playbook-3',
      meta: { systemPrompt: 'my-chat' },
    });
    expect(info1.systemPrompt).toBe('my-chat');

    const info2 = parsePromptInfo({
      name: 'playbook-4',
      meta: { system_prompt: 'my-chat-2' },
    });
    expect(info2.systemPrompt).toBe('my-chat-2');
  });

  it('trims whitespace and returns undefined if empty or whitespace-only', () => {
    const info1 = parsePromptInfo({
      name: 'playbook-5',
      _meta: { systemPrompt: '  ' },
    });
    expect(info1.systemPrompt).toBeUndefined();

    const info2 = parsePromptInfo({
      name: 'playbook-6',
      _meta: {},
    });
    expect(info2.systemPrompt).toBeUndefined();
  });

  it('parses integer version from _meta.version and meta.version', () => {
    expect(
      parsePromptInfo({
        name: 'playbook-v2',
        _meta: { version: 2 },
      }).version,
    ).toBe(2);

    expect(
      parsePromptInfo({
        name: 'playbook-v3',
        meta: { version: 3 },
      }).version,
    ).toBe(3);

    expect(
      parsePromptInfo({
        name: 'playbook-no-version',
        _meta: {},
      }).version,
    ).toBeUndefined();
  });
});

