import { UserError, type EvalQuestion } from '../types';
import type { PromptSource } from '../mcp/McpPrompts';
import type { AnswerBundle, EvalTask } from './AnswerBundle';
import type { AnswerRunner } from './SdkAnswerRunner';
import { WebChatClient, createTimeoutSignal, extractPlaybooksFromThreadHtml } from './WebChatClient';
import { bundleFromWebTrace } from './webCapture';

export interface WebRunnerOptions {
  baseUrl: string;
  answerModel: string;
  defaultPlaybook: string | null;
  username?: string;
  password?: string;
  sessionCookie?: string;
  pollIntervalMs: number;
  keepConversations: boolean;
  fetchFn?: typeof fetch;
  retryDelaysMs?: number[];
  log?: (msg: string) => void;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Single-agent answer provider that drives yvoke-web's async chat endpoints
 * and converts MessageTraceDto into an AnswerBundle.
 */
export class WebAnswerRunner implements AnswerRunner {
  private static readonly CLEANUP_REQUEST_TIMEOUT_MS = 10_000;
  private static readonly CLEANUP_WAIT_CAP_MS = 25_000;
  private readonly client: WebChatClient;
  private readonly activeRuns = new Set<Promise<void>>();

  constructor(private readonly opts: WebRunnerOptions) {
    if (typeof opts.pollIntervalMs !== 'number' || !Number.isFinite(opts.pollIntervalMs) || opts.pollIntervalMs <= 0) {
      throw new UserError(
        `Invalid answer.web.pollIntervalMs "${String(opts.pollIntervalMs)}": must be a finite number > 0.`,
      );
    }
    this.client = new WebChatClient({
      baseUrl: opts.baseUrl,
      username: opts.username,
      password: opts.password,
      sessionCookie: opts.sessionCookie,
      fetchFn: opts.fetchFn,
      retryDelaysMs: opts.retryDelaysMs,
      log: opts.log,
    });
  }

  getServerVersion(): string | undefined {
    return this.client.getServerVersion();
  }

  private async withCleanupTimeout(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const { signal, clear } = createTimeoutSignal(WebAnswerRunner.CLEANUP_REQUEST_TIMEOUT_MS);
    try {
      await fn(signal);
    } finally {
      clear();
    }
  }

  async awaitCleanup(): Promise<void> {
    if (this.activeRuns.size === 0) return;
    const pending = Promise.all([...this.activeRuns]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WebAnswerRunner.CLEANUP_WAIT_CAP_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([pending, cap]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async preflight(questions: EvalQuestion[], prompts: PromptSource): Promise<void> {
    const missingPlaybookQs = questions.filter((q) => !(q.playbook ?? this.opts.defaultPlaybook));
    if (missingPlaybookQs.length > 0) {
      const ids = missingPlaybookQs.map((q) => `${q.category}.${q.id}`).join(', ');
      throw new UserError(
        `Web provider requires a specialized playbook for every question, but the following question(s) have playbook=null: ${ids}. Set answer.web.defaultPlaybook in yvoke-eval.yaml (note: answer.web.defaultPlaybook routes un-annotated questions through that specialist playbook rather than free/default chat).`,
      );
    }

    const distinctPlaybooks = [
      ...new Set(
        questions
          .map((q) => q.playbook ?? this.opts.defaultPlaybook)
          .filter((p): p is string => Boolean(p)),
      ),
    ];

    const mcpList = await prompts.list();
    const mcpNames = new Set(mcpList.map((p) => p.name));
    const missingFromMcp = distinctPlaybooks.filter((pb) => !mcpNames.has(pb));
    if (missingFromMcp.length > 0) {
      throw new UserError(
        `Playbook(s) not found in MCP server prompts.list(): ${missingFromMcp.join(', ')}. Available: ${[...mcpNames].join(', ') || 'none'}.`,
      );
    }

    await this.client.authenticate();

    const convId = await this.client.createConversation();
    try {
      const threadHtml = await this.client.getThreadHtml(convId);
      const webPlaybooks = new Set(extractPlaybooksFromThreadHtml(threadHtml));
      const missingFromWeb = distinctPlaybooks.filter((pb) => !webPlaybooks.has(pb));
      if (missingFromWeb.length > 0) {
        throw new UserError(
          `Playbook(s) ${missingFromWeb.join(', ')} not found in yvoke-web UI on /chat/${convId}. Available web playbooks: ${[...webPlaybooks].join(', ') || 'none'}.`,
        );
      }

      const traceStatus = await this.client.probeTraceAccess(convId);
      if (traceStatus === 403) {
        throw new UserError(
          'Authenticated web user lacks ROLE_ADMIN or ROLE_AREA_ADMIN required for /chat/{id}/messages/{messageId}/trace.',
        );
      }
      if (traceStatus !== 404 && traceStatus !== 200) {
        throw new UserError(
          `Unexpected status ${traceStatus} when probing /chat/${convId}/messages/.../trace.`,
        );
      }

      const modelStatus = await this.client.setModel(convId, this.opts.answerModel);
      if (modelStatus === 400) {
        throw new UserError(
          `Model "${this.opts.answerModel}" is rejected by yvoke-web (not in app.chat.allowed-models).`,
        );
      }
      if (modelStatus !== 200) {
        throw new UserError(
          `Unexpected status ${modelStatus} when probing /chat/${convId}/model for model "${this.opts.answerModel}".`,
        );
      }
    } finally {
      await this.withCleanupTimeout((sig) => this.client.deleteConversation(convId, sig)).catch(() => {});
    }
  }

  async run(task: EvalTask): Promise<AnswerBundle> {
    const signal = task.abortController?.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    const effectivePlaybook = task.question.playbook ?? this.opts.defaultPlaybook ?? null;
    if (!effectivePlaybook) {
      throw new UserError(
        `Question ${task.question.category}.${task.question.id} has no playbook and answer.web.defaultPlaybook is not set.`,
      );
    }

    await this.awaitCleanup();
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.activeRuns.add(settled);

    try {
      await this.client.ensureAuthenticated(signal);
      if (signal?.aborted) {
        throw signal.reason ?? new Error('Aborted');
      }

      const mappedThinkingLevel = task.thinkingLevel === 'off' ? 'minimal' : task.thinkingLevel;

      const convId = await this.client.createConversation(signal);
      let assistantMessageId: string | undefined;
      try {
        if (signal?.aborted) {
          throw signal.reason ?? new Error('Aborted');
        }

        const modelStatus = await this.client.setModel(convId, task.answerModel, signal);
        if (modelStatus === 400) {
          throw new UserError(
            `Model "${task.answerModel}" is rejected by yvoke-web (not in app.chat.allowed-models).`,
          );
        }
        if (modelStatus !== 200) {
          throw new Error(`POST /chat/${convId}/model failed with status ${modelStatus}.`);
        }

        await this.client.setThinkingLevel(convId, mappedThinkingLevel, signal);

        assistantMessageId = await this.client.sendAsyncWithBackoff(
          convId,
          task.modelContent,
          effectivePlaybook,
          signal,
        );

        while (true) {
          if (signal?.aborted) {
            throw signal.reason ?? new Error('Aborted');
          }
          const statusRes = await this.client.getMessageStatus(convId, assistantMessageId, signal);
          if (statusRes.status === 'generating') {
            await sleepAbortable(this.opts.pollIntervalMs, signal);
            continue;
          }
          if (statusRes.status === 'error' || statusRes.status === 'cancelled') {
            throw new Error(
              `yvoke-web generation ended with status="${statusRes.status}": ${statusRes.message?.content ?? ''}`,
            );
          }
          if (statusRes.status === 'done') {
            break;
          }
          throw new Error(`Unexpected message status "${String(statusRes.status)}" from yvoke-web.`);
        }

        const trace = await this.client.getMessageTrace(convId, assistantMessageId, signal);
        if (trace.status !== 'done') {
          throw new Error(`Expected trace.status="done", got "${String(trace.status)}".`);
        }

        const bundle = bundleFromWebTrace(trace, { expect: task.question.expect });
        if (bundle.providerMeta) {
          if (!bundle.providerMeta.conversationId) {
            bundle.providerMeta.conversationId = convId;
          }
          if (!bundle.providerMeta.messageId) {
            bundle.providerMeta.messageId = assistantMessageId;
          }
        }
        if (bundle.providerMeta?.clarifyingXmlWithoutToolCall === true) {
          (this.opts.log ?? console.error)(
            `[WARN] ${task.question.category}.${task.question.id}: <clarifying-question> XML emitted without ask_clarifying_question tool call in trace (used XML fallback).`,
          );
        }
        return bundle;
      } catch (err) {
        const attachIds = (target: unknown) => {
          if (target && typeof target === 'object') {
            const rec = target as Record<string, unknown>;
            if (convId) rec.webConversationId = convId;
            if (assistantMessageId) rec.webMessageId = assistantMessageId;
          }
        };
        attachIds(err);
        if (signal?.aborted) {
          attachIds(signal.reason);
        }
        if (task.abortController?.signal.aborted) {
          await this.withCleanupTimeout((sig) => this.client.stopConversation(convId, sig)).catch(() => {});
        }
        throw err;
      } finally {
        if (!this.opts.keepConversations) {
          await this.withCleanupTimeout((sig) => this.client.deleteConversation(convId, sig)).catch(() => {});
        }
      }
    } finally {
      this.activeRuns.delete(settled);
      markSettled();
    }
  }
}
