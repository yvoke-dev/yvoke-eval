import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadGrader, stripFrontmatter } from '../src/reviewer/loadGrader';

const graderPath = fileURLToPath(new URL('./fixtures/graders/reviewer.md', import.meta.url));

describe('loadGrader', () => {
  it('loads a grader, strips frontmatter, and yields a stable sha', () => {
    const g = loadGrader(graderPath);
    expect(g.prompt.startsWith('# Eval Reviewer')).toBe(true);
    expect(g.prompt).not.toContain('name: fixture-eval-reviewer');
    expect(g.prompt).not.toContain('target_agent:');
    expect(g.prompt).toContain('routing');
    expect(g.sha).toMatch(/^[0-9a-f]{12}$/);
    expect(loadGrader(graderPath).sha).toBe(g.sha); // deterministic
  });

  it('strips multiple leading frontmatter blocks', () => {
    const body = stripFrontmatter('---\na: 1\n---\n\n---\nb: 2\n---\n\n# Title\ntext');
    expect(body.trim()).toBe('# Title\ntext');
  });

  it('leaves a file without frontmatter untouched', () => {
    expect(stripFrontmatter('# Title\ntext')).toBe('# Title\ntext');
  });
});
