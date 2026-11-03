/**
 * Run a whole suite category by category, and optionally promote each one that succeeds.
 *
 * `run` writes nothing until its question loop finishes (runSuite.ts), so one long invocation over
 * every category is all-or-nothing — a failure at the last question discards the lot. This spawns one
 * CLI process per category instead, so a failure costs that category and nothing else, and `--from`
 * picks up where it stopped.
 *
 * Categories are read from the config's evalDir, never hardcoded: this script must not know which
 * knowledge base it is running.
 *
 * Usage:
 *   npm run eval:all -- --config ../yvoke-eval-oim/yvoke-eval.yaml
 *   npm run eval:all -- --config $CFG --promote ./eval/baseline-sdk-single
 *   npm run eval:all -- --config $CFG --provider web --answer-model <model> [--web-url <url>] --promote ./eval/baseline-web
 *   npm run eval:all -- --config $CFG --from ts_databases --continue
 */
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveSuite } from '../src/config/loadConfig';
import { EvalSpecParser } from '../src/specs/EvalSpecParser';
import { toRunConfig } from '../src/cli';
import { UserError } from '../src/types';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(repoRoot, 'src', 'cli.ts');
const TSX = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

export const RUN_ALL_OPTIONS = {
  config: { type: 'string' },
  suite: { type: 'string' },
  only: { type: 'string' },
  from: { type: 'string' },
  promote: { type: 'string' },
  continue: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean' },
  provider: { type: 'string' },
  'web-url': { type: 'string' },
  'answer-model': { type: 'string' },
  'reviewer-model': { type: 'string' },
  'reviewer-thinking': { type: 'string' },
  thinking: { type: 'string' },
  mode: { type: 'string' },
  eval: { type: 'string' },
  expect: { type: 'string' },
  limit: { type: 'string' },
} as const;

const RUN_PASSTHROUGH_STRING_FLAGS = [
  'provider',
  'web-url',
  'answer-model',
  'reviewer-model',
  'reviewer-thinking',
  'thinking',
  'mode',
  'eval',
  'expect',
  'limit',
] as const;

const USAGE = `usage: npm run eval:all -- --config <eval-repo>/yvoke-eval.yaml [options]

  --config <path>             required; the content repository's yvoke-eval.yaml
  --suite <name>              suite overlay to apply (passed through to every category)
  --only a,b,c                run only these categories
  --from <category>           skip categories before this one (resume a stopped sweep)
  --promote <dir>             promote each category into <dir> as soon as it succeeds
  --continue                  keep going after a category fails (default: stop)
  --dry-run                   plan only, no model calls
  --provider <sdk|web>        answer provider (default: sdk)
  --web-url <url>             yvoke-web base URL when --provider web
  --answer-model <model>      answer model override (required for --provider web unless in config)
  --thinking <level>          answer thinking level (off|low|medium|high)
  --reviewer-model <model>    judge model override
  --reviewer-thinking <level> judge thinking level (off|low|medium|high)
  --mode <single|mas>         execution mode override
  --eval <intent>             eval intent override (specialist|mas|orchestration)
  --expect <kind>             filter questions by expect kind (answer|clarify|redirect|refuse)
  --limit <n>                 per-category question limit
  --help                      print this help message

examples:
  npm run eval:all -- --config $CFG --promote ./eval/baseline-sdk-single
  npm run eval:all -- --config $CFG --provider web --answer-model <model> [--web-url <url>] --promote ./eval/baseline-web`;

export function parseRunAllArgs(args: string[] = process.argv.slice(2)) {
  return parseArgs({
    args,
    options: RUN_ALL_OPTIONS,
  });
}

export function buildCliInvocationArgs(
  subcommandArgs: string[],
  values: Record<string, unknown>,
): string[] {
  const out: string[] = [
    '--config',
    path.resolve(String(values.config)),
    ...(values.suite ? ['--suite', String(values.suite)] : []),
  ];
  out.push(...subcommandArgs);

  if (subcommandArgs[0] === 'run') {
    for (const flag of RUN_PASSTHROUGH_STRING_FLAGS) {
      const val = values[flag];
      if (val !== undefined) {
        out.push(`--${flag}`, String(val));
      }
    }
    if (values['dry-run']) {
      out.push('--dry-run');
    }
  } else if (subcommandArgs[0] === 'promote') {
    if (values.provider !== undefined) {
      out.push('--provider', String(values.provider));
    }
  }

  return out;
}

function main(): void {
  const { values } = parseRunAllArgs();
  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (!values.config) throw new Error(USAGE);
  const configPath = path.resolve(values.config);
  if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}\n\n${USAGE}`);

  const contentRoot = path.dirname(configPath);
  const cfg = resolveSuite(loadConfig(configPath), values.suite);
  const runConfig = toRunConfig(cfg, values, contentRoot);
  const evalDir = runConfig.evalDir;
  const evalIntent = runConfig.evalIntent;
  const categories = selectCategories(evalDir, evalIntent, values.only, values.from);
  if (categories.length === 0) throw new Error(`No categories selected from ${evalDir}.`);

  console.error(`${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} from ${evalDir}:`);
  console.error(`  ${categories.join(', ')}\n`);

  const results: { category: string; ok: boolean; promoted: boolean }[] = [];
  for (const [i, category] of categories.entries()) {
    console.error(`─── [${i + 1}/${categories.length}] ${category} ───`);
    const ok = cli(['run', '--category', category], values);
    let promoted = false;

    // Promote per category, not at the end: a sweep that stops early still leaves every category it
    // did finish promoted, and re-running picks up from --from without redoing them.
    if (ok && values.promote && !values['dry-run']) {
      const runId = latestRunFor(evalDir, category);
      if (!runId) {
        console.error(`  ! ${category}: run finished but no run directory found — not promoted`);
      } else {
        promoted = cli(['promote', runId, '--baseline', values.promote], values);
      }
    }

    results.push({ category, ok, promoted });
    if (!ok && !values.continue) {
      console.error(`\nStopped at ${category}. Re-run with --from ${category} once it is fixed, or pass --continue.`);
      break;
    }
  }

  report(results, categories.length, Boolean(values.promote));
  if (results.some((r) => !r.ok)) process.exit(1);
}

/** Spawn the CLI for one command, inheriting stdio so progress streams live. */
function cli(subcommandArgs: string[], values: Record<string, unknown>): boolean {
  const cliArgs = buildCliInvocationArgs(subcommandArgs, values);
  const r = spawnSync(TSX, [CLI, ...cliArgs], { stdio: 'inherit' });
  return r.status === 0;
}

/** Spec order is the suite's own order, so a sweep runs in the order the author listed. */
export function selectCategories(evalDir: string, evalIntent: string, only?: string, from?: string): string[] {
  const allQuestions = new EvalSpecParser(evalDir).parse();
  const applicable = evalIntent === 'orchestration'
    ? allQuestions.filter((q) => q.category === 'orchestration_ie' || q.expectedSpecialists !== undefined)
    : allQuestions.filter((q) => q.category !== 'orchestration_ie' && q.expectedSpecialists === undefined);
  const all = [...new Set(applicable.map((q) => q.category))];

  let picked = all;
  if (only) {
    const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = wanted.filter((w) => !all.includes(w));
    if (unknown.length > 0) throw new Error(`Unknown categor(y/ies): ${unknown.join(', ')}.\nAvailable: ${all.join(', ')}`);
    picked = wanted;
  }
  if (from) {
    const i = picked.indexOf(from);
    if (i < 0) throw new Error(`--from "${from}" is not in the selection.\nAvailable: ${picked.join(', ')}`);
    picked = picked.slice(i);
  }
  return picked;
}

/** Newest run directory whose id ends in `__<category>` (how runSuite names per-category runs). */
export function latestRunFor(evalDir: string, category: string): string | null {
  const runsDir = path.join(evalDir, 'runs');
  if (!existsSync(runsDir)) return null;
  const matches = readdirSync(runsDir)
    .filter((d) => d.endsWith(`__${category}`))
    .map((d) => ({ d, m: statSync(path.join(runsDir, d)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return matches[0]?.d ?? null;
}

export function report(results: { category: string; ok: boolean; promoted: boolean }[], planned: number, promoting: boolean): void {
  const done = results.filter((r) => r.ok).length;
  console.error(`\n═══ ${done}/${planned} categories succeeded ═══`);
  for (const r of results) {
    const status = r.ok ? 'ok  ' : 'FAIL';
    const note = r.ok && promoting ? (r.promoted ? '  promoted' : '  NOT promoted') : '';
    console.error(`  ${status}  ${r.category}${note}`);
  }
  const skipped = planned - results.length;
  if (skipped > 0) console.error(`  (${skipped} not attempted)`);
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(argv1);
  if (invoked === self) return true;
  try {
    return realpathSync(invoked) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    main();
  } catch (e) {
    if (e instanceof UserError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
