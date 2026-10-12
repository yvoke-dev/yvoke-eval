import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectCategories } from '../scripts/run-all';

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
