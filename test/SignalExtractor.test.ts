import { describe, it, expect } from 'vitest';
import { extractSignals } from '../src/signals/SignalExtractor';
import {
  mkQuestion,
  mkBundle,
  searchCorpusCall,
  getSectionCall,
  GOOD_ANSWER,
  GS_STANDARD,
} from './fixtures';

describe('extractSignals', () => {
  it('extracts tools, collections, chunks and citations from a good search answer', () => {
    const s = extractSignals(GOOD_ANSWER.question, GOOD_ANSWER.bundle);
    expect(s.toolsFired).toEqual(['search_corpus']); // server prefix stripped
    expect(s.searchCollections).toEqual([GS_STANDARD]);
    expect(s.retrievedCollections).toEqual([GS_STANDARD]); // from the result header
    expect(s.retrievedChunkCount).toBe(1);
    expect(s.hasCitations).toBe(true);
    expect(s.mustIncludeMissing).toEqual([]);
    expect(s.mustNotIncludePresent).toEqual([]);
  });

  it('flags must_include that is absent (case-insensitive)', () => {
    const q = mkQuestion({ mustInclude: ['AttestationPolicy'] });
    const s = extractSignals(q, mkBundle({ answer: 'a generic answer with no policy names' }));
    expect(s.mustIncludeMissing).toEqual(['AttestationPolicy']);
  });

  it('flags must_not_include (fabrication bait) that appears', () => {
    const q = mkQuestion({ mustNotInclude: ['SchemaWizard.exe'] });
    const s = extractSignals(q, mkBundle({ answer: 'Use SCHEMAWIZARD.EXE to do X' }));
    expect(s.mustNotIncludePresent).toEqual(['SchemaWizard.exe']);
  });

  it('does not count a collection when no chunks were retrieved', () => {
    const s = extractSignals(
      mkQuestion(),
      mkBundle({ toolCalls: [searchCorpusCall(GS_STANDARD)], retrievedChunkIds: [] }),
    );
    expect(s.retrievedCollections).toEqual([]);
    expect(s.retrievedChunkCount).toBe(0);
  });

  it('ignores an errored search_corpus for retrieved collections', () => {
    const s = extractSignals(
      mkQuestion(),
      mkBundle({
        toolCalls: [searchCorpusCall(GS_STANDARD, { error: true })],
        retrievedChunkIds: ['22222222-2222-2222-2222-222222222222'],
      }),
    );
    expect(s.retrievedCollections).toEqual([]);
  });

  it('handles a get_section-only browse answer (chunks present, no collection mapping)', () => {
    const s = extractSignals(
      mkQuestion(),
      mkBundle({
        answer: 'Here are the steps [1].',
        toolCalls: [getSectionCall('33333333-3333-3333-3333-333333333333')],
        retrievedChunkIds: ['aaaa', 'bbbb'],
      }),
    );
    expect(s.toolsFired).toEqual(['get_section']);
    expect(s.retrievedChunkCount).toBe(2);
    expect(s.retrievedCollections).toEqual([]); // documented DB-free fidelity delta
    expect(s.hasCitations).toBe(true);
  });

  it('detects a References section without numbered markers as citations', () => {
    const s = extractSignals(mkQuestion(), mkBundle({ answer: 'text\n\n## References\n- a manual' }));
    expect(s.hasCitations).toBe(true);
  });

  it('dedups repeated tools and collections', () => {
    const s = extractSignals(
      mkQuestion(),
      mkBundle({
        toolCalls: [searchCorpusCall(GS_STANDARD), searchCorpusCall(GS_STANDARD)],
        retrievedChunkIds: ['x'],
      }),
    );
    expect(s.toolsFired).toEqual(['search_corpus']);
    expect(s.searchCollections).toEqual([GS_STANDARD]);
    expect(s.retrievedCollections).toEqual([GS_STANDARD]);
  });
});
