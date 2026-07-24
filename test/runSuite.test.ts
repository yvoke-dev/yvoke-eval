import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite, selectQuestions, type RunConfig, type RunDeps } from '../src/run/runSuite';
import { SYSTEM_PROMPT_NAME } from '../src/server/SystemPromptClient';
import type { PromptSource } from '../src/mcp/McpPrompts';
import type { EvalTask } from '../src/agent/AnswerBundle';
import type { Judge } from '../src/reviewer/Judge';
import { UserError } from '../src/types';
import { mkBundle } from './fixtures';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const EVAL_DIR = join(FIXTURES, 'eval');

/**
 * Wiring tests for runSuite. These exist because SystemPromptClient.test.ts proves the client works
 * but nothing proved runSuite *calls* it — the base prompt used to be fetched over MCP, and reverting
 * to that left the whole suite green. Everything here runs offline: the five collaborators that cross
 * a process boundary are injected, and what remains is fixture files on disk.
 *
 * No git stub is needed even though ReportWriter can shell out to `git rev-parse`: it only does so
 * when meta.gitSha is empty, and sanitizeSha always yields at least 'nogit'.
 */
function cfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    evalDir: EVAL_DIR,
    mode: 'single',
    evalIntent: 'specialist',
    categories: ['basics'],
    expect: null,
    limit: 1,
    merge: false,
    answerModel: 'sonnet',
    thinkingLevel: 'high',
    mcp: { serverBaseUrl: 'http://localhost:8080', bearer: 'tok', transport: 'http' },
    reviewerModel: 'opus',
    graderPath: join(FIXTURES, 'graders', 'reviewer.md'),
    orchestrationGraderPath: null,
    sandboxDir: join(FIXTURES, '.sandbox'),
    maxTurns: 8,
    ...overrides,
  };
}

const passJudge: Judge = {
  async review() {
    return { verdict: 'PASS', dimensions: {}, reasoning: 'fake', evidence: [] };
  },
};

/** Records every call, so a dep that stops being consulted shows up as an empty array. */
function harness(systemPromptBody: unknown = { systemPrompt: 'GROUNDING RULES' }, status = 200) {
  const urls: string[] = [];
  const askedOverMcp: string[] = [];
  const tasks: EvalTask[] = [];

  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(systemPromptBody), { status });
  }) as unknown as typeof fetch;

  const prompts: PromptSource = {
    list: async () => [{ name: 'demo-basics', title: 'Basics', description: '', tools: ['search_corpus'] }],
    getText: async (name) => {
      askedOverMcp.push(name);
      return 'PLAYBOOK TEXT';
    },
    serverVersion: () => undefined,
    close: async () => {},
  };

  const deps: Partial<RunDeps> = {
    credentials: () => 'ok',
    fetchFn,
    prompts,
    answerRunner: {
      run: async (t) => {
        tasks.push(t);
        return mkBundle({ answer: 'an answer' });
      },
    },
    judge: passJudge,
  };

  return { deps, urls, askedOverMcp, tasks };
}

describe('selectQuestions — --expect filter', () => {
  // Added to measure a behavioural question directly (do clarify answers retrieve first?) instead of
  // running 91 questions to reach the 18 that matter.
  it('keeps only questions of the requested kind', () => {
    const all = selectQuestions(cfg({ categories: [] }));
    const clarify = selectQuestions(cfg({ categories: [], expect: 'clarify' }));
    expect(all.length).toBeGreaterThan(clarify.length);
    expect(clarify.length).toBeGreaterThan(0);
    expect(clarify.every((q) => q.expect === 'clarify')).toBe(true);
  });

  it('returns everything when no kind is given', () => {
    expect(selectQuestions(cfg({ categories: [], expect: null })).length).toBe(
      selectQuestions(cfg({ categories: [] })).length,
    );
  });

  // The filter runs BEFORE the per-category cap, so --limit counts matching questions rather than
  // being spent on non-matching ones.
  it('applies before the per-category limit', () => {
    const capped = selectQuestions(cfg({ categories: [], expect: 'clarify', limit: 1 }));
    expect(capped.every((q) => q.expect === 'clarify')).toBe(true);
    const cats = capped.map((q) => q.category);
    expect(new Set(cats).size).toBe(cats.length); // at most one per category
  });
});

describe('runSuite — base system prompt wiring', () => {
  it('fetches it over REST, never over MCP, and threads it into the answer runner', async () => {
    const h = harness();
    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      // Pinned by URL, not by collaborator name: MCP cannot produce this path, so no MCP-backed
      // implementation can satisfy the assertion.
      expect(h.urls).toEqual(['http://localhost:8080/api/chat/v1/prompts/system/default-chat']);
      expect(h.askedOverMcp).not.toContain(SYSTEM_PROMPT_NAME);
      // The fetched text has to reach the model, not merely be fetched.
      expect(h.tasks[0]!.systemPrompt).toBe('GROUNDING RULES');
      expect(summary.pass).toBe(1);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('records which prompt the answers ran under', async () => {
    const h = harness();
    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
      expect(meta.systemPromptName).toBe(SYSTEM_PROMPT_NAME);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('runs on the SDK default when the server has no such prompt, and says so in run_meta', async () => {
    // 200 + "" is the server's own "no prompt configured" answer (the controller's orElse("")).
    const h = harness({ systemPrompt: '' });
    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      expect(h.tasks[0]!.systemPrompt).toBeNull();
      const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
      expect(meta.systemPromptName).toBeNull();
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('aborts the whole run when the endpoint errors, rather than degrading quietly', async () => {
    const h = harness({}, 500);
    // Fatal by design: a run without the production prompt is comparable neither to production nor
    // to the baseline, so it must not silently produce gradeable results.
    await expect(runSuite(cfg(), () => {}, h.deps)).rejects.toThrow(UserError);
    expect(h.tasks).toHaveLength(0);
  });
});
