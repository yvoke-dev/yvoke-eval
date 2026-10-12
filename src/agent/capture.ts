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
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export const ID_COVERAGE = 1.0;
export const LENGTH_RATIO = 0.5;
export const LONG = 200;

function uuids(text: string): Set<string> {
  const set = new Set<string>();
  UUID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UUID_RE.exec(text)) !== null) set.add(m[0].toLowerCase());
  return set;
}

function word5Grams(text: string): Set<string> {
  const words = text.toLowerCase().match(/\w+/g) || [];
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - 5; i++) {
    grams.add(words.slice(i, i + 5).join(' '));
  }
  return grams;
}

export function restated(earlier: string, later: string): boolean {
  if (earlier.length < LONG || later.length < LONG) return false;
  if (later.length < LENGTH_RATIO * earlier.length) return false;
  const eIds = uuids(earlier);
  if (eIds.size > 0) {
    const lIds = uuids(later);
    let match = 0;
    for (const id of eIds) if (lIds.has(id)) match++;
    return match / eIds.size >= ID_COVERAGE;
  }
  const eGrams = word5Grams(earlier);
  if (eGrams.size === 0) return false;
  const lGrams = word5Grams(later);
  let match = 0;
  for (const g of eGrams) if (lGrams.has(g)) match++;
  return match / eGrams.size >= 0.5;
}

export function bundleFromMessages(messages: StreamMessage[]): AnswerBundle {
  const textParts: string[] = [];
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
        textParts.length = 0;
        resultText = undefined;
        hasSeenResult = false;
      }

      for (const b of content) {
        if (b.type === 'tool_use') {
          const name = String(b.name);
          if (DELEGATE_NAMES.has(name)) continue;
          const inv: ToolInvocation & { id: string } = {
            id: String(b.id),
            name,
            argumentsJson: JSON.stringify(b.input ?? {}),
          };
          tools.push(inv);
          byId.set(inv.id, inv);
        }
      }

      if (!isSubAgent) {
        for (const b of content) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            const t = b.text;
            for (let i = textParts.length - 1; i >= 0; i--) {
              if (restated(textParts[i], t)) {
                textParts.splice(i, 1);
              }
            }
            textParts.push(t);
          }
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
      if (typeof msg.total_cost_usd === 'number') {
        costUsd = msg.total_cost_usd;
      }
      if (typeof msg.num_turns === 'number') {
        numTurns = (numTurns ?? 0) + msg.num_turns;
      }
    }
  }

  const answer = (textParts.join('\n\n').trim() || resultText || '').trim();

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
