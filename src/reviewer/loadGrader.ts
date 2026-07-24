import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface Grader {
  /** The grader system prompt (frontmatter stripped). */
  prompt: string;
  /** Short checksum of the raw file, recorded in run_meta as graderPromptSha for attributability. */
  sha: string;
}

/** Load the in-repo grader rubric, stripping any leading YAML frontmatter block(s). */
export function loadGrader(path: string): Grader {
  const raw = readFileSync(path, 'utf8');
  const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return { prompt: stripFrontmatter(raw).trim(), sha };
}

/** Remove one or more leading `---\n…\n---` frontmatter blocks (the export has two). */
export function stripFrontmatter(text: string): string {
  let t = text.replace(/^﻿/, '');
  const fm = /^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;
  while (fm.test(t)) {
    t = t.replace(fm, '');
  }
  return t;
}
