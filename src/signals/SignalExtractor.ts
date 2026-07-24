import type { EvalQuestion, Signals } from '../types';
import type { AnswerBundle, ToolInvocation } from '../agent/AnswerBundle';

/**
 * Deterministic, LLM-free signal extraction — derived entirely from the answer text + the SDK/MCP
 * trace (no DB). Replaces the old JdbcTemplate chunk→collection SQL: `search_corpus` results name
 * their collection in the header ("Searched **<collection>** for…") and are single-collection-scoped,
 * so the retrieved collection is read straight off the trace.
 *
 * Fidelity note: a pure `get_section` browse answer (no `search_corpus`) can't map its chunks to a
 * collection name without the DB, so `retrievedCollections` is empty for it; routing should be judged
 * on `searchCollections ∪ retrievedCollections`, and `get_section` firing already proves a real read.
 */
const CITATION = /\[\d+\]/;
const SEARCHED_HEADER = /^Searched\s+\*\*(.+?)\*\*/m;

export function extractSignals(question: EvalQuestion, bundle: AnswerBundle): Signals {
  const answer = bundle.answer ?? '';
  const toolsFired = distinct(bundle.toolCalls.map((t) => stripPrefix(t.name)));

  const searchCollections = distinct(
    bundle.toolCalls.map((t) => collectionArg(t.argumentsJson)).filter(isString),
  );

  const chunkIds = distinct(bundle.retrievedChunkIds ?? []);

  // Only collections whose chunks were actually retrieved count as "retrieved".
  const retrievedCollections =
    chunkIds.length === 0
      ? []
      : distinct(
          bundle.toolCalls
            .filter((t) => stripPrefix(t.name) === 'search_corpus' && !t.isError)
            .map(searchCorpusCollection)
            .filter(isString),
        );

  const hay = answer.toLowerCase();
  const mustIncludeMissing = question.mustInclude.filter((s) => !hay.includes(s.toLowerCase()));
  const mustNotIncludePresent = question.mustNotInclude.filter((s) => hay.includes(s.toLowerCase()));
  const hasCitations = CITATION.test(answer) || answer.includes('## References');

  return {
    toolsFired,
    searchCollections,
    retrievedCollections,
    retrievedChunkCount: chunkIds.length,
    mustIncludeMissing,
    mustNotIncludePresent,
    hasCitations,
  };
}

/** Prefer the authoritative result header; fall back to the `collection` arg; skip error results. */
function searchCorpusCollection(t: ToolInvocation): string | null {
  if (t.resultText) {
    const m = SEARCHED_HEADER.exec(t.resultText);
    if (m) return m[1].trim();
    if (t.resultText.startsWith('Error:')) return null;
  }
  return collectionArg(t.argumentsJson);
}

function collectionArg(argsJson: string): string | null {
  try {
    const o = JSON.parse(argsJson) as Record<string, unknown>;
    return typeof o?.collection === 'string' ? o.collection : null;
  } catch {
    return null;
  }
}

/** Strip an MCP tool prefix: `mcp__yvoke__search_corpus` → `search_corpus`. */
function stripPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

function isString(v: string | null): v is string {
  return v !== null;
}

function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
