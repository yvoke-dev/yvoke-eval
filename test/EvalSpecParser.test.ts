import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSpecParser } from '../src/specs/EvalSpecParser';

const evalDir = fileURLToPath(new URL('./fixtures/eval', import.meta.url));
const questions = new EvalSpecParser(evalDir).parse();

describe('EvalSpecParser', () => {
  it('parses every category that has a spec entry', () => {
    // basics Q1-Q7 minus Q6 (skip:true) = 6, plus advanced Q1-Q2 = 2.
    expect(questions.length).toBe(8);
    const cats = new Set(questions.map((q) => q.category));
    expect(cats.has('basics')).toBe(true);
    expect(cats.has('advanced')).toBe(true);
  });

  it('resolves the playbook from the markdown header', () => {
    expect(byId('basics', 'Q1').playbook).toBe('demo-basics');
    expect(byId('advanced', 'Q1').playbook).toBe('demo-advanced');
  });

  it('merges machine-readable spec fields and strips the *(annotation)*', () => {
    expect(byId('basics', 'Q1').targetTopic).toBe('Basics');
    expect(byId('basics', 'Q1').question).not.toContain('*(');
    const q3 = byId('basics', 'Q3');
    expect(q3.expect).toBe('clarify');
    expect(q3.critical).toBe(true);
    expect(byId('basics', 'Q4').bait).toBe('PhantomTool.exe');
    expect(byId('basics', 'Q2').mustInclude).toContain('WidgetRegistry');
    expect(byId('advanced', 'Q1').expectToolCalled).toContain('get_graph_neighbors');
  });

  it('honors skip:true (basics Q6 is a grader-only note)', () => {
    const ids = questions.filter((q) => q.category === 'basics').map((q) => q.id);
    expect(ids).not.toContain('Q6');
    expect(ids).toContain('Q7');
  });

  it('defaults citationsRequired true unless the spec sets citations:false', () => {
    expect(byId('basics', 'Q1').citationsRequired).toBe(true);
    expect(byId('basics', 'Q5').citationsRequired).toBe(false);
  });

  it('defaults expect=answer and leaves versionTag null', () => {
    const q1 = byId('basics', 'Q1');
    expect(q1.expect).toBe('answer');
    expect(q1.versionTag).toBeNull();
  });

  it('carries version_tag through when a spec sets one', () => {
    expect(byId('advanced', 'Q2').versionTag).toBe('2.1');
  });

  it('a non-opt-in question carries NO orchestration keys (14-key shape unchanged)', () => {
    const q1 = byId('basics', 'Q1');
    expect('expectedSpecialists' in q1).toBe(false);
    expect('expectedDelegation' in q1).toBe(false);
    expect('minReviewRounds' in q1).toBe(false);
    expect(Object.keys(q1)).toHaveLength(14);
  });

  it('parses orchestration opt-in fields when present, omits them when absent', () => {
    const qs = new EvalSpecParser(writeTempEval()).parse();
    const q1 = qs.find((q) => q.id === 'Q1')!;
    expect(q1.expectedSpecialists).toEqual(['demo-basics']);
    expect(q1.expectedDelegation).toBe('none');
    expect(q1.minReviewRounds).toBe(1);
    const q2 = qs.find((q) => q.id === 'Q2')!;
    expect('expectedSpecialists' in q2).toBe(false);
    expect('expectedDelegation' in q2).toBe(false);
    expect('minReviewRounds' in q2).toBe(false);
  });

  it('validates expected_specialists against knownSpecialists — unknown name throws loudly', () => {
    const dir = writeTempEval();
    expect(() => new EvalSpecParser(dir, ['demo-advanced']).parse()).toThrow(/not a known specialist/);
    expect(() => new EvalSpecParser(dir, ['demo-basics']).parse()).not.toThrow();
  });
});

/** Writes a minimal isolated eval dir (category "orch": Q1 opt-in, Q2 plain) to a temp path. */
function writeTempEval(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yvoke-eval-spec-'));
  writeFileSync(
    join(dir, 'eval_specs.yaml'),
    ['orch:', '  Q1:', '    expected_specialists: [demo-basics]', '    expected_delegation: none', '    min_review_rounds: 1', '  Q2: {}'].join('\n'),
  );
  writeFileSync(
    join(dir, 'eval_orch.md'),
    ['**Playbook:** `skills/demo-basics.md`', '', '## Q1 — What is a widget?', '## Q2 — Something plain'].join('\n'),
  );
  return dir;
}

function byId(category: string, id: string) {
  const q = questions.find((x) => x.category === category && x.id === id);
  if (!q) throw new Error(`missing ${category}.${id}`);
  return q;
}
