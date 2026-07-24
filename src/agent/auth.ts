import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude (model) auth. We never handle claude.ai credentials — the Agent SDK picks up ambient
 * Claude Code subscription credentials from ~/.claude/. This module only detects their presence and
 * strips an inherited ANTHROPIC_API_KEY so usage stays on the subscription, not pay-per-token.
 * Ported from yvoke-desktop/src/main/agent/ClaudeAuth.ts.
 */
export type ClaudeCredentialStatus = 'ok' | 'missing' | 'unknown';

export function detectClaudeCredentials(home: string = os.homedir()): ClaudeCredentialStatus {
  try {
    const credentialsFile = path.join(home, '.claude', '.credentials.json');
    if (fs.existsSync(credentialsFile)) return 'ok';
    const claudeDir = path.join(home, '.claude');
    // macOS stores creds in the keychain, so absence of the file is inconclusive.
    if (process.platform === 'darwin' && fs.existsSync(claudeDir)) return 'unknown';
    return fs.existsSync(claudeDir) ? 'unknown' : 'missing';
  } catch {
    return 'unknown';
  }
}

export function isAuthError(message: string): boolean {
  return /invalid api key|not logged in|please run \/login|authentication|credential|oauth token|api key/i.test(
    message,
  );
}

/** Inherit the environment except ANTHROPIC_API_KEY (which would switch billing off the subscription). */
export function sanitizedEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export const LOGIN_INSTRUCTIONS =
  'No Claude credentials found. Sign in with your Claude (Pro/Max) account by running ' +
  '`claude /login` in a terminal (install via `npm install -g @anthropic-ai/claude-code` if needed).';
