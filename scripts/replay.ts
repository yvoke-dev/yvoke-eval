/**
 * Offline replay — re-grade already-produced answers WITHOUT re-running the model.
 *
 * Rebuilds each AnswerBundle from the Claude Code session transcripts (which retain every tool call
 * and its full result), then grades it with the current judge + rubric. Because the answers are
 * byte-identical to those of the original run, any verdict change is attributable to the grader
 * change alone — no answer-side nondeterminism confounding the comparison.
 *
 * Usage:  npx tsx scripts/replay.ts --config <eval-repo>/yvoke-eval.yaml <old-run-dir> [outfile.json]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { parseArgs } from 'node:util';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EvalSpecParser } from '../src/specs/EvalSpecParser';
import { bundleFromMessages, type StreamMessage } from '../src/agent/capture';
import type { AnswerBundle } from '../src/agent/AnswerBundle';
import { extractSignals } from '../src/signals/SignalExtractor';
import { gradeOne } from '../src/run/grade';
import { ClaudeJudge } from '../src/reviewer/Judge';
import { AgentSdkStructuredModel } from '../src/reviewer/AgentSdkStructuredModel';
import { loadGrader } from '../src/reviewer/loadGrader';
import { loadConfig, resolveSuite } from '../src/config/loadConfig';
import type { EvalResult } from '../src/types';

function collect(re: RegExp, text: string, into: Set<string>): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) into.add(m[1]);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Where Claude Code stores the answer-run transcripts.
 *
 * Claude Code names a project directory after its cwd with every non-alphanumeric character replaced
 * by `-`, and runSuite gives the SDK `<tmpdir>/yvoke-eval-sandbox` as cwd. Derive that rather than
 * hardcoding it: the literal path this used to carry embedded one machine's macOS temp directory, so
 * the script ran nowhere else. macOS resolves /var to /private/var, so try both spellings.
 */
function transcriptsDir(): string {
  const sandboxDir = join(os.tmpdir(), 'yvoke-eval-sandbox');
  const candidates = new Set([sandboxDir]);
  try {
    candidates.add(realpathSync(sandboxDir));
  } catch {
    // Sandbox not present — the resolved spelling is unknowable; the raw one still may match.
  }
  const tried: string[] = [];
  for (const dir of candidates) {
    const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const full = join(os.homedir(), '.claude', 'projects', slug);
    tried.push(full);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `No Claude Code transcripts found for the eval sandbox. Looked in:\n${tried.map((t) => `  ${t}`).join('\n')}\n\n` +
      'Transcripts are written by an answer run, so run the suite at least once on this machine first.',
  );
}

type Line = { type?: string; message?: { role?: string; content?: unknown } };

/** The eval task prompt ends with `---\n\n<question>`; that trailing line is the join key. */
function questionOf(content: string): string | null {
  const idx = content.lastIndexOf('\n---\n');
  if (idx < 0) return null;
  const tail = content.slice(idx + 5).trim();
  return tail.length > 0 && tail.length < 400 ? tail : null;
}

/** question text → the most recent answer session for it (the newest run wins). */
function loadSessions(transcripts: string): Map<string, StreamMessage[]> {
  const best = new Map<string, { mtime: number; messages: StreamMessage[] }>();
  for (const f of readdirSync(transcripts).filter((x) => x.endsWith('.jsonl'))) {
    const file = join(transcripts, f);
    let lines: Line[];
    try {
      lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Line);
    } catch {
      continue;
    }
    const firstUser = lines.find((o) => o.type === 'user' && typeof o.message?.content === 'string');
    if (!firstUser) continue;
    const content = firstUser.message!.content as string;
    if (content.startsWith('## Question under test')) continue; // judge session, not an answer
    const q = questionOf(content);
    if (!q) continue;

    // Single-mode runs have no sub-agents, so parent_tool_use_id is uniformly null.
    const messages: StreamMessage[] = lines
      .filter((o) => o.type === 'assistant' || o.type === 'user')
      .map((o) => ({ type: o.type!, message: o.message, parent_tool_use_id: null }));
    if (!messages.some((m) => Array.isArray(m.message?.content))) continue;

    const mtime = statSync(file).mtimeMs;
    const prev = best.get(q);
    if (!prev || mtime > prev.mtime) best.set(q, { mtime, messages });
  }
  return new Map([...best].map(([k, v]) => [k, v.messages]));
}

const USAGE = 'usage: tsx scripts/replay.ts --config <eval-repo>/yvoke-eval.yaml <old-run-dir> [outfile.json]';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' }, suite: { type: 'string' } },
  });

  const oldRunDir = positionals[0];
  const outFile = positionals[1] ?? join(process.cwd(), 'replay-results.json');
  if (!oldRunDir) throw new Error(USAGE);

  // Same contract as the CLI: content lives beside its config, so relative paths resolve against
  // the config's directory rather than this repo.
  const configPath = values.config ? path.resolve(values.config) : join(repoRoot, 'yvoke-eval.yaml');
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\n\n${USAGE}`);
  }
  const cfg = resolveSuite(loadConfig(configPath), values.suite);
  const contentRoot = path.dirname(configPath);
  const resolve = (p: string): string => (path.isAbsolute(p) ? p : join(contentRoot, p));

  const evalDir = resolve(cfg.evalDir ?? './eval');
  if (!cfg.reviewer?.promptFile) {
    throw new Error(
      `Missing reviewer.promptFile in ${configPath} — it names the rubric to re-grade against.\n` +
        'Grader rubrics are knowledge-base content and live with the evals, so there is no default.',
    );
  }
  const graderPath = resolve(cfg.reviewer.promptFile);
  const reviewerModel = cfg.reviewer.model ?? 'opus';

  const questions = new EvalSpecParser(evalDir).parse();
  const oldByKey = new Map<string, EvalResult>();
  for (const r of JSON.parse(readFileSync(join(oldRunDir, 'results.json'), 'utf8')) as EvalResult[]) {
    oldByKey.set(`${r.question.category}.${r.question.id}`, r);
  }

  const sessions = loadSessions(transcriptsDir());
  console.error(`transcripts: ${sessions.size} distinct questions recovered`);

  const grader = loadGrader(graderPath);
  // The SDK uses sandboxDir as the judge process's cwd — it MUST exist, or the spawn fails with a
  // misleading "binary does not match this system's libc" error. (runSuite does the same at :57.)
  const sandboxDir = join(os.tmpdir(), 'yvoke-replay-sandbox');
  mkdirSync(sandboxDir, { recursive: true });
  const judge = new ClaudeJudge(new AgentSdkStructuredModel({ sandboxDir }), {
    model: reviewerModel,
    systemPrompt: grader.prompt,
  });

  // Resume: keep any verdict already graded in a previous attempt, re-grade only ERRORs and gaps.
  // (A judge run can be cut short mid-suite by a Claude session limit.)
  const out: EvalResult[] = [];
  const done = new Set<string>();
  if (existsSync(outFile)) {
    for (const r of JSON.parse(readFileSync(outFile, 'utf8')) as EvalResult[]) {
      if (r.verdict.verdict === 'ERROR') continue;
      out.push(r);
      done.add(`${r.question.category}.${r.question.id}`);
    }
    if (done.size > 0) console.error(`resuming: ${done.size} verdict(s) already graded, re-grading the rest`);
  }

  const targetQuestions =
    oldByKey.size > 0 ? questions.filter((q) => oldByKey.has(`${q.category}.${q.id}`)) : questions;

  let n = 0;
  for (const q of targetQuestions) {
    n++;
    const o = oldByKey.get(`${q.category}.${q.id}`);

    if (process.env.DRY === '1') {
      if (o && o.toolEvidence != null && o.answer != null) {
        console.error(
          `[${n}/${targetQuestions.length}] ${q.category}.${q.id}  evidence=${o.toolEvidence.length} items answer=${o.answer.length}ch (self-contained from results.json)`,
        );
      } else {
        const messages = sessions.get(q.question.trim());
        if (!messages) {
          console.error(`[${n}/${targetQuestions.length}] ${q.category}.${q.id} → NO TRANSCRIPT (skipped)`);
        } else {
          const bundle = bundleFromMessages(messages);
          const same =
            o != null &&
            (o.answer ?? '').trim() === bundle.answer.trim() &&
            JSON.stringify(o.signals.toolsFired) ===
              JSON.stringify([...new Set(bundle.toolCalls.map((t) => t.name.replace(/^mcp__.+?__/, '')))]);
          console.error(
            `[${n}/${targetQuestions.length}] ${q.category}.${q.id}  tools=${bundle.toolCalls.length} answer=${bundle.answer.length}ch ${o ? (same ? 'MATCHES recorded' : 'DIFFERS from recorded') : '(not in old run)'}`,
          );
        }
      }
      continue;
    }

    let res: EvalResult;
    if (o && o.toolEvidence != null && o.answer != null) {
      let chunkIds: string[];
      let evidenceTruncated = false;
      if (Array.isArray(o.retrievedChunkIds) && o.retrievedChunkIds.length > 0) {
        chunkIds = o.retrievedChunkIds;
      } else {
        const idSet = new Set<string>();
        for (const e of o.toolEvidence) {
          if (e.resultText) {
            if (e.resultText.length >= 20_000) {
              evidenceTruncated = true;
            }
            collect(/\[chunk_id=([0-9a-fA-F-]{8,})\]/g, e.resultText, idSet);
            collect(/\bid=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g, e.resultText, idSet);
          }
        }
        chunkIds = [...idSet];
      }
      const syntheticBundle: AnswerBundle = {
        answer: o.answer,
        rawAnswer: o.rawAnswer ?? undefined,
        toolCalls: o.toolEvidence.map((e) => ({
          name: e.name,
          argumentsJson: e.argumentsJson,
          resultText: e.resultText,
        })),
        retrievedChunkIds: chunkIds,
        promptTokens: o.promptTokens,
        completionTokens: o.completionTokens,
        totalTokens: o.totalTokens,
        providerMeta: o.costUsd != null ? { costUsd: o.costUsd } : {},
      };
      const signals = extractSignals(q, syntheticBundle);
      if (evidenceTruncated && signals.unverifiedCitations && signals.unverifiedCitations.length > 0) {
        // Truncated tool evidence in legacy run missing full chunk list: do not falsely fail citations
        signals.unverifiedCitations = undefined;
      }
      const evidence = o.toolEvidence;
      const verdict = await judge.review({ question: q, answer: o.answer, signals, evidence });
      const isJudgeError = verdict.verdict === 'ERROR';
      if (!isJudgeError) {
        if (signals.mustNotIncludePresent.length > 0) {
          verdict.verdict = 'FAIL';
          verdict.dimensions.no_fabrication = 'FAIL';
          verdict.reasoning = `[Deterministic safety FAIL: must_not_include present: ${signals.mustNotIncludePresent.join(', ')}]\n${verdict.reasoning}`.trim();
        } else if (q.critical && signals.mustIncludeMissing.length > 0) {
          verdict.verdict = 'FAIL';
          verdict.dimensions.completeness = 'FAIL';
          verdict.reasoning = `[Deterministic completeness FAIL on critical question: missing ${signals.mustIncludeMissing.join(', ')}]\n${verdict.reasoning}`.trim();
        }
      }
      res = {
        question: q,
        answer: o.answer,
        rawAnswer: o.rawAnswer ?? null,
        signals,
        verdict,
        promptTokens: o.promptTokens,
        completionTokens: o.completionTokens,
        totalTokens: o.totalTokens,
        latencyMs: 0,
        error: isJudgeError ? (verdict.reasoning || 'reviewer call failed') : null,
        toolEvidence: evidence,
        costUsd: o.costUsd,
      };
    } else {
      const messages = sessions.get(q.question.trim());
      if (!messages) {
        console.error(`[${n}/${targetQuestions.length}] ${q.category}.${q.id} → NO TRANSCRIPT (skipped)`);
        continue;
      }
      const bundle = bundleFromMessages(messages);
      res = await gradeOne(q, bundle, judge, 0);
    }

    out.push(res);
    const key = `${q.category}.${q.id}`;
    const before = oldByKey.get(key)?.verdict.verdict ?? '—';
    const flag = before !== '—' && before !== res.verdict.verdict ? `  ${before} → ${res.verdict.verdict}` : '';
    console.error(`[${n}/${targetQuestions.length}] ${key} → ${res.verdict.verdict}${flag}`);
    writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  }
  console.error(`\nreplayed ${out.length}/${targetQuestions.length}; graderSha=${grader.sha}; out=${outFile}`);
}

void main();
