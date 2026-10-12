import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  runSuite,
  selectQuestions,
  withTimeout,
  CachedPromptSource,
  harnessGitSha,
  gitShaForDir,
  type RunConfig,
  type RunDeps,
} from '../src/run/runSuite';
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
    webAllowedDomains: [],
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
      // The fetched text reaches the model, combined with the playbook template text.
      expect(h.tasks[0]!.systemPrompt).toBe('GROUNDING RULES\n\n---\n\nPLAYBOOK TEXT');
      expect(h.tasks[0]!.modelContent).toBe(h.tasks[0]!.question.question);
      expect(h.tasks[0]!.modelContent).not.toContain('PLAYBOOK TEXT');
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
      // With a playbook and no server base prompt, systemPrompt contains only the playbook text.
      expect(h.tasks[0]!.systemPrompt).toBe('PLAYBOOK TEXT');
      const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
      expect(meta.systemPromptName).toBeNull();
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('runs on SDK default (null systemPrompt) when both server prompt and playbook template are empty', async () => {
    const h = harness({ systemPrompt: '' });
    h.deps.prompts = {
      ...h.deps.prompts!,
      getText: async () => '',
    };
    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      expect(h.tasks[0]!.systemPrompt).toBeNull();
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

describe('runSuite — playbook-designated system prompt resolution', () => {
  it('resolves designated system prompt over REST and combines with playbook', async () => {
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'demo-basics', title: 'Basics', description: '', tools: ['search_corpus'], systemPrompt: 'coding-chat' },
      ],
    };
    const promptsReturned: Record<string, string> = {
      'default-chat': 'DEFAULT RULES',
      'coding-chat': 'CODING RULES',
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      h.urls.push(urlStr);
      const name = decodeURIComponent(urlStr.split('/').pop() ?? '');
      return new Response(JSON.stringify({ systemPrompt: promptsReturned[name] ?? '' }), { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      expect(h.urls).toContain('http://localhost:8080/api/chat/v1/prompts/system/default-chat');
      expect(h.urls).toContain('http://localhost:8080/api/chat/v1/prompts/system/coding-chat');
      expect(h.tasks[0]!.systemPrompt).toBe('CODING RULES\n\n---\n\nPLAYBOOK TEXT');
      expect(h.tasks[0]!.modelContent).toBe(h.tasks[0]!.question.question);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('falls back to default-chat when designated prompt resolution fails', async () => {
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'demo-basics', title: 'Basics', description: '', tools: ['search_corpus'], systemPrompt: 'failing-chat' },
      ],
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      h.urls.push(urlStr);
      if (urlStr.includes('failing-chat')) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT RULES' }), { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      expect(h.tasks[0]!.systemPrompt).toBe('DEFAULT RULES\n\n---\n\nPLAYBOOK TEXT');
      expect(summary.pass).toBe(1);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });
});

describe('withTimeout', () => {
  it('aborts the AbortController when timing out', async () => {
    let signalAborted = false;
    let abortReason: unknown;
    await expect(
      withTimeout(
        async (ac) => {
          ac.signal.addEventListener('abort', () => {
            signalAborted = true;
            abortReason = ac.signal.reason;
          });
          await new Promise((r) => setTimeout(r, 100));
          return 'ok';
        },
        10,
        'test operation',
      ),
    ).rejects.toThrow(/Timed out after 0s while test operation/);

    expect(signalAborted).toBe(true);
    expect(abortReason).toBeInstanceOf(Error);
    expect((abortReason as Error).message).toMatch(/Timed out/);
  });
});

describe('CachedPromptSource', () => {
  it('evicts failed getText promises so subsequent calls can retry', async () => {
    let attempts = 0;
    const inner: PromptSource = {
      list: async () => [],
      getText: async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient failure');
        return 'success';
      },
      serverVersion: () => undefined,
      close: async () => {},
    };
    const cached = new CachedPromptSource(inner);
    await expect(cached.getText('test')).rejects.toThrow('transient failure');
    const res = await cached.getText('test');
    expect(res).toBe('success');
    expect(attempts).toBe(2);
  });

  it('evicts failed list promises so subsequent calls can retry', async () => {
    let attempts = 0;
    const inner: PromptSource = {
      list: async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient failure');
        return [{ name: 'p1', title: 'P1', description: '', tools: [] }];
      },
      getText: async () => '',
      serverVersion: () => undefined,
      close: async () => {},
    };
    const cached = new CachedPromptSource(inner);
    await expect(cached.list()).rejects.toThrow('transient failure');
    const res = await cached.list();
    expect(res).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe('runSuite — judge quota exhaustion aborts suite', () => {
  it('stops suite immediately with aborted: true when judge returns quota error', async () => {
    const h = harness();
    let judgeCalls = 0;
    h.deps.judge = {
      async review() {
        judgeCalls++;
        return {
          verdict: 'ERROR',
          dimensions: {},
          reasoning: '429 You have exhausted your capacity limit. Please wait before retrying.',
          evidence: [],
        };
      },
    };
    // basics has 6 questions (Q1..Q5, Q7; Q6 is skipped), limit: 0 runs all
    const summary = await runSuite(cfg({ limit: 0 }), () => {}, h.deps);
    try {
      expect(judgeCalls).toBe(1); // Aborted after the first question!
      expect(summary.aborted).toBe(true);
      expect(summary.abortReason).toBeDefined();
      expect(summary.error).toBe(1);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });
});

describe('runSuite — scoring version and provenance', () => {
  it('records scoringVersion 2.2, harnessGitSha, contentGitSha, and systemPromptSha in run_meta.json', async () => {
    const h = harness();
    const config = cfg();
    const summary = await runSuite(config, () => {}, h.deps);
    try {
      const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
      expect(meta.scoringVersion).toBe('2.2');
      expect(meta.harnessGitSha).toBe(harnessGitSha());
      expect(meta.contentGitSha).toBe(gitShaForDir(config.evalDir));
      expect(typeof meta.systemPromptSha).toBe('string');
      expect(meta.systemPromptSha).toMatch(/^[0-9a-fA-F]{64}$/);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('hashes the exact task system prompt including designated prompt text', async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oim-structured')) {
        return new Response(JSON.stringify({ systemPrompt: 'CUSTOM DESIGNATED STRUCTURED PROMPT' }), { status: 200 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT CHAT PROMPT' }), { status: 200 });
    }) as unknown as typeof fetch;

    const prompts: PromptSource = {
      list: async () => [
        {
          name: 'demo-basics',
          title: 'Basics',
          description: '',
          tools: ['search_corpus'],
          systemPrompt: 'oim-structured',
        },
      ],
      getText: async () => 'PLAYBOOK TEMPLATE TEXT',
      serverVersion: () => undefined,
      close: async () => {},
    };

    const deps: Partial<RunDeps> = {
      credentials: () => 'ok',
      fetchFn,
      prompts,
      answerRunner: {
        run: async () => mkBundle({ answer: 'an answer' }),
      },
      judge: passJudge,
    };

    const summary = await runSuite(cfg(), () => {}, deps);
    try {
      const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
      const expectedText = 'CUSTOM DESIGNATED STRUCTURED PROMPT\n\n---\n\nPLAYBOOK TEMPLATE TEXT';
      const expectedSha = createHash('sha256').update(expectedText).digest('hex');
      const defaultSha = createHash('sha256').update('DEFAULT CHAT PROMPT\n\n---\n\nPLAYBOOK TEMPLATE TEXT').digest('hex');
      expect(meta.systemPromptName).toBe('oim-structured');
      expect(meta.systemPromptSha).toBe(expectedSha);
      expect(meta.systemPromptSha).not.toBe(defaultSha);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('records distinct contentGitSha when evalDir is a separate git repository', async () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'yvoke-separate-git-'));
    try {
      execSync('git init -b main', { cwd: tmp, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmp, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
      mkdirSync(join(tmp, 'eval'), { recursive: true });
      copyFileSync(join(EVAL_DIR, 'eval_specs.yaml'), join(tmp, 'eval', 'eval_specs.yaml'));
      copyFileSync(join(EVAL_DIR, 'eval_basics.md'), join(tmp, 'eval', 'eval_basics.md'));
      execSync('git add . && git commit -m "content commit"', { cwd: tmp, stdio: 'ignore' });

      const separateSha = gitShaForDir(join(tmp, 'eval'));
      expect(separateSha).not.toBe(harnessGitSha());

      const h = harness();
      const customCfg: RunConfig = {
        ...cfg(),
        evalDir: join(tmp, 'eval'),
      };
      const summary = await runSuite(customCfg, () => {}, h.deps);
      try {
        const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
        expect(meta.contentGitSha).toBe(separateSha);
        expect(meta.harnessGitSha).toBe(harnessGitSha());
        expect(meta.contentGitSha).not.toBe(meta.harnessGitSha);
      } finally {
        summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('harnessGitSha and gitShaForDir', () => {
  it('detects clean and dirty working trees including pathspec exclusion for eval/runs and runs', () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'yvoke-git-'));
    try {
      execSync('git init -b main', { cwd: tmp, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmp, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
      mkdirSync(join(tmp, 'graders'), { recursive: true });
      mkdirSync(join(tmp, 'eval'), { recursive: true });
      writeFileSync(join(tmp, 'graders', 'oim.md'), 'grader content\n');
      writeFileSync(join(tmp, 'eval', 'specs.yaml'), 'specs\n');
      execSync('git add . && git commit -m "initial"', { cwd: tmp, stdio: 'ignore' });

      // Clean tree
      const cleanSha = harnessGitSha(tmp);
      expect(cleanSha).not.toContain('-dirty');
      expect(cleanSha).toMatch(/^[0-9a-fA-F]{7,12}$/);

      // Untracked file in root -> dirty in harnessGitSha
      writeFileSync(join(tmp, 'untracked_harness.ts'), 'content\n');
      expect(harnessGitSha(tmp)).toBe(`${cleanSha}-dirty`);
      rmSync(join(tmp, 'untracked_harness.ts'));
      expect(harnessGitSha(tmp)).toBe(cleanSha);

      // Tracked file modification in root -> dirty in harnessGitSha
      writeFileSync(join(tmp, 'graders', 'oim.md'), 'modified\n');
      expect(harnessGitSha(tmp)).toBe(`${cleanSha}-dirty`);
      // Restore tracked file
      execSync('git checkout graders/oim.md', { cwd: tmp, stdio: 'ignore' });
      expect(harnessGitSha(tmp)).toBe(cleanSha);

      // In gitShaForDir called with <repo>/eval:
      // 1. Clean when called on eval subdirectory
      const evalSubdir = join(tmp, 'eval');
      expect(gitShaForDir(evalSubdir)).toBe(cleanSha);

      // 2. Untracked file inside eval/runs/ does NOT mark dirty
      mkdirSync(join(tmp, 'eval', 'runs', 'r1'), { recursive: true });
      writeFileSync(join(tmp, 'eval', 'runs', 'r1', 'result.json'), '{"output":1}');
      expect(gitShaForDir(evalSubdir)).toBe(cleanSha);

      // 3. Untracked file inside root runs/ does NOT mark dirty
      mkdirSync(join(tmp, 'runs', 'r2'), { recursive: true });
      writeFileSync(join(tmp, 'runs', 'r2', 'result.json'), '{"output":2}');
      expect(gitShaForDir(evalSubdir)).toBe(cleanSha);

      // 4. Modifying root graders/oim.md DOES mark gitShaForDir dirty even when called with evalSubdir
      writeFileSync(join(tmp, 'graders', 'oim.md'), 'changed\n');
      expect(gitShaForDir(evalSubdir)).toBe(`${cleanSha}-dirty`);
      execSync('git checkout graders/oim.md', { cwd: tmp, stdio: 'ignore' });
      expect(gitShaForDir(evalSubdir)).toBe(cleanSha);

      // 5. Untracked file in eval/specs/ DOES mark gitShaForDir dirty
      mkdirSync(join(tmp, 'eval', 'specs'), { recursive: true });
      writeFileSync(join(tmp, 'eval', 'specs', 'new.yaml'), 'spec: 1');
      expect(gitShaForDir(evalSubdir)).toBe(`${cleanSha}-dirty`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});


describe('selectQuestions — orchestration_ie filtering', () => {
  it('filters out orchestration_ie when in specialist intent with no categories specified', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'yvoke-select-'));
    try {
      writeFileSync(
        join(dir, 'eval_specs.yaml'),
        `
basics:
  Q1: {}
orchestration_ie:
  Q1:
    expected_specialists: [specialist-a]
`,
      );
      writeFileSync(join(dir, 'eval_basics.md'), '# Basics\n\n## Q1 — Question 1\n');
      writeFileSync(
        join(dir, 'eval_orchestration_ie.md'),
        '# Orchestration\n\n## Q1 — Question 1\n',
      );

      const specialist = selectQuestions(cfg({ evalDir: dir, evalIntent: 'specialist', categories: [] }));
      expect(specialist.some((q) => q.category === 'orchestration_ie')).toBe(false);
      expect(specialist.some((q) => q.category === 'basics')).toBe(true);

      const orchestration = selectQuestions(
        cfg({
          evalDir: dir,
          evalIntent: 'orchestration',
          categories: [],
          mas: {
            profile: {
              orchestratorPlaybook: 'skills/oim-orchestrator.md',
              reviewerPlaybook: 'skills/oim-reviewer.md',
              specialistPlaybooks: ['specialist-a'],
            },
            tuning: {
              orchestrator: { model: 'sonnet', thinkingLevel: 'off' },
              reviewer: { configuredModel: 'haiku', model: 'haiku', thinkingLevel: 'off' },
              specialist: { model: 'haiku', thinkingLevel: 'off' },
              maxReviewRounds: 1,
              maxSpecialistCalls: 4,
              orchestratorMaxTurns: 4,
              specialistMaxTurns: 4,
            },
          },
        }),
      );
      expect(orchestration.some((q) => q.category === 'orchestration_ie')).toBe(true);
      expect(orchestration.some((q) => q.category === 'basics')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSuite — abortController forwarding', () => {
  it('forwards AbortController to single-mode task.abortController', async () => {
    const h = harness();
    const summary = await runSuite(cfg(), () => {}, h.deps);
    try {
      expect(h.tasks).toHaveLength(1);
      expect(h.tasks[0]!.abortController).toBeInstanceOf(AbortController);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('forwards AbortController and expect to masAnswerRunner.run', async () => {
    const h = harness();
    let capturedOpts: { abortController?: AbortController; expect?: string } | undefined;
    h.deps.masAnswerRunner = {
      run: async (_content, opts) => {
        capturedOpts = opts;
        return mkBundle({ answer: 'mas answer' });
      },
    };

    const masCfg = cfg({
      mode: 'mas',
      mas: {
        profile: {
          orchestratorPlaybook: 'demo-basics',
          reviewerPlaybook: 'demo-basics',
          specialistPlaybooks: ['demo-basics'],
        },
        tuning: {
          orchestrator: { model: 'sonnet', thinkingLevel: 'off' },
          reviewer: { configuredModel: 'haiku', model: 'haiku', thinkingLevel: 'off' },
          specialist: { model: 'haiku', thinkingLevel: 'off' },
          maxReviewRounds: 1,
          maxSpecialistCalls: 4,
          orchestratorMaxTurns: 4,
          specialistMaxTurns: 4,
        },
      },
    });

    const summary = await runSuite(masCfg, () => {}, h.deps);
    try {
      expect(capturedOpts?.abortController).toBeInstanceOf(AbortController);
      expect(capturedOpts?.expect).toBe('answer');
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });
});
