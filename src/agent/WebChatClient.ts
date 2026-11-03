import { FatalRunError, UserError, WebCapacityError } from '../types';
import type { WebMessageTraceDto } from './webCapture';

export interface WebChatClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  sessionCookie?: string;
  fetchFn?: typeof fetch;
  /** Optional override for 429 retry backoff delays in ms (default: [1000, 2000, 4000, 8000, 15000, 15000]). */
  retryDelaysMs?: number[];
  log?: (msg: string) => void;
}

export interface WebStatusResponse {
  status: 'generating' | 'done' | 'error' | 'cancelled' | string;
  message?: {
    id?: string;
    content?: string;
    status?: string;
  };
}

const DEFAULT_429_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 15000];

/**
 * Validates web authentication credentials so empty interpolated env vars fail fast with a clear UserError.
 */
export function validateWebCredentials(creds: {
  sessionCookie?: unknown;
  username?: unknown;
  password?: unknown;
}): void {
  if (creds.sessionCookie !== undefined) {
    if (typeof creds.sessionCookie !== 'string' || creds.sessionCookie.trim().length === 0) {
      throw new UserError(
        creds.sessionCookie === null || typeof creds.sessionCookie === 'string'
          ? 'answer.web.sessionCookie is configured but empty (check that the referenced environment variable is set, or remove sessionCookie to use mock form login).'
          : 'answer.web.sessionCookie must be a non-empty string (quote scalar values in YAML).',
      );
    }
    return;
  }

  const hasUser = creds.username !== undefined;
  const hasPass = creds.password !== undefined;
  if (!hasUser && !hasPass) {
    return;
  }
  if (!hasUser || typeof creds.username !== 'string' || creds.username.trim().length === 0) {
    throw new UserError(
      !hasUser || creds.username === null || typeof creds.username === 'string'
        ? 'answer.web.username is missing or empty (check environment variable interpolation, or omit both username and password for default mock login).'
        : 'answer.web.username must be a non-empty string (quote numeric usernames in YAML).',
    );
  }
  if (!hasPass || typeof creds.password !== 'string' || creds.password.trim().length === 0) {
    throw new UserError(
      !hasPass || creds.password === null || typeof creds.password === 'string'
        ? 'answer.web.password is missing or empty (check environment variable interpolation, or omit both username and password for default mock login).'
        : 'answer.web.password must be a non-empty string (quote numeric passwords in YAML).',
    );
  }
}

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
 * Extracts the Spring Security CSRF header name from HTML (<meta name="_csrf_header" content="...">).
 */
export function extractCsrfHeaderName(html: string): string | null {
  if (!html) return null;

  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    if (/\bname\s*=\s*["']_csrf_header["']/i.test(tag)) {
      const contentMatch = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag);
      const trimmed = contentMatch?.[1]?.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

/**
 * Single-pass HTML entity decoder so nested entities like `&amp;lt;` decode to `&lt;` (never `<`).
 */
export function decodeHtmlEntities(raw: string): string {
  if (!raw || !raw.includes('&')) return raw;
  return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|quot|apos|lt|gt|amp);/gi, (match, dec?: string, hex?: string) => {
    if (dec !== undefined) {
      const cp = Number.parseInt(dec, 10);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (hex !== undefined) {
      const cp = Number.parseInt(hex, 16);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    switch (match.toLowerCase()) {
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&amp;':
        return '&';
      default:
        return match;
    }
  });
}

/**
 * Creates a fake-timer-compatible timeout AbortSignal and a cleanup function that cancels the timer.
 */
export function createTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new Error(`Timed out after ${ms}ms`));
  }, ms);
  timer.unref?.();
  return {
    signal: ac.signal,
    clear: () => clearTimeout(timer),
  };
}

function extractHtmlAttr(attrs: string, targetName: string): string | null {
  const lowerTarget = targetName.toLowerCase();
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrs)) !== null) {
    if (m[1]?.toLowerCase() === lowerTarget) {
      return m[2] ?? m[3] ?? m[4] ?? '';
    }
  }
  return null;
}

/**
 * Extracts best-effort web server version from HTML:
 * - Primary: `<span class="... build-version ..." title="...">...</span>` (inner text, falling back to `title`)
 * - Fallback: `<meta name="app-version"|"build-version" content="...">`
 */
export function extractWebVersionFromHtml(html: string): string | null {
  if (!html) return null;

  const openSpanRe = /<span\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openSpanRe.exec(html)) !== null) {
    const attrs = openMatch[1] ?? '';
    const classAttr = extractHtmlAttr(attrs, 'class');
    if (!classAttr) continue;
    const classTokens = classAttr.trim().split(/\s+/);
    if (!classTokens.includes('build-version')) continue;

    if (!attrs.trimEnd().endsWith('/')) {
      const contentStart = openMatch.index + openMatch[0].length;
      const closeMatch = /<\/span\s*>/i.exec(html.slice(contentStart));
      if (closeMatch) {
        const innerRaw = html.slice(contentStart, contentStart + closeMatch.index);
        const innerDecoded = decodeHtmlEntities(innerRaw).trim();
        if (innerDecoded) return innerDecoded;
      }
    }

    const titleAttr = extractHtmlAttr(attrs, 'title');
    if (titleAttr !== null) {
      const titleDecoded = decodeHtmlEntities(titleAttr).trim();
      if (titleDecoded) return titleDecoded;
    }
  }

  const metaRe = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRe.exec(html)) !== null) {
    const attrs = metaMatch[1] ?? '';
    const nameAttr = extractHtmlAttr(attrs, 'name')?.trim().toLowerCase();
    if (nameAttr === 'app-version' || nameAttr === 'build-version') {
      const contentAttr = extractHtmlAttr(attrs, 'content');
      if (contentAttr !== null) {
        const decoded = decodeHtmlEntities(contentAttr).trim();
        if (decoded) return decoded;
      }
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
 * Fallback: matches `data-prompt-name="([^"]+)"` attributes when window.CHAT_CONFIG is absent or yields no playbook names.
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
            if (names.length > 0) {
              return [...new Set(names)];
            }
          }
        } catch {
          // If JSON.parse fails on non-standard JS literal in a test fixture, try extracting name fields
          const names: string[] = [];
          const nameRe = /["']?name["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
          let m: RegExpExecArray | null;
          while ((m = nameRe.exec(jsonArrayText)) !== null) {
            const rawVal = m[1] ?? m[2] ?? '';
            let parsedVal = rawVal;
            try {
              parsedVal = JSON.parse(`"${rawVal.replace(/"/g, '\\"')}"`);
            } catch {
              parsedVal = rawVal;
            }
            if (parsedVal.length > 0) {
              names.push(parsedVal);
            }
          }
          if (names.length > 0) {
            return [...new Set(names)];
          }
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
      names.push(decodeHtmlEntities(raw));
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
  private csrfHeaderName = 'X-CSRF-TOKEN';
  private htmlServerVersion: string | undefined;
  private headerServerVersion: string | undefined;
  private warnedHtmlVersionDrift = false;
  private warnedHeaderVersionDrift = false;
  private authenticated = false;

  constructor(private readonly opts: WebChatClientOptions) {
    validateWebCredentials(opts);
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

  getCsrfHeaderName(): string {
    return this.csrfHeaderName;
  }

  getServerVersion(): string | undefined {
    return this.htmlServerVersion ?? this.headerServerVersion;
  }

  private observeHtmlVersion(raw: string | null | undefined): void {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    if (this.htmlServerVersion === undefined) {
      this.htmlServerVersion = trimmed;
      return;
    }
    if (this.htmlServerVersion !== trimmed && !this.warnedHtmlVersionDrift) {
      this.warnedHtmlVersionDrift = true;
      (this.opts.log ?? console.error)(
        `[WARN] Web server version changed mid-run from "${this.htmlServerVersion}" to "${trimmed}"; keeping initial version "${this.htmlServerVersion}".`,
      );
    }
  }

  private observeHeaderVersion(raw: string | null | undefined): void {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    if (this.headerServerVersion === undefined) {
      this.headerServerVersion = trimmed;
      return;
    }
    if (this.headerServerVersion !== trimmed && !this.warnedHeaderVersionDrift) {
      this.warnedHeaderVersionDrift = true;
      if (!this.warnedHtmlVersionDrift) {
        const kept = this.htmlServerVersion ?? this.headerServerVersion;
        (this.opts.log ?? console.error)(
          `[WARN] Web server version changed mid-run from "${this.headerServerVersion}" to "${trimmed}"; keeping initial version "${kept}".`,
        );
      }
    }
  }

  private captureHtmlMeta(html: string): void {
    const headerName = extractCsrfHeaderName(html);
    if (headerName) {
      this.csrfHeaderName = headerName;
    }
    this.observeHtmlVersion(extractWebVersionFromHtml(html));
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
        headers.set(this.csrfHeaderName, sentCsrf);
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
    this.observeHeaderVersion(res.headers.get('x-app-version') ?? res.headers.get('x-build-version'));
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

  async ensureAuthenticated(signal?: AbortSignal): Promise<void> {
    if (!this.authenticated) {
      await this.authenticate(signal);
    }
  }

  async authenticate(signal?: AbortSignal): Promise<void> {
    if (this.isCookieMode) {
      this.cookies.clear();
      this.seedSessionCookie(this.opts.sessionCookie!);
      const { res } = await this.rawRequest('/chat', { method: 'GET', signal });
      if (res.status !== 200) {
        throw new UserError('Provided answer.web.sessionCookie is invalid or expired.');
      }
      const html = await res.text();
      this.captureHtmlMeta(html);
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
    const { res: loginPageRes } = await this.rawRequest('/login', { method: 'GET', signal });
    if (loginPageRes.status !== 200) {
      throw new UserError(
        `yvoke-web at ${this.baseUrl} does not have mock form login enabled. Start yvoke-web with SPRING_PROFILES_ACTIVE=dev and APP_SECURITY_MOCK=true, or configure answer.web.sessionCookie.`,
      );
    }
    const loginHtml = await loginPageRes.text();
    this.captureHtmlMeta(loginHtml);
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
      signal,
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
        `Web login failed for user "${username}". Note: trace access requires ROLE_ADMIN or ROLE_AREA_ADMIN (e.g. username="admin" in mock auth).`,
      );
    }

    // Step 3: GET /chat with rotated JSESSIONID to verify authenticated session and extract post-auth _csrf
    const { res: chatRes } = await this.rawRequest('/chat', { method: 'GET', signal });
    if (chatRes.status !== 200) {
      throw new UserError('Web login did not establish an authenticated session on /chat.');
    }
    const chatHtml = await chatRes.text();
    this.captureHtmlMeta(chatHtml);
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
    const reqSignal = init.signal ?? undefined;
    await this.ensureAuthenticated(reqSignal);
    const method = (init.method ?? 'GET').toUpperCase();
    const allowChatRedirect = init.allowChatRedirect === true;

    const { res, sentCsrf } = await this.rawRequest(path, init);

    if (this.isAuthRedirect(res, allowChatRedirect)) {
      if (this.isCookieMode) {
        throw new FatalRunError('Web sessionCookie expired mid-run.');
      }
      await this.authenticate(reqSignal);
      const retry = await this.rawRequest(path, init);
      return retry.res;
    }

    if (res.status === 403 && method !== 'GET' && method !== 'HEAD') {
      const { res: chatRes } = await this.rawRequest('/chat', { method: 'GET', signal: init.signal });
      if (this.isAuthRedirect(chatRes, false)) {
        if (this.isCookieMode) {
          throw new FatalRunError('Web sessionCookie expired mid-run.');
        }
        await this.authenticate(reqSignal);
        const retry = await this.rawRequest(path, init);
        return retry.res;
      }
      if (chatRes.status === 200) {
        const html = await chatRes.text();
        if (isLoginPageHtml(html)) {
          if (this.isCookieMode) {
            throw new FatalRunError('Web sessionCookie expired mid-run.');
          }
          await this.authenticate(reqSignal);
          const retry = await this.rawRequest(path, init);
          return retry.res;
        }
        const prevHeaderName = this.csrfHeaderName;
        this.captureHtmlMeta(html);
        const headerChanged = this.csrfHeaderName !== prevHeaderName;
        const newCsrf = extractCsrfToken(html);
        if ((newCsrf && newCsrf !== sentCsrf) || (newCsrf && headerChanged)) {
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
    this.captureHtmlMeta(html);
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
    const maxAttempts = this.retryDelaysMs.length + 1; // default: 7 total attempts (1 initial + 6 retries)
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
        throw new WebCapacityError(
          `Web server concurrency limit reached: POST /chat/${conversationId}/send-async returned HTTP 429 Too Many Requests after ${maxAttempts} attempts.`,
        );
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

  async stopConversation(conversationId: string, signal?: AbortSignal): Promise<void> {
    const defaultTimeout = signal ? undefined : createTimeoutSignal(10_000);
    try {
      await this.requestWithRecovery(`/chat/${conversationId}/stop`, {
        method: 'POST',
        form: {},
        signal: signal ?? defaultTimeout!.signal,
      });
    } finally {
      defaultTimeout?.clear();
    }
  }

  async deleteConversation(conversationId: string, signal?: AbortSignal): Promise<void> {
    const defaultTimeout = signal ? undefined : createTimeoutSignal(10_000);
    try {
      await this.requestWithRecovery(`/chat/${conversationId}/delete`, {
        method: 'POST',
        form: {},
        signal: signal ?? defaultTimeout!.signal,
        allowChatRedirect: true,
      });
    } finally {
      defaultTimeout?.clear();
    }
  }
}
