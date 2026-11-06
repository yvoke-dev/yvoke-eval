import { UserError, type EvalQuestion, type ThinkingLevel } from '../types';
import type { EvalTask } from './AnswerBundle';
import type { PromptSource } from '../mcp/McpPrompts';

export interface BuildTaskOptions {
  answerModel: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Build one EvalTask by resolving the question's self-contained playbook from
 * MCP and setting it directly as the LLM system prompt.
 *
 * The user query (modelContent) contains only q.question without playbook text prepended.
 */
export async function buildEvalTask(
  q: EvalQuestion,
  prompts: PromptSource,
  opts: BuildTaskOptions,
): Promise<EvalTask> {
  let systemPrompt: string | null = null;
  let playbookTools: string[] | undefined;
  let codeExecution = true;
  let playbookVersion: number | null = null;

  if (q.playbook) {
    const list = await prompts.list();
    const info = list.find((p) => p.name === q.playbook);
    playbookTools = info?.tools;
    codeExecution = info?.codeExecution !== false;
    playbookVersion = info?.version ?? null;
    const template = await prompts.getText(q.playbook);
    if (!template || template.trim().length === 0) {
      throw new UserError(`Playbook "${q.playbook}" returned empty instructions.`);
    }
    systemPrompt = template.trim();
  }

  return {
    question: q,
    modelContent: q.question,
    answerModel: opts.answerModel,
    systemPrompt,
    playbookTools,
    thinkingLevel: opts.thinkingLevel,
    codeExecution,
    playbookVersion,
  };
}
