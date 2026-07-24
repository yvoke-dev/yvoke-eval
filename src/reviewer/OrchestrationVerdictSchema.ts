// The structured-output contract for the ORCHESTRATION grader (Mode 3). Mirrors VerdictSchema.ts but
// scores the coordination PROCESS, not the answer. MVP dimensions (synthesis_fidelity is deferred
// until a real trace proves specialist result-text attribution — see docs/orchestration-eval-design.md §4).

export const ORCH_DIMENSIONS = [
  'delegation_routing',
  'coordination_termination',
  'reviewer_effectiveness',
] as const;

export type OrchDimension = (typeof ORCH_DIMENSIONS)[number];

const dimEnum = { type: 'string', enum: ['PASS', 'PARTIAL', 'FAIL', 'NA'] } as const;

export const ORCH_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'dimensions', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PARTIAL', 'FAIL'] },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: [...ORCH_DIMENSIONS],
      properties: Object.fromEntries(ORCH_DIMENSIONS.map((d) => [d, dimEnum])),
    },
    reasoning: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * Plain-language rendering of the schema, appended to the grader prompt — load-bearing because the
 * Agent SDK judge (subscription auth) has no responseSchema binding, so the flat shape parseVerdict
 * expects must be spelled out.
 */
export const ORCH_VERDICT_CONTRACT = [
  'Respond with ONLY a JSON object — no prose before or after, no markdown fences — with EXACTLY these keys:',
  '{',
  '  "verdict": "PASS" | "PARTIAL" | "FAIL",',
  `  "dimensions": { ${ORCH_DIMENSIONS.map((d) => `"${d}": D`).join(', ')} },`,
  '  "reasoning": "one short paragraph",',
  '  "evidence": ["string", "..."]',
  '}',
  'Each dimension value D is one of "PASS" | "PARTIAL" | "FAIL" | "NA".',
  'Put the verdict as a top-level STRING (not nested); put each dimension value as a STRING (not nested).',
].join('\n');
