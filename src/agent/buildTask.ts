import type { EvalQuestion, ThinkingLevel } from '../types';
import type { EvalTask } from './AnswerBundle';
import type { PromptSource } from '../mcp/McpPrompts';
import { SystemPromptClient, SYSTEM_PROMPT_NAME } from '../server/SystemPromptClient';

export interface BuildTaskOptions {
  answerModel: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string | null;
  systemPromptClient?: SystemPromptClient;
}

/**
 * Resolves the system prompt for a playbook.
 * If the playbook designates a custom system prompt name, attempts to load it via SystemPromptClient.
 * Falls back to default-chat (or defaultPrompt) when absent, empty, or on resolution error.
 */
export async function resolvePlaybookSystemPrompt(
  designatedName: string | undefined | null,
  client?: SystemPromptClient,
  defaultPrompt?: string | null,
): Promise<string | null> {
  const designated = designatedName?.trim();
  if (designated && designated !== SYSTEM_PROMPT_NAME && client) {
    try {
      const custom = await client.get(designated);
      if (custom && custom.trim().length > 0) {
        return custom;
      }
    } catch {
      // on resolution error, fall back to default-chat
    }
  }

  // Fallback to defaultPrompt if explicitly provided (even if null or empty)
  if (defaultPrompt !== undefined) {
    return defaultPrompt;
  }
  if (client) {
    try {
      return await client.get(SYSTEM_PROMPT_NAME);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build one EvalTask by resolving the question's playbook from MCP and combining the playbook
 * template text into the LLM system prompt: <systemPrompt>\n\n---\n\n<playbookText>.
 * The user query (modelContent) contains only q.question without playbook text prepended.
 */
export async function buildEvalTask(
  q: EvalQuestion,
  prompts: PromptSource,
  opts: BuildTaskOptions,
): Promise<EvalTask> {
  let template = '';
  let playbookTools: string[] | undefined;
  let codeExecution = true;
  let designatedSystemPrompt: string | undefined;

  if (q.playbook) {
    const list = await prompts.list();
    const info = list.find((p) => p.name === q.playbook);
    playbookTools = info?.tools;
    codeExecution = info?.codeExecution !== false;
    designatedSystemPrompt = info?.systemPrompt;
    template = await prompts.getText(q.playbook);
  }

  const basePrompt = await resolvePlaybookSystemPrompt(
    designatedSystemPrompt,
    opts.systemPromptClient,
    opts.systemPrompt,
  );

  const hasTemplate = template && template.trim().length > 0;
  const systemPrompt = hasTemplate
    ? (basePrompt && basePrompt.trim().length > 0
        ? `${basePrompt}\n\n---\n\n${template}`
        : template)
    : basePrompt;

  return {
    question: q,
    modelContent: q.question,
    answerModel: opts.answerModel,
    systemPrompt,
    playbookTools,
    thinkingLevel: opts.thinkingLevel,
    codeExecution,
  };
}
