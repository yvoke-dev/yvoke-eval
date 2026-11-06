import { describe, it, expect } from 'vitest';
import { buildEvalTask } from '../src/agent/buildTask';
import { UserError } from '../src/types';
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

  it('throws UserError when playbook template text is empty or whitespace', async () => {
    const q = mkQuestion({ playbook: 'demo-basics' });
    const prompts = mkPrompts([{ name: 'demo-basics', title: 'Basics', description: '' }], '   \n  ');
    await expect(
      buildEvalTask(q, prompts, {
        answerModel: 'sonnet',
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow(new UserError('Playbook "demo-basics" returned empty instructions.'));
  });
});
