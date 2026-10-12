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
  designatedName: string | undefined | null,
  client?: SystemPromptClient,
  defaultPrompt?: string | null,
): Promise<ResolvedSystemPrompt> {
  const designated = designatedName?.trim();
  if (designated && client) {
    try {
      const custom = await client.get(designated);
      if (custom && custom.trim().length > 0) {
        return { text: custom, name: designated, fallback: false };
      }
    } catch {
      // on resolution error, fall back to default-chat
    }
    console.warn(`[WARN] Designated system prompt '${designated}' was empty or not found; fell back to default-chat.`);
    if (defaultPrompt !== undefined) {
      return { text: defaultPrompt, name: SYSTEM_PROMPT_NAME, fallback: true };
    }
    try {
      const text = await client.get(SYSTEM_PROMPT_NAME);
      return { text, name: SYSTEM_PROMPT_NAME, fallback: true };
    } catch {
      return { text: null, name: SYSTEM_PROMPT_NAME, fallback: true };
    }
  }

  // Fallback to defaultPrompt if explicitly provided (even if null or empty)
  if (defaultPrompt !== undefined) {
    return {
      text: defaultPrompt,
      name: defaultPrompt !== null ? SYSTEM_PROMPT_NAME : null,
      fallback: false,
    };
  }
  if (client) {
    try {
      const text = await client.get(SYSTEM_PROMPT_NAME);
      return { text, name: SYSTEM_PROMPT_NAME, fallback: false };
    } catch {
      return { text: null, name: null, fallback: false };
    }
  }
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
  let designatedSystemPrompt: string | undefined;

  if (q.playbook) {
    const list = await prompts.list();
    const info = list.find((p) => p.name === q.playbook);
    playbookTools = info?.tools;
    codeExecution = info?.codeExecution !== false;
    designatedSystemPrompt = info?.systemPrompt;
    template = await prompts.getText(q.playbook);
  }

  const resolved = await resolvePlaybookSystemPrompt(
    designatedSystemPrompt,
    opts.systemPromptClient,
    opts.systemPrompt,
  );
  const basePrompt = resolved.text;

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
    systemPromptName: resolved.name,
    systemPromptFallback: resolved.fallback,
  };
}
