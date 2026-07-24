# Orchestration Eval (Mode 3) — Consolidated Design

**Status: MVP IMPLEMENTED** (increments 1–11). Delegation-trace capture, orchestration signals, the
3-dimension rubric + judge, spec fields, and run/CLI/config wiring are built and unit-tested (all 64
prior tests stay green; `--eval orchestration` runs end-to-end). **Increments 12–13 remain and gate
SCORING** (author `expected_specialists`; record one real `mas` run to verify the assumed stream shape
+ calibrate the grader — see §1 Trust gate, §9). Do not promote a `baseline-sdk-orchestration` before
Increment 13. Original plan status below.

**Design status:** vetted plan, implemented. Reconciles the original design with three
review lenses (delegation-extraction-correctness, backward-compat, completeness-and-rubric).
Where a critique overturned the design, the corrected decision is stated here and the
superseded version is called out inline so nothing is silently papered over.

**Repo:** `yvoke-eval` (TS harness). **Runtime gates:** `npm run typecheck` (`tsc --noEmit`)
**and** `npm test` (`vitest run`, currently 64 `it()` blocks). These are *separate* gates —
esbuild/vitest strips types without checking, so "tests green" does **not** imply
"typecheck green". Every increment below must keep **both** green.

---

## 1. Summary

Mode 3 scores the **coordination process** of the multi-agent system (MAS), not the answer.

- **Mode 2 — MAS eval (black-box):** grades the *composed answer* the orchestrator emits,
  using the existing `Signals` + `oim-eval-reviewer` rubric. Unchanged by this work.
- **Mode 3 — Orchestration eval (white-box):** grades *how* the orchestrator got there —
  did it delegate to the right specialist(s), invoke the reviewer, respect the round/stop
  rules, and faithfully synthesize what came back. Scored off the **same MAS trace** as
  Mode 2, but reading the delegation structure that `capture.ts` currently discards.

The pipeline is a **parallel track** that mirrors the existing one file-for-file:

```
MasAnswerRunner ──> AnswerBundle{ …, orchestration?: OrchestrationTrace }
                          │
                          ├─ (Mode 2) extractSignals ─> ClaudeJudge ─────────> EvalResult.verdict
                          └─ (Mode 3) extractOrchestrationSignals ─> OrchestrationJudge ─> EvalResult.orchestrationVerdict
```

**The whole feature is additive.** `bundleFromMessages`, `extractSignals`, `VerdictSchema`,
`buildUserMessage`, `gradeOne`, and every current `results.json` field are left untouched so
specialist eval, MAS eval, and all 64 vitest tests stay green. The **single** shared coupling
that must be broken is `parseVerdict`'s hard-coded `DIMENSIONS` constant, resolved by a
default-argument parameter (`parseVerdict(raw, dims = DIMENSIONS)`) that preserves every
existing caller.

### Two claims from the original design that are FALSE and are corrected here

1. **"Every `results.json` field stays byte-for-byte identical"** — only true if the new
   `EvalQuestion` fields are **optional** *and* the parser **omits absent keys** (conditional
   spread, not unconditional `strList`/`str`). `EvalResult` embeds the whole `question`, and
   `ReportWriter` serializes it verbatim; non-optional fields with concrete defaults (`[]`,
   `null`) are **not** omitted by `JSON.stringify` and would bump every question sub-object
   from 14 keys to 17, drifting the golden schema (`ReportWriter.test.ts` `QUESTION_KEYS`) and
   breaking any strict (Jackson `FAIL_ON_UNKNOWN_PROPERTIES`) consumer. See §5/§8.
2. **"Import `DELEGATE_NAMES` from `capture.ts`"** — impossible: `DELEGATE_NAMES` is a
   private, non-exported `const` (`capture.ts:35`). Importing it requires adding `export`,
   which edits `capture.ts` and voids the byte-identity guarantee. It is **re-declared
   locally** in `orchestrationCapture.ts` instead (intentional duplication). Only
   `REVIEWER_SUBAGENT` (genuinely exported from `orchestration.ts`) is imported.

### Trust gate (not a build gate)

The repo has **no recorded or synthetic real MAS trace**. The only delegation stream shape
lives inline in `capture.test.ts:118-165` and is itself synthetic, never verified against a
real SDK trace. Verification is therefore **circular** until a real run is recorded: green
tests prove internal consistency, not correctness against the live stream. Consequently:

- **Build & land** capture → signals → rubric → judge → wiring on the documented assumptions
  (fixtures-first).
- **Do NOT promote or trust** any orchestration verdict into a baseline until **one recorded
  real `mas` run** confirms the four load-bearing unknowns (§2, §9) and the deferred
  real-trace snapshot test passes. Recording that trace is a **first-class blocking
  milestone** for *scoring*, listed as Increment 12.

---

## 2. Delegation-trace capture

**New files:** `src/agent/OrchestrationTrace.ts` (types), `src/agent/orchestrationCapture.ts`
(logic). `capture.ts` is **not edited**.

### Stream shape: **ASSUMED — fixtures-first, unverified against a real SDK trace**

The following field names/locations are proven **only** by the synthetic inline fixture in
`capture.test.ts` and must be confirmed against one real `mas` run before scoring (§9):

| Assumption | Source of truth today | Guard |
|---|---|---|
| delegation `tool_use.name` is `'Agent'` (allow-list token is `'Task'`) | `capture.ts:34` comment + MEMORY | match **both** via local `DELEGATE_NAMES = new Set(['Agent','Task'])` |
| target specialist in `input.subagent_type` | synthetic fixture only | `String(input.subagent_type ?? '')` |
| delegated task in `input.prompt` | synthetic fixture only | optional field |
| sub-agent messages link back via `parent_tool_use_id === delegation.id` | `capture.ts:53`, fixture `:133/:144` | — |
| reviewer verdict first line `/^(APPROVED\|REJECTED)/` | `orchestration.ts` reviewer contract | scan (see below) |

A **top-of-fixture comment** in `test/fixtures.ts` must state plainly that these names are
ASSUMED and unverified.

### Topology fact that overturns the original data model

Only the orchestrator is granted the delegation tool. `orchestration.ts` gives
`ORCHESTRATOR_AGENT` the delegate token; specialists get `mapSpecialistTools()` and the
reviewer gets `REVIEWER_TOOLS` (`verify_citations`, `get_section`) — **neither includes
`Task`**. So **no sub-agent can delegate**: every real delegation has
`parent_tool_use_id === null`, and `parentId` is **always `undefined`** in the current
single-tier topology.

> **Superseded:** the original "nested/specialist-issued delegation" modeling and its test
> case 4 are **dropped**. `parentId` is retained on the type as unused future-proofing only;
> the capture test **asserts all captured delegations have `parentId === undefined`** rather
> than pinning a stream shape the system cannot produce.

### `orchestrationTraceFromMessages(messages: StreamMessage[]): OrchestrationTrace`

A single fold over the **same** `StreamMessage[]` `bundleFromMessages` sees, keeping what it
throws away:

1. **Delegations.** For each assistant `tool_use` whose name ∈ local `DELEGATE_NAMES`, push a
   `DelegationInvocation { id, subagentType: String(input.subagent_type ?? ''),
   prompt: input.prompt, order: delegations.length, parentId: undefined /* single-tier */,
   isReviewer: subagentType === REVIEWER_SUBAGENT }`. `order` = stream-arrival index.
   **Handle SDK parallel tool-calling:** multiple `tool_use` blocks in a *single* assistant
   message are each pushed in block order (a fixture case must exercise this — see §7).

2. **Attribution map.** Build `byDelegation: Map<delegationId, { text: string[]; toolResult?: string }>`:
   - Every sub-agent message (`parent_tool_use_id === delegationId`) contributes its
     **forwarded text** to `text[]`. **Exclude the reviewer's own tool-result text**
     (`verify_citations`/`get_section` outputs) so interim tool narration is not mistaken for
     the verdict.
   - Every **main-thread** `tool_result` whose `tool_use_id === delegationId` sets
     `toolResult` (this is the sub-agent's *final* text, when it exists).

3. **Result & verdict resolution** (after the fold), per delegation:
   - `resultText` = `toolResult` if present, else the **last** forwarded `text[]` block.
     (Whether specialist output arrives as a main-thread `tool_result` at all is
     **unverified** — §9 open question. When neither source is populated, `resultText`
     stays `undefined`.)
   - For **reviewer** delegations, derive `verdict` by scanning the verdict source for the
     **first line matching** `/^(APPROVED|REJECTED)/` **anywhere** in the text (not requiring
     line 1 to match).
     - **Preference order** (corrects the original "first non-empty line of all attributed
       content"): (a) main-thread `tool_result` for the reviewer delegation, which is the
       sub-agent's *final* turn; else (b) the **last** forwarded text block only. Never scan
       the reviewer's `verify_citations`/`get_section` tool-result text.
     - The reviewer runs multiple turns with tools; `forwardSubagentText:true` interleaves
       interim reasoning before the final verdict turn, so a naive "first line" grabs
       narration and yields `undefined`. The scan-anywhere + final-turn-preference fixes this.
     - If no line matches, leave `verdict` undefined **and** increment
       `reviewerVerdictsUnparsed` so the signal layer can tell "reviewer ran, verdict
       unreadable" apart from "clean verdict".

4. Compute `reviewRounds` = count of reviewer delegations; `specialistCallCount` = count of
   non-reviewer delegations; carry `numTurns` from the result message.

Reuse `stringifyToolResult` (already exported from `capture.ts`). Import only
`REVIEWER_SUBAGENT`.

### Backward-compat guardrail (a test, not a promise)

`bundleFromMessages(masDelegationStream())` must **still** yield `toolCalls` without any
`Agent`/`Task` entry and an `answer` free of sub-agent chatter — asserting `capture.ts`
is untouched (`capture.test.ts:161-162` behavior preserved).

---

## 3. Orchestration signals (deterministic, LLM-free)

**New file:** `src/signals/OrchestrationSignalExtractor.ts`. `SignalExtractor.ts` and the
7-field `Signals` path are **never edited**.

```ts
extractOrchestrationSignals(
  question: EvalQuestion,
  trace: OrchestrationTrace,
  maxReviewRounds: number,      // plumbed from cfg.mas.tuning — see below
): OrchestrationSignals
```

`OrchestrationSignals` (new interface in `types.ts`, next to `Signals`, never modifying it):

| field | derivation |
|---|---|
| `delegatedSpecialists: string[]` | distinct **non-reviewer** `subagentType`s |
| `delegationCount: number` | `trace.specialistCallCount` |
| `reviewRounds: number` | `trace.reviewRounds` |
| `reviewerVerdicts: ('APPROVED'\|'REJECTED')[]` | reviewer delegations' parsed verdicts, in order |
| `reviewerVerdictsUnparsed: number` | reviewer delegations whose verdict failed to parse |
| `reviewInvoked: boolean` | `reviewRounds > 0` |
| `clarifyRequested: boolean` | an `ask_clarifying_question` tool call was captured (see below) |
| `delegatedToExpectedSpecialist: boolean \| null` | see routing rule below |
| `unexpectedSpecialists: string[]` | `delegatedSpecialists` − `expectedSpecialists` **only when `expectedSpecialists` is set**, else `[]` |
| `redundantDelegations: number` | duplicate `subagentType` beyond first, computed over **non-reviewer** delegations only |
| `roundCapRespected: boolean` | `reviewRounds <= maxReviewRounds` |

**Routing rule (fail-closed, corrects the vacuous-PASS bug).** `expectedSpecialists.every(...)`
returns `true` on an empty array — a vacuous PASS that makes the flagship dimension inert for
the ~84 questions that don't yet author it. Instead:

- `expectedSpecialists` absent/empty ⇒ `delegatedToExpectedSpecialist = null` (→ dimension
  emits **NA**, never a vacuous PASS).
- otherwise ⇒ `expectedSpecialists.every(s => delegatedSpecialists.includes(s))`.

**Specialist-name vocabulary (corrects the wrong examples).** `subagentType` values are the
**exact playbook names** as listed under `mas.profiles.<profile>.specialists` in the content
repository's `yvoke-eval.yaml` — whatever naming convention that knowledge base uses (the One
Identity Manager suite prefixes them `oim-`, e.g. `oim-getting-started`). `expected_specialists`
MUST be authored with those exact strings. Short names (`access-governance`) or non-existent
names (`install-kit`) silently produce `delegatedToExpectedSpecialist=false` forever. A
**parse-time validation** (§5) fails loudly on any `expected_specialists` entry not in the
resolved profile's specialist list.

**`roundCapRespected` (corrects the broken formula).** The original
`reviewRounds <= (minReviewRounds != null ? Infinity : DEFAULT_CAP)` keys the *cap* off a
*minimum* and disables it whenever an expectation is set. The real cap is
`cfg.mas.tuning.maxReviewRounds` (= 2), which lives at runtime and is **plumbed into the
extractor** (threaded through `runSuite` alongside the trace). `minReviewRounds` is a separate
lower-bound assertion, used only by `reviewInvoked`/coordination checks — never as the cap.

**`clarifyRequested` (new capture, corrects the clarify blind spot).** ~21 clarify + 6 redirect
questions want the orchestrator to call `ask_clarifying_question` and **not** fan out. Capture
those tool-call invocations in the trace and expose `clarifyRequested`, so
`expected_delegation:'none'` can assert *zero specialist delegations AND `clarifyRequested`*.
Without this, ~25% of the suite is ungradable at the orchestration layer.

**Degenerate path:** an empty/undefined trace yields all-empty/false signals (all counts 0,
booleans false, `delegatedToExpectedSpecialist=null`).

---

## 4. Orchestration rubric + judge path

### Minimal viable rubric (MVP scoped down from the original 4 dimensions)

Each dimension emits `PASS|PARTIAL|FAIL|NA`; the top-level orchestration verdict emits
`PASS|PARTIAL|FAIL` (mirroring `VERDICT_SCHEMA`'s enum discipline). `ERROR`/`NA` are code-side
fallbacks only, never in the schema enum.

| dimension | what it grades | how it is graded | MVP status |
|---|---|---|---|
| **delegation_routing** | delegated to the right specialist(s) (`expectedSpecialists`), no over/under/disallowed delegation; for `expected_delegation:'none'` questions, no fan-out + `clarifyRequested` | signal-anchored: `delegatedToExpectedSpecialist`, `unexpectedSpecialists`, `clarifyRequested`. **NA** when `expectedSpecialists` unauthored. | **in**, but gated NA until authored |
| **coordination_termination** | round/stop rules respected: `roundCapRespected`, no premature stop (`minReviewRounds` required but `reviewRounds==0`), no error/max-turn truncation (`providerMeta.isError`, `numTurns` at ceiling) | signal-anchored. **Reframed** away from "runaway loop" (physically impossible — SDK hard-caps rounds and `orchestratorMaxTurns=60`) toward the failure modes that *do* occur: premature stop and truncation. | **in** |
| **reviewer_effectiveness** | **MVP: mechanical only** — reviewer invoked when `min_review_rounds` required it, and produced a parseable verdict | signal-anchored: `reviewInvoked`, `reviewRounds >= minReviewRounds`, `reviewerVerdictsUnparsed==0`. | **in (reduced)** |
| **synthesis_fidelity** | orchestrator faithfully composed specialists' returned evidence (no invented/dropped material), judged against delegation `resultText`s | LLM judge over `resultText`s. **Emits NA whenever no `resultText` was attributed** to non-reviewer delegations. | **DEFERRED out of MVP** until a real trace confirms `resultText` attribution |

**Two rubric corrections carried from the completeness lens:**

- **`reviewer_effectiveness` cannot judge "discriminate vs rubber-stamp"** from signals alone:
  a reviewer that approves everything is signal-identical to one that approves only good
  drafts, and the rubric forbids the judge from re-grading grounding (that's Mode 2). Judging
  "was the reviewer *right*?" would require cross-feeding the **Mode-2 answer-quality verdict**
  as ground truth. That cross-feed is **out of scope for the MVP**, so the dimension is reduced
  to the mechanical "invoked-when-required + parseable" check the signals *do* support. A
  post-MVP enhancement can feed the Mode-2 verdict into `buildOrchestrationUserMessage` to
  restore the discrimination check.
- **`synthesis_fidelity` is deferred, not merely "unverified."** Its only evidence source is
  `resultText`, whose delivery path is unproven on a real trace, and it structurally overlaps
  Mode 2's grounding check (double-counting risk despite the "do not re-grade" instruction).
  Ship it only after the capture pass demonstrably populates `resultText` for specialists on a
  live run.

**`expected_delegation:'parallel'|'sequential'` is NOT a scored deterministic signal in the
MVP.** `order` = stream-arrival index, and the SDK does not guarantee parallel delegations
arrive contiguously or in issue order. The spec field is retained as **informational, not
scored**, until real ordering evidence (timestamps / `tool_use` batching) is captured.

### Judge path (reuses the entire transport, unchanged)

**New files:** `OrchestrationVerdictSchema.ts`, `buildOrchestrationUserMessage.ts`,
`OrchestrationJudge.ts`, `graders/oim-orchestration-reviewer.md`. Reused **unchanged**:
`StructuredModel`, `AgentSdkStructuredModel` (schema-agnostic subscription-auth transport),
`jsonExtract`, `loadGrader`, `errorVerdict`, the `Verdict` type (`dimensions` is already
`Record<string,string>`).

- `OrchestrationVerdictSchema.ts` mirrors `VerdictSchema.ts`: `ORCH_DIMENSIONS` tuple,
  `ORCH_VERDICT_SCHEMA` (`verdict` enum `PASS|PARTIAL|FAIL`, `required=[...ORCH_DIMENSIONS]`,
  each dim `PASS|PARTIAL|FAIL|NA`), and `ORCH_VERDICT_CONTRACT` (flat-string prose contract —
  load-bearing because the Agent SDK judge has **no** schema binding and relies on
  `parseVerdict`'s flatness). `VerdictSchema.ts` is never touched.
- `buildOrchestrationUserMessage.ts` renders `## Question under test` (category/id, question,
  `expected_specialists`, `expected_delegation`, `min_review_rounds`) + `## Orchestration trace
  (already verified — trust these)` (the `OrchestrationSignals` lines + an ordered delegation
  list: order, subagentType, isReviewer, verdict, truncated prompt) + `## Composed answer`.
  `buildUserMessage.ts` stays hard-coded to the 7 specialist signals.
- `OrchestrationJudge.review({question, answer, orchestrationSignals, trace})` mirrors
  `ClaudeJudge`: `user = buildOrchestrationUserMessage(...) + '\n\n---\n' + ORCH_VERDICT_CONTRACT`;
  `model.complete({ system: orchestration grader prompt, toolName:'record_orchestration_verdict',
  schema: ORCH_VERDICT_SCHEMA, temperature: 0, maxTokens: 2048 })`; returns
  `parseVerdict(raw, ORCH_DIMENSIONS)`. A throw → `errorVerdict`.
- **The one shared edit:** `parseVerdict(raw)` → `parseVerdict(raw, dims: readonly string[] =
  DIMENSIONS)`, iterating `dims`. Default = `DIMENSIONS`, so `ClaudeJudge.review` and every
  existing `Judge.test.ts` call behave identically. This is the only edit to a file that has
  existing tests, and it is signature-compatible.
- `graders/oim-orchestration-reviewer.md`: instructs the judge to score **only** coordination
  (routing, reviewer invocation, coordination/termination, and — once un-deferred — synthesis)
  and **explicitly NOT** re-grade answer grounding/citations (Mode 2 owns that). New file, no
  Java counterpart, no committed baseline; wording needs a calibration pass (§9).

`maxTurns=4` in `AgentSdkStructuredModel` was tuned for the compact verdict rubric; the larger
orchestration user message could push a low-thinking grader against that ceiling. Watch for
truncated JSON during calibration; revisit the turn/token budget if it surfaces.

---

## 5. Per-question spec fields

All three are **OPTIONAL** on `EvalQuestion` and **opt-in** per question. Optional is
mandatory (not stylistic): two test files build full inline `EvalQuestion` literals **without**
`mkQuestion` (`compare.test.ts` `mkResult`, `promote.test.ts` `mkResult`); required fields
would make both literals incomplete and fail `tsc --noEmit` (TS2741) even though vitest stays
green.

```ts
// EvalQuestion, appended after expectToolCalled:
expectedSpecialists?: string[];       // exact subagent_type(s) to delegate to, as named in the profile
expectedDelegation?: string | null;   // 'none' | 'sequential' | 'parallel' — lenient, informational
minReviewRounds?: number | null;      // min reviewer rounds expected (e.g. 1 = reviewer consulted)
```

| YAML key | field | parser | default when absent |
|---|---|---|---|
| `expected_specialists` | `expectedSpecialists` | conditional `strList` (omit key if absent) | omitted |
| `expected_delegation` | `expectedDelegation` | conditional `str` (omit key if absent) | omitted |
| `min_review_rounds` | `minReviewRounds` | conditional new `num()` helper | omitted |

**Parser must OMIT absent keys** (conditional spread), not emit `[]`/`null` unconditionally —
so a non-opt-in question's serialized `question` sub-object stays **14 keys** and `results.json`
stays a superset (§8). Add the `num()` helper — `bool()` would silently swallow a number:

```ts
function num(m: Spec, k: string): number | null {
  const v = m[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
```

**Validation (fail loud).** At parse time (or a dedicated test), assert every
`expected_specialists` entry is a member of the resolved mas profile's specialist list, so a
short-name/typo fails at parse rather than silently scoring routing `false`.

**Authoring is a prerequisite, not opt-in flavor** (completeness lens). `delegation_routing`
is inert until `expected_specialists` is authored (currently 0/84). Budget one explicit
~1–2h pass over all ~84 questions:
- ~63 single-domain answer questions: mechanical `category → oim-<category>`.
- ~21 clarify + 6 redirect/routing questions: a human read of the existing `Expected:` prose
  (e.g. `ts_databases Q6` "redirect to Operations & Configuration" → `[oim-operations-config]`,
  and `expected_delegation:'none'`).
Until a question is authored, its routing dimension emits **NA** (never vacuous PASS).

Document the three keys in the `eval_specs.yaml` header comment block. Add them only to the
opt-in orchestration-relevant questions.

---

## 6. Run / CLI / config wiring + baseline scoping

An **evaluation-intent axis** (`specialist | mas | orchestration`) is added *orthogonally* to
the existing execution `mode` (`single | mas`). Intent forces execution mode and swaps the
grading path; it never touches the `produce` branches.

- **`EvalConfig.run.eval?: 'specialist'|'mas'|'orchestration'`** (`loadConfig.ts`), plus
  optional `reviewer.orchestrationPromptFile`. YAML passthrough, no parsing-logic change.
- **`--eval` CLI flag** (`cli.ts parseArgs`).
  `resolveEvalIntent(values,cfg) = values.eval ?? cfg.run?.eval ?? deriveFromMode(mode)`
  (`single→specialist`, `mas→mas`). Thread it into `cmdRun`, `cmdCompare`, **and** `cmdPromote`.
- **Force `mode='mas'` when `evalIntent==='orchestration'`**, *before* the `resolveMas`
  decision — so a missing `mas` profile throws the existing clear error.
- **`runSuite`:** add `evalIntent` to `RunConfig`. Keep the `produce` branch **keyed on
  `cfg.mode`** (orchestration reuses the `mas` branch / `MasAnswerRunner` unchanged). Select
  the **grading path** by `evalIntent`: orchestration ⇒ `OrchestrationJudge` +
  `gradeOrchestration`; specialist/mas ⇒ `ClaudeJudge` + `gradeOne` (identical to today). Load
  `graders/oim-orchestration-reviewer.md` for the orchestration grader. `answerProvider` stays
  `'sdk-mas'` (do not widen the union); add `evalIntent` as one additive key to `run_meta`.
- **Plumb `cfg.mas.tuning.maxReviewRounds`** through `runSuite` into
  `extractOrchestrationSignals` (alongside the trace) for `roundCapRespected`.

### Baseline scoping (precedence preserved)

A shared `baselineDefaultFor(intent)` helper, used by all three commands:
- `'./eval/baseline'` for **specialist AND mas** (unchanged), `'./eval/baseline-sdk-orchestration'`
  for orchestration — so orchestration verdicts never cross-contaminate the answer-quality
  baseline.
- **Precedence must stay exactly:** `values.baseline ?? cfg.baselineDir ?? baselineDefaultFor(intent)`
  — keep `cfg.baselineDir` in the chain or configs that pin a baseline dir silently break.
- If adding an intent-match check, treat **absent `run_meta.evalIntent` as the mode-derived
  intent** and only **warn** on mismatch — never gate. Every existing baseline `run_meta.json`
  on disk has no `evalIntent` key.
- Confirm the `baseline-sdk-orchestration` name matches the planned `baseline-sdk-single` /
  `baseline-sdk-mas` siblings in `MODES.md` before wiring `promote` (§9).

### Optional config overlay (no code beyond the config surface)

```yaml
suites:
  orchestration:
    run: { eval: orchestration, mode: mas, merge: true }
    mas: { profile: OIM }
    reviewer: { promptFile: ./graders/oim-orchestration-reviewer.md }
    baselineDir: ./eval/baseline-sdk-orchestration
```

### `MasAnswerRunner` wiring

After `bundleFromMessages(messages)`, also call `orchestrationTraceFromMessages(messages)` and
attach it to `bundle` **before** the clarify-fallback check, so `{ ...bundle, answer }` in that
branch carries `orchestration` through. Return type stays `AnswerBundle` (optional field
populated). `SdkAnswerRunner` is untouched → single-mode bundles have `orchestration`
undefined and `gradeOrchestration` is never invoked there.

### `gradeOrchestration` — required-field detail

`gradeOrchestration(question, bundle, judge, latencyMs): EvalResult`:
`extractOrchestrationSignals(question, bundle.orchestration ?? emptyTrace, maxReviewRounds)`
→ `judge.review(...)`. Never throws (try/catch → `errorVerdict`). The ORCH verdict is stored
on both `orchestrationVerdict` and `verdict`; `orchestrationSignals` holds the facts.

**Must populate the required `EvalResult.signals` field** with a **degenerate 7-field
`Signals`** (all arrays `[]`, counts 0, `hasCitations:false`) exactly as `gradeOne`'s error
branch and `runSuite.errorResult` already do. Leaving `signals` undefined fails `tsc` *and*
throws in `compare`'s `effectiveVerdict(r)` (`r.signals.mustNotIncludePresent.length`), breaking
`eval compare`/`promote` on the orchestration path. `gradeOne` is **not** modified.

---

## 7. Test plan (vitest, fixtures first)

**FIXTURES FIRST** — `test/fixtures.ts`. Add, with the ASSUMPTION comment at top:
`masDelegationStream(opts?: { reviewer?: 'APPROVED'|'REJECTED'; rounds?: number })`,
`mkTrace(partial)`, `mkOrchestrationSignals(partial)`. Model on `capture.test.ts:118-165`,
extended with a reviewer delegation (`name:'Agent'`, `input.subagent_type:'reviewer'`) whose
sub-agent messages carry `parent_tool_use_id === reviewer delegation id`. **Include an
interim-narration case**: reviewer emits interim text **and a `verify_citations` tool call**
*before* the `APPROVED`/`REJECTED` line, so the verdict scan is proven to skip narration and
tool-result text. **Include a parallel case**: two delegations as two `tool_use` blocks in a
**single** assistant message. Additive exports only; existing exports unchanged.

Then, tests **before** their implementation:

1. **`test/orchestrationCapture.test.ts`** —
   (a) records one specialist delegation with `subagentType`/`prompt`/`order`;
   (b) records the reviewer delegation `isReviewer=true` and recovers `verdict` **even with
   interim narration + a tool call before the verdict line**;
   (c) `reviewRounds` counts reviewer delegations, `specialistCallCount` the rest;
   (d) **all captured delegations have `parentId === undefined`** (single-tier topology);
   (e) parallel delegations in one assistant message both captured with distinct `order`;
   (f) **guardrail:** `bundleFromMessages(masDelegationStream())` still yields `toolCalls`
   with no `Agent`/`Task` entry and an `answer` with no sub-agent chatter.
2. **`test/OrchestrationSignalExtractor.test.ts`** — distinct reviewer-excluded
   `delegatedSpecialists`; `delegatedToExpectedSpecialist` `true` when `⊆`, `false` on a miss,
   **`null` when `expectedSpecialists` empty**; `reviewerVerdicts` in order;
   `reviewerVerdictsUnparsed` counts parse misses; `clarifyRequested` reflects an
   `ask_clarifying_question` call; `redundantDelegations` over non-reviewer only;
   `roundCapRespected` uses the passed `maxReviewRounds`; empty-trace ⇒ all-empty/false/null.
3. **`test/Judge.test.ts` (extend additively)** — `parseVerdict(raw, ORCH_DIMENSIONS)` fills
   exactly the ORCH dims and defaults missing to `NA`; existing `parseVerdict(raw)` (default
   `DIMENSIONS`) calls stay green (proves the default-arg backward-compat).
4. **`test/OrchestrationJudge.test.ts`** — with a fake `StructuredModel`, `review()` sends
   `toolName:'record_orchestration_verdict'` and a user message containing
   `## Orchestration trace` + the ordered delegation list; returns the parsed ORCH verdict; a
   throwing model ⇒ `errorVerdict`.
5. **`test/grade.orchestration.test.ts`** — `gradeOrchestration` with a fake judge assembles an
   `EvalResult` carrying `orchestrationSignals` + `orchestrationVerdict` **and a degenerate
   `signals`**; a throwing judge ⇒ ERROR verdict, never throws.
6. **`test/EvalSpecParser.test.ts` (extend)** — a question with the three keys parses to the
   right values; a question **without** them yields a `question` object with **no** new keys
   (14-key shape); `expected_specialists` with an unknown name **fails loudly**; the existing
   "parses the full vendored suite" counts are unchanged.
7. **Whole-suite gate:** after every increment, run **both** `npm run typecheck` and
   `npm test`; confirm 0 regressions against the current 64 `it()` blocks.
8. **Deferred (Increment 12, not a unit test):** once one real `mas` run is recorded, snapshot
   its `StreamMessage[]` and re-run `orchestrationCapture.test.ts` against the **real** shape to
   retire the synthetic-fixture open questions.

---

## 8. Backward-compat guarantees

| Surface | Guarantee | How |
|---|---|---|
| **64 vitest tests** | 0 regressions | all new files ADD tests; only signature-compatible edit is `parseVerdict`'s default arg |
| **`npm run typecheck`** | stays green | new `EvalQuestion` fields are **optional** → inline `mkResult` literals in `compare.test.ts`/`promote.test.ts` stay valid; `gradeOrchestration` populates required `EvalResult.signals` |
| **`results.json` schema** | non-opt-in questions stay **14-key** | fields optional **and** parser omits absent keys (conditional spread). Opting a question in adds its keys to that question's record across all intents — an accepted, deliberate, local change |
| **`ReportWriter.test.ts` `QUESTION_KEYS`** | unchanged for non-opt-in data | absent key → `undefined` → omitted by `JSON.stringify` |
| **specialist / MAS eval verdicts** | byte-identical | `bundleFromMessages`, `extractSignals`, `Signals`, `VerdictSchema`, `buildUserMessage`, `oim-eval-reviewer.md`, `gradeOne`, `ClaudeJudge` all untouched |
| **`capture.ts`** | byte-for-byte identical | `DELEGATE_NAMES` re-declared locally (not imported); capture logic lives in the new file |
| **`compare` / `promote` for existing intents** | identical | precedence `values.baseline ?? cfg.baselineDir ?? baselineDefaultFor(intent)`; `baselineDefaultFor` returns `./eval/baseline` for specialist+mas; absent `run_meta.evalIntent` → mode-derived, warn-not-gate |
| **`run_meta` / `answerProvider`** | supersets only | `evalIntent` appended; `answerProvider` union not widened (`'sdk-mas'` for orchestration) |

> **Dropped claim:** "byte-for-byte identical `results.json`" is **not** achievable when a
> question opts into the new keys — that question's record legitimately gains them. The
> guarantee is precise: **non-opt-in** questions are unchanged; opting in is a local, intended
> addition. If instead always-present fields are ever desired, that is a deliberate schema
> bump requiring a `QUESTION_KEYS` update + baseline regeneration + a check for strict
> consumers.

---

## 9. Open questions / unverified assumptions (carry forward)

**Blocking for TRUST/SCORING (not for build):**

1. **Stream field names** — `subagent_type` / `prompt` proven only by synthetic fixture.
   Confirm against one real `mas` run.
2. **Reviewer verdict delivery location** — forwarded sub-agent text (final turn) vs main-thread
   Task `tool_result`. Capture attributes **both** defensively (final-turn preference); a real
   trace must confirm which carries the `APPROVED`/`REJECTED` line, especially given the
   reviewer's own `verify_citations`/`get_section` interim output.
3. **Specialist result attribution** — whether specialist output arrives as a main-thread Task
   `tool_result` at all, or only as forwarded sub-agent text. Directly gates
   `synthesis_fidelity` (deferred until this is confirmed; emits NA when `resultText` absent).
4. **Round/parallelism reconstruction** — `order` = stream-arrival index approximates rounds;
   the SDK may not deliver parallel delegations contiguously/in issue order. `expected_delegation`
   stays informational-only until real ordering evidence exists.

**Design decisions to confirm:**

5. **`maxReviewRounds` source** — resolved from `cfg.mas.tuning`; confirm it is the intended cap
   (vs a per-question value). Plumbing is specified (§6); the value's authority is not yet
   ratified.
6. **`expected_delegation` vocabulary** — confirm allowed values (`none|sequential|parallel`)
   and that only `none` is deterministically enforced (via `clarifyRequested` + zero fan-out) in
   the MVP.
7. **Baseline dir name** — `./eval/baseline-sdk-orchestration`; confirm it matches the planned
   `baseline-sdk-single` / `baseline-sdk-mas` naming in `MODES.md`.
8. **Grader rubric content** — `graders/oim-orchestration-reviewer.md` is new, no Java
   counterpart, no committed baseline. Its wording (esp. the explicit "do NOT re-grade
   grounding/citations") needs review + a calibration run before verdicts are trusted. The
   first N orchestration runs are **calibration-only**: human-review verdicts, commit them as
   `./eval/baseline-sdk-orchestration`, only then treat orchestration verdicts as gate-eligible.
9. **Vendored `eval_specs.yaml` / Java parity** — confirm the Java `EvalSpecParser` ignores
   unknown YAML keys (lenient, like the TS side) before adding keys to any shared/vendored copy;
   if the copy is TS-only, note that so no one round-trips it back to the Java repo.

---

## Increment list (execute top-to-bottom)

Each increment ends with **both** `npm run typecheck` and `npm test` green.

1. **Fixtures-first.** `test/fixtures.ts`: add `masDelegationStream(opts)` (with reviewer
   delegation, interim-narration case, parallel-in-one-message case), `mkTrace`,
   `mkOrchestrationSignals`, and the top-of-file ASSUMPTION comment. Compiles; nothing to
   assert yet.
2. **Trace types.** `src/agent/OrchestrationTrace.ts`: `DelegationInvocation` (incl.
   `isReviewer`, `resultText?`, `verdict?`, `parentId?` future-proof-only) and
   `OrchestrationTrace` (`delegations`, `reviewRounds`, `specialistCallCount`, `numTurns?`,
   plus a `reviewerVerdictsUnparsed` carrier or compute it in signals).
3. **Capture (a).** Write `test/orchestrationCapture.test.ts` (cases a–f, §7), then
   `src/agent/orchestrationCapture.ts`: local `DELEGATE_NAMES`, import only `REVIEWER_SUBAGENT`,
   reuse `stringifyToolResult`; verdict scan with final-turn preference + scan-anywhere +
   reviewer-tool-result exclusion; `parentId` always undefined; capture
   `ask_clarifying_question`.
4. **Bundle field.** `AnswerBundle.ts`: add optional `orchestration?: OrchestrationTrace`.
5. **Runner wiring.** `MasAnswerRunner.ts`: attach the trace to `bundle` **before** the
   clarify-fallback branch.
6. **Signal types + extractor (b).** `types.ts`: add `OrchestrationSignals` (next to `Signals`)
   and optional `EvalResult.orchestrationSignals?` / `orchestrationVerdict?` (appended). Write
   `test/OrchestrationSignalExtractor.test.ts`, then
   `src/signals/OrchestrationSignalExtractor.ts` (routing NA-not-vacuous, `maxReviewRounds`
   param, `redundantDelegations` non-reviewer-only, `clarifyRequested`, `reviewerVerdictsUnparsed`).
7. **parseVerdict param (c).** Extend `test/Judge.test.ts` for
   `parseVerdict(raw, ORCH_DIMENSIONS)`, then change `parseVerdict(raw, dims = DIMENSIONS)` in
   `Judge.ts`.
8. **Rubric + judge (c).** `OrchestrationVerdictSchema.ts`, `buildOrchestrationUserMessage.ts`,
   `graders/oim-orchestration-reviewer.md`; write `test/OrchestrationJudge.test.ts`, then
   `OrchestrationJudge.ts`.
9. **Grade seam (c/e).** Write `test/grade.orchestration.test.ts` (asserts degenerate `signals`
   populated), then add `gradeOrchestration` to `grade.ts` (`gradeOne` untouched).
10. **Spec fields (d).** Append optional fields to `EvalQuestion`; add `num()` helper +
    conditional (omit-absent) reads to `EvalSpecParser.ts`; add the profile-membership
    validation for `expected_specialists`; extend `test/EvalSpecParser.test.ts` (incl. 14-key
    shape for non-opt-in + loud failure on unknown specialist). No `mkQuestion` change needed
    (fields optional).
11. **Run/CLI/config + baseline (e).** `loadConfig.ts` (`run.eval`,
    `reviewer.orchestrationPromptFile`); `runSuite.ts` (`evalIntent`, force mas, grade-path
    switch, plumb `maxReviewRounds`, `evalIntent` in `run_meta`); `cli.ts` (`--eval`,
    `resolveEvalIntent`, `baselineDefaultFor`, precedence preserved, threaded into
    run/compare/promote); optional `suites.orchestration` overlay in `yvoke-eval.yaml`.
12. **Author `expected_specialists`** for the ~84-question suite (the ~1–2h pass, §5) with
    the exact specialist names from the profile; document the keys in the `eval_specs.yaml` header.
13. **TRUST GATE — record one real `mas` run** (§1, §9). Snapshot its `StreamMessage[]` as the
    canonical fixture, add the real-trace snapshot test, retire open questions 1–4, and
    un-defer `synthesis_fidelity` only if `resultText` attribution is confirmed. Then run the
    calibration passes and commit `./eval/baseline-sdk-orchestration`. **No orchestration
    verdict is promoted/trusted before this increment completes.**
