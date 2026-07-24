import type { ThinkingLevel } from '../types';

/** ThinkingLevel → maxThinkingTokens budget (ported from yvoke-desktop/src/main/agent/thinking.ts). */
export const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 4096,
  medium: 10_000,
  high: 31_999,
};

export function thinkingBudget(level: ThinkingLevel): number {
  return THINKING_BUDGETS[level];
}
