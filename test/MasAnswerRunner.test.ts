import { describe, it, expect } from 'vitest';
import { assembleMasBundle } from '../src/agent/MasAnswerRunner';
import { mkBundle, mkTrace, mkDelegation } from './fixtures';

describe('assembleMasBundle', () => {
  const trace = mkTrace({ delegations: [mkDelegation({ subagentType: 'oim-getting-started' })], specialistCallCount: 1 });

  it('attaches the orchestration trace to the bundle', () => {
    const b = assembleMasBundle(mkBundle({ answer: 'composed' }), trace);
    expect(b.answer).toBe('composed');
    expect(b.orchestration).toBe(trace);
  });

  it('preserves the trace on the clarify fallback (empty answer + captured clarification)', () => {
    const b = assembleMasBundle(mkBundle({ answer: '' }), trace, { question: 'Which version?', options: ['9.2', '9.3'] });
    expect(b.answer).toContain('<clarifying-question>Which version?');
    expect(b.answer).toContain('options: 9.2 | 9.3');
    expect(b.orchestration).toBe(trace); // trace still attached on the clarify branch
  });

  it('does NOT trigger clarify when a real answer is present', () => {
    const b = assembleMasBundle(mkBundle({ answer: 'real answer' }), trace, { question: 'q', options: [] });
    expect(b.answer).toBe('real answer');
    expect(b.orchestration).toBe(trace);
  });
});
