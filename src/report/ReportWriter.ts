import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { EvalResult } from '../types';

/**
 * Writes a timestamped eval run under <evalDir>/runs/. Same artifact set + folder naming as the Java
 * ReportWriter (run_meta.json, results.json, summary.md, eval_<category>.md), so `compare`/`promote`
 * and existing readers keep working. Serialization is standard 2-space JSON (the old Java used
 * Jackson's `" : "`); SDK runs form their own baseline, so the golden test asserts structural — not
 * byte — parity.
 */
export interface WriteResult {
  runDir: string;
  runId: string;
}

export class ReportWriter {
  /**
   * `runId` MUST be supplied when writing more than one run (i.e. the per-category `merge: false`
   * path). It used to be derived from `new Date()` *inside* this method, so every category write in a
   * loop collided on the same second and silently overwrote the previous category's results.json.
   */
  write(
    evalDir: string,
    meta: Record<string, unknown>,
    results: EvalResult[],
    runId?: string,
  ): WriteResult {
    const model = String(meta['answerModel'] ?? 'model');
    const provided = meta['gitSha'];
    const sha = provided != null && String(provided).length > 0 ? String(provided) : gitSha(evalDir);
    const id = runId ?? newRunId(model, sha);
    const ts = timestampOf(id);
    const runDir = join(evalDir, 'runs', id);
    mkdirSync(runDir, { recursive: true });

    const fullMeta: Record<string, unknown> = {
      ...meta,
      timestamp: ts,
      gitSha: sha,
      questionCount: results.length,
    };
    writeFileSync(join(runDir, 'run_meta.json'), toJson(fullMeta));
    writeFileSync(join(runDir, 'results.json'), toJson(results));
    writeFileSync(join(runDir, 'summary.md'), renderSummary(fullMeta, results));

    const byCategory = new Map<string, EvalResult[]>();
    for (const r of results) {
      const list = byCategory.get(r.question.category) ?? [];
      list.push(r);
      byCategory.set(r.question.category, list);
    }
    for (const [cat, list] of sortedEntries(byCategory)) {
      writeFileSync(join(runDir, `eval_${cat}.md`), renderCategoryReport(cat, list));
    }
    return { runDir, runId: id };
  }
}

/** Build one run id for a whole run. Call ONCE per `runSuite`, then pass it to every `write`. */
export function newRunId(answerModel: string, gitSha: string): string {
  return `${formatTimestamp(new Date())}__${sanitize(answerModel)}__${gitSha}`;
}

/** The `<timestamp>__<model>__<sha>` prefix, so run_meta.timestamp matches the folder it sits in. */
function timestampOf(runId: string): string {
  return runId.split('__')[0] ?? runId;
}

/** Standard, stable 2-space JSON with a trailing newline. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderSummary(meta: Record<string, unknown>, results: EvalResult[]): string {
  const byCat = new Map<string, [number, number, number, number]>(); // [pass, partial, fail, error]
  const tot: [number, number, number, number] = [0, 0, 0, 0];
  for (const r of results) {
    const c = byCat.get(r.question.category) ?? [0, 0, 0, 0];
    const idx = verdictIndex(r.verdict.verdict);
    c[idx]++;
    tot[idx]++;
    byCat.set(r.question.category, c);
  }

  let sb = '# Eval run summary\n\n';
  sb += `- timestamp: ${meta['timestamp']}  UTC\n`;
  sb += `- answer model: \`${meta['answerModel']}\`\n`;
  sb += `- reviewer model: \`${meta['reviewerModel']}\`\n`;
  sb += `- git: \`${meta['gitSha']}\`\n\n`;
  sb += `**Overall: ${tot[0]} PASS / ${tot[1]} PARTIAL / ${tot[2]} FAIL / ${tot[3]} ERROR** (of ${results.length})\n\n`;
  sb += '| Category | PASS | PARTIAL | FAIL | ERROR |\n|---|---|---|---|---|\n';
  for (const [cat, c] of sortedEntries(byCat)) {
    sb += `| ${cat} | ${c[0]} | ${c[1]} | ${c[2]} | ${c[3]} |\n`;
  }
  return sb;
}

export function renderCategoryReport(category: string, results: EvalResult[]): string {
  let sb = `# Eval results — ${category}\n\n`;
  sb += '| # | Question | Expect | Verdict |\n|---|---|---|---|\n';
  for (const r of results) {
    sb += `| ${r.question.id} | ${escape(r.question.question)} | ${r.question.expect} | ${r.verdict.verdict} |\n`;
  }
  sb += '\n';
  for (const r of results) {
    sb += `## ${r.question.id} — ${r.question.question}\n\n`;
    sb += `**Verdict:** ${r.verdict.verdict}  ${JSON.stringify(r.verdict.dimensions)}\n\n`;
    sb += `**Reasoning:** ${r.verdict.reasoning}\n\n`;
    sb += `**Signals:** tools=${JSON.stringify(r.signals.toolsFired)} retrievedCollections=${JSON.stringify(r.signals.retrievedCollections)} citations=${r.signals.hasCitations}\n\n`;
    if (r.error) {
      sb += `**Run error:** ${r.error}\n\n`;
    }
    sb += `**Model answer:**\n\n${r.answer ?? '_(none)_'}\n\n---\n\n`;
  }
  return sb;
}

function verdictIndex(v: string): number {
  switch (v) {
    case 'PASS':
      return 0;
    case 'PARTIAL':
      return 1;
    case 'FAIL':
      return 2;
    default:
      return 3;
  }
}

function sortedEntries<T>(m: Map<string, T>): [string, T][] {
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-');
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** `yyyy-MM-dd'T'HH-mm-ss'Z'` in UTC (matches the Java DateTimeFormatter used for run ids). */
function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}Z`
  );
}

function gitSha(cwd: string): string {
  try {
    const out = execSync('git rev-parse --short HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out.length > 0 ? out : 'nogit';
  } catch {
    return 'nogit';
  }
}
