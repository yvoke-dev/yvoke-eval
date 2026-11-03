import { describe, it, expect, vi } from 'vitest';
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
import { FatalRunError, UserError } from '../src/types';
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

describe('Phase 3: Prompt provenance and metadata', () => {
  const sha = (str: string) => createHash('sha256').update(str).digest('hex');

  function makeTestEvalDir(categories: Record<string, Record<string, { playbook?: string | null }>>): string {
    const dir = mkdtempSync(join(os.tmpdir(), 'yvoke-phase3-eval-'));
    const specsYaml: Record<string, unknown> = {};
    for (const [cat, questions] of Object.entries(categories)) {
      specsYaml[cat] = {};
      let md = `# ${cat}\n\n`;
      for (const [qid, qspec] of Object.entries(questions)) {
        (specsYaml[cat] as Record<string, unknown>)[qid] = {
          playbook: qspec.playbook !== undefined ? qspec.playbook : undefined,
        };
        md += `## ${qid} — Question ${qid}\n\nQuestion text for ${qid}\n\n`;
      }
      writeFileSync(join(dir, `eval_${cat}.md`), md);
    }
    writeFileSync(join(dir, 'eval_specs.yaml'), JSON.stringify(specsYaml));
    return dir;
  }

  function readMeta(runDir: string) {
    return JSON.parse(readFileSync(join(runDir, 'run_meta.json'), 'utf8'));
  }

  it('Test 1 (Single playbook in merge mode - Hash what was sent)', async () => {
    const evalDir = makeTestEvalDir({
      c1: { Q1: { playbook: 'demo-basics' } },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'demo-basics', title: 'Basics', description: '', tools: [], systemPrompt: 'oim-structured', version: 2 },
      ],
      getText: async () => 'PLAYBOOK TEMPLATE',
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oim-structured')) {
        return new Response(JSON.stringify({ systemPrompt: 'STRUCTURED BASE' }), { status: 200 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT BASE' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: true, categories: ['c1'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      const meta = readMeta(summary.runDirs[0]!);
      const sentPrompt = 'STRUCTURED BASE\n\n---\n\nPLAYBOOK TEMPLATE';
      expect(meta.systemPromptName).toBe('oim-structured');
      expect(meta.systemPromptSha).toBe(sha(sentPrompt));
      expect(meta.systemPromptFallback).toBe(false);
      expect(meta.playbookPrompts).toBeNull();
      expect(meta.playbookVersion).toBe(2);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 2 (Designated prompt fallback)', async () => {
    const evalDir = makeTestEvalDir({
      c1: { Q1: { playbook: 'demo-basics' } },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'demo-basics', title: 'Basics', description: '', tools: [], systemPrompt: 'empty-chat' },
      ],
      getText: async () => 'PLAYBOOK TEMPLATE',
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('empty-chat')) {
        return new Response(JSON.stringify({ systemPrompt: '' }), { status: 200 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT BASE' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: true, categories: ['c1'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      const meta = readMeta(summary.runDirs[0]!);
      const expectedPrompt = 'DEFAULT BASE\n\n---\n\nPLAYBOOK TEMPLATE';
      expect(meta.systemPromptName).toBe('default-chat');
      expect(meta.systemPromptFallback).toBe(true);
      expect(meta.systemPromptSha).toBe(sha(expectedPrompt));
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 3 (Transient fallback aggregation)', async () => {
    const evalDir = makeTestEvalDir({
      c1: { Q1: { playbook: 'demo-basics' }, Q2: { playbook: 'demo-basics' } },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'demo-basics', title: 'Basics', description: '', tools: [], systemPrompt: 'transient-chat' },
      ],
      getText: async () => 'PLAYBOOK TEMPLATE',
    };
    let transientCallCount = 0;
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('transient-chat')) {
        transientCallCount++;
        if (transientCallCount === 1) {
          return new Response(JSON.stringify({ systemPrompt: '' }), { status: 200 });
        }
        return new Response(JSON.stringify({ systemPrompt: 'CUSTOM BASE' }), { status: 200 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT BASE' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: true, categories: ['c1'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      const meta = readMeta(summary.runDirs[0]!);
      const fallbackSha = sha('DEFAULT BASE\n\n---\n\nPLAYBOOK TEMPLATE');
      const customSha = sha('CUSTOM BASE\n\n---\n\nPLAYBOOK TEMPLATE');
      expect(meta.systemPromptName).toBeNull();
      expect(meta.systemPromptSha).toBeNull();
      expect(meta.systemPromptVaried).toBe(true);
      expect(meta.systemPromptFallback).toBe(true);
      expect(meta.systemPromptShas).toHaveLength(2);
      expect(meta.systemPromptShas).toContain(fallbackSha);
      expect(meta.systemPromptShas).toContain(customSha);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 4 (Non-merge multi-category sweep)', async () => {
    const evalDir = makeTestEvalDir({
      catA: { Q1: { playbook: 'pbA' } },
      catB: { Q1: { playbook: 'pbB' } },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'pbA', title: 'A', description: '', tools: [], systemPrompt: 'promptA' },
        { name: 'pbB', title: 'B', description: '', tools: [], systemPrompt: 'promptB' },
      ],
      getText: async (name) => (name === 'pbA' ? 'PBA TEMPLATE' : 'PBB TEMPLATE'),
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('promptA')) return new Response(JSON.stringify({ systemPrompt: 'BASE A' }), { status: 200 });
      if (urlStr.includes('promptB')) return new Response(JSON.stringify({ systemPrompt: 'BASE B' }), { status: 200 });
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: false, categories: ['catA', 'catB'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      expect(summary.runDirs).toHaveLength(2);
      const meta0 = readMeta(summary.runDirs[0]!);
      const meta1 = readMeta(summary.runDirs[1]!);
      const [metaA, metaB] = meta0.playbooks.includes('pbA') ? [meta0, meta1] : [meta1, meta0];

      expect(metaA.systemPromptName).toBe('promptA');
      expect(metaA.systemPromptSha).toBe(sha('BASE A\n\n---\n\nPBA TEMPLATE'));
      expect(metaA.systemPromptFallback).toBe(false);

      expect(metaB.systemPromptName).toBe('promptB');
      expect(metaB.systemPromptSha).toBe(sha('BASE B\n\n---\n\nPBB TEMPLATE'));
      expect(metaB.systemPromptFallback).toBe(false);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 5 (Category without playbook & Sentinel check)', async () => {
    const evalDir = makeTestEvalDir({
      plain: { Q1: { playbook: null } },
    });
    const h = harness({ systemPrompt: 'DEFAULT BASE CHAT' });
    const runCfg = cfg({ evalDir, merge: false, categories: ['plain'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      const raw = readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8');
      const meta = JSON.parse(raw);
      expect(meta.systemPromptName).toBe('default-chat');
      expect(meta.systemPromptSha).toBe(sha('DEFAULT BASE CHAT'));
      expect(raw).not.toContain('(none)');
      expect(meta.playbooks).toEqual([]);
      expect(meta.playbooks).not.toContain('_no_playbook');
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 6 (Multi-playbook in merge mode & _no_playbook preservation)', async () => {
    const evalDir = makeTestEvalDir({
      multi: {
        Q1: { playbook: 'pb1' },
        Q2: { playbook: 'pb2' },
        Q3: { playbook: null },
      },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'pb1', title: '1', description: '', tools: [], systemPrompt: 'sys1' },
        { name: 'pb2', title: '2', description: '', tools: [], systemPrompt: 'sys2' },
      ],
      getText: async (name) => (name === 'pb1' ? 'TEXT 1' : 'TEXT 2'),
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('sys1')) return new Response(JSON.stringify({ systemPrompt: 'BASE 1' }), { status: 200 });
      if (urlStr.includes('sys2')) return new Response(JSON.stringify({ systemPrompt: 'BASE 2' }), { status: 200 });
      return new Response(JSON.stringify({ systemPrompt: 'BASE DEFAULT' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: true, categories: ['multi'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      const meta = readMeta(summary.runDirs[0]!);
      expect(meta.systemPromptName).toBeNull();
      expect(meta.systemPromptSha).toBeNull();
      expect(meta.playbookPrompts).toBeDefined();
      expect(meta.playbookPrompts['pb1']).toEqual({
        systemPromptName: 'sys1',
        systemPromptSha: sha('BASE 1\n\n---\n\nTEXT 1'),
        systemPromptFallback: false,
      });
      expect(meta.playbookPrompts['pb2']).toEqual({
        systemPromptName: 'sys2',
        systemPromptSha: sha('BASE 2\n\n---\n\nTEXT 2'),
        systemPromptFallback: false,
      });
      expect(meta.playbookPrompts['_no_playbook']).toEqual({
        systemPromptName: 'default-chat',
        systemPromptSha: sha('BASE DEFAULT'),
        systemPromptFallback: false,
      });
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 7 (MAS mode in merge run)', async () => {
    const evalDir = makeTestEvalDir({
      c1: { Q1: { playbook: 'demo-basics' } },
    });
    const h = harness();
    h.deps.masAnswerRunner = {
      run: async () => mkBundle({ answer: 'mas compose' }),
    };
    const masCfg = cfg({
      evalDir,
      mode: 'mas',
      merge: true,
      categories: ['c1'],
      limit: 0,
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
      const meta = readMeta(summary.runDirs[0]!);
      expect(meta.systemPromptName).toBeNull();
      expect(meta.systemPromptSha).toBeNull();
      expect(meta.playbookPrompts).toBeNull();
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 8 (MAS mode in non-merge category sweep)', async () => {
    const evalDir = makeTestEvalDir({
      m1: { Q1: { playbook: 'demo-basics' } },
      m2: { Q1: { playbook: 'demo-basics' } },
    });
    const h = harness();
    h.deps.masAnswerRunner = {
      run: async () => mkBundle({ answer: 'mas compose' }),
    };
    const masCfg = cfg({
      evalDir,
      mode: 'mas',
      merge: false,
      categories: ['m1', 'm2'],
      limit: 0,
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
      expect(summary.runDirs).toHaveLength(2);
      for (const dir of summary.runDirs) {
        const meta = readMeta(dir);
        expect(meta.systemPromptName).toBeNull();
        expect(meta.systemPromptSha).toBeNull();
        expect(meta.systemPromptFallback).toBe(false);
      }
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 9 (Two categories sharing a playbook)', async () => {
    const evalDir = makeTestEvalDir({
      full: { Q1: { playbook: 'oim-full' }, Q2: { playbook: 'oim-full' } },
      full_ie: { Q1: { playbook: 'oim-full' }, Q2: { playbook: 'oim-full' } },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'oim-full', title: 'Full', description: '', tools: [], systemPrompt: 'oim-full' },
      ],
      getText: async () => 'FULL TEMPLATE',
    };
    let oimFullCalls = 0;
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oim-full')) {
        oimFullCalls++;
        // Category `full` runs first (Q1, Q2): call 1 (Q1) returns empty, call 2 (Q2) returns custom
        if (oimFullCalls === 1) {
          return new Response(JSON.stringify({ systemPrompt: '' }), { status: 200 });
        }
        return new Response(JSON.stringify({ systemPrompt: 'FULL BASE' }), { status: 200 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT BASE' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: false, categories: ['full', 'full_ie'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      expect(summary.runDirs).toHaveLength(2);
      const meta0 = readMeta(summary.runDirs[0]!);
      const meta1 = readMeta(summary.runDirs[1]!);
      const [metaFull, metaFullIe] = summary.runDirs[0]!.includes('__full') ? [meta0, meta1] : [meta1, meta0];

      // Category full had transient fallback
      expect(metaFull.systemPromptVaried).toBe(true);
      expect(metaFull.systemPromptFallback).toBe(true);
      expect(metaFull.systemPromptName).toBeNull();

      // Category full_ie was unvaried and clean
      expect(metaFullIe.systemPromptVaried).toBeUndefined();
      expect(metaFullIe.systemPromptFallback).toBe(false);
      expect(metaFullIe.systemPromptName).toBe('oim-full');
      expect(metaFullIe.systemPromptSha).toBe(sha('FULL BASE\n\n---\n\nFULL TEMPLATE'));
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 10 (Mixed category with playbook and no-playbook questions)', async () => {
    const evalDir = makeTestEvalDir({
      mixed: {
        Q1: { playbook: 'oim-structured' },
        Q2: { playbook: null },
      },
    });
    const h = harness();
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'oim-structured', title: 'Struct', description: '', tools: [], systemPrompt: 'oim-structured' },
      ],
      getText: async () => 'STRUCT TEMPLATE',
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oim-structured')) {
        return new Response(JSON.stringify({ systemPrompt: 'STRUCT BASE' }), { status: 200 });
      }
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT BASE' }), { status: 200 });
    }) as unknown as typeof fetch;

    const runCfg = cfg({ evalDir, merge: false, categories: ['mixed'], limit: 0 });
    const summary = await runSuite(runCfg, () => {}, h.deps);
    try {
      const meta = readMeta(summary.runDirs[0]!);
      expect(meta.systemPromptName).toBeNull();
      expect(meta.systemPromptSha).toBeNull();
      expect(meta.playbookPrompts).toBeDefined();
      expect(Object.keys(meta.playbookPrompts).sort()).toEqual(['_no_playbook', 'oim-structured']);
      expect(meta.playbooks).toEqual(['oim-structured']);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('Test 11 (Web provider defaultPlaybook propagation across all 4 metadata sites in merge: true and merge: false)', async () => {
    const evalDir = makeTestEvalDir({
      getting_started: {
        Q1: { playbook: null },
        Q2: { playbook: null },
      },
      coding: {
        Q1: { playbook: 'oim-coding' },
      },
    });
    const h = harness();
    let preflightCalled = false;
    h.deps.prompts = {
      ...h.deps.prompts!,
      list: async () => [
        { name: 'oim-full', title: 'Full', description: '', tools: [], systemPrompt: 'oim-full-sys', version: 2 },
        { name: 'oim-coding', title: 'Coding', description: '', tools: [], systemPrompt: 'oim-coding-sys', version: 3 },
      ],
      getText: async (name) => (name === 'oim-full' ? 'FULL PLAYBOOK TEXT' : 'CODING PLAYBOOK TEXT'),
    };
    h.deps.fetchFn = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oim-full-sys')) return new Response(JSON.stringify({ systemPrompt: 'FULL SYS' }), { status: 200 });
      if (urlStr.includes('oim-coding-sys')) return new Response(JSON.stringify({ systemPrompt: 'CODING SYS' }), { status: 200 });
      return new Response(JSON.stringify({ systemPrompt: 'DEFAULT SYS' }), { status: 200 });
    }) as unknown as typeof fetch;

    h.deps.answerRunner = {
      preflight: async () => {
        preflightCalled = true;
      },
      run: async (task) =>
        mkBundle({
          answer: 'web answer',
          providerMeta: {
            resolvedModel: 'gemini-3.8-flash-001',
            playbook: task.question.playbook,
            playbookVersion: task.question.playbook === 'oim-full' ? 7 : 3,
          },
        }),
    };

    const webCfgBase = cfg({
      evalDir,
      provider: 'web',
      answerModel: 'gemini-3.8-flash',
      categories: ['getting_started', 'coding'],
      limit: 0,
      web: {
        baseUrl: 'http://localhost:8080',
        defaultPlaybook: 'oim-full',
        pollIntervalMs: 10,
        keepConversations: false,
      },
    });

    // 1. Non-merge mode (per-category run_meta.json)
    const summaryNonMerge = await runSuite({ ...webCfgBase, merge: false }, () => {}, h.deps);
    // 2. Merge mode (root run_meta.json)
    const summaryMerge = await runSuite({ ...webCfgBase, merge: true }, () => {}, h.deps);
    try {
      expect(preflightCalled).toBe(true);
      expect(summaryNonMerge.runDirs).toHaveLength(2);
      for (const dir of summaryNonMerge.runDirs) {
        expect(dir).toContain('__web-gemini-3.8-flash__');
      }

      const gsDir = summaryNonMerge.runDirs.find((d) => d.endsWith('__getting_started'))!;
      const gsMeta = readMeta(gsDir);
      expect(gsMeta.answerProvider).toBe('web-single');
      expect(gsMeta.sdkModel).toBeUndefined();
      expect(gsMeta.sdkVersion).toBeUndefined();
      expect(gsMeta.resolvedAnswerModel).toBe('gemini-3.8-flash-001');
      // defaultPlaybook propagated to catPlaybooks, playbookVersion (from web trace = 7), and systemPromptSha:
      expect(gsMeta.playbooks).toEqual(['oim-full']);
      expect(gsMeta.playbookVersion).toBe(7);
      expect(gsMeta.systemPromptName).toBe('oim-full-sys');
      expect(gsMeta.systemPromptSha).toBe(sha('FULL SYS\n\n---\n\nFULL PLAYBOOK TEXT'));

      // Meanwhile results.json preserves the original spec question.playbook === null:
      const gsResults = JSON.parse(readFileSync(join(gsDir, 'results.json'), 'utf8'));
      expect(gsResults[0].question.playbook).toBeNull();

      // Merge mode root run_meta.json:
      expect(summaryMerge.runDirs[0]).toContain('__web-gemini-3.8-flash__');
      const rootMeta = readMeta(summaryMerge.runDirs[0]!);
      expect(rootMeta.answerProvider).toBe('web-single');
      expect(rootMeta.playbooks.sort()).toEqual(['oim-coding', 'oim-full']);
      expect(Object.keys(rootMeta.playbookPrompts).sort()).toEqual(['oim-coding', 'oim-full']);
      expect(rootMeta.playbookPrompts['oim-full']).toEqual({
        systemPromptName: 'oim-full-sys',
        systemPromptSha: sha('FULL SYS\n\n---\n\nFULL PLAYBOOK TEXT'),
        systemPromptFallback: false,
      });
    } finally {
      summaryNonMerge.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      summaryMerge.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });
});

describe('runSuite — FatalRunError aborts question loop on first question', () => {
  it('stops immediately on the first question and sets summary.aborted and summary.abortReason', async () => {
    const h = harness();
    let runnerCalls = 0;
    h.deps.answerRunner = {
      run: async () => {
        runnerCalls++;
        throw new FatalRunError(
          'yvoke-web returned 0 toolCalls in trace despite tool activity in the message. Start yvoke-web with APP_CHAT_TRACE_TOOL_CALLS=true (app.chat.trace-tool-calls=true).',
        );
      },
    };

    const logs: string[] = [];
    // limit: 0 on basics has 6 questions; FatalRunError on Q1 must abort before Q2
    const summary = await runSuite(cfg({ limit: 0 }), (m) => logs.push(m), h.deps);
    try {
      expect(runnerCalls).toBe(1);
      expect(summary.total).toBe(1);
      expect(summary.error).toBe(1);
      expect(summary.aborted).toBe(true);
      expect(summary.abortReason).toContain('APP_CHAT_TRACE_TOOL_CALLS=true');
      expect(logs.some((l) => l.includes('[ABORT]') && l.includes('APP_CHAT_TRACE_TOOL_CALLS=true'))).toBe(true);
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });
});

describe('runSuite — production WebAnswerRunner wiring', () => {
  function makeWebEvalDir(categories: Record<string, Record<string, { playbook?: string | null }>>): string {
    const dir = mkdtempSync(join(os.tmpdir(), 'yvoke-web-wiring-'));
    const specsYaml: Record<string, unknown> = {};
    for (const [cat, questions] of Object.entries(categories)) {
      specsYaml[cat] = {};
      let md = `# ${cat}\n\n`;
      for (const [qid, qspec] of Object.entries(questions)) {
        (specsYaml[cat] as Record<string, unknown>)[qid] = {
          ...(qspec.playbook !== undefined ? { playbook: qspec.playbook } : {}),
        };
        md += `## ${qid} — Question ${qid}\n\nQuestion text for ${cat}.${qid}\n\n`;
      }
      writeFileSync(join(dir, `eval_${cat}.md`), md);
    }
    writeFileSync(join(dir, 'eval_specs.yaml'), JSON.stringify(specsYaml));
    return dir;
  }

  interface FakeWebServerOpts {
    webPlaybooks?: string[];
    buildVersionSpan?: string;
    appVersionHeader?: string;
    onSendAsync?: (convId: string, qIndex: number) => Promise<Response> | Response;
    onStatus?: (convId: string, msgId: string, qIndex: number) => Promise<Response> | Response;
    onTrace?: (convId: string, msgId: string, qIndex: number) => Promise<Response> | Response;
    stopDelayMs?: number;
    deleteDelayMs?: number;
    events?: string[];
  }

  function createFakeWebAndPromptFetch(opts: FakeWebServerOpts = {}) {
    const playbooks = opts.webPlaybooks ?? ['oim-coding', 'oim-full', 'demo-basics'];
    const events = opts.events ?? [];
    const sentPrompts: Array<{ convId: string; promptName: string; content: string }> = [];
    const stoppedConvs = new Set<string>();
    let convCounter = 0;
    const convToQIndex = new Map<string, number>();
    let questionConvCount = 0;

    const withVersion = (headers: Record<string, string> = {}) =>
      opts.appVersionHeader ? { ...headers, 'X-App-Version': opts.appVersionHeader } : headers;
    const versionSpanHtml = opts.buildVersionSpan
      ? `<span class="build-version"\n  title="${opts.buildVersionSpan}">${opts.buildVersionSpan}</span>`
      : '';

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      // SystemPromptClient REST endpoint:
      if (url.includes('/api/chat/v1/prompts/system/')) {
        return new Response(JSON.stringify({ systemPrompt: 'WEB BASE SYSTEM PROMPT' }), { status: 200 });
      }

      if (url.endsWith('/login') && method === 'GET') {
        // /login never exposes build-version span in real yvoke-web:
        return new Response(
          '<html><body><form><input name="username"><input name="password"><input name="_csrf" value="csrf-login"></form></body></html>',
          {
            status: 200,
            headers: { 'Set-Cookie': 'JSESSIONID=pre-auth; Path=/' },
          },
        );
      }

      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/chat',
            'Set-Cookie': 'JSESSIONID=post-auth; Path=/',
          },
        });
      }

      if (url.endsWith('/chat') && method === 'GET') {
        return new Response(
          `<html><head><meta name="_csrf" content="csrf-chat"><meta name="_csrf_header" content="X-CSRF-TOKEN"></head><body>Chat ${versionSpanHtml}</body></html>`,
          { status: 200, headers: withVersion() },
        );
      }

      if (url.endsWith('/chat/new') && method === 'POST') {
        convCounter++;
        const convId = `conv-${convCounter}`;
        // conv-1 is always preflight; conv-2+ are per-question runs
        if (convCounter >= 2) {
          questionConvCount++;
          convToQIndex.set(convId, questionConvCount);
          events.push(`q${questionConvCount}:create:${convId}`);
        } else {
          events.push(`preflight:create:${convId}`);
        }
        return new Response(null, {
          status: 302,
          headers: withVersion({ Location: `/chat/${convId}` }),
        });
      }

      // Preflight GET /chat/conv-1
      const threadMatch = /\/chat\/(conv-\d+)$/.exec(url);
      if (threadMatch && method === 'GET') {
        const promptsJson = JSON.stringify(playbooks.map((name) => ({ name })));
        return new Response(
          `<html><head><meta name="_csrf" content="csrf-thread"></head><body>${versionSpanHtml}<script>window.CHAT_CONFIG = { prompts: ${promptsJson} };</script></body></html>`,
          { status: 200, headers: withVersion() },
        );
      }

      // Preflight trace probe:
      if (url.includes('/messages/00000000-0000-0000-0000-000000000000/trace')) {
        return new Response(null, { status: 404, headers: withVersion() });
      }

      if ((url.endsWith('/model') || url.endsWith('/thinking-level')) && method === 'POST') {
        return new Response(null, { status: 200, headers: withVersion() });
      }

      const sendMatch = /\/chat\/(conv-\d+)\/send-async$/.exec(url);
      if (sendMatch && method === 'POST') {
        const convId = sendMatch[1]!;
        const qIdx = convToQIndex.get(convId) ?? 1;
        const params = new URLSearchParams(String(init?.body ?? ''));
        sentPrompts.push({
          convId,
          promptName: params.get('promptName') ?? '',
          content: params.get('content') ?? '',
        });
        if (opts.onSendAsync) {
          return await opts.onSendAsync(convId, qIdx);
        }
        return new Response(JSON.stringify({ assistantMessageId: `msg-q${qIdx}` }), {
          status: 202,
          headers: withVersion(),
        });
      }

      const statusMatch = /\/chat\/(conv-\d+)\/messages\/([^/]+)\/status$/.exec(url);
      if (statusMatch && method === 'GET') {
        const convId = statusMatch[1]!;
        const msgId = statusMatch[2]!;
        const qIdx = convToQIndex.get(convId) ?? 1;
        if (opts.onStatus) {
          return await opts.onStatus(convId, msgId, qIdx);
        }
        return new Response(JSON.stringify({ status: 'done' }), { status: 200, headers: withVersion() });
      }

      const traceMatch = /\/chat\/(conv-\d+)\/messages\/([^/]+)\/trace$/.exec(url);
      if (traceMatch && method === 'GET') {
        const convId = traceMatch[1]!;
        const msgId = traceMatch[2]!;
        const qIdx = convToQIndex.get(convId) ?? 1;
        if (opts.onTrace) {
          return await opts.onTrace(convId, msgId, qIdx);
        }
        return new Response(
          JSON.stringify({
            mode: 'single',
            conversationId: convId,
            messageId: msgId,
            status: 'done',
            content: `Web answer for Q${qIdx}`,
            model: 'gemini-3.8-flash-001',
            playbook: qIdx === 1 ? 'oim-coding' : 'oim-full',
            playbookVersion: qIdx === 1 ? null : 5,
            tokens: { prompt: 100, completion: 40, total: 140 },
            retrievedChunkIds: [],
            toolCalls: [],
          }),
          { status: 200, headers: withVersion() },
        );
      }

      const stopMatch = /\/chat\/(conv-\d+)\/stop$/.exec(url);
      if (stopMatch && method === 'POST') {
        const convId = stopMatch[1]!;
        const qIdx = convToQIndex.get(convId);
        const tag = qIdx ? `q${qIdx}` : 'preflight';
        stoppedConvs.add(convId);
        events.push(`${tag}:stop:start:${convId}`);
        if (opts.stopDelayMs && qIdx !== undefined) {
          await new Promise((r) => setTimeout(r, opts.stopDelayMs));
        }
        events.push(`${tag}:stop:done:${convId}`);
        return new Response(null, { status: 200, headers: withVersion() });
      }

      const deleteMatch = /\/chat\/(conv-\d+)\/delete$/.exec(url);
      if (deleteMatch && method === 'POST') {
        const convId = deleteMatch[1]!;
        const qIdx = convToQIndex.get(convId);
        const tag = qIdx ? `q${qIdx}` : 'preflight';
        events.push(`${tag}:delete:start:${convId}`);
        if (opts.deleteDelayMs && stoppedConvs.has(convId)) {
          await new Promise((r) => setTimeout(r, opts.deleteDelayMs));
        }
        events.push(`${tag}:delete:done:${convId}`);
        return new Response(null, {
          status: 302,
          headers: withVersion({ Location: '/chat' }),
        });
      }

      return new Response(`Unhandled fake URL: ${method} ${url}`, { status: 404 });
    }) as unknown as typeof fetch;

    return { fetchFn, events, sentPrompts };
  }

  it('(a) runs full preflight + 2-question sweep (explicit playbook + defaultPlaybook), records correlation IDs & web provenance, and prevents MCP playbookVersion leakage (incl. cross-origin)', async () => {
    const evalDir = makeWebEvalDir({
      cat_explicit: { Q1: { playbook: 'oim-coding' } },
      cat_default: { Q1: { playbook: null } },
    });
    const evalDirCrossWithVer = makeWebEvalDir({
      cat_explicit: { Q1: { playbook: 'oim-coding' } },
    });
    const evalDirCrossNoVer = makeWebEvalDir({
      cat_explicit: { Q1: { playbook: 'oim-coding' } },
    });

    const prompts: PromptSource = {
      list: async () => [
        // MCP reports versions 99 and 88 — neither may leak into web run_meta!
        { name: 'oim-coding', title: 'Coding', description: '', tools: ['search_corpus'], version: 99 },
        { name: 'oim-full', title: 'Full', description: '', tools: ['search_corpus'], version: 88 },
      ],
      getText: async () => 'PLAYBOOK BODY',
      serverVersion: () => ({ name: 'yvoke-mcp', version: '1.5.0-mcp' }),
      close: async () => {},
    };

    const sameOriginServer = createFakeWebAndPromptFetch({ buildVersionSpan: '2.3.0-web' });
    const crossOriginWithVerServer = createFakeWebAndPromptFetch({ buildVersionSpan: '2.4.0-staging' });
    const crossOriginNoVerServer = createFakeWebAndPromptFetch(); // no buildVersionSpan -> gitSha must be 'nogit' on cross-origin!

    const summarySame = await runSuite(
      cfg({
        evalDir,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['cat_explicit', 'cat_default'],
        limit: 0,
        merge: false,
        mcp: { serverBaseUrl: 'http://localhost:8080/mcp', bearer: 'tok', transport: 'http' },
        web: {
          baseUrl: 'http://localhost:8080',
          defaultPlaybook: 'oim-full',
          pollIntervalMs: 5,
          keepConversations: false,
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: sameOriginServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: passJudge,
      },
    );

    const summaryCrossWithVer = await runSuite(
      cfg({
        evalDir: evalDirCrossWithVer,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['cat_explicit'],
        limit: 0,
        merge: true,
        mcp: { serverBaseUrl: 'http://localhost:8080/mcp', bearer: 'tok', transport: 'http' },
        web: {
          baseUrl: 'http://localhost:9090',
          defaultPlaybook: 'oim-full',
          pollIntervalMs: 5,
          keepConversations: false,
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: crossOriginWithVerServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: passJudge,
      },
    );

    const summaryCross = await runSuite(
      cfg({
        evalDir: evalDirCrossNoVer,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['cat_explicit'],
        limit: 0,
        merge: true,
        mcp: { serverBaseUrl: 'http://localhost:8080/mcp', bearer: 'tok', transport: 'http' },
        web: {
          baseUrl: 'http://localhost:9090',
          defaultPlaybook: 'oim-full',
          pollIntervalMs: 5,
          keepConversations: false,
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: crossOriginNoVerServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: passJudge,
      },
    );

    try {
      expect(summarySame.pass).toBe(2);
      expect(summarySame.aborted).toBe(false);

      const expDir = summarySame.runDirs.find((d) => d.endsWith('__cat_explicit'))!;
      const defDir = summarySame.runDirs.find((d) => d.endsWith('__cat_default'))!;

      const expResults = JSON.parse(readFileSync(join(expDir, 'results.json'), 'utf8'));
      const defResults = JSON.parse(readFileSync(join(defDir, 'results.json'), 'utf8'));
      expect(expResults[0].webConversationId).toBe('conv-2');
      expect(expResults[0].webMessageId).toBe('msg-q1');
      expect(defResults[0].webConversationId).toBe('conv-3');
      expect(defResults[0].webMessageId).toBe('msg-q2');

      const expMeta = JSON.parse(readFileSync(join(expDir, 'run_meta.json'), 'utf8'));
      const defMeta = JSON.parse(readFileSync(join(defDir, 'run_meta.json'), 'utf8'));
      const expSummaryMd = readFileSync(join(expDir, 'summary.md'), 'utf8');

      // Q1 trace had playbookVersion: null -> MCP version 99 MUST NOT leak!
      expect(expMeta.playbookVersion).toBeNull();
      // Q2 trace had playbookVersion: 5 -> overrides/ignores MCP version 88!
      expect(defMeta.playbookVersion).toBe(5);

      // (1) Same-origin with buildVersionSpan: '2.3.0-web':
      expect(expMeta.webBaseUrl).toBe('http://localhost:8080');
      expect(expMeta.webServerVersion).toBe('2.3.0-web');
      expect(expMeta.gitSha).toBe('2.3.0-web');
      expect(expMeta.mcpServerBaseUrl).toBe('http://localhost:8080/mcp');
      expect(expMeta.promptMetadataSource).toBe('mcp');
      expect(expMeta.mcpGitSha).toBeUndefined();
      expect(expSummaryMd).toContain('- web server version: `2.3.0-web`');
      expect(expSummaryMd).not.toContain('- mcp git:');

      // (2) Cross-origin WITH buildVersionSpan: '2.4.0-staging':
      const crossVerMeta = JSON.parse(readFileSync(join(summaryCrossWithVer.runDirs[0]!, 'run_meta.json'), 'utf8'));
      const crossVerSummaryMd = readFileSync(join(summaryCrossWithVer.runDirs[0]!, 'summary.md'), 'utf8');
      expect(crossVerMeta.webBaseUrl).toBe('http://localhost:9090');
      expect(crossVerMeta.webServerVersion).toBe('2.4.0-staging');
      expect(crossVerMeta.gitSha).toBe('2.4.0-staging');
      expect(crossVerMeta.promptMetadataSource).toBe('mcp-cross-origin');
      expect(crossVerMeta.mcpGitSha).toBe('1.5.0-mcp');
      expect(crossVerSummaryMd).toContain('- web server version: `2.4.0-staging`');
      expect(crossVerSummaryMd).toContain('- mcp git: `1.5.0-mcp`');

      // (3) Cross-origin WITHOUT buildVersionSpan:
      const crossMeta = JSON.parse(readFileSync(join(summaryCross.runDirs[0]!, 'run_meta.json'), 'utf8'));
      const crossSummaryMd = readFileSync(join(summaryCross.runDirs[0]!, 'summary.md'), 'utf8');
      expect(crossMeta.webBaseUrl).toBe('http://localhost:9090');
      expect(crossMeta.webServerVersion).toBeNull();
      expect(crossMeta.promptMetadataSource).toBe('mcp-cross-origin');
      expect(crossMeta.mcpGitSha).toBe('1.5.0-mcp');
      expect(crossMeta.gitSha).toBe('nogit');
      expect(crossSummaryMd).not.toContain('- web server version:');
      expect(crossSummaryMd).toContain('- mcp git: `1.5.0-mcp`');
    } finally {
      summarySame.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      summaryCrossWithVer.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      summaryCross.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
      rmSync(evalDirCrossWithVer, { recursive: true, force: true });
      rmSync(evalDirCrossNoVer, { recursive: true, force: true });
    }
  });

  it('(b) records Q1 as ERROR (with webConversationId) on WebCapacityError 429 exhaustion and continues to Q2, while Judge 429 and upstream provider quota errors still abort sweep', async () => {
    const evalDirWeb = makeWebEvalDir({
      basics: {
        Q1: { playbook: 'demo-basics' },
        Q2: { playbook: 'demo-basics' },
      },
    });
    const evalDirJudge = makeWebEvalDir({
      basics: {
        Q1: { playbook: 'demo-basics' },
        Q2: { playbook: 'demo-basics' },
      },
    });
    const evalDirUpstreamQuota = makeWebEvalDir({
      basics: {
        Q1: { playbook: 'demo-basics' },
        Q2: { playbook: 'demo-basics' },
      },
    });
    const prompts: PromptSource = {
      list: async () => [{ name: 'demo-basics', title: 'Basics', description: '', tools: ['search_corpus'], version: 1 }],
      getText: async () => 'PLAYBOOK',
      serverVersion: () => ({ name: 'yvoke', version: '1.0.0' }),
      close: async () => {},
    };

    let q1SendAttempts = 0;
    const capacityServer = createFakeWebAndPromptFetch({
      onSendAsync: (_convId, qIdx) => {
        if (qIdx === 1) {
          q1SendAttempts++;
          return new Response('Busy', { status: 429 });
        }
        return new Response(JSON.stringify({ assistantMessageId: `msg-q${qIdx}` }), { status: 202 });
      },
    });

    const summaryWeb429 = await runSuite(
      cfg({
        evalDir: evalDirWeb,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['basics'],
        limit: 0,
        merge: true,
        web: {
          baseUrl: 'http://localhost:8080',
          defaultPlaybook: null,
          pollIntervalMs: 5,
          keepConversations: false,
          retryDelaysMs: [1, 1],
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: capacityServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: passJudge,
      },
    );

    // Contrast 1: Judge 429 on Q1 must still abort the sweep before Q2!
    const okServer = createFakeWebAndPromptFetch();
    let judgeCalls = 0;
    const quotaJudge: Judge = {
      async review() {
        judgeCalls++;
        return {
          verdict: 'ERROR',
          dimensions: {},
          reasoning: '429 Too Many Requests: Claude judge rate limit reached',
          evidence: [],
        };
      },
    };

    const summaryJudge429 = await runSuite(
      cfg({
        evalDir: evalDirJudge,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['basics'],
        limit: 0,
        merge: true,
        web: {
          baseUrl: 'http://localhost:8080',
          defaultPlaybook: null,
          pollIntervalMs: 5,
          keepConversations: false,
          retryDelaysMs: [1, 1],
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: okServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: quotaJudge,
      },
    );

    // Contrast 2: Upstream LLM quota error reported in /status must also still abort the sweep!
    const upstreamQuotaServer = createFakeWebAndPromptFetch({
      onStatus: () =>
        new Response(
          JSON.stringify({ status: 'error', message: { content: 'Upstream LLM quota exceeded (429)' } }),
          { status: 200 },
        ),
    });

    const summaryUpstreamQuota = await runSuite(
      cfg({
        evalDir: evalDirUpstreamQuota,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['basics'],
        limit: 0,
        merge: true,
        web: {
          baseUrl: 'http://localhost:8080',
          defaultPlaybook: null,
          pollIntervalMs: 5,
          keepConversations: false,
          retryDelaysMs: [1, 1],
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: upstreamQuotaServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: passJudge,
      },
    );

    try {
      expect(q1SendAttempts).toBe(3);
      expect(summaryWeb429.aborted).toBe(false);
      expect(summaryWeb429.total).toBe(2);
      expect(summaryWeb429.error).toBe(1);
      expect(summaryWeb429.pass).toBe(1);

      const results = JSON.parse(readFileSync(join(summaryWeb429.runDirs[0]!, 'results.json'), 'utf8'));
      expect(results[0].verdict.verdict).toBe('ERROR');
      expect(results[0].error).toContain('HTTP 429 Too Many Requests');
      expect(results[0].webConversationId).toBe('conv-2');
      expect(results[0].webMessageId).toBeUndefined();
      expect(results[1].verdict.verdict).toBe('PASS');
      expect(results[1].webConversationId).toBe('conv-3');
      expect(results[1].webMessageId).toBe('msg-q2');

      // Judge 429 aborted immediately after Q1:
      expect(judgeCalls).toBe(1);
      expect(summaryJudge429.aborted).toBe(true);
      expect(summaryJudge429.total).toBe(1);

      // Upstream LLM quota error in /status aborted immediately after Q1:
      expect(summaryUpstreamQuota.aborted).toBe(true);
      expect(summaryUpstreamQuota.total).toBe(1);
    } finally {
      summaryWeb429.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      summaryJudge429.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      summaryUpstreamQuota.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDirWeb, { recursive: true, force: true });
      rmSync(evalDirJudge, { recursive: true, force: true });
      rmSync(evalDirUpstreamQuota, { recursive: true, force: true });
    }
  });

  it('(c) awaits Q1 async 2s /stop and 2s /delete strictly BEFORE Q2 POST /chat/new on per-question timeout under fake timers, preserving correlation IDs and exact latencyMs', async () => {
    const evalDir = makeWebEvalDir({
      basics: {
        Q1: { playbook: 'demo-basics' },
        Q2: { playbook: 'demo-basics' },
      },
    });
    const prompts: PromptSource = {
      list: async () => [{ name: 'demo-basics', title: 'Basics', description: '', tools: ['search_corpus'], version: 1 }],
      getText: async () => 'PLAYBOOK',
      serverVersion: () => ({ name: 'yvoke', version: '1.0.0' }),
      close: async () => {},
    };

    const events: string[] = [];
    const timeoutServer = createFakeWebAndPromptFetch({
      events,
      stopDelayMs: 2_000,
      deleteDelayMs: 2_000,
      onStatus: (_convId, _msgId, qIdx) => {
        if (qIdx === 1) {
          return new Response(JSON.stringify({ status: 'generating' }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'done' }), { status: 200 });
      },
    });

    let summary: Awaited<ReturnType<typeof runSuite>> | undefined;
    vi.useFakeTimers();
    try {
      const suitePromise = runSuite(
        cfg({
          evalDir,
          provider: 'web',
          answerModel: 'gemini-3.8-flash',
          categories: ['basics'],
          limit: 0,
          merge: true,
          questionTimeoutMs: 1_000,
          web: {
            baseUrl: 'http://localhost:8080',
            defaultPlaybook: null,
            pollIntervalMs: 5_000,
            keepConversations: false,
          },
        }),
        () => {},
        {
          credentials: () => 'ok',
          fetchFn: timeoutServer.fetchFn,
          prompts,
          answerRunner: undefined,
          judge: passJudge,
        },
      );
      await vi.runAllTimersAsync();
      summary = await suitePromise;

      expect(summary.aborted).toBe(false);
      expect(summary.total).toBe(2);
      expect(summary.error).toBe(1);
      expect(summary.pass).toBe(1);

      expect(events).toEqual([
        'preflight:create:conv-1',
        'preflight:delete:start:conv-1',
        'preflight:delete:done:conv-1',
        'q1:create:conv-2',
        'q1:stop:start:conv-2',
        'q1:stop:done:conv-2',
        'q1:delete:start:conv-2',
        'q1:delete:done:conv-2',
        'q2:create:conv-3',
        'q2:delete:start:conv-3',
        'q2:delete:done:conv-3',
      ]);

      const results = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'results.json'), 'utf8'));
      expect(results[0].verdict.verdict).toBe('ERROR');
      expect(results[0].webConversationId).toBe('conv-2');
      expect(results[0].webMessageId).toBe('msg-q1');
      expect(results[0].latencyMs).toBe(1_000);
      expect(results[1].verdict.verdict).toBe('PASS');
      expect(results[1].webConversationId).toBe('conv-3');
      expect(results[1].webMessageId).toBe('msg-q2');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      summary?.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('(d) aborts before Q2 via production WebAnswerRunner when Q1 trace has 🔧 banner + empty toolCalls (FatalRunError)', async () => {
    const evalDir = makeWebEvalDir({
      basics: {
        Q1: { playbook: 'demo-basics' },
        Q2: { playbook: 'demo-basics' },
      },
    });
    const prompts: PromptSource = {
      list: async () => [{ name: 'demo-basics', title: 'Basics', description: '', tools: ['search_corpus'], version: 1 }],
      getText: async () => 'PLAYBOOK',
      serverVersion: () => ({ name: 'yvoke', version: '1.0.0' }),
      close: async () => {},
    };

    const events: string[] = [];
    const fatalServer = createFakeWebAndPromptFetch({
      events,
      onTrace: (convId, msgId) =>
        new Response(
          JSON.stringify({
            mode: 'single',
            conversationId: convId,
            messageId: msgId,
            status: 'done',
            content: '🔧 *Calling tool:* `search_corpus`\nUntraced tool answer',
            toolCalls: [],
            retrievedChunkIds: [],
          }),
          { status: 200 },
        ),
    });

    const summary = await runSuite(
      cfg({
        evalDir,
        provider: 'web',
        answerModel: 'gemini-3.8-flash',
        categories: ['basics'],
        limit: 0,
        merge: true,
        web: {
          baseUrl: 'http://localhost:8080',
          defaultPlaybook: null,
          pollIntervalMs: 5,
          keepConversations: false,
        },
      }),
      () => {},
      {
        credentials: () => 'ok',
        fetchFn: fatalServer.fetchFn,
        prompts,
        answerRunner: undefined,
        judge: passJudge,
      },
    );

    try {
      expect(summary.aborted).toBe(true);
      expect(summary.total).toBe(1);
      expect(summary.error).toBe(1);
      expect(summary.abortReason).toContain('APP_CHAT_TRACE_TOOL_CALLS=true');
      expect(events.some((e) => e.startsWith('q2:create'))).toBe(false);

      const results = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'results.json'), 'utf8'));
      expect(results[0].webConversationId).toBe('conv-2');
      expect(results[0].webMessageId).toBe('msg-q1');
    } finally {
      summary.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });

  it('(e) prevents late buildEvalTask resolution after Q1 timeout from calling POST /chat/new, recording unused prompt metadata, or racing Q2 cleanup before Q3', async () => {
    const evalDir = makeWebEvalDir({
      basics: {
        Q1: { playbook: 'pb-q1-late' },
        Q2: { playbook: 'demo-basics' },
        Q3: { playbook: 'demo-basics' },
      },
    });

    const events: string[] = [];
    let q2WasMidFlightWhenQ1PromptResolved = false;

    const prompts: PromptSource = {
      list: async () => [
        {
          name: 'pb-q1-late',
          title: 'Late Q1',
          description: '',
          tools: ['search_corpus'],
          systemPrompt: 'prompt-q1-unused',
          version: 77,
        },
        {
          name: 'demo-basics',
          title: 'Basics',
          description: '',
          tools: ['search_corpus'],
          version: 1,
        },
      ],
      getText: async (name) => {
        if (name === 'pb-q1-late') {
          // Resolves at t = 1,500ms: 500ms AFTER Q1's 1,000ms timeout, while Q2 is mid-flight!
          await new Promise((r) => setTimeout(r, 1_500));
          q2WasMidFlightWhenQ1PromptResolved =
            events.includes('q1:create:conv-2') && !events.includes('q1:stop:start:conv-2');
          return 'LATE Q1 PLAYBOOK';
        }
        return 'DEMO BASICS PLAYBOOK';
      },
      serverVersion: () => ({ name: 'yvoke', version: '1.0.0' }),
      close: async () => {},
    };

    const server = createFakeWebAndPromptFetch({
      webPlaybooks: ['pb-q1-late', 'demo-basics'],
      events,
      stopDelayMs: 2_000,
      deleteDelayMs: 2_000,
      onStatus: (convId) => {
        // conv-2 is Q2 (since Q1 never created a conversation): keep generating until Q2 times out!
        if (convId === 'conv-2') {
          return new Response(JSON.stringify({ status: 'generating' }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'done' }), { status: 200 });
      },
    });

    let summary: Awaited<ReturnType<typeof runSuite>> | undefined;
    vi.useFakeTimers();
    try {
      const suitePromise = runSuite(
        cfg({
          evalDir,
          provider: 'web',
          answerModel: 'gemini-3.8-flash',
          categories: ['basics'],
          limit: 0,
          merge: true,
          questionTimeoutMs: 1_000,
          web: {
            baseUrl: 'http://localhost:8080',
            defaultPlaybook: null,
            pollIntervalMs: 5_000,
            keepConversations: false,
          },
        }),
        () => {},
        {
          credentials: () => 'ok',
          fetchFn: server.fetchFn,
          prompts,
          answerRunner: undefined,
          judge: passJudge,
        },
      );
      await vi.runAllTimersAsync();
      summary = await suitePromise;

      expect(q2WasMidFlightWhenQ1PromptResolved).toBe(true);
      expect(summary.aborted).toBe(false);
      expect(summary.total).toBe(3);
      expect(summary.error).toBe(2);
      expect(summary.pass).toBe(1);

      // Q1 never called POST /chat/new or /send-async: only Q2 (conv-2) and Q3 (conv-3) sent prompts!
      expect(server.sentPrompts.map((s) => s.promptName)).toEqual(['demo-basics', 'demo-basics']);
      expect(server.sentPrompts[0]?.content).toBe('Question Q2');
      expect(server.sentPrompts[1]?.content).toBe('Question Q3');

      // Q2 (conv-2) /stop + /delete strictly finished before Q3 (conv-3) POST /chat/new:
      expect(events).toEqual([
        'preflight:create:conv-1',
        'preflight:delete:start:conv-1',
        'preflight:delete:done:conv-1',
        'q1:create:conv-2',
        'q1:stop:start:conv-2',
        'q1:stop:done:conv-2',
        'q1:delete:start:conv-2',
        'q1:delete:done:conv-2',
        'q2:create:conv-3',
        'q2:delete:start:conv-3',
        'q2:delete:done:conv-3',
      ]);

      // Q1's late buildEvalTask did NOT record unused 'pb-q1-late' / 'prompt-q1-unused' prompt metadata:
      const meta = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'run_meta.json'), 'utf8'));
      expect(meta.playbookPrompts).toBeNull();
      expect(meta.systemPromptName).toBe('default-chat');

      const results = JSON.parse(readFileSync(join(summary.runDirs[0]!, 'results.json'), 'utf8'));
      expect(results).toHaveLength(3);
      expect(results[0].question.id).toBe('Q1');
      expect(results[0].verdict.verdict).toBe('ERROR');
      expect(results[0].webConversationId).toBeUndefined();
      expect(results[1].question.id).toBe('Q2');
      expect(results[1].verdict.verdict).toBe('ERROR');
      expect(results[1].webConversationId).toBe('conv-2');
      expect(results[1].latencyMs).toBe(1_000);
      expect(results[2].question.id).toBe('Q3');
      expect(results[2].verdict.verdict).toBe('PASS');
      expect(results[2].webConversationId).toBe('conv-3');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      summary?.runDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
      rmSync(evalDir, { recursive: true, force: true });
    }
  });
});
