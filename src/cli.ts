import { parseArgs } from 'node:util';
import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveSuite, type EvalConfig } from './config/loadConfig';
import { runSuite, selectQuestions, type RunConfig } from './run/runSuite';
import {
  loadResults,
  loadBaseline,
  groupByCategory,
  compareRunToBaseline,
  renderCompareReport,
} from './compare/BaselineComparator';
import { promote } from './compare/promote';
import type { OrchestratorProfile, OrchestratorTuning } from './agent/orchestration';
import { UserError, type ThinkingLevel } from './types';

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
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      suite: { type: 'string' },
      category: { type: 'string', multiple: true },
      limit: { type: 'string' },
      'answer-model': { type: 'string' },
      'reviewer-model': { type: 'string' },
      thinking: { type: 'string' },
      mode: { type: 'string' },
      eval: { type: 'string' },
      expect: { type: 'string' },
      merge: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      run: { type: 'string' },
      baseline: { type: 'string' },
      gate: { type: 'boolean' },
    },
  });

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

async function cmdRun(cfg: EvalConfig, values: Record<string, unknown>, contentRoot: string): Promise<void> {
  const runConfig = toRunConfig(cfg, values, contentRoot);

  if (values['dry-run']) {
    const qs = selectQuestions(runConfig);
    console.log('Resolved run configuration:');
    console.log(JSON.stringify({ ...runConfig, mcp: { ...runConfig.mcp, bearer: mask(runConfig.mcp.bearer) } }, null, 2));
    console.log(`\n${qs.length} question(s) selected:`);
    for (const q of qs) console.log(`  ${q.category}.${q.id}  [${q.expect}]  ${q.question}`);
    return;
  }

  const answerLabel =
    runConfig.mode === 'mas'
      ? `${runConfig.evalIntent} eval · sdk-mas (orchestrator=${runConfig.mas?.tuning.orchestrator.model})`
      : `specialist eval · sdk-single (answer=${runConfig.answerModel})`;
  console.error(
    `Running ${runConfig.categories.length > 0 ? runConfig.categories.join(',') : 'all categories'} ` +
      `via ${answerLabel}, judge=${runConfig.reviewerModel} against ${runConfig.mcp.serverBaseUrl}`,
  );
  const summary = await runSuite(runConfig);
  console.error(
    `\nDone: ${summary.pass} PASS / ${summary.partial} PARTIAL / ${summary.fail} FAIL / ${summary.error} ERROR (of ${summary.total})`,
  );
  for (const dir of summary.runDirs) console.log(dir);
}

function cmdCompare(cfg: EvalConfig, values: Record<string, unknown>, positionals: string[], contentRoot: string): void {
  const runArg = (values.run as string | undefined) ?? positionals[1];
  if (!runArg) throw new UserError('compare needs a run: `eval compare --run <run-dir-or-id> [--baseline <dir>] [--gate]`');
  const evalDir = resolve(contentRoot, cfg.evalDir ?? './eval');
  const runDir = resolveRunDir(runArg, evalDir, contentRoot);
  const baselineDir = resolve(contentRoot, (values.baseline as string | undefined) ?? cfg.baselineDir ?? baselineDefaultFor(resolveEvalIntent(values, cfg)));

  const byCat = groupByCategory(loadResults(runDir));
  const baseByCat = loadBaseline(baselineDir, [...byCat.keys()]);
  const report = compareRunToBaseline(basename(runDir), byCat, baseByCat);

  console.log(renderCompareReport(report));
  if (values.gate && report.gated) {
    console.error(`\nGATE FAILED: ${report.hardRegressions.length} hard regression(s).`);
    process.exit(1);
  }
}

function cmdPromote(cfg: EvalConfig, values: Record<string, unknown>, positionals: string[], contentRoot: string): void {
  const runArg = (values.run as string | undefined) ?? positionals[1];
  if (!runArg) throw new UserError('promote needs a run: `eval promote <run-dir-or-id> [--category C ...] [--baseline <dir>]`');
  const evalDir = resolve(contentRoot, cfg.evalDir ?? './eval');
  const runDir = resolveRunDir(runArg, evalDir, contentRoot);
  const baselineDir = resolve(contentRoot, (values.baseline as string | undefined) ?? cfg.baselineDir ?? baselineDefaultFor(resolveEvalIntent(values, cfg)));

  const res = promote(runDir, baselineDir, values.category as string[] | undefined);
  console.error(`Promoted ${res.categories.length} categor${res.categories.length === 1 ? 'y' : 'ies'} from ${res.runId} → ${baselineDir}:`);
  for (const c of res.categories) console.log(c);
}

/**
 * Normalizes user-friendly model aliases (e.g. `haiku-5.5`, `haiku 5.5`, `sonnet-5.5`)
 * to their concrete Claude Agent SDK model identifiers (`claude-haiku-5-5`, etc.).
 */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim();
  if (/^(claude-)?haiku[-\s.]?5[-\s.]?5$/i.test(trimmed)) return 'claude-haiku-5-5';
  if (/^(claude-)?sonnet[-\s.]?5[-\s.]?5$/i.test(trimmed)) return 'claude-sonnet-5-5';
  if (/^(claude-)?opus[-\s.]?5[-\s.]?5$/i.test(trimmed)) return 'claude-opus-5-5';
  return trimmed;
}

/**
 * Resolve a config + CLI flags into a RunConfig. `contentRoot` is the directory holding the config
 * file; every relative path in `cfg` resolves against it.
 */
export function toRunConfig(cfg: EvalConfig, values: Record<string, unknown>, contentRoot: string): RunConfig {
  const evalDir = resolve(contentRoot, cfg.evalDir ?? './eval');
  const limitFlag = values.limit ? Number.parseInt(String(values.limit), 10) : undefined;
  const evalIntent = resolveEvalIntent(values, cfg);
  // Intent drives execution mode: specialist→single; mas/orchestration→mas.
  const mode: 'single' | 'mas' = evalIntent === 'specialist' ? 'single' : 'mas';
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
    graderPath,
    orchestrationGraderPath,
    mode,
    evalIntent,
    mas: mode === 'mas' ? resolveMas(cfg) : undefined,
    // Absent → empty, which makes web access fail closed in canUseTool rather than reaching the
    // open web. An eval is only worth its verdict if the answer ran under the shipped constraints.
    webAllowedDomains: cfg.web?.allowedDomains ?? [],
    categories: (values.category as string[] | undefined) ?? cfg.run?.categories ?? [],
    expect: (values.expect as string | undefined) ?? null,
    limit: limitFlag ?? cfg.run?.limit ?? 0,
    merge: (values.merge as boolean | undefined) ?? cfg.run?.merge ?? false,
    answerModel: normalizeModelName((values['answer-model'] as string | undefined) ?? cfg.answer?.model ?? 'sonnet'),
    thinkingLevel: ((values['thinking'] ?? cfg.answer?.thinkingLevel) as ThinkingLevel) ?? 'low',
    reviewerModel: normalizeModelName((values['reviewer-model'] as string | undefined) ?? cfg.reviewer?.model ?? 'opus'),
    mcp: {
      serverBaseUrl: cfg.mcp?.serverBaseUrl ?? 'http://localhost:8080',
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
function resolveEvalIntent(values: Record<string, unknown>, cfg: EvalConfig): 'specialist' | 'mas' | 'orchestration' {
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
    thinkingLevel: r.thinkingLevel as ThinkingLevel,
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
