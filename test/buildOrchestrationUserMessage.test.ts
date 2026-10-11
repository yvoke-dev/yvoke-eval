import { describe, it, expect } from 'vitest';
import { buildOrchestrationUserMessage } from '../src/reviewer/buildOrchestrationUserMessage';
import { mkQuestion, mkTrace, mkDelegation, mkOrchestrationSignals } from './fixtures';

describe('buildOrchestrationUserMessage', () => {
  it('renders authored expectations, the trace signals, and the ordered delegation list', () => {
    const trace = mkTrace({
      delegations: [
        mkDelegation({ id: 'd1', subagentType: 'oim-getting-started', order: 0, prompt: 'which clients?' }),
        mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 1, verdict: 'APPROVED' }),
      ],
    });
    const msg = buildOrchestrationUserMessage(
      mkQuestion({ expectedSpecialists: ['oim-getting-started'], expectedDelegation: 'none', minReviewRounds: 1 }),
      'answer [1]',
      mkOrchestrationSignals({ delegatedSpecialists: ['oim-getting-started'], reviewRounds: 1, reviewInvoked: true }),
      trace,
    );
    expect(msg).toContain('expected_specialists: [oim-getting-started]');
    expect(msg).not.toContain('(UNAUTHORED');
    expect(msg).toContain('expected_delegation: none');
    expect(msg).toContain('min_review_rounds: 1');
    expect(msg).toContain('## Orchestration trace');
    expect(msg).toContain('terminated_abnormally: false');
    expect(msg).toContain('min_review_rounds_satisfiable: true');
    expect(msg).toContain('0. batch=0  oim-getting-started  isReviewer=false');
    expect(msg).toContain('1. batch=1  reviewer  isReviewer=true  verdict=APPROVED');
  });

  it('marks routing UNAUTHORED for BOTH undefined and empty expected_specialists', () => {
    expect(buildOrchestrationUserMessage(mkQuestion(), 'a', mkOrchestrationSignals(), mkTrace())).toContain('(UNAUTHORED — routing is NA)');
    expect(buildOrchestrationUserMessage(mkQuestion({ expectedSpecialists: [] }), 'a', mkOrchestrationSignals(), mkTrace())).toContain('(UNAUTHORED — routing is NA)');
  });

  it('omits the optional expected_delegation / min_review_rounds meta lines when unset', () => {
    const msg = buildOrchestrationUserMessage(mkQuestion(), 'a', mkOrchestrationSignals(), mkTrace());
    expect(msg).not.toContain('expected_delegation:');
    expect(msg).not.toMatch(/min_review_rounds: \d/); // the meta line, not the *_satisfied/_satisfiable signals
    expect(msg).toContain('min_review_rounds_satisfied: NA (unset)');
  });

  it('renders (no delegations) and an UNPARSED reviewer verdict', () => {
    expect(buildOrchestrationUserMessage(mkQuestion(), 'a', mkOrchestrationSignals(), mkTrace())).toContain('(no delegations)');
    const unparsed = buildOrchestrationUserMessage(
      mkQuestion(),
      'a',
      mkOrchestrationSignals({ reviewRounds: 1, reviewerVerdictsUnparsed: 1 }),
      mkTrace({ delegations: [mkDelegation({ id: 'r1', subagentType: 'reviewer', isReviewer: true, order: 0 })], reviewRounds: 1 }),
    );
    expect(unparsed).toContain('verdict=UNPARSED');
  });

  it('labels the answer as context-only (do not re-grade grounding)', () => {
    expect(buildOrchestrationUserMessage(mkQuestion(), 'the answer', mkOrchestrationSignals(), mkTrace())).toContain('do NOT re-grade grounding/citations');
  });
});

it('renders the observed delegation shape beside the authored expectation', () => {
  // The grader cannot infer concurrency from prose, so both must be on the page or the assertion is
  // decorative: `expected_delegation` used to be printed with no observed value to compare it to.
  const msg = buildOrchestrationUserMessage(
    mkQuestion({ expectedDelegation: 'parallel' }),
    'answer',
    mkOrchestrationSignals({
      delegationPattern: 'sequential',
      maxDelegationBatchWidth: 1,
      expectedDelegationSatisfied: false,
    }),
    mkTrace(),
  );
  expect(msg).toContain('expected_delegation: parallel');
  expect(msg).toContain('delegation_pattern: sequential');
  expect(msg).toContain('max_delegation_batch_width: 1');
  expect(msg).toContain('expected_delegation_satisfied: false');
});

it('says NA when no shape was authored, so the grader judges membership only', () => {
  const msg = buildOrchestrationUserMessage(mkQuestion(), 'answer', mkOrchestrationSignals(), mkTrace());
  expect(msg).toContain('expected_delegation_satisfied: NA (unset)');
  expect(msg).not.toContain('expected_delegation:');
});
