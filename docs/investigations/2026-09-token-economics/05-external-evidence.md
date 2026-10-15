# 05 — External evidence

Annotated; the number actually used in this investigation is listed with each source.

## Harness telemetry studies

- **LangWatch — Finding the Optimal Context Window for Coding Agents** (Aug 2026). https://langwatch.ai/research/finding-the-optimal-context-window — 287,748 API calls, 2,451 agents, 162 days, 873 compactions, 201 judged steps. Cost of reaching context C ∝ C^2.55 (R² 0.994); caching alters the constant only; read amplification U-shaped with minimum ~75k; active context per step 6–8.5k across a 16.6× window range; cost-optimal threshold 220k (cycle model) / 240k (file re-reference); post-compaction correction rate 41.9 % vs 17.7 % for ≥30 steps; median compaction keeps 0.8 % of the window; reconciled recommendation 250–450k by task type; dominant levers = 30–60k verbatim tail and small subagent initialisation. Narrative version: https://langwatch.ai/blog/context-tax-when-to-compact
- **WorkOS — Stop giving your coding agent a million-token context window** (Aug 2026). https://workos.com/blog/coding-agent-context-window-compaction-settings — on pi (omp's upstream): `contextWindow 320000 / reserveTokens 64000 / keepRecentTokens 40000` → trigger 256k, 60k generation runway, 40k tail; derivation `reserve = G + 4096`, `window = H + G + 4096`; 272k anchored on OpenAI's short-context pricing tier; "an override larger than the route accepts relocates the failure".
- **badlogic (pi author) — Context Compaction Research gist** (updated Sept 2026). https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f — Claude Code auto-compacts ~95 %; Codex CLI `model_auto_compact_token_limit` 180–244k by model, keeps ~20k of recent user messages, warns about repeated compaction; OpenCode compacts at `context − output_limit` and prunes tool output beyond the last 40k (PRUNE_PROTECT) when >20k prunable; Amp: no auto-compaction, handoff/fork/thread references.
- **Daniel Vaughan — Context Compaction Deep Dive: Codex CLI, Claude Code, OpenCode** (Apr 2026). https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/
- **Amp — Context management guide.** https://ampcode.com/guides/context-management — "keep conversations short & focused; everything in the context window influences the output".

## Long-context degradation

- **Martin & Roger — classifier context rot** (May 2026). https://arxiv.org/abs/2605.12366 — Opus 4.6, GPT-5.4, Gemini 3.1 miss a subtly dangerous coding-agent action 2–30× more often after 800k tokens of benign transcript; reminders recover part of the loss.
- **Chroma — Context Rot** (2025). https://research.trychroma.com/context-rot — 18 models; performance degrades with input length even on trivial tasks; one topically related distractor drops below baseline.
- **NoLiMa** (2025). https://arxiv.org/abs/2502.05167 — long-context retrieval without lexical overlap degrades sharply.
- **1M long-context benchmark roundup** (Mar 2026). https://yage.ai/share/long-context-benchmark-en-20260315.html — MRCR v2 8-needle: Opus 4.6 93 % @256k / 76 % @1M; Sonnet 4.6 90 % / 66 %; GPT-5.4 79 % @128–256k, 57 % @256–512k, 37 % @512k–1M; Gemini 3.1 Pro 85 % @128k, 26 % @1M. Sources it aggregates: Anthropic Sonnet 4.6 system card, OpenAI GPT-5.4 post, contextarena.ai.
- **An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks.** https://arxiv.org/html/2601.06007v2
- **TraceLab: Characterizing Coding Agent Workloads for LLM Serving.** https://arxiv.org/html/2606.30560v2

## Context engineering guidance

- Anthropic — Effective context engineering for AI agents. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — "the solution isn't more capacity; it's better management of existing capacity".
- Anthropic — prompt caching docs (5 m vs 1 h TTL, write multipliers 1.25× / 2×). https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Manus — Context Engineering for AI Agents. https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus — KV-cache hit rate as the primary metric; append-only context; file system as external memory.

## Pricing

- models.sulat.com (models.dev mirror; JSON at `/_catalog/models`, `/_catalog/providers`). https://models.sulat.com/
- Z.AI GLM Coding Plan overview (credit multipliers, plan quotas, off-peak). https://docs.z.ai/devpack/overview ; FAQ https://docs.z.ai/devpack/faq ; plan prices Lite $18 / Pro $80 / Max $168 per month.
- crof.ai pricing / `/v1/models` (self-reported speed, TTFT, quantisation). https://crof.ai/pricing
- OpenRouter endpoint listings. https://openrouter.ai/z-ai/glm-5.3 , https://openrouter.ai/deepseek/deepseek-v4.1-flash

## omp docs referenced

`docs/compaction.md`, `docs/advisor-watchdog.md`, `docs/non-compaction-retry-policy.md`, `docs/session.md`; code: `packages/agent/src/compaction/compaction.ts` (threshold math), `packages/coding-agent/src/session/turn-recovery.ts` (`#maybeApplyUsageAwareFallback`), `packages/coding-agent/src/session/agent-session.ts` (async-result delivery sink), `packages/ai/src/providers/anthropic.ts` (`getCacheControl`), `packages/catalog/src/compat/anthropic.ts` (`supportsLongCacheRetention`), `packages/coding-agent/src/task/structured-subagent.ts` (model resolution precedence).
