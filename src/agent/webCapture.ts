import { FatalRunError } from '../types';
import type { AnswerBundle, ToolInvocation } from './AnswerBundle';
import { extractChunkIdsFromToolsAndAnswer } from './capture';

export interface WebToolCallTraceDto {
  seq?: number;
  id?: string;
  name: string;
  arguments?: string | null;
  result?: string | null;
  isError?: boolean;
}

export interface WebTokenUsageDto {
  prompt?: number | null;
  completion?: number | null;
  total?: number | null;
  cached?: number | null;
  thought?: number | null;
}

export interface WebMessageTraceDto {
  mode?: string | null;
  messageId?: string | null;
  conversationId?: string | null;
  status?: string | null;
  content?: string | null;
  model?: string | null;
  playbook?: string | null;
  playbookVersion?: number | null;
  tokens?: WebTokenUsageDto | null;
  retrievedChunkIds?: string[] | null;
  toolCalls?: WebToolCallTraceDto[] | null;
}

const WRENCH_BANNER = '🔧';
const MOJIBAKE_BANNERS = ['?? *Calling tool:*', '?? Calling tool:'] as const;

export function isWebToolBannerLine(trimmedLine: string): boolean {
  if (trimmedLine.startsWith(WRENCH_BANNER)) return true;
  for (const banner of MOJIBAKE_BANNERS) {
    if (trimmedLine.startsWith(banner)) return true;
  }
  return false;
}

export function hasWebToolBanner(text: string): boolean {
  if (!text) return false;
  for (const line of text.split(/\r?\n/)) {
    if (isWebToolBannerLine(line.trim())) return true;
  }
  return false;
}

/**
 * Port of yvoke-web's AssistantTranscript.toModelText:
 * 1. Removes balanced <think>...</think> blocks (non-greedy).
 * 2. Removes unclosed <think> at end of stream when no </think follows.
 * 3. Removes stray </think> closing tags.
 * 4. Filters out lines whose trimmed text starts with 🔧, '?? *Calling tool:*', or '?? Calling tool:'.
 * 5. Trims surrounding whitespace.
 */
export function cleanWebTranscript(raw: string): string {
  if (!raw) return '';
  let withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const opener = withoutThink.lastIndexOf('<think>');
  if (opener >= 0 && withoutThink.indexOf('</think', opener) < 0) {
    withoutThink = withoutThink.substring(0, opener);
  }
  withoutThink = withoutThink.replaceAll('</think>', '');

  const kept: string[] = [];
  for (const line of withoutThink.split(/\r?\n/)) {
    if (isWebToolBannerLine(line.trim())) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractClarifyingQuestion(
  toolCalls: ToolInvocation[],
  cleanedContent: string,
): { question: string; options: string[] } | undefined {
  for (const tc of toolCalls) {
    const bareName = tc.name.replace(/^mcp__.+?__/, '');
    if (bareName === 'ask_clarifying_question') {
      try {
        const parsed = JSON.parse(tc.argumentsJson) as { question?: unknown; options?: unknown };
        if (typeof parsed?.question === 'string' && parsed.question.trim().length > 0) {
          const options = Array.isArray(parsed.options)
            ? parsed.options.map((o) => String(o)).filter((o) => o.length > 0)
            : [];
          return { question: parsed.question, options };
        }
      } catch {
        // Fall through to XML extraction if tool arguments JSON is malformed
      }
    }
  }

  const blockMatch = /<clarifying-question>([\s\S]*?)<\/clarifying-question>/.exec(cleanedContent);
  if (!blockMatch) return undefined;
  const inner = blockMatch[1] ?? '';

  const qMatch = /<question>([\s\S]*?)<\/question>/.exec(inner);
  if (qMatch) {
    const question = unescapeXmlText(qMatch[1] ?? '').trim();
    const options: string[] = [];
    const optRe = /<option>([\s\S]*?)<\/option>/g;
    let m: RegExpExecArray | null;
    while ((m = optRe.exec(inner)) !== null) {
      options.push(unescapeXmlText(m[1] ?? '').trim());
    }
    if (question.length > 0) {
      return { question, options };
    }
  }

  // Already in synthesized format: <clarifying-question>Question\noptions: A | B</clarifying-question>
  const trimmedInner = inner.trim();
  if (trimmedInner.length > 0) {
    const [qPart, optsPart] = trimmedInner.split(/\noptions:\s*/);
    const question = (qPart ?? '').trim();
    const options = optsPart
      ? optsPart
          .split(/\s*\|\s*/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (question.length > 0) {
      return { question, options };
    }
  }

  return undefined;
}

/**
 * Converts a yvoke-web MessageTraceDto into a provider-agnostic AnswerBundle.
 */
export function bundleFromWebTrace(
  trace: WebMessageTraceDto,
  opts?: { expect?: string },
): AnswerBundle {
  const rawToolCalls = trace.toolCalls ?? [];
  const rawChunkIds = trace.retrievedChunkIds ?? [];
  const rawContent = trace.content ?? '';

  if (
    rawToolCalls.length === 0 &&
    (hasWebToolBanner(rawContent) || rawChunkIds.length > 0)
  ) {
    throw new FatalRunError(
      'yvoke-web returned 0 toolCalls in trace despite tool activity in the message. Start yvoke-web with APP_CHAT_TRACE_TOOL_CALLS=true (app.chat.trace-tool-calls=true).',
    );
  }

  const toolCalls: ToolInvocation[] = rawToolCalls.map((tc) => ({
    name: tc.name,
    argumentsJson: tc.arguments && tc.arguments.length > 0 ? tc.arguments : '{}',
    resultText: tc.result ?? '',
    isError: tc.isError === true,
  }));

  const cleanedContent = cleanWebTranscript(rawContent);
  const clarifyingXmlWithoutToolCall =
    rawToolCalls.length === 0 && cleanedContent.includes('<clarifying-question>');
  let answer = cleanedContent;
  let rawAnswer: string | undefined;

  const clarify = extractClarifyingQuestion(toolCalls, cleanedContent);
  if (clarify) {
    const nonClarifyProse = cleanedContent
      .replace(/<clarifying-question>[\s\S]*?<\/clarifying-question>/g, '')
      .trim();
    if (opts?.expect === 'clarify' || nonClarifyProse.length === 0) {
      const optsSuffix = clarify.options.length > 0 ? `\noptions: ${clarify.options.join(' | ')}` : '';
      const synthesized = `<clarifying-question>${clarify.question}${optsSuffix}</clarifying-question>`;
      if (cleanedContent.trim().length > 0 && cleanedContent !== synthesized) {
        rawAnswer = cleanedContent;
      }
      answer = synthesized;
    }
  }

  const extractedIds = extractChunkIdsFromToolsAndAnswer(toolCalls, answer);
  const retrievedChunkIds = [
    ...new Set([
      ...rawChunkIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => id.toLowerCase()),
      ...extractedIds.map((id) => id.toLowerCase()),
    ]),
  ];

  const promptTokens = trace.tokens?.prompt ?? 0;
  const completionTokens = trace.tokens?.completion ?? 0;
  const totalTokens =
    trace.tokens?.total && trace.tokens.total > 0
      ? trace.tokens.total
      : promptTokens + completionTokens;

  return {
    answer,
    ...(rawAnswer !== undefined ? { rawAnswer } : {}),
    toolCalls,
    retrievedChunkIds,
    promptTokens,
    completionTokens,
    totalTokens,
    providerMeta: {
      resolvedModel: trace.model ?? undefined,
      cachedTokens: trace.tokens?.cached ?? 0,
      thoughtTokens: trace.tokens?.thought ?? 0,
      playbook: trace.playbook ?? null,
      playbookVersion: trace.playbookVersion ?? null,
      messageId: trace.messageId ?? null,
      conversationId: trace.conversationId ?? null,
      ...(clarifyingXmlWithoutToolCall ? { clarifyingXmlWithoutToolCall: true } : {}),
    },
  };
}
