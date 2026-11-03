import { FatalRunError, UserError } from '../types';
import type { WebMessageTraceDto } from './webCapture';

export interface WebChatClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  sessionCookie?: string;
  fetchFn?: typeof fetch;
  /** Optional override for 429 retry backoff delays in ms (default: [1000, 2000, 4000, 8000]). */
  retryDelaysMs?: number[];
}

export interface WebStatusResponse {
  status: 'generating' | 'done' | 'error' | 'cancelled' | string;
  message?: {
    id?: string;
    content?: string;
    status?: string;
  };
}

const DEFAULT_429_DELAYS_MS = [1000, 2000, 4000, 8000];

/**
 * Extracts a Spring Security CSRF token from HTML (<meta name="_csrf" ...> or <input name="_csrf" ...>).
 */
export function extractCsrfToken(html: string): string | null {
  if (!html) return null;

  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    if (/\bname\s*=\s*["']_csrf["']/i.test(tag)) {
      const contentMatch = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (contentMatch?.[1]) return contentMatch[1];
    }
  }

  const inputTags = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of inputTags) {
    if (/\bname\s*=\s*["']_csrf["']/i.test(tag)) {
      const valueMatch = /\bvalue\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (valueMatch?.[1]) return valueMatch[1];
    }
  }

  return null;
}

/**
 * Detects whether the HTML body is the Spring Security login form.
 */
export function isLoginPageHtml(html: string): boolean {
  if (!html) return false;
  return /<input\b[^>]*\bname\s*=\s*["']username["']/i.test(html);
}

/**
 * Extracts available specialized playbook names from GET /chat/{id} (thread.html).
 * Primary: parses window.CHAT_CONFIG's `prompts` JSON array.
 * Fallback: matches `data-prompt-name="([^"]+)"` attributes when window.CHAT_CONFIG is absent.
 */
export function extractPlaybooksFromThreadHtml(html: string): string[] {
  if (!html) return [];

  const chatConfigIdx = html.indexOf('window.CHAT_CONFIG');
  if (chatConfigIdx >= 0) {
    const afterConfig = html.slice(chatConfigIdx);
    const promptsMatch = /\bprompts\s*:\s*\[/.exec(afterConfig);
    if (promptsMatch) {
      const bracketStart = chatConfigIdx + promptsMatch.index + promptsMatch[0].length - 1;
      const jsonArrayText = extractBalancedBracketArray(html, bracketStart);
      if (jsonArrayText !== null) {
        try {
          const parsed = JSON.parse(jsonArrayText) as unknown;
          if (Array.isArray(parsed)) {
            const names: string[] = [];
            for (const item of parsed) {
              if (typeof item === 'string' && item.length > 0) {
                names.push(item);
              } else if (
                item &&
                typeof item === 'object' &&
                typeof (item as { name?: unknown }).name === 'string' &&
                (item as { name: string }).name.length > 0
              ) {
                names.push((item as { name: string }).name);
              }
            }
            return [...new Set(names)];
          }
        } catch {
          // If JSON.parse fails on non-standard JS literal in a test fixture, try extracting name fields
          const names: string[] = [];
          const nameRe = /["']?name["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
          let m: RegExpExecArray | null;
          while ((m = nameRe.exec(jsonArrayText)) !== null) {
            const rawVal = m[1] ?? m[2] ?? '';
            try {
              names.push(JSON.parse(`"${rawVal.replace(/"/g, '\\"')}"`));
            } catch {
              names.push(rawVal);
            }
          }
          return [...new Set(names)];
        }
      }
    }
  }

  // Fallback to data-prompt-name="..." attributes when window.CHAT_CONFIG is absent
  const names: string[] = [];
  const attrRe = /\bdata-prompt-name\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) {
    const raw = m[1] ?? m[2] ?? '';
    if (raw.length > 0) {
      names.push(
        raw
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&'),
      );
    }
  }
  return [...new Set(names)];
}

function extractBalancedBracketArray(text: string, openBracketIndex: number): string | null {
  if (text[openBracketIndex] !== '[') return null;
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;

  for (let i = openBracketIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(openBracketIndex, i + 1);
      }
    }
  }
  return null;
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
 * Stateful HTTP client for yvoke-web's session-authenticated + CSRF-protected chat endpoints.
 */
export class WebChatClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private readonly isCookieMode: boolean;
  private readonly retryDelaysMs: number[];
  private csrfToken: string | null = null;
  private authenticated = false;

  constructor(private readonly opts: WebChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.isCookieMode = Boolean(opts.sessionCookie && opts.sessionCookie.trim().length > 0);
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_429_DELAYS_MS;
  }

  getCookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  private seedSessionCookie(rawCookie: string): void {
    const parts = rawCookie
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    const attrNames = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) {
        if (!this.cookies.has('JSESSIONID')) {
          this.cookies.set('JSESSIONID', part);
        }
      } else {
        const name = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (name && !attrNames.has(name.toLowerCase())) {
          this.cookies.set(name, val);
        }
      }
    }
  }

  private updateCookiesFromResponse(res: Response): void {
    let setCookies: string[] = [];
    if (typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      setCookies = (res.headers as { getSetCookie: () => string[] }).getSetCookie();
    }
    if (setCookies.length === 0) {
      const single = res.headers.get('set-cookie');
      if (single) setCookies = [single];
    }
    for (const raw of setCookies) {
      const firstPair = raw.split(';')[0]?.trim() ?? '';
      const eq = firstPair.indexOf('=');
      if (eq > 0) {
        const name = firstPair.slice(0, eq).trim();
        const value = firstPair.slice(eq + 1).trim();
        if (name) {
          this.cookies.set(name, value);
        }
      }
    }
  }

  private async rawRequest(
    pathOrUrl: string,
    init: RequestInit & { form?: Record<string, string> } = {},
  ): Promise<{ res: Response; sentCsrf: string | null }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }

    let body = init.body;
    let sentCsrf: string | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      sentCsrf = this.csrfToken;
      if (sentCsrf) {
        headers.set('X-CSRF-TOKEN', sentCsrf);
      }
      if (init.form) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(init.form)) {
          params.set(k, v);
        }
        if (sentCsrf && !params.has('_csrf')) {
          params.set('_csrf', sentCsrf);
        }
        body = params.toString();
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }
    }

    const res = await this.fetchFn(url, {
      ...init,
      method,
      headers,
      body,
      redirect: 'manual',
    });
    this.updateCookiesFromResponse(res);
    return { res, sentCsrf };
  }

  private isAuthRedirect(res: Response, allowChatRedirect = false): boolean {
    if (res.status === 401) return true;
    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
      const loc = res.headers.get('location') ?? '';
      if (loc.includes('/login') || loc.includes('oauth2')) return true;
      if (!allowChatRedirect) return true;
    }
    return false;
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.authenticated) {
      await this.authenticate();
    }
  }

  async authenticate(): Promise<void> {
    if (this.isCookieMode) {
      this.cookies.clear();
      this.seedSessionCookie(this.opts.sessionCookie!);
      const { res } = await this.rawRequest('/chat', { method: 'GET' });
      if (res.status !== 200) {
        throw new UserError('Provided answer.web.sessionCookie is invalid or expired.');
      }
      const html = await res.text();
      const csrf = extractCsrfToken(html);
      if (!csrf || isLoginPageHtml(html)) {
        throw new UserError('Provided answer.web.sessionCookie is invalid or expired.');
      }
      this.csrfToken = csrf;
      this.authenticated = true;
      return;
    }

    // Mock Form Login Mode:
    // Step 1: GET /login
    this.cookies.clear();
    const { res: loginPageRes } = await this.rawRequest('/login', { method: 'GET' });
    if (loginPageRes.status !== 200) {
      throw new UserError(
        `yvoke-web at ${this.baseUrl} does not have mock form login enabled. Start yvoke-web with SPRING_PROFILES_ACTIVE=dev and APP_SECURITY_MOCK=true, or configure answer.web.sessionCookie.`,
      );
    }
    const loginHtml = await loginPageRes.text();
    const loginCsrf = extractCsrfToken(loginHtml);
    if (!isLoginPageHtml(loginHtml) || !loginCsrf) {
      throw new UserError(
        `yvoke-web at ${this.baseUrl} does not have mock form login enabled. Start yvoke-web with SPRING_PROFILES_ACTIVE=dev and APP_SECURITY_MOCK=true, or configure answer.web.sessionCookie.`,
      );
    }
    this.csrfToken = loginCsrf;

    // Step 2: POST /login (defaulting to admin/admin only after mock login form is confirmed)
    const username = this.opts.username && this.opts.username.length > 0 ? this.opts.username : 'admin';
    const password = this.opts.password && this.opts.password.length > 0 ? this.opts.password : 'admin';
    const { res: postLoginRes } = await this.rawRequest('/login', {
      method: 'POST',
      form: {
        username,
        password,
        _csrf: loginCsrf,
      },
    });
    const loginLoc = postLoginRes.headers.get('location') ?? '';
    if (
      loginLoc.includes('/login?error') ||
      loginLoc.includes('error') ||
      postLoginRes.status === 401 ||
      postLoginRes.status === 403 ||
      postLoginRes.status >= 400
    ) {
      throw new UserError(
        `Web login failed for user "${username}". Note: mock auth requires username="admin" for ROLE_ADMIN trace access.`,
      );
    }

    // Step 3: GET /chat with rotated JSESSIONID to verify authenticated session and extract post-auth _csrf
    const { res: chatRes } = await this.rawRequest('/chat', { method: 'GET' });
    if (chatRes.status !== 200) {
      throw new UserError('Web login did not establish an authenticated session on /chat.');
    }
    const chatHtml = await chatRes.text();
    const postAuthCsrf = extractCsrfToken(chatHtml);
    if (!postAuthCsrf || isLoginPageHtml(chatHtml)) {
      throw new UserError('Web login did not establish an authenticated session on /chat.');
    }
    this.csrfToken = postAuthCsrf;
    this.authenticated = true;
  }

  /**
   * Executes an authenticated request with mid-run session/CSRF recovery:
   * - Never retries GET on 403 (role denial).
   * - On 401 or login redirect (302): throws FatalRunError in cookie mode; re-logs in once in mock mode.
   * - On POST 403: probes GET /chat. If 302/401, handles as session expiry; if 200 with rotated _csrf, retries POST once; otherwise returns 403.
   */
  async requestWithRecovery(
    path: string,
    init: RequestInit & { form?: Record<string, string>; allowChatRedirect?: boolean } = {},
  ): Promise<Response> {
    await this.ensureAuthenticated();
    const method = (init.method ?? 'GET').toUpperCase();
    const allowChatRedirect = init.allowChatRedirect === true;

    const { res, sentCsrf } = await this.rawRequest(path, init);

    if (this.isAuthRedirect(res, allowChatRedirect)) {
      if (this.isCookieMode) {
        throw new FatalRunError('Web sessionCookie expired mid-run.');
      }
      await this.authenticate();
      const retry = await this.rawRequest(path, init);
      return retry.res;
    }

    if (res.status === 403 && method !== 'GET' && method !== 'HEAD') {
      const { res: chatRes } = await this.rawRequest('/chat', { method: 'GET', signal: init.signal });
      if (this.isAuthRedirect(chatRes, false)) {
        if (this.isCookieMode) {
          throw new FatalRunError('Web sessionCookie expired mid-run.');
        }
        await this.authenticate();
        const retry = await this.rawRequest(path, init);
        return retry.res;
      }
      if (chatRes.status === 200) {
        const html = await chatRes.text();
        if (isLoginPageHtml(html)) {
          if (this.isCookieMode) {
            throw new FatalRunError('Web sessionCookie expired mid-run.');
          }
          await this.authenticate();
          const retry = await this.rawRequest(path, init);
          return retry.res;
        }
        const newCsrf = extractCsrfToken(html);
        if (newCsrf && newCsrf !== sentCsrf) {
          this.csrfToken = newCsrf;
          const retry = await this.rawRequest(path, init);
          return retry.res;
        }
      }
    }

    return res;
  }

  async createConversation(signal?: AbortSignal): Promise<string> {
    const res = await this.requestWithRecovery('/chat/new', {
      method: 'POST',
      form: {},
      signal,
      allowChatRedirect: true,
    });
    const loc = res.headers.get('location') ?? '';
    const match = /\/chat\/([^/?#]+)/.exec(loc);
    if (!match?.[1] || match[1] === 'new' || match[1] === 'login') {
      throw new Error(`POST /chat/new did not redirect to /chat/{id} (status=${res.status}, location="${loc}").`);
    }
    return match[1];
  }

  async getThreadHtml(conversationId: string, signal?: AbortSignal): Promise<string> {
    const res = await this.requestWithRecovery(`/chat/${conversationId}`, {
      method: 'GET',
      signal,
    });
    if (res.status !== 200) {
      throw new Error(`GET /chat/${conversationId} failed with status ${res.status}.`);
    }
    const html = await res.text();
    const csrf = extractCsrfToken(html);
    if (csrf) {
      this.csrfToken = csrf;
    }
    return html;
  }

  async probeTraceAccess(conversationId: string, signal?: AbortSignal): Promise<number> {
    const res = await this.requestWithRecovery(
      `/chat/${conversationId}/messages/00000000-0000-0000-0000-000000000000/trace`,
      { method: 'GET', signal },
    );
    return res.status;
  }

  async setModel(conversationId: string, model: string, signal?: AbortSignal): Promise<number> {
    const res = await this.requestWithRecovery(`/chat/${conversationId}/model`, {
      method: 'POST',
      form: { model },
      signal,
    });
    return res.status;
  }

  async setThinkingLevel(conversationId: string, level: string, signal?: AbortSignal): Promise<void> {
    const res = await this.requestWithRecovery(`/chat/${conversationId}/thinking-level`, {
      method: 'POST',
      form: { level },
      signal,
    });
    if (!res.ok) {
      throw new Error(`POST /chat/${conversationId}/thinking-level failed with status ${res.status}.`);
    }
  }

  async sendAsyncWithBackoff(
    conversationId: string,
    content: string,
    promptName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const maxAttempts = this.retryDelaysMs.length + 1; // 5 total attempts (1 initial + 4 retries)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await this.requestWithRecovery(`/chat/${conversationId}/send-async`, {
        method: 'POST',
        form: { content, promptName },
        signal,
      });

      if (res.status === 429) {
        if (attempt < this.retryDelaysMs.length) {
          await sleepAbortable(this.retryDelaysMs[attempt]!, signal);
          continue;
        }
        throw new Error(`POST /chat/${conversationId}/send-async returned 429 Too Many Requests after ${maxAttempts} attempts.`);
      }

      if (res.status !== 202 && res.status !== 200) {
        const text = await res.text().catch(() => '');
        throw new Error(`POST /chat/${conversationId}/send-async failed with status ${res.status}: ${text}`);
      }

      const body = (await res.json()) as { assistantMessageId?: string };
      if (!body?.assistantMessageId) {
        throw new Error(`POST /chat/${conversationId}/send-async response missing assistantMessageId.`);
      }
      return body.assistantMessageId;
    }
    throw new Error(`POST /chat/${conversationId}/send-async exhausted retries.`);
  }

  async getMessageStatus(
    conversationId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<WebStatusResponse> {
    const res = await this.requestWithRecovery(
      `/chat/${conversationId}/messages/${messageId}/status`,
      { method: 'GET', signal },
    );
    if (res.status !== 200) {
      throw new Error(`GET /chat/${conversationId}/messages/${messageId}/status failed with status ${res.status}.`);
    }
    return (await res.json()) as WebStatusResponse;
  }

  async getMessageTrace(
    conversationId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<WebMessageTraceDto> {
    const res = await this.requestWithRecovery(
      `/chat/${conversationId}/messages/${messageId}/trace`,
      { method: 'GET', signal },
    );
    if (res.status !== 200) {
      throw new Error(`GET /chat/${conversationId}/messages/${messageId}/trace failed with status ${res.status}.`);
    }
    return (await res.json()) as WebMessageTraceDto;
  }

  async stopConversation(conversationId: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<void> {
    await this.requestWithRecovery(`/chat/${conversationId}/stop`, {
      method: 'POST',
      form: {},
      signal,
    });
  }

  async deleteConversation(conversationId: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<void> {
    await this.requestWithRecovery(`/chat/${conversationId}/delete`, {
      method: 'POST',
      form: {},
      signal,
      allowChatRedirect: true,
    });
  }
}
