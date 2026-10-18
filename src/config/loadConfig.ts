import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { UserError } from '../types';

/**
 * Config loader. Reads yvoke-eval.yaml, interpolates ${ENV} / ${ENV:default} in string values, and
 * resolves named suites (deep-merged overlays). Precedence CLI > env > file > defaults is applied by
 * the caller (CLI layer lands in P2); this module owns file + env interpolation + suite merge.
 */
export interface RoleConfig {
  model: string;
  thinkingLevel: string;
}

export interface MasConfig {
  profile?: string;
  profiles?: Record<string, { orchestrator: string; reviewer: string; specialists: string[] }>;
  roles?: { orchestrator: RoleConfig; reviewer: RoleConfig; specialist: RoleConfig };
  maxReviewRounds?: number;
  maxSpecialistCalls?: number;
  orchestratorMaxTurns?: number;
  specialistMaxTurns?: number;
}

export interface EvalConfig {
  evalDir: string;
  baselineDir?: string;
  run: { mode: string; eval?: string; categories: string[]; limit: number; merge: boolean };
  answer: { model: string; thinkingLevel: string };
  mcp: { serverBaseUrl: string; transport: string; bearer: string };
  /**
   * The deployment's web allow-list. Content-repo config, because which domains are worth searching
   * belongs to a knowledge base rather than to the harness — the same reason the client ships it in
   * settings.json rather than letting a user edit it.
   */
  web?: { allowedDomains?: string[] };
  mas?: MasConfig;
  reviewer: {
    provider: string;
    model: string;
    thinkingLevel?: string;
    temperature: number;
    promptFile: string;
    /** Orchestration eval (Mode 3) grader rubric. Required only for `run.eval: orchestration`. */
    orchestrationPromptFile?: string;
    seed?: number;
  };
  suites?: Record<string, unknown>;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

/** Recursively replace ${NAME} / ${NAME:default} inside every string in `value`. */
export function interpolate(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string, def: string | undefined) => {
      const v = env[name];
      return v !== undefined && v !== '' ? v : (def ?? '');
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, env));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, env)]),
    );
  }
  return value;
}

/** Deep-merge `overlay` onto `base` (objects merge recursively; arrays and scalars are replaced). */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return (overlay ?? base) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): EvalConfig {
  // Never fall back to an empty config: every value would then come from the caller's ?? defaults,
  // producing a plausible-looking run against content that isn't there.
  if (!existsSync(path)) throw new UserError(`Config not found: ${path}`);
  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
  return interpolate(raw ?? {}, env) as EvalConfig;
}

/** Apply a named suite overlay (from config.suites) on top of the base config. */
export function resolveSuite(config: EvalConfig, suite?: string): EvalConfig {
  if (!suite) return config;
  const overlay = config.suites?.[suite as keyof typeof config.suites];
  if (!overlay) {
    throw new UserError(`Unknown suite "${suite}". Available: ${Object.keys(config.suites ?? {}).join(', ') || 'none'}`);
  }
  return deepMerge(config, overlay);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
