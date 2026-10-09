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

  /**
   * The deployed `default-chat` prompt writes bare ids inline and forbids numbering and a
   * References section outright. While this detector matched only `[1]`, every correctly-cited
   * answer reported false and the grader capped it at PARTIAL on citations — measuring the one
   * format the prompt disallows.
   */
  it('detects a bare inline id as a citation — the current deployed form', () => {
    const s = extractSignals(
      mkQuestion(),
      mkBundle({ answer: 'Attestation runs in cycles [8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071].' }),
    );
    expect(s.hasCitations).toBe(true);
  });

  it('detects a 32-hex id and the kinded legacy forms', () => {
    for (const cite of [
      '[8f7c1a2b3d4e4f508a1b2c3d4e5f6071]',
      '[chunk_id=8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071]',
      '[document_id=abc.def-1]',
      '[file=notes.md]',
    ]) {
      expect(extractSignals(mkQuestion(), mkBundle({ answer: `claim ${cite}` })).hasCitations).toBe(true);
    }
  });

  it('detects a markdown link as a citation — how a web source is attributed', () => {
    // A search result has no chunk and no document, so a link is the only honest form; an id
    // attached to one would be fabricated.
    const s = extractSignals(
      mkQuestion(),
      mkBundle({ answer: 'KB 4380945 describes the offline mirror ([KB 4380945](https://support.example.com/kb/4380945/x)).' }),
    );
    expect(s.hasCitations).toBe(true);
  });

  it('does not mistake ordinary bracketed prose for a citation', () => {
    for (const answer of [
      'The value [see the guide] is configurable.',
      'Set it to [true] or [false].',
      'A path like [/var/log] is fine.',
    ]) {
      expect(extractSignals(mkQuestion(), mkBundle({ answer })).hasCitations).toBe(false);
    }
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

/**
 * `expect_tool_called` was parsed into the question and then consumed by nothing — no signal, no
 * line in the judge's message, no check. Every assertion written with it was silently vacuous,
 * which is how questions requiring `WebSearch` or `get_section` passed without either firing.
 */
describe('extractSignals — expected tools', () => {
  it('reports an expected tool that never fired', () => {
    const q = { ...mkQuestion(), expectToolCalled: ['WebSearch', 'get_section'] };
    const s = extractSignals(q, mkBundle({ toolCalls: [] }));
    expect(s.expectedToolsMissing).toEqual(['WebSearch', 'get_section']);
  });

  it('is empty when every expected tool fired, matching on the bare name', () => {
    const q = { ...mkQuestion(), expectToolCalled: ['get_section', 'mcp__yvoke__search_corpus'] };
    const s = extractSignals(
      q,
      mkBundle({
        toolCalls: [
          { name: 'mcp__yvoke__get_section', argumentsJson: '{}', resultText: '', isError: false },
          { name: 'mcp__yvoke__search_corpus', argumentsJson: '{}', resultText: '', isError: false },
        ],
      }),
    );
    expect(s.expectedToolsMissing).toEqual([]);
  });

  it('is empty when the spec asks for nothing', () => {
    expect(extractSignals(mkQuestion(), mkBundle({})).expectedToolsMissing).toEqual([]);
  });
});
