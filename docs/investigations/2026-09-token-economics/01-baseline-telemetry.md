# 01 — Baseline telemetry

Source: `~/.omp/stats.db` (`messages`, `tool_calls`), `~/.omp/agent/agent.db` (`usage_history`, `model_perf`, `auth_credentials`). Window 2026-08-31 → 2026-09-14; the stats sync had data through 2026-09-06 at analysis time. Tables: `data/14d-*.csv`, `data/7d-quota-snapshot.csv`, `data/model-perf.csv`.

## Setup under study

- Models via subscriptions: OpenAI Codex OAuth (4 accounts; `gpt-6-astra`, `gpt-5.6-sol/terra/luna`), Anthropic OAuth (3 accounts; `claude-opus-5`, `claude-fable-5`/`5.1`, `claude-opus-4-8`), Google Antigravity (`gemini-3.8-flash`, `gemini-3.1-pro`), Z.AI coding plan (`glm-5.3`, `glm-5.3-flash`). OpenRouter API key for overflow.
- Roles at the time (`~/.omp/agent/config.yml`): `default: openai-codex/gpt-6-astra:medium`, `reader: anthropic/claude-opus-5:medium`, `slow: anthropic/claude-opus-5:max`, `plan: anthropic/claude-opus-5:xhigh`, `smol: google-antigravity/gemini-3.8-flash:high`, `tiny: openai-codex/gpt-5.6-luna:xhigh`, `advisor: anthropic/claude-fable-5:high`. `task.agentModelOverrides.task: "@reader"`. No `compaction` block. `retry.maxDelayMs: 10800000` (3 h). `models.yml` overrode `gpt-6-astra.contextWindow` to 1,000,000.

## Volume and nominal cost

| provider / model | msgs | cache-read M | out M | nominal $ | errors |
|---|---|---|---|---|---|
| anthropic/claude-fable-5-1 | 15,780 | 2,938 | 12.0 | 4,707 | 113 |
| openai-codex/gpt-5.6-sol | 25,274 | 2,867 | 11.3 | 1,869 | 88 |
| anthropic/claude-opus-5 | 10,511 | 1,795 | 9.6 | 1,472 | 53 |
| anthropic/claude-fable-5 | 1,967 | 297 | 1.7 | 490 | 8 |
| openai-codex/gpt-5.6-terra | 3,912 | 216 | 1.2 | 93 | 17 |
| openai-codex/gpt-6-astra | 3,373 | 344 | 0.8 | (no pricing) | 18 |
| **total** | | **8,538** | **37.6** | **≈ 8,724** | |

Totals: 89 M fresh input, 8,538 M cache-read, 160 M cache-write, 37.6 M output → **8.79 B tokens, 97.2 % cache-hit**. Nominal $ split: cache-read 64 %, **cache-write 19 % ($1,637)**, output 14 %, input 4 %. "Nominal" = list API price; actual payment is subscription quota.

## By agent type

| agent type | msgs | cache-read M | out M | avg context | share of tokens |
|---|---|---|---|---|---|
| main | 17,750 | 3,625 | 12.2 | **210k** | 42 % |
| subagent | 20,057 | 2,271 | 15.9 | 117k | 26 % |
| advisor | 23,664 | 2,642 | 9.4 | 114k | **31 %** |

The advisor is a second full agent (`docs/advisor-watchdog.md`) that re-runs on every primary step over its own accumulated history; it made 16,262 tool calls. Sept 1 alone: 8,666 advisor turns. It was disabled on 2026-09-06 and daily volume dropped accordingly.

## Main-session context distribution

| context band | turns | tokens M |
|---|---|---|
| 0–50k | 1,028 | 37 |
| 50–100k | 3,092 | 233 |
| 100–200k | 6,341 | 948 |
| 200–300k | 3,572 | 855 |
| 300–500k | 2,684 | 1,035 |
| 500k–2M | 1,033 | 624 |

Percentiles: p25 105k, **p50 174k**, p75 268k, p90 425k, max 844,613 (`claude-opus-5`). First-turn context (system prompt + tools + context files): p50 34k, p90 52k.

By session peak:

| peak context | sessions | tokens | share of main |
|---|---|---|---|
| < 150k | 58 | 0.10 B | 3 % |
| 150–300k | 33 | 1.21 B | 32 % |
| 300–500k | 24 | 1.27 B | 34 % |
| > 500k | 9 | 1.15 B | 31 % |

The 33 sessions above 300k are hub-coordinated goal runs (638 `hub` calls, 68 `task` calls inside them). Codex models never exceeded 253k (server-side ceiling); every session above that is Anthropic: opus-5 845k, opus-4-8 720k, fable-5-1 701k, fable-5 462k.

## Tool output into context (14 d)

| tool | calls | result MB | avg chars |
|---|---|---|---|
| read | 20,374 | 131.5 | 6,454 |
| grep | 8,071 | 44.1 | 5,460 |
| bash | 10,940 | 15.0 | 1,374 |
| eval | 3,157 | 5.2 | 1,653 |
| edit | 3,377 | 4.1 | 1,226 |

`read` + `grep` = 82 % of tool bytes.

## Quota saturation (7 d to 2026-09-14)

| pool | accounts at cap |
|---|---|
| Codex 7-day | 4 / 4 at 100 % |
| Anthropic "Claude 7 Day (Fable)" sub-cap | 100 % / 100 % / 91 % |
| Anthropic "Claude 7 Day" (Opus pool) | 77 % / 75 % / 60 % |
| Z.AI 5-hour | 100 % (weekly 21 %) — burst-capped, not volume-capped |
| Antigravity weekly | 43 % |

Errors in window: 69 Anthropic overloaded, 25 × 429, 11 Codex `usage_limit_reached`, 46 advisor resets.

Supply estimate: the saturated week 2026-09-01→07 consumed ≈ 6.0 B context tokens across Anthropic (4.7 B) + Codex (1.3 B) with every pool hitting 100 % → **≈ 6 B/week is the combined subscription capacity at current context shapes.** Daily demand during that week: 0.7–1.9 B/day.

## Cache-write anatomy (Anthropic main turns)

A turn with `cache_write > 50k` is a prefix rebuild. Bucketed by idle gap since the previous turn in the same session:

| gap | turns | rebuilds | rate | tokens |
|---|---|---|---|---|
| < 1 m | 9,898 | 23 | 0 % | 6 M |
| 1–5 m | 1,224 | 17 | 1 % | 5 M |
| 5–15 m | 286 | 24 | 8 % | 8 M |
| **15–60 m** | 151 | 99 | **66 %** | 35 M |
| > 1 h | 46 | 40 | 87 % | 9 M |

Session JSONLs report `ephemeral5m` on 606 of 608 Anthropic turns and zero `ephemeral1h`, although `packages/ai/src/providers/anthropic.ts` (`getCacheControl`) defaults OAuth to `"long"` → `ttl: "1h"` when `compat.supportsLongCacheRetention`. Either the flag resolves false for these routes or the TTL is dropped on the wire. Compaction's own cache cost is small by comparison: ~94k rewritten per event → ~22 M tokens/14 d at ~2 compactions/session.

## Model performance (`model_perf`)

| model | samples | tok/s | TTFT |
|---|---|---|---|
| anthropic/claude-fable-5 | 469 | 76 | 1.9 s |
| anthropic/claude-fable-5-1 | 195 | 80 | 2.2 s |
| anthropic/claude-opus-5 | 166 | 75 | 1.8 s |
| openai-codex/gpt-6-astra | 226 | 22 | 3.6 s |
| openai-codex/gpt-5.6-sol | 134 | 41 | 2.3 s |
| openrouter/deepseek/deepseek-v4-pro | 194 | 42 | 2.9 s |
| fireworks/glm-5.3 | 224 | 65 | 2.2 s |
| zai/glm-5.3 | 43 | 42 | 5.9 s |
| zai/glm-5.3-flash | 13 | 35 | 4.3 s |
| openrouter/moonshotai/kimi-k3 | 44 | 31 | 9.8 s |
| google-antigravity/gemini-3.1-pro | 42 | 115 | 7.0 s |
