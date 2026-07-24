import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../src/reviewer/jsonExtract';

describe('extractJsonObject', () => {
  it('parses bare JSON', () => {
    expect(extractJsonObject('{"verdict":"PASS"}')).toEqual({ verdict: 'PASS' });
  });

  it('parses a ```json fenced block', () => {
    const text = 'Here is the verdict:\n```json\n{"verdict":"FAIL","dimensions":{}}\n```\n';
    expect(extractJsonObject(text)).toEqual({ verdict: 'FAIL', dimensions: {} });
  });

  it('parses an object embedded in surrounding prose', () => {
    const text = 'The answer is {"verdict":"PARTIAL"} — hope that helps.';
    expect(extractJsonObject(text)).toEqual({ verdict: 'PARTIAL' });
  });

  it('throws when there is no JSON object', () => {
    expect(() => extractJsonObject('no json here')).toThrow(/no JSON object/);
  });
});
