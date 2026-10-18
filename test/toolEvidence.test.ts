import { describe, it, expect } from 'vitest';
import { toEvidence, unwrapResult, MAX_RESULT_CHARS, MAX_TOTAL_CHARS } from '../src/reviewer/toolEvidence';
import { buildUserMessage } from '../src/reviewer/buildUserMessage';
import { mkQuestion, mcpTool } from './fixtures';
import type { Signals } from '../src/types';
import type { ToolInvocation } from '../src/agent/AnswerBundle';

const SIGNALS: Signals = {
  toolsFired: ['search_corpus'],
  searchCollections: ['OIM - Manuals - Getting Started - Standard'],
  retrievedCollections: ['OIM - Manuals - Getting Started - Standard'],
  retrievedChunkCount: 10,
  mustIncludeMissing: [],
  mustNotIncludePresent: [],
  expectedToolsMissing: [],
  hasCitations: true,
};

function call(over: Partial<ToolInvocation> & { name: string }): ToolInvocation {
  return { argumentsJson: '{}', resultText: 'ok', ...over };
}

describe('toEvidence', () => {
  it('keeps retrieval tools and strips the mcp prefix', () => {
    const ev = toEvidence([
      call({ name: mcpTool('search_corpus'), resultText: 'Searched **X** for: _y_' }),
      call({ name: mcpTool('get_graph_neighbors'), resultText: '| a | b |' }),
    ]);
    expect(ev.map((e) => e.name)).toEqual(['search_corpus', 'get_graph_neighbors']);
  });

  it('drops meta/UI tools, errors, and empty results — but keeps verify_citations', () => {
    const ev = toEvidence([
      call({ name: 'ToolSearch' }),
      call({ name: 'AskUserQuestion' }),
      call({ name: 'ask_clarifying_question' }),
      call({ name: 'search_corpus', isError: true }),
      call({ name: 'get_section', resultText: '   ' }),
      call({ name: 'verify_citations', resultText: 'REAL' }),
    ]);
    expect(ev.map((e) => e.name)).toEqual(['verify_citations']);
  });

  it('decodes a JSON-encoded graph result into real line breaks', () => {
    const raw = JSON.stringify('### Graph Entities\n| a | b |\n| 1 | 2 |');
    const ev = toEvidence([call({ name: 'search_graph_entities', resultText: raw })]);
    expect(ev[0].resultText).toContain('\n| a | b |');
    expect(ev[0].resultText.startsWith('"')).toBe(false);
  });

  it('leaves plain markdown (search_corpus) untouched', () => {
    const raw = 'Searched **OIM** for: _x_\n\n### hit';
    expect(unwrapResult(raw)).toBe(raw);
  });

  it('preserves a 45k-char 10-chunk search_corpus result under default caps (60k per result, 180k total)', () => {
    expect(MAX_RESULT_CHARS).toBe(60_000);
    expect(MAX_TOTAL_CHARS).toBe(180_000);
    const fullSearch = 'c'.repeat(45_000);
    const ev = toEvidence([call({ name: 'search_corpus', resultText: fullSearch })]);
    expect(ev[0].resultText).toHaveLength(45_000);
    expect(ev[0].resultText).not.toContain('[…truncated');
  });

  it('caps a single oversized result and marks the truncation', () => {
    const ev = toEvidence([call({ name: 'search_corpus', resultText: 'x'.repeat(5000) })], {
      maxResultChars: 100,
    });
    expect(ev[0].resultText).toContain('[…truncated 4900 chars]');
  });

  it('stops once the total budget is exhausted', () => {
    const ev = toEvidence(
      [
        call({ name: 'search_corpus', resultText: 'a'.repeat(200) }),
        call({ name: 'get_section', resultText: 'b'.repeat(200) }),
      ],
      { maxResultChars: 200, maxTotalChars: 200 },
    );
    expect(ev).toHaveLength(1);
  });
});

describe('buildUserMessage — evidence block', () => {
  const q = mkQuestion({ category: 'getting_started', id: 'Q4' });

  it('is absent when no evidence is supplied (back-compat)', () => {
    const msg = buildUserMessage(q, 'answer', SIGNALS);
    expect(msg).not.toContain('Tool evidence');
  });

  it('renders evidence OUTSIDE the "trust these" section, after the answer', () => {
    const msg = buildUserMessage(q, 'the answer', SIGNALS, [
      { name: 'get_graph_neighbors', argumentsJson: '{"entity_name":"RACFLdap"}', resultText: '| VI.Projector.RACFLdap |' },
    ]);
    expect(msg.indexOf('Tool evidence')).toBeGreaterThan(msg.indexOf('## Model answer to grade'));
    expect(msg.indexOf('Tool evidence')).toBeGreaterThan(msg.indexOf('trust these'));
    expect(msg).toContain('### [1] get_graph_neighbors');
    expect(msg).toContain('| VI.Projector.RACFLdap |');
  });

  it('warns the judge about query echoes (the fabrication-bait laundering path)', () => {
    const msg = buildUserMessage(q, 'a', SIGNALS, [
      { name: 'search_graph_entities', argumentsJson: '{}', resultText: "matching 'SchemaWizard.exe'" },
    ]);
    expect(msg).toMatch(/echoes the query/i);
  });
});
