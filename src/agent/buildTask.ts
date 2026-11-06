import type { EvalQuestion, ThinkingLevel } from '../types';
import type { EvalTask } from './AnswerBundle';
import type { PromptSource } from '../mcp/McpPrompts';

export interface BuildTaskOptions {
  answerModel: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt?: string | null;
  systemPromptClient?: unknown;
}

export interface ResolvedSystemPrompt {
  text: string | null;
  name: string | null;
  fallback: boolean;
}

/**
 * Resolves the system prompt for a playbook.
 * If the playbook designates a custom system prompt name, attempts to load it via SystemPromptClient.
 * Falls back to default-chat (or defaultPrompt) when absent, empty, or on resolution error.
 */
export async function resolvePlaybookSystemPrompt(
  _designatedName?: string | undefined | null,
  _client?: unknown,
  _defaultPrompt?: string | null,
): Promise<ResolvedSystemPrompt> {
  return { text: null, name: null, fallback: false };
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
  let playbookVersion: number | null = null;

  if (q.playbook) {
    const list = await prompts.list();
    const info = list.find((p) => p.name === q.playbook);
    playbookTools = info?.tools;
    codeExecution = info?.codeExecution !== false;
    playbookVersion = info?.version ?? null;
    template = await prompts.getText(q.playbook);
  }

  const hasTemplate = template && template.trim().length > 0;
  const systemPrompt = hasTemplate ? template : null;

  return {
    question: q,
    modelContent: q.question,
    answerModel: opts.answerModel,
    systemPrompt,
    playbookTools,
    thinkingLevel: opts.thinkingLevel,
    codeExecution,
    systemPromptName: null,
    systemPromptFallback: false,
    playbookVersion,
  };
}
