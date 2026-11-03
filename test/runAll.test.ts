import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { selectCategories, parseRunAllArgs, buildCliInvocationArgs } from '../scripts/run-all';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function createMockEvalDir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'yvoke-run-all-'));
  writeFileSync(
    join(tmp, 'eval_specs.yaml'),
    `
basics:
  Q1: {}
databases:
  Q1: {}
orchestration_ie:
  Q1:
    expected_specialists: ['specialist-a']
`,
  );
  writeFileSync(join(tmp, 'eval_basics.md'), '# Basics\n\n## Q1 — Question 1\n');
  writeFileSync(join(tmp, 'eval_databases.md'), '# Databases\n\n## Q1 — Question 1\n');
  writeFileSync(join(tmp, 'eval_orchestration_ie.md'), '# Orchestration\n\n## Q1 — Question 1\n');
  return tmp;
}

describe('selectCategories', () => {
  it('strictly excludes orchestration_ie in specialist eval intent', () => {
    const dir = createMockEvalDir();
    const categories = selectCategories(dir, 'specialist');
    expect(categories).toEqual(['basics', 'databases']);
    expect(categories).not.toContain('orchestration_ie');
  });

  it('selects only orchestration categories in orchestration eval intent', () => {
    const dir = createMockEvalDir();
    const categories = selectCategories(dir, 'orchestration');
    expect(categories).toEqual(['orchestration_ie']);
    expect(categories).not.toContain('basics');
    expect(categories).not.toContain('databases');
  });

  it('respects --only filter', () => {
    const dir = createMockEvalDir();
    const categories = selectCategories(dir, 'specialist', 'databases');
    expect(categories).toEqual(['databases']);
  });

  it('throws on unknown category in --only', () => {
    const dir = createMockEvalDir();
    expect(() => selectCategories(dir, 'specialist', 'nonexistent')).toThrow(/Unknown categor/);
  });

  it('respects --from resume parameter', () => {
    const dir = createMockEvalDir();
    const categories = selectCategories(dir, 'specialist', undefined, 'databases');
    expect(categories).toEqual(['databases']);
  });
});

describe('parseRunAllArgs & buildCliInvocationArgs', () => {
  it('parses all run-all flags and forwards passthrough flags to run and promote invocations', () => {
    const { values } = parseRunAllArgs([
      '--config',
      './my-kb/yvoke-eval.yaml',
      '--suite',
      'smoke',
      '--only',
      'basics,databases',
      '--from',
      'databases',
      '--promote',
      './eval/baseline-web',
      '--continue',
      '--dry-run',
      '--provider',
      'web',
      '--web-url',
      'http://localhost:9090',
      '--answer-model',
      'gemini-3.8-flash',
      '--thinking',
      'medium',
      '--reviewer-model',
      'claude-opus-5-5',
      '--reviewer-thinking',
      'high',
      '--mode',
      'single',
      '--eval',
      'specialist',
      '--expect',
      'clarify',
      '--limit',
      '3',
    ]);

    expect(values.provider).toBe('web');
    expect(values['web-url']).toBe('http://localhost:9090');
    expect(values['answer-model']).toBe('gemini-3.8-flash');
    expect(values.thinking).toBe('medium');
    expect(values['reviewer-model']).toBe('claude-opus-5-5');
    expect(values['reviewer-thinking']).toBe('high');
    expect(values.mode).toBe('single');
    expect(values.eval).toBe('specialist');
    expect(values.expect).toBe('clarify');
    expect(values.limit).toBe('3');
    expect(values.promote).toBe('./eval/baseline-web');
    expect(values['dry-run']).toBe(true);
    expect(values.continue).toBe(true);

    const expectedConfigPath = path.resolve('./my-kb/yvoke-eval.yaml');

    const runArgs = buildCliInvocationArgs(['run', '--category', 'databases'], values);
    expect(runArgs).toEqual([
      '--config',
      expectedConfigPath,
      '--suite',
      'smoke',
      'run',
      '--category',
      'databases',
      '--provider',
      'web',
      '--web-url',
      'http://localhost:9090',
      '--answer-model',
      'gemini-3.8-flash',
      '--reviewer-model',
      'claude-opus-5-5',
      '--reviewer-thinking',
      'high',
      '--thinking',
      'medium',
      '--mode',
      'single',
      '--eval',
      'specialist',
      '--expect',
      'clarify',
      '--limit',
      '3',
      '--dry-run',
    ]);

    const promoteArgs = buildCliInvocationArgs(
      ['promote', '2026-11-03T10-00-00Z__web-gemini__sha__databases', '--baseline', './eval/baseline-web'],
      values,
    );
    expect(promoteArgs).toEqual([
      '--config',
      expectedConfigPath,
      '--suite',
      'smoke',
      'promote',
      '2026-11-03T10-00-00Z__web-gemini__sha__databases',
      '--baseline',
      './eval/baseline-web',
      '--provider',
      'web',
    ]);
  });

  it('omits optional passthrough flags when unset and supports --help', () => {
    const { values } = parseRunAllArgs(['--config', './kb/yvoke-eval.yaml', '--help']);
    expect(values.help).toBe(true);

    const minimalRunArgs = buildCliInvocationArgs(['run', '--category', 'basics'], {
      config: './kb/yvoke-eval.yaml',
    });
    expect(minimalRunArgs).toEqual(['--config', path.resolve('./kb/yvoke-eval.yaml'), 'run', '--category', 'basics']);

    const minimalPromoteArgs = buildCliInvocationArgs(['promote', 'run-id', '--baseline', './eval/baseline'], {
      config: './kb/yvoke-eval.yaml',
    });
    expect(minimalPromoteArgs).toEqual([
      '--config',
      path.resolve('./kb/yvoke-eval.yaml'),
      'promote',
      'run-id',
      '--baseline',
      './eval/baseline',
    ]);
  });
});
