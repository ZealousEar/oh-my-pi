# 03 — Context economics: thresholds, tails, regimes

Tables: `data/sim-main-compaction.csv`, `data/14d-main-context-distribution.csv`, `data/14d-sessions-by-peak.csv`. External numbers: `05-external-evidence.md`.

## Why compaction currently fires at ~850k

`resolveThresholdTokens` (`packages/agent/src/compaction/compaction.ts:360`): with `compaction.thresholdTokens` and `thresholdPercent` unset, threshold = `contextWindow − resolveBudgetReserveTokens(...)` = `window − max(15 % · window, 16,384)`. On a 1M-window model that is 850k; on Codex `gpt-5.6-*` (372k bundled) 316k; on a 200k model 170k — which is why the default was harmless before 1M windows. The observed 844,613 peak is this formula working as designed: it is a request-overflow guard, not an economic or quality policy.

Threshold and tail in one line: **threshold** = context size at which compaction fires; **tail** (`keepRecentTokens`, default 20k) = newest N tokens kept verbatim after compaction, everything older is summarised (or, with `snapcompact`, archived as images the model can read back).

## Replay simulation on real sessions

Method (`scripts/analyze.py::sim_main`): for each of the 124 main sessions, replay per-turn context growth (Δ between consecutive turns' billed context); when the running context exceeds the threshold, reset it to 34k (measured system-prompt + tools base) + `keepRecentTokens`. Optimistic in two ways: ignores snapcompact image tokens read back later, and assumes no rediscovery growth after compaction.

| threshold / tail | main tokens | saving | compactions / session |
|---|---|---|---|
| none (today, ≈850k) | 3.73 B | — | ~0 |
| 150k / 20k | 1.71 B | −54 % | 3.2 |
| 180k / 48k | 2.19 B | −42 % | 2.9 |
| **200k / 48k** | **2.34 B** | **−39 %** | 2.5 |
| 250k / 60k | 2.72 B | −27 % | 1.9 |
| 300k / 60k | 3.03 B | −19 % | 1.4 |
| 400k / 60k | 3.40 B | −9 % | 0.8 |

(Second-run figures with the script's window; the narrative in the chat used the same replay with slightly different rounding: 150k/20k −54 %, 250k/60k −27 %.)

The curve knees between 150k and 250k. Below 150k the harness compacts every ~50 turns and re-reads what it just discarded; above 250k it pays for the long tail and saves little.

## What the external evidence says about the number

- LangWatch (287,748 calls, 873 compactions): cumulative cost of reaching context C ∝ C^2.5 (R² 0.994); caching changes the constant not the exponent; the context a step *uses* is 6–8.5k regardless of window (47 % of a 39k window, 2.5 % of a 645k one); cost-optimal threshold 220k (cycle model) and 240k (file re-reference distance), independently; below ~146k the cycle is dominated by rediscovery; **but** operator corrections rise from 17.7 % to 41.9 % in the 5 steps after a compaction and stay elevated 100+ steps → reconciled recommendation 250–450k by task type, and the bigger lever is preserving a 30–60k verbatim tail rather than a 4k digest.
- Codex CLI defaults `model_auto_compact_token_limit` to 180–244k by model; Claude Code auto-compacts at ~95 % of 200k; WorkOS's pi profile compacts at 256k with a 40k tail, anchored on OpenAI's 272k pricing tier; OpenCode compacts at `context − output_limit` and prunes tool output beyond the last 40k first.
- Long-context reliability on current-generation models (MRCR v2 8-needle): Opus 4.6 93 % @256k / 76 % @1M; GPT-5.4 79 % @128–256k, 57 % @256–512k, 37 % @512k–1M; Gemini 3.1 Pro 85 % @128k, 26 % @1M. Classifier context-rot paper (arXiv 2605.12366): Opus 4.6 / GPT-5.4 / Gemini 3.1 miss a dangerous action 2–30× more often after 800k tokens of benign transcript.
- Caveat stated by the external reviewer (`consults/01-astra-policy-answer.md` §B): none of this measures *agentic decision quality* for Opus-5 / Fable / GPT-6 specifically; retrieval benchmarks and the LangWatch correction rate are the best proxies available. Operate at 60–160k for routine turns, allow 180–240k for demanding work, require a reason above that.

Convergence across sources: **trigger 180–256k, tail 20–48k, prune tool output before compacting.** 200k/48k is the midpoint; it also sits under Codex's enforced ~253k ceiling, which a 250k trigger would not.

## Cache-write cost of compacting

Each compaction rewrites ≈ 34k + tail as a new prefix. At 2–3 compactions per long session that is ~22 M cache-write tokens per 14 d (≈ $140 nominal) against 35–43 M from idle-expiry rewrites. Amortisation: 94k written at 1.25× input ÷ (~120k tokens removed per subsequent turn × 0.1× cache-read price) ≈ 6–10 turns. Compacting a session that is about to end is a net loss; compacting *before* a resumed call whose prefix has already expired is free.

## Two operating regimes

Supply ≈ 6 B context tokens/week at 100 % of every pool (`01-baseline-telemetry.md`). Demand: crunch fortnight (diss-v2, chessathon) 1–1.9 B/day ≈ 7–13 B/week; quiet weeks < 3 B.

| | Crunch | Quality |
|---|---|---|
| objective | verified work per quota point | best output; quota is use-it-or-lose-it |
| main threshold / tail | 150k / 32k (−54 % main) | 300k / 60k (−19 %, ~1 compaction/session) |
| subagent cap / tail | 96–150k / 24–32k (−33–50 %) | 250k / 48k (touches top ~10 % of runs) |
| `reader` | `openrouter/deepseek/deepseek-v4.1-flash` (moves ~1/3 of demand off subscription, ≈ $15/wk) | `anthropic/claude-opus-5` (idle quota) |
| `default` / `slow` | sol / opus-5 | fable-5-1 / astra:high |
| usage-aware fallback | `auto` | `confirm` |
| turn guard | 200 | 200 |

Crunch arithmetic: 13 B × (1 − 0.45) ≈ 7.1 B, minus reader tier moved to API (~2.4 B) ≈ 4.7 B on subscriptions vs 6 B supply. Quality: 3 B × 0.85 ≈ 2.5 B, under half of supply.

Mechanism: presets carrying `compaction` + `task` limits in addition to roles (schema extension), plus a quota-adaptive rule (aggregate 7-day remaining < 40 % → Crunch) driven by the `usage_history` bars omp already records.
