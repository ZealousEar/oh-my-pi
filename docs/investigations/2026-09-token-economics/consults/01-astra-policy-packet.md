
# Consult: token-spend and context-quality policy for an omp (oh-my-pi) coding-agent harness

## Situation
Single power user of omp (Bun/TS coding agent harness, tool-calling loop, subagents, optional "advisor" shadow model).
Models via subscriptions: OpenAI Codex OAuth (4 accounts: gpt-6-astra, gpt-5.6-sol/terra/luna), Anthropic OAuth (3 accounts: claude-opus-5, claude-fable-5/5.1), Google Antigravity (gemini-3.8-flash), Z.AI coding plan (glm-5.3). OpenRouter API key for overflow.
Every subscription's 5-hour and 7-day quota is being exhausted (Codex 7d at 100% on all 4 accounts; Anthropic Fable 7d 100%/100%/91%; Z.AI Lite burned in minutes).

## Measured, last 14 days (stats.db, deduplicated per message)
- 8.79B tokens total: 8.54B cache-read, 89M fresh input, 160M cache-write, 37.6M output. Cache hit 97%.
- Nominal $ split: cache-read 64%, cache-write 19% ($1,637), output 14%, input 4%.
- By agent type: main 17,750 turns / 3.73B tokens / avg ctx 210k; subagent 20,057 turns / 2.27B / avg ctx 117k; advisor 23,664 turns / 2.64B / avg ctx 114k (advisor now disabled).
- Main-turn context percentiles: p25 105k, p50 174k, p75 268k, p90 425k, max 845k.
- Sessions: 124. 58 sessions peak <150k = 3% of tokens. 33 sessions peak >300k = 65% of main tokens (long "goal runs" coordinating subagents via hub). 9 sessions >500k = 31%.
- Peak context by model: claude-opus-5 845k, claude-fable-5-1 701k; codex models never exceed 253k (server-side cap).
- Read amplification (context tokens per output token): main 305:1, subagent 147:1.
- Subagents (456 runs): start fresh at ~11k median first-turn context; turns/run p50 34, p90 89, p99 204; peak ctx p50 113k, p90 268k, max 473k; top 10% of runs = 47% of subagent tokens. 1,498 subagent turns ran >250k ctx.
- Tool output into context: read 131MB, grep 44MB, bash 15MB (of 214MB).
- Cache-write anatomy (Anthropic main): 66% of turns resuming after a 15-60 min idle gap rewrite the full prefix; 87% after >1h. Session JSONL shows ephemeral5m TTL on 606/608 Anthropic turns, zero 1h, even though the harness code intends 1h TTL on OAuth. Idle-expiry rewrites ≈ 35-43M tokens.
- Errors: 69 Anthropic overloaded, 25 429s, 11 codex usage_limit_reached; retry maxDelay set to 3h.

## Harness knobs (omp)
- compaction.strategy: snapcompact (default; no LLM call; history archived as dense images the model can read back), alternatives context-full (LLM summary), handoff (new session with handoff doc), shake (drop heavy tool results, keep artifact refs), off.
- compaction.thresholdTokens (default: contextWindow − max(15%, 16k) → 850k on 1M models); compaction.keepRecentTokens (default 20k verbatim tail); idle compaction (off by default); supersedeReads/dropUseless pruning on by default.
- retry.usageAwareFallback (off by default): preflight quota check, rotate same-provider accounts, walk fallbackChains at reserve %; policy confirm/auto/fail-closed.
- modelRoles: default, slow, plan, smol, tiny, reader (subagents/task), vision, commit, advisor; fallbackChains per role.
- Subagents start with fresh context (not forked), inherit compaction settings.

## External evidence gathered
- LangWatch case study (Aug 2026, 287k API calls, 873 compactions): cumulative cost ∝ C^2.5; caching changes constant not exponent; active context per step flat at 6-8.5k tokens across 39k-645k windows; cost-optimal threshold 220-240k; post-compaction operator-correction rate 41.9% vs 17.7% baseline for ~30-100 steps; reconciled recommendation 250-450k by task type; dominant levers = preserve 30-60k verbatim tail (not 4k digest) and start subagents small; subagent step count unpredictable (p99 359).
- Long-context reliability (MRCR v2 8-needle): Opus 4.6 93% @256k / 76% @1M; GPT-5.4 79% @128-256k, 57% @256-512k, 37% @512k-1M; Gemini 3.1 Pro 85% @128k, 26% @1M. Chroma "Context Rot": degradation with length across 18 models even on trivial tasks.
- Z.AI coding plan credit math makes any subscription die in <1h at this burn; pay-per-token GLM-5.3 ~$0.18-0.26/M cache-read vs DeepSeek V4.1 Flash $0.003/M.

## Candidate plan under consideration
1. compaction.thresholdTokens 250k, keepRecentTokens 60k (sim on real sessions: −27% main tokens, 1.9 compactions/session; 150k/20k would be −54% but 3.2 compactions/session).
2. Fix/verify Anthropic 1h cache TTL (currently 5m in practice).
3. reader/subagent role stays on claude-opus-5 (idle quota) or moves to openrouter/deepseek-v4.1-flash.
4. retry.usageAwareFallback: confirm; default role on gpt-5.6-sol not gpt-6-astra for routine turns.
5. Keep advisor off.

## Questions
A. What should this user do, in priority order, and why? Challenge the plan where the evidence doesn't support it.
B. Where is the "smart zone" for frontier models in an agentic coding loop — at what context size does decision quality start dropping for Opus-5/Fable-class and GPT-6/5.6-class models, and how should the compaction threshold and keepRecentTokens be set to stay in it? Distinguish retrieval benchmarks from agentic decision quality.
C. Subagents: do they actually optimise token usage here, or just move it? Given p90 89 turns and peak 268k, what policy (per-subagent context cap, turn cap, brief size, handoff-on-cap) would you set?
D. Any second-order effects of frequent compaction on prompt-cache economics we're missing (cache-write cost per compaction vs idle expiry)?
E. Anything omp should implement that it lacks (e.g., per-role thresholds, task-type-aware compaction, subagent budget caps)?
Be concrete: numbers, config values, and the reasoning chain. Say where you are inferring vs where the data supports it.
