import { parseArgs } from 'node:util';
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';

import os from 'node:os';
import path from 'node:path';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveSuite, type EvalConfig } from './config/loadConfig';
import { runSuite, selectQuestions, type RunConfig, type RunSummary } from './run/runSuite';
import {
  loadResults,
  loadBaseline,
  groupByCategory,
  compareRunToBaseline,
  renderCompareReport,
} from './compare/BaselineComparator';
import { promote } from './compare/promote';
import type { OrchestratorProfile, OrchestratorTuning } from './agent/orchestration';
import { validateWebCredentials } from './agent/WebChatClient';
import { UserError, type ThinkingLevel } from './types';

export { validateWebCredentials };

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Root that relative config paths (evalDir, baselineDir, grader prompts, run ids) resolve against:
 * the directory holding the config file, so eval content lives with its config rather than with the
 * harness.
 *
 * Passed explicitly rather than held in module state. It was a mutable module-level binding assigned
 * inside main(), which meant no test could set it — every assertion ran against the harness root, and
 * reverting the assignment left the suite green. Threading it makes the refactor's central invariant
 * testable.
 */
export const CLI_OPTIONS = {
  config: { type: 'string' },
  suite: { type: 'string' },
  category: { type: 'string', multiple: true },
  limit: { type: 'string' },
  provider: { type: 'string' },
  'web-url': { type: 'string' },
  'answer-model': { type: 'string' },
  'reviewer-model': { type: 'string' },
  'reviewer-thinking': { type: 'string' },
  thinking: { type: 'string' },
  mode: { type: 'string' },
  eval: { type: 'string' },
  expect: { type: 'string' },
  merge: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  run: { type: 'string' },
  baseline: { type: 'string' },
  gate: { type: 'boolean' },
  'gate-critical': { type: 'boolean' },
} as const;

export function parseCliArgs(args: string[] = process.argv.slice(2)) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: CLI_OPTIONS,
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs();

  // --config is CWD-relative, like any other CLI path argument.
  const configPath = values.config ? path.resolve(String(values.config)) : path.join(repoRoot, 'yvoke-eval.yaml');
  const contentRoot = path.dirname(configPath);
  if (!existsSync(configPath)) {
    throw new UserError(
      `Config not found: ${configPath}\n\n` +
        'Eval content — suites, graders and baselines — lives in its own repository, and the harness\n' +
        'is pointed at it. For the One Identity Manager suite:\n\n' +
        '  npm run eval -- --config ../yvoke-eval-oim/yvoke-eval.yaml\n',
    );
  }
  const cfg = resolveSuite(loadConfig(configPath), values.suite as string | undefined);
  const command = positionals[0] ?? 'run';

  switch (command) {
    case 'run':
      await cmdRun(cfg, values, contentRoot);
      break;
    case 'compare':
      cmdCompare(cfg, values, positionals, contentRoot);
      break;
    case 'promote':
      cmdPromote(cfg, values, positionals, contentRoot);
      break;
    default:
      console.error(`Unknown command "${command}". Commands: run | compare | promote`);
      process.exit(2);
  }
}

export async function cmdRun(
  cfg: EvalConfig,
  values: Record<string, unknown>,
  contentRoot: string,
  runSuiteFn: (config: RunConfig) => Promise<RunSummary> = runSuite,
): Promise<void> {
  const runConfig = toRunConfig(cfg, values, contentRoot);

  if (values['dry-run']) {
    const qs = selectQuestions(runConfig);
    console.log('Resolved run configuration:');
    const maskedWeb = runConfig.web
      ? {
          ...runConfig.web,
          ...(runConfig.web.password !== undefined ? { password: mask(runConfig.web.password) } : {}),
          ...(runConfig.web.sessionCookie !== undefined ? { sessionCookie: mask(runConfig.web.sessionCookie) } : {}),
        }
      : undefined;
    console.log(
      JSON.stringify(
        {
          ...runConfig,
          mcp: { ...runConfig.mcp, bearer: mask(runConfig.mcp.bearer) },
          ...(maskedWeb ? { web: maskedWeb } : {}),
        },
        null,
        2,
      ),
    );
    console.log(`\n${qs.length} question(s) selected:`);
    for (const q of qs) console.log(`  ${q.category}.${q.id}  [${q.expect}]  ${q.question}`);
    return;
  }

  const answerLabel =
    runConfig.mode === 'mas'
      ? `${runConfig.evalIntent} eval · sdk-mas (orchestrator=${runConfig.mas?.tuning.orchestrator.model})`
      : runConfig.provider === 'web'
        ? `specialist eval · web-single (answer=${runConfig.answerModel})`
        : `specialist eval · sdk-single (answer=${runConfig.answerModel})`;
  const targetUrl =
    runConfig.provider === 'web'
      ? (runConfig.web?.baseUrl ?? runConfig.mcp.serverBaseUrl)
      : runConfig.mcp.serverBaseUrl;
  console.error(
    `Running ${runConfig.categories.length > 0 ? runConfig.categories.join(',') : 'all categories'} ` +
      `via ${answerLabel}, judge=${runConfig.reviewerModel} against ${targetUrl}`,
  );
  const summary = await runSuiteFn(runConfig);

  const abortNote = summary.aborted ? ` [ABORTED: ${summary.abortReason ?? 'early stop'}]` : '';
  console.error(
    `\nDone: ${summary.pass} PASS / ${summary.partial} PARTIAL / ${summary.fail} FAIL / ${summary.error} ERROR (of ${summary.total})${abortNote}`,
  );
  for (const dir of summary.runDirs) console.log(dir);
  if (summary.error > 0 || summary.aborted) {
    process.exit(1);
  }
}

export function resolveBaselineDir(
  contentRoot: string,
  cfg: EvalConfig,
  values: Record<string, unknown>,
  runDir: string,
): string {
  if (values.baseline) {
    return resolve(contentRoot, String(values.baseline));
  }

  let runMeta: Record<string, unknown> | undefined;
  const runMetaPath = path.join(runDir, 'run_meta.json');
  if (existsSync(runMetaPath)) {
    try {
      runMeta = JSON.parse(readFileSync(runMetaPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Malformed run_meta.json will be reported by caller
    }
  }

  const isWebRun =
    String(runMeta?.['answerProvider'] ?? '').startsWith('web-') || values.provider === 'web';
  const sdkDefaultDir = resolve(contentRoot, './eval/baseline');
  const webDefaultDir = resolve(contentRoot, './eval/baseline-web');
  const configuredDir = cfg.baselineDir ? resolve(contentRoot, cfg.baselineDir) : null;

  if (isWebRun) {
    if (!configuredDir || path.resolve(configuredDir) === path.resolve(sdkDefaultDir)) {
      return webDefaultDir;
    }
    if (path.resolve(configuredDir) !== path.resolve(webDefaultDir)) {
      console.error(
        `[WARN] Web run is using custom configured baselineDir (${configuredDir}) instead of ${webDefaultDir}; verify this baseline is not an SDK baseline.`,
      );
    }
    return configuredDir;
  }

  return configuredDir ?? resolve(contentRoot, baselineDefaultFor(resolveEvalIntent(values, cfg)));
}

export function cmdCompare(cfg: EvalConfig, values: Record<string, unknown>, positionals: string[], contentRoot: string): void {
  const runArg = (values.run as string | undefined) ?? positionals[1];
  if (!runArg) throw new UserError('compare needs a run: `eval compare --run <run-dir-or-id> [--baseline <dir>] [--gate] [--gate-critical]`');
  const evalDir = resolve(contentRoot, cfg.evalDir ?? './eval');
  const runDir = resolveRunDir(runArg, evalDir, contentRoot);
  const baselineDir = resolveBaselineDir(contentRoot, cfg, values, runDir);

  const byCat = groupByCategory(loadResults(runDir));
  const baseByCat = loadBaseline(baselineDir, [...byCat.keys()]);

  const runMetaPath = path.join(runDir, 'run_meta.json');
  if (existsSync(runMetaPath)) {
    try {
      const runMeta = JSON.parse(readFileSync(runMetaPath, 'utf8')) as Record<string, unknown>;
      const runScoring = (runMeta['scoringVersion'] as string | undefined) ?? 'legacy';
      for (const cat of byCat.keys()) {
        let baseMetaPath = path.join(baselineDir, cat, 'run_meta.json');
        if (!existsSync(baseMetaPath)) {
          const flatMeta = path.join(baselineDir, 'run_meta.json');
          if (existsSync(flatMeta)) baseMetaPath = flatMeta;
        }
        if (existsSync(baseMetaPath)) {
          const baseMeta = JSON.parse(readFileSync(baseMetaPath, 'utf8')) as Record<string, unknown>;
          const baseScoring = (baseMeta['scoringVersion'] as string | undefined) ?? 'legacy';
          if (runScoring !== baseScoring) {
            console.error(
              `[WARN] Scoring version mismatch for ${cat}: run is scored with v${runScoring} but baseline is v${baseScoring}.`,
            );
          }
          const runVaried = runMeta['systemPromptVaried'] === true;
          const baseVaried = baseMeta['systemPromptVaried'] === true;
          if (runVaried || baseVaried) {
            const runShas = (runMeta['systemPromptShas'] as string[] | undefined)?.join(', ');
            const baseShas = (baseMeta['systemPromptShas'] as string[] | undefined)?.join(', ');
            if (runVaried && baseVaried) {
              console.error(`[WARN] System prompt varied across questions in both runs for ${cat} (run used ${runShas}, baseline used ${baseShas}).`);
            } else if (runVaried) {
              console.error(`[WARN] System prompt varied across questions during ${cat} run (used ${runShas}).`);
            } else {
              console.error(`[WARN] System prompt varied across questions during ${cat} baseline (used ${baseShas}).`);
            }
          } else {
            // Scalar comparison strictly in 'else' so varied runs never trigger spurious mismatch warnings:
            const runSysSha = runMeta['systemPromptSha'];
            const baseSysSha = baseMeta['systemPromptSha'];
            if ((runSysSha || baseSysSha) && runSysSha !== baseSysSha) {
              console.error(`[WARN] System prompt SHA mismatch for ${cat}: run has ${runSysSha ?? 'none'} but baseline has ${baseSysSha ?? 'none'}.`);
            }
          }
          const runGraderSha = runMeta['graderPromptSha'];
          const baseGraderSha = baseMeta['graderPromptSha'];
          if ((runGraderSha || baseGraderSha) && runGraderSha !== baseGraderSha) {
            console.error(
              `[WARN] Grader prompt SHA mismatch for ${cat}: run has ${runGraderSha ?? 'none'} but baseline has ${baseGraderSha ?? 'none'}.`,
            );
          }
          const runModel = runMeta['answerModel'];
          const baseModel = baseMeta['answerModel'];
          if ((runModel || baseModel) && runModel !== baseModel) {
            console.error(
              `[WARN] Answer model mismatch for ${cat}: run used ${runModel ?? 'none'} but baseline used ${baseModel ?? 'none'}.`,
            );
          }
          const runProvider =
            (runMeta['answerProvider'] as string | undefined) ??
            (runMeta['evalIntent'] === 'mas' ? 'sdk-mas' : 'sdk-single');
          const baseProvider =
            (baseMeta['answerProvider'] as string | undefined) ??
            (baseMeta['evalIntent'] === 'mas' ? 'sdk-mas' : 'sdk-single');
          if (runProvider !== baseProvider) {
            console.error(
              `[WARN] Answer provider mismatch for ${cat}: run used ${runProvider} but baseline used ${baseProvider}.`,
            );
          }
        } else {
          console.error(
            `[WARN] Scoring version mismatch for ${cat}: run is scored with v${runScoring} but baseline has no run_meta.json.`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[WARN] Failed to read run or baseline metadata for scoring comparison: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const report = compareRunToBaseline(basename(runDir), byCat, baseByCat);
  console.log(renderCompareReport(report));
  if (values['gate-critical'] && report.criticalHardRegressions.length > 0) {
    console.error(`\nGATE FAILED: ${report.criticalHardRegressions.length} critical hard regression(s).`);
    process.exit(1);
  }
  if (values.gate && report.gated) {
    console.error(`\nGATE FAILED: ${report.hardRegressions.length} hard regression(s) (${report.criticalHardRegressions.length} critical).`);
    process.exit(1);
  }
}

export function cmdPromote(cfg: EvalConfig, values: Record<string, unknown>, positionals: string[], contentRoot: string): void {
  const runArg = (values.run as string | undefined) ?? positionals[1];
  if (!runArg) throw new UserError('promote needs a run: `eval promote <run-dir-or-id> [--category C ...] [--baseline <dir>]`');
  const evalDir = resolve(contentRoot, cfg.evalDir ?? './eval');
  const runDir = resolveRunDir(runArg, evalDir, contentRoot);
  const baselineDir = resolveBaselineDir(contentRoot, cfg, values, runDir);

  const res = promote(runDir, baselineDir, values.category as string[] | undefined);
  console.error(`Promoted ${res.categories.length} categor${res.categories.length === 1 ? 'y' : 'ies'} from ${res.runId} → ${baselineDir}:`);
  for (const c of res.categories) console.log(c);
}

const CANONICAL_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  'claude-haiku': 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  'claude-sonnet': 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  'claude-opus': 'claude-opus-5-5',
};

/**
 * Normalizes user-friendly model aliases (e.g. `haiku`, `haiku-5.5`, `sonnet`, `sonnet-5.5`)
 * to their concrete Claude Agent SDK model identifiers (`claude-haiku-5-5`, etc.), matching
 * desktop resolveCanonicalModel.
 */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (CANONICAL_MODELS[lower]) return CANONICAL_MODELS[lower];
  if (/^(claude-)?haiku[-\s.]?5[-\s.]?5$/i.test(trimmed)) return 'claude-haiku-5-5';
  if (/^(claude-)?sonnet[-\s.]?5[-\s.]?5$/i.test(trimmed)) return 'claude-sonnet-5-5';
  if (/^(claude-)?opus[-\s.]?5[-\s.]?5$/i.test(trimmed)) return 'claude-opus-5-5';
  return trimmed;
}

const VALID_THINKING_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high'];

export function parseThinkingLevel(value: unknown): ThinkingLevel {
  if (value === undefined || value === null) return 'low';
  const s = String(value).trim().toLowerCase();
  if (!VALID_THINKING_LEVELS.includes(s)) {
    throw new UserError(`Invalid thinking level "${value}". Allowed values: ${VALID_THINKING_LEVELS.join(', ')}.`);
  }
  return s as ThinkingLevel;
}

function parseHttpUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UserError(`Invalid ${label} "${raw}": must be a valid http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UserError(`Invalid ${label} "${raw}": must be a valid http:// or https:// URL.`);
  }
  return parsed;
}

/**
 * Resolve a config + CLI flags into a RunConfig. `contentRoot` is the directory holding the config
 * file; every relative path in `cfg` resolves against it.
 */
export function toRunConfig(cfg: EvalConfig, values: Record<string, unknown>, contentRoot: string): RunConfig {
  const evalDir = resolve(contentRoot, cfg.evalDir ?? './eval');
  const limitFlag = values.limit ? Number.parseInt(String(values.limit), 10) : undefined;
  const rawProvider = String((values.provider as string | undefined) ?? cfg.answer?.provider ?? 'sdk').trim();
  if (rawProvider !== 'sdk' && rawProvider !== 'web') {
    throw new UserError(`Invalid --provider "${rawProvider}". Allowed values: sdk, web.`);
  }
  const provider: 'sdk' | 'web' = rawProvider;

  const evalIntent = resolveEvalIntent(values, cfg);
  // Intent drives execution mode: specialist→single; mas/orchestration→mas.
  const mode: 'single' | 'mas' = evalIntent === 'specialist' ? 'single' : 'mas';
  if (provider === 'web' && mode !== 'single') {
    throw new UserError('Web provider currently supports single-agent (specialist) mode only (--mode single --eval specialist).');
  }

  let answerModel: string;
  if (provider === 'web') {
    const explicitWebModel = (
      (values['answer-model'] as string | undefined) ??
      cfg.answer?.web?.model
    )?.trim();
    const fallbackAnswerModel =
      cfg.answer?.provider === 'web' ? cfg.answer?.model?.trim() : undefined;

    if (explicitWebModel) {
      answerModel = explicitWebModel;
    } else if (fallbackAnswerModel && !/^(sonnet|haiku|opus)$/i.test(fallbackAnswerModel)) {
      answerModel = fallbackAnswerModel;
    } else {
      throw new UserError(
        'Web provider requires an explicit web chat model via --answer-model <model> or answer.web.model (e.g. gemini-3.8-flash, gpt-5.4-mini, claude-sonnet-5-5).',
      );
    }
  } else {
    answerModel = normalizeModelName((values['answer-model'] as string | undefined) ?? cfg.answer?.model ?? 'sonnet');
  }

  const mcpServerBaseUrl = cfg.mcp?.serverBaseUrl ?? 'http://localhost:8080';
  const parsedMcpUrl = parseHttpUrl(mcpServerBaseUrl, 'mcp.serverBaseUrl');
  let webConfig: RunConfig['web'];
  let questionTimeoutMs = 180_000;
  if (provider === 'web') {
    const webBaseUrl = (
      (values['web-url'] as string | undefined) ??
      cfg.answer?.web?.baseUrl ??
      parsedMcpUrl.origin
    ).replace(/\/+$/, '');
    const parsedWebUrl = parseHttpUrl(webBaseUrl, '--web-url / answer.web.baseUrl');
    if (parsedWebUrl.origin !== parsedMcpUrl.origin) {
      console.error(
        `[WARN] Web baseUrl (${webBaseUrl}) and MCP serverBaseUrl (${mcpServerBaseUrl}) have different origins; system prompt / playbook metadata may not match the web server's database.`,
      );
    }
    const timeoutSec = cfg.answer?.web?.questionTimeoutSec ?? 180;
    if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new UserError(
        `Invalid answer.web.questionTimeoutSec "${String(timeoutSec)}": must be a finite number > 0.`,
      );
    }
    const pollIntervalMs = cfg.answer?.web?.pollIntervalMs ?? 500;
    if (typeof pollIntervalMs !== 'number' || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new UserError(
        `Invalid answer.web.pollIntervalMs "${String(pollIntervalMs)}": must be a finite number > 0.`,
      );
    }
    validateWebCredentials({
      sessionCookie: cfg.answer?.web?.sessionCookie,
      username: cfg.answer?.web?.username,
      password: cfg.answer?.web?.password,
    });
    questionTimeoutMs = timeoutSec * 1000;
    webConfig = {
      baseUrl: webBaseUrl,
      defaultPlaybook: cfg.answer?.web?.defaultPlaybook?.trim() || null,
      username: cfg.answer?.web?.username,
      password: cfg.answer?.web?.password,
      sessionCookie: cfg.answer?.web?.sessionCookie,
      pollIntervalMs,
      keepConversations: cfg.answer?.web?.keepConversations ?? false,
    };
  }

  // Graders are knowledge-base content, so there is no default worth falling back to: a wrong rubric
  // grades the whole run against the wrong domain and reports verdicts that look entirely normal.
  // Demand them here, before any answer is generated, rather than at first use.
  const graderPath = requireGrader(cfg.reviewer?.promptFile, 'promptFile', 'grades answer quality', contentRoot);
  const orchestrationGraderPath =
    evalIntent === 'orchestration'
      ? requireGrader(cfg.reviewer?.orchestrationPromptFile, 'orchestrationPromptFile', 'grades the orchestration process', contentRoot)
      : null;
  return {
    evalDir,
    provider,
    graderPath,
    orchestrationGraderPath,
    mode,
    evalIntent,
    mas: mode === 'mas' ? resolveMas(cfg) : undefined,
    // Absent → empty, which makes web access fail closed in canUseTool rather than reaching the
    // open web. An eval is only worth its verdict if the answer ran under the shipped constraints.
    webAllowedDomains: cfg.web?.allowedDomains ?? [],
    ...(webConfig ? { web: webConfig } : {}),
    questionTimeoutMs,
    categories: (values.category as string[] | undefined) ?? cfg.run?.categories ?? [],
    expect: (values.expect as string | undefined) ?? null,
    limit: limitFlag ?? cfg.run?.limit ?? 0,
    merge: (values.merge as boolean | undefined) ?? cfg.run?.merge ?? false,
    answerModel,
    thinkingLevel: parseThinkingLevel(values['thinking'] ?? cfg.answer?.thinkingLevel),
    reviewerModel: normalizeModelName((values['reviewer-model'] as string | undefined) ?? cfg.reviewer?.model ?? 'opus'),
    reviewerThinkingLevel: parseThinkingLevel(values['reviewer-thinking'] ?? cfg.reviewer?.thinkingLevel),
    mcp: {
      serverBaseUrl: mcpServerBaseUrl,
      bearer: cfg.mcp?.bearer ?? 'dev-local-token',
      transport: (cfg.mcp?.transport as 'http' | 'sse') ?? 'http',
    },
    sandboxDir: path.join(os.tmpdir(), 'yvoke-eval-sandbox'),
    maxTurns: 20,
  };
}

/** Resolve a configured grader rubric, or explain exactly which key is missing and why it matters. */
function requireGrader(value: string | undefined, key: string, role: string, contentRoot: string): string {
  if (!value) {
    throw new UserError(
      `Missing reviewer.${key} in the eval config — it names the rubric that ${role}.\n\n` +
        'Grader rubrics are knowledge-base content and live with the evals, so there is no default:\n\n' +
        '  reviewer:\n' +
        `    ${key}: ./graders/${key === 'promptFile' ? 'eval-reviewer.md' : 'orchestration-reviewer.md'}\n`,
    );
  }
  return resolve(contentRoot, value);
}

/** What to measure: explicit --eval / config, else derived from execution mode (single→specialist, mas→mas). */
export function resolveEvalIntent(values: Record<string, unknown>, cfg: EvalConfig): 'specialist' | 'mas' | 'orchestration' {
  const explicit = (values.eval as string | undefined) ?? cfg.run?.eval;
  if (explicit === 'specialist' || explicit === 'mas' || explicit === 'orchestration') return explicit;
  if (explicit) throw new UserError(`Unknown --eval "${explicit}". Use: specialist | mas | orchestration.`);
  const mode = (values.mode as string | undefined) ?? cfg.run?.mode ?? 'single';
  return mode === 'mas' ? 'mas' : 'specialist';
}

/** Orchestration verdicts get their own baseline so they never mix with answer-quality baselines. */
function baselineDefaultFor(intent: 'specialist' | 'mas' | 'orchestration'): string {
  return intent === 'orchestration' ? './eval/baseline-sdk-orchestration' : './eval/baseline';
}

function resolveMas(cfg: EvalConfig): { profile: OrchestratorProfile; tuning: OrchestratorTuning } {
  const mas = cfg.mas;
  const name = mas?.profile;
  const def = name ? mas?.profiles?.[name] : undefined;
  if (!mas || !name || !def) {
    throw new UserError(`mas mode needs mas.profile + mas.profiles.<name> in the config (got profile="${name}").`);
  }
  const roles = mas.roles ?? {
    orchestrator: { model: 'opus', thinkingLevel: 'high' },
    reviewer: { model: 'opus', thinkingLevel: 'high' },
    specialist: { model: 'sonnet', thinkingLevel: 'medium' },
  };
  const role = (r: { model: string; thinkingLevel: string }) => ({
    model: normalizeModelName(r.model),
    thinkingLevel: parseThinkingLevel(r.thinkingLevel),
    configuredModel: r.model.trim(),
  });
  return {
    profile: {
      orchestratorPlaybook: def.orchestrator,
      reviewerPlaybook: def.reviewer,
      specialistPlaybooks: def.specialists,
    },
    tuning: {
      orchestrator: role(roles.orchestrator),
      reviewer: role(roles.reviewer),
      specialist: role(roles.specialist),
      maxReviewRounds: mas.maxReviewRounds ?? 2,
      maxSpecialistCalls: mas.maxSpecialistCalls ?? 8,
      orchestratorMaxTurns: mas.orchestratorMaxTurns ?? 60,
      specialistMaxTurns: mas.specialistMaxTurns ?? 20,
    },
  };
}

function resolveRunDir(arg: string, evalDir: string, contentRoot: string): string {
  const candidates = [arg, path.resolve(process.cwd(), arg), path.join(contentRoot, arg), path.join(evalDir, 'runs', arg)];
  for (const c of candidates) {
    if (isDir(c)) return c;
  }
  throw new UserError(`Run not found: "${arg}" (looked in cwd, ${contentRoot}, and ${path.join(evalDir, 'runs')}).`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve a possibly-relative config path against the directory holding the config file. */
function resolve(contentRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(contentRoot, p);
}

function mask(s: string): string {
  return s.length <= 4 ? '****' : `${s.slice(0, 2)}…${s.slice(-2)}`;
}

/**
 * Is this module the process entry point? Importing it — as the tests do, to exercise toRunConfig —
 * must not parse argv, read a config, or call process.exit.
 *
 * Compare resolved realpaths, not the raw strings: argv[1] and import.meta.url can spell the same
 * file differently through a symlinked checkout or macOS's /tmp → /private/tmp alias, and a
 * mismatch makes the CLI exit 0 having silently done nothing.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(argv1);
  if (invoked === self) return true;
  try {
    return realpathSync(invoked) === realpathSync(self);
  } catch {
    return false; // argv[1] does not exist on disk — not us.
  }
}

if (isEntryPoint()) {
  main().catch((e) => {
    // A UserError is something the reader must act on, so print it alone — a stack would bury the
    // instruction under frames of node internals. Everything else is our fault: keep the stack.
    if (e instanceof UserError) {
      console.error(e.message);
    } else {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
    process.exit(1);
  });
}
