# 07 — Discussion log

Questions raised while reviewing the proposals, with the answers that were grounded in the data. Numbering follows the change list in `06-proposed-changes.md` where applicable.

## Q: Which models get capped, and why that number?

All of them: `compaction.thresholdTokens` is session-level. Today's effective thresholds are 850k (Anthropic, Astra-with-override) and 316k (Codex 5.6). A fixed 200k makes them equal. The number came from the replay curve (`03-context-economics.md`): the knee is 150–250k; 150k gives −54 % but 3.2 compactions/session and sits below LangWatch's ~146k floor where rediscovery dominates; 250k is above Codex's enforced ~253k ceiling so gives no overflow headroom there. 200k/48k is the midpoint of every documented setup (Codex CLI 180–244k, Claude Code ~190k, WorkOS 256k). No evidence ties 150k vs 200k to task success on this workload — that part is judgement; B14 telemetry is what would settle it.

## Q: Why is compaction only at 850k — isn't that the default?

It is the default *formula* (`window − max(15 %, 16k)`), not a chosen number; it exists so the request never overflows. On 200k models it gave 170k and nobody noticed. Higher is impossible, staying at 850k pays C^2.5 growth for context that contributes ~2.5 % useful content. Go lower.

## Q: What is a "tail"?

Threshold = context size where compaction fires; tail = `keepRecentTokens`, the newest N tokens kept verbatim afterwards; older content is summarised or (snapcompact) archived.

## Q: How does the advisor charge?

A second full agent with its own append-only context and tools; after every primary step it receives the delta and runs a model turn over its whole history. 23,664 calls, 2.64 B tokens, on the same subscription pools. Separate usage, visible via `/advisor status`. Disabled since 2026-09-06.

## Q: Opus is "free" — just use it for `reader`?

Yes, with the correction that the "Claude 7 Day" pool Opus draws from was at 77 % / 75 % / 60 %, not unlimited; the Fable sub-cap was the one at 100 %. Decision: `reader` stays on `anthropic/claude-opus-5`; the 200k cap doubles how many subagent turns that headroom buys.

## Q: Doesn't omp already have smart model routing?

Reactive routing is on by default (`retry.modelFallback`): after a 429 / usage-limit / overloaded error it rotates sibling credentials, applies banked Codex resets, walks fallback chains, else backs off up to `maxDelayMs`. `retry.usageAwareFallback` is the *preflight* version: reads the quota bars before the call and rotates/falls back at 10 % remaining. Off by default because it will move an interactive session without an error having occurred; `confirm` policy asks first.

## Q: Should Astra go back to its default 256k window?

Cost-wise irrelevant — Codex sessions never exceeded 253k; every runaway session was Anthropic. Reverting removes an overflow failure mode; the global threshold (A1) is the cleaner fix.

## Q: "I almost never hit 50 % of the window"

True for 58 of 124 sessions (3 % of tokens). The 33 sessions above 300k — the hub-coordinated goal runs — are 65 % of main tokens. Cost is decided by the tail, and the tail is exactly the long runs.

## Q: How do cache hits/misses factor in?

Cache-read 64 %, cache-write 19 %, output 14 %, input 4 % of nominal. Compaction's rewrite cost is ~22 M tokens/14 d; idle-expiry rewrites are 35–43 M and are caused by a 5 m TTL in practice despite the 1 h intent (B10). LangWatch: caching changes the constant, not the C^2.5 exponent.

## Q: Is there a deeper study?

LangWatch (Aug 2026) — see `05-external-evidence.md`. Its findings moved the recommendation from 150k/20k to 200k/48k and added "preserve a larger tail" and "start subagents small" as the dominant levers.

## Q: Are there documented comparable setups?

Yes; they converge on trigger 180–256k, tail 20–48k, prune tool output first (WorkOS on pi, Codex CLI, Claude Code, OpenCode, Amp). Nobody documented runs 500k+ on purpose except the "fidelity camp" LangWatch measured and found not to break even on tokens.

## Q11: Do roles change the subagent's prompt? Why not auto-fill from benchmarks?

A role is only `model:thinking`; it never alters prompt text (prompts come from the agent definition; model-family switches some system-prompt sections, keyed on the model). Subagent model precedence (`structured-subagent.ts:281`): caller `model` → `task.agentModelOverrides[agentName]` → agent file `model:` → parent's active model. Only `task → @reader` is set, so `scout`/`reviewer`/`sonic` inherit the parent model. Benchmarks rank models; a role needs a *route* (auth, quota state, cache price, ceiling, latency), and no aggregated benchmark covers Fable-5.1 / GPT-6 Astra programmatically yet. Proposal B20: suggest-then-apply from a catalog `quality` field plus local `model_perf` and quota data.

Preset plan: ~4 axes (frontier for `default`; frontier for `slow`; reader tier; smol tier) × 3 options → ~8 named intents rather than 81 combinations: `Codex-first`, `Claude-first`, `Balanced`, `Quota-saver`, `Overnight-GLM`, `Research`, `Design`, `Emergency-paid`. **Open:** confirm the axes match what the user actually switches between.

## Q12: Subagent completion is polled — waste?

Delivery is push (`async-result` yield-queue sink). The waste is the coordinator having nothing to do and issuing finite-timeout `hub wait`s, each a full-context turn: 462 lone-wait turns = 183 M tokens in the big sessions; 339 of 638 hub results < 300 chars. Fixes in B12b, cheapest first: `timeoutMs: 0` + prompt rule; time-window coalescing of deliveries; idle compaction during waits; a park primitive with zero model calls.

## Q13: Would capping subagents hurt? Show the math.

Real downsides: mid-work cut on legitimately long tasks (p90 = 89 turns) with ~28 steps of rediscovery per handoff; early-"done" incentive near a cap; compounding digest loss across successors; 96k too small for tasks holding several files verbatim (18–20 % of building steps need verbatim per the LangWatch audit). Replay (`04-subagents-and-effort.md`): context caps save −20 % to −50 % with no handoff penalty; a 48-turn cap saves −21 % at P=28 and **costs +6 % at P=55**. Decision: cap context (150k/32k everyday, 96k/24k crunch), turn cap only as a p99 guard (~200), soft checkpoint with artifact evidence and parent-grantable extension, lineage budget so successors can't reset.

Two regimes: crunch (diss-v2 / chessathon; 7–13 B/week demand vs 6 B supply) → aggressive caps, reader on API, `auto` fallback; quality (now; < 3 B/week, half the supply unused) → 300k/60k main, 250k/48k subagents, frontier everywhere. Preset switch, optionally quota-driven (B21).

## Q14: Do more compaction instructions cost tokens?

Marginally, per event only. `snapcompact` makes no LLM call, so instructions don't apply; `context-full`/`handoff` add a few hundred tokens to a ~200k summariser input. What recurs is the *output*: summary length and `keepRecentTokens` are re-read every turn until the next compaction. Boundary-aware timing (B15) costs zero tokens.

## Q: Where were the reasoning-effort lapses?

Not in thinking tokens (Codex ~100/turn; Anthropic output 14 % of spend). The lapse is running a full-context turn that produces nothing: hub-only 0.87 B / 1.07 M out, todo-only 0.25 B. Thinking level is flat on those turns; dropping it saves < 0.004 %. Subagents helped on mechanism (half the replay cost per output token, 11k start, low duplication) but 87 runs > 90 turns are 58 % of subagent tokens and 81 runs > 2 M tokens returned < 800 chars. Full analysis `04-subagents-and-effort.md`; reviewer's ranking in `consults/02-astra-effort-answer.md`.

## Open decisions

1. Preset axes and names (Q11).
2. Cap levels per subagent kind: scout / builder / coordinator.
3. Quota-adaptive preset switching (B21) — automatic or manual.
4. Whether B13 tool-output budgets apply to `bash` (risk: truncating test output the agent needs verbatim).
