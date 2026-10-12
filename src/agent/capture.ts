import type { AnswerBundle, ToolInvocation } from './AnswerBundle';

/**
 * Folds an Agent SDK message stream into an AnswerBundle. Pure and fixture-testable (mirrors the
 * desktop's translate.ts capture, minus the renderer-event machinery). Works for both single-agent
 * and MAS: the answer is the MAIN-thread text only (parent_tool_use_id null), while tool calls and
 * retrieved chunks are collected from ALL agents (in MAS the retrieval happens inside specialist
 * sub-agents). Delegation calls (`Agent`/`Task`) are not retrieval tools and are excluded.
 */
export interface StreamMessage {
  type: string; // 'system' | 'assistant' | 'user' | 'result' | 'stream_event'
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: unknown };
  session_id?: string;
  model?: string;
  usage?: Record<string, unknown>;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** In-stream delegation tool names (the allow-list token is 'Task'; the tool_use name is 'Agent'). */
const DELEGATE_NAMES = new Set(['Agent', 'Task']);
const CHUNK_MARKER = /\[chunk_id=([0-9a-fA-F-]{8,})\]/g;
// The `id=<uuid>` inside a search_corpus result header: "### kind/title  (score=… id=<uuid> doc_id=…)".
// `\bid=` never matches inside `doc_id=` (the `_` before `id` blocks the word boundary).
const SEARCH_RESULT_ID = /\bid=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

export function bundleFromMessages(messages: StreamMessage[]): AnswerBundle {
  const finalTextParts: string[] = [];
  const intermediateTextParts: string[] = [];
  const tools: Array<ToolInvocation & { id: string }> = [];
  const byId = new Map<string, ToolInvocation & { id: string }>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let resultText: string | undefined;
  let isError = false;
  let costUsd: number | undefined;
  let numTurns: number | undefined;
  let sessionId: string | undefined;
  let resolvedModel: string | undefined;
  let hasSeenResult = false;

  for (const msg of messages) {
    const isSubAgent = msg.parent_tool_use_id != null;
    const content = Array.isArray(msg.message?.content) ? (msg.message!.content as Block[]) : [];

    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
      if (typeof msg.model === 'string' && msg.model) {
        resolvedModel = msg.model;
      }
    } else if (msg.type === 'assistant') {
      if (!isSubAgent && hasSeenResult) {
        // The draft from the prior turn is superseded by whatever comes back post-review or in
        // subsequent turns; drop earlier prose so the delivered message isn't "draft + final"
        // concatenated (mirroring desktop AgentService.maybeContinueForReview).
        finalTextParts.length = 0;
        intermediateTextParts.length = 0;
        resultText = undefined;
        hasSeenResult = false;
      }
      const msgTextBlocks = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text)
        .map((b) => b.text as string);
      const msgHasToolUse = content.some((b) => b.type === 'tool_use');

      for (const b of content) {
        if (b.type === 'tool_use') {
          const name = String(b.name);
          if (DELEGATE_NAMES.has(name)) continue; // delegation, not a retrieval tool
          const inv: ToolInvocation & { id: string } = {
            id: String(b.id),
            name,
            argumentsJson: JSON.stringify(b.input ?? {}),
          };
          tools.push(inv);
          byId.set(inv.id, inv);
        }
      }

      if (!isSubAgent && msgTextBlocks.length > 0) {
        if (msgHasToolUse) {
          // This text accompanied a tool call (e.g. pre-search narration or pre-verification draft).
          // Stored as intermediate text; if a subsequent final answer arrives, it will supersede this.
          intermediateTextParts.push(...msgTextBlocks);
          if (finalTextParts.length > 0) {
            intermediateTextParts.push(...finalTextParts);
            finalTextParts.length = 0;
          }
        } else {
          // This message has no tool calls (post-tool final answer or pure text response).
          finalTextParts.push(...msgTextBlocks);
        }
      }
    } else if (msg.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const inv = byId.get(String(b.tool_use_id));
        if (inv) {
          inv.resultText = stringifyToolResult(b.content);
          inv.isError = b.is_error === true;
        }
      }
    } else if (msg.type === 'result') {
      hasSeenResult = true;
      const u = msg.usage ?? {};
      totalInputTokens += num(u.input_tokens);
      totalOutputTokens += num(u.output_tokens);
      if (typeof msg.result === 'string') resultText = msg.result;
      if (msg.is_error === true) isError = true;
      // total_cost_usd is cumulative across turns in streaming sessions — keep latest running total
      if (typeof msg.total_cost_usd === 'number') {
        costUsd = msg.total_cost_usd;
      }
      if (typeof msg.num_turns === 'number') {
        numTurns = (numTurns ?? 0) + msg.num_turns;
      }
    }
  }

  const finalAnswer = finalTextParts.join('\n\n').trim();
  const intermediateAnswer = intermediateTextParts.join('\n\n').trim();
  const answer = (finalAnswer || intermediateAnswer || resultText || '').trim();

  const chunkIds = new Set<string>();
  for (const t of tools) {
    if (!t.resultText) continue;
    collect(CHUNK_MARKER, t.resultText, chunkIds);
    if (stripPrefix(t.name) === 'search_corpus') collect(SEARCH_RESULT_ID, t.resultText, chunkIds);
  }
  collect(CHUNK_MARKER, answer, chunkIds);

  const promptTokens = totalInputTokens;
  const completionTokens = totalOutputTokens;

  return {
    answer,
    toolCalls: tools.map(({ name, argumentsJson, resultText: r, isError: e }) => ({
      name,
      argumentsJson,
      resultText: r,
      isError: e,
    })),
    retrievedChunkIds: [...chunkIds],
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    providerMeta: { sessionId, costUsd, numTurns, isError, resolvedModel },
  };
}

/** Flatten an SDK tool_result content (string | text blocks | object) to text — mirrors translate.ts. */
export function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as Block).type === 'text' ? ((b as Block).text ?? '') : '',
      )
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function collect(re: RegExp, text: string, into: Set<string>): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) into.add(m[1]);
}

function stripPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
