## Recommendation

**Keep the advisor off; bound the long-running main sessions and subagents; verify cache TTL on the wire; then optimise model routing against measured quota consumption.** Do not treat either a 97% cache-hit rate or a cheaper model name as proof of efficient subscription use.

Your proposed **250k/60k compaction policy is a reasonable Anthropic coordination-session experiment, not a good universal default**. It is too close to the observed Codex ceiling, and too permissive for routine subagents.

**Evidence labels below:**
- **Measured:** your supplied telemetry; I have not independently queried the database.
- **External:** the studies and prices you supplied, not independently verified here.
- **Inference:** an engineering recommendation to test, not an established model capability.

---

## A. Priority order

### 1. Keep the advisor off, and measure the remaining system separately

**Measured:** the advisor consumed 2.64B / 8.79B ≈ **30% of historical tokens**.

That is the largest demonstrated removable workload. But because it is already disabled, **do not count its removal as another prospective saving**.

Your 250k/60k simulation saves:

- 27% × 3.73B main tokens ≈ **1.01B tokens per comparable 14 days**.
- **11.5% of the historical total**.
- Approximately **16.4% of the remaining total after removing advisor traffic**, assuming the rest of the workload stays unchanged.

That is substantial, but not enough to make an otherwise saturated system comfortable. Subagent control must accompany main-session compaction.

**Challenge:** verify that the simulation models the *actual post-compaction prompt size*, including snapshot/image tokens, retained instructions, summaries and subsequent archive retrieval. A simulation that simply resets context to `keepRecentTokens` is optimistic.

### 2. Replace the near-window-limit compaction default

The existing approximately 850k trigger on 1M models is effectively a **capacity-protection setting, not an economic policy**.

Start with this immediately available global configuration:

```yaml
# Existing knobs; use omp's actual configuration syntax.
compaction:
  thresholdTokens: 180000
  keepRecentTokens: 48000

retry:
  usageAwareFallback: confirm
```

Keep advisor disabled. Leave `snapcompact` as the initial strategy **to avoid changing both the trigger and memory representation simultaneously**.

Then implement or manually apply role-specific policies:

| Workload | Compaction trigger | Verbatim tail | Policy |
|---|---:|---:|---|
| Routine main-session coding | 160k–180k | 40k–48k | Default |
| Complex Anthropic coordination | 220k–240k | 60k | Explicit exception |
| GPT-class main session | 180k initially | 48k | Respect actual server limit |
| Routine coding subagent | 96k | 24k–32k | Prefer completion or handoff at cap |
| Bounded search/reader subagent | 48k–64k | 12k–16k | Usually finish before compaction |

**Inference:** these are conservative starting policies, not experimentally established optima.

Apply a separate safety constraint:

\[
T_{\text{trigger}}\leq W-\max(32k,\ 0.15W,\ \text{output reserve + tool burst allowance})
\]

Use the provider’s **actual enforced request budget**, not merely the advertised model window. If 253k approximates the effective Codex input ceiling, a 15% margin leaves about **215k**. A 250k trigger offers almost no protection against a large tool result.

**Challenge to the plan:** 250k/60k is defensible for long Anthropic goal runs, but it cannot be the universal policy when one provider never reaches 253k.

### 3. Budget subagents before moving all of them to another model

**Measured:** subagents consumed 2.27B tokens—approximately **37% of non-advisor historical traffic**. Their average is roughly **5.0M tokens per run**, despite starting at only 11k.

They are not currently just lightweight context-isolation workers. Many become substantial independent sessions.

Implement the policy in section C before deciding that a model switch solves this workload.

### 4. Fix and verify TTL—but do not assume blanket 1h caching wins

The discrepancy between intended 1h caching and recorded `ephemeral5m` deserves immediate investigation. However, the economic fix is **verified, selective longer caching**, not merely replacing every 5m marker.

Verify at three layers:

1. **Serialisation:** does the final outbound request contain the intended TTL?
2. **Provider acceptance:** does this OAuth route support and honour that setting?
3. **Billing/usage:** does an identical prefix reused after, say, **10 and 40 minutes** produce cache reads rather than creation? Include a **70-minute control**.

Session JSONL is strong evidence of a configuration problem, but may describe the harness’s internal representation rather than the final wire request.

The measured idle-expiry rewrites are **35–43M tokens**, or **22–27% of all recorded cache-write tokens**. They are only **0.4–0.5% of total processed tokens**, but writes are disproportionately expensive.

**Important:** the 87% rewrite rate after more than an hour is not generally fixed by a 1h TTL.

### 5. Add quota-aware routing and bounded retries

Set `usageAwareFallback: confirm` initially. Use confirmation for **provider/model/cost boundary changes**, rather than repeatedly interrupting for already-authorised equivalent-account rotation, if omp supports that distinction.

Starting policy:

- Preserve **20% weekly quota** on the strongest reasoning pool for difficult planning, debugging and review.
- Keep routine tasks out of that reserve.
- Route routine work to `gpt-5.6-sol` **as an experiment**, not because its name establishes lower subscription consumption.
- Keep paid overflow explicitly budgeted; an initial guardrail could be **$5/day and $30/week**, adjusted after a measured pilot.
- Treat exhausted weekly quota as a routing or pause condition, not a transient error.

Replace the 3h retry-delay allowance with:

- Transient overload: **at most 3 retries**, roughly **120 seconds total waiting budget**, with jitter.
- Respect `Retry-After`; if it exceeds the interactive budget, checkpoint and pause or route elsewhere.
- `usage_limit_reached`: **no repeated retry on the same exhausted account** before its reset.

**Inference:** multi-hour retry waits can worsen both operational reliability and cache-expiry exposure.

---

## B. Where is the frontier-model “smart zone”?

### What the evidence does—and does not—establish

There is **no defensible model-specific degradation breakpoint for Opus-5, Fable-5/5.1, GPT-6 or GPT-5.6 in the evidence provided**.

The retrieval results concern other model versions. They show that long-context access is not uniformly reliable, but do not establish that:

- coding decisions suddenly deteriorate at 200k;
- Opus-5 inherits Opus-4.6’s exact curve;
- a model with better needle retrieval makes better architectural decisions;
- compaction necessarily improves net task performance.

Agentic decision quality includes maintaining constraints, tracking repository state, choosing tools, rejecting failed hypotheses and recognising completion. Needle retrieval tests only part of that.

The supplied compaction study actually argues for caution: **41.9% post-compaction corrections versus 17.7% baseline** means removing context can create substantial recovery work. That association may also contain workload confounding; it is not necessarily the causal effect of compaction alone.

Likewise, **cost ∝ C²·⁵ is a fitted workload relationship, not a universal scaling law**. For a fixed number of calls, input-token cost is approximately linear in context. Superlinear session costs arise when session duration, growing history and recovery behaviour interact.

### A practical operating zone

**Inference:** target an ordinary main-session working context of roughly **60k–160k**, allow demanding work into **180k–240k**, and require a reason to remain above that.

This is an **economic and risk-management band**, not a claim that model reasoning peaks there.

For your workload:

- **GPT-class:** start at **180k trigger / 48k tail**.
- **Anthropic routine work:** the same.
- **Anthropic complex coordination:** **240k / 60k**.
- Do not adopt **300k–450k** merely because an external study recommends it for some workloads. Your own >300k sessions already account for 65% of main-token traffic.

The retained tail must be supplemented by a small, structured state record:

- current objective and acceptance tests;
- constraints and user decisions;
- repository/worktree state;
- completed changes;
- failed approaches and why they failed;
- unresolved hypotheses;
- exact artifact and test references.

**A 60k tail is not a guarantee that the important decision from 150k tokens ago survives.**

Compact at natural boundaries when possible: completed patch, verified test, finished investigation. Avoid interrupting an unresolved debugging hypothesis solely to hit an exact token number; allow a small bounded grace period, such as **two turns**, below the hard context limit.

---

## C. Do subagents optimise tokens here?

**They provide isolation, but token savings are unproven without a counterfactual.**

A subagent saves tokens when it prevents the parent from repeatedly carrying a large investigation history. It wastes tokens when it duplicates discovery, runs too long, returns a transcript, or causes the parent to re-read everything.

Your data shows both a useful starting condition and an unhealthy tail:

- Fresh start: **11k median**, good.
- p90: **89 turns / 268k peak**, too large for a default bounded worker.
- Top 10% of runs: **47% of subagent tokens**.
- Mean: approximately **44 turns and 5M tokens per run**.

### Recommended subagent contract

| Control | Initial setting |
|---|---:|
| Task-specific brief | **2k–4k tokens** |
| Total initial prompt | Target **≤12k–16k** |
| Progress checkpoint | **20 turns** |
| Soft turn limit | **32 turns** |
| Hard turn limit | **48 turns** |
| Routine coding context cap | **96k** |
| Search/reader context cap | **64k** |
| Cumulative input-token budget | **2M soft / 3M hard** |
| Final report | **1k–3k**, plus artifact references |
| Default concurrency | **2**; increase for demonstrably independent work |

Count cumulative input as **uncached input + cache-read + cache-write**, without double-counting provider fields.

**Inference:** 48 turns at an average 50k context consume roughly **2.4M input tokens**. This makes the turn and token limits reasonably consistent, but it does not predict task success.

At the soft cap, the worker must report:

1. What changed or was established?
2. What verification passed or failed?
3. What specifically remains?
4. Why is an extension preferable to stopping or handing off?

At the hard cap:

- checkpoint artifacts;
- leave the worktree in a documented state;
- produce a structured handoff;
- stop or obtain an explicit budget extension.

**Do not blindly spawn a fresh successor every 48 turns.** Otherwise the “cap” becomes a repeated reconstruction tax. Successors should inherit only the handoff and necessary artifacts, and **the task lineage must retain its cumulative budget**.

Long-lived integration agents can receive a larger explicit allocation. They should not masquerade as ordinary reader workers.

### Model choice

Do not equate the `reader` role with every subagent task.

- Cheap-model candidates: bounded search, inventory, log classification, extraction and mechanical edits with strong tests.
- Frontier candidates: ambiguous debugging, architecture, security-sensitive reasoning and integration.

Using idle Opus quota is reasonable for tasks that benefit from it, but **idle quota is capacity, not evidence of efficiency**.

The supplied cache-read prices imply a **60–87× difference** between GLM and DeepSeek. For **2B cached tokens**, that is approximately **$360–$520 versus $6**. This is a useful price signal, not a total-job estimate: misses, writes, output, availability and extra recovery turns still matter.

Pilot DeepSeek on **20–30 matched bounded tasks**, preserving the same tools and completion criteria. Measure cost and frontier rescue work, not just whether it produced an answer.

---

## D. Compaction can improve token counts while worsening cache economics

### 1. Rewriting the prefix has a real amortisation period

Compaction can invalidate the prefix that was cheap to reread. The relevant quantity is the **newly uncached prefix**, not simply the retained tail.

A conservative approximation is:

\[
\text{turns to amortise}
\approx
\frac{\text{newly written tokens}\times\text{write price}}
{\text{tokens removed per future turn}\times\text{read price}}
\]

**Illustrative assumptions:** compaction reduces 250k to 80k, all 80k must be written, cache reads cost 0.1× base input, and writes cost 1.25× for 5m or 2× for 1h.

Then:

- 5m write: \(80\times12.5/170\) ≈ **6 subsequent turns**.
- 1h write: \(80\times20/170\) ≈ **9–10 turns**.

This is conservative because it omits the baseline read cost on the compaction turn and any preserved cached prefix. It also excludes compaction-generation cost and recovery work.

**Consequence:** compacting a session that is about to end can be a net loss.

### 2. Longer TTL costs more to create

Under those same illustrative cache-price multipliers:

- One creation, no reuse: **1.25× versus 2×**; 1h is more expensive.
- One reuse after 5m but before 1h:
  - 5m: two creations = **2.5×**.
  - 1h: one creation plus one read = **2.1×**.

Break-even requires approximately **0.65 avoided expiry rewrites per initial creation**. That is why TTL should follow reuse patterns.

Use 1h preferentially for stable, resumable main-session prefixes; do not assume it helps short-lived workers or continuously active sessions whose shorter cache remains warm. Verify provider-specific refresh semantics.

### 3. Align compaction with inevitable cache misses

If a prefix has already expired and the session is large, **compact locally before the resumed model call**, where possible. You avoid paying to recreate the entire old prefix immediately before discarding it.

For idle compaction, prefer an **on-resume eligibility check**, rather than eagerly rewriting every abandoned session.

### 4. Preserve a stable prefix

Keep stable instructions, tool schemas and reusable project material before mutable state. Avoid injecting changing timestamps, status summaries or reordered tool definitions near the front.

For `snapcompact`, measure:

- billed image tokens;
- actual post-compaction size;
- archive read-back frequency;
- correction and repeated-tool rates.

**No summarisation call does not mean no cost or no quality loss.**

---

## E. What omp should implement

### Highest priority

1. **Per-role and per-task budgets**
   - Context trigger and hard ceiling.
   - Retained tail.
   - Turn, cumulative-token, dollar and wall-time budgets.
   - Budget inheritance across successor agents.

2. **Real quota accounting**
   - Log provider/account quota deltas when available.
   - Estimate **quota consumed per verified task**, by model.
   - Track reset time and protected reserve.

   Subscription quota and nominal API dollars are different objectives. Your 64% cache-read dollar share does not prove that cache reads cause 64% of subscription exhaustion.

3. **Compaction observability**
   - Reason, strategy, before/after tokens.
   - Newly written prefix tokens.
   - Cache TTL requested and observed.
   - Compaction latency.
   - Subsequent archive reads, repeated tools and corrections.

4. **Controlled handoff**
   - Typed state document plus artifact references.
   - Outstanding hypotheses and verification state.
   - Explicit extension decision.
   - No automatic budget reset.

### Next

5. **Tool-output budgets**
   - Start with **8k tokens per tool result** and **20k aggregate new tool output per turn**.
   - Paginate reads; scope grep by path and result count.
   - Store full logs as artifacts; return summaries and relevant spans.
   - Allow deliberate expansion when needed.

   **Measured:** read and grep account for **175MB of 214MB**, about **82%** of tool-output bytes. Bytes are not tokens, but this identifies the first tools to optimise. Preventing unnecessary ingestion also avoids paying to reread it later.

6. **Cache-aware, boundary-aware compaction**
   - Prefer completed work boundaries.
   - Consider expected remaining turns.
   - Coordinate with cache expiry.
   - Preserve stable cached blocks where the provider permits.

7. **Controlled policy evaluation**
   Compare current behaviour with:
   - **180k/48k** routine policy;
   - **240k/60k** complex-main policy;
   - bounded subagents.

   Track **verified completions per quota point**, tokens, nominal dollars, wall time, operator corrections and post-compaction recovery. Follow at least the next **50 turns** where sessions continue; immediate test success misses delayed forgetting.

## Bottom line

The dominant problem is **persistent oversized working histories**, not insufficient caching. Your fresh subagent starts are already fairly lean; their unbounded lifetime is the issue.

Adopt **180k/48k globally**, reserve **240k/60k for complex Anthropic coordination**, give ordinary subagents **96k context / 48 turns / 3M cumulative input** limits with controlled handoff, and verify TTL end to end. Then route bounded work to cheaper capacity based on **verified completion and actual quota consumption**—not model branding or cached-token price alone.
