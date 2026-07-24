// The JSON Schema for the grader's verdict. Bound as the grader's structured-output contract:
//   - Claude: as the input_schema of a forced `record_verdict` tool.
//   - Gemini: as responseJsonSchema on a tool-less generateContent call.
// Enums over scores → maximally reliable constrained decode + trivial aggregation.
// Mirrors de.palsoftware.yvoke.eval.VerdictSchema.

export const DIMENSIONS = [
  'routing',
  'grounding',
  'stop_rule',
  'no_fabrication',
  'citations',
  'completeness',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

const dimEnum = { type: 'string', enum: ['PASS', 'PARTIAL', 'FAIL', 'NA'] } as const;

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'dimensions', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PARTIAL', 'FAIL'] },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: [...DIMENSIONS],
      properties: Object.fromEntries(DIMENSIONS.map((d) => [d, dimEnum])),
    },
    reasoning: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * A plain-language rendering of the schema, appended to the grader prompt. Needed because the Agent
 * SDK (subscription auth) has no responseSchema binding, so the exact output shape must be spelled
 * out in the prompt (the flat top-level `verdict` + flat `dimensions` values are load-bearing for
 * parseVerdict).
 */
export const VERDICT_CONTRACT = [
  'Respond with ONLY a JSON object — no prose before or after, no markdown fences — with EXACTLY these keys:',
  '{',
  '  "verdict": "PASS" | "PARTIAL" | "FAIL",',
  `  "dimensions": { ${DIMENSIONS.map((d) => `"${d}": D`).join(', ')} },`,
  '  "reasoning": "one short paragraph",',
  '  "evidence": ["string", "..."]',
  '}',
  'Each dimension value D is one of "PASS" | "PARTIAL" | "FAIL" | "NA".',
  'Put the verdict as a top-level STRING (not nested); put each dimension value as a STRING (not nested).',
].join('\n');
