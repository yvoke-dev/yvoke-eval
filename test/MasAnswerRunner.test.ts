import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { assembleMasBundle, UserTurns } from '../src/agent/MasAnswerRunner';
import { needsReviewEnforcement } from '../src/agent/orchestration';
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

  it('triggers clarify when expectBehavior is clarify, overriding post-denial prose and saving rawAnswer', () => {
    const b = assembleMasBundle(mkBundle({ answer: 'post denial prose' }), trace, { question: 'q', options: [] }, 'clarify');
    expect(b.answer).toBe('<clarifying-question>q</clarifying-question>');
    expect(b.rawAnswer).toBe('post denial prose');
    expect(b.orchestration).toBe(trace);
  });

  it('preserves answer when expectBehavior is answer and answer is non-empty', () => {
    const b = assembleMasBundle(mkBundle({ answer: 'full answer' }), trace, { question: 'q', options: [] }, 'answer');
    expect(b.answer).toBe('full answer');
    expect(b.orchestration).toBe(trace);
  });

  it('does NOT trigger clarify when clarify is undefined', () => {
    const b = assembleMasBundle(mkBundle({ answer: 'real answer' }), trace, undefined);
    expect(b.answer).toBe('real answer');
    expect(b.orchestration).toBe(trace);
  });
});

/**
 * The enforcement gate. It decides whether a finished run gets a second turn, so the two ways to get
 * it wrong are both bad: never firing leaves the 3 Sep behaviour (a skipped review just ends the
 * run), and firing on a clarify/refusal would re-prompt a run that has no composed answer to review.
 */
describe('needsReviewEnforcement', () => {
  it('fires when specialists were consulted and no reviewer was', () => {
    expect(needsReviewEnforcement({ specialistCallCount: 2, reviewRounds: 0 })).toBe(true);
  });

  it('does not fire when a review already happened', () => {
    expect(needsReviewEnforcement({ specialistCallCount: 2, reviewRounds: 1 })).toBe(false);
  });

  it('does not fire on a run with no delegations at all', () => {
    // A clarify or a direct refusal: no composed answer, nothing to validate, nothing to nudge.
    expect(needsReviewEnforcement({ specialistCallCount: 0, reviewRounds: 0 })).toBe(false);
  });
});

/**
 * The input generator has to stay open for a second turn to be pushable — `onceUser` completed
 * immediately, which is exactly why a skipped review ended the run — but it must still terminate, or
 * every mas question would hang forever waiting on a turn that never comes.
 */
describe('UserTurns', () => {
  const drain = async (t: UserTurns) => {
    const out: string[] = [];
    for await (const m of t.stream()) out.push(String(m.message.content));
    return out;
  };

  it('yields the first turn, then a pushed turn, then ends on close', async () => {
    const t = new UserTurns('question');
    const collected = drain(t);
    // Push and close asynchronously, as the runner does while consuming the SDK stream.
    await Promise.resolve();
    t.push('nudge');
    await Promise.resolve();
    t.close();
    expect(await collected).toEqual(['question', 'nudge']);
  });

  it('terminates on close alone, so a run that needs no nudge does not hang', async () => {
    const t = new UserTurns('question');
    const collected = drain(t);
    await Promise.resolve();
    t.close();
    expect(await collected).toEqual(['question']);
  });

  it('closing while a turn is still queued still delivers it', async () => {
    const t = new UserTurns('question');
    t.push('nudge');
    t.close();
    expect(await drain(t)).toEqual(['question', 'nudge']);
  });
});

/**
 * The wiring, not the pieces. Verified the hard way: stubbing the enforcement branch out of `run()`
 * left all the tests above green, because they exercise `needsReviewEnforcement` and `UserTurns`
 * directly. That is the same shape as the WebSearch domain gate (E10) and the roster gate — a
 * correct function nothing calls. `run()` itself drives `query()` and is integration-only, so this
 * asserts the source.
 */
describe('MasAnswerRunner.run — the enforcement is actually wired', () => {
  const src = readFileSync(new URL('../src/agent/MasAnswerRunner.ts', import.meta.url), 'utf8');

  it('consults needsReviewEnforcement on the result message and pushes the nudge', () => {
    expect(src).toMatch(/needsReviewEnforcement\(orchestrationTraceFromMessages\(messages\)\)/);
    expect(src).toMatch(/turns\.push\(REVIEW_ENFORCEMENT_PROMPT\)/);
  });

  it('is one-shot: the enforced flag guards the branch and the run closes otherwise', () => {
    expect(src).toMatch(/if \(!enforced && needsReviewEnforcement/);
    expect(src).toMatch(/turns\.close\(\)/);
  });

  it('records whether the nudge was needed, so reviewRounds can be read correctly', () => {
    expect(src).toMatch(/reviewEnforced:\s*enforced/);
  });

  it('forwards opts.abortController to SDK options', () => {
    expect(src).toMatch(/abortController:\s*opts\?\.abortController/);
  });
});

