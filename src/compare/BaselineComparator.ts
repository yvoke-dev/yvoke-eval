import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EvalResult } from '../types';
import { effectiveVerdict, verdictRank } from './verdict';

export interface QuestionDiff {
  category: string;
  id: string;
  baseVerdict: string;
  runVerdict: string;
  kind: 'improved' | 'same' | 'soft-regression' | 'hard-regression' | 'new';
}

export interface CategoryDiff {
  category: string;
  hasBaseline: boolean;
  basePass: number;
  runPass: number;
  total: number;
  questions: QuestionDiff[];
}

export interface CompareReport {
  runId: string;
  categories: CategoryDiff[];
  hardRegressions: QuestionDiff[];
  softRegressions: QuestionDiff[];
  improvements: QuestionDiff[];
  /** True when the run should FAIL a `--gate` check (any hard regression). */
  gated: boolean;
}

/** Group an EvalResult[] by category. */
export function groupByCategory(results: EvalResult[]): Map<string, EvalResult[]> {
  const m = new Map<string, EvalResult[]>();
  for (const r of results) {
    const list = m.get(r.question.category) ?? [];
    list.push(r);
    m.set(r.question.category, list);
  }
  return m;
}

/** Read a run folder (or a baseline/<category> folder) → its results.json as EvalResult[]. */
export function loadResults(dir: string): EvalResult[] {
  return JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as EvalResult[];
}

/** Load baseline results for a set of categories from `<baselineDir>/<category>/results.json`. */
export function loadBaseline(baselineDir: string, categories: string[]): Map<string, EvalResult[]> {
  const out = new Map<string, EvalResult[]>();
  for (const cat of categories) {
    const p = join(baselineDir, cat);
    if (isDir(p) && isFile(join(p, 'results.json'))) {
      out.set(cat, loadResults(p));
    }
  }
  return out;
}

/**
 * Compare a run (results grouped by category) against a baseline. Verdict changes are classified by
 * band: a hard regression (was ≥PARTIAL, now ≤FAIL/ERROR) fails the gate; a soft regression
 * (PASS→PARTIAL) is reported only. The deterministic fabrication gate is applied to both sides.
 */
export function compareRunToBaseline(
  runId: string,
  runByCat: Map<string, EvalResult[]>,
  baselineByCat: Map<string, EvalResult[]>,
): CompareReport {
  const categories: CategoryDiff[] = [];
  const hardRegressions: QuestionDiff[] = [];
  const softRegressions: QuestionDiff[] = [];
  const improvements: QuestionDiff[] = [];

  for (const [category, runResults] of [...runByCat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const baseResults = baselineByCat.get(category);
    const baseById = new Map((baseResults ?? []).map((r) => [r.question.id, r]));
    const questions: QuestionDiff[] = [];

    for (const r of runResults) {
      const runV = effectiveVerdict(r);
      const base = baseById.get(r.question.id);
      if (!base) {
        questions.push({ category, id: r.question.id, baseVerdict: '—', runVerdict: runV, kind: 'new' });
        continue;
      }
      const baseV = effectiveVerdict(base);
      const kind = classify(baseV, runV);
      const diff: QuestionDiff = { category, id: r.question.id, baseVerdict: baseV, runVerdict: runV, kind };
      questions.push(diff);
      if (kind === 'hard-regression') hardRegressions.push(diff);
      else if (kind === 'soft-regression') softRegressions.push(diff);
      else if (kind === 'improved') improvements.push(diff);
    }

    categories.push({
      category,
      hasBaseline: baseResults != null,
      basePass: (baseResults ?? []).filter((r) => effectiveVerdict(r) === 'PASS').length,
      runPass: runResults.filter((r) => effectiveVerdict(r) === 'PASS').length,
      total: runResults.length,
      questions,
    });
  }

  return {
    runId,
    categories,
    hardRegressions,
    softRegressions,
    improvements,
    gated: hardRegressions.length > 0,
  };
}

function classify(baseV: string, runV: string): QuestionDiff['kind'] {
  const b = verdictRank(baseV);
  const r = verdictRank(runV);
  if (r > b) return 'improved';
  if (r === b) return 'same';
  // regression
  if (b >= verdictRank('PARTIAL') && r <= verdictRank('FAIL')) return 'hard-regression';
  return 'soft-regression';
}

/** Human-readable comparison report. */
export function renderCompareReport(report: CompareReport): string {
  const out: string[] = [];
  out.push(`# Eval comparison — run \`${report.runId}\``);
  out.push('');
  out.push('| Category | Baseline PASS | Run PASS | Δ | Notes |');
  out.push('|---|---|---|---|---|');
  for (const c of report.categories) {
    const delta = c.runPass - c.basePass;
    const note = !c.hasBaseline ? 'no baseline' : delta < 0 ? '⚠️ regression' : delta > 0 ? 'improved' : '';
    out.push(`| ${c.category} | ${c.hasBaseline ? `${c.basePass}/${c.total}` : '—'} | ${c.runPass}/${c.total} | ${delta >= 0 ? '+' : ''}${delta} | ${note} |`);
  }
  out.push('');
  out.push(
    `**${report.hardRegressions.length} hard regression(s), ${report.softRegressions.length} soft, ${report.improvements.length} improvement(s).**`,
  );
  if (report.hardRegressions.length > 0) {
    out.push('');
    out.push('## Hard regressions');
    for (const q of report.hardRegressions) {
      out.push(`- ${q.category}.${q.id}: ${q.baseVerdict} → **${q.runVerdict}**`);
    }
  }
  return out.join('\n');
}

/** The run id (folder name) for display. */
export function runIdOf(runDir: string): string {
  return basename(runDir);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** List category subfolders under a baseline dir. */
export function baselineCategories(baselineDir: string): string[] {
  if (!isDir(baselineDir)) return [];
  return readdirSync(baselineDir)
    .filter((n) => isFile(join(baselineDir, n, 'results.json')))
    .sort();
}
