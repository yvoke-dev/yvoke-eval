import { describe, it, expect } from 'vitest';
import { WebAnswerRunner } from '../src/agent/WebAnswerRunner';
import { extractPlaybooksFromThreadHtml } from '../src/agent/WebChatClient';
import { FatalRunError } from '../src/types';
import type { PromptSource } from '../src/mcp/McpPrompts';
import type { EvalTask } from '../src/agent/AnswerBundle';
import { mkQuestion } from './fixtures';

const MOCK_LOGIN_HTML = `
<!DOCTYPE html>
<html>
<body>
  <form method="post" action="/login">
    <input type="text" name="username" />
    <input type="password" name="password" />
    <input type="hidden" name="_csrf" value="csrf-login-1" />
  </form>
</body>
</html>
`;

const MOCK_CHAT_HTML = (csrf = 'csrf-chat-1') => `
<!DOCTYPE html>
<html>
<head>
  <meta name="_csrf" content="${csrf}">
  <meta name="_csrf_header" content="X-CSRF-TOKEN">
</head>
<body>
  <div class="chat-layout">Chat Index</div>
</body>
</html>
`;

const MOCK_THREAD_HTML_CHAT_CONFIG = (playbooks: Array<{ name: string; description?: string }> = [{ name: 'demo-basics' }]) => `
<!DOCTYPE html>
<html>
<head>
  <meta name="_csrf" content="csrf-thread-1">
</head>
<body>
  <script>
    window.CHAT_CONFIG = {
      conversationId: "conv-1",
      isReadOnly: false,
      prompts: ${JSON.stringify(playbooks)},
      streaming: false
    };
  </script>
</body>
</html>
`;

const MOCK_THREAD_HTML_FALLBACK_CHIPS = (playbookNames: string[] = ['demo-basics']) => `
<!DOCTYPE html>
<html>
<head>
  <meta name="_csrf" content="csrf-thread-fallback">
</head>
<body>
  <div id="prompt-chips">
    ${playbookNames.map((n) => `<button type="button" class="chip" data-prompt-name="${n}">${n}</button>`).join('\n')}
  </div>
</body>
</html>
`;

function mockPrompts(names: string[] = ['demo-basics', 'oim-full']): PromptSource {
  return {
    list: async () => names.map((name) => ({ name, title: name, description: '', tools: ['search_corpus'], version: 1 })),
    getText: async () => 'PLAYBOOK TEXT',
    serverVersion: () => ({ name: 'yvoke', version: 'abc1234' }),
    close: async () => {},
  };
}

function mkTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    question: mkQuestion({ category: 'basics', id: 'Q1', playbook: 'demo-basics' }),
    modelContent: 'How does sync work?',
    answerModel: 'gemini-3.8-flash',
    systemPrompt: 'SYSTEM PROMPT',
    thinkingLevel: 'low',
    codeExecution: true,
    ...overrides,
  };
}

describe('extractPlaybooksFromThreadHtml', () => {
  it('parses window.CHAT_CONFIG.prompts JSON array primarily, including special characters and brackets in descriptions', () => {
    const html = MOCK_THREAD_HTML_CHAT_CONFIG([
      { name: 'oim-full', description: 'Full KB with [brackets] and "quotes"' },
      { name: 'oim-special:v2', description: 'Another [one]' },
    ]);
    expect(extractPlaybooksFromThreadHtml(html)).toEqual(['oim-full', 'oim-special:v2']);
  });

  it('falls back to data-prompt-name attributes when window.CHAT_CONFIG is absent', () => {
    const html = MOCK_THREAD_HTML_FALLBACK_CHIPS(['oim-full', 'oim-coding']);
    expect(extractPlaybooksFromThreadHtml(html)).toEqual(['oim-full', 'oim-coding']);
  });
});

describe('WebAnswerRunner — Cookie jar, session fixation, and authentication modes', () => {
  it('rotates JSESSIONID on POST /login and verifies step 3 GET /chat with the rotated cookie', async () => {
    const seenRequests: Array<{ url: string; method: string; cookie: string | null; csrfHeader: string | null }> = [];

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const cookie = headers.get('Cookie');
      const csrfHeader = headers.get('X-CSRF-TOKEN');
      seenRequests.push({ url, method, cookie, csrfHeader });

      if (url.endsWith('/login') && method === 'GET') {
        return new Response(MOCK_LOGIN_HTML, {
          status: 200,
          headers: { 'Set-Cookie': 'JSESSIONID=pre-login-session; Path=/; HttpOnly' },
        });
      }
      if (url.endsWith('/login') && method === 'POST') {
        expect(cookie).toContain('JSESSIONID=pre-login-session');
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/chat',
            'Set-Cookie': 'JSESSIONID=rotated-post-login-session; Path=/; HttpOnly',
          },
        });
      }
      if (url.endsWith('/chat') && method === 'GET') {
        // Must send rotated session cookie!
        if (!cookie?.includes('JSESSIONID=rotated-post-login-session')) {
          return new Response(null, { status: 302, headers: { Location: '/login' } });
        }
        return new Response(MOCK_CHAT_HTML('post-auth-csrf'), { status: 200 });
      }
      if (url.endsWith('/chat/new') && method === 'POST') {
        expect(cookie).toContain('JSESSIONID=rotated-post-login-session');
        expect(csrfHeader).toBe('post-auth-csrf');
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-preflight' } });
      }
      if (url.endsWith('/chat/conv-preflight') && method === 'GET') {
        return new Response(MOCK_THREAD_HTML_CHAT_CONFIG([{ name: 'demo-basics' }]), { status: 200 });
      }
      if (url.includes('/messages/00000000-0000-0000-0000-000000000000/trace')) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith('/chat/conv-preflight/model') && method === 'POST') {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/chat/conv-preflight/delete') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      pollIntervalMs: 10,
      keepConversations: true, // Even with keepConversations: true, preflight temp conv must be deleted!
      fetchFn,
    });

    await runner.preflight([mkQuestion({ playbook: 'demo-basics' })], mockPrompts());

    expect(seenRequests.some((r) => r.url.endsWith('/chat/conv-preflight/delete') && r.method === 'POST')).toBe(true);
  });

  it('rejects when step 3 GET /chat returns 302 or login page HTML after POST /login', async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'GET') {
        return new Response(MOCK_LOGIN_HTML, { status: 200 });
      }
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      if (url.endsWith('/chat') && method === 'GET') {
        return new Response(MOCK_LOGIN_HTML, { status: 200 }); // still login page!
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      pollIntervalMs: 10,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.preflight([mkQuestion({ playbook: 'demo-basics' })], mockPrompts())).rejects.toThrow(
      /Web login did not establish an authenticated session on \/chat/,
    );
  });

  it('supports sessionCookie mode and throws FatalRunError on mid-run 401/302 without attempting form login', async () => {
    let loginCalled = false;
    let statusPolls = 0;

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      if (url.endsWith('/login')) {
        loginCalled = true;
        return new Response(MOCK_LOGIN_HTML, { status: 200 });
      }
      if (url.endsWith('/chat') && method === 'GET') {
        expect(headers.get('Cookie')).toContain('JSESSIONID=my-preauth-cookie');
        return new Response(MOCK_CHAT_HTML('cookie-csrf'), { status: 200 });
      }
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-1' } });
      }
      if (url.endsWith('/chat/conv-1/model') || url.endsWith('/chat/conv-1/thinking-level')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/chat/conv-1/send-async')) {
        return new Response(JSON.stringify({ assistantMessageId: 'msg-1' }), { status: 202 });
      }
      if (url.endsWith('/chat/conv-1/messages/msg-1/status')) {
        statusPolls++;
        return new Response(null, { status: 302, headers: { Location: '/login' } });
      }
      if (url.endsWith('/chat/conv-1/delete')) {
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      sessionCookie: 'my-preauth-cookie',
      pollIntervalMs: 5,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.run(mkTask())).rejects.toThrow(FatalRunError);
    expect(loginCalled).toBe(false);
    expect(statusPolls).toBe(1);
  });
});

describe('WebAnswerRunner — Startup preflight checks', () => {
  it('rejects OAuth / non-mock /login page with actionable UserError', async () => {
    const fetchFn = (async () =>
      new Response(null, { status: 302, headers: { Location: '/oauth2/authorization/azure' } })) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      pollIntervalMs: 10,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.preflight([mkQuestion({ playbook: 'demo-basics' })], mockPrompts())).rejects.toThrow(
      /does not have mock form login enabled/,
    );
  });

  it('rejects when trace probe returns 403 Forbidden (missing ROLE_ADMIN)', async () => {
    let deletedTempConv = false;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'GET') return new Response(MOCK_LOGIN_HTML, { status: 200 });
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML(), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-temp' } });
      }
      if (url.endsWith('/chat/conv-temp') && method === 'GET') {
        return new Response(MOCK_THREAD_HTML_CHAT_CONFIG([{ name: 'demo-basics' }]), { status: 200 });
      }
      if (url.includes('/trace')) {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.endsWith('/chat/conv-temp/delete')) {
        deletedTempConv = true;
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      pollIntervalMs: 10,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.preflight([mkQuestion({ playbook: 'demo-basics' })], mockPrompts())).rejects.toThrow(
      /lacks ROLE_ADMIN/,
    );
    expect(deletedTempConv).toBe(true);
  });

  it('rejects when model probe returns 400 Bad Request (model not in allowed-models)', async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'GET') return new Response(MOCK_LOGIN_HTML, { status: 200 });
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML(), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-temp' } });
      }
      if (url.endsWith('/chat/conv-temp') && method === 'GET') {
        return new Response(MOCK_THREAD_HTML_FALLBACK_CHIPS(['demo-basics']), { status: 200 });
      }
      if (url.includes('/trace')) return new Response(null, { status: 404 });
      if (url.endsWith('/chat/conv-temp/model')) return new Response('Disallowed model', { status: 400 });
      if (url.endsWith('/chat/conv-temp/delete')) return new Response(null, { status: 302, headers: { Location: '/chat' } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'unknown-model-xyz',
      defaultPlaybook: null,
      pollIntervalMs: 10,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.preflight([mkQuestion({ playbook: 'demo-basics' })], mockPrompts())).rejects.toThrow(
      /Model "unknown-model-xyz" is rejected by yvoke-web/,
    );
  });

  it('rejects null playbook when defaultPlaybook is unset, and succeeds when defaultPlaybook is configured', async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'GET') return new Response(MOCK_LOGIN_HTML, { status: 200 });
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML(), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-temp' } });
      }
      if (url.endsWith('/chat/conv-temp') && method === 'GET') {
        return new Response(MOCK_THREAD_HTML_CHAT_CONFIG([{ name: 'oim-full' }]), { status: 200 });
      }
      if (url.includes('/trace')) return new Response(null, { status: 404 });
      if (url.endsWith('/chat/conv-temp/model')) return new Response(null, { status: 200 });
      if (url.endsWith('/chat/conv-temp/delete')) return new Response(null, { status: 302, headers: { Location: '/chat' } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runnerWithoutDefault = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      pollIntervalMs: 10,
      keepConversations: false,
      fetchFn,
    });

    await expect(
      runnerWithoutDefault.preflight([mkQuestion({ category: 'getting_started', id: 'Q1', playbook: null })], mockPrompts()),
    ).rejects.toThrow(/getting_started\.Q1.*answer\.web\.defaultPlaybook/);

    const runnerWithDefault = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: 'oim-full',
      pollIntervalMs: 10,
      keepConversations: false,
      fetchFn,
    });

    await expect(
      runnerWithDefault.preflight([mkQuestion({ category: 'getting_started', id: 'Q1', playbook: null })], mockPrompts()),
    ).resolves.toBeUndefined();
  });
});

describe('WebAnswerRunner — Per-question lifecycle, 429 retries, 403 handling, error status, and abort cleanup', () => {
  it('maps thinkingLevel: off -> minimal, retries 429 up to 5 total attempts, polls status, and converts trace', async () => {
    let sendAttempts = 0;
    let statusCalls = 0;
    let recordedThinkingLevel: string | null = null;
    let deletedConv = false;

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML('csrf-1'), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-run-1' } });
      }
      if (url.endsWith('/chat/conv-run-1/model') && method === 'POST') {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/chat/conv-run-1/thinking-level') && method === 'POST') {
        const params = new URLSearchParams(String(init?.body ?? ''));
        recordedThinkingLevel = params.get('level');
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/chat/conv-run-1/send-async') && method === 'POST') {
        sendAttempts++;
        if (sendAttempts < 5) {
          return new Response('Busy', { status: 429 });
        }
        return new Response(JSON.stringify({ assistantMessageId: 'msg-99' }), { status: 202 });
      }
      if (url.endsWith('/chat/conv-run-1/messages/msg-99/status')) {
        statusCalls++;
        if (statusCalls === 1) {
          return new Response(JSON.stringify({ status: 'generating' }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'done', message: { id: 'msg-99', content: 'Final answer' } }), {
          status: 200,
        });
      }
      if (url.endsWith('/chat/conv-run-1/messages/msg-99/trace')) {
        return new Response(
          JSON.stringify({
            mode: 'single',
            messageId: 'msg-99',
            conversationId: 'conv-run-1',
            status: 'done',
            content: '<think>Reasoning</think>\n🔧 *Calling tool:* `search_corpus`\nFinal answer [chunk_id=11111111-2222-3333-4444-555555555555]',
            model: 'gemini-3.8-flash-001',
            playbook: 'demo-basics',
            playbookVersion: 3,
            tokens: { prompt: 200, completion: 50, total: 300, cached: 0, thought: 50 },
            retrievedChunkIds: ['11111111-2222-3333-4444-555555555555'],
            toolCalls: [
              {
                seq: 1,
                id: 'tc-1',
                name: 'search_corpus',
                arguments: '{"query":"sync"}',
                result: '[chunk_id=11111111-2222-3333-4444-555555555555] text',
                isError: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/chat/conv-run-1/delete') && method === 'POST') {
        deletedConv = true;
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      sessionCookie: 'valid-cookie',
      pollIntervalMs: 1,
      keepConversations: false,
      fetchFn,
      retryDelaysMs: [1, 1, 1, 1],
    });

    const bundle = await runner.run(mkTask({ thinkingLevel: 'off' }));
    expect(recordedThinkingLevel).toBe('minimal');
    expect(sendAttempts).toBe(5);
    expect(statusCalls).toBe(2);
    expect(deletedConv).toBe(true);
    expect(bundle.answer).toBe('Final answer [chunk_id=11111111-2222-3333-4444-555555555555]');
    expect(bundle.providerMeta.resolvedModel).toBe('gemini-3.8-flash-001');
  });

  it('throws an Error when generation status is error or cancelled instead of grading it', async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML('csrf-1'), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-err' } });
      }
      if (url.endsWith('/model') || url.endsWith('/thinking-level')) return new Response(null, { status: 200 });
      if (url.endsWith('/send-async')) {
        return new Response(JSON.stringify({ assistantMessageId: 'msg-err' }), { status: 202 });
      }
      if (url.endsWith('/messages/msg-err/status')) {
        return new Response(
          JSON.stringify({ status: 'error', message: { content: 'Provider quota exceeded' } }),
          { status: 200 },
        );
      }
      if (url.endsWith('/delete')) return new Response(null, { status: 302, headers: { Location: '/chat' } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      sessionCookie: 'valid-cookie',
      pollIntervalMs: 1,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.run(mkTask())).rejects.toThrow(
      /yvoke-web generation ended with status="error": Provider quota exceeded/,
    );
  });

  it('distinguishes 403 on GET (never retried) from 403 on POST (retried once when GET /chat yields rotated _csrf)', async () => {
    let chatGets = 0;
    let modelPosts = 0;
    let traceGets = 0;

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      if (url.endsWith('/chat') && method === 'GET') {
        chatGets++;
        const token = chatGets === 1 ? 'csrf-initial' : 'csrf-rotated';
        return new Response(MOCK_CHAT_HTML(token), { status: 200 });
      }
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-403' } });
      }
      if (url.endsWith('/chat/conv-403/model') && method === 'POST') {
        modelPosts++;
        if (headers.get('X-CSRF-TOKEN') !== 'csrf-rotated') {
          return new Response('Invalid CSRF', { status: 403 });
        }
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/thinking-level')) return new Response(null, { status: 200 });
      if (url.endsWith('/send-async')) {
        return new Response(JSON.stringify({ assistantMessageId: 'msg-403' }), { status: 202 });
      }
      if (url.endsWith('/messages/msg-403/status')) {
        return new Response(JSON.stringify({ status: 'done' }), { status: 200 });
      }
      if (url.endsWith('/messages/msg-403/trace') && method === 'GET') {
        traceGets++;
        return new Response('Forbidden', { status: 403 });
      }
      if (url.endsWith('/delete')) return new Response(null, { status: 302, headers: { Location: '/chat' } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      sessionCookie: 'valid-cookie',
      pollIntervalMs: 1,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.run(mkTask())).rejects.toThrow(/trace failed with status 403/);
    // POST /model was retried once after GET /chat rotated CSRF:
    expect(modelPosts).toBe(2);
    // GET /trace was NOT retried on 403 and did not trigger another GET /chat:
    expect(traceGets).toBe(1);
    expect(chatGets).toBe(2);
  });

  it('calls POST /chat/{id}/stop and POST /chat/{id}/delete with fresh non-aborted signals when task.abortController aborts', async () => {
    const ac = new AbortController();
    let stopSignalAborted: boolean | null = null;
    let deleteSignalAborted: boolean | null = null;

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML('csrf-1'), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-abort' } });
      }
      if (url.endsWith('/model') || url.endsWith('/thinking-level')) return new Response(null, { status: 200 });
      if (url.endsWith('/send-async')) {
        return new Response(JSON.stringify({ assistantMessageId: 'msg-abort' }), { status: 202 });
      }
      if (url.endsWith('/messages/msg-abort/status')) {
        ac.abort(new Error('Question timeout'));
        return new Response(JSON.stringify({ status: 'generating' }), { status: 200 });
      }
      if (url.endsWith('/chat/conv-abort/stop') && method === 'POST') {
        stopSignalAborted = init?.signal?.aborted ?? true;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/chat/conv-abort/delete') && method === 'POST') {
        deleteSignalAborted = init?.signal?.aborted ?? true;
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      sessionCookie: 'valid-cookie',
      pollIntervalMs: 50,
      keepConversations: false,
      fetchFn,
    });

    await expect(runner.run(mkTask({ abortController: ac }))).rejects.toThrow(/Question timeout/);
    expect(stopSignalAborted).toBe(false);
    expect(deleteSignalAborted).toBe(false);
  });
});
