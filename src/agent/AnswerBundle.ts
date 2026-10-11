import type { EvalQuestion, ThinkingLevel } from '../types';
import type { OrchestrationTrace } from './OrchestrationTrace';

/** One tool call observed in an answer run — provider-normalized (mcp__<server>__ prefix stripped). */
export interface ToolInvocation {
  name: string;
  argumentsJson: string; // raw JSON string of the tool input
  resultText?: string; // tool result text, when captured
  isError?: boolean;
}

/**
 * One tool result as shown to the judge — verbatim output the model actually received. Distinct from
 * `Signals`, which can only represent evidence carrying a chunk id (graph/section reads carry none).
 */
export interface ToolEvidence {
  name: string;
  argumentsJson: string;
  resultText: string;
}

/**
 * The input handed to an AnswerProvider. The playbook template text is combined into `systemPrompt`,
 * and `modelContent` carries only the user question (clean without playbook text).
 */
export interface EvalTask {
  question: EvalQuestion;
  modelContent: string;
  answerModel: string;
  systemPrompt: string | null;
  /** The playbook's declared tools (from MCP meta.tools). `undefined` → the default tool set. */
  playbookTools?: string[];
  thinkingLevel: ThinkingLevel;
  codeExecution: boolean;
}

/** Provider-agnostic result of producing one answer — the sole input to signal extraction. */
export interface AnswerBundle {
  answer: string;
  toolCalls: ToolInvocation[];
  retrievedChunkIds: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerMeta: Record<string, unknown>;
  /** mas runs only: the delegation trace for orchestration eval (Mode 3). Undefined for single mode. */
  orchestration?: OrchestrationTrace;
}
