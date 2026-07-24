import type { ToolEvidence, ToolInvocation } from '../agent/AnswerBundle';

/**
 * Turns the captured tool calls into the verbatim evidence block handed to the judge.
 *
 * Why this exists: `Signals` can only express evidence that carries a chunk id. The graph tools
 * (`search_graph_entities`, `get_graph_neighbors`) and `get_section` return rows with no chunk id at
 * all — `get_graph_neighbors` edge rows have no id column whatsoever — and the playbooks explicitly
 * instruct the model *not* to cite them. Judging those answers on `retrieved_chunk_count` alone marks
 * a correct, playbook-compliant answer as ungrounded. The fix is to let the judge read what the model
 * actually received.
 */

/** Meta/UI tools that carry no retrieval evidence. `verify_citations` IS kept — its REAL/FABRICATED
 *  verdicts are direct evidence about citation validity. */
const NON_EVIDENCE_TOOLS = new Set(['ToolSearch', 'AskUserQuestion', 'ask_clarifying_question']);

/** Per-result and whole-block caps. Measured: ~20 KB mean and ~92 KB max per question over an 84-question
 *  run, so these bound the tail without touching the typical case. */
export const MAX_RESULT_CHARS = 20_000;
export const MAX_TOTAL_CHARS = 120_000;

export function toEvidence(
  toolCalls: ToolInvocation[],
  caps: { maxResultChars?: number; maxTotalChars?: number } = {},
): ToolEvidence[] {
  const maxResult = caps.maxResultChars ?? MAX_RESULT_CHARS;
  const maxTotal = caps.maxTotalChars ?? MAX_TOTAL_CHARS;

  const out: ToolEvidence[] = [];
  let budget = maxTotal;

  for (const t of toolCalls) {
    if (t.isError) continue;
    const name = stripPrefix(t.name);
    if (NON_EVIDENCE_TOOLS.has(name)) continue;

    const text = unwrapResult(t.resultText ?? '');
    if (!text.trim()) continue;
    if (budget <= 0) break;

    const resultText = truncate(text, Math.min(maxResult, budget));
    budget -= resultText.length;
    out.push({ name, argumentsJson: t.argumentsJson, resultText });
  }
  return out;
}

/**
 * `search_corpus` returns plain markdown, but the graph/section/document tools return a *JSON-encoded
 * string* — a leading `"` with `\n` escapes — so the raw text reads as one unbroken line. Decode it so
 * the judge sees real tables and real line breaks.
 */
export function unwrapResult(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('"')) return raw;
  try {
    const parsed = JSON.parse(s) as unknown;
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const dropped = s.length - limit;
  return `${s.slice(0, limit)}\n[…truncated ${dropped} chars]`;
}

/** `mcp__yvoke__search_corpus` → `search_corpus` (mirrors SignalExtractor). */
function stripPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}
