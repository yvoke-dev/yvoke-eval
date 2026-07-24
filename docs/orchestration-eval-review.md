# Orchestration Eval (Mode 3) — Adversarial Review Report

Scope: the orchestration-eval capture → signal-extraction → grader-prompt pipeline and its rubric. Eight findings survived verification (all CONFIRMED); two raised issues were dismissed as false-positives. No confirmed finding is a security or data-loss defect — the theme is *gradeability*: several rubric clauses instruct the judge to grade conditions for which no deterministic signal is ever surfaced, plus a few reachable edge-case bugs and coverage gaps.

---

## CONFIRMED findings

### 1. [HIGH] `coordination_termination` truncation/error failure mode is ungradeable
- **File:** `src/reviewer/buildOrchestrationUserMessage.ts` (+ `src/signals/OrchestrationSignalExtractor.ts`, `src/agent/OrchestrationTrace.ts`, `src/agent/orchestrationCapture.ts`, `src/types.ts`)
- **Problem:** `graders/oim-orchestration-reviewer.md` §2 tells the judge to **FAIL** when "the run was truncated / errored before finishing," but no truncation/error signal ever reaches the judge. `OrchestrationSignals` (types.ts:48-71) has no error/truncation/turn field; `buildOrchestrationUserMessage` renders `round_cap_respected` but never `numTurns`, `isError`, or the turn ceiling. `OrchestrationTrace` captures `numTurns` (orchestrationCapture.ts:86) but it is dead-ended, and `is_error` is never captured at all even though the result `StreamMessage` carries it (capture.ts:20). `round_cap_respected` only covers excess review rounds, not overall truncation/provider error. The design doc (§4, line 242) confirms the intended signals were `providerMeta.isError` + `numTurns` at ceiling — neither implemented. The judge is instructed to fail on a condition for which it has zero evidence, and is separately told not to re-grade from the answer text.
- **Fix:** Full fix — add `isError` to `OrchestrationTrace` and capture `msg.is_error` at the `result` message (mirror capture.ts:86); plumb the orchestrator turn ceiling (`orchestratorMaxTurns`) into `extractOrchestrationSignals` the same way `maxReviewRounds` is passed (runSuite.ts:118); derive `terminatedAbnormally = trace.isError === true || (numTurns != null && numTurns >= orchestratorMaxTurns)`; add it (plus `numTurns`/ceiling) to `OrchestrationSignals` and render it. Minimal fix — drop the "or the run was truncated / errored before finishing" clause from §2 so the grader isn't told to grade an absent signal.

### 2. [MEDIUM] `min_review_rounds` can be unsatisfiable with no guard or signal
- **File:** `src/signals/OrchestrationSignalExtractor.ts` / `src/specs/EvalSpecParser.ts`
- **Problem:** The orchestrator hard-caps review rounds at `maxReviewRounds` (orchestration.ts:87, default 2 via cli.ts:190), and `roundCapRespected = trace.reviewRounds <= maxReviewRounds` (OrchestrationSignalExtractor.ts:49). `min_review_rounds` is parsed (EvalSpecParser.ts:111) and shown to the judge (buildOrchestrationUserMessage.ts:23) but never compared against `maxReviewRounds` anywhere. The parser validates `expected_specialists` against the roster but has no analogous guard here. A `min_review_rounds: 3` question under the default cap of 2 can never reach 3 rounds, so `reviewer_effectiveness` and `coordination_termination` FAIL every run — and the grader message never emits the numeric `maxReviewRounds`, so the judge cannot even detect that the contract is impossible.
- **Fix:** In `extractOrchestrationSignals` (which already has both values), emit `minReviewRoundsSatisfiable = (minReviewRounds == null) || minReviewRounds <= maxReviewRounds`, add it to `OrchestrationSignals`, and surface it so the rubric can emit NA rather than FAIL. Optionally also fail loud where the cap is in scope (grade.ts/runSuite). Note: parse-time validation would require plumbing `maxReviewRounds` into `EvalSpecParser`, which currently doesn't receive it — the extractor is the cleaner fix site.

### 3. [MEDIUM] `min_review_rounds` satisfaction left to the LLM (asymmetry) + double-FAIL
- **File:** `src/signals/OrchestrationSignalExtractor.ts` (+ `graders/oim-orchestration-reviewer.md`)
- **Problem:** `roundCapRespected` is a pre-computed deterministic boolean, but there is no parallel `minReviewRoundsSatisfied`; the extractor never reads `question.minReviewRounds` (it is only rendered raw at buildOrchestrationUserMessage.ts:23). So the judge must do `review_rounds >= min_review_rounds` arithmetic itself across two lines — an asymmetry in a module whose stated purpose is deterministic, LLM-free signals. Separately, the same "min_review_rounds required but review_invoked=false" condition triggers FAIL under **both** §2 `coordination_termination` and §3 `reviewer_effectiveness`, double-counting one defect.
- **Fix:** Compute `minReviewRoundsSatisfied: boolean | null` (null when unset, else `trace.reviewRounds >= minReviewRounds`) parallel to `roundCapRespected`, add it to `OrchestrationSignals` and the user message. Assign the "required but not invoked" FAIL to exactly one dimension (keep it in §3 reviewer_effectiveness; scope §2 to round_cap/truncation only).

### 4. [MEDIUM] No focused unit test for the grader's prompt-builder
- **File:** `src/reviewer/buildOrchestrationUserMessage.ts`
- **Problem:** No `buildOrchestrationUserMessage.test.ts` exists. The file — the single "what the judge actually sees" builder — is exercised only indirectly by `OrchestrationJudge.test.ts` via three `.toContain` assertions on one happy-path fixture that avoids every conditional branch. Untested: the `expected_delegation` line (22), `min_review_rounds` line (23), `(UNAUTHORED — routing is NA)` annotation (21), `(no delegations)` empty branch (42), `verdict=UNPARSED` rendering (45), and prompt truncation (46-47). A regression in any of these silently changes the judge's input with no test failure.
- **Fix:** Add `test/buildOrchestrationUserMessage.test.ts` asserting each conditional line renders (and is omitted) as intended: authored vs unauthored specialists, present/absent `expected_delegation` and `min_review_rounds`, zero-delegation runs, and an unparsed reviewer verdict.

### 5. [LOW] Empty-string Task tool_result defeats the forwarded-text verdict fallback
- **File:** `src/agent/orchestrationCapture.ts`
- **Problem:** `stringifyToolResult` (capture.ts:122-132) returns `''` for content that is `''`, an empty array, an array of non-text blocks, or null. orchestrationCapture.ts:82 unconditionally assigns that to `a.toolResult`. Line 95 uses `a?.toolResult ?? (last forwarded text)`, but `??` only falls through on null/undefined, so `''` is retained (`'' ?? x === ''`), bypassing the fallback. The line-97 guard `if (d.isReviewer && source)` is then falsy, so `VERDICT_LINE.exec` never runs and a clean APPROVED/REJECTED line present in the forwarded sub-agent text is silently reported as UNPARSED (reviewerVerdictsUnparsed++). This contradicts the module's own documented intent (lines 90-92) that forwarded text is the fallback for a missing Task result.
- **Fix:** `const source = (a?.toolResult && a.toolResult.length > 0) ? a.toolResult : (a && a.text.length > 0 ? a.text[a.text.length - 1] : undefined);` — treat toolResult as the source only when non-empty. Also repairs `d.resultText` in the same edge case.

### 6. [LOW] Authored-but-empty `expected_specialists: []` renders inconsistent grader message
- **File:** `src/reviewer/buildOrchestrationUserMessage.ts` (line 21)
- **Problem:** The `(UNAUTHORED — routing is NA)` note is gated on `q.expectedSpecialists ? '' : ...`; an empty array is truthy in JS, so `[]` renders `expected_specialists: []` **without** the note. Meanwhile `OrchestrationSignalExtractor.ts:29` computes `hasExpected = Array.isArray(expected) && expected.length > 0`, so `[]` yields `hasExpected=false` → `delegated_to_expected_specialist: NA (unauthored)`. The two lines contradict each other in the same message. Reachable: `EvalSpecParser` `optStrList` (155-158) returns `[]` for an authored `expected_specialists: []`, and the `if (expectedSpecialists)` guard (line 98) is truthy for `[]`. (The common `undefined` case is handled correctly.)
- **Fix:** Gate on length: `${q.expectedSpecialists && q.expectedSpecialists.length > 0 ? '' : '   (UNAUTHORED — routing is NA)'}` (equivalently `q.expectedSpecialists?.length ? ...`), aligning the note with the extractor's `hasExpected` semantics.

> Note: findings 6 and the duplicate low-severity entry describe the same defect at line 21 from two angles; treat as one fix.

### 7. [LOW] Clarify-fallback trace preservation is untested
- **File:** `src/agent/MasAnswerRunner.ts`
- **Problem:** `run()` attaches `orchestration` at line 55, then the clarify branch (57-60) spreads `...bundle` — correct by construction, but no test covers a mas run that both requests clarification and needs its `OrchestrationTrace` preserved. The design doc (§6, lines 402-408 and 554-555) bolds attaching the trace *before* the clarify branch as load-bearing. `grep` finds zero test references to `MasAnswerRunner`; the clarify path is only covered at the primitive level. Because `run()` drives `query()`, the merge is integration-only, so a reorder regression would pass all existing tests.
- **Fix:** Extract the bundle-assembly/clarify-merge into a pure helper (e.g. `assembleBundle(base, orchestration, clarify?)`) and unit-test that when clarify is set the returned bundle has the `<clarifying-question>` answer **and** retains `orchestration`. Alternatively add the deferred integration snapshot (design Increment 13).

---

## Dismissed (false-positives)

- **Missing/empty `subagent_type` scored as a real specialist named `''`** (`orchestrationCapture.ts:53`) — *Dismissed.* The mechanism is present, but the triggering input is unreachable: a `tool_use` only reaches that line when its name is `Agent`/`Task` (the SDK Task delegation tool), for which `subagent_type` is a required argument. Fixtures and the orchestrator system prompt all set it; a malformed Task call missing the required arg is rejected by the SDK before a completed `tool_use` streams. Speculative input-hardening, not a reachable defect.

- **Missing `tool_use` ids collapse to literal `'undefined'` and alias/cross-attribute** (`orchestrationCapture.ts:55`) — *Dismissed.* The coercion mechanism is real, but `id` / `tool_use_id` are required API-contract fields always present on valid SDK traces; the claim itself concedes impact is limited to malformed/synthetic streams. Defensive hardening on unreachable input, not an actual bug.

---

## Resolution (all 8 fixed, 2026-07-24)

Every confirmed finding was fixed in the same pass; the two dismissed items were left alone (unreachable
input on SDK-required fields). Test count 90 → **103**, typecheck clean.

- **#1 (HIGH):** captured `is_error` into `OrchestrationTrace`; plumbed `orchestratorMaxTurns` into
  `extractOrchestrationSignals` (via an `OrchestrationCaps` object); added `numTurns` +
  `terminatedAbnormally` signals (rendered in the grader message); grader §2 now grades
  `terminated_abnormally` instead of an absent condition.
- **#2 + #3 (MEDIUM):** added deterministic `minReviewRoundsSatisfied` (null/true/false) and
  `minReviewRoundsSatisfiable` (false when `minReviewRounds > cap`); grader §3 emits **NA** on an
  impossible contract; the "required-but-not-invoked" FAIL now lives in exactly one dimension (§3), and
  §2 was scoped to round-cap/termination only (no more double-FAIL).
- **#4 (MEDIUM):** added `test/buildOrchestrationUserMessage.test.ts` covering every conditional line.
- **#5 (LOW):** empty (`''`) main-thread Task result now falls through to forwarded text (was retained
  by `??`); regression-tested.
- **#6 (LOW):** the `(UNAUTHORED — routing is NA)` note now gates on length, so `expected_specialists: []`
  renders consistently with the extractor's `hasExpected` semantics.
- **#7 (LOW):** extracted `assembleMasBundle` (pure) from `MasAnswerRunner.run` and unit-tested that the
  clarify fallback preserves the orchestration trace.

## Bottom line

8 confirmed findings (1 high, 3 medium, 4 low) — all fixed (see Resolution above). The high and both medium rubric findings share one root cause: the rubric asks the judge to grade termination/round conditions (truncation, error, `min_review_rounds`) that are never turned into deterministic signals — so the fixes cluster around plumbing `isError` / turn-ceiling / `minReviewRoundsSatisfiable` signals into `OrchestrationSignals` and reconciling the grader rubric. The low findings are two reachable edge-case bugs (empty tool_result, empty `expected_specialists: []`) and two test-coverage gaps.
