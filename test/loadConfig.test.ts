import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig, interpolate, deepMerge, resolveSuite } from '../src/config/loadConfig';

const configPath = fileURLToPath(new URL('./fixtures/yvoke-eval.yaml', import.meta.url));

describe('loadConfig', () => {
  it('loads defaults from the config file', () => {
    const cfg = loadConfig(configPath, {});
    expect(cfg.evalDir).toBe('./eval');
    expect(cfg.run.mode).toBe('single');
    expect(cfg.reviewer.provider).toBe('claude');
    expect(cfg.reviewer.promptFile).toBe('./graders/reviewer.md');
  });

  it('throws when the config file does not exist', () => {
    expect(() => loadConfig(`${configPath}.missing`, {})).toThrow(/Config not found/);
  });

  it('interpolates ${ENV} with a fallback default when unset', () => {
    const cfg = loadConfig(configPath, {});
    expect(cfg.mcp.serverBaseUrl).toBe('http://localhost:8080');
    expect(cfg.mcp.bearer).toBe('dev-local-token');
  });

  it('interpolates ${ENV} from the environment when set', () => {
    const cfg = loadConfig(configPath, { YVOKE_SERVER: 'http://host:9000', EVAL_BEARER: 'secret' });
    expect(cfg.mcp.serverBaseUrl).toBe('http://host:9000');
    expect(cfg.mcp.bearer).toBe('secret');
  });

  it('resolves a named suite as a deep-merged overlay', () => {
    const cfg = loadConfig(configPath, {});
    const smoke = resolveSuite(cfg, 'smoke');
    expect(smoke.run.limit).toBe(2);
    expect(smoke.run.mode).toBe('single'); // untouched keys survive the merge
    const mas = resolveSuite(cfg, 'mas-full');
    expect(mas.run.mode).toBe('mas');
    expect(mas.run.merge).toBe(true);
  });

  it('throws on an unknown suite', () => {
    const cfg = loadConfig(configPath, {});
    expect(() => resolveSuite(cfg, 'nope')).toThrow(/Unknown suite/);
  });

  it('interpolate/deepMerge unit behaviour', () => {
    expect(interpolate('${A:x}', { A: '' })).toBe('x'); // empty env → default
    expect(interpolate('${A}', { A: 'y' })).toBe('y');
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });
});
