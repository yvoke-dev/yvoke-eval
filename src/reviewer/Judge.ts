import type { EvalQuestion, Signals, Verdict } from '../types';
import type { ToolEvidence } from '../agent/AnswerBundle';
import { errorVerdict } from '../types';
import { DIMENSIONS, VERDICT_SCHEMA, VERDICT_CONTRACT } from './VerdictSchema';
import { ORCH_DIMENSIONS } from './OrchestrationVerdictSchema';
import { buildUserMessage } from './buildUserMessage';

export interface JudgeRequest {
  question: EvalQuestion;
  answer: string;
  signals: Signals;
  /** Verbatim tool results the model received. Lets the judge resolve claims that carry no chunk id
   *  (graph/section reads) instead of treating them as ungrounded. Omitted → evidence block absent. */
  evidence?: ToolEvidence[];
  abortController?: AbortController;
}

/** The LLM-as-judge. Claude by default (ClaudeJudge); Gemini optional for cross-family audits. */
export interface Judge {
  review(req: JudgeRequest): Promise<Verdict>;
  readonly resolvedModel?: string;
}

/**
 * A model that returns a JSON object conforming to `schema` for a system+user prompt. Abstracts the
 * transport so ClaudeJudge is testable offline. Concrete impls: AnthropicMessagesModel (forced
 * tool-use) now; a subscription-auth Agent-SDK-backed model lands with the answer path in P2.
 */
export interface StructuredModel {
  readonly resolvedModel?: string;
  complete(input: {
    system: string;
    user: string;
    model: string;
    temperature: number;
    maxTokens: number;
    toolName: string;
    schema: unknown;
    abortController?: AbortController;
  }): Promise<unknown>;
}

/**
 * Derive overall verdict deterministically from dimension scores matching rubric:
 * - Orchestration (Mode 3): FAIL if any dimension is FAIL; PASS if all non-NA are PASS; PARTIAL otherwise.
 * - Answer-quality (Mode 1 & 2): FAIL if any hard constraint fails (stop_rule FAIL, no_fabrication FAIL,
 *   grounding FAIL, or on critical questions completeness/routing FAIL). PASS only if all non-NA are PASS.
 *   PARTIAL otherwise.
 */
export function deriveVerdictFromDimensions(
  dimensions: Record<string, string>,
  rawVerdict?: string,
  isCritical: boolean = false,
  dims: readonly string[] = DIMENSIONS,
): string {
  const vals = Object.values(dimensions);
  const nonNa = vals.filter((v) => v !== 'NA');
  // When no specific dimension evaluations are present, retain the raw verdict if valid
  if (nonNa.length === 0) {
    return rawVerdict && rawVerdict !== 'ERROR' ? rawVerdict : (rawVerdict ?? 'ERROR');
  }

  // Check if evaluating orchestration dimensions (Mode 3):
  const isOrch =
    dims.some((d) => (ORCH_DIMENSIONS as readonly string[]).includes(d)) ||
    Object.keys(dimensions).some((d) => (ORCH_DIMENSIONS as readonly string[]).includes(d));

  if (isOrch) {
    if (vals.some((v) => v === 'FAIL')) return 'FAIL';
    if (vals.some((v) => v === 'ERROR')) return 'ERROR';
    if (nonNa.every((v) => v === 'PASS')) return 'PASS';
    return 'PARTIAL';
  }

  // Hard constraints from answer-quality rubric:
  if (
    dimensions['stop_rule'] === 'FAIL' ||
    dimensions['no_fabrication'] === 'FAIL' ||
    dimensions['grounding'] === 'FAIL' ||
    (isCritical && (dimensions['completeness'] === 'FAIL' || dimensions['routing'] === 'FAIL'))
  ) {
    return 'FAIL';
  }

  if (vals.some((v) => v === 'ERROR')) return 'ERROR';
  if (nonNa.every((v) => v === 'PASS')) return 'PASS';

  // Non-critical gaps in completeness/routing/citations or any PARTIAL -> PARTIAL
  return 'PARTIAL';
}

/**
 * Map a raw structured verdict object into our Verdict, defaulting anything missing. Tolerant of shape
 * variance (verdict/dimension values sometimes arrive nested), because the Agent SDK judge has no
 * responseSchema binding to guarantee the exact shape.
 */
export function parseVerdict(
  raw: unknown,
  dims: readonly string[] = DIMENSIONS,
  isCritical: boolean = false,
): Verdict {
  if (!raw || typeof raw !== 'object') {
    return errorVerdict('unparseable reviewer output');
  }
  const o = raw as Record<string, unknown>;
  const rawVerdict = pickEnum(o.verdict, ['verdict', 'overall', 'value', 'result', 'label']) ?? 'ERROR';
  const dimsIn =
    o.dimensions && typeof o.dimensions === 'object'
      ? (o.dimensions as Record<string, unknown>)
      : {};
  const dimensions: Record<string, string> = {};
  for (const dim of dims) {
    dimensions[dim] = pickEnum(dimsIn[dim], ['score', 'value', 'verdict', 'rating']) ?? 'NA';
  }
  const derivedVerdict = deriveVerdictFromDimensions(dimensions, rawVerdict, isCritical, dims);
  const verdict = derivedVerdict;
  let reasoning = typeof o.reasoning === 'string' ? o.reasoning : '';
  if (rawVerdict !== 'ERROR' && rawVerdict !== derivedVerdict) {
    reasoning = `[Verdict derived in code: ${derivedVerdict} (model returned ${rawVerdict})]\n${reasoning}`.trim();
  }
  const evidence = Array.isArray(o.evidence) ? o.evidence.map(String) : [];
  return { verdict, dimensions, reasoning, evidence };
}

/** Read an enum value that may be a bare string or nested under a common key; normalize to upper-case. */
function pickEnum(v: unknown, nestedKeys: string[]): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim().toUpperCase();
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of nestedKeys) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) {
        return (o[k] as string).trim().toUpperCase();
      }
    }
  }
  return undefined;
}

export interface ClaudeJudgeOptions {
  model: string;
  /** The grader rubric, loaded from the path named by `reviewer.promptFile` in the eval config. */
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export class ClaudeJudge implements Judge {
  constructor(
    private readonly model: StructuredModel,
    private readonly opts: ClaudeJudgeOptions,
  ) {}

  get resolvedModel(): string | undefined {
    return this.model.resolvedModel;
  }

  async review(req: JudgeRequest): Promise<Verdict> {
    const user = `${buildUserMessage(req.question, req.answer, req.signals, req.evidence)}\n\n---\n${VERDICT_CONTRACT}`;
    try {
      const raw = await this.model.complete({
        system: this.opts.systemPrompt,
        user,
        model: this.opts.model,
        temperature: this.opts.temperature ?? 0,
        maxTokens: this.opts.maxTokens ?? 2048,
        toolName: 'record_verdict',
        schema: VERDICT_SCHEMA,
        abortController: req.abortController,
      });
      return parseVerdict(raw, DIMENSIONS, req.question.critical);
    } catch (e) {
      return errorVerdict(`reviewer call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
