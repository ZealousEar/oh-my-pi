# 04 — Subagents, hub waits, and reasoning effort

Source: 1,261 session and subagent transcripts modified in the 24 days to 2026-09-17 (`~/.omp/agent/sessions/**/*.jsonl`, advisor transcripts excluded). 83,637 assistant turns: 44,061 main, 39,572 subagent; 15.1 B tokens. Tables: `data/24d-*.csv`, `data/sim-subagent-caps.csv`. External review: `consults/02-astra-effort-answer.md`.

Turn classes are by the tools called: `hub-only` (only `hub`), `todo-only`, `read/search` (read/grep/glob), `bash/eval`, `edit/write` (any edit), `text-only` (no tool), `task-spawn`.

## Where main-session context goes

| class | turns | context | output | ctx per output token |
|---|---|---|---|---|
| bash/eval | 16,616 | 3.97 B (43 %) | 10.5 M | 379 |
| read/search | 11,044 | 1.84 B (20 %) | 3.5 M | 519 |
| edit/write | 5,490 | 1.31 B (14 %) | 6.8 M | 193 |
| **hub-only** | 3,492 | **0.87 B (9 %)** | 1.1 M | **810** |
| text-only | 2,919 | 0.53 B | 2.5 M | 215 |
| todo-only | 1,346 | 0.25 B | 0.4 M | 623 |
| task-spawn | 339 | 0.07 B | 1.0 M | 73 |

`hub` ops inside hub-only turns: wait 2,202, send 651, start 195, logs 181, jobs 135. In the >400k sessions, 462 main turns were a lone `hub` call (183 M tokens) and 339 of 638 hub results were under 300 chars — "nothing yet". Delivery is already push (`agent-session.ts:1317` registers an `async-result` yield-queue sink; completions inject as follow-up turns); the waste is the coordinator issuing finite-timeout `wait`s that each cost a full-context turn.

## Reasoning effort

On Codex, `reasoningTokens` averages ~100 per turn (≤1 % of tokens). On Anthropic, thinking is inside output, and output is 14 % of nominal spend. Median Anthropic output (incl. thinking) per turn by class × configured thinking level:

| class | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| hub-only | 133 | 136 | 139 | 139 | 136 |
| todo-only | 97 | 150 | 165 | 209 | 290 |
| read/search | 185 | 185 | 249 | 231 | 209 |
| bash/eval | 376 | 407 | 456 | 543 | 659 |
| edit/write | 684 | 697 | 765 | 1,096 | 722 |
| text-only | 452 | 624 | 855 | 963 | 994 |

Main turns by level: low 2,412 / medium 11,875 / high 9,037 / xhigh 4,361 / **max 14,923 (2.98 B ctx)**.

Findings:
- Effort is flat on hub-only turns (the model doesn't think about a wait regardless of setting) and rises where work happens (bash/eval +75 %, text-only +120 % low→max).
- 2,043 hub/todo-only turns ran at xhigh/max: 0.43 B context, 0.63 M output. Eliminating *all* their output saves 0.004 % of tokens. **Thinking level is not a cost lever; the existence of the turn is.**
- No quality observation is possible from telemetry; the reviewer declined to recommend blanket lower effort.

## Subagents

853 runs with a parent transcript in the window.

| | p50 | p90 | max |
|---|---|---|---|
| turns per run | 31 | 92 | 639 |
| tokens per run | 2.15 M | 15.2 M | 238 M |
| wall time | 7 min | 45 min | 849 min |
| final yield payload | 3.5k chars | 18.5k | 61k |

- Subagents are 39 % of context but 56 % of all output; **ctx per output token 167 vs 335 for main** — half the replay cost.
- Fresh start: median first-turn context 11k vs 161k parent context at spawn.
- Duplication is low: subagents re-read 12 % of files the parent already had (58 of 756 runs ≥ 50 %, 0.24 B); parents re-read 7 % of subagent files afterwards (24 runs, 0.13 B).
- Small delegations are not a problem: 82 runs ≤ 8 turns = 23 M tokens (0.15 %).
- Spawn batch sizes: 1 → 126 calls, 2 → 113, 3 → 51, 4 → 31, 5+ → 33. 36 % of calls had no fan-out (isolation only), which is legitimate.

Where they stop being subagents:
- **87 runs > 90 turns = 3.40 B of 5.84 B subagent tokens (58 %), 22.6 % of everything.** `CampaignInfra` 639 turns / 238 M; `DefenseTrace` 437 / 196 M; `FieldEstimator` 433 / 174 M; `TeacherProtocol` 332 / 144 M — all `claude-opus-5`, all ChessBot. They inherit the 850k threshold, so they are main sessions with a badge.
- 81 runs > 2 M tokens returned < 800 chars (0.74 B). `NNUEEval` 41 M → empty yield; `AuthorityReview` 29 M → 32 chars. Value may have shipped via files/hub; the transcript doesn't show it.
- 48 runs with no yield at all (0.18 B).

Inline counterfactual (reviewer's arithmetic): the same 39.6k subtask turns run inline carrying the parent's extra 150k would have cost ≈ 11.8 B vs 5.84 B observed — isolation plausibly saved ~6 B, but the realised saving is unidentified without a completed-work comparison.

## Cap simulation on the 456 subagent runs from the 14-day window

Method (`scripts/analyze.py::sim_sub`): replay per-run context growth; a context cap resets to 12k + tail (in-subagent compaction); a turn cap forces a handoff to a successor starting at 12k + 8k and pays P steps of extra growth (LangWatch's measured rediscovery penalty P = 28; their conservative 55).

| policy | tokens | Δ | compactions | handoffs | runs touched |
|---|---|---|---|---|---|
| none | 2.35 B | — | 0 | 0 | 0 |
| **ctx 96k / 24k** | 1.17 B | **−50 %** | 544 | 0 | 264 |
| **ctx 150k / 32k** | 1.58 B | **−33 %** | 235 | 0 | 157 |
| ctx 200k / 48k | 1.89 B | −20 % | 126 | 0 | 104 |
| turn 48 + handoff (P=28) | 1.87 B | −21 % | 0 | 206 | 138 |
| turn 90 + handoff | 2.15 B | −9 % | 0 | 56 | 45 |
| ctx 150k/32k + turn 90 | 1.57 B | −33 % | 209 | 56 | 158 |
| turn 48, P=10 / 28 / 55 | | −31 % / −21 % / **+6 %** | | | |

Conclusions: cap **context**, not turns — same or better saving, no handoff penalty, no early-"done" incentive. A turn cap only earns its place as a p99 runaway guard (~200 turns: 4 runs). 96k/24k is the crunch setting; 150k/32k everyday. Astra's 48-turn suggestion bites a third of ordinary runs (p50 = 34) and flips negative if the handoff penalty is at the high end.

## Reviewer's ranked interventions (`consults/02-astra-effort-answer.md`)

1. Bound subagent context growth with progress checkpoints — base 3.40 B; 25–50 % → 0.85–1.70 B (5.6–11.3 %).
2. Event-driven resumption instead of model-mediated waiting; bundle todo updates — base ~0.79 B; 50–90 % → 0.40–0.71 B (2.6–4.7 %).
3. Artifact-linked progress checks for expensive workers — base 0.74 B; 25–50 % if audit confirms waste (overlaps 1).
4. Duplication suppression — not identifiable from aggregates.
5. Lower effort on scheduling turns — < 0.004 %.

Would not do: blanket low effort; hard kill at 90 turns; ban singleton spawns; drop repeat reads; adopt 220–240k without local testing; minimum report lengths. Missing measurement: tokens per independently verified completed task (inline vs delegated, current vs capped workers, current vs event-driven scheduling; hidden tests + parent rework over a fixed window).
