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
/**
 * What counts as a citation in an answer.
 *
 * This must track the **deployed** convention rather than a historical one, because the grader is
 * handed `answer_has_citations` and reads a false there as a citation failure. It had drifted: this
 * recognised only numbered `[1]` markers, while the shipped `default-chat` system prompt now writes
 * bare ids inline and says outright *"Do not number citations and do not write a `## References`
 * section"*. So every correctly-cited answer reported `hasCitations: false` and was capped at PARTIAL
 * on the citations dimension however good it was — the harness was measuring the one format the
 * prompt forbids.
 *
 * The accepted forms mirror the renderer's own `citationRehype.ts`, which is the product's authority
 * on what a citation is:
 *  - a **bare id** — `[8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071]`, hyphenated or 32-hex — the current form;
 *  - the **kinded legacy** forms `[chunk_id=…]` / `[document_id=…]` / `[file=…]`, still emitted by
 *    some playbooks and still resolvable;
 *  - a **markdown link**, which is how a *web* source is cited: a search result carries no chunk and
 *    no document, so there is no id to write and a link is the only honest attribution;
 *  - a `## References` section, kept so an older recorded run still reads as cited rather than being
 *    silently regraded by this change.
 */
const UUID_HEX =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}';
const CITE_ITEM = `(?:(?:chunk_id|document_id|file)=[a-zA-Z0-9_.-]+|${UUID_HEX})`;
const CITATION = new RegExp(
  [
    '\\[\\d+\\]',
    `\\[\\s*${CITE_ITEM}(?:\\s*,\\s*${CITE_ITEM})*\\s*\\]`,
    '\\[[^\\]\\n]+\\]\\(https?://[^)\\s]+\\)',
  ].join('|'),
);
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

  const normHay = normalizeHaystack(answer);
  const mustIncludeMissing = question.mustInclude.filter((s) => !normHay.includes(normalizeNeedle(s)));
  if (question.mustIncludeAny && question.mustIncludeAny.length > 0) {
    for (const group of question.mustIncludeAny) {
      const match = group.some((s) => normHay.includes(normalizeNeedle(s)));
      if (!match) {
        mustIncludeMissing.push(group.join(' | '));
      }
    }
  }
  const mustNotIncludePresent = question.mustNotInclude.filter((s) => normHay.includes(normalizeNeedle(s)));
  const hasCitations = CITATION.test(answer) || answer.includes('## References');
  // Compared on the bare name, because the trace is stripped of the server prefix while a spec
  // names tools the way a playbook does.
  const firedBare = new Set(toolsFired.map((t) => t.toLowerCase()));
  const expectedToolsMissing = question.expectToolCalled.filter(
    (t) => !firedBare.has(stripPrefix(t).toLowerCase()),
  );

  return {
    toolsFired,
    searchCollections,
    retrievedCollections,
    retrievedChunkCount: chunkIds.length,
    mustIncludeMissing,
    mustNotIncludePresent,
    expectedToolsMissing,
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

export function normalizeHaystack(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\+/g, '/')
    .replace(/\s+/g, ' ');
}

export function normalizeNeedle(needle: string): string {
  return needle
    .toLowerCase()
    .replace(/\\+/g, '/')
    .replace(/\s+/g, ' ');
}

export function normalizeText(text: string): string {
  return normalizeNeedle(text);
}

