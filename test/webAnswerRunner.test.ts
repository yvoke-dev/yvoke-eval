import { describe, it, expect, vi } from 'vitest';
import { WebAnswerRunner } from '../src/agent/WebAnswerRunner';
import {
  WebChatClient,
  decodeHtmlEntities,
  extractCsrfHeaderName,
  extractPlaybooksFromThreadHtml,
  extractWebVersionFromHtml,
} from '../src/agent/WebChatClient';
import { FatalRunError, UserError, WebCapacityError } from '../src/types';
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

  it('falls through to data-prompt-name when window.CHAT_CONFIG.prompts is empty, lacks .name, or fails JSON.parse with 0 regex names', () => {
    const emptyPromptsHtml = `
      <script>window.CHAT_CONFIG = { prompts: [] };</script>
      <button data-prompt-name="fallback-empty"></button>
    `;
    expect(extractPlaybooksFromThreadHtml(emptyPromptsHtml)).toEqual(['fallback-empty']);

    const missingNameHtml = `
      <script>window.CHAT_CONFIG = { prompts: [{"slug":"no-name-field"}] };</script>
      <button data-prompt-name="fallback-no-name"></button>
    `;
    expect(extractPlaybooksFromThreadHtml(missingNameHtml)).toEqual(['fallback-no-name']);

    const unparseableNoNameHtml = `
      <script>window.CHAT_CONFIG = { prompts: [someDynamicRef, { slug: 'still-no-name' }] };</script>
      <button data-prompt-name="fallback-catch"></button>
    `;
    expect(extractPlaybooksFromThreadHtml(unparseableNoNameHtml)).toEqual(['fallback-catch']);

    const entityAttrHtml = `<button data-prompt-name="pb&amp;lt;&#39;1"></button>`;
    expect(extractPlaybooksFromThreadHtml(entityAttrHtml)).toEqual(["pb&lt;'1"]);
  });
});

describe('extractWebVersionFromHtml & decodeHtmlEntities', () => {
  it('parses real yvoke-web multiline sidebar <span class="build-version"> and multi-class spans', () => {
    const sidebarHtml = `
      <aside class="sidebar">
        <div class="sidebar-footer">
          <span class="build-version"
            title="1.4.2-7-gabc1234">1.4.2-7-gabc1234</span>
        </div>
      </aside>
    `;
    expect(extractWebVersionFromHtml(sidebarHtml)).toBe('1.4.2-7-gabc1234');

    const multiClassHtml = `<div><span class="badge build-version muted">0.9.0-SNAPSHOT</span></div>`;
    expect(extractWebVersionFromHtml(multiClassHtml)).toBe('0.9.0-SNAPSHOT');

    const nestedOuterSpanHtml = `<span class="footer-meta">Build: <span class="build-version">1.4.2</span></span>`;
    expect(extractWebVersionFromHtml(nestedOuterSpanHtml)).toBe('1.4.2');
  });

  it('decodes HTML entities in a single pass and guards out-of-range numeric code points', () => {
    expect(extractWebVersionFromHtml('<span class="build-version">1.2.3+a&amp;b&#39;rc&#x2f;1</span>')).toBe(
      "1.2.3+a&b'rc/1",
    );
    expect(extractWebVersionFromHtml('<span class="build-version">&amp;lt;</span>')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;quot;&amp;lt;')).toBe('&quot;&lt;');
    expect(extractWebVersionFromHtml('<span class="build-version">&#99999999;</span>')).toBe('&#99999999;');
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('does not match substring class names like my-build-version and returns null on login HTML', () => {
    expect(extractWebVersionFromHtml('<span class="my-build-version">wrong</span>')).toBeNull();
    expect(extractWebVersionFromHtml('<span class="build-version-extra">wrong</span>')).toBeNull();
    expect(extractWebVersionFromHtml(MOCK_LOGIN_HTML)).toBeNull();
  });

  it('falls back to span title attribute when inner text is empty/whitespace, and to <meta> tags when span is absent', () => {
    expect(extractWebVersionFromHtml('<span class="build-version" title="1.4.2-title&amp;only">   </span>')).toBe(
      '1.4.2-title&only',
    );
    expect(extractWebVersionFromHtml('<meta name="app-version" content="2.4.1-sha999">')).toBe('2.4.1-sha999');
    expect(extractWebVersionFromHtml('<meta name="build-version" content="2.4.2&amp;dev">')).toBe('2.4.2&dev');
  });
});

describe('WebChatClient — credential validation, dynamic _csrf_header, and version capture', () => {
  it('rejects empty sessionCookie or empty/partial username/password in WebChatClient constructor with UserError', () => {
    expect(() => new WebChatClient({ baseUrl: 'http://localhost:8080', sessionCookie: '' })).toThrow(UserError);
    expect(() => new WebChatClient({ baseUrl: 'http://localhost:8080', username: '', password: '' })).toThrow(UserError);
    expect(() => new WebChatClient({ baseUrl: 'http://localhost:8080', username: 'admin', password: '' })).toThrow(UserError);
    expect(() => new WebChatClient({ baseUrl: 'http://localhost:8080', username: '', password: 'secret' })).toThrow(UserError);
    expect(
      () =>
        new WebAnswerRunner({
          baseUrl: 'http://localhost:8080',
          answerModel: 'gemini-3.8-flash',
          defaultPlaybook: null,
          pollIntervalMs: 0,
          keepConversations: false,
        }),
    ).toThrow(UserError);
  });

  it('extracts custom _csrf_header meta tag, captures first-seen server version from /chat build-version span (never /login), and warns once on mid-run drift', async () => {
    expect(extractCsrfHeaderName('<meta content="X-XSRF-TOKEN" name="_csrf_header">')).toBe('X-XSRF-TOKEN');

    let seenXsrfHeader: string | null = null;
    let seenDefaultCsrfHeader: string | null = null;
    const logs: string[] = [];

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      if (url.endsWith('/login') && method === 'GET') {
        return new Response(MOCK_LOGIN_HTML, {
          status: 200,
          headers: { 'Set-Cookie': 'JSESSIONID=pre-login; Path=/' },
        });
      }
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, {
          status: 302,
          headers: { Location: '/chat', 'Set-Cookie': 'JSESSIONID=post-login; Path=/' },
        });
      }
      if (url.endsWith('/chat') && method === 'GET') {
        return new Response(
          `<html><head>
            <meta name="_csrf" content="xsrf-tok-42">
            <meta name="_csrf_header" content="X-XSRF-TOKEN">
          </head><body>
            <span class="build-version" title="1.9.0">1.9.0</span>
          </body></html>`,
          { status: 200 },
        );
      }
      if (url.endsWith('/chat/new') && method === 'POST') {
        seenXsrfHeader = headers.get('X-XSRF-TOKEN');
        seenDefaultCsrfHeader = headers.get('X-CSRF-TOKEN');
        return new Response(null, {
          status: 302,
          headers: { Location: '/chat/conv-xsrf' },
        });
      }
      if (url.endsWith('/chat/conv-xsrf') && method === 'GET') {
        // Rolling deploy mid-run: HTML span now reports 2.0.0
        return new Response(
          `<html><head><meta name="_csrf" content="xsrf-tok-42"></head><body>
            <span class="build-version" title="2.0.0">2.0.0</span>
          </body></html>`,
          { status: 200 },
        );
      }
      if (url.endsWith('/chat/conv-xsrf/model') && method === 'POST') {
        // Subsequent response also carries X-App-Version: 2.0.0 header
        return new Response(null, {
          status: 200,
          headers: { 'X-App-Version': '2.0.0' },
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const client = new WebChatClient({
      baseUrl: 'http://localhost:8080',
      fetchFn,
      log: (m) => logs.push(m),
    });

    await client.authenticate();
    expect(client.getCsrfHeaderName()).toBe('X-XSRF-TOKEN');
    expect(client.getServerVersion()).toBe('1.9.0');
    expect(logs).toHaveLength(0);

    const convId = await client.createConversation();
    expect(convId).toBe('conv-xsrf');
    expect(seenXsrfHeader).toBe('xsrf-tok-42');
    expect(seenDefaultCsrfHeader).toBeNull();

    // HTML span drift (2.0.0) and header drift (2.0.0) preserve first-seen 1.9.0 and warn once:
    await client.getThreadHtml(convId);
    await client.setModel(convId, 'gemini-3.8-flash');
    expect(client.getServerVersion()).toBe('1.9.0');
    const driftWarnings = logs.filter((l) =>
      l.includes('[WARN] Web server version changed mid-run from "1.9.0" to "2.0.0"'),
    );
    expect(driftWarnings).toHaveLength(1);

    // Also verify <span class="build-version"> takes priority over a proxy X-App-Version header on /chat:
    const proxyLogs: string[] = [];
    const proxyClient = new WebChatClient({
      baseUrl: 'http://localhost:8080',
      sessionCookie: 'JSESSIONID=valid',
      log: (m) => proxyLogs.push(m),
      fetchFn: (async () =>
        new Response(
          `<html><head><meta name="_csrf" content="tok"></head><body><span class="build-version">1.9.0-html</span></body></html>`,
          { status: 200, headers: { 'X-App-Version': '0.1.0-proxy' } },
        )) as unknown as typeof fetch,
    });
    await proxyClient.authenticate();
    expect(proxyClient.getServerVersion()).toBe('1.9.0-html');
    expect(proxyLogs).toHaveLength(0);
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
      /lacks ROLE_ADMIN or ROLE_AREA_ADMIN/,
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

  it('throws WebCapacityError with HTTP 429 details when all send-async retry attempts return 429, and attaches webConversationId', async () => {
    let sendAttempts = 0;
    let deletedConv = false;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML('csrf-1'), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        return new Response(null, { status: 302, headers: { Location: '/chat/conv-429' } });
      }
      if (url.endsWith('/model') || url.endsWith('/thinking-level')) return new Response(null, { status: 200 });
      if (url.endsWith('/send-async') && method === 'POST') {
        sendAttempts++;
        return new Response('Too Many Requests', { status: 429 });
      }
      if (url.endsWith('/chat/conv-429/delete') && method === 'POST') {
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
      retryDelaysMs: [1, 1],
    });

    let caught: unknown;
    try {
      await runner.run(mkTask());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WebCapacityError);
    expect((caught as Error).message).toMatch(/POST \/chat\/conv-429\/send-async returned HTTP 429 Too Many Requests after 3 attempts/);
    expect((caught as Record<string, unknown>).webConversationId).toBe('conv-429');
    expect(sendAttempts).toBe(3);
    expect(deletedConv).toBe(true);
  });

  it('serializes abort cleanup so task 1 /stop + /delete finish strictly before task 2 /chat/new starts, and attaches webConversationId & webMessageId', async () => {
    const events: string[] = [];
    let convCounter = 0;
    let notifyPollingStarted!: () => void;
    const pollingStarted = new Promise<void>((resolve) => {
      notifyPollingStarted = resolve;
    });

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML('csrf-1'), { status: 200 });
      if (url.endsWith('/chat/new') && method === 'POST') {
        convCounter++;
        const id = `conv-${convCounter}`;
        events.push(`create:${id}`);
        return new Response(null, { status: 302, headers: { Location: `/chat/${id}` } });
      }
      if (url.endsWith('/model') || url.endsWith('/thinking-level')) return new Response(null, { status: 200 });
      if (url.includes('/conv-1/send-async')) {
        return new Response(JSON.stringify({ assistantMessageId: 'msg-1' }), { status: 202 });
      }
      if (url.includes('/conv-1/messages/msg-1/status')) {
        notifyPollingStarted();
        return new Response(JSON.stringify({ status: 'generating' }), { status: 200 });
      }
      if (url.includes('/conv-1/stop')) {
        events.push('stop:conv-1:start');
        await new Promise((r) => setTimeout(r, 30));
        events.push('stop:conv-1:done');
        return new Response(null, { status: 200 });
      }
      if (url.includes('/conv-1/delete')) {
        events.push('delete:conv-1:start');
        await new Promise((r) => setTimeout(r, 30));
        events.push('delete:conv-1:done');
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      if (url.includes('/conv-2/send-async')) {
        return new Response(JSON.stringify({ assistantMessageId: 'msg-2' }), { status: 202 });
      }
      if (url.includes('/conv-2/messages/msg-2/status')) {
        return new Response(JSON.stringify({ status: 'done' }), { status: 200 });
      }
      if (url.includes('/conv-2/messages/msg-2/trace')) {
        return new Response(
          JSON.stringify({
            status: 'done',
            content: '<clarifying-question><question>Which DB?</question></clarifying-question>',
            toolCalls: [],
            retrievedChunkIds: [],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/conv-2/delete')) {
        events.push('delete:conv-2:done');
        return new Response(null, { status: 302, headers: { Location: '/chat' } });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const runner = new WebAnswerRunner({
      baseUrl: 'http://localhost:8080',
      answerModel: 'gemini-3.8-flash',
      defaultPlaybook: null,
      sessionCookie: 'valid-cookie',
      pollIntervalMs: 50,
      keepConversations: false,
      fetchFn,
      log: (m) => logs.push(m),
    });

    const ac1 = new AbortController();
    const task1Promise = runner.run(mkTask({ abortController: ac1 }));

    // Deterministically wait for task 1 to reach /status polling, then abort and start task 2 concurrently:
    await pollingStarted;
    const timeoutErr = new Error('Task 1 timed out');
    ac1.abort(timeoutErr);

    const task2Promise = runner.run(mkTask({ question: mkQuestion({ category: 'basics', id: 'Q2', playbook: 'demo-basics' }) }));

    let caught1: unknown;
    try {
      await task1Promise;
    } catch (e) {
      caught1 = e;
    }
    const bundle2 = await task2Promise;

    expect(caught1).toBe(timeoutErr);
    expect((caught1 as Record<string, unknown>).webConversationId).toBe('conv-1');
    expect((caught1 as Record<string, unknown>).webMessageId).toBe('msg-1');

    // Task 1 stop + delete completed strictly BEFORE task 2 POST /chat/new:
    expect(events).toEqual([
      'create:conv-1',
      'stop:conv-1:start',
      'stop:conv-1:done',
      'delete:conv-1:start',
      'delete:conv-1:done',
      'create:conv-2',
      'delete:conv-2:done',
    ]);

    expect(bundle2.answer).toBe('<clarifying-question>Which DB?</clarifying-question>');
    expect(bundle2.providerMeta?.conversationId).toBe('conv-2');
    expect(bundle2.providerMeta?.messageId).toBe('msg-2');
    expect(logs.some((l) => l.includes('[WARN]') && l.includes('basics.Q2'))).toBe(true);
  });

  it('waits past 15.5s (up to 25s cap) under fake timers when /stop hangs until its 10s timeout and /delete takes 9s (19s total)', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let convCounter = 0;
      let notifyPollingStarted!: () => void;
      const pollingStarted = new Promise<void>((resolve) => {
        notifyPollingStarted = resolve;
      });

      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith('/chat') && method === 'GET') return new Response(MOCK_CHAT_HTML('csrf-1'), { status: 200 });
        if (url.endsWith('/chat/new') && method === 'POST') {
          convCounter++;
          const id = `conv-${convCounter}`;
          events.push(`create:${id}`);
          return new Response(null, { status: 302, headers: { Location: `/chat/${id}` } });
        }
        if (url.endsWith('/model') || url.endsWith('/thinking-level')) return new Response(null, { status: 200 });
        if (url.includes('/conv-1/send-async')) {
          return new Response(JSON.stringify({ assistantMessageId: 'msg-1' }), { status: 202 });
        }
        if (url.includes('/conv-1/messages/msg-1/status')) {
          notifyPollingStarted();
          return new Response(JSON.stringify({ status: 'generating' }), { status: 200 });
        }
        if (url.includes('/conv-1/stop')) {
          events.push('stop:conv-1:start');
          await new Promise<never>((_, reject) => {
            const sig = init?.signal;
            if (sig?.aborted) {
              events.push('stop:conv-1:aborted');
              reject(sig.reason ?? new Error('Aborted'));
              return;
            }
            sig?.addEventListener(
              'abort',
              () => {
                events.push('stop:conv-1:aborted');
                reject(sig.reason ?? new Error('Aborted'));
              },
              { once: true },
            );
          });
        }
        if (url.includes('/conv-1/delete')) {
          events.push('delete:conv-1:start');
          await new Promise((r) => setTimeout(r, 9_000));
          events.push('delete:conv-1:done');
          return new Response(null, { status: 302, headers: { Location: '/chat' } });
        }
        if (url.includes('/conv-2/send-async')) {
          return new Response(JSON.stringify({ assistantMessageId: 'msg-2' }), { status: 202 });
        }
        if (url.includes('/conv-2/messages/msg-2/status')) {
          return new Response(JSON.stringify({ status: 'done' }), { status: 200 });
        }
        if (url.includes('/conv-2/messages/msg-2/trace')) {
          return new Response(
            JSON.stringify({
              status: 'done',
              content: 'Task 2 clean answer',
              toolCalls: [],
              retrievedChunkIds: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/conv-2/delete')) {
          events.push('delete:conv-2:done');
          return new Response(null, { status: 302, headers: { Location: '/chat' } });
        }
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch;

      const runner = new WebAnswerRunner({
        baseUrl: 'http://localhost:8080',
        answerModel: 'gemini-3.8-flash',
        defaultPlaybook: null,
        sessionCookie: 'valid-cookie',
        pollIntervalMs: 5_000,
        keepConversations: false,
        fetchFn,
      });

      const ac1 = new AbortController();
      const task1Outcome = runner.run(mkTask({ abortController: ac1 })).then(
        () => undefined,
        (err: unknown) => err,
      );

      await pollingStarted;
      const timeoutErr = new Error('Task 1 timed out');
      ac1.abort(timeoutErr);

      const task2Promise = runner.run(
        mkTask({ question: mkQuestion({ category: 'basics', id: 'Q2', playbook: 'demo-basics' }) }),
      );

      // Advance to t = 15,500ms (exceeding the old 15s cap): /stop timed out at 10,000ms and /delete is still in progress.
      await vi.advanceTimersByTimeAsync(15_500);
      expect(events).toEqual([
        'create:conv-1',
        'stop:conv-1:start',
        'stop:conv-1:aborted',
        'delete:conv-1:start',
      ]);
      expect(events).not.toContain('create:conv-2');

      // Advance to t = 19,000ms: /delete finishes and task 2 proceeds cleanly.
      await vi.advanceTimersByTimeAsync(3_500);
      const caught1 = await task1Outcome;
      const bundle2 = await task2Promise;

      expect(caught1).toBe(timeoutErr);
      expect(bundle2.answer).toBe('Task 2 clean answer');
      expect(events).toEqual([
        'create:conv-1',
        'stop:conv-1:start',
        'stop:conv-1:aborted',
        'delete:conv-1:start',
        'delete:conv-1:done',
        'create:conv-2',
        'delete:conv-2:done',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
