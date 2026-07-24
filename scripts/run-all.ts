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
 *   npm run eval:all -- --config $CFG --from ts_databases --continue
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveSuite } from '../src/config/loadConfig';
import { EvalSpecParser } from '../src/specs/EvalSpecParser';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(repoRoot, 'src', 'cli.ts');
const TSX = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const USAGE = `usage: npm run eval:all -- --config <eval-repo>/yvoke-eval.yaml [options]

  --config <path>     required; the content repository's yvoke-eval.yaml
  --suite <name>      suite overlay to apply (passed through to every category)
  --only a,b,c        run only these categories
  --from <category>   skip categories before this one (resume a stopped sweep)
  --promote <dir>     promote each category into <dir> as soon as it succeeds
  --continue          keep going after a category fails (default: stop)
  --dry-run           plan only, no model calls`;

function main(): void {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      suite: { type: 'string' },
      only: { type: 'string' },
      from: { type: 'string' },
      promote: { type: 'string' },
      continue: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

  if (!values.config) throw new Error(USAGE);
  const configPath = path.resolve(values.config);
  if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}\n\n${USAGE}`);

  const contentRoot = path.dirname(configPath);
  const cfg = resolveSuite(loadConfig(configPath), values.suite);
  const evalDir = path.isAbsolute(cfg.evalDir ?? './eval')
    ? (cfg.evalDir ?? './eval')
    : path.join(contentRoot, cfg.evalDir ?? './eval');

  const categories = selectCategories(evalDir, values.only, values.from);
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
function cli(args: string[], values: Record<string, unknown>): boolean {
  const passthrough: string[] = ['--config', path.resolve(String(values.config))];
  if (values.suite) passthrough.push('--suite', String(values.suite));
  if (values['dry-run']) args.push('--dry-run');
  const r = spawnSync(TSX, [CLI, ...passthrough, ...args], { stdio: 'inherit' });
  return r.status === 0;
}

/** Spec order is the suite's own order, so a sweep runs in the order the author listed. */
function selectCategories(evalDir: string, only?: string, from?: string): string[] {
  const all = [...new Set(new EvalSpecParser(evalDir).parse().map((q) => q.category))];

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
function latestRunFor(evalDir: string, category: string): string | null {
  const runsDir = path.join(evalDir, 'runs');
  if (!existsSync(runsDir)) return null;
  const matches = readdirSync(runsDir)
    .filter((d) => d.endsWith(`__${category}`))
    .map((d) => ({ d, m: statSync(path.join(runsDir, d)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return matches[0]?.d ?? null;
}

function report(results: { category: string; ok: boolean; promoted: boolean }[], planned: number, promoting: boolean): void {
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

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
