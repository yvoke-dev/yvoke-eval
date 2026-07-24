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
): Promise<EvalResult> {
  try {
    const signals = extractSignals(question, bundle);
    const evidence = toEvidence(bundle.toolCalls);
    const verdict = await judge.review({ question, answer: bundle.answer, signals, evidence });
    return {
      question,
      answer: bundle.answer,
      signals,
      verdict,
      promptTokens: bundle.promptTokens,
      completionTokens: bundle.completionTokens,
      totalTokens: bundle.totalTokens,
      latencyMs,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      question,
      answer: bundle.answer,
      signals: {
        toolsFired: [],
        searchCollections: [],
        retrievedCollections: [],
        retrievedChunkCount: 0,
        mustIncludeMissing: question.mustInclude,
        mustNotIncludePresent: [],
        hasCitations: false,
      },
      verdict: errorVerdict(msg),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs,
      error: msg,
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
): Promise<EvalResult> {
  const trace = bundle.orchestration ?? EMPTY_TRACE;
  try {
    const orchestrationSignals = extractOrchestrationSignals(question, trace, caps);
    const verdict = await judge.review({ question, answer: bundle.answer, orchestrationSignals, trace });
    return {
      question,
      answer: bundle.answer,
      signals: emptySignals(),
      verdict,
      orchestrationSignals,
      orchestrationVerdict: verdict,
      promptTokens: bundle.promptTokens,
      completionTokens: bundle.completionTokens,
      totalTokens: bundle.totalTokens,
      latencyMs,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      question,
      answer: bundle.answer,
      signals: emptySignals(),
      verdict: errorVerdict(msg),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs,
      error: msg,
    };
  }
}
