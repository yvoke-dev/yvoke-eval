import { describe, it, expect, vi } from 'vitest';
import { toRunConfig, normalizeModelName, parseCliArgs, cmdRun } from '../src/cli';
import type { EvalConfig } from '../src/config/loadConfig';
import type { RunSummary } from '../src/run/runSuite';


/** A config with everything toRunConfig needs, so each test can remove exactly one thing. */
function cfg(overrides: Record<string, unknown> = {}): EvalConfig {
  return {
    evalDir: './eval',
    run: { mode: 'single', categories: [], limit: 0, merge: false },
    answer: { model: 'sonnet', thinkingLevel: 'high' },
    mcp: { serverBaseUrl: 'http://localhost:8080', transport: 'http', bearer: 'token' },
    mas: {
      profile: 'demo',
      profiles: { demo: { orchestrator: 'o', reviewer: 'r', specialists: ['s'] } },
    },
    reviewer: {
      provider: 'claude',
      model: 'opus',
      temperature: 0,
      promptFile: './graders/reviewer.md',
      orchestrationPromptFile: './graders/orchestration-reviewer.md',
    },
    ...overrides,
  } as EvalConfig;
}

/** Stand-in for "the directory holding the config file" — deliberately not this repo. */
const CONTENT = '/somewhere/else/my-kb';

describe('toRunConfig — content paths resolve against the config directory', () => {
  // The whole point of the extraction: eval content lives beside its config, NOT beside the harness.
  // Assert absolute paths — a suffix match like /reviewer\.md$/ passes under either root and so
  // silently tolerates a regression to harness-relative resolution.
  it('roots every relative content path at contentRoot', () => {
    const rc = toRunConfig(cfg(), {}, CONTENT);
    expect(rc.evalDir).toBe(`${CONTENT}/eval`);
    expect(rc.graderPath).toBe(`${CONTENT}/graders/reviewer.md`);
  });

  it('roots the orchestration rubric at contentRoot too', () => {
    const rc = toRunConfig(cfg(), { eval: 'orchestration' }, CONTENT);
    expect(rc.orchestrationGraderPath).toBe(`${CONTENT}/graders/orchestration-reviewer.md`);
  });

  it('follows contentRoot rather than any fixed root', () => {
    const a = toRunConfig(cfg(), {}, '/root/a');
    const b = toRunConfig(cfg(), {}, '/root/b');
    expect(a.evalDir).toBe('/root/a/eval');
    expect(b.evalDir).toBe('/root/b/eval');
  });

  it('leaves absolute config paths untouched', () => {
    const rc = toRunConfig(cfg({ evalDir: '/abs/eval' }), {}, CONTENT);
    expect(rc.evalDir).toBe('/abs/eval');
  });
});

describe('toRunConfig — grader rubrics are required, never defaulted', () => {
  it('throws when reviewer.promptFile is absent, naming the key', () => {
    const c = cfg({ reviewer: { provider: 'claude', model: 'opus', temperature: 0 } });
    expect(() => toRunConfig(c, {}, CONTENT)).toThrow(/Missing reviewer\.promptFile/);
  });

  it('does not require orchestrationPromptFile for a specialist run', () => {
    const c = cfg({
      reviewer: { provider: 'claude', model: 'opus', temperature: 0, promptFile: './graders/reviewer.md' },
    });
    const rc = toRunConfig(c, {}, CONTENT);
    expect(rc.graderPath).toBe(`${CONTENT}/graders/reviewer.md`);
    expect(rc.orchestrationGraderPath).toBeNull();
  });

  it('requires orchestrationPromptFile once the intent is orchestration', () => {
    const c = cfg({
      reviewer: { provider: 'claude', model: 'opus', temperature: 0, promptFile: './graders/reviewer.md' },
    });
    expect(() => toRunConfig(c, { eval: 'orchestration' }, CONTENT)).toThrow(
      /Missing reviewer\.orchestrationPromptFile/,
    );
  });

  it('resolves both rubrics for an orchestration run', () => {
    const rc = toRunConfig(cfg(), { eval: 'orchestration' }, CONTENT);
    expect(rc.evalIntent).toBe('orchestration');
    expect(rc.mode).toBe('mas');
    expect(rc.orchestrationGraderPath).toBe(`${CONTENT}/graders/orchestration-reviewer.md`);
  });

  it('allows overriding thinkingLevel via CLI values', () => {
    const rc = toRunConfig(cfg(), { thinking: 'high' }, CONTENT);
    expect(rc.thinkingLevel).toBe('high');
  });

  it('rejects invalid thinking level values', () => {
    expect(() => toRunConfig(cfg(), { thinking: 'invalid-level' }, CONTENT)).toThrow(
      /Invalid thinking level "invalid-level"/,
    );
  });

  it('normalizes shorthand model names like haiku-5.5 to claude-haiku-5-5', () => {
    const rc = toRunConfig(cfg(), { 'answer-model': 'haiku-5.5', 'reviewer-model': 'sonnet-5.5' }, CONTENT);
    expect(rc.answerModel).toBe('claude-haiku-5-5');
    expect(rc.reviewerModel).toBe('claude-sonnet-5-5');
  });
});

describe('normalizeModelName', () => {
  it('normalizes 5.5 shorthand variants', () => {
    expect(normalizeModelName('haiku-5.5')).toBe('claude-haiku-5-5');
    expect(normalizeModelName('haiku 5.5')).toBe('claude-haiku-5-5');
    expect(normalizeModelName('haiku-5-5')).toBe('claude-haiku-5-5');
    expect(normalizeModelName('claude-haiku-5-5')).toBe('claude-haiku-5-5');

    expect(normalizeModelName('sonnet-5.5')).toBe('claude-sonnet-5-5');
    expect(normalizeModelName('sonnet 5.5')).toBe('claude-sonnet-5-5');
    expect(normalizeModelName('opus-5.5')).toBe('claude-opus-5-5');
  });

  it('canonicalizes bare aliases to claude-*-5-5 matching desktop resolveCanonicalModel', () => {
    expect(normalizeModelName('haiku')).toBe('claude-haiku-5-5');
    expect(normalizeModelName('sonnet')).toBe('claude-sonnet-5-5');
    expect(normalizeModelName('opus')).toBe('claude-opus-5-5');
    expect(normalizeModelName('claude-haiku')).toBe('claude-haiku-5-5');
    expect(normalizeModelName('claude-sonnet')).toBe('claude-sonnet-5-5');
    expect(normalizeModelName('claude-opus')).toBe('claude-opus-5-5');
  });

  it('leaves custom or fully-specified model IDs untouched', () => {
    expect(normalizeModelName('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
    expect(normalizeModelName('gpt-4o')).toBe('gpt-4o');
  });
});

describe('parseCliArgs', () => {
  it('parses --gate-critical flag in compare/run invocations', () => {
    const { values: compareValues } = parseCliArgs(['compare', 'run1', '--gate-critical']);
    expect(compareValues['gate-critical']).toBe(true);

    const { values: runValues } = parseCliArgs(['run', '--gate-critical']);
    expect(runValues['gate-critical']).toBe(true);
  });
});

describe('cmdRun — exit code behavior', () => {
  it('exits with code 1 when summary contains ERROR rows', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const mockSummary: RunSummary = {
      runDirs: ['/path/to/run'],
      total: 2,
      pass: 1,
      partial: 0,
      fail: 0,
      error: 1,
    };
    await cmdRun(cfg(), {}, CONTENT, async () => mockSummary);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with code 1 when summary was aborted', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const mockSummary: RunSummary = {
      runDirs: ['/path/to/run'],
      total: 2,
      pass: 1,
      partial: 0,
      fail: 0,
      error: 0,
      aborted: true,
      abortReason: 'quota limit',
    };
    await cmdRun(cfg(), {}, CONTENT, async () => mockSummary);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('does not exit with error when summary has only PASS, PARTIAL, or FAIL', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const mockSummary: RunSummary = {
      runDirs: ['/path/to/run'],
      total: 3,
      pass: 1,
      partial: 1,
      fail: 1,
      error: 0,
    };
    await cmdRun(cfg(), {}, CONTENT, async () => mockSummary);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});


