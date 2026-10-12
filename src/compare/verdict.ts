import type { EvalResult } from '../types';

/** Verdict ordering — higher is better. Used to classify a run vs baseline as improved/regressed. */
export const VERDICT_RANK: Record<string, number> = {
  PASS: 3,
  PARTIAL: 2,
  FAIL: 1,
  ERROR: 0,
};

export function verdictRank(v: string): number {
  return VERDICT_RANK[v] ?? 0;
}

/**
 * The effective verdict, applying the deterministic backstop the judge cannot override:
 * - A `must_not_include` hit (fabrication) is an automatic FAIL.
 * - On `critical: true` questions, any missing `must_include` token is an automatic FAIL.
 */
export function effectiveVerdict(r: EvalResult): string {
  if (r.signals.mustNotIncludePresent.length > 0) return 'FAIL';
  if (r.question.critical && r.signals.mustIncludeMissing.length > 0) return 'FAIL';
  return r.verdict.verdict;
}
