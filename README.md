# yvoke-eval

Standalone eval harness for the Yvoke RAG assistant. It runs authored question suites against an
answer provider — either `--provider sdk` (default: **Claude Agent SDK** single-agent or multi-agent
over **MCP**, matching `yvoke-desktop`) or `--provider web` (`yvoke-web`'s HTTP async chat + trace
endpoints, single-agent specialist mode) — grades each answer with a version-controlled LLM-as-judge,
and writes timestamped, comparable result sets.

**This repository contains no eval content.** Suites, grader rubrics, baselines and recorded runs
belong to a knowledge base and live in their own repository; the harness is pointed at one with
`--config`. The One Identity Manager suite is [`yvoke-eval-oim`](../yvoke-eval-oim).

Extracted from the in-repo Spring Boot eval IT (`yvoke-web/src/it/java/.../eval`). See
[PLAN.md](./PLAN.md) for the full design and rationale.

## Design in one screen

- **Two answer providers:**
  - **`--provider sdk` (default):** Answers come from the Claude Agent SDK → MCP (`localhost:8080/mcp`).
    Playbook **prompts, tools, and `codeExecution` are loaded from MCP** (`prompts/list` + `prompts/get`).
    Supports both `single` (any playbook, incl. one specialist) and `mas` (orchestrator + specialists +
    reviewer). Each playbook's MCP prompt is self-contained and passed directly as the system prompt (no
    separate `/api/chat/v1/prompts/system/*` fetch), matching `yvoke-desktop` and `yvoke-web` (V17+).
  - **`--provider web`:** Answers come from `yvoke-web`'s session-authenticated async chat endpoints
    (`/chat/new`, `/send-async`, `/status`, `/trace`) in `single` (specialist) mode, evaluating non-SDK
    or server-hosted chat models (e.g. Gemini, OpenAI, or Claude models configured in `yvoke-web`).
    Conversations created per question are automatically deleted unless `keepConversations: true`.
- **Signals are derived from the execution trace + tool results** — no DB. Tools fired, searched/retrieved
  collections, chunk counts, include/exclude checks, citation discipline.
- **The grader is owned by the eval content, not the server.** The rubric is named by
  `reviewer.promptFile` in the content repository's config — there is no default, since a rubric is
  knowledge-base specific — and its checksum is pinned into each run's `run_meta.json`
  (`graderPromptSha`), so verdicts stay attributable. Judge is **Claude** (Agent SDK structured
  model with defensive JSON extraction and deterministic dimension scoring).

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
`compare`/`--gate`/`promote` are implemented and tested. 465+ offline tests + typecheck green.


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

Known caveats: `run_meta.gitSha` is the MCP server version (e.g. `1.0.0`), not a commit; the `mas`
composed answer includes some orchestrator narration; the `expect:clarify` STOP path is verified in
single mode only. Hardening idea: replace the prompt-contract judge with an in-process
`record_verdict` SDK tool for guaranteed-schema output.

> **Historical baseline transitions:**
> - Baselines recorded before 2026-07-28 ran with the SDK default system prompt — the harness was
>   asking MCP for `default-chat`, which only ever served playbooks, and swallowing the error.
> - **V17 lockstep transition:** Playbooks are now self-contained and passed directly as the system prompt
>   (no `/api/chat/v1/prompts/system/*` composition). `systemPromptSha` now hashes the standalone playbook
>   text rather than `<basePrompt>\n\n---\n\n<playbook>`, so pre-V17 baselines will report a
>   `systemPromptSha` mismatch warning and should be re-promoted. Deploy this harness update in lockstep
>   with `yvoke-web` V17 and self-contained playbook content.

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
| **Claude Haiku 5.5** | `claude-haiku-5-5` | Pass `claude-haiku-5-5`, `haiku-5.5`, `haiku 5.5`, or bare `haiku` (canonicalizes to `claude-haiku-5-5`). |
| **Claude Sonnet 5.5** | `claude-sonnet-5-5` | Pass `claude-sonnet-5-5`, `sonnet-5.5`, `sonnet 5.5`, or bare `sonnet` (canonicalizes to `claude-sonnet-5-5`). |
| **Claude Opus 5.5** | `claude-opus-5-5` | Pass `claude-opus-5-5`, `opus-5.5`, `opus 5.5`, or bare `opus` (canonicalizes to `claude-opus-5-5`). |

The harness automatically extracts the concrete runtime model ID returned in the Anthropic Agent SDK's `system.init` message (`msg.model`) and records both the alias and resolved version in `run_meta.json`, `summary.md`, and `eval/runs/OVERVIEW.md`.

### Web Access Configuration (`web.allowedDomains`)

When evaluating playbooks that declare `WebSearch` or `WebFetch`, allowed domains are configured in `yvoke-eval.yaml`:

```yaml
web:
  allowedDomains:
    - docs.oneidentity.com
    - support.oneidentity.com
```

If `web.allowedDomains` is omitted or empty, web tool calls fail closed in `canUseTool`, ensuring eval runs only contact approved endpoints matching production policy.

> **Do not confuse `web.allowedDomains` with `answer.web.*`:** Top-level `web.allowedDomains` configures the outbound domain allow-list injected into the Claude Agent SDK's `WebSearch` / `WebFetch` tools (`--provider sdk`). By contrast, `answer.web.*` configures the `yvoke-web` HTTP chat answer provider (`--provider web`).

### Evaluating `yvoke-web` (`--provider web`)

`--provider web` drives `yvoke-web`'s HTTP chat endpoints directly in single-agent (`specialist`) mode and grades the normalized `MessageTraceDto` with the exact same signal extractor and Claude Judge used for SDK runs.

#### Required `yvoke-web` Server Settings & Auth

1. **Tool-call tracing (`APP_CHAT_TRACE_TOOL_CALLS=true`):** `yvoke-web` must run with `app.chat.trace-tool-calls=true` (`APP_CHAT_TRACE_TOOL_CALLS=true`) so `/chat/{id}/messages/{messageId}/trace` includes `toolCalls`. If `yvoke-web` emits tool banners or `retrievedChunkIds` with an empty `toolCalls` array, the harness aborts immediately with a `FatalRunError` rather than grading incomplete traces.
2. **Authentication (Mock Login vs. Session Cookie):**
   - **Local / Dev Mock Auth:** Start `yvoke-web` with `SPRING_PROFILES_ACTIVE=dev` and `APP_SECURITY_MOCK=true`. Omit `username`/`password` to use the default `admin`/`admin` mock login, or set both `answer.web.username` and `answer.web.password` explicitly.
   - **Pre-authenticated Session Cookie:** Set `answer.web.sessionCookie` (e.g. `${YVOKE_SESSION}`) for environments without mock form login. Empty interpolated credential strings fail fast at startup with a `UserError`.
3. **Trace Role Requirement:** The authenticated web user must hold `ROLE_ADMIN` or `ROLE_AREA_ADMIN` (verified during startup preflight against `/chat/{id}/messages/.../trace`).
4. **Allowed Models (`app.chat.allowed-models`):** Web model resolution follows `--answer-model <model>` > `answer.web.model` > `answer.model` (the `answer.model` fallback applies only when `answer.provider: web` is set in config and its value is not a bare SDK alias `sonnet`/`haiku`/`opus`; when overriding an SDK config from the CLI with `--provider web`, pass `--answer-model` or configure `answer.web.model`). Startup preflight verifies that `yvoke-web` accepts the resolved model on `POST /chat/{id}/model`.

#### Configuration (`answer.web.*`) & Playbook Scope

```yaml
answer:
  provider: web                # or pass --provider web on the CLI
  thinkingLevel: medium        # off -> mapped to 'minimal' for yvoke-web
  web:
    baseUrl: "${YVOKE_WEB_URL:http://localhost:8080}" # defaults to origin of mcp.serverBaseUrl
    model: gemini-3.8-flash    # or pass --answer-model <model>
    defaultPlaybook: oim-full  # fallback specialist playbook when a question has playbook: null
    # username: "${YVOKE_WEB_USER}"
    # password: "${YVOKE_WEB_PASSWORD}"
    # sessionCookie: "${YVOKE_SESSION}"
    pollIntervalMs: 500        # default 500 (must be > 0)
    questionTimeoutSec: 180    # default 180 (must be > 0)
    keepConversations: false   # default false (deletes per-question conversations after capture)
```

> **Playbook requirement & `defaultPlaybook` measurement note:** `yvoke-web` chat requires selecting a playbook prompt on `POST /chat/{id}/send-async`. Setting `answer.web.defaultPlaybook` routes un-annotated questions (`playbook: null`) through that specialist playbook's system prompt and collection scope rather than free/default chat (`results.json` still preserves the authored `question.playbook: null`).

#### Baseline Isolation & Provenance

- **Isolated default baseline (`./eval/baseline-web`):** `compare` and `promote` automatically route `web-single` runs to `./eval/baseline-web` (unless overridden via `--baseline`), preventing accidental cross-provider diffs against `./eval/baseline`.
- **Per-question correlation IDs (`results.json`):** Web runs record `webConversationId` and `webMessageId` on graded and errored rows (useful with `keepConversations: true` or server logs; omitted on SDK runs).
- **Web provenance (`run_meta.json` & `summary.md`):** In `run_meta.json`, web runs record `answerProvider: "web-single"`, `webBaseUrl`, first-seen `webServerVersion` (parsed from `<span class="build-version">` on `/chat` with `X-App-Version` / `X-Build-Version` header and `<meta name="app-version"|"build-version">` fallbacks; mid-run version drift warns once and keeps the initial version), `mcpServerBaseUrl`, `promptMetadataSource` (`"mcp"` when same-origin, `"mcp-cross-origin"` with conditional `mcpGitSha` when web and MCP origins differ), and `playbookVersion` strictly from the web message trace. `summary.md` renders `specialist (web)` mode, `web target` (with cross-origin note when applicable), plus `web server version`, `mcp git`, and `playbook version` when present.

#### Web CLI Examples

```bash
# Single question dry-run & live smoke run via eval.sh
./eval.sh run --provider web --answer-model gemini-3.8-flash --category getting_started --limit 1 --dry-run
./eval.sh run --provider web --answer-model gemini-3.8-flash --category getting_started --limit 1

# Target a separate/cross-origin yvoke-web instance explicitly via --web-url
./eval.sh run --provider web --answer-model gemini-3.8-flash --web-url http://localhost:9090 --category getting_started --limit 1

# Full category-by-category web sweep with per-category promotion into ./eval/baseline-web
./eval-all.sh --provider web --answer-model gemini-3.8-flash --promote ./eval/baseline-web
```

### Run Provenance & Metadata (`run_meta.json`)

Every evaluation run and category writes a `run_meta.json` containing complete provenance of the code, content, models, and prompts used during evaluation:

- `scoringVersion`: Eval scoring and extraction contract version (e.g. `'2.2'`).
- `harnessGitSha`: Git commit hash of `yvoke-eval` (with `-dirty` suffix if uncommitted modifications or untracked source files exist).
- `contentGitSha`: Git commit hash of the external content repo (`cfg.evalDir`).
- `systemPromptSha`: Scalar SHA-256 hash of the standalone playbook prompt text passed as the system prompt. Set to `null` when a run or category used multiple playbooks, ran in `mas` mode, or had no playbook.
- `systemPromptName` and `systemPromptFallback`: Retained as `null` and `false` on every run, category metadata, and `playbookPrompts` entry for backward schema compatibility with existing `run_meta.json` consumers and baselines.
- `playbookPrompts`: Map of prompt metadata per playbook (including `_no_playbook`) emitted in multi-playbook runs or mixed categories, used uniformly for both merged and category metadata.
- `_no_playbook`: Public documented key in `playbookPrompts` representing questions evaluated without a playbook (`systemPrompt: null`, running on the SDK default system prompt).
- `systemPromptShas` and `systemPromptVaried`: `systemPromptShas: string[]` and `systemPromptVaried: true` are emitted only when questions within a playbook or suite ran under multiple distinct prompt texts.

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
