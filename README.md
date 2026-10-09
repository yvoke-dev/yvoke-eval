# yvoke-eval

Standalone eval harness for the Yvoke RAG assistant. It runs authored question suites through the
**Claude Agent SDK** (single-agent or multi-agent) against the yvoke **MCP** server — exactly like
`yvoke-desktop` — grades each answer with a version-controlled LLM-as-judge, and writes timestamped,
comparable result sets.

**This repository contains no eval content.** Suites, grader rubrics, baselines and recorded runs
belong to a knowledge base and live in their own repository; the harness is pointed at one with
`--config`. The One Identity Manager suite is [`yvoke-eval-oim`](../yvoke-eval-oim).

Extracted from the in-repo Spring Boot eval IT (`yvoke-web/src/it/java/.../eval`). See
[PLAN.md](./PLAN.md) for the full design and rationale.

## Design in one screen

- **Answers come only from the Claude Agent SDK → MCP** (`localhost:8080/mcp`). Playbook **prompts,
  tools, and `codeExecution` are loaded from MCP** (`prompts/list` + `prompts/get`). Two modes:
  `single` (any playbook, incl. one specialist) and `mas` (orchestrator + specialists + reviewer).
  The one exception to MCP-only is the **base system prompt**, which is not an MCP prompt: it is read
  from `GET /api/chat/v1/prompts/system/default-chat`, exactly as yvoke-desktop does, so answers are
  produced under the deployed grounding and citation rules. No other server endpoints, no
  server-side writes.
- **Signals are derived from the SDK trace + MCP tool results** — no DB. Tools fired, searched/retrieved
  collections, chunk counts, include/exclude checks, citation discipline.
- **The grader is owned by the eval content, not the server.** The rubric is named by
  `reviewer.promptFile` in the content repository's config — there is no default, since a rubric is
  knowledge-base specific — and its checksum is pinned into each run's `run_meta.json`
  (`graderPromptSha`), so verdicts stay attributable. Judge is **Claude by default** (forced
  structured output); Gemini is an optional cross-family bias-audit provider.
- **All content lives in the content repo:** its `eval/` holds the specs (`eval_specs.yaml` +
  `eval_<category>.md`), `baseline/`, and `runs/`; its `graders/` holds the rubrics. Every relative
  path in `yvoke-eval.yaml` resolves against the directory holding that config.

## Three eval modes — see [MODES.md](./MODES.md)

The harness answers three different questions, scored differently, at three levels of the system:

- **Specialist eval** ✅ — is *one specialist* good: does it retrieve the right context and build a
  grounded, cited answer? Runs on `single`. A knowledge base's specialist fleets (e.g. pinpoint vs
  browsing) are a sub-axis here, not a separate mode.
- **MAS eval** ✅ — is the *whole system's* final composed answer good (black box)? Runs on `mas`,
  grading the end-to-end answer with the same answer-quality rubric. This is what `mas` mode does
  today.
- **Orchestration eval** 🔭 — does the *orchestrator + reviewer coordinate* correctly (white box):
  right delegation, effective reviewer, stop/round rules? Runs on `mas` too, but needs delegation-trace
  capture + orchestration-specific signals and rubric that don't exist yet. A single `mas` run can feed
  both MAS eval and orchestration eval.

## Status — P4 (single + mas modes, compare/gate/promote)

Both answer modes run end-to-end against a live `localhost:8080` and grade to a full structured
verdict — **verified** (both smoke-graded PASS), all on `~/.claude` subscription auth (no API key).
`compare`/`--gate`/`promote` are implemented and tested. 128 offline tests + typecheck green.

- **`single` mode** — one playbook, tools + prompt from MCP, captured to an `AnswerBundle`.
- **`mas` mode** — orchestrator + specialists + reviewer (per `spike-mas.ts`); retrieval happens
  inside specialist sub-agents and capture harvests their tool/chunk signals; the composed answer is
  the orchestrator's. Profiles are config-driven (`mas.profiles` in `yvoke-eval.yaml`).

Implemented:
- **Answer path:** `src/agent/{SdkAnswerRunner,MasAnswerRunner,orchestration,buildTask,capture,policy,mcpServers,thinking,auth}.ts`
  + `src/mcp/McpPrompts.ts`. `ask_clarifying_question` is gated by `canUseTool` (single mode).
- **Scoring core:** `src/signals/SignalExtractor.ts` (trace-only), `src/reviewer/` (`Judge`,
  `ClaudeJudge`, `AgentSdkStructuredModel` — subscription-auth judge with an injected shape contract +
  tolerant `parseVerdict`, since the SDK has no responseSchema binding), `src/run/grade.ts`.
- **Orchestration + CLI:** `src/run/runSuite.ts`, `src/cli.ts` (`run` / `compare` / `promote`).
- **Compare/promote:** `src/compare/{verdict,BaselineComparator,promote}.ts` — band-classified run-vs-
  baseline diff with a deterministic fabrication gate (`must_not_include` hit = auto-FAIL), a `--gate`
  non-zero exit on hard regressions, and `promote` (regenerates `baseline/<category>/` + `BASELINE.md`).
- **Reporting/specs/config:** `EvalSpecParser`, `ReportWriter` (golden-tested), `loadConfig`.

Known caveats: `run_meta.gitSha` is the MCP server version (e.g. `1.0.0`), not a commit; `sdkVersion`
may read `unknown`; the `mas` composed answer includes some orchestrator narration; the
`expect:clarify` STOP path is verified in single mode only. Hardening idea: replace the
prompt-contract judge with an in-process `record_verdict` SDK tool for guaranteed-schema output.

> Baselines recorded before 2026-07-28 ran with the SDK default system prompt — the harness was
> asking MCP for `default-chat`, which only ever served playbooks, and swallowing the error. They are
> not comparable with runs made since; re-baseline rather than diff across the fix.

Cutover (P5, done): the old yvoke-web eval harness is fully removed. [CUTOVER.md](./CUTOVER.md) is
kept as the historical record of that switch — its commands predate the content move and no longer
run as written.

## Develop

```bash
npm install
npm run typecheck
npm test
```

## Run against a live server

### Environment

**Nothing here loads a `.env` file** — there is no dotenv dependency and no `--env-file`. These are
plain shell exports, read either by the `${VAR:default}` interpolation in the content repo's
`yvoke-eval.yaml` or directly by the code. All four are optional:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | **Leave unset.** Runs use ambient `~/.claude` subscription auth; [`sanitizedEnv`](src/agent/auth.ts:33) strips this from the SDK's environment so an inherited key can't silently switch you to pay-per-token billing. |
| `YVOKE_SERVER` | MCP server base URL, if the content repo's config interpolates it (the OIM one does, defaulting to `http://localhost:8080`). |
| `EVAL_BEARER` | Bearer token for that server, same mechanism (OIM default: `dev-local-token`). |
| `DRY=1` | `scripts/replay.ts` only — rebuild signals from recorded transcripts and diff them against the old run, making no judge calls. |

`$YVOKE_EVAL_CONFIG` also selects the content repo for one shell; see below.

### Model Selection & Version Resolution

Models are configured via `answer.model` (or CLI `--answer-model`), `reviewer.model` (or CLI `--reviewer-model`), and MAS role tunings.

| Target Model | Full Model ID | Shorthand / Alias Handling |
|---|---|---|
| **Claude Haiku 5.5** | `claude-haiku-5-5` | Pass `claude-haiku-5-5`, `haiku-5.5`, or `haiku 5.5`. **Do not pass bare alias `haiku`** (that defaults to the older `claude-haiku-4-5-20251001`). |
| **Claude Sonnet 5** | `claude-sonnet-5` | Default alias `sonnet`. |
| **Claude Sonnet 5.5** | `claude-sonnet-5-5` | Pass `claude-sonnet-5-5`, `sonnet-5.5`, or `sonnet 5.5`. |
| **Claude Opus 4.8** | `claude-opus-4-8` | Default alias `opus`. |
| **Claude Opus 5.5** | `claude-opus-5-5` | Pass `claude-opus-5-5`, `opus-5.5`, or `opus 5.5`. |

The harness automatically extracts the concrete runtime model ID returned in the Anthropic Agent SDK's `system.init` message (`msg.model`) and records both the alias and resolved version in `run_meta.json`, `summary.md`, and `eval/runs/OVERVIEW.md`.

### Caveat — a replayed answer can be scored as if the model had run

Yvoke reaches Gemini through a Cloudflare AI Gateway, and **caching is on at the gateway** — enabled
in the dashboard, not in code. It caches streaming responses too. The cache key is
`SHA-256(provider + endpoint + model + auth header + full request body)`, so organic chat rarely
repeats — but **this harness replays a fixed question set, so it sends byte-identical first turns by
design.** That is exactly the shape the cache is built for.

When it hits, the gateway returns the stored answer and **the model never executes**. The run then
scores a replayed answer, and its cost reads near-zero for work that would really have been billed.
Nothing prevents this today: `yvoke-web` records the outcome faithfully
(`llm_call_logs.gateway_cache_status`, `cost_avoided`, `gateway_log_id`) but **never sends
`cf-aig-skip-cache`**, and this harness has no way to ask for it.

Two practical consequences:

- **Before trusting a comparison**, check what share of that run's calls were replayed.
  `gateway_cache_status` is on every `llm_call_logs` row and eval traffic is identifiable by
  `source`. A run with a material HIT share is measuring the cache, not the model.
- **Re-running the same suite is the worst case, not the safest.** The second run is the one likely
  to be served from cache, so a score that looks stable across repeated runs is weak evidence.

If this proves to bite, the fix is two-sided: the harness identifies its traffic, and `yvoke-web`
forwards `cf-aig-skip-cache: true` for it. Neither half exists yet.

### Shell wrappers

`./eval.sh` and `./eval-all.sh` supply `--config` for you. Name your content repo once:

```bash
echo ../yvoke-eval-oim/yvoke-eval.yaml > .eval-config
```

`.eval-config` is gitignored — the harness must not name a knowledge base in tracked files.
`$YVOKE_EVAL_CONFIG` overrides it for one shell, and an explicit `--config` overrides both.

```bash
./eval.sh run --category getting_started --limit 1
```

```bash
./eval-all.sh --promote ./eval/baseline-sdk-single
```

The rest of this section spells the commands out in full; the wrappers take the same arguments.

### Full commands

Every command needs `--config` pointing at the content repository — the harness has no evals of its
own. Substitute your own content repo for `../yvoke-eval-oim`.

```bash
# app up at localhost:8080, signed in via `claude /login`
export CFG=../yvoke-eval-oim/yvoke-eval.yaml

# plan only, no model calls — always start here to see what a run would select
npm run eval -- --config $CFG run --limit 1 --dry-run

# one live question end-to-end. --limit is PER CATEGORY, so pick one explicitly:
npm run eval -- --config $CFG run --category getting_started --limit 1

npm run eval -- --config $CFG run --category getting_started   # a full category
npm run eval -- --config $CFG run --mode mas --category getting_started

# `--suite smoke` is limit:2 per category — for the OIM suite that is 30 live questions, not 2.
npm run eval -- --config $CFG run --suite smoke

# compare a run against the baseline and gate CI on hard regressions
npm run eval -- --config $CFG compare --run <run-dir-or-id> --gate
# promote a good run into the baseline (regenerates baseline/<cat>/ + BASELINE.md)
npm run eval -- --config $CFG promote <run-dir-or-id> [--category C ...] [--baseline ./eval/baseline-sdk]

# re-grade recorded answers offline, without re-running the model
npx tsx scripts/replay.ts --config $CFG <old-run-dir>
```

### Sweeping a whole suite

`run` writes nothing until its question loop finishes, so one invocation over every category is
all-or-nothing — a failure on the last question discards the lot. `eval:all` spawns one process per
category instead, so a failure costs that category alone and `--from` resumes the sweep. Categories
come from the config's `evalDir`, never a hardcoded list.

```bash
npm run eval:all -- --config $CFG --dry-run
```

Establish a fresh baseline — promoting each category the moment it succeeds, so a sweep that stops
early keeps everything it finished:

```bash
npm run eval:all -- --config $CFG --promote ./eval/baseline-sdk-single
```

```bash
npm run eval:all -- --config $CFG --from ts_databases   # resume where it stopped
```

Also takes `--only a,b,c`, `--suite <name>`, and `--continue` (keep going past a failure).

> Baselines are only comparable within one answer/judge pairing. After changing either, re-promote
> into a new `--baseline` directory rather than diffing across providers.

> For a fair regression gate, compare/promote against a **same-provider** baseline via `--baseline`:
> answers from one provider are a different distribution than another's, so a cross-provider diff
> measures the provider, not the change under test.

## Roadmap

| Phase | Scope |
|---|---|
| **P0** ✅ | Scaffold, vendor data + grader, parser + report writer + config, golden test. |
| **P1** ✅ | Trace-based `SignalExtractor` + Claude `Judge` + `gradeOne`, tested offline on `AnswerBundle` fixtures. |
| **P2** ✅ | SDK `single` mode live against `localhost:8080` (MCP prompts/tools + capture + CLI); smoke PASS. |
| **P3** ✅ | SDK `mas` mode (orchestrator + specialists + reviewer); MAS-aware capture; smoke PASS. |
| **P4** ✅ | `compare` (band diff + deterministic gate) · `--gate` exit code · `promote` (regenerates baseline + index). |
| **P5** ✅ | Cutover — [CUTOVER.md](./CUTOVER.md): old yvoke-web eval harness fully removed (committed). yvoke-eval is now the sole harness. |
| **Specialist eval** 🔄 | Mode 1 (see [MODES.md](./MODES.md)) — mechanism done; **remaining:** full-suite run → `eval/baseline-sdk-single`, verdict hand-review, optional per-fleet A/B. |
| **MAS eval** 🔄 | Mode 2 (see [MODES.md](./MODES.md)) — mechanism done (`mas` grades the composed answer); **remaining:** full-suite run → `eval/baseline-sdk-mas`. |
| **Orchestration eval** 🟡 | Mode 3 (see [MODES.md](./MODES.md)) — **MVP built** (`--eval orchestration`): delegation-trace capture, orchestration signals, 3-dim rubric + judge, `run.eval` axis, spec fields. **Remaining before scoring:** author `expected_specialists`; record one real `mas` run to verify the stream shape + calibrate. |
