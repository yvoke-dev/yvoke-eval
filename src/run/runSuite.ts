import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UserError, type EvalQuestion, type EvalResult, type ThinkingLevel } from '../types';

import type { AnswerBundle } from '../agent/AnswerBundle';
import { EvalSpecParser } from '../specs/EvalSpecParser';
import { McpPrompts, type PromptSource, type McpPromptInfo } from '../mcp/McpPrompts';
import { SystemPromptClient, SYSTEM_PROMPT_NAME } from '../server/SystemPromptClient';
import { SdkAnswerRunner, type AnswerRunner } from '../agent/SdkAnswerRunner';
import { MasAnswerRunner } from '../agent/MasAnswerRunner';
import { buildOrchestrator, type OrchestratorProfile, type OrchestratorTuning } from '../agent/orchestration';
import { buildEvalTask } from '../agent/buildTask';
import { gradeOne, gradeOrchestration } from './grade';
import { ClaudeJudge, type Judge } from '../reviewer/Judge';
import { ClaudeOrchestrationJudge, type OrchestrationJudge } from '../reviewer/OrchestrationJudge';
import { AgentSdkStructuredModel } from '../reviewer/AgentSdkStructuredModel';
import { loadGrader } from '../reviewer/loadGrader';
import { ReportWriter, newRunId } from '../report/ReportWriter';
import {
  detectClaudeCredentials,
  type ClaudeCredentialStatus,
  isQuotaOrAuthError,
  isAuthError,
  isQuotaError,
  LOGIN_INSTRUCTIONS,
  QUOTA_INSTRUCTIONS,
} from '../agent/auth';
import { normalizeModelName } from '../cli';
import { effectiveVerdict } from '../compare/verdict';

export interface RunConfig {
  evalDir: string;
  mode: 'single' | 'mas';
  /** What is being measured (Mode 1/2/3). 'orchestration' grades the process; specialist/mas grade the answer. */
  evalIntent: 'specialist' | 'mas' | 'orchestration';
  categories: string[]; // empty = all
  /** Keep only questions whose spec `expect` matches (e.g. 'clarify'). Null = every kind. */
  expect: string | null;
  limit: number; // 0 = no cap (per category)
  merge: boolean;
  answerModel: string; // single mode
  thinkingLevel: ThinkingLevel; // single mode
  mas?: { profile: OrchestratorProfile; tuning: OrchestratorTuning }; // mas mode
  mcp: { serverBaseUrl: string; bearer: string; transport: 'http' | 'sse' };
  /** The deployment's web allow-list; empty/absent makes web access fail closed. */
  webAllowedDomains: string[];
  reviewerModel: string;
  reviewerThinkingLevel?: ThinkingLevel;
  graderPath: string;
  /** Only needed for `evalIntent: 'orchestration'`; null for every other intent. */
  orchestrationGraderPath: string | null;
  sandboxDir: string;
  maxTurns: number;
}

export interface RunSummary {
  runDirs: string[];
  total: number;
  pass: number;
  partial: number;
  fail: number;
  error: number;
  aborted?: boolean;
  abortReason?: string;
}


type Logger = (msg: string) => void;

/**
 * The collaborators runSuite would otherwise build for itself. Every field defaults to the production
 * wiring, so `runSuite(cfg)` is unchanged; a test overrides only what needs a live server, a Claude
 * subscription, or a subprocess.
 *
 * `fetchFn` is deliberately the transport rather than a `{ get(name) }` system-prompt port. The
 * invariant worth protecting is that the base prompt comes from the server's REST endpoint and *not*
 * from MCP, and only a seam at this level lets a test assert the actual URL — a named port would be
 * satisfiable by an MCP-backed object, which is exactly the regression it exists to catch.
 *
 * Scope rule: `deps` is for collaborators that cross a process boundary. Pure helpers
 * (selectQuestions, loadGrader, the report renderers) stay internal and are unit-tested directly.
 */
export interface RunDeps {
  /** Claude subscription probe (reads ~/.claude). */
  credentials: () => ClaudeCredentialStatus;
  /** Handed to SystemPromptClient, whose own `?? fetch` supplies the global. */
  fetchFn: typeof fetch;
  /** MCP playbook source. */
  prompts: PromptSource;
  /** single-mode answer producer. */
  answerRunner: AnswerRunner;
  /** multi-agent mode answer producer. */
  masAnswerRunner?: { run(modelContent: string, opts?: { abortController?: AbortController; expect?: string }): Promise<AnswerBundle> };
  /** Answer-quality judge. */
  judge: Judge;
  /** Orchestration judge. */
  orchJudge?: OrchestrationJudge;
}


export async function withTimeout<T>(fn: (ac: AbortController) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while ${label}`);
      ac.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ac), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CachedPromptSource implements PromptSource {
  private listCache?: Promise<McpPromptInfo[]>;
  private textCache = new Map<string, Promise<string>>();

  constructor(private readonly inner: PromptSource) {}

  list(): Promise<McpPromptInfo[]> {
    if (!this.listCache) {
      this.listCache = this.inner.list().catch((err) => {
        this.listCache = undefined;
        throw err;
      });
    }
    return this.listCache;
  }

  getText(name: string, args?: Record<string, string>): Promise<string> {
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    let p = this.textCache.get(key);
    if (!p) {
      p = this.inner.getText(name, args).catch((err) => {
        this.textCache.delete(key);
        throw err;
      });
      this.textCache.set(key, p);
    }
    return p;
  }

  serverVersion() {
    return this.inner.serverVersion();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export async function runSuite(
  cfg: RunConfig,
  log: Logger = (m) => console.error(m),
  deps: Partial<RunDeps> = {},
): Promise<RunSummary> {
  if ((deps.credentials ?? detectClaudeCredentials)() === 'missing') {
    throw new UserError('No Claude credentials (~/.claude). Run `claude /login` first.');
  }

  const questions = selectQuestions(cfg);
  if (questions.length === 0) throw new UserError('No questions matched the run selection.');

  mkdirSync(cfg.sandboxDir, { recursive: true });
  const rawPrompts = deps.prompts ?? new McpPrompts(cfg.mcp);
  const prompts = new CachedPromptSource(rawPrompts);
  const orchestrationMode = cfg.evalIntent === 'orchestration';
  // Active grader = the orchestration rubric for Mode 3, else the answer-quality rubric.
  const graderPath = orchestrationMode ? cfg.orchestrationGraderPath : cfg.graderPath;
  if (!graderPath) {
    throw new UserError('orchestration eval needs reviewer.orchestrationPromptFile in the eval config.');
  }
  const grader = loadGrader(graderPath);
  const structuredModel = new AgentSdkStructuredModel({
    sandboxDir: cfg.sandboxDir,
    thinkingLevel: cfg.reviewerThinkingLevel ?? 'low',
  });
  const judge = deps.judge ?? new ClaudeJudge(structuredModel, { model: cfg.reviewerModel, systemPrompt: grader.prompt });
  const orchJudge: OrchestrationJudge | null =
    deps.orchJudge ??
    (orchestrationMode
      ? new ClaudeOrchestrationJudge(structuredModel, { model: cfg.reviewerModel, systemPrompt: grader.prompt })
      : null);

  // The production base system prompt, so answers are produced under the same grounding and citation
  // rules as yvoke-desktop. A failure here is fatal by design — see SystemPromptClient.get.
  const systemPromptClient = new SystemPromptClient({ ...cfg.mcp, fetchFn: deps.fetchFn });
  const systemPrompt = await systemPromptClient.get(SYSTEM_PROMPT_NAME);
  log(
    systemPrompt
      ? `Loaded ${SYSTEM_PROMPT_NAME} system prompt from the server (${systemPrompt.length} chars).`
      : `Server has no ${SYSTEM_PROMPT_NAME} system prompt — running with the SDK default.`,
  );

  interface PromptEntry {
    names: Set<string>;
    shas: Set<string>;
    fallback: boolean;
  }

  function formatPromptEntry(entry?: PromptEntry) {
    if (!entry || (entry.names.size === 0 && entry.shas.size === 0)) {
      return {
        systemPromptName: null,
        systemPromptSha: null,
        systemPromptFallback: false,
      };
    }
    const isVaried = entry.names.size > 1 || entry.shas.size > 1;
    if (isVaried) {
      return {
        systemPromptName: null,
        systemPromptSha: null,
        systemPromptFallback: entry.fallback,
        systemPromptShas: [...entry.shas],
        systemPromptVaried: true as const,
      };
    }
    return {
      systemPromptName: [...entry.names][0] ?? null,
      systemPromptSha: [...entry.shas][0] ?? null,
      systemPromptFallback: entry.fallback,
    };
  }

  const categoryPrompts = new Map<string, PromptEntry>(); // keyed by `${q.category}::${pbKey}`
  const mergedPlaybookPrompts = new Map<string, PromptEntry>(); // keyed by pbKey
  const playbookVersions = new Map<string, number>();

  // Build the answer producer for the selected mode.
  let produce: (q: EvalQuestion, ac: AbortController) => Promise<AnswerBundle>;
  let answerModelLabel: string;
  let answerProvider: 'sdk-single' | 'sdk-mas';
  let thinkingLabel: string;
  if (cfg.mode === 'mas') {
    if (!cfg.mas) throw new Error('mas mode requires a resolved profile (cfg.mas).');
    const orch = await buildOrchestrator(cfg.mas.profile, cfg.mas.tuning, prompts, systemPrompt, systemPromptClient);
    log(`Orchestrator ready: ${orch.specialistNames.length} specialists (${orch.specialistNames.join(', ')}).`);
    const masRunner =
      deps.masAnswerRunner ??
      new MasAnswerRunner({ ...cfg.mcp, sandboxDir: cfg.sandboxDir, webAllowedDomains: cfg.webAllowedDomains }, orch);
    produce = (q, ac) => masRunner.run(q.question, { abortController: ac, expect: q.expect });

    answerModelLabel = cfg.mas.tuning.orchestrator.model;
    answerProvider = 'sdk-mas';
    thinkingLabel = cfg.mas.tuning.orchestrator.thinkingLevel;
  } else {
    const runner =
      deps.answerRunner ??
      new SdkAnswerRunner({
        ...cfg.mcp,
        sandboxDir: cfg.sandboxDir,
        maxTurns: cfg.maxTurns,
        webAllowedDomains: cfg.webAllowedDomains,
      });
    produce = async (q, ac) => {
      const task = await buildEvalTask(q, prompts, {
        answerModel: cfg.answerModel,
        thinkingLevel: cfg.thinkingLevel,
        systemPrompt,
        systemPromptClient,
      });
      task.abortController = ac;

      if (q.playbook && typeof task.playbookVersion === 'number') {
        playbookVersions.set(q.playbook, task.playbookVersion);
      }

      const pbKey = q.playbook ?? '_no_playbook';
      const catKey = `${q.category}::${pbKey}`;
      for (const [map, key] of [[categoryPrompts, catKey], [mergedPlaybookPrompts, pbKey]] as const) {
        let entry = map.get(key);
        if (!entry) {
          entry = { names: new Set(), shas: new Set(), fallback: false };
          map.set(key, entry);
        }
        if (task.systemPromptName) entry.names.add(task.systemPromptName);
        if (task.systemPrompt) entry.shas.add(sha256(task.systemPrompt));
        if (task.systemPromptFallback) entry.fallback = true;
      }

      return runner.run(task);
    };
    answerModelLabel = cfg.answerModel;
    answerProvider = 'sdk-single';
    thinkingLabel = cfg.thinkingLevel;
  }

  const results: EvalResult[] = [];
  let n = 0;
  let resolvedWorkerModel: string | undefined;
  for (const q of questions) {
    n++;
    const t0 = Date.now();
    let result: EvalResult;
    try {
      const bundle = await withTimeout((ac) => produce(q, ac), 180_000, `answering ${q.category}.${q.id}`);
      if (!resolvedWorkerModel && typeof bundle.providerMeta?.resolvedModel === 'string') {
        resolvedWorkerModel = bundle.providerMeta.resolvedModel;
      }
      result = orchestrationMode
        ? await withTimeout(
            (ac) =>
              gradeOrchestration(
                q,
                bundle,
                orchJudge!,
                Date.now() - t0,
                {
                  maxReviewRounds: cfg.mas!.tuning.maxReviewRounds,
                  orchestratorMaxTurns: cfg.mas!.tuning.orchestratorMaxTurns,
                },
                ac,
              ),
            180_000,
            `grading orchestration ${q.category}.${q.id}`,
          )
        : await withTimeout(
            (ac) => gradeOne(q, bundle, judge, Date.now() - t0, ac),
            180_000,
            `grading ${q.category}.${q.id}`,
          );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = errorResult(q, msg, Date.now() - t0);
    }
    results.push(result);
    log(`[${n}/${questions.length}] ${q.category}.${q.id} → ${result.verdict.verdict}`);
    const errText = result.error ?? (result.verdict.verdict === 'ERROR' ? result.verdict.reasoning : null);
    if (errText && isQuotaOrAuthError(errText)) {
      log(`\n[ABORT] Fatal quota or authentication failure on ${q.category}.${q.id}: ${errText}`);
      if (isAuthError(errText)) log(LOGIN_INSTRUCTIONS);
      if (isQuotaError(errText)) log(QUOTA_INSTRUCTIONS);
      break;
    }
  }

  await prompts.close();

  const sutSha = sanitizeSha(prompts.serverVersion()?.version);
  const activeJudge = orchestrationMode ? orchJudge : judge;
  const resolvedJudgeModel = activeJudge?.resolvedModel ?? (judge as { resolvedModel?: string })?.resolvedModel;

  const allPlaybooks = [...new Set(results.map((r) => r.question.playbook).filter((p): p is string => Boolean(p)))];

  function resolvePlaybookVersion(playbooks: string[]): number | null {
    const versions = new Set<number>();
    for (const pb of playbooks) {
      const v = playbookVersions.get(pb);
      if (typeof v === 'number') versions.add(v);
    }
    return versions.size === 1 ? ([...versions][0] ?? null) : null;
  }

  let rootPromptMeta: {
    systemPromptName: string | null;
    systemPromptSha: string | null;
    systemPromptFallback: boolean;
    systemPromptShas?: string[];
    systemPromptVaried?: boolean;
    playbookPrompts: Record<string, unknown> | null;
  };

  if (mergedPlaybookPrompts.size === 0) {
    // MAS mode
    rootPromptMeta = {
      systemPromptName: null,
      systemPromptSha: null,
      systemPromptFallback: false,
      playbookPrompts: null,
    };
  } else if (mergedPlaybookPrompts.size === 1) {
    const singleEntry = [...mergedPlaybookPrompts.values()][0];
    const formatted = formatPromptEntry(singleEntry);
    rootPromptMeta = {
      systemPromptName: formatted.systemPromptName,
      systemPromptSha: formatted.systemPromptSha,
      systemPromptFallback: formatted.systemPromptFallback,
      ...(formatted.systemPromptVaried ? { systemPromptVaried: true, systemPromptShas: formatted.systemPromptShas } : {}),
      playbookPrompts: null,
    };
  } else {
    // mergedPlaybookPrompts.size > 1
    rootPromptMeta = {
      systemPromptName: null,
      systemPromptSha: null,
      systemPromptFallback: [...mergedPlaybookPrompts.values()].some((e) => e.fallback),
      playbookPrompts: Object.fromEntries(
        [...mergedPlaybookPrompts.entries()].map(([pb, e]) => [pb, formatPromptEntry(e)]),
      ),
    };
  }

  const meta = {
    answerModel: answerModelLabel,
    resolvedAnswerModel: resolvedWorkerModel ?? null,
    answerProvider,
    evalIntent: cfg.evalIntent,
    scoringVersion: '2.2',
    harnessGitSha: harnessGitSha(),
    contentGitSha: gitShaForDir(cfg.evalDir),
    sdkModel: answerModelLabel,
    sdkVersion: agentSdkVersion(),

    reviewerModel: cfg.reviewerModel,
    resolvedReviewerModel: resolvedJudgeModel ?? null,
    reviewerProvider: 'claude',
    reviewerThinkingLevel: cfg.reviewerThinkingLevel ?? 'low',
    thinkingLevel: thinkingLabel,
    ...rootPromptMeta,
    graderPromptSha: grader.sha,
    gitSha: sutSha,
    playbooks: allPlaybooks,
    playbookVersion: resolvePlaybookVersion(allPlaybooks),
    masReviewerModel:
      cfg.mode === 'mas'
        ? (cfg.mas?.tuning.reviewer.configuredModel ?? cfg.mas?.tuning.reviewer.model ?? null)
        : null,
    resolvedMasReviewerModel:
      cfg.mode === 'mas' && cfg.mas?.tuning.reviewer.model
        ? normalizeModelName(cfg.mas.tuning.reviewer.model)
        : null,
  };

  const writer = new ReportWriter();
  const runDirs: string[] = [];
  if (cfg.merge) {
    runDirs.push(writer.write(cfg.evalDir, meta, results).runDir);
  } else {
    for (const [cat, list] of groupByCategory(results)) {
      const runId = `${newRunId(answerModelLabel, sutSha)}__${cat}`;
      const distinctKeys = [...new Set(list.map((r) => r.question.playbook ?? '_no_playbook'))];
      let catPlaybooks: string[];
      let catPromptMeta: {
        systemPromptName: string | null;
        systemPromptSha: string | null;
        systemPromptFallback: boolean;
        systemPromptShas?: string[];
        systemPromptVaried?: boolean;
        playbookPrompts?: Record<string, unknown> | null;
      };

      if (distinctKeys.length === 1) {
        const k = distinctKeys[0];
        const isNoPb = k === '_no_playbook';
        catPlaybooks = isNoPb ? [] : [k];
        const entry = categoryPrompts.get(`${cat}::${k}`);
        if (!entry) {
          // MAS mode where categoryPrompts wasn't populated
          catPromptMeta = {
            systemPromptName: null,
            systemPromptSha: null,
            systemPromptFallback: false,
            playbookPrompts: null,
          };
        } else {
          const formatted = formatPromptEntry(entry);
          catPromptMeta = {
            systemPromptName: formatted.systemPromptName,
            systemPromptSha: formatted.systemPromptSha,
            systemPromptFallback: formatted.systemPromptFallback,
            ...(formatted.systemPromptVaried ? { systemPromptVaried: true, systemPromptShas: formatted.systemPromptShas } : {}),
            playbookPrompts: null,
          };
        }
      } else {
        // Multi-playbook or mixed category!
        catPlaybooks = distinctKeys.filter((k) => k !== '_no_playbook');
        catPromptMeta = {
          systemPromptName: null,
          systemPromptSha: null,
          systemPromptFallback: distinctKeys.some((k) => categoryPrompts.get(`${cat}::${k}`)?.fallback ?? false),
          playbookPrompts: Object.fromEntries(
            distinctKeys.map((k) => [k, formatPromptEntry(categoryPrompts.get(`${cat}::${k}`))]),
          ),
        };
      }

      const catMeta = {
        ...meta,
        ...catPromptMeta,
        playbooks: catPlaybooks,
        playbookVersion: resolvePlaybookVersion(catPlaybooks),
      };
      if (!catPromptMeta.systemPromptVaried) {
        delete (catMeta as any).systemPromptVaried;
        delete (catMeta as any).systemPromptShas;
      }
      runDirs.push(writer.write(cfg.evalDir, catMeta, list, runId).runDir);
    }
  }

  const summary: RunSummary = {
    runDirs,
    total: results.length,
    pass: results.filter((r) => effectiveVerdict(r) === 'PASS').length,
    partial: results.filter((r) => effectiveVerdict(r) === 'PARTIAL').length,
    fail: results.filter((r) => effectiveVerdict(r) === 'FAIL').length,
    error: results.filter((r) => effectiveVerdict(r) === 'ERROR').length,
    aborted: results.length < questions.length,
    abortReason: results.length < questions.length ? 'Quota, authentication, or fatal error encountered' : undefined,
  };
  return summary;
}

export function selectQuestions(cfg: RunConfig): EvalQuestion[] {
  // Orchestration eval validates expected_specialists against the profile's roster at parse time.
  const known = cfg.evalIntent === 'orchestration' ? cfg.mas?.profile.specialistPlaybooks : undefined;
  const all = new EvalSpecParser(cfg.evalDir, known).parse();
  const wanted = cfg.categories.length > 0 ? new Set(cfg.categories) : null;
  const byCategory = wanted ? all.filter((q) => wanted.has(q.category)) : all;
  const intentFiltered = cfg.evalIntent === 'orchestration'
    ? byCategory.filter((q) => q.category === 'orchestration_ie' || q.expectedSpecialists !== undefined)
    : byCategory.filter((q) => q.category !== 'orchestration_ie' && q.expectedSpecialists === undefined);
  // Applied before the per-category cap, so `--expect clarify --limit 2` means two CLARIFY
  // questions per category rather than two questions of which some may be clarify.
  const filtered = cfg.expect ? intentFiltered.filter((q) => q.expect === cfg.expect) : intentFiltered;
  if (cfg.limit <= 0) return filtered;
  // Per-category cap.
  const counts = new Map<string, number>();
  const out: EvalQuestion[] = [];
  for (const q of filtered) {
    const c = counts.get(q.category) ?? 0;
    if (c < cfg.limit) {
      out.push(q);
      counts.set(q.category, c + 1);
    }
  }
  return out;
}

function groupByCategory(results: EvalResult[]): Map<string, EvalResult[]> {
  const m = new Map<string, EvalResult[]>();
  for (const r of results) {
    const list = m.get(r.question.category) ?? [];
    list.push(r);
    m.set(r.question.category, list);
  }
  return m;
}

function errorResult(q: EvalQuestion, msg: string, latencyMs: number): EvalResult {
  return {
    question: q,
    answer: '',
    signals: {
      toolsFired: [],
      searchCollections: [],
      retrievedCollections: [],
      retrievedChunkCount: 0,
      mustIncludeMissing: [],
      mustNotIncludePresent: [],
      expectedToolsMissing: [],
      hasCitations: false,
    },
    verdict: { verdict: 'ERROR', dimensions: {}, reasoning: msg, evidence: [] },
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs,
    error: msg,
  };
}

function sanitizeSha(v: string | undefined): string {
  return v && v.length > 0 ? v.replace(/[^A-Za-z0-9._-]/g, '-') : 'nogit';
}

function agentSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    let dir = dirname(entry);
    while (dir && dir !== dirname(dir)) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === '@anthropic-ai/claude-agent-sdk' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
      dir = dirname(dir);
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function harnessGitSha(repoRoot = fileURLToPath(new URL('../..', import.meta.url))): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const status = execSync('git status --porcelain', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return status.length > 0 ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function gitShaForDir(dir: string): string | null {
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const sha = execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const status = execSync(
      "git status --porcelain -- ':!eval/runs' ':!eval/runs/**' ':!runs' ':!runs/**'",
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .toString()
      .trim();
    return status.length > 0 ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}
