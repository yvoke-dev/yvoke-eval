import type { EvalQuestion, EvalResult, Signals } from '../types';
import { errorVerdict } from '../types';
import type { AnswerBundle } from '../agent/AnswerBundle';
import type { OrchestrationTrace } from '../agent/OrchestrationTrace';
import { extractSignals } from '../signals/SignalExtractor';
import { extractOrchestrationSignals, type OrchestrationCaps } from '../signals/OrchestrationSignalExtractor';
import type { Judge } from '../reviewer/Judge';
import { toEvidence } from '../reviewer/toolEvidence';
import type { OrchestrationJudge } from '../reviewer/OrchestrationJudge';

/**
 * Grade one already-produced answer: signals → verdict → EvalResult. The scoring core, independent of
 * how the answer was produced. Never throws — a failure yields an ERROR verdict (mirrors the Java
 * runner's per-question try/catch, incl. echoing must_include as "missing" on failure).
 */
export async function gradeOne(
  question: EvalQuestion,
  bundle: AnswerBundle,
  judge: Judge,
  latencyMs: number,
  abortController?: AbortController,
): Promise<EvalResult> {
  try {
    const signals = extractSignals(question, bundle);
    const evidence = toEvidence(bundle.toolCalls);
    const verdict = await judge.review({ question, answer: bundle.answer, signals, evidence, abortController });

    const isJudgeError = verdict.verdict === 'ERROR';
    // Hard deterministic guardrails enforced in code only when judge succeeded:
    if (!isJudgeError) {
      if (signals.mustNotIncludePresent.length > 0) {
        verdict.verdict = 'FAIL';
        verdict.dimensions.no_fabrication = 'FAIL';
        verdict.reasoning = `[Deterministic safety FAIL: must_not_include present: ${signals.mustNotIncludePresent.join(', ')}]\n${verdict.reasoning}`.trim();
      } else if (question.critical && signals.mustIncludeMissing.length > 0) {
        verdict.verdict = 'FAIL';
        verdict.dimensions.completeness = 'FAIL';
        verdict.reasoning = `[Deterministic completeness FAIL on critical question: missing ${signals.mustIncludeMissing.join(', ')}]\n${verdict.reasoning}`.trim();
      }
    }

    return {
      question,
      answer: bundle.answer,
      rawAnswer: bundle.rawAnswer ?? null,
      signals,
      verdict,
      promptTokens: bundle.promptTokens,
      completionTokens: bundle.completionTokens,
      totalTokens: bundle.totalTokens,
      latencyMs,
      error: isJudgeError ? (verdict.reasoning || 'reviewer call failed') : null,
      toolEvidence: evidence,
      costUsd: typeof bundle.providerMeta?.costUsd === 'number' ? bundle.providerMeta.costUsd : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      question,
      answer: bundle.answer,
      rawAnswer: bundle.rawAnswer ?? null,
      signals: {
        toolsFired: [],
        searchCollections: [],
        retrievedCollections: [],
        retrievedChunkCount: 0,
        mustIncludeMissing: [],
        mustNotIncludePresent: [],
        expectedToolsMissing: [],
        hasCitations: false,
      },
      verdict: errorVerdict(msg),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs,
      error: msg,
      toolEvidence: toEvidence(bundle.toolCalls),
      costUsd: typeof bundle.providerMeta?.costUsd === 'number' ? bundle.providerMeta.costUsd : undefined,
    };
  }
}

const EMPTY_TRACE: OrchestrationTrace = {
  delegations: [],
  reviewRounds: 0,
  specialistCallCount: 0,
  clarifyRequested: false,
};

/** A degenerate 7-field Signals for the orchestration path (which does not compute answer signals),
 *  so the required EvalResult.signals field stays populated and compare/promote's effectiveVerdict
 *  (reads signals.mustNotIncludePresent) never throws. */
function emptySignals(): Signals {
  return {
    toolsFired: [],
    searchCollections: [],
    retrievedCollections: [],
    retrievedChunkCount: 0,
    mustIncludeMissing: [],
    mustNotIncludePresent: [],
    expectedToolsMissing: [],
    hasCitations: false,
  };
}

/**
 * Grade one mas run for orchestration eval (Mode 3): orchestration signals → orchestration verdict →
 * EvalResult. The orchestration verdict is stored on BOTH `orchestrationVerdict` and `verdict` (so
 * compare/promote, which read `verdict`, work on this path), and `signals` is a degenerate placeholder
 * (answer-quality signals belong to specialist / MAS eval). Never throws — mirrors gradeOne.
 */
export async function gradeOrchestration(
  question: EvalQuestion,
  bundle: AnswerBundle,
  judge: OrchestrationJudge,
  latencyMs: number,
  caps: OrchestrationCaps,
  abortController?: AbortController,
): Promise<EvalResult> {
  const trace = bundle.orchestration ?? EMPTY_TRACE;
  try {
    const orchestrationSignals = extractOrchestrationSignals(question, trace, caps);
    const verdict = await judge.review({ question, answer: bundle.answer, orchestrationSignals, trace, abortController });
    const isJudgeError = verdict.verdict === 'ERROR';
    return {
      question,
      answer: bundle.answer,
      rawAnswer: bundle.rawAnswer ?? null,
      signals: emptySignals(),
      verdict,
      orchestrationSignals,
      orchestrationVerdict: verdict,
      orchestration: trace,
      promptTokens: bundle.promptTokens,
      completionTokens: bundle.completionTokens,
      totalTokens: bundle.totalTokens,
      latencyMs,
      error: isJudgeError ? (verdict.reasoning || 'orchestration reviewer call failed') : null,
      toolEvidence: toEvidence(bundle.toolCalls),
      costUsd: typeof bundle.providerMeta?.costUsd === 'number' ? bundle.providerMeta.costUsd : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      question,
      answer: bundle.answer,
      rawAnswer: bundle.rawAnswer ?? null,
      signals: emptySignals(),
      verdict: errorVerdict(msg),
      orchestration: trace,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs,
      error: msg,
      toolEvidence: toEvidence(bundle.toolCalls),
      costUsd: typeof bundle.providerMeta?.costUsd === 'number' ? bundle.providerMeta.costUsd : undefined,
    };
  }
}
