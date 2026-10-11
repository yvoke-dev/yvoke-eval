import { describe, it, expect } from 'vitest';
import { buildEvalTask, resolvePlaybookSystemPrompt } from '../src/agent/buildTask';
import { SystemPromptClient } from '../src/server/SystemPromptClient';
import type { PromptSource, McpPromptInfo } from '../src/mcp/McpPrompts';
import { mkQuestion } from './fixtures';

function mkPrompts(promptsInfo: McpPromptInfo[] = [], text = 'PLAYBOOK TEXT'): PromptSource {
  return {
    list: async () => promptsInfo,
    getText: async () => text,
    serverVersion: () => undefined,
    close: async () => {},
  };
}

function stubSystemPromptClient(reply: Record<string, string | null | Error>) {
  const fetchFn = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    const name = decodeURIComponent(urlStr.split('/').pop() ?? '');
    const val = reply[name];
    if (val instanceof Error) {
      throw val;
    }
    if (val === undefined || val === null) {
      return new Response(JSON.stringify({ systemPrompt: '' }), { status: 200 });
    }
    return new Response(JSON.stringify({ systemPrompt: val }), { status: 200 });
  }) as unknown as typeof fetch;

  return new SystemPromptClient({
    serverBaseUrl: 'http://localhost:8080',
    bearer: 'tok',
    fetchFn,
  });
}

describe('buildEvalTask — Prompt Assembly & Clean User Message (R1)', () => {
  it('combines baseSystemPrompt and playbookText separated by \\n\\n---\\n\\n', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts([{ name: 'demo-basics', title: 'Basics', description: '' }], 'PLAYBOOK TEXT');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: 'GROUNDING RULES',
    });

    expect(task.systemPrompt).toBe('GROUNDING RULES\n\n---\n\nPLAYBOOK TEXT');
    expect(task.modelContent).toBe(q.question);
    expect(task.modelContent).not.toContain('PLAYBOOK TEXT');
  });

  it('leaves baseSystemPrompt as-is when question has no playbook', async () => {
    const q = mkQuestion({ playbook: null });
    const prompts = mkPrompts([], 'PLAYBOOK TEXT');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: 'GROUNDING RULES',
    });

    expect(task.systemPrompt).toBe('GROUNDING RULES');
    expect(task.modelContent).toBe(q.question);
  });

  it('leaves baseSystemPrompt as-is when playbook template text is empty or whitespace', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts([{ name: 'demo-basics', title: 'Basics', description: '' }], '   \n  ');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: 'GROUNDING RULES',
    });

    expect(task.systemPrompt).toBe('GROUNDING RULES');
    expect(task.modelContent).toBe(q.question);
  });

  it('uses only playbook text when baseSystemPrompt is null', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts([{ name: 'demo-basics', title: 'Basics', description: '' }], 'PLAYBOOK TEXT');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: null,
    });

    expect(task.systemPrompt).toBe('PLAYBOOK TEXT');
    expect(task.modelContent).toBe(q.question);
  });
});

describe('buildEvalTask & resolvePlaybookSystemPrompt — Designated System Prompt (R2)', () => {
  it('resolves designated system prompt when declared by playbook', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts(
      [{ name: 'demo-basics', title: 'Basics', description: '', systemPrompt: 'coding-chat' }],
      'PLAYBOOK TEXT',
    );
    const client = stubSystemPromptClient({
      'coding-chat': 'CODING GROUNDING',
      'default-chat': 'DEFAULT GROUNDING',
    });

    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: 'DEFAULT GROUNDING',
      systemPromptClient: client,
    });

    expect(task.systemPrompt).toBe('CODING GROUNDING\n\n---\n\nPLAYBOOK TEXT');
    expect(task.modelContent).toBe(q.question);
  });

  it('falls back to default-chat when designated system prompt resolution errors', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts(
      [{ name: 'demo-basics', title: 'Basics', description: '', systemPrompt: 'failing-chat' }],
      'PLAYBOOK TEXT',
    );
    const client = stubSystemPromptClient({
      'failing-chat': new Error('network failure'),
      'default-chat': 'DEFAULT GROUNDING',
    });

    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: 'DEFAULT GROUNDING',
      systemPromptClient: client,
    });

    expect(task.systemPrompt).toBe('DEFAULT GROUNDING\n\n---\n\nPLAYBOOK TEXT');
    expect(task.modelContent).toBe(q.question);
  });

  it('falls back to default-chat when designated system prompt is absent or empty', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts(
      [{ name: 'demo-basics', title: 'Basics', description: '', systemPrompt: 'missing-chat' }],
      'PLAYBOOK TEXT',
    );
    const client = stubSystemPromptClient({
      'missing-chat': null, // empty prompt
      'default-chat': 'DEFAULT GROUNDING',
    });

    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
      systemPrompt: 'DEFAULT GROUNDING',
      systemPromptClient: client,
    });

    expect(task.systemPrompt).toBe('DEFAULT GROUNDING\n\n---\n\nPLAYBOOK TEXT');
  });

  it('resolvePlaybookSystemPrompt helper handles custom prompt and fallbacks cleanly', async () => {
    const client = stubSystemPromptClient({
      custom: 'CUSTOM PROMPT',
      'default-chat': 'FALLBACK PROMPT',
    });

    // 1. Success with custom prompt
    await expect(resolvePlaybookSystemPrompt('custom', client, 'FALLBACK PROMPT')).resolves.toBe('CUSTOM PROMPT');

    // 2. Absent / empty custom prompt falls back to defaultPrompt
    await expect(resolvePlaybookSystemPrompt('nonexistent', client, 'FALLBACK PROMPT')).resolves.toBe('FALLBACK PROMPT');

    // 3. Undefined custom prompt uses defaultPrompt
    await expect(resolvePlaybookSystemPrompt(undefined, client, 'FALLBACK PROMPT')).resolves.toBe('FALLBACK PROMPT');

    // 4. Error on custom prompt falls back to defaultPrompt
    const failingClient = stubSystemPromptClient({
      broken: new Error('boom'),
      'default-chat': 'FALLBACK PROMPT',
    });
    await expect(resolvePlaybookSystemPrompt('broken', failingClient, 'FALLBACK PROMPT')).resolves.toBe('FALLBACK PROMPT');

    // 5. Explicit null fallback returns null and does NOT fall through to default-chat
    await expect(resolvePlaybookSystemPrompt(undefined, client, null)).resolves.toBeNull();
    await expect(resolvePlaybookSystemPrompt('nonexistent', client, null)).resolves.toBeNull();
  });
});
