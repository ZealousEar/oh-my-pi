---
name: decision-writing
description: Write an answer-first decision report (ADR shape) for an architecture, design, or directional decision — header Status/Decision/Confidence/Door/Blast radius, one visual, trade-off table, convergence account, consequences, evidence, next steps. Use when asked to write up a design decision, an architecture decision record, a converge report, or the outcome of a debate/review.
---

# Writing a decision report

Goal: the reader learns the decision, why it wins, what it costs, and how sure we are — in the first line and the headings alone. Skip preambles. Pyramid order: answer, then reasons, then context. Use the project's domain language (`CONTEXT.md` when it exists; otherwise the names the code uses). Render from a structured record (a converge `ledger.json` + `synthesis-latest.md` + `panel.json`, a review's findings, an ADR draft) — never re-argue the question or re-read transcripts while writing.

<critical>
- First line after the title MUST be the header block; `Decision` MUST name one option (a noun), never "it depends" or "both".
- Status vocabulary is closed: `Converged | Converged with dissent | Judge-selected | No convergence | Proposed | Accepted | Superseded`.
- One visual, placed beside the reasons it supports. Two only when the second changes the decision.
- No agent, model, vendor, or participant names in the body. Convergence is described as positions and evidence, not as who said what.
- Every claim in *Evidence* is `Observed` (with a locator), `Assumed`, or `UNKNOWN`. NEVER upgrade an assumption by phrasing.
</critical>

## Skeleton (word budgets per section; total 900–1 200; deep tier ≤ 1 600; appendix ≤ 600)

```markdown
# Decision: <active, specific title>

**Status:** Converged | Converged with dissent | Judge-selected | No convergence
**Decision:** <one sentence: chosen option + principal benefit/cost>
**Confidence:** High | Medium | Low — <one-line basis: evidence kind, residual dissent>
**Door:** One-way | Two-way — <why, when one-way>
**Blast radius:** <one precise noun phrase>

## <Action title stating why the choice wins>                          [120–180]
- <reason 1: capability/value>
- <reason 2: operational or implementation fit>
- <reason 3: risk/reversibility>
<smallest useful visual + one-sentence "read this as…" caption>

## The decision is constrained by <decisive forces>                   [100–160]
- **Must:** <hard constraints and success criteria>
- **Prefer:** <soft drivers>
- **Out of scope:** <only exclusions a reader would expect>

## <Winner> beats the alternatives on <decisive dimensions>          [220–320]
| Option | Decisive upside | Decisive cost | Fatal constraint? | Reversibility |
|---|---|---|---|---|
| Chosen | … | … | No | … |
| Alternative | … | … | … | … |
<2–4 sentences on the non-obvious trade-off; do not narrate every cell>

<!-- convergence -->
## The debate converged after resolving <central disagreement>        [140–220]
- **Initial split:** <the genuinely different positions, not names>
- **Decisive challenge:** <objection/evidence that changed the analysis — cite ids>
- **Why positions moved:** <what was learned or corrected; the `moved_by` chain>
- **Residual dissent:** <best surviving objection, or "None material">
- **Judge:** <deepest tier only: why intervention was needed and which criterion broke the tie; a split names both reasons>

## The choice makes <benefit> easier and accepts <cost>               [160–230]
- **Gains:** … - **Costs:** … - **Failure modes:** <top 1–3> - **Mitigations:** <one per material failure mode>

## The evidence supports the decision, with <named uncertainty>       [130–200]
- **Observed:** <repo facts `path:lines`, benchmarks, incidents, vendor guarantees>
- **Assumed:** <important unverified premises>
- **UNKNOWN:** <facts that could not be established>
- **Confirmation:** <measurement/test/operational signal that will validate the choice>

## Implement now; revisit only if <trigger>                            [80–140]
1. <first irreversible or enabling action> 2. <next step> 3. <verification or rollout gate>
**Revisit when:** <quantified trigger, changed constraint, or deadline>

## Left out                                                         [0–80, optional]
- <expected item deliberately excluded, and why>

## Appendix: judge rationale and source ledger                        [deepest tier only, ≤ 600]
- Criterion-by-criterion ruling · material source links · minority argument worth preserving
```

## Header definitions (borrowed from `skill://pr-writing`, verbatim)

- **Door**: two-way if the decision is cheap to roll back (revert and you're done); one-way if it involves destructive actions, migrations, data/format changes, published APIs, or anything hard to reverse. Say which and, when one-way, why.
- **Blast Radius**: the potential scope of impact if it's wrong — one word (e.g. `none`, `local`, `consumers`, `layout`, `mobile`, `data`, `auth`, `all-users`), then optionally one line of ramifications: consumers that break, layout shift, mobile responsiveness, performance, security surface. A short noun phrase is allowed when architectural scope needs precision.
- **Confidence**: High = decisive evidence observed and no material dissent; Medium = judgment call with residual stakes-2 dissent or an assumed premise; Low = unresolved stakes-3 crux, judge split, or the decision rests on UNKNOWNs.

## Visual

Pick the smallest view that makes the key point clear (views from `skill://show-me`): pseudocode (algorithm), call tree (runtime flow), component tree (UI + state boundaries), shallow file tree (ownership), Mermaid `flowchart`/`sequenceDiagram`/`stateDiagram` (interaction, data flow; short labels — the terminal renders ASCII), `diff` sketch (what changes when the surrounding shape exists; usually best for "status quo → proposed"), whole block (when most of it is new). Keep only the calls, files, states, and boundaries the decision turns on. Caption it.

## Rendering rules

- Action titles state conclusions ("Re-spawn per round beats keep-alive on effort control"), not labels ("Trade-offs").
- Reading only the first line and the headings MUST reproduce the argument. Check this before shipping.
- Trade-off table: every row has `Fatal constraint?` filled (`No`, or the constraint); a hybrid nobody argued for is a synthesis error, not a compromise.
- Convergence section maps 1:1 onto the record: *Initial split* = round-1 positions; *Decisive challenge* = the evidence/objection with the largest Φ drop or the `moved_by` of the closing concession; *Residual dissent* = open cruxes, jointly withdrawn cruxes (as UNKNOWN), and non-verdict-changing falsification objections, by id. A `No convergence` report states the open stakes-3 crux and both positions in this section, under an action title that says so. Keep the `<!-- convergence -->` marker line directly above this section's heading whatever the title: the converge report gate locates the section by the marker, never by the heading text.
- Status quo / proposed is fine; NEVER manufacture an "after" for an unimplemented design. Prototypes, benchmarks, constraint satisfaction, and source-backed assumptions are the evidence.
- Include decision-relevant movement (the decisive objection, why a position changed); omit procedural churn (round numbers, message counts, timings, hub traffic).
- Rewrite, never concatenate: the report is one document, not stitched participant outputs.
- Word budgets are caps; a section under budget is fine when the record has nothing more.
- Store where asked (`local://…/report.md`, `docs/decisions/<date>-<slug>.md`); when unasked, keep it out of the repo.

## Chat summary (accompanies the file, ≤ 8 lines)

`Decision`, `Status`, `Confidence`, `Door`, `Blast radius`, residual dissent (one line), report path, cost/time when known.

<critical>
Answer first; one named option; closed Status vocabulary; one visual beside its reasons; no participant names; Observed/Assumed/UNKNOWN discipline; render from the record, never re-argue.
</critical>
