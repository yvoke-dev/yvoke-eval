import { describe, it, expect } from 'vitest';
import { ClaudeJudge, parseVerdict, type StructuredModel } from '../src/reviewer/Judge';
import { buildUserMessage } from '../src/reviewer/buildUserMessage';
import { DIMENSIONS } from '../src/reviewer/VerdictSchema';
import { ORCH_DIMENSIONS } from '../src/reviewer/OrchestrationVerdictSchema';
import { mkQuestion } from './fixtures';
import type { Signals } from '../src/types';

const SIGNALS: Signals = {
  toolsFired: ['search_corpus'],
  searchCollections: ['OIM - Manuals - Getting Started - Standard'],
  retrievedCollections: ['OIM - Manuals - Getting Started - Standard'],
  retrievedChunkCount: 3,
  mustIncludeMissing: [],
  mustNotIncludePresent: [],
  hasCitations: true,
};

describe('parseVerdict', () => {
  it('maps a full verdict object', () => {
    const v = parseVerdict({
      verdict: 'PASS',
      dimensions: {
        routing: 'PASS',
        grounding: 'PASS',
        stop_rule: 'NA',
        no_fabrication: 'PASS',
        citations: 'PASS',
        completeness: 'PARTIAL',
      },
      reasoning: 'looks good',
      evidence: ['cited the manual'],
    });
    expect(v.verdict).toBe('PASS');
    expect(v.dimensions.completeness).toBe('PARTIAL');
    expect(v.reasoning).toBe('looks good');
    expect(v.evidence).toEqual(['cited the manual']);
  });

  it('defaults missing dimensions to NA and fills all six', () => {
    const v = parseVerdict({ verdict: 'FAIL', dimensions: { routing: 'FAIL' }, reasoning: '' });
    expect(Object.keys(v.dimensions).sort()).toEqual([...DIMENSIONS].sort());
    expect(v.dimensions.grounding).toBe('NA');
  });

  it('returns an ERROR verdict on a non-object', () => {
    expect(parseVerdict(null).verdict).toBe('ERROR');
    expect(parseVerdict('nope').verdict).toBe('ERROR');
  });

  it('normalizes lower-case and reads nested verdict/dimension shapes', () => {
    const v = parseVerdict({
      verdict: 'pass',
      dimensions: { routing: { score: 'pass' }, grounding: 'PARTIAL' },
      reasoning: 'x',
    });
    expect(v.verdict).toBe('PASS');
    expect(v.dimensions.routing).toBe('PASS'); // unwrapped from { score }
    expect(v.dimensions.grounding).toBe('PARTIAL');
    expect(v.dimensions.citations).toBe('NA'); // absent → default
  });

  it('reads a nested overall verdict field', () => {
    expect(parseVerdict({ verdict: { overall: 'FAIL' }, reasoning: '' }).verdict).toBe('FAIL');
  });

  it('fills a custom dimension set when passed one (orchestration), defaulting missing to NA', () => {
    const v = parseVerdict(
      { verdict: 'PARTIAL', dimensions: { delegation_routing: 'PASS' }, reasoning: '' },
      ORCH_DIMENSIONS,
    );
    expect(Object.keys(v.dimensions).sort()).toEqual([...ORCH_DIMENSIONS].sort());
    expect(v.dimensions.delegation_routing).toBe('PASS');
    expect(v.dimensions.reviewer_effectiveness).toBe('NA');
    // the default (specialist) dims are NOT present when a custom set is passed
    expect(v.dimensions.grounding).toBeUndefined();
  });
});

describe('buildUserMessage', () => {
  it('includes question meta, signals and the answer', () => {
    const q = mkQuestion({ bait: null, rubric: 'must name the clients' });
    const msg = buildUserMessage(q, 'Manager, Designer [1]', SIGNALS);
    expect(msg).toContain('expected_collection_contains: Getting Started');
    expect(msg).toContain('rubric: must name the clients');
    expect(msg).toContain('tools_fired: [search_corpus]');
    expect(msg).toContain('answer_has_citations: true');
    expect(msg).toContain('## Model answer to grade');
    expect(msg).toContain('Manager, Designer [1]');
  });

  it('surfaces the fabrication bait line only when present', () => {
    const withBait = buildUserMessage(mkQuestion({ bait: 'SchemaWizard.exe' }), 'x', SIGNALS);
    expect(withBait).toContain('fabrication_bait (MUST NOT be described as real): SchemaWizard.exe');
    const without = buildUserMessage(mkQuestion({ bait: null }), 'x', SIGNALS);
    expect(without).not.toContain('fabrication_bait');
  });

  it('shows a placeholder for an empty answer', () => {
    expect(buildUserMessage(mkQuestion(), '', SIGNALS)).toContain('(no answer produced)');
  });
});

describe('ClaudeJudge', () => {
  it('builds the request and returns the parsed verdict', async () => {
    let captured: { system: string; user: string; toolName: string } | undefined;
    const model: StructuredModel = {
      async complete(input) {
        captured = { system: input.system, user: input.user, toolName: input.toolName };
        return { verdict: 'PASS', dimensions: {}, reasoning: 'ok' };
      },
    };
    const judge = new ClaudeJudge(model, { model: 'opus', systemPrompt: 'GRADER RUBRIC' });
    const v = await judge.review({ question: mkQuestion(), answer: 'a [1]', signals: SIGNALS });

    expect(v.verdict).toBe('PASS');
    expect(captured?.system).toBe('GRADER RUBRIC');
    expect(captured?.toolName).toBe('record_verdict');
    expect(captured?.user).toContain('## Question under test');
  });

  it('returns an ERROR verdict when the model throws', async () => {
    const model: StructuredModel = {
      async complete() {
        throw new Error('boom');
      },
    };
    const judge = new ClaudeJudge(model, { model: 'opus', systemPrompt: 'r' });
    const v = await judge.review({ question: mkQuestion(), answer: 'a', signals: SIGNALS });
    expect(v.verdict).toBe('ERROR');
    expect(v.reasoning).toContain('boom');
  });
});
