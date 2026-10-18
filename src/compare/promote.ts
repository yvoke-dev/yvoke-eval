import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { UserError, type EvalResult } from '../types';
import { loadResults, groupByCategory, baselineCategories } from './BaselineComparator';
import { effectiveVerdict } from './verdict';
import { renderSummary, renderCategoryReport, toJson } from '../report/ReportWriter';

export interface PromoteResult {
  runId: string;
  categories: string[];
}

/**
 * Promote a run into the baseline: write per-category `<baselineDir>/<category>/` folders (regenerated
 * from the run's results so merged and per-category runs both work) and rebuild `BASELINE.md`.
 */
export function promote(runDir: string, baselineDir: string, categoryFilter?: string[]): PromoteResult {
  const runId = basename(runDir);
  const meta = JSON.parse(readFileSync(join(runDir, 'run_meta.json'), 'utf8')) as Record<string, unknown>;
  const byCat = groupByCategory(loadResults(runDir));
  const filter = categoryFilter && categoryFilter.length > 0 ? new Set(categoryFilter) : null;

  const promoted: string[] = [];
  for (const [cat, catResults] of byCat) {
    if (filter && !filter.has(cat)) continue;
    const errorCount = catResults.filter((r) => effectiveVerdict(r) === 'ERROR').length;
    if (errorCount > 0) {
      throw new UserError(
        `Cannot promote ${cat} from ${runId}: contains ${errorCount} ERROR result(s). A run must be error-free to become a baseline.`,
      );
    }
    const dir = join(baselineDir, cat);
    mkdirSync(dir, { recursive: true });
    const catMeta: Record<string, unknown> = { ...meta, questionCount: catResults.length, sourceRun: runId };
    writeFileSync(join(dir, 'run_meta.json'), toJson(catMeta));
    writeFileSync(join(dir, 'results.json'), toJson(catResults));
    writeFileSync(join(dir, 'summary.md'), renderSummary(catMeta, catResults));
    writeFileSync(join(dir, `eval_${cat}.md`), renderCategoryReport(cat, catResults));
    promoted.push(cat);
  }

  regenerateBaselineIndex(baselineDir);
  return { runId, categories: promoted.sort() };
}

/** Rebuild BASELINE.md from the current baseline folders — always consistent with what's on disk. */
export function regenerateBaselineIndex(baselineDir: string): void {
  const cats = baselineCategories(baselineDir);
  const rows: string[] = [];
  let totalPass = 0;
  let totalQ = 0;
  const models = new Set<string>();
  const reviewers = new Set<string>();

  for (const cat of cats) {
    const dir = join(baselineDir, cat);
    const results = loadResults(dir);
    const meta = JSON.parse(readFileSync(join(dir, 'run_meta.json'), 'utf8')) as Record<string, unknown>;
    const pass = results.filter((r: EvalResult) => effectiveVerdict(r) === 'PASS').length;
    totalPass += pass;
    totalQ += results.length;
    const model = String(meta.answerModel ?? meta.sdkModel ?? 'model');
    const sha = String(meta.gitSha ?? 'nogit');
    const runId = meta.sourceRun ? String(meta.sourceRun) : `${meta.timestamp}__${sanitize(model)}__${sha}`;
    models.add(model);
    if (meta.reviewerModel) reviewers.add(String(meta.reviewerModel));
    rows.push(`| ${cat} | ${pass}/${results.length} PASS | \`${runId}\` |`);
  }

  const md = [
    '# Eval baseline',
    '',
    'Snapshot of the promoted run per category — the reference future eval runs compare against.',
    '',
    `- **Answer model(s):** ${fmtSet(models)}`,
    `- **Reviewer model(s):** ${fmtSet(reviewers)}`,
    `- **Total:** ${totalPass}/${totalQ} questions PASS across ${cats.length} categories`,
    '',
    '| Category | Result | Source run |',
    '|---|---|---|',
    ...rows,
    '',
    "Each `baseline/<category>/` folder holds that run's `results.json`, `summary.md`, `run_meta.json`, and `eval_<category>.md`.",
    '',
  ].join('\n');

  writeFileSync(join(baselineDir, 'BASELINE.md'), md);
}

function fmtSet(s: Set<string>): string {
  return s.size > 0 ? [...s].map((m) => `\`${m}\``).join(', ') : '—';
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-');
}
