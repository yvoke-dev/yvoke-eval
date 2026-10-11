import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { UserError, type EvalQuestion, type EvalResult, type ThinkingLevel } from '../types';
import type { AnswerBundle } from '../agent/AnswerBundle';
import { EvalSpecParser } from '../specs/EvalSpecParser';
import { McpPrompts, type PromptSource } from '../mcp/McpPrompts';
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
import { detectClaudeCredentials, type ClaudeCredentialStatus } from '../agent/auth';
import { normalizeModelName } from '../cli';

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
  /** Answer-quality judge. */
  judge: Judge;
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
  const prompts = deps.prompts ?? new McpPrompts(cfg.mcp);
  const orchestrationMode = cfg.evalIntent === 'orchestration';
  // Active grader = the orchestration rubric for Mode 3, else the answer-quality rubric.
  const graderPath = orchestrationMode ? cfg.orchestrationGraderPath : cfg.graderPath;
  if (!graderPath) {
    throw new UserError('orchestration eval needs reviewer.orchestrationPromptFile in the eval config.');
  }
  const grader = loadGrader(graderPath);
  const structuredModel = new AgentSdkStructuredModel({ sandboxDir: cfg.sandboxDir });
  const judge = deps.judge ?? new ClaudeJudge(structuredModel, { model: cfg.reviewerModel, systemPrompt: grader.prompt });
  const orchJudge: OrchestrationJudge | null = orchestrationMode
    ? new ClaudeOrchestrationJudge(structuredModel, { model: cfg.reviewerModel, systemPrompt: grader.prompt })
    : null;

  // The production base system prompt, so answers are produced under the same grounding and citation
  // rules as yvoke-desktop. A failure here is fatal by design — see SystemPromptClient.get.
  const systemPromptClient = new SystemPromptClient({ ...cfg.mcp, fetchFn: deps.fetchFn });
  const systemPrompt = await systemPromptClient.get(SYSTEM_PROMPT_NAME);
  log(
    systemPrompt
      ? `Loaded ${SYSTEM_PROMPT_NAME} system prompt from the server (${systemPrompt.length} chars).`
      : `Server has no ${SYSTEM_PROMPT_NAME} system prompt — running with the SDK default.`,
  );

  // Build the answer producer for the selected mode.
  let produce: (q: EvalQuestion) => Promise<AnswerBundle>;
  let answerModelLabel: string;
  let answerProvider: 'sdk-single' | 'sdk-mas';
  let thinkingLabel: string;
  if (cfg.mode === 'mas') {
    if (!cfg.mas) throw new Error('mas mode requires a resolved profile (cfg.mas).');
    const orch = await buildOrchestrator(cfg.mas.profile, cfg.mas.tuning, prompts, systemPrompt, systemPromptClient);
    log(`Orchestrator ready: ${orch.specialistNames.length} specialists (${orch.specialistNames.join(', ')}).`);
    const masRunner = new MasAnswerRunner({ ...cfg.mcp, sandboxDir: cfg.sandboxDir, webAllowedDomains: cfg.webAllowedDomains }, orch);
    produce = (q) => masRunner.run(q.question);
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
    produce = async (q) => {
      const task = await buildEvalTask(q, prompts, {
        answerModel: cfg.answerModel,
        thinkingLevel: cfg.thinkingLevel,
        systemPrompt,
        systemPromptClient,
      });
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
      const bundle = await produce(q);
      if (!resolvedWorkerModel && typeof bundle.providerMeta?.resolvedModel === 'string') {
        resolvedWorkerModel = bundle.providerMeta.resolvedModel;
      }
      result = orchestrationMode
        ? await gradeOrchestration(q, bundle, orchJudge!, Date.now() - t0, {
            maxReviewRounds: cfg.mas!.tuning.maxReviewRounds,
            orchestratorMaxTurns: cfg.mas!.tuning.orchestratorMaxTurns,
          })
        : await gradeOne(q, bundle, judge, Date.now() - t0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = errorResult(q, msg, Date.now() - t0);
    }
    results.push(result);
    log(`[${n}/${questions.length}] ${q.category}.${q.id} → ${result.verdict.verdict}`);
  }

  await prompts.close();

  const sutSha = sanitizeSha(prompts.serverVersion()?.version);
  const activeJudge = orchestrationMode ? orchJudge : judge;
  const resolvedJudgeModel = activeJudge?.resolvedModel ?? (judge as { resolvedModel?: string })?.resolvedModel;

  const meta = {
    answerModel: answerModelLabel,
    resolvedAnswerModel: resolvedWorkerModel ?? null,
    answerProvider,
    evalIntent: cfg.evalIntent,
    sdkModel: answerModelLabel,
    sdkVersion: agentSdkVersion(),
    reviewerModel: cfg.reviewerModel,
    resolvedReviewerModel: resolvedJudgeModel ?? null,
    reviewerProvider: 'claude',
    thinkingLevel: thinkingLabel,
    systemPromptName: systemPrompt ? SYSTEM_PROMPT_NAME : null,
    graderPromptSha: grader.sha,
    gitSha: sutSha,
    masReviewerModel: cfg.mode === 'mas' ? (cfg.mas?.tuning.reviewer.model ?? null) : null,
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
    // One run id per CATEGORY — computed up front, so the per-category writes can never collide on
    // the same second and clobber each other's results.json.
    for (const [cat, list] of groupByCategory(results)) {
      const runId = `${newRunId(answerModelLabel, sutSha)}__${cat}`;
      runDirs.push(writer.write(cfg.evalDir, { ...meta }, list, runId).runDir);
    }
  }

  const tally = { total: results.length, pass: 0, partial: 0, fail: 0, error: 0 };
  for (const r of results) {
    if (r.verdict.verdict === 'PASS') tally.pass++;
    else if (r.verdict.verdict === 'PARTIAL') tally.partial++;
    else if (r.verdict.verdict === 'FAIL') tally.fail++;
    else tally.error++;
  }
  return { runDirs, ...tally };
}

export function selectQuestions(cfg: RunConfig): EvalQuestion[] {
  // Orchestration eval validates expected_specialists against the profile's roster at parse time.
  const known = cfg.evalIntent === 'orchestration' ? cfg.mas?.profile.specialistPlaybooks : undefined;
  const all = new EvalSpecParser(cfg.evalDir, known).parse();
  const wanted = cfg.categories.length > 0 ? new Set(cfg.categories) : null;
  const byCategory = wanted ? all.filter((q) => wanted.has(q.category)) : all;
  // Applied before the per-category cap, so `--expect clarify --limit 2` means two CLARIFY
  // questions per category rather than two questions of which some may be clarify.
  const filtered = cfg.expect ? byCategory.filter((q) => q.expect === cfg.expect) : byCategory;
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
      mustIncludeMissing: q.mustInclude,
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
    return (require('@anthropic-ai/claude-agent-sdk/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
