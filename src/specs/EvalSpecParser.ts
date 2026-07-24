import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EvalQuestion } from '../types';

/**
 * Reads the human-authored eval_<category>.md suites (question text + prose "Expected") and merges
 * each question's machine-readable spec from eval_specs.yaml (keyed category → question id) into
 * EvalQuestions. The markdown stays the single source of question text; the yaml carries the
 * gradeable assertions. Ported verbatim from de.palsoftware.yvoke.eval.EvalSpecParser.
 */
const PLAYBOOK = /\*\*Playbook:\*\*\s*`skills\/([a-z0-9-]+)\.md`/;
// "## Q3 — What database tables back attestation? *(composition)*"
const QUESTION = /^##\s+(Q\d+)\s+[—-]\s+(.*)$/;
const ANNOTATION = /\s*\*\(.*\)\*\s*$/;

type Spec = Record<string, unknown>;

export class EvalSpecParser {
  constructor(
    private readonly evalDir: string,
    /** When provided (orchestration eval), every expected_specialists entry is validated against this
     *  list and an unknown name throws at parse time — a typo can't silently score routing false. */
    private readonly knownSpecialists?: string[],
  ) {}

  parse(): EvalQuestion[] {
    const specsPath = join(this.evalDir, 'eval_specs.yaml');
    let specs: Record<string, Spec> = {};
    if (isFile(specsPath)) {
      const loaded = parseYaml(readFileSync(specsPath, 'utf8')) as unknown;
      if (loaded && typeof loaded === 'object') {
        specs = loaded as Record<string, Spec>;
      }
    }

    // Iterate the categories that have a spec entry (controls which suites run); fall back to
    // discovering eval_*.md files when no specs are present.
    const categories = Object.keys(specs).length > 0 ? Object.keys(specs) : this.discoverCategories();

    const out: EvalQuestion[] = [];
    for (const category of categories) {
      const md = join(this.evalDir, `eval_${category}.md`);
      if (!isFile(md)) continue;
      const catSpecs = isObject(specs[category]) ? (specs[category] as Record<string, Spec>) : {};
      out.push(...this.parseCategory(category, md, catSpecs));
    }
    return out;
  }

  private discoverCategories(): string[] {
    // eval_db_history.md used to be excluded here: it predated eval_specs.yaml and was a
    // hand-written record of stored chat runs rather than a runnable suite. It was rewritten
    // against the live corpus on 2026-07-26 and now has a spec entry, so the exclusion is gone.
    return readdirSync(this.evalDir)
      .filter((n) => n.startsWith('eval_') && n.endsWith('.md'))
      .map((n) => n.slice('eval_'.length, n.length - '.md'.length))
      .sort();
  }

  private parseCategory(category: string, md: string, catSpecs: Record<string, Spec>): EvalQuestion[] {
    const lines = readFileSync(md, 'utf8').split(/\r?\n/);

    let playbook: string | null = null;
    for (const line of lines) {
      const m = PLAYBOOK.exec(line);
      if (m) {
        playbook = m[1];
        break;
      }
    }

    const qs: EvalQuestion[] = [];
    for (const line of lines) {
      const qm = QUESTION.exec(line);
      if (!qm) continue;
      const id = qm[1];
      const question = qm[2].trim().replace(ANNOTATION, '').trim();
      const s: Spec = isObject(catSpecs[id]) ? (catSpecs[id] as Spec) : {};
      if (bool(s, 'skip', false)) continue; // meta/non-runnable question (e.g. a grader-only note)

      const q: EvalQuestion = {
        category,
        id,
        question,
        playbook: str(s, 'playbook', playbook),
        expect: str(s, 'expect', 'answer'),
        versionTag: str(s, 'version_tag', null),
        targetTopic: str(s, 'target', null),
        mustInclude: strList(s, 'must_include'),
        mustNotInclude: strList(s, 'must_not_include'),
        expectToolCalled: strList(s, 'expect_tool_called'),
        bait: str(s, 'bait', null),
        citationsRequired: bool(s, 'citations', true),
        critical: bool(s, 'critical', false),
        rubric: str(s, 'rubric', null),
      };
      // Orchestration (Mode 3) opt-in fields — added ONLY when present, so a non-opt-in question keeps
      // its exact serialized shape (results.json / baseline parity).
      const expectedSpecialists = optStrList(s, 'expected_specialists');
      if (expectedSpecialists) {
        for (const name of expectedSpecialists) {
          if (this.knownSpecialists && !this.knownSpecialists.includes(name)) {
            throw new Error(
              `${category}.${id}: expected_specialists entry "${name}" is not a known specialist. ` +
                `Use an exact name from: ${this.knownSpecialists.join(', ')}.`,
            );
          }
        }
        q.expectedSpecialists = expectedSpecialists;
      }
      const expectedDelegation = optStr(s, 'expected_delegation');
      if (expectedDelegation !== undefined) q.expectedDelegation = expectedDelegation;
      const minReviewRounds = num(s, 'min_review_rounds');
      if (minReviewRounds !== undefined) q.minReviewRounds = minReviewRounds;
      qs.push(q);
    }
    return qs;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(m: Spec, k: string, def: string): string;
function str(m: Spec, k: string, def: string | null): string | null;
function str(m: Spec, k: string, def: string | null): string | null {
  const v = m[k];
  return v !== undefined && v !== null ? String(v) : def;
}

function bool(m: Spec, k: string, def: boolean): boolean {
  const v = m[k];
  return typeof v === 'boolean' ? v : def;
}

function strList(m: Spec, k: string): string[] {
  const v = m[k];
  return Array.isArray(v) ? v.map(String) : [];
}

// Optional variants — return undefined when the key is ABSENT, so the caller can omit the field
// entirely (keeping non-opt-in questions' serialized shape unchanged).
function optStr(m: Spec, k: string): string | undefined {
  const v = m[k];
  return v !== undefined && v !== null ? String(v) : undefined;
}

function optStrList(m: Spec, k: string): string[] | undefined {
  const v = m[k];
  return Array.isArray(v) ? v.map(String) : undefined;
}

function num(m: Spec, k: string): number | undefined {
  const v = m[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
