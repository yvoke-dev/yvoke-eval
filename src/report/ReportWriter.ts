import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
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
    this.appendOverview(evalDir, fullMeta, results, id);
    return { runDir, runId: id };
  }

  private appendOverview(evalDir: string, meta: Record<string, unknown>, results: EvalResult[], runId: string): void {
    const runsDir = join(evalDir, 'runs');
    if (!existsSync(runsDir)) {
      mkdirSync(runsDir, { recursive: true });
    }
    const overviewPath = join(runsDir, 'OVERVIEW.md');
    const exists = existsSync(overviewPath);

    const mode = String(meta['evalIntent'] ?? meta['answerProvider'] ?? 'single');
    const playbookVersion = formatPlaybookVersion(meta['playbookVersion']);
    const answerModel = formatModelDisplay(String(meta['answerModel'] ?? 'model'), meta['resolvedAnswerModel']);
    const reviewerModel = formatModelDisplay(String(meta['reviewerModel'] ?? 'reviewer'), meta['resolvedReviewerModel']);
    const masReviewer = meta['masReviewerModel']
      ? formatModelDisplay(String(meta['masReviewerModel']), meta['resolvedMasReviewerModel'])
      : '—';
    const thinkingLevel = meta['thinkingLevel'] ? String(meta['thinkingLevel']) : 'off';

    let passCount = 0;
    let critPass = 0;
    let critTotal = 0;
    let totalLatencyMs = 0;
    const cats = new Set<string>();

    for (const r of results) {
      if (r.verdict.verdict === 'PASS') passCount++;
      if (r.question.critical) {
        critTotal++;
        if (r.verdict.verdict === 'PASS') critPass++;
      }
      cats.add(r.question.category);
      totalLatencyMs += r.latencyMs ?? 0;
    }

    const catStr = [...cats].join(', ');
    const passRate = `${passCount}/${results.length} (${Math.round((passCount / (results.length || 1)) * 100)}%)`;
    const critRate = critTotal > 0 ? `${critPass}/${critTotal}` : 'N/A';
    const latStr = `${(totalLatencyMs / 1000).toFixed(1)}s`;

    let content = '';
    if (!exists) {
      content += '# Evaluation Benchmark Overview\n\n';
      content += 'Cumulative record of evaluation runs across single-agent and multi-agent suites.\n\n';
      content += '| Date (UTC) | Run ID | Mode | Playbook Version | Category / Scope | Worker Model | Thinking | Judge Model | MAS Reviewer | Pass Rate | Critical Pass | Latency |\n';
      content += '|---|---|---|---|---|---|---|---|---|---|---|---|\n';
    }

    content += `| ${meta['timestamp']} | \`${runId}\` | ${mode} | ${playbookVersion} | ${catStr} (${results.length} Qs) | ${answerModel} | ${thinkingLevel} | ${reviewerModel} | ${masReviewer} | ${passRate} | ${critRate} | ${latStr} |\n`;

    appendFileSync(overviewPath, content, 'utf8');
  }
}

export function formatPlaybookVersion(version: unknown): string {
  if (typeof version === 'number' && Number.isInteger(version) && version >= 1) {
    return `v${version}`;
  }
  if (typeof version === 'string' && version.trim().length > 0) {
    const trimmed = version.trim();
    return /^v\d+$/i.test(trimmed) ? trimmed : /^\d+$/.test(trimmed) ? `v${trimmed}` : trimmed;
  }
  return '—';
}

/** Format a configured model alias with its concrete resolved version, e.g. `sonnet (claude-sonnet-5)`. */
export function formatModelDisplay(model: string, resolved?: unknown): string {
  if (!model || model === '—') return '—';
  const res = typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : undefined;
  if (!res || res === model) return model;
  return `${model} (${res})`;
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
  let totalLatencyMs = 0;

  for (const r of results) {
    const c = byCat.get(r.question.category) ?? [0, 0, 0, 0];
    const idx = verdictIndex(r.verdict.verdict);
    c[idx]++;
    tot[idx]++;
    byCat.set(r.question.category, c);
    totalLatencyMs += r.latencyMs ?? 0;
  }

  const mode = String(meta['evalIntent'] ?? meta['answerProvider'] ?? 'single');
  const playbookVersion = formatPlaybookVersion(meta['playbookVersion']);
  const answerModel = formatModelDisplay(String(meta['answerModel'] ?? 'model'), meta['resolvedAnswerModel']);
  const reviewerModel = formatModelDisplay(String(meta['reviewerModel'] ?? 'reviewer'), meta['resolvedReviewerModel']);
  const masReviewer = meta['masReviewerModel']
    ? formatModelDisplay(String(meta['masReviewerModel']), meta['resolvedMasReviewerModel'])
    : '—';
  const thinkingLevel = meta['thinkingLevel'] ? String(meta['thinkingLevel']) : 'off';

  let sb = '# Eval run summary\n\n';
  sb += `- timestamp: ${meta['timestamp']}  UTC\n`;
  sb += `- mode: \`${mode}\`\n`;
  if (playbookVersion !== '—') {
    sb += `- playbook version: \`${playbookVersion}\`\n`;
  }
  sb += `- answer model: \`${answerModel}\` (thinking: \`${thinkingLevel}\`)\n`;
  sb += `- reviewer model: \`${reviewerModel}\`\n`;
  if (masReviewer !== '—') {
    sb += `- mas reviewer: \`${masReviewer}\`\n`;
  }
  sb += `- git: \`${meta['gitSha']}\`\n`;
  sb += `- total duration: \`${(totalLatencyMs / 1000).toFixed(1)}s\`\n\n`;
  sb += `**Overall: ${tot[0]} PASS / ${tot[1]} PARTIAL / ${tot[2]} FAIL / ${tot[3]} ERROR** (of ${results.length})\n\n`;
  sb += '| Category | PASS | PARTIAL | FAIL | ERROR |\n|---|---|---|---|---|\n';
  for (const [cat, c] of sortedEntries(byCat)) {
    sb += `| ${cat} | ${c[0]} | ${c[1]} | ${c[2]} | ${c[3]} |\n`;
  }
  sb += '\n';

  sb += '### Detailed Results\n\n';
  sb += '| Category | # | Question | Mode | Worker | Judge | MAS Rev | Verdict | Latency | Tokens | Critical |\n';
  sb += '|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const r of results) {
    const lat = r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—';
    const tok = r.totalTokens != null && r.totalTokens > 0 ? r.totalTokens.toLocaleString() : '—';
    const crit = r.question.critical ? 'YES' : 'NO';
    sb += `| ${r.question.category} | ${r.question.id} | ${escape(r.question.question)} | ${mode} | ${answerModel} | ${reviewerModel} | ${masReviewer} | ${r.verdict.verdict} | ${lat} | ${tok} | ${crit} |\n`;
  }
  sb += '\n';

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
    const unverifiedStr = r.signals.unverifiedCitations?.length
      ? ` unverifiedCitations=${JSON.stringify(r.signals.unverifiedCitations)}`
      : '';
    sb += `**Signals:** tools=${JSON.stringify(r.signals.toolsFired)} retrievedCollections=${JSON.stringify(r.signals.retrievedCollections)} citations=${r.signals.hasCitations}${unverifiedStr}\n\n`;
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
