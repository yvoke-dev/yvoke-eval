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

  it('rejects unterminated citation markers', () => {
    const s = extractSignals(
      mkQuestion(),
      mkBundle({ answer: 'Unterminated [chunk_id=11111111-1111-1111-1111-111111111111 is not a citation' }),
    );
    expect(s.hasCitations).toBe(false);
  });

  it('accepts comma-separated citation marker groups', () => {
    const s1 = extractSignals(
      mkQuestion(),
      mkBundle({ answer: 'Valid [11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222] marker' }),
    );
    expect(s1.hasCitations).toBe(true);

    const s2 = extractSignals(
      mkQuestion(),
      mkBundle({ answer: 'Valid [chunk_id=11111111-1111-1111-1111-111111111111, chunk_id=22222222-2222-2222-222222222222] marker' }),
    );
    expect(s2.hasCitations).toBe(true);

    const s3 = extractSignals(
      mkQuestion(),
      mkBundle({ answer: 'Valid [chunk_id=11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222] marker' }),
    );
    expect(s3.hasCitations).toBe(true);
  });

  it('flags must_include that is absent (case-insensitive)', () => {
    const q = mkQuestion({ mustInclude: ['AttestationPolicy'] });
    const s = extractSignals(q, mkBundle({ answer: 'a generic answer with no policy names' }));
    expect(s.mustIncludeMissing).toEqual(['AttestationPolicy']);
  });

  it('normalizes whitespace and backslashes in must_include and answer', () => {
    const q = mkQuestion({ mustInclude: ['Password Capture Agent\\Driver'] });
    const s = extractSignals(q, mkBundle({ answer: 'Check Password   Capture  Agent/Driver in HKLM' }));
    expect(s.mustIncludeMissing).toEqual([]);
  });

  it('evaluates mustIncludeAny disjunctions: passes if any alternative matches', () => {
    const q = mkQuestion({
      mustInclude: ['DialogTable'],
      mustIncludeAny: [['EMC CIFS', 'CIFS']],
    });
    // Matches "CIFS" alternative
    const s1 = extractSignals(q, mkBundle({ answer: 'Uses DialogTable and a storage device with CIFS enabled' }));
    expect(s1.mustIncludeMissing).toEqual([]);

    // Misses both alternatives
    const s2 = extractSignals(q, mkBundle({ answer: 'Uses DialogTable and an NFS share' }));
    expect(s2.mustIncludeMissing).toEqual(['EMC CIFS | CIFS']);
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

describe('extractSignals — whitespace and needle boundary handling', () => {
  it('does not trim needle with intentional trailing space (e.g. "Dim " must not match "dimension")', () => {
    const q = { ...mkQuestion(), mustNotInclude: ['Dim '] };
    const s = extractSignals(
      q,
      mkBundle({ answer: 'The script reads the dimension of the config parameter.' }),
    );
    expect(s.mustNotIncludePresent).toEqual([]);
  });

  it('matches needle with intentional trailing space when the token is genuinely present', () => {
    const q = { ...mkQuestion(), mustNotInclude: ['Dim '] };
    const s = extractSignals(
      q,
      mkBundle({ answer: 'Dim x As Integer\nx = Session.Config()' }),
    );
    expect(s.mustNotIncludePresent).toEqual(['Dim ']);
  });

  it('normalizes backslashes in both needle and haystack', () => {
    const q = { ...mkQuestion(), mustInclude: ['QER\\Person\\Blocked'] };
    const s = extractSignals(
      q,
      mkBundle({ answer: 'Look at QER/Person/Blocked configuration parameter.' }),
    );
    expect(s.mustIncludeMissing).toEqual([]);
  });
});

describe('extractSignals — toolsFired and errored tool calls', () => {
  it('excludes errored tool calls from toolsFired', () => {
    const q = mkQuestion({ expectToolCalled: ['search_corpus'] });
    const s = extractSignals(
      q,
      mkBundle({
        toolCalls: [
          { name: 'mcp__yvoke__search_corpus', argumentsJson: '{}', resultText: 'denied', isError: true },
        ],
      }),
    );
    expect(s.toolsFired).toEqual([]);
    expect(s.expectedToolsMissing).toEqual(['search_corpus']);
  });

  it('includes intercepted ask_clarifying_question even when isError is true', () => {
    const q = mkQuestion({ expectToolCalled: ['ask_clarifying_question'] });
    const s = extractSignals(
      q,
      mkBundle({
        toolCalls: [
          {
            name: 'mcp__yvoke__ask_clarifying_question',
            argumentsJson: '{"question":"Which version?"}',
            resultText: 'Captured by the eval harness',
            isError: true,
          },
        ],
      }),
    );
    expect(s.toolsFired).toEqual(['ask_clarifying_question']);
    expect(s.expectedToolsMissing).toEqual([]);
  });
});

describe('extractSignals — unverifiedCitations', () => {
  const FAKE_UUID = '12345678-1234-1234-1234-123456789abc';
  const REAL_UUID = '87654321-4321-4321-4321-cba987654321';

  it('flags cited UUIDs not present in retrieved chunks or tool evidence', () => {
    const q = mkQuestion();
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${FAKE_UUID}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [],
      }),
    );
    expect(s.unverifiedCitations).toEqual([FAKE_UUID]);
  });

  it('does not flag cited UUIDs that appear in retrieved chunks', () => {
    const q = mkQuestion();
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${REAL_UUID}], the setting is enabled.`,
        retrievedChunkIds: [REAL_UUID],
        toolCalls: [],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('does not count verify_citations output as evidence verifying a citation', () => {
    const q = mkQuestion();
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${FAKE_UUID}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [
          {
            name: 'verify_citations',
            argumentsJson: `{"chunk_id":"${FAKE_UUID}"}`,
            resultText: `[chunk_id=${FAKE_UUID}] status=REAL`,
            isError: false,
          },
        ],
      }),
    );
    expect(s.unverifiedCitations).toEqual([FAKE_UUID]);
  });

  it('does not count errored tool results as evidence for citations', () => {
    const q = mkQuestion();
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${FAKE_UUID}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [
          {
            name: 'get_section',
            argumentsJson: `{"chunk_id":"${FAKE_UUID}"}`,
            resultText: `Chunk body for ${FAKE_UUID}`,
            isError: true,
          },
        ],
      }),
    );
    expect(s.unverifiedCitations).toEqual([FAKE_UUID]);
  });

  it('detects unverified 32-hex unhyphenated citations', () => {
    const q = mkQuestion();
    const hex32 = '0123456789abcdef0123456789abcdef';
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${hex32}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [],
      }),
    );
    expect(s.unverifiedCitations).toEqual([hex32]);
  });

  it('verifies citation when answer cites unhyphenated 32-hex ID but retrieved chunkId has hyphens', () => {
    const q = mkQuestion();
    const unhyphenated = REAL_UUID.replace(/-/g, '');
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${unhyphenated}], the setting is enabled.`,
        retrievedChunkIds: [REAL_UUID],
        toolCalls: [],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('verifies citation when answer cites hyphenated UUID but tool result has unhyphenated 32-hex ID', () => {
    const q = mkQuestion();
    const unhyphenated = REAL_UUID.replace(/-/g, '');
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${REAL_UUID}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [
          {
            name: 'get_section',
            argumentsJson: `{"chunk_id":"${unhyphenated}"}`,
            resultText: `Found section in chunk ${unhyphenated}`,
            isError: false,
          },
        ],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('does not treat a 64-hex SHA-256 checksum in answer as cited UUIDs', () => {
    const q = mkQuestion();
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const s = extractSignals(
      q,
      mkBundle({
        answer: `The SHA-256 hash is ${sha256}.`,
        retrievedChunkIds: [],
        toolCalls: [],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('case-folds uppercase and mixed-case cited and evidence UUIDs', () => {
    const q = mkQuestion();
    const upperUuid = '8F7C1A2B-3D4E-4F50-8A1B-2C3D4E5F6071';
    const lowerUnhyphenated = '8f7c1a2b3d4e4f508a1b2c3d4e5f6071';
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${upperUuid}], the setting is enabled.`,
        retrievedChunkIds: [lowerUnhyphenated],
        toolCalls: [],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('normalizes UUIDs found in tool resultText against answer citations with different case and hyphens', () => {
    const q = mkQuestion();
    const toolHexUpper = 'ABCDEF1234567890ABCDEF1234567890';
    const answerHyphenLower = 'abcdef12-3456-7890-abcd-ef1234567890';
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${answerHyphenLower}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [
          {
            name: 'get_section',
            argumentsJson: `{"chunk_id":"${toolHexUpper}"}`,
            resultText: `Found section in chunk ${toolHexUpper}`,
            isError: false,
          },
        ],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('normalizes hyphenated UUIDs found in tool resultText against unhyphenated answer citations', () => {
    const q = mkQuestion();
    const toolHyphenLower = '12345678-abcd-ef01-2345-6789abcdef01';
    const answerUnhyphenUpper = '12345678ABCDEF0123456789ABCDEF01';
    const s = extractSignals(
      q,
      mkBundle({
        answer: `According to [${answerUnhyphenUpper}], the setting is enabled.`,
        retrievedChunkIds: [],
        toolCalls: [
          {
            name: 'get_section',
            argumentsJson: `{"chunk_id":"${toolHyphenLower}"}`,
            resultText: `Found section in chunk ${toolHyphenLower}`,
            isError: false,
          },
        ],
      }),
    );
    expect(s.unverifiedCitations).toBeUndefined();
  });

  it('respects word boundaries when evaluating must_include needles to prevent substring matching across alphanumeric boundaries', () => {
    const q = mkQuestion({
      mustInclude: ['connector is SAP'],
    });
    // Answer contains "connector is SAPR3" — SAP should NOT match SAPR3
    const s1 = extractSignals(
      q,
      mkBundle({
        answer: 'Yes. The connector is SAPR3 and its canonical identifier is connector:SAPR3-0001.',
      }),
    );
    expect(s1.mustIncludeMissing).toEqual(['connector is SAP']);

    // Answer contains "The connector is SAP." — should match
    const s2 = extractSignals(
      q,
      mkBundle({
        answer: 'In One Identity Manager, the connector is SAP.',
      }),
    );
    expect(s2.mustIncludeMissing).toEqual([]);
  });

  it('normalizes markdown formatting (bold, backticks) when matching must_include needles', () => {
    const q = mkQuestion({
      mustInclude: ['connector is SAP'],
    });
    // Answer contains bold markdown: "connector is **SAP**"
    const s1 = extractSignals(
      q,
      mkBundle({
        answer: 'The connector is **SAP** in 9.3.1.',
      }),
    );
    expect(s1.mustIncludeMissing).toEqual([]);

    // Answer contains code backticks: "connector is `SAP`"
    const s2 = extractSignals(
      q,
      mkBundle({
        answer: 'The connector is `SAP` in 9.3.1.',
      }),
    );
    expect(s2.mustIncludeMissing).toEqual([]);
  });

  it('matches trailing English plural "-s" for needles ending in alphanumeric characters', () => {
    const q = mkQuestion({
      mustInclude: ['support team', 'password template', 'internal transfer price', 'subscription'],
    });
    const s = extractSignals(
      q,
      mkBundle({
        answer:
          'We have support teams managing password templates, with internal transfer prices and multiple subscriptions.',
      }),
    );
    expect(s.mustIncludeMissing).toEqual([]);

    // Negative check: trailing alphanumeric continuation beyond "-s" must NOT match
    const qNeg = mkQuestion({
      mustInclude: ['support team'],
    });
    const sNeg = extractSignals(
      qNeg,
      mkBundle({
        answer: 'My support teammate is reviewing the request.',
      }),
    );
    expect(sNeg.mustIncludeMissing).toContain('support team');
  });

  it('enforces word boundaries on must_not_include to prevent false-positive substring hits', () => {
    const q = mkQuestion({
      mustNotInclude: ['SAP'],
    });
    // "SAPR3" should NOT trigger must_not_include for "SAP"
    const s1 = extractSignals(
      q,
      mkBundle({
        answer: 'The connector is SAPR3 in this environment.',
      }),
    );
    expect(s1.mustNotIncludePresent).toEqual([]);

    // Exact word "SAP" does trigger
    const s2 = extractSignals(
      q,
      mkBundle({
        answer: 'The connector is SAP in this environment.',
      }),
    );
    expect(s2.mustNotIncludePresent).toEqual(['SAP']);
  });

  it('enforces word boundaries on must_include_any', () => {
    const q = mkQuestion({
      mustIncludeAny: [['IApiProvider', 'IApiProviderFor']],
    });
    // "IApiProviderFor" matches the second alternative
    const s1 = extractSignals(
      q,
      mkBundle({
        answer: 'You must implement the IApiProviderFor<T> interface.',
      }),
    );
    expect(s1.mustIncludeMissing).toEqual([]);

    // Neither matches
    const s2 = extractSignals(
      q,
      mkBundle({
        answer: 'You must implement the ICustomProvider interface.',
      }),
    );
    expect(s2.mustIncludeMissing).toEqual(['IApiProvider | IApiProviderFor']);
  });

  it('handles leading word boundaries, markdown stripping of underscores/headings, and later occurrences', () => {
    const q = mkQuestion({
      mustInclude: ['SAP'],
    });

    // Leading non-alphanumeric (hyphen) matches, but alphanumeric prefix does not
    expect(extractSignals(q, mkBundle({ answer: 'This is anti-SAP tooling.' })).mustIncludeMissing).toEqual([]);
    expect(extractSignals(q, mkBundle({ answer: 'This is notSAP tooling.' })).mustIncludeMissing).toEqual(['SAP']);

    // Markdown underscore and heading stripping
    expect(extractSignals(q, mkBundle({ answer: 'Review _SAP_ carefully.' })).mustIncludeMissing).toEqual([]);
    expect(extractSignals(q, mkBundle({ answer: '# SAP System Details' })).mustIncludeMissing).toEqual([]);

    // Later occurrence: first occurrence is inside "SAPR3", but later occurrence is standalone "SAP"
    expect(
      extractSignals(q, mkBundle({ answer: 'It is not SAPR3; the true connector is SAP.' })).mustIncludeMissing,
    ).toEqual([]);
  });

  describe('Phase 4: Matcher Boundary, Plural Pinning & C# Negative Tests', () => {
    it('does not match C# when only C is present in text (negative tests)', () => {
      const q = mkQuestion({ mustInclude: ['C#'] });
      expect(extractSignals(q, mkBundle({ answer: 'Programming in C and .NET' })).mustIncludeMissing).toEqual(['C#']);
      expect(extractSignals(q, mkBundle({ answer: 'Vitamin C is found in citrus' })).mustIncludeMissing).toEqual(['C#']);
    });

    it('does not match F# when only F is present in text (negative test)', () => {
      const q = mkQuestion({ mustInclude: ['F#'] });
      expect(extractSignals(q, mkBundle({ answer: 'Use Option F for the form' })).mustIncludeMissing).toEqual(['F#']);
    });

    it('matches C# when C# is present in text (positive test)', () => {
      const q = mkQuestion({ mustInclude: ['C#'] });
      expect(extractSignals(q, mkBundle({ answer: 'Programming in C# and .NET' })).mustIncludeMissing).toEqual([]);
    });

    it('does not match SAP against SAPS4 in plural boundary check', () => {
      const q = mkQuestion({ mustInclude: ['SAP'] });
      expect(extractSignals(q, mkBundle({ answer: 'The system is SAPS4 in this deployment' })).mustIncludeMissing).toEqual(['SAP']);
    });

    it('matches internal underscore markdown stripping (One _Identity_ Manager matches One Identity Manager)', () => {
      const q = mkQuestion({ mustInclude: ['One Identity Manager'] });
      expect(extractSignals(q, mkBundle({ answer: 'Welcome to One _Identity_ Manager docs.' })).mustIncludeMissing).toEqual([]);
    });

    it('matches internal asterisk markdown stripping (One *Identity* Manager and **SAP** R/3)', () => {
      const q1 = mkQuestion({ mustInclude: ['One Identity Manager'] });
      expect(extractSignals(q1, mkBundle({ answer: 'Welcome to One *Identity* Manager docs.' })).mustIncludeMissing).toEqual([]);

      const q2 = mkQuestion({ mustInclude: ['SAP R/3'] });
      expect(extractSignals(q2, mkBundle({ answer: 'Connector for **SAP** R/3 system.' })).mustIncludeMissing).toEqual([]);
    });

    it('enforces word boundary collisions in must_include_any (connector is SAP against SAPR3)', () => {
      const q = mkQuestion({
        mustIncludeAny: [['connector is SAP', 'SAP R/3 User Management Module']],
      });
      // "The connector is SAPR3." should NOT match "connector is SAP"
      expect(extractSignals(q, mkBundle({ answer: 'The connector is SAPR3.' })).mustIncludeMissing).toEqual([
        'connector is SAP | SAP R/3 User Management Module',
      ]);
      // "The connector is SAP." should match
      expect(extractSignals(q, mkBundle({ answer: 'The connector is SAP.' })).mustIncludeMissing).toEqual([]);
    });
  });
});



