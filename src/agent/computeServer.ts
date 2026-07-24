/**
 * In-process MCP server exposing the safe compute helpers (computeTools.ts) to the model
 * as `mcp__compute__*` tools. Runs entirely in the main process with no shell, filesystem,
 * or network access — the cross-platform, Windows-safe alternative to the `Bash` tool.
 *
 * COPIED VERBATIM from yvoke-desktop/src/main/agent/computeServer.ts. The eval must reproduce production's tool
 * surface exactly, so this cannot drift: if the desktop copy changes, change this one in the same
 * commit. Duplicated rather than shared because the two repos have no common package — extracting
 * one is the right long-term fix and is tracked with the desktop work.
 */
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { COMPUTE_SERVER_NAME, computeStatistics, dateDiff, safeCalculate } from './computeTools';

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fresh in-process compute server; the SDK namespaces its tools as `mcp__compute__<name>`. */
export function buildComputeServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COMPUTE_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Safe in-process computation tools. Use these for arithmetic, statistics, and date math instead of writing or running code.',
    tools: [
      tool(
        'calculate',
        'Evaluate an arithmetic expression and return the numeric result. Supports + - * / % ^ (** for power), ' +
          'parentheses, functions (abs, sign, sqrt, cbrt, round, floor, ceil, exp, ln, log, log2, sin, cos, tan, ' +
          'pow, hypot, min, max) and constants (pi, e, tau). Pure math only — no variables or code.',
        { expression: z.string().describe('e.g. "(1200 * 1.19) / 12"') },
        async ({ expression }): Promise<CallToolResult> => {
          try {
            return ok({ expression, result: safeCalculate(expression) });
          } catch (err) {
            return fail(`calculate error: ${messageOf(err)}`);
          }
        },
      ),
      tool(
        'statistics',
        'Compute summary statistics (count, sum, mean, median, min, max, range, sample variance and standard ' +
          'deviation) over a list of numbers.',
        { values: z.array(z.number()).describe('the numeric values to summarize') },
        async ({ values }): Promise<CallToolResult> => {
          try {
            return ok(computeStatistics(values));
          } catch (err) {
            return fail(`statistics error: ${messageOf(err)}`);
          }
        },
      ),
      tool(
        'date_diff',
        'Compute the signed difference (to − from) between two ISO-8601 date/times in the given unit.',
        {
          from: z.string().describe('ISO date/time, e.g. "2024-01-01"'),
          to: z.string().describe('ISO date/time, e.g. "2024-03-15T12:00:00Z"'),
          unit: z.enum(['weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds']).optional(),
        },
        async ({ from, to, unit }): Promise<CallToolResult> => {
          try {
            const resolved = unit ?? 'days';
            return ok({ from, to, unit: resolved, difference: dateDiff(from, to, resolved) });
          } catch (err) {
            return fail(`date_diff error: ${messageOf(err)}`);
          }
        },
      ),
    ],
  });
}
