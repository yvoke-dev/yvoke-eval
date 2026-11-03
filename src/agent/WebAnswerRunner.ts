import { UserError, type EvalQuestion } from '../types';
import type { PromptSource } from '../mcp/McpPrompts';
import type { AnswerBundle, EvalTask } from './AnswerBundle';
import type { AnswerRunner } from './SdkAnswerRunner';
import { WebChatClient, extractPlaybooksFromThreadHtml } from './WebChatClient';
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
  private readonly client: WebChatClient;

  constructor(private readonly opts: WebRunnerOptions) {
    this.client = new WebChatClient({
      baseUrl: opts.baseUrl,
      username: opts.username,
      password: opts.password,
      sessionCookie: opts.sessionCookie,
      fetchFn: opts.fetchFn,
      retryDelaysMs: opts.retryDelaysMs,
    });
  }

  async preflight(questions: EvalQuestion[], prompts: PromptSource): Promise<void> {
    const missingPlaybookQs = questions.filter((q) => !(q.playbook ?? this.opts.defaultPlaybook));
    if (missingPlaybookQs.length > 0) {
      const ids = missingPlaybookQs.map((q) => `${q.category}.${q.id}`).join(', ');
      throw new UserError(
        `Web provider requires a specialized playbook for every question, but the following question(s) have playbook=null: ${ids}. Set answer.web.defaultPlaybook in yvoke-eval.yaml.`,
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
          'Authenticated web user lacks ROLE_ADMIN required for /chat/{id}/messages/{messageId}/trace.',
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
      await this.client.deleteConversation(convId, AbortSignal.timeout(10_000)).catch(() => {});
    }
  }

  async run(task: EvalTask): Promise<AnswerBundle> {
    const effectivePlaybook = task.question.playbook ?? this.opts.defaultPlaybook ?? null;
    if (!effectivePlaybook) {
      throw new UserError(
        `Question ${task.question.category}.${task.question.id} has no playbook and answer.web.defaultPlaybook is not set.`,
      );
    }

    await this.client.ensureAuthenticated();

    const signal = task.abortController?.signal;
    const mappedThinkingLevel = task.thinkingLevel === 'off' ? 'minimal' : task.thinkingLevel;

    const convId = await this.client.createConversation(signal);
    try {
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

      const assistantMessageId = await this.client.sendAsyncWithBackoff(
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

      return bundleFromWebTrace(trace, { expect: task.question.expect });
    } catch (err) {
      if (task.abortController?.signal.aborted) {
        await this.client.stopConversation(convId, AbortSignal.timeout(10_000)).catch(() => {});
      }
      throw err;
    } finally {
      if (!this.opts.keepConversations) {
        await this.client.deleteConversation(convId, AbortSignal.timeout(10_000)).catch(() => {});
      }
    }
  }
}
