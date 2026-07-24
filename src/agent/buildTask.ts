import type { EvalQuestion, ThinkingLevel } from '../types';
import type { EvalTask } from './AnswerBundle';
import type { PromptSource } from '../mcp/McpPrompts';

export interface BuildTaskOptions {
  answerModel: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string | null;
}

/**
 * Build one EvalTask by resolving the question's playbook from MCP. Each question is a fresh
 * single-turn conversation ("first use"), so — exactly like production — the playbook template is
 * prepended to the query, giving every provider identical model input.
 */
export async function buildEvalTask(
  q: EvalQuestion,
  prompts: PromptSource,
  opts: BuildTaskOptions,
): Promise<EvalTask> {
  let template = '';
  let playbookTools: string[] | undefined;
  let codeExecution = true;

  if (q.playbook) {
    const list = await prompts.list();
    const info = list.find((p) => p.name === q.playbook);
    playbookTools = info?.tools;
    codeExecution = info?.codeExecution !== false;
    template = await prompts.getText(q.playbook);
  }

  const modelContent =
    template && template.trim().length > 0 ? `${template}\n\n---\n\n${q.question}` : q.question;

  return {
    question: q,
    modelContent,
    answerModel: opts.answerModel,
    systemPrompt: opts.systemPrompt,
    playbookTools,
    thinkingLevel: opts.thinkingLevel,
    codeExecution,
  };
}
