import { describe, it, expect } from 'vitest';
import { ClaudeOrchestrationJudge } from '../src/reviewer/OrchestrationJudge';
import type { StructuredModel } from '../src/reviewer/Judge';
import { mkQuestion, mkTrace, mkDelegation, mkOrchestrationSignals } from './fixtures';

describe('ClaudeOrchestrationJudge', () => {
  it('sends the orchestration tool + a trace-bearing user message and returns the parsed verdict', async () => {
    let captured: { system: string; user: string; toolName: string } | undefined;
    const model: StructuredModel = {
      async complete(input) {
        captured = { system: input.system, user: input.user, toolName: input.toolName };
        return {
          verdict: 'PASS',
          dimensions: { delegation_routing: 'PASS', coordination_termination: 'PASS', reviewer_effectiveness: 'PASS' },
          reasoning: 'ok',
        };
      },
    };
    const judge = new ClaudeOrchestrationJudge(model, { model: 'opus', systemPrompt: 'ORCH RUBRIC' });
    const trace = mkTrace({
      delegations: [
        mkDelegation({ id: 'd1', subagentType: 'oim-getting-started', order: 0 }),
        mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 1, verdict: 'APPROVED' }),
      ],
      reviewRounds: 1,
      specialistCallCount: 1,
    });
    const v = await judge.review({
      question: mkQuestion({ expectedSpecialists: ['oim-getting-started'] }),
      answer: 'The clients are Manager and Designer [1].',
      orchestrationSignals: mkOrchestrationSignals({ delegatedSpecialists: ['oim-getting-started'], reviewRounds: 1, reviewInvoked: true, delegatedToExpectedSpecialist: true }),
      trace,
    });

    expect(v.verdict).toBe('PASS');
    expect(v.dimensions.delegation_routing).toBe('PASS');
    expect(captured?.system).toBe('ORCH RUBRIC');
    expect(captured?.toolName).toBe('record_orchestration_verdict');
    expect(captured?.user).toContain('## Orchestration trace');
    expect(captured?.user).toContain('oim-getting-started');
    expect(captured?.user).toContain('isReviewer=true');
  });

  it('returns an ERROR verdict when the model throws', async () => {
    const model: StructuredModel = {
      async complete() {
        throw new Error('orch boom');
      },
    };
    const judge = new ClaudeOrchestrationJudge(model, { model: 'opus', systemPrompt: 'r' });
    const v = await judge.review({
      question: mkQuestion(),
      answer: 'a',
      orchestrationSignals: mkOrchestrationSignals(),
      trace: mkTrace(),
    });
    expect(v.verdict).toBe('ERROR');
    expect(v.reasoning).toContain('orch boom');
  });
});
