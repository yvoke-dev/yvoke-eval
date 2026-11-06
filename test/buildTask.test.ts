import { describe, it, expect } from 'vitest';
import { buildEvalTask } from '../src/agent/buildTask';
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

describe('buildEvalTask — Standalone Playbook Instructions', () => {
  it('passes playbook text directly as systemPrompt and forwards playbookVersion', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts([{ name: 'demo-basics', title: 'Basics', description: '', version: 2 }], 'PLAYBOOK TEXT');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
    });

    expect(task.systemPrompt).toBe('PLAYBOOK TEXT');
    expect(task.modelContent).toBe(q.question);
    expect(task.playbookVersion).toBe(2);
    expect(task.systemPromptName).toBeNull();
    expect(task.systemPromptFallback).toBe(false);
  });

  it('sets systemPrompt to null when question has no playbook', async () => {
    const q = mkQuestion({ playbook: null });
    const prompts = mkPrompts([], 'PLAYBOOK TEXT');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
    });

    expect(task.systemPrompt).toBeNull();
    expect(task.modelContent).toBe(q.question);
  });

  it('sets systemPrompt to null when playbook template text is empty or whitespace', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts([{ name: 'demo-basics', title: 'Basics', description: '' }], '   \n  ');
    const task = await buildEvalTask(q, prompts, {
      answerModel: 'sonnet',
      thinkingLevel: 'low',
    });

    expect(task.systemPrompt).toBeNull();
    expect(task.modelContent).toBe(q.question);
  });
});
