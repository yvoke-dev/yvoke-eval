import { describe, it, expect } from 'vitest';
import { orchestrationTraceFromMessages } from '../src/agent/orchestrationCapture';
import { bundleFromMessages, type StreamMessage } from '../src/agent/capture';
import { masDelegationStream, mcpTool } from './fixtures';

describe('orchestrationTraceFromMessages', () => {
  it('records a specialist delegation with subagentType, prompt, order, and result text', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream());
    const spec = t.delegations.find((d) => !d.isReviewer)!;
    expect(spec.subagentType).toBe('oim-getting-started');
    expect(spec.prompt).toContain('clients');
    expect(spec.order).toBe(0);
    expect(spec.resultText).toContain('Manager and Designer');
  });

  it('records the reviewer delegation and recovers the verdict despite interim narration + a tool call', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream({ reviewer: 'APPROVED' }));
    const rev = t.delegations.find((d) => d.isReviewer)!;
    expect(rev.isReviewer).toBe(true);
    expect(rev.subagentType).toBe('reviewer');
    expect(rev.verdict).toBe('APPROVED');
  });

  it('recovers a REJECTED verdict from forwarded text when no main-thread tool_result exists', () => {
    const t = orchestrationTraceFromMessages(
      masDelegationStream({ reviewer: 'REJECTED', reviewerViaToolResult: false }),
    );
    expect(t.delegations.find((d) => d.isReviewer)!.verdict).toBe('REJECTED');
  });

  it('leaves verdict undefined when the reviewer text has no APPROVED/REJECTED line', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream({ reviewer: 'MAYBE' }));
    expect(t.delegations.find((d) => d.isReviewer)!.verdict).toBeUndefined();
  });

  it('does NOT mistake the reviewer sub-agent tool-result noise for a verdict', () => {
    // The fixture's verify_citations result is 'REJECTED-LOOKING NOISE'; a correct fold ignores it.
    const t = orchestrationTraceFromMessages(masDelegationStream({ reviewer: 'APPROVED' }));
    expect(t.delegations.find((d) => d.isReviewer)!.verdict).toBe('APPROVED');
  });

  it('counts reviewRounds (reviewer) vs specialistCallCount (the rest) and carries numTurns', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream());
    expect(t.reviewRounds).toBe(1);
    expect(t.specialistCallCount).toBe(1);
    expect(t.numTurns).toBe(6);
  });

  it('captures every delegation as main-thread (parentId undefined) — single-tier topology', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream({ parallel: true }));
    expect(t.delegations.every((d) => d.parentId === undefined)).toBe(true);
  });

  it('captures parallel delegations in one assistant message with distinct order', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream({ parallel: true }));
    const specs = t.delegations.filter((d) => !d.isReviewer);
    expect(specs.map((d) => d.subagentType)).toEqual(['oim-getting-started', 'oim-access-governance']);
    expect(specs.map((d) => d.order)).toEqual([0, 1]);
  });

  it('detects the clarify path (ask_clarifying_question) with no delegations', () => {
    const t = orchestrationTraceFromMessages(masDelegationStream({ clarify: true }));
    expect(t.clarifyRequested).toBe(true);
    expect(t.delegations).toHaveLength(0);
  });

  it('GUARDRAIL: bundleFromMessages still ignores delegations (capture.ts untouched)', () => {
    const b = bundleFromMessages(masDelegationStream());
    const names = b.toolCalls.map((t) => t.name);
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('Task');
    expect(names).toContain(mcpTool('search_corpus'));
    expect(b.answer).not.toContain('searching'); // sub-agent chatter excluded
    expect(b.answer).toContain('Manager and Designer');
  });

  it('falls through to forwarded text when the reviewer Task tool_result is EMPTY (not just missing)', () => {
    const msgs: StreamMessage[] = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Agent', input: { subagent_type: 'reviewer', prompt: 'validate' } }] } },
      { type: 'assistant', parent_tool_use_id: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'APPROVED\nlooks good' }] } },
      // Empty main-thread Task result must NOT shadow the forwarded verdict ('' ?? x would keep '').
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '' }] } },
      { type: 'result', result: 'x', usage: {}, num_turns: 2, is_error: false },
    ];
    expect(orchestrationTraceFromMessages(msgs).delegations.find((d) => d.isReviewer)!.verdict).toBe('APPROVED');
  });

  it('captures isError from the result message', () => {
    expect(orchestrationTraceFromMessages(masDelegationStream()).isError).toBe(false);
    const errored: StreamMessage[] = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'd1', name: 'Agent', input: { subagent_type: 'oim-getting-started' } }] } },
      { type: 'result', result: '', usage: {}, num_turns: 40, is_error: true },
    ];
    expect(orchestrationTraceFromMessages(errored).isError).toBe(true);
  });
});
