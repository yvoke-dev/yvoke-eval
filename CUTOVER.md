# Cutover — retiring the yvoke-web eval IT

> **Historical record (2026-07-28).** The cutover is complete: the yvoke-web harness is gone and
> yvoke-eval is the sole one. Kept as-written, so two things below are now false — eval content and
> the grader rubrics no longer live in this repo (they moved to a per-knowledge-base content
> repository), and every command here predates `--config` and will fail without it.
> See [README.md](./README.md) for the current shape.

`yvoke-eval` replaces the in-repo Spring Boot eval harness. This is the plan to switch over. **Do not
delete the old harness until the parity checklist below is signed off** — the new tool is smoke-verified
(one question per mode) but has not yet been run across the full 84-question suite.

## What replaces what

| Old (yvoke-web) | New (yvoke-eval) |
|---|---|
| `./run-eval.sh` | `npm run eval -- run` |
| `EVAL_ANSWER_MODEL=x ./run-eval.sh` | `npm run eval -- run --answer-model x` *(x is now a Claude alias, e.g. `sonnet`)* |
| `EVAL_CATEGORY=c EVAL_LIMIT=n` | `--category c --limit n` |
| `EVAL_REVIEWER_MODEL=m` | `--reviewer-model m` *(Claude alias; Gemini optional via `reviewer.provider`)* |
| `-Peval` Maven profile / `EvalRunnerIT` | the `run` command (no Spring, no live DB) |
| *(none)* | `--mode mas`, `compare --gate`, `promote` |

**Behavioural differences to expect (by design):**
- **Answers now come from the Claude Agent SDK over MCP**, not `RagService` with `gemini-3.5-flash`.
  Different answer distribution → SDK runs get their **own** provider-scoped baseline; do not diff them
  against the vendored `gemini-3.5-flash` baseline.
- **Signals are trace-derived, DB-free.** A pure `get_section` browse answer won't map to a collection
  name (documented delta).
- **Grader is Claude (subscription auth), owned in-repo** (`graders/oim-eval-reviewer.md`), no bound
  responseSchema (prompt-contract + tolerant parse instead of Gemini's schema binding).
- The eval **content is vendored here** (`eval/`); the icc `eval/` copy becomes historical.

## Parity checklist (do before removing the old harness)

1. App up at `localhost:8080` (populated DB), signed in via `claude /login`.
2. Full single-mode run: `npm run eval -- run` → writes one folder per category under `eval/runs/`.
3. Establish the SDK baseline: `npm run eval -- promote <run> --baseline ./eval/baseline-sdk-single`
   for each category (or promote a merged run).
4. Hand-review a sample of verdicts against `graders/oim-eval-reviewer.md`; tune the rubric if needed.
5. (Optional) `--mode mas` run + its own `./eval/baseline-sdk-mas`.
6. Confirm coverage: parse ✓, answer ✓, signals ✓, judge ✓, report ✓, plus compare/gate/promote the
   old harness never had.
7. Wire CI to `npm test` + `npm run eval -- compare --run <latest> --baseline ./eval/baseline-sdk-single --gate`.

## Removal list (yvoke-web) — only after the checklist passes

- `src/it/java/de/palsoftware/yvoke/eval/` — all 10 files (`EvalRunnerIT`, `EvalSpecParser`,
  `SignalExtractor`, `ReviewerService`, `ReportWriter`, `VerdictSchema`, `EvalQuestion`, `EvalResult`,
  `Signals`, `Verdict`).
- `run-eval.sh`.
- The `eval` profile in `pom.xml` (and the now-moot `<excludedGroups>eval</excludedGroups>` if nothing
  else uses the `eval` tag).
- The `app.eval.*` block in `src/main/resources/application.yml`.
- Docs to update: `CLAUDE.md` + `.agents/AGENTS.md` (eval instructions), `.antigravity/steering/*`,
  and the icc `eval/AUTOMATION_PLAN.md` (mark superseded).

The `oim-eval-reviewer` playbook row in the DB is no longer used by the eval path after cutover (the
grader now lives here); it can stay for reference.

## Status

- ✅ **yvoke-web eval harness fully removed** (2026-07-23, on request): the `..eval` IT package (10
  files), `run-eval.sh`, the Maven `eval` profile + the `<excludedGroups>eval</excludedGroups>` line,
  the `app.eval.*` block in `application.yml`, and the `EVAL_LIVE_DB`/`EVAL_DATASOURCE_URL` branch in
  `PostgresTestContainerInitializer`. Verified: no eval references remain; pom is valid XML;
  application.yml is valid YAML; the shared IT initializer still compiles (Testcontainers path intact).
  Changes are uncommitted in the yvoke-web working tree.
- ⏳ Recommended next: run the full-suite parity pass (checklist above) to establish an SDK-provider
  baseline before wiring CI to `compare --gate`. `yvoke-eval` is now the only eval harness.
