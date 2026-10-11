# yvoke-eval — Extraction & Redesign Plan (finalized)

> **Historical record (2026-07-28).** This is the plan as finalized, kept as-written. Three things have
> since changed and are *not* corrected below: eval content (suites, graders, baselines, runs) no
> longer lives in this repo but in a per-knowledge-base content repository selected with `--config`;
> the MCP server alias is `yvoke`, so tools are `mcp__yvoke__*` rather than `mcp__oim__*`; and §2's
> claim that the `default-chat` system prompt is fetched over MCP was simply wrong — it is not an MCP
> prompt, and the harness now reads it over REST from `/api/chat/v1/prompts/system/default-chat`
> (`SystemPromptClient`), which is also the one exception to "no server-side endpoints" below.
> See [README.md](./README.md) for the current shape.

Standalone **TypeScript** project at `/Users/eduardpal/work/yvoke/yvoke-eval`. Answers are produced
**only through the Claude Agent SDK** (single-agent, specialist, or MAS/orchestrator — exactly like
`yvoke-desktop`), connecting to the yvoke **MCP** server (`localhost:8080/mcp`) and loading **tools and
playbook prompts from MCP**. No server-side endpoints, no server-side persistence, no direct DB.
All eval data (specs, `runs/`, `baseline/`) lives **inside the new repo**.

### Locked decisions
1. **Language:** TypeScript-first, single Node tool (SDK runs natively, reuses desktop capture code).
2. **Answer path:** Claude Agent SDK only → MCP; tools + prompts loaded from MCP. Modes: `single`
   (any playbook, incl. a single specialist) and `mas` (orchestrator + specialists + reviewer). No
   `/api/eval/*` endpoint, nothing written to the server.
3. **Data location:** specs + `baseline/` + `runs/` vendored into `yvoke-eval/eval/`; that repo is the
   source of truth.

---

## 1. Pipeline

```
EvalSpecParser (eval_specs.yaml + eval_<cat>.md → EvalQuestion[])
  └─ McpPrompts.list()/getText()  → playbook template + tools[] + codeExecution   (from MCP)
  └─ per question:
       EvalTask = { systemPrompt = base + "\n\n---\n\n" + template, modelContent = question, allowedTools, thinking, … }
       AgentRun (Claude Agent SDK → MCP)   → AnswerBundle { answer, toolCalls, chunkIds, tokens, meta }
       SignalExtractor (trace-only, DB-free) → Signals
       Reviewer (Gemini structured judge)    → Verdict
  └─ ReportWriter → eval/runs/<UTC-ts>__<answerLabel>__<sutSha>/{run_meta,results,summary,eval_<cat>}
  └─ BaselineComparator (compare/gate/promote against eval/baseline/)
```

Only **answer production** is pluggable, and it's always the SDK — the "provider" is really a **run
mode** (`single` | `mas`). Everything downstream is mode-agnostic.

---

## 2. Answer path — Claude Agent SDK over MCP (reuses desktop verbatim)

**Loading tools + prompts from MCP** (`McpPrompts`, ported from desktop): `prompts/list` returns each
playbook's `name/title/description` + `meta.tools` + `meta.codeExecution`; `prompts/get` returns the
playbook **template text**. So the tool needs zero DB and zero hardcoded playbook data — it discovers
everything from the running server. The reviewer's `oim-eval-reviewer` prompt and the `default-chat`
system prompt are fetched the same way (MCP prompt if exposed; bundled fallback otherwise).

**`single` mode** (default; also how a lone specialist is evaluated): `query()` with `systemPrompt` =
`default-chat`, `mcpServers = { oim: { type:'http', url:`${base}/mcp`, headers:{Authorization:
`Bearer ${token}`} } }`, `allowedTools` = the playbook's tools (`mcp__oim__*` + policy extras),
`model`, `maxThinkingTokens = thinkingBudget(level)`, `settingSources:[]`, `cwd = sandbox`, `env =
sanitizedEnv()` (drops `ANTHROPIC_API_KEY` → Claude **subscription OAuth** from `~/.claude/`). The
prompt is an async generator yielding `{type:'user', message:{role:'user',
content: modelContent}, parent_tool_use_id:null}` (multi-turn runs in mas mode drive through `UserTurns`).

**`mas` mode**: `agent:'orchestrator'`, `agents` = `buildOrchestrator(profile)` (orchestrator +
specialists + reviewer `AgentDefinition`s with per-role Claude models), `forwardSubagentText:true`.
Proven end-to-end headless in `yvoke-desktop/scripts/spike-mas.ts` — that script is the reference
implementation for the eval runner's SDK wiring.

**Capture** (`translateMessage` + `TurnContext`, ported from desktop):
- `answer` = `turnText || result.result`.
- `toolCalls` = `ctx.toolCalls` (name with `mcp__oim__` stripped, input serialized to `argumentsJson`).
- `retrievedChunkIds` = `[chunk_id=UUID]` markers in `search_corpus`/`get_section` tool-results ∪ answer.
- tokens = `usageFromSdk(result.usage)`; `providerMeta = { sessionId, costUsd, numTurns, isError }`.
- `canUseTool` intercepts `ask_clarifying_question`: for `expect:clarify` it **denies** the tool but
  captures the question/options and emits the production `<clarifying-question>…</clarifying-question>`
  block as the answer, so unattended runs never hang and `stop_rule` grades identically.

**Two auth planes:** model = Claude subscription OAuth (preflight `detectClaudeCredentials()`, fail
fast with login instructions); server/MCP = bearer (`dev-local-token` now, Entra later). Independent.

---

## 3. Signals — trace-only, DB-free (the key change)

The old `SignalExtractor` used `JdbcTemplate` (`chunk→collection` SQL). We drop the DB entirely and
derive every signal from the SDK trace + MCP tool results:

| Signal | Source (no DB) |
|---|---|
| `toolsFired` | `tool_use` names (strip `mcp__oim__`) |
| `searchCollections` | `collection` arg of `search_corpus`/`search_graph_entities`/`get_graph_neighbors`/`query_json_objects`/`get_json_schema` |
| `retrievedCollections` | collection named in each `search_corpus` result header (`Searched **<collection>** for…`) — corpus search is single-collection-scoped, so header = retrieved collection |
| `retrievedChunkCount` | distinct `[chunk_id=UUID]` markers across `search_corpus` + `get_section` results |
| `mustIncludeMissing` / `mustNotIncludePresent` | case-insensitive substring checks on the answer |
| `hasCitations` | `[\d+]` marker or `## References` in the answer |

**Fidelity delta vs the old DB path:** a pure *browse/read* answer (only `get_section`, no
`search_corpus`) won't map its chunks to a collection name without the DB. Mitigation: for routing,
check `target` against `searchCollections ∪ retrievedCollections`; `get_section` firing already proves
a real document read (grounded), which the reviewer sees. If exact browse-collection routing ever
matters, add an **optional** read-only `pg` resolver later — off by default, honoring "just use MCP".

---

## 4. Reviewer — Claude judge by default, pluggable (one provider, one auth)

The judge is **Claude by default** (not Gemini) — same provider and auth as the answer path, so the
tool needs no `GEMINI_API_KEY` out of the box. The old harness used Gemini only because (a) in
yvoke-web's `LlmClient` abstraction only `GeminiLlmClient` honors `responseSchema`, and (b) cross-family
bias mitigation. Neither forces Gemini here: Claude produces guaranteed-schema output via **forced
tool-use**.

**The grader prompt is owned by this project, not the server.** Ownership split: the answer path is
the *system under test* (its playbooks/tools/prompts come from MCP), but the reviewer/grader is the
eval tool's *measuring instrument* → its rubric is a **version-controlled file in the repo**
(`graders/oim-eval-reviewer.md`), never loaded from the server. **Seed source:** the authoritative,
already-tuned export at `yvoke-icc/yvoke-web/exports/playbooks/oim-eval-reviewer.md` (the version that
graded the current baseline — richer than the Java `DEFAULT_PROMPT`); the loader strips YAML
frontmatter and uses the markdown body as the system prompt (`DEFAULT_PROMPT` remains a last-resort
fallback). This keeps verdicts attributable — a score can't shift because someone edited a `playbooks`
DB row. The grader file's checksum is recorded in `run_meta` (`graderPromptSha`); its path is config-
and per-suite-overridable.

A small `Judge` interface with two implementations, selected by config (`reviewer.provider:
claude | gemini`, default `claude`):
- **`ClaudeJudge` (default):** one Claude call (cleanest as a direct Anthropic Messages call — no MCP,
  no tool loop): `system` = the local `graders/oim-eval-reviewer.md`,
  `user` = the ported `buildUserMessage` (question + signals + answer), `tools:[{name:'record_verdict',
  input_schema: VERDICT_SCHEMA}]`, `tool_choice:{type:'tool',name:'record_verdict'}`, `temperature:0`
  → read `tool_use.input` as the verdict. Default model a **stronger tier than the answerer**
  (e.g. answer `sonnet` → judge `opus`) to blunt self-preference bias.
- **`GeminiJudge` (optional):** the verbatim port of today's reviewer (tool-less `generateContent`,
  `responseJsonSchema`, `seed:7`). Kept for **cross-family "second-opinion" / bias-audit** runs.

Both keep `VERDICT_SCHEMA` (6 dims × PASS|PARTIAL|FAIL|NA), `buildUserMessage`, and `parse` defaults
**verbatim** so verdicts stay comparable. Tradeoffs of the Claude default: some self-preference bias
(mitigated by the stronger judge tier + the deterministic signal gates that hard-gate the mechanical
archetypes), and **no `seed`** (Claude has none → reproducibility rests on `temperature:0`). The judge
needs **no** chunk text — only answer + signals + question meta → DB-free.

---

## 5. Artifacts & backward-compat

Same **schema and folder layout** as today (so `compare`/`promote`/existing readers keep working):
- `run_meta.json`: existing fields + additive `answerProvider` (`sdk-single`|`sdk-mas`), `sdkModel`,
  `sdkVersion`, `reviewerProvider`, and **`graderPromptSha`** (checksum of the in-repo grader file →
  verdict attributability). `gitSha` denotes the **SUT** (server `/mcp` build sha), not the eval repo.
- `results.json`: `EvalResult[]` with the exact nested `question/signals/verdict` field order.
- `summary.md`, `eval_<category>.md`: unchanged format.
- Folder `eval/runs/<UTC-ts>__<answerLabel>__<sutSha>/`; one folder per category by default,
  `--merge` for all-84.
- **Baselines are provider-scoped:** Claude-SDK answers differ from the old gemini-3.5-flash RAG
  baseline, so SDK runs promote to their own labeled baseline; the old baseline is kept as historical
  reference only. A **golden re-serialization test** locks the artifact format.

---

## 6. Configurability

Single `yvoke-eval.yaml` + `EVAL_*` env + CLI flags (precedence flags > env > file > defaults;
`${ENV}` interpolation; legacy env names preserved). Named **suites** = deep-merged config overlays.

```yaml
evalDir: ./eval                       # vendored into the repo
run: { mode: single, categories: [], limit: 0, merge: false }
answer: { model: sonnet, thinkingLevel: low }   # Claude model alias for the SDK
mcp: { serverBaseUrl: http://localhost:8080, transport: http, bearer: ${EVAL_BEARER:dev-local-token} }
mas:  { profile: null, orchestrator: {…}, reviewer: {…}, specialist: {…}, maxReviewRounds: 2, maxSpecialistCalls: 8 }
reviewer: { provider: claude, model: opus, temperature: 0.0, promptFile: ./graders/oim-eval-reviewer.md }  # provider: claude|gemini (gemini adds seed:7); grader lives in-repo, never from server
suites:
  smoke:   { run: { limit: 2 } }
  mas-full:{ run: { mode: mas, merge: true }, mas: { profile: OIM } }
```

**CLI:** `eval run [--config f] [--mode single|mas] [--suite S] [--category X…] [--limit N]
[--answer-model M] [--reviewer-model M] [--merge] [--dry-run]` · `eval compare --run <dir> [--gate]`
· `eval promote <run> [--category X]` · `eval list`.

---

## 7. Repo layout

```
yvoke-eval/
  package.json  tsconfig.json  README.md  yvoke-eval.yaml  .env.example
  src/
    cli.ts
    config/{loadConfig.ts,types.ts}
    specs/{EvalSpecParser.ts,EvalQuestion.ts}
    mcp/McpPrompts.ts                       # ported from desktop
    agent/
      AgentRun.ts                           # query() wiring for single + mas
      buildTask.ts                          # EvalTask (system prompt + playbook assembly lives here)
      capture.ts                            # AnswerBundle from the SDK stream
      vendor/                               # synced from yvoke-desktop (provenance header + sync script)
        translate.ts policy.ts orchestration.ts McpConnection.ts thinking.ts ClaudeAuth.ts types.ts
    signals/{SignalExtractor.ts,Signals.ts}
    reviewer/{Judge.ts,ClaudeJudge.ts,GeminiJudge.ts,VerdictSchema.ts,Verdict.ts,buildUserMessage.ts}
    report/{ReportWriter.ts,BaselineComparator.ts,EvalResult.ts}
    run/runSuite.ts
  graders/oim-eval-reviewer.md              # the grader rubric — owned & versioned HERE, not the server
  eval/                                     # VENDORED source-of-truth data
    eval_specs.yaml  eval_<category>.md×N
    runs/  baseline/{BASELINE.md,<category>/…}
  test/{golden/,fixtures/,*.test.ts}
```

**Desktop code reuse:** a `sync-desktop.sh` copies the six Electron-free modules + the needed
`shared/types` subset into `src/agent/vendor/` with a provenance header, rewriting imports and stubbing
the `log` shim. These modules (`translate`, `policy`, `orchestration`, `McpConnection`, `thinking`,
`ClaudeAuth`) are already Electron-free — the trickiest engineering task is just the import rewrite.

---

## 8. Phased build

- **P0 — Scaffold + vendor data.** Repo, `package.json`/`tsconfig`, config loader, copy the icc
  `eval/` (specs + baseline + runs) into `yvoke-eval/eval/`, and copy
  `exports/playbooks/oim-eval-reviewer.md` → `graders/oim-eval-reviewer.md`. Port `EvalSpecParser` +
  records. **Golden test:** re-serialize an existing `baseline/*/results.json` → assert schema/format
  parity.
- **P1 — Signals + reviewer offline.** `SignalExtractor` (trace-only) + `Reviewer` (Gemini) driven by
  **recorded `AnswerBundle` fixtures**; assert verdicts/signals match a hand-graded sample. No SUT yet.
- **P2 — SDK `single` mode.** Vendor desktop modules; `McpPrompts` + `AgentRun` + `capture`; run one
  category live against `localhost:8080`; `ReportWriter` writes a real run folder.
- **P3 — SDK `mas` mode.** `buildOrchestrator` wiring per `spike-mas.ts`; run one category; promote a
  provider-scoped baseline.
- **P4 — compare / gate / promote.** `BaselineComparator` (band diff; deterministic gates —
  `mustNotIncludePresent` hit = auto-FAIL — backstop the judge); `--gate` non-zero exit; `promote`
  copies into `baseline/<category>/` + updates `BASELINE.md`.
- **P5 — cutover.** Replace `run-eval.sh`; deprecate/remove the yvoke-web `eval` IT + Maven profile
  once parity is signed off; update steering docs + the `eval-automation` memory.

**First milestone:** P0 + P1 — parser, artifact format, signals, and the Gemini judge all working
**offline against fixtures**, before any live SDK run. De-risks format + reviewer independently of the
SUT.

---

## 9. Risks

- **Desktop vendor drift** → sync script + provenance header + a `typecheck` in CI; pin the
  `@anthropic-ai/claude-agent-sdk` version to the desktop's.
- **Browse-only routing fidelity** (§3 delta) → documented; optional read-only `pg` resolver later.
- **Non-determinism** → reviewer temp 0 + seed; answers compared as a band; optional majority-vote for
  `critical` items.
- **Two auth planes** → explicit preflight for both with clear errors.
```
