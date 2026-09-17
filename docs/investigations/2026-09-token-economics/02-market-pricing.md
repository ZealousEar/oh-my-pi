# 02 — Market pricing versus the measured workload

Sources: `https://models.sulat.com/_catalog/models` (a models.dev mirror; 7,784 listings / 213 providers, dumped 2026-09-14), OpenRouter `/api/v1/models/{id}/endpoints` (live), `docs.z.ai/devpack/overview`, `crof.ai/v1/models`. Tables: `data/price-*.csv`, `data/openrouter-endpoints-snapshot.csv`, `data/glm-credit-burn.csv`.

Projection basis for every "$/14 d" figure: the measured 14-day volume — 89 M input, 8,538 M cache-read, 37.6 M output — priced at each listing's input / cache-read / output rates. At this shape **cache-read price decides everything**: cache reads are 96 % of tokens.

## What sulat adds

Nothing omp doesn't discover live — `openrouter`, `kilo`, `nanogpt`, `deepseek` all run `fetchDynamicModels`; `zai` is bundled-only (`special.ts:211`, catalog stops at glm-5.2). Its value is the cross-provider price table per model.

Provider coverage: 21 sulat providers not in omp are gateways/resellers (302ai, aihubmix, merge-gateway, crof, …); omp providers not on sulat are OAuth/special routes (openai-codex, google-antigravity, cursor, …).

## Candidate models on omp-supported providers (cheapest route each)

| model | $/14 d | provider | in / out / cache per M | ctx | released |
|---|---|---|---|---|---|
| deepseek/deepseek-v4-flash | 47 | nanogpt | 0.14 / 0.28 / 0.0028 | 1 M | 04-24 |
| **deepseek/deepseek-v4.1-flash** | **62** | openrouter | 0.15 / 0.60 / **0.003** | 1 M | 09-10 |
| deepseek-v4-pro | 102 | deepseek direct | 0.435 / 0.87 / 0.0036 | 1 M | 08-12 |
| xiaomi/mimo-v2.5-pro | 102 | openrouter | 0.435 / 0.87 / 0.0036 | 1 M | 04-22 |
| z-ai/glm-5.3-flash | 144 | zai / openrouter | 0.075 / 0.25 / 0.015 | 1 M | 08-26 |
| openai/gpt-5.6-luna | 234 | openrouter | 0.2 / 1.2 / 0.02 | 1.05 M | 07-09 |
| google/gemini-3.8-flash | 848 | google / openrouter | 0.75 / 3.75 / 0.075 | 1 M | 09-02 |
| z-ai/glm-5.3 | 1,958 | openrouter (default) | 1.09 / 3.43 / 0.20 | 1.3 M | 08-14 |
| openai/gpt-5.6-sol | 2,262 | openrouter | 2 / 10 / 0.20 | 1.05 M | 07-09 |
| sakana/fugu-max | 2,539 | openrouter | 2 / 6 / 0.25 | 1 M | 09-11 |
| moonshotai/kimi-k3 | 3,320 | openrouter | 2.65 / 13.3 / 0.30 | 1 M | 07-16 |
| claude-opus-5 | 5,655 | bedrock | 5 / 25 / 0.5 | 1 M | 07-24 |
| gpt-6-astra | 11,310 | bedrock / kilo | 10 / 50 / 1.0 | 1.05 M | 09-04 |

## GLM-5.3 specifically

All 54 listings ranked (`data/price-glm53-all-providers.csv`); usable ones:

| route | in / out / cache | $/14 d | verified | caveat |
|---|---|---|---|---|
| Z.AI Coding Plan Max ($168/mo) off-peak | ≈ 0.007 / 0.024 / 0.0017 (derived) | $78 plan; covers ~35 % of volume | docs.z.ai credit table | quota-capped, supported-tools ToS |
| crof.ai | 0.40 / 1.40 / 0.06 | 601 | live `/v1/models` | Q8_0, 30 tok/s, 17 s TTFT (self-reported); not an omp provider |
| OpenRouter → DeepInfra | 1.20 / 4.00 / 0.12 | 1,282 | endpoints API | fp4 |
| OpenRouter → Morph | 0.90 / 3.07 / 0.18 | 1,770 | endpoints API | fp8, 99 % uptime — cheapest fp8 |
| OpenRouter default (Novita) | 1.09 / 3.43 / 0.20 | 1,958 | live | fp8 |
| Z.AI / bigmodel.cn API | 1.40 / 4.40 / 0.26 | 2,510 | | first-party |
| coralbricks `-fp4` | 1.12 / 4.40 / **0** | "265" | sulat only | cache=0 means no caching → real ≈ $9.7k |
| tokenrouter `:free`, nan.builders, scnet/volcengine plans | 0 | — | sulat only | rate-limited / unknown / China-only |

## Z.AI coding-plan credit math

Credits per 10k tokens (input / cached / output): GLM-5.3 = 6.9 / 1.7 / 24; GLM-5.3-Flash = 2.3 / 0.56 / 8. Off-peak (outside Mon–Fri 14:00–18:00 SGT) ×0.5. Plans: Lite $18 = 2,000 / 5 h, 10,000 / wk; Pro $80 = 12,000 / 60,000; Max $168 = 28,000 / 140,000. Campaign: unlimited Flash 23:00–09:00 on paid plans.

Applied to this user's hourly burn (`data/glm-credit-burn.csv`):

| | GLM-5.3 credits | Flash credits |
|---|---|---|
| median active hour | 10,732 | 3,542 |
| p90 hour | 30,446 | 10,047 |
| worst 5-hour window | 196,676 | ~65,000 |
| 14-day total | 1.71 M | 0.57 M |

Lite's 5-hour bucket = **11 minutes** at median burn (observed: "burned through in 5 minutes"). Max lasts 2.6 h at median, 55 min at p90; the weekly total needs ~6 Max plans. Subscriptions are sized for a human at ~50k context, not a 210k-context agent loop. Conclusion: for this workload GLM-5.3 by subscription is only viable as an overnight Flash lane; pay-per-token GLM-5.3 loses to DeepSeek V4.1 Flash by 60× on cache-read price.

## GLM-5.3-Flash vs DeepSeek V4.1 Flash

| route | in / out / cache | $/14 d |
|---|---|---|
| DeepSeek V4.1 Flash — OpenRouter (DeepSeek first-party endpoint or Relace fp4) | 0.15 / 0.60 / 0.003 | **62** |
| DeepSeek V4.1 Flash — DeepSeek direct | 0.15 / 0.60 / 0.003 | 62 (no OpenRouter 5.5 % credit fee) |
| GLM-5.3-Flash — OpenRouter → DeepInfra fp4 | 0.075 / 0.25 / 0.015 | 144 |
| GLM-5.3-Flash — Z.AI API / OpenRouter default | 0.15 / 0.50 / 0.03 | 288 |

The gap is entirely cache-read (0.003 vs 0.015–0.03); output price favours GLM, but output is 0.4 % of tokens here.

## OpenRouter endpoint snapshot (2026-09-14)

Full table in `data/openrouter-endpoints-snapshot.csv`. Notable: GLM-5.3 has 27 endpoints from $0.90 (Morph fp8) to $2.10; GLM-5.3-Flash 27 endpoints, DeepInfra fp4 cheapest at $0.075 with 97 % uptime; DeepSeek V4.1 Flash first-party endpoint showed 0 % uptime in the last 30 min at snapshot time, Relace fp4 same price. omp exposes routing pins through `models.yml → compat.openRouterRouting.{only,order}`.
