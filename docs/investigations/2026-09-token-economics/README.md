# Token economics investigation (September 2026)

Why one power user exhausts every subscription quota (4× Codex, 3× Anthropic, Z.AI) inside hours, what the telemetry says the tokens are spent on, what the external evidence says about context size versus quality, and which omp changes the numbers support. Everything here is reproducible from local omp state with `scripts/analyze.py`; every number in the narrative files traces to a CSV under `data/`.

## Files

| file | what |
|---|---|
| `01-baseline-telemetry.md` | 14-day usage anatomy from `stats.db` / `agent.db`: by model, by agent type, context distribution, quota saturation, cache-write causes |
| `02-market-pricing.md` | models.sulat.com / OpenRouter / Z.AI plan pricing, projected on the measured volume; why GLM-5.3 and every subscription lose to a cache-read price comparison |
| `03-context-economics.md` | compaction threshold math, replay simulations on real sessions, the two operating regimes (crunch / quality), external evidence on the "smart zone" |
| `04-subagents-and-effort.md` | transcript-level analysis of 83,637 turns: reasoning-effort lapses, hub-wait cost, subagent value and the long tail; cap simulations |
| `05-external-evidence.md` | annotated citation list with the specific numbers used |
| `06-proposed-changes.md` | the numbered change list (config + harness), each with expected effect and evidence status |
| `07-discussion-log.md` | questions raised during review and the answers, including open decisions |
| `consults/` | packets sent to `openai-codex/gpt-6-astra:high` as an external reviewer, and its verbatim answers |
| `data/` | CSV tables (generated) |
| `scripts/analyze.py` | regenerates `data/` from `~/.omp/stats.db`, `~/.omp/agent/agent.db`, `~/.omp/agent/sessions/**` |

## Headline numbers (14 days, 2026-08-31 → 2026-09-14; transcripts to 2026-09-17)

- 8.8 B tokens: 97 % cache reads. Nominal API-price equivalent ≈ $8.7k; actually paid via subscriptions, all at 100 % of their weekly caps.
- Advisor (shadow reviewer) = 30 % of tokens; disabled 2026-09-06.
- Main sessions: median turn carries 174k context, p90 425k, max 845k. 33 of 124 sessions exceeded 300k and account for 65 % of main tokens. Compaction default on 1M models fires at 850k.
- Subagents: 39 % of context, 56 % of output; 10 % of runs (>90 turns) = 58 % of subagent tokens.
- `hub wait` turns that returned nothing: 0.87 B context for 1 M output.
- Cache writes: 19 % of nominal spend; 66 % of resumes after 15–60 min idle rewrite the prefix because sessions run a 5 m TTL although the code intends 1 h on OAuth.

## Decisions reached so far

- Compaction: cap context, not turns. Global `thresholdTokens` in the 180–200k band, `keepRecentTokens` 48k; per-role override for coordination runs (240k/60k). See `06-proposed-changes.md` items 1–2, 11.
- Subagents: context cap inside the subagent (150k/32k everyday, 96k/24k crunch), turn cap only as a p99 runaway guard (~200). See item 12.
- `reader` stays on `anthropic/claude-opus-5` while Opus quota is idle; `advisor` role moves to a cheap model and stays disabled.
- Reasoning-effort levels are not a lever (<0.01 % of tokens); not running the turn is.

## Decided 2026-09-17 (`07-discussion-log.md` → Decisions)

- Presets: `Codex-first`, `Claude-first`, `Balanced`, `Quota-saver`, `Quality`, `Overnight-GLM`, `Emergency-paid`, plus a generated `Benchmark` preset (B20).
- Subagent context caps by kind: scout 96k/24k, builder 150k/32k, coordinator 240k/60k; crunch scales ~35 % down. Turn guard 200 (checkpoint + handoff, not a cap).
- Regime switching automatic from quota bars (< 40 % → `Quota-saver`, > 70 % → `Quality`) with a TUI notice; `/preset` pins.
- Tool-output budgets on all tools: 8k per result, 16k for bash/eval, spill to `artifact://`.

## Still open

- Scoring weights and benchmark source for the `Benchmark` preset (B20).
