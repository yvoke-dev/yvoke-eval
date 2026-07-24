# Eval modes — specialist, MAS, orchestration

The harness answers **three different evaluation questions**. They are not three ways of running the
same test — they target different levels of the system, and (will) use different signals and rubrics.

| Mode | The question it answers | Execution | Rubric | Status |
|---|---|---|---|---|
| **Specialist eval** | Is *one specialist agent* good — does it retrieve the right context and build a grounded, cited response? | `single` | answer-quality (6 dims) | ✅ Built |
| **MAS eval** | Is the *whole multi-agent system's* final composed answer good? (system as a black box) | `mas` | answer-quality (6 dims) | ✅ Built |
| **Orchestration eval** | Does the *orchestrator + reviewer coordinate* correctly — right delegation, effective reviewer, stop/round rules respected? (the controller, white box) | `mas` | orchestration (new) | 🟡 MVP built* |

\* MVP mechanism is built + unit-tested (`--eval orchestration`); **not yet trustworthy for scoring** — see Mode 3 §Status.

Why three and not two: **MAS eval** and **Orchestration eval** both run the `mas` mechanism, but they
score different things. MAS eval treats the system as a black box and grades the answer it produces.
Orchestration eval opens the box and grades *how* it got there. A MAS can produce a great answer while
the orchestrator delegated to the wrong specialist and the reviewer rubber-stamped — MAS eval passes,
orchestration eval fails. You want to see both.

> **One run, two scores.** A single `mas` execution trace can feed *both* MAS eval and orchestration
> eval — grade the composed answer (MAS) and the coordination process (orchestration) off the same
> run. No need to run the system twice.

---

## Mode 1 — Specialist eval  ✅

Evaluate a single specialist agent in isolation. This is what the old Spring Boot eval did.

- **Execution:** `run.mode: single`. One specialist playbook (prompt + tools from MCP), question in,
  answer out. No orchestrator, no reviewer.
- **Measures — the retrieval + response of *that* specialist:** right tools/collections (`routing`),
  grounded answer with real citations and no fabrication (`grounding`, `citations`, `no_fabrication`),
  coverage + correct clarify/redirect/refuse (`completeness`, `stop_rule`).
- **Signals:** `toolsFired`, `searchCollections`, `retrievedCollections`, `retrievedChunkCount`,
  `mustIncludeMissing`, `mustNotIncludePresent`, `hasCitations` ([`src/types.ts`](./src/types.ts)).
- **Rubric:** the 6 dimensions in [`src/reviewer/VerdictSchema.ts`](./src/reviewer/VerdictSchema.ts).

### Fleets are a sub-axis of specialist eval, not a mode

A knowledge base's specialist **fleets** are just *which* specialists you point Mode 1 at — same
eval, different roster/retrieval strategy. The One Identity Manager suite ships two:

- **pinpoint:** `search_corpus` on `… - Standard` collections → `chunk_id` citations.
- **browsing (top-down):** `<topic>-browsing` specialists use
  `list_documents → get_toc → get_section` on `… - Hierarchical` collections → `document_id` citations.

Run the same suite against each fleet and compare — an A/B of retrieval strategy, still Mode 1.
Citation-shape checks must be fleet-aware (`chunk_id` for pinpoint, `document_id` for browsing).

---

## Mode 2 — MAS eval  ✅

Evaluate the whole multi-agent system **as a black box**: run the orchestrator + specialists +
reviewer, and grade the **final composed answer** — exactly as you'd grade a specialist's answer, but
for the system's output. This is what `mas` mode does today.

- **Execution:** `run.mode: mas` (`MasAnswerRunner` + `orchestration.ts`). The composed answer is the
  orchestrator's main-thread text; retrieval/tool/chunk signals are harvested from all agents
  (including specialist sub-agents) for grounding/citation checks.
- **Measures:** the same answer-quality question as Mode 1, applied to the system's end-to-end output —
  is the *final* answer grounded, cited, complete, non-fabricated?
- **Rubric:** the same 6 dimensions. Deliberately answer-focused; it does **not** judge how the answer
  was coordinated (that's Mode 3).
- **Status:** built and smoke-verified. Like Mode 1, the only thing missing is operational: its own
  provider-scoped baseline (`eval/baseline-sdk-mas`).

---

## Mode 3 — Orchestration eval  🟡 (MVP built)

Evaluate the orchestrator and reviewer **as a system** — the coordination, not the answer.

### Status (built this pass)

The MVP mechanism is **implemented and unit-tested** — run it with `--eval orchestration` (or the
`orchestration` suite). What landed: delegation-trace capture (`orchestrationCapture.ts`, additive —
`capture.ts` untouched), orchestration signals (`OrchestrationSignalExtractor.ts`), a 3-dimension
rubric + judge (`OrchestrationVerdictSchema.ts` / `buildOrchestrationUserMessage.ts` /
`OrchestrationJudge.ts` / the content repo's orchestration rubric), the `run.eval` intent axis
(specialist|mas|orchestration) with its own `baseline-sdk-orchestration`, and per-question
`expected_specialists` / `expected_delegation` / `min_review_rounds` spec fields. All 64 prior tests
stay green; the design + implementation each went through an adversarial review pass. See
[docs/orchestration-eval-design.md](./docs/orchestration-eval-design.md).

**NOT yet trustworthy for scoring** — two gates remain (do not promote an orchestration baseline first):
1. **Author `expected_specialists`** for the ~84-question suite (else `delegation_routing` emits NA —
   fail-closed, never a vacuous PASS). ~1–2h.
2. **Trust gate:** record ONE real `mas` run and confirm the stream shape (the capture is built on an
   *assumed* shape — `Agent`/`Task` name, `input.subagent_type`/`input.prompt`, reviewer-verdict
   delivery — grounded in `orchestration.ts` but not yet verified live), then calibrate the grader.
   `synthesis_fidelity` stays deferred until that run proves specialist result-text attribution.

- **Execution:** `run.mode: mas` (same run as MAS eval; can be scored off the same trace).
- **Measures — orchestration behavior:**
  - **Delegation routing:** did the orchestrator delegate to the *right* specialist(s), and not
    over-/under-delegate?
  - **Reviewer effectiveness:** did the reviewer catch a weak/ungrounded draft and trigger a re-round,
    or approve a good one — rather than rubber-stamp?
  - **Coordination / termination:** were the round caps and stop rules respected (no runaway loop, no
    premature stop)?
  - **Synthesis:** did the orchestrator faithfully compose the specialists' outputs (vs. inventing or
    dropping content)?

### Why it isn't just "run mas and grade the answer" (that's Mode 2)

The answer-quality capture step **throws the delegation trace away**: delegation tool calls
(`Agent`/`Task`) are explicitly skipped in [`src/agent/capture.ts`](./src/agent/capture.ts)
(`if (DELEGATE_NAMES.has(name)) continue`) — so it alone can't see which specialists were invoked.
Mode 3 keeps `capture.ts` untouched and adds a **parallel** fold. What it required (all now
implemented in the MVP):

1. **Capture the delegation trace** (new). Stop discarding `Agent`/`Task` calls; record each
   delegation's target specialist (from `subagent_type` / input), ordering, round count, and each
   reviewer invocation + its verdict.
2. **Orchestration signals** (new, alongside `Signals`): e.g. `delegatedSpecialists[]`,
   `delegationCount`, `reviewRounds`, `reviewerVerdicts[]`.
3. **Per-question orchestration expectations** (new spec fields): e.g. `expectedSpecialists` /
   `expectedDelegation`, so routing can be judged against intent. Today `EvalQuestion` only names one
   `playbook` + `expectToolCalled` — enough for Modes 1–2, not for routing.
4. **An orchestration rubric** (new, separate from `VERDICT_SCHEMA`): dimensions like
   `delegation_routing`, `reviewer_behavior`, `coordination`/`termination`, `synthesis`. Kept distinct
   so a Mode-3 verdict is about the orchestration, not re-judging answer grounding (Mode 2 already
   does that).

---

## Proposed config shape (when Mode 3 lands)

Make the *evaluation intent* explicit rather than overloading the execution mechanism (**illustrative,
not yet implemented**):

```yaml
run:
  eval: specialist   # specialist | mas | orchestration   ← what we're measuring
  mode: single       # single | mas                       ← how the answer is produced
```

- `specialist` ⇒ `single` execution, answer rubric.
- `mas` ⇒ `mas` execution, answer rubric on the composed answer.
- `orchestration` ⇒ `mas` execution, orchestration signals + orchestration rubric.

`mas` and `orchestration` can be scored off the same `mas` run.

---

## Summary

- **Specialist eval** ✅ — "is this specialist good?" (leaf). Built; needs `baseline-sdk-single`.
- **MAS eval** ✅ — "is the system's final answer good?" (whole system, black box). Built; needs
  `baseline-sdk-mas`.
- **Orchestration eval** 🟡 — "does the orchestrator coordinate well?" (controller, white box). MVP
  built (`--eval orchestration`); before scoring, author `expected_specialists` and record one real
  `mas` run to verify the stream shape + calibrate the grader.
- Fleets (pinpoint vs browsing) are a sub-axis of specialist eval, not a mode.
