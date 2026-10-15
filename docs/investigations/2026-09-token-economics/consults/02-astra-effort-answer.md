## Bottom line

- **[Data-supported]** The clearest cost concentration is **context replay**, not visibly excessive thinking: main-session hub/todo turns consume about **1.11B tokens**, while 87 long subagent runs consume **3.40B**.
- **[Inference]** The strongest candidates for negligible marginal benefit are repeated scheduling turns, standalone bookkeeping, and continued execution without new verified progress. **The telemetry cannot establish a <5% quality benefit for any of them.**
- **[Data-supported]** Subagents start with much smaller contexts and have lower context/output ratios. **[Inference]** Whether they save tokens for equivalent completed work remains unresolved; plausible inline counterfactuals differ by billions of tokens.

### Denominator and limitations

**[Data-supported]** The main-class table sums to **9.20B context + 27.47M output tokens**. Adding the reported **5.84B subagent tokens** gives a working denominator of **15.07B tokens**. Percentages below use that denominator, not dollars.

**[Data-supported]** The supplied aggregates do not fully reconcile: main-class counts sum to **42,770**, versus 44,061 reported main turns; thinking-level counts sum to **42,608**; spawn-batch counts sum to **354 calls**, versus 339 task-spawn turns. Consequently, the percentages are approximate shares of the supplied token aggregates, not audited full-corpus totals.

## 1. Costly patterns and plausible lapses

| Pattern | Data-supported exposure | Inferred mechanism and qualification |
|---|---:|---|
| **Hub-only turns** | **861M tokens; 5.71%** of total. Waits are **2,202/3,497 = 63.0%** of listed hub operations. | Repeated model turns to discover “still running” replay large contexts without advancing the task. Event-driven wake-up could avoid that replay. Necessary messages and job starts are not waste. |
| **Todo-only turns** | **250M; 1.66%**. Together, hub/todo consume **1.111B; 7.38%**. | Updating bookkeeping in a standalone inference can replay the entire context for a small state change. Bundling or external state management could retain its function. |
| **Trivial turns at xhigh/max** | **430.63M; 2.86%**, of which only **0.63M** is output. | Misallocated effort is plausible, but almost all the exposure is context. Lowering effort without eliminating the turn does not recover the 430M context tokens. |
| **Long subagent runs** | **87/853 = 10.2%** of runs consume **3.40B; 22.6%** of total and **58.2%** of subagent tokens. | With an approximately 850k compaction threshold, an initially isolated worker can become another context-heavy main session. Length alone does not establish waste. |
| **Large runs with short final reports** | **81 runs; 740M; 4.91%**. | Possible failure to deliver useful work or communicate it. But file changes, test results, or prior hub messages can carry the value; report length is not a quality measure. |
| **No final/yield output** | **48 runs; 180M; 1.19%**. | Possible abandonment, cancellation, delivery failure, or transcript censoring. Absence of a final message does not prove absence of useful artifacts. |
| **High read duplication** | Reported associated volumes: **240M; 1.59%**, and **130M; 0.86%**. | Redundant discovery can increase both immediate input and subsequent replay. Verification reads can instead be valuable. The brief does not establish that these token volumes are exclusively attributable to redundant reads. |

**[Inference]** The closest match to “plausibly <5% marginal benefit” is **another wait/poll with no new information**, followed by **a standalone todo update that could accompany an already-required turn**. That judgment concerns individual redundant operations—not every turn in either class.

**[Data-supported]** The flagged subagent categories overlap. Their token volumes must not be added into a “waste total.”

## 2. What thinking level actually changes

### Observed output response

**[Data-supported]** These are associations between configured effort and median Anthropic output, **including thinking**:

| Class | Low → max median output | Interpretation of observed association |
|---|---:|---|
| Hub-only | 133 → 136; **+2.3%** | Essentially flat; all five medians lie between 133 and 139. |
| Todo-only | 97 → 290; **+199%** | Strong increase in generated tokens. |
| Read/search | 185 → 209; **+13%** | Non-monotonic; high reaches 249. |
| Bash/eval | 376 → 659; **+75%** | Monotonic increase across the reported levels. |
| Edit/write | 684 → 722; **+5.6%** | Non-monotonic; xhigh reaches 1,096, **60% above low**. |
| Text-only | 452 → 994; **+120%** | Monotonic increase. |

**[Data-supported]** Hub-only output shows almost no response to effort settings. Todo-only output does respond substantially. Therefore, “effort does nothing on trivial turns” is too broad.

**[Inference]** For hub-only turns, the likely problem is **paying for another large-context turn**, not generating a large reasoning trace. For todo-only turns, additional reasoning or verbosity is a plausible avoidable expense, but its quality contribution is unobserved.

**[Data-supported]** Even eliminating *all* output from the 2,043 xhigh/max trivial turns would save only **630,000 tokens: 0.0042% of total tokens**. This is an impossible-to-achieve ceiling for output savings from lowering effort on that fixed set of turns; actual savings would be smaller.

**[Inference]** Consequently, changing those turns from max to low is a secondary optimization. Avoiding the unnecessary inference is the materially larger intervention.

**[Data-supported]** The class-by-level table contains medians, not matched tasks, outcome measurements, or uncertainty intervals. It cannot establish causation, statistical significance, or quality improvement.

**[Inference]** Effort settings appear most behaviorally consequential for bash/eval and text-only turns, and potentially for todo-only turns. None can be labelled **pure cost** conclusively: longer output may be useful reasoning, unnecessary reasoning, or different task composition. For Anthropic, it must not be interpreted as visible verbosity alone.

## 3. Where subagents helped—and what remains unproven

### Demonstrated architectural and accounting advantages

- **[Data-supported] Fresh context:** median first-turn context is approximately **11k**, versus **161k** at parent spawn. Comparing those medians gives **150k fewer tokens**, or a **93% smaller starting context**.
- **[Data-supported] Lower context/output ratio:** **167 versus 335**, approximately **50% lower** for subagents.
- **[Inference]** Fresh contexts provide a credible mechanism for savings: workers need not replay all parent history. The ratio alone does not demonstrate equivalent useful output, because output includes thinking and differs by task and model.
- **[Data-supported] Parallelism opportunities:** **228/354 = 64.4%** of listed task calls spawn multiple workers.
- **[Inference]** These calls permit parallel execution, but no realized speedup is demonstrated without overlap, critical-path, and serial-baseline measurements.

### Where the evidence does not support “subagents failed”

**[Data-supported]** Single-task calls constitute **126/354 = 35.6% of calls**, but only **126/833 = 15.1% of tasks** represented by the batch table.

**[Inference]** A singleton call lacks *within-call* fan-out, not necessarily parallelism: its worker may overlap the parent or workers from other calls. Even genuinely serial delegation can be worthwhile for context isolation.

**[Data-supported]** The 82 runs of at most eight turns consume only **23M tokens: 0.15% of total**.

**[Inference]** Eliminating short delegations is therefore a weak optimization target. Their maximum gross recoverable cost is small, and inline execution would still cost something.

### Where the design loses its advantage

**[Data-supported]** Ten percent of runs account for 58% of subagent tokens; the largest alone consumes **238M tokens**, or **1.58% of total**.

**[Inference]** These workers have lost much of the *small-context* advantage, although they may retain useful isolation or concurrency. Whether they are productive long jobs or unbounded exploration requires outcome and progress evidence.

### Inline counterfactual: two different assumptions

**[Inference—scope assumption]** The calculations below assume the **39,572 subagent turns** correspond to the **5.84B-token cohort**. That linkage needs verification.

**[Data-supported arithmetic]** The reported output share implies approximately:

\[
O_{\mathrm{sub}}=27.47M\times\frac{56}{44}\approx34.96M.
\]

#### A. Parent context held constant at 161k

**[Inference—fixed-context scenario]**

\[
39{,}572\times161{,}000+34.96M
\approx \mathbf{6.41B\ tokens}.
\]

That is **0.57B more** than observed subagent consumption: **9.7% of subagent tokens**, or **3.8% of observed total tokens**.

**[Inference]** This scenario effectively prevents inline working context from growing. It is not a realistic unbounded-parent trajectory, but illustrates why “161k versus 11k” does not imply a 93% saving over entire runs.

#### B. Preserve each worker’s working-context trajectory, but add parent history

**[Inference—additive-context scenario]** Suppose inline execution retains the same task-specific context trajectory but carries an extra **161k − 11k = 150k** on every turn:

\[
\Delta T=39{,}572\times150{,}000
=\mathbf{5.94B}.
\]

Inline subtask work would then cost approximately **11.78B**, about **2.02×** observed subagent consumption. The extra burden equals **39.4% of observed total tokens**.

**[Inference]** Neither scenario is an estimate with statistical confidence, nor are they formal bounds. Actual costs depend on parent-context variation, shared information, compaction, changed turn counts, and delegation overhead. **The defensible conclusion is that isolation has substantial potential value, but its realized causal saving is not identified.**

## 4. Ranked interventions

**[Inference]** The ranges below are **conditional planning scenarios**, not measured expectations. The dataset identifies exposed cost; it does not identify the recoverable fraction.

| Rank | Intervention | Data-supported cost base | Inference: conditional token saving |
|---|---|---:|---:|
| **1** | **Bound subagent context growth using progress checkpoints and scoped continuation.** Check artifacts and remaining work before extending long runs; test a substantially lower context threshold. | Long-tail runs: **3.40B**. | Reducing their token consumption **25–50%**, while preserving outcomes, saves **0.85–1.70B; 5.6–11.3%** of total. |
| **2** | **Replace repeated model-mediated waiting with event-driven resumption; bundle todo updates.** Preserve necessary communication and planning. | Hub waits approximately **542M** under proportional allocation; todo-only **250M**. | Avoiding **50–90%** of this estimated base saves **396–713M; 2.6–4.7%**. |
| **3** | **Require artifact-linked progress and delivery checks for expensive workers.** Resume, redirect, or stop based on evidence of progress—not final-message length. | Large/short-report cohort: **740M**. | If audit finds **25–50% of that consumption avoidable**, saving is **185–370M; 1.2–2.5%**. If artifacts justify the work, saving may be zero. Overlaps rank 1. |
| **4** | **Transfer scoped evidence and artifact references; suppress demonstrably unchanged rediscovery.** | Mean read duplication **12% outward**, **7% on parent return**; flagged associated volumes **240M/130M**. | **Not identifiable from these aggregates.** Need duplicated byte/token sizes and downstream replay. Do not call 370M recoverable. |
| **5** | **Use low effort for mechanical scheduling/bookkeeping where an inference remains necessary.** | High-effort trivial output: **630k tokens**. | **Less than 630k; less than 0.0042%** in direct output savings on the observed turns. Quality and turn-count effects remain unmeasured. |

**[Inference]** The wait estimate allocates hub tokens by operation frequency:

\[
861.06M\times\frac{2{,}202}{3{,}497}\approx542M.
\]

It assumes comparable token consumption per operation and is not a measured wait-turn total.

**[Inference]** Ranks 1 and 2 address separate subagent and main-session cost pools. Under their stated assumptions, their combined planning envelope is **1.25–2.41B tokens, or 8.3–16.0%**. Do not add ranks 3–5 without accounting for overlap.

### Interventions I would not deploy blindly

- **[Inference] No blanket “low effort everywhere.”** The observed output response is substantial on execution and text turns; a small increase in mistakes or rework could erase savings.
- **[Inference] No hard kill at 90 turns.** This selects a costly cohort, not a proven unproductive cohort. Use a review checkpoint and resumable handoff.
- **[Inference] No blanket ban on singleton delegation.** It can preserve the principal benefit: context isolation.
- **[Inference] No deletion of verification reads merely because paths repeat.** Files may have changed, and independent checking can prevent costly errors.
- **[Inference] No production-wide adoption of the external 220–240k optimum without local testing.** The reported higher post-compaction correction rate warns of quality risk; neither that association nor the optimum automatically transfers to this workload.
- **[Inference] No minimum report-length target.** Require verifiable artifacts, unresolved issues, and test evidence—not more characters.

## 5. The measurement that resolves the central uncertainty

**[Inference—recommended experiment]** Measure **tokens per independently verified completed task**, including downstream parent rework, in a task-level randomized evaluation.

1. **[Inference—design]** Start equivalent coding tasks from the same repository snapshot. Stratify by project, model, and task type. Compare:
   - inline versus delegated execution;
   - current versus checkpointed/lower-context workers;
   - current versus event-driven scheduling.
   
   Use separate ablations so mechanisms remain identifiable.

2. **[Inference—quality measurement]** Evaluate with hidden task-specific tests and blinded review against acceptance criteria. Include regressions, incomplete requirements, and parent/user repairs over a fixed follow-up window.

3. **[Inference—telemetry measurement]** Record actual parent context at spawn, per-turn worker context, concurrency intervals, delivered artifact IDs, file versions read, and tokens spent after the last verified progress event. Trace whether “empty-result” workers delivered through files or hub messages.

4. **[Inference—decision rule]** Predefine quality non-inferiority and report both quality and cost uncertainty. If the threshold is “5%,” specify whether that means **5% relative performance** or **five percentage points of task success**; these are materially different.

**[Inference]** The most important missing datum is **whether the expensive extra work changes verified outcomes or prevents later repair**. Without it, this telemetry can rank cost concentrations and plausible mechanisms—but cannot distinguish valuable persistence from waste.
