import type { EvalQuestion, OrchestrationSignals, Verdict } from '../types';
import { errorVerdict } from '../types';
import type { OrchestrationTrace } from '../agent/OrchestrationTrace';
import { parseVerdict, type StructuredModel } from './Judge';
import { ORCH_DIMENSIONS, ORCH_VERDICT_SCHEMA, ORCH_VERDICT_CONTRACT } from './OrchestrationVerdictSchema';
import { buildOrchestrationUserMessage } from './buildOrchestrationUserMessage';

export interface OrchestrationJudgeRequest {
  question: EvalQuestion;
  answer: string;
  orchestrationSignals: OrchestrationSignals;
  trace: OrchestrationTrace;
}

/** The orchestration LLM-as-judge (Mode 3). Reuses the same StructuredModel transport as ClaudeJudge. */
export interface OrchestrationJudge {
  review(req: OrchestrationJudgeRequest): Promise<Verdict>;
  readonly resolvedModel?: string;
}

export interface OrchestrationJudgeOptions {
  model: string;
  /** The orchestration rubric, from `reviewer.orchestrationPromptFile` in the eval config. */
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export class ClaudeOrchestrationJudge implements OrchestrationJudge {
  constructor(
    private readonly model: StructuredModel,
    private readonly opts: OrchestrationJudgeOptions,
  ) {}

  get resolvedModel(): string | undefined {
    return this.model.resolvedModel;
  }

  async review(req: OrchestrationJudgeRequest): Promise<Verdict> {
    const user = `${buildOrchestrationUserMessage(req.question, req.answer, req.orchestrationSignals, req.trace)}\n\n---\n${ORCH_VERDICT_CONTRACT}`;
    try {
      const raw = await this.model.complete({
        system: this.opts.systemPrompt,
        user,
        model: this.opts.model,
        temperature: this.opts.temperature ?? 0,
        maxTokens: this.opts.maxTokens ?? 2048,
        toolName: 'record_orchestration_verdict',
        schema: ORCH_VERDICT_SCHEMA,
      });
      return parseVerdict(raw, ORCH_DIMENSIONS);
    } catch (e) {
      return errorVerdict(`orchestration reviewer call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
