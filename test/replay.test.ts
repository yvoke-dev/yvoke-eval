import { describe, it, expect } from 'vitest';
import { buildReplayBundle, adjustReplaySignals } from '../scripts/replay';
import { MAX_RESULT_CHARS } from '../src/reviewer/toolEvidence';
import { mkQuestion } from './fixtures';
import { extractSignals } from '../src/signals/SignalExtractor';

describe('replay module', () => {
  const CHUNK_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const CHUNK_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('modern results with Array.isArray(o.retrievedChunkIds) carry forward unverifiedCitations directly', () => {
    const modernRecord = {
      answer: `Discussion citing [chunk_id=${CHUNK_A}] and [chunk_id=${CHUNK_B}].`,
      toolEvidence: [{ name: 'search_corpus', argumentsJson: '{}', resultText: `id=${CHUNK_A}` }],
      retrievedChunkIds: [CHUNK_A], // raw extraction would mark CHUNK_B as unverified
      signals: {
        unverifiedCitations: ['live-carried-forward-id'], // live run had this specific signal
      },
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };

    const { bundle, evidenceTruncated } = buildReplayBundle(modernRecord);
    expect(evidenceTruncated).toBe(false);
    expect(bundle.retrievedChunkIds).toEqual([CHUNK_A]);

    const q = mkQuestion();
    const signals = extractSignals(q, bundle);
    expect(signals.unverifiedCitations).toEqual([CHUNK_B]); // without adjust, it is CHUNK_B

    // Overwrite with live signals per modern contract
    adjustReplaySignals(signals, modernRecord, evidenceTruncated);

    expect(signals.unverifiedCitations).toEqual(['live-carried-forward-id']);
  });

  it('legacy results without retrievedChunkIds scrape IDs via regex from toolEvidence', () => {
    const legacyRecord = {
      answer: `Discussion citing [chunk_id=${CHUNK_A}].`,
      toolEvidence: [
        {
          name: 'search_corpus',
          argumentsJson: '{}',
          resultText: `Found ### title (score=0.9 id=${CHUNK_A} doc_id=none)\nBody with [chunk_id=${CHUNK_B}] marker.`,
        },
      ],
      // No retrievedChunkIds field (legacy run)
      signals: {},
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };

    const { bundle, evidenceTruncated } = buildReplayBundle(legacyRecord);
    expect(evidenceTruncated).toBe(false);
    expect(bundle.retrievedChunkIds).toEqual(expect.arrayContaining([CHUNK_A, CHUNK_B]));
    expect(bundle.retrievedChunkIds).toHaveLength(2);
  });

  it('legacy results with evidence >= MAX_RESULT_CHARS or […truncated marker set evidenceTruncated = true and clear unverifiedCitations', () => {
    const truncatedText = 'x'.repeat(MAX_RESULT_CHARS) + '\n[…truncated 500 chars]';
    const legacyRecord = {
      answer: `Discussion citing [chunk_id=${CHUNK_A}].`,
      toolEvidence: [
        {
          name: 'search_corpus',
          argumentsJson: '{}',
          resultText: truncatedText, // evidence was truncated, chunk A may have been dropped past truncation point
        },
      ],
      // No retrievedChunkIds field (legacy run)
      signals: {},
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };

    const { bundle, evidenceTruncated } = buildReplayBundle(legacyRecord);
    expect(evidenceTruncated).toBe(true);
    expect(bundle.retrievedChunkIds).toEqual([]); // none found before truncation

    const q = mkQuestion();
    const signals = extractSignals(q, bundle);
    expect(signals.unverifiedCitations).toEqual([CHUNK_A]); // raw extraction thought A was unverified

    adjustReplaySignals(signals, legacyRecord, evidenceTruncated);
    expect(signals.unverifiedCitations).toBeUndefined(); // cleared to avoid false negative on truncated evidence
  });
});
