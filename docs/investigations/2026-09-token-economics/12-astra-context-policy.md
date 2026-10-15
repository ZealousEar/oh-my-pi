# Decision: Hold Astra at its 272K standard window, compact at 231,200, keep 48K of recent history

**Status:** Proposed
**Decision:** Keep `openai-codex/gpt-6-astra` on the catalog's 272K window with the existing 231,200-token trigger and raise the retained tail to 48K; this halves long-session cost against the 1M-window operating mode while costing ~4–7 % over a 20K tail.
**Confidence:** Medium — the cost cliff and replay are observed; no Astra-specific quality breakpoint below 272K is published, and the subscription quota's relation to API prices is assumed.
**Door:** Two-way — profile configuration only; every value reverts by editing `config.yml`.
**Blast radius:** Astra sessions; `keepRecentTokens` also applies to other models (capped at 25 % of the window below 512K).

## Staying under 272K halves cost; going lower buys little

- **Cost cliff.** OpenAI bills prompts above 272K input tokens at 2× input and cache rates and 1.5× output for the whole request. Over the 22 days, 51 % of Astra input tokens were sent above 272K, all of them between 09-07 and 09-20.
- **Vendor operating point.** Codex itself runs Astra at a 272,000 window and compacts at 90 % (244,800), overridable to 872,000.
- **Flat below the cliff.** Replaying 22 days of Astra sessions, every trigger from 200K to 272K lands within 50–56 % of the 450K mode; lower triggers add compactions faster than they save tokens.

| Compact at | Cost vs 450K mode | Compactions | Requests >272K |
|---|---|---|---|
| 450K (45 % of 1M, 09-07 → 09-20) | 100 % | 31 | 27.6 % |
| 350K | 80 % | 51 | 17.5 % |
| 272K | 56 % | 79 | 0 % |
| **231,200 (current)** | **52 %** | **108** | **0 %** |
| 200K | 50 % | 143 | 0 % |

Read this as: the 272K cliff is worth ~45 points of cost; the band below it is worth ~6.
(API-list-price equivalent, post-compaction context 70K; `data/sim-astra-trigger-price.csv`.)

## The decision is constrained by price tiers, research continuity and small-window policy

- **Must:** no Astra request above 272K by default; do not break the small-window tiers (models <512K compact at window − 15 %, lean models <50K use their own fractions); keep long research sessions coherent across compactions.
- **Prefer:** fewer compactions; more recent findings retained verbatim; stable cache prefixes.
- **Out of scope:** the Claude 1M policy (45 %), subagent caps, lean mode for sub-50K models.

## The current trigger beats a lower one on continuity and a global fixed trigger on safety

| Option | Decisive upside | Decisive cost | Fatal constraint? | Reversibility |
|---|---|---|---|---|
| 272K window, 231,200 trigger, 48K tail (chosen) | Below the cliff; 108 compactions; no config change for the trigger | 52 % vs 50 % at 200K | No | Config |
| 200K trigger (September proposal A1) | Cheapest band | 32 % more compactions than 231K for 2 points of cost | No, but dominated | Config |
| 245K trigger (Codex default) | Fewest compactions under the cliff | Needs a per-model trigger omp does not have | Requires code | Code |
| Global `thresholdTokens` | One number for Astra | Overrides every small-window tier; on a 32K model it clamps to window − 1 and compaction never fires before overflow | Yes | Config |
| 922K window with 45 % trigger (415K) | Fewer compactions; MRCR recall holds | Every request past 272K at 2× | Yes (cost) | Config |

The trigger already falls out of the small-window rule: 272K × 0.85 = 231,200 (`packages/agent/src/compaction/compaction.ts:406-409`). The real lever left is what survives compaction, not when it fires.

## The choice makes long sessions cheaper and accepts more compactions than today's 1M habit

- **Gains:** ~48 % lower per-session cost than the 1M mode; all requests in the 1× price tier; after compaction ≈ 14K prompt + ≤48K tail + ≤16K summary ≈ 78K, leaving ~150K of runway.
- **Costs:** ~3.5× the compactions of the 450K mode; each resets the cache prefix; a larger tail costs ~4–7 % over 20K.
- **Failure modes:** (1) `/extended-context` re-enables 922K and the 45 % rule moves the trigger to 415K; (2) summaries lose research detail; (3) a 30-minute idle gap rewrites a 231K prefix at cache-write price.
- **Mitigations:** (1) open decision A; (2) `semantic-shake` first (drops stale tool bodies, keeps references) and remote compaction retaining up to 64K of user messages (`packages/agent/src/compaction/compaction-v2-streaming.ts:42,186-188`), plus decision C; (3) decision D.

## The evidence supports the cost case, with the quality curve below 272K unknown

- **Observed:**
  - Pricing tier above 272K and 922K input ceiling: https://developers.openai.com/api/docs/models/gpt-6-astra
  - Codex `gpt-6-astra` `context_window: 272000`, `max_context_window: 872000`: https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json ; compaction at `window * 9 / 10`: `codex-rs/protocol/src/openai_models.rs:525-535`
  - Cache TTL fixed at 30 minutes; compaction and summarization reset cache reuse: https://developers.openai.com/api/docs/guides/prompt-caching (lines 152, 286, 935-941 of the `.md` rendition)
  - omp catalog: Codex Astra 272K standard, 922K extended, no long-context multiplier on the subscription route: `packages/catalog/src/compat/rules/providers/openai-codex.kdl:58-81`
  - Profile: `thresholdPercent: 45`, `thresholdMinContextWindow: 512000`, no Astra window override: `~/.omp/profiles/daily-fork/agent/config.yml:45-46`
  - Usage: 17,869 Astra requests 2026-09-05 → 09-26; nothing above 232K since 09-21: `data/22d-astra-context-bands.csv`, `data/22d-astra-by-day.csv`
  - MRCR v2 8-needle: 100 % at 256–512K, 96.3 % at 512K–1M: https://openai.com/index/gpt-6-astra/
  - Degradation with length for semantic/distractor-heavy content: https://www.trychroma.com/research/context-rot , https://arxiv.org/abs/2502.05167
  - Own frustration signals (negation, repetition, blame, anguish) flat at 4–9 % across context bands, n = 1,580, mostly non-Astra: `data/frustration-by-context.csv`
- **Assumed:** subscription quota consumption tracks API list prices, including the 272K step; the replay's growth model (context carried forward by observed per-request growth, compaction to a fixed size) approximates real sessions — it reproduces the observed 3.4B input tokens at the 450K trigger.
- **UNKNOWN:** Astra's agentic-quality curve below 272K; whether compaction-call usage is fully counted in omp stats views.
- **Confirmation:** after two weeks, no Astra request above 272K; compactions per long session near the replay's estimate; re-read tool calls in the first five turns after compaction do not rise with the 48K tail.

## Implement the tail change now; revisit when Codex changes its Astra defaults

1. Set `compaction.keepRecentTokens: 48000` in the daily-fork, dev-fork and stock profiles and the profile seed. Leave the trigger and `extendedContext: false` as they are.
2. Decide the open items:
   - **A. Extended-context guard** — keep `/extended-context` as a deliberate one-off, or cap the trigger at 245K whenever the window exceeds 272K (code).
   - **B. Tail** — 48K (proposed) or 20K.
   - **C. Notes mode** — trial `compaction.experimentalContextManagement` (persistent notes + searchable raw history) in one research session; OpenAI says the equivalent Codex mode "will become the default for Astra in the coming weeks" (https://openai.com/index/gpt-6-astra/).
   - **D. Idle compaction** — compact before the 30-minute cache expiry so a resume rewrites ~78K instead of ~231K; costs detail, worthwhile only if long sessions often sit idle.
3. Re-run the replay on the next 14 days to confirm.

**Revisit when:** Codex changes Astra's default window or compaction point; OpenAI changes the 272K tier; notes mode becomes the Codex default; or post-compaction re-reads rise.

## Left out

- No debate record exists for this proposal, so there is no convergence section.
- Sub-50K lean mode is a separate change with its own fractions.

## Appendix: method

Session transcripts under `~/.omp/agent/sessions`, `~/.omp/profiles/daily-fork/agent/sessions` and `~/.omp/profiles/stock/agent/sessions` were scanned for `openai-codex` Astra assistant messages; context = input + cache read + cache write. The replay walks each session in order, adds the observed request-to-request growth (negative growth, i.e. a real compaction, adds nothing), and when the simulated context would pass the trigger records a compaction: the summary call is priced as a cached read of the full context plus 16K output, and the next request is priced uncached at the post-compaction size (40K and 70K rows). Prices: $1/M cached, $12.5/M cache write, $50/M output up to 272K; $2, $25, $75 above. Frustration rows join each `user_messages` row in `stats.db` to the preceding main-agent request in the same session.
