# converge — ledger, manifest, round record, jev question sets

Ids: cruxes `C<n>` (statement frozen at admission), evidence `E-<side>-<n>` (`E-0-n` = brief, orchestrator-gathered), experiments `X<n>`. All files JSON except the Markdown artefacts named in the run layout.

## Thresholds (design §1.7; constants `TH` in the orchestrator cell)

| Name | Value | Used for |
|---|---|---|
| material | P(verdict)+P(implementation) ≥ 0.60 | jev M: crux is material; else `wording` (closed, excluded from Φ, kept for the report) |
| stakes | 3 iff P(verdict) ≥ 0.50, else 2 | 3 = flips the decision, the door, or blast radius; 2 = changes cost/risk/rollout/design detail |
| uncertainty | u = P(disagree) + 0.5·P(partial) | jev C after each round; u = 1 for every open crux before its first contest (round 1) |
| close | u ≤ 0.15, both sides addressed the crux this round, and no concession is flagged | `closed_agree` |
| moved_by | an evidence-id `moved_by` MUST resolve to a ledger entry with `verified = true`, `quote_supports_claim ≥ 0.70`, and support established for THE conceded crux: the entry's recorded `supports_crux ≥ 0.60` when it was filed for that crux, else a fresh jev E `supports_crux` against that crux's statement (cached in `entry.supports[C<n>]`; brief `E-0-n` is verified by construction but goes through the same support check); a quoted argument is judged by jev C | unresolved/unverified/non-supporting id ⇒ flag `invalid_moved_by:C<n>:<side>`, treated as sycophancy; `moved_by_status` records why |
| sycophancy | jev C `concession_without_evidence` ≥ 0.60, or an invalid `moved_by` | never lowers Φ below the contested floor: u := max(u, 0.5); `contested_closure` if it would otherwise have closed, else stays `open`; flag `sycophancy:C<n>:<side>` |
| withdrawn | jev C `both_withdraw` ≥ 0.60 — BOTH sides' positions this round withdraw the crux (not established / not decidable here AND neither answer depends on it) | `closed_withdrawn`: excluded from Φ and from the stakes-3 escalation trigger; reported under Residual dissent / UNKNOWN (disclosure "withdrawn by both sides (UNKNOWN): C<n>"); one side withdrawing leaves it open |
| unaddressed | a side gave no position for an open crux this round | crux untouched (no jev C, no closure), history `unaddressed`, flag `unaddressed:C<n>:<side>`; silence is never agreement |
| scoped_out | BOTH sides scope the crux out in the same round (distinct sides, each `why` kept) | one side's entries, however many, never close it |
| duplicate | max P(existing crux) ≥ 0.60 | jev M `duplicate`: merge into that crux (history `restated`), never re-admit; below → distinct |
| evidence | `verified` iff the quote is at the locator AND supports the claim: deterministic first — the whitespace/quote-normalised `quote` (≥ 12 chars) found verbatim in the orchestrator-fetched text sets `quote_present` (false ⇒ never verified; a short, uncheckable quote defers presence to jev) — then jev E `quote_supports_claim ≥ 0.70`; jev E always records `quote_supports_claim` and `supports_crux` | one meaning for every consumer (packets, dossier, report card, `moved_by`); counts in n_r iff `verified` AND `supports_crux ≥ 0.60` AND crux open AND id unseen; `quote_present` is diagnostic only |
| late crux | jev N `verdict_changing` ≥ 0.60 (r ≥ 3, and every falsification objection) | else `deferred` / residual |
| caps | ≤ 3 new candidates per side per round (falsification objections included); ≤ 12 material cruxes per run | beyond → `deferred`; one shared gate (`_admit_candidate`) for rounds and objections |
| reply validity | the COMPLETE phase schema (nested required fields, types, enums, caps, `additionalProperties`) and no `blocked` — `validate_reply` → `_schema_errors`, checked before any state changes | invalid ⇒ `retry` once with the identical packet; second failure ⇒ that side's failure count +1, round forced non-progress, nothing closed from its input; two failures of one side in a run ⇒ `incomplete_transport` |
| Φ_r | Σ_{open ∪ contested_closure} s_c · u_c | |
| ε_r | max(0.25, 0.10·Φ_{r−1}) | progress(r) ⇔ Φ_r ≤ Φ_{r−1} − ε_r OR n_r ≥ 1 |
| streak | first ¬progress → escalate (`-esc` agents, once per run); second consecutive → stop | round 1 never counts |
| backstops | `max_rounds` (L1 1, L2/L3 6) and wall cap (25/75/150 min) → stop as streak 2; the convergence loop stops by round `max_rounds − 1` so the last round is reserved for the reopen | |
| reopen | material, verdict-changing falsification objections are ALWAYS admitted as open cruxes; one more round (`phase = reopen`) at current effort only if `round + 1 ≤ max_rounds` and never twice | `manifest.reopened`; no round left (or L1) ⇒ the admitted cruxes stay open and are named in `falsification.unresolved` — the report says No convergence / Converged with dissent, never plain Converged; a `fatal` objection the caps kept from jev (`deferred:per_side_cap|run_cap`) also blocks plain Converged (disclosed) |
| brief | jev T `brief_leans` ≥ 0.60 → rewrite before spawning | |
| report | jev R `report_matches_ledger` ≥ 0.70 → ship; else rewrite once, then ship with a warning line | |
| experiment | jev X `mutates_network` or `touches_outside_sandbox` ≥ 0.50 → refused | |

Debate states (`terminal_state(ledger)`, math only): `converged` (no open material crux) · `converged_with_dissent` (open cruxes all stakes 2) · `unresolved` (open stakes-3 crux). Effective outcome (`final_status()`, what the report says): `converged` + falsification completed for both sides → **Converged**; `converged` without completed falsification → `converged_unfalsified` → **Converged with dissent** + disclosure line; `converged` with a cap-deferred fatal objection → **Converged with dissent** + disclosure; `converged_with_dissent` → **Converged with dissent**; `unresolved` → **No convergence**, or **Judge-selected** iff the L3 panel's validated joint winner is `A` or `B` (tie/insufficient/split/unavailable never select; they are disclosed); `incomplete_transport` (identity mismatch, or a side failed twice) → no report, owner told. `final_status()` also returns `withdrawn` (ids + statements), `unresolved_objections`, and every disclosure the report MUST carry: falsification skipped/incomplete, unresolved objections, cap-deferred fatal objections, withdrawn cruxes, panel notes (inconsistent judge, missing/incomplete/invalid conference, unsupported change, residual disagreement), contaminated identities, orchestrator-judged bookkeeping. `finish()` persists `terminal_state`, `final_status`, `report_status`, `disclosures`, `wall_ms`, and the harvested `cost_usd`.

## `ledger.json`

```json
{
  "run_id": "20260924-1530-persistent-debaters",
  "tier": "L2", "round": 3,
  "cruxes": [{
    "id": "C1",
    "statement": "Re-spawning debaters per round loses reasoning continuity that outweighs anchoring risk",
    "origin": {"round": 1, "side": "B"},
    "materiality": {"verdict": 0.71, "implementation": 0.21, "wording": 0.08},
    "stakes": 3,
    "positions": {"A": {"text": "…≤120 words", "round": 3}, "B": {"text": "…", "round": 3}},
    "steelman": {"A": "…", "B": "…"},
    "falsifier": {"A": "…", "B": "…"},
    "evidence": ["E-A-2", "E-B-1", "E-0-4"],
    "convergence": {"agree": 0.12, "partial": 0.30, "disagree": 0.58},
    "uncertainty": 0.73, "weight": 2.19,
    "status": "open",
    "history": [
      {"round": 1, "event": "opened", "side": "B"},
      {"round": 2, "event": "position", "side": "A", "detail": "…"},
      {"round": 2, "event": "concession", "side": "B", "moved_by": "E-A-2", "flag": {"concession_without_evidence": 0.22}},
      {"round": 3, "event": "state", "jev": {"agree": 0.12, "partial": 0.30, "disagree": 0.58}}
    ]
  }],
  "evidence": [{
    "id": "E-A-2", "side": "A", "round": 2, "crux": "C1",
    "claim": "Child sessions cannot change thinking level after spawn",
    "locator": "packages/coding-agent/src/task/executor.ts:3577-3581",
    "quote": "Precedence: caller `effort` > explicit `:level` suffix …",
    "verified": true, "quote_present": true, "quote_supports_claim": 0.91, "supports_crux": 0.84,
    "supports": {"C1": 0.84, "C3": 0.22}, "counted_new_in_round": 2
  }],
  "phi": [{"round": 1, "phi": 6.0, "open": 3, "new_evidence": 5, "progress": null},
          {"round": 2, "phi": 3.4, "open": 3, "new_evidence": 2, "progress": true, "reason": "phi_drop"}],
  "non_progress_streak": 0, "escalated_at": null, "reopened": false,
  "deferred": [{"statement": "…", "reason": "not verdict-changing (0.31)", "round": 3, "side": "A"}],
  "flags": ["sycophancy:C3:B"],
  "ref_map": {"1": {"A": {"NEW-1": "C1"}, "B": {"NEW-1": "C1"}}}
}
```

Statuses: `open | contested_closure | closed_agree | closed_evidence | closed_withdrawn | scoped_out | wording | merged:<id>`. Φ sums `open` and `contested_closure` only. `scoped_out` requires both sides in the same round (each side's `why` kept under `scoped_out`) or Main with a `why`; `closed_withdrawn` requires both sides' positions and jev C `both_withdraw ≥ 0.60` (kept under `withdrawn: {round, both_withdraw, positions}`). `initial[side]` = the first position a side stated (the report's *Initial split*); `positions[side]` = the latest. Statements are frozen at ≤ 80 words. `ref_map` records each round's `NEW-k` → `C<n>` admissions. History events: `opened | position | restated | concession (moved_by, moved_by_status, flag) | state (jev, both_withdraw) | withdrawn | unaddressed | scoped_out | unresolved_objection`. `flags` are STANDING flags (`<kind>:C<n>:<side>`): a crux re-evaluated or closed in a round drops its earlier flags; the per-round flags (incl. `invalid:<side>:…`) live in `rounds/<r>/record.json`.

## `rounds/<r>/record.json`

```json
{"round": 2, "phase": "converge|reopen|falsification",
 "effort": {"A": "medium", "B": "high"}, "agents": {"A": "converge-openai", "B": "converge-anthropic"},
 "spawn": {"A": {"job": "Cv3f9a1cR2A", "resolved": "openai-codex/gpt-6-astra:medium", "fallback": false, "wall_ms": 412000,
                 "tokens": {"in": 61000, "out": 9000}, "requests": 14, "cost_usd": 2.83, "tool_calls": 18, "retries": 0}, "B": {}},
 "phi_before": 6.0, "phi_after": 3.4, "progress": true, "progress_reason": "phi_drop|new_evidence|none|forced",
 "cruxes_opened": ["C4"], "cruxes_closed": ["C2"], "cruxes_deferred": 1,
 "flags": ["sycophancy:C3:B", "invalid:A:blocked: …", "unaddressed:C5:B"], "jev_backend": "typesafe|orchestrator",
 "checkpoint": "checkpoints/synthesis-2.md", "started_at": "…", "ended_at": "…", "action": "continue|escalate|stop"}
```

Sibling files per round: `packet-A.md`, `packet-B.md` (exactly what each side received), `packet-<side>-overflow.md` (only when a variable section exceeded its share; named in the packet), `reply-<side>.a<n>.json` (every attempt, raw, immutable), `reply-A.json`, `reply-B.json` (the accepted attempt), `retry.json`, `jev.json` (every `judge()` call: state or its digest, questions, answers, backend, ms), `identity.json` (hub-jobs identity snapshots, incl. `retry`/`pending` results), `spawn-<phase>-a<n>.json` (requested names ↔ sides per attempt), `state-before.json` (ledger + ingestion-owned manifest keys restore point; ingestion is idempotent per round). `spawn[side].cost_usd/tokens/requests` are filled by `harvest_costs` from the child's session file.

## `manifest.json`

`run_id, question, constraints, tier, experiments (bool), sides {A: openai|anthropic, B}, opener (L1 only), expected {A: {family, agent, esc_agent, role, esc_role, model, effort, esc_model, esc_effort}, B: {…}, judges: {J1: {agent, role, model, effort}, J2}}` (frozen from the configured `modelRoles` at `new_run`; identity checks and spawns read only this), `budgets {max_rounds, wall_min, spawn_cap_min[, judge_cap_min]}, per_spawn, jev_backend (typesafe|orchestrator), started_at, status (running|done|incomplete_transport|interrupted), terminal_state (debate math), final_status, report_status, disclosures [], escalated_at, reopened, contaminated_identities, tier_escalations [{from, to, at_round, approved, timed_out, applied, reason, at}], failures {A, B}, falsification {integrated, completed {A, B}, invalid, reopen_allowed, skipped_reason?, admitted [{id, side, statement, why_wrong, evidence, severity, outcome}], residual [same shape], unresolved [C<n> …], verdict_stands}, panel {winner, agreed, outcome, reasons {J1, J2}, notes {unavailable, inconsistent, unsupported_change, missing_conference, incomplete_conference, invalid_conference, residual_disagreement, conference_final_used}}, spawns {"<phase>:<r>": {ids (all attempts), by_who (latest per role), current (last batch), batches [{ids, by_who, at}]}}, report, report_gate, report_gate_section_found, cost_usd, cost_by_job {<job id>: {usd, tokens_in, tokens_out, requests, who, key}} (harvested from each child's session file — the only source of spend), cost_missing [job ids whose session file was not found], wall_ms, ask {tier, experiments, tier_escalation, …}, experiment_worktrees`. Only `failures, falsification, reopened, escalated_at` roll back on a transactional replay.

## Run directory

```text
local://converge/<run-id>/
├── manifest.json
├── brief.md                      # frozen; deltas as brief.delta-<n>.md
├── ledger.json
├── rounds/<r>/  packet-A.md packet-B.md [packet-<side>-overflow.md] reply-<side>.a<n>.json reply-A.json reply-B.json [retry.json]
│                jev.json record.json identity.json spawn-<phase>-a<n>.json state-before.json
├── checkpoints/synthesis-<r>.md, synthesis-latest.md
├── falsification/  packet-A.md packet-B.md reply-<side>.a<n>.json A.json B.json spawn-falsification-a<n>.json state-before.json
├── l3/  dossier.md dossier-BA.md spawn-verdict-a1.json verdict-J1-AB.json verdict-J1-BA.json verdict-J2-AB.json verdict-J2-BA.json
│        spawn-conference-a1.json conference-J1.json conference-J2.json panel.json
├── experiments/  index.json  <r>-<side>-<name>/ script.sh stdout stderr meta.json
└── report.md
```

## jev question sets (exact; `judge(state, questions)`; state = a compact card ≤ ~3 000 tokens, never a transcript)

jev is a clerk: labels from small fixed sets and calibrated probabilities against the thresholds above. NEVER "which position is better".

**Q-set M — materiality** (per candidate crux; state = `{question, constraints, crux, proposer_position, other_side_position, open_cruxes, evidence_summaries}`)

```python
{"materiality": {"type": "choice",
   "instructions": "Classify what resolving this crux changes for the decision described in state.question.",
   "criteria": {
     "verdict": "resolving it flips or blocks the decision, or changes the door (reversibility) or blast radius",
     "implementation": "changes cost, risk, rollout, or design details but not which option wins",
     "wording": "the sides differ only in terminology, emphasis, or presentation"}},
 "duplicate": {"type": "choice",   # only when open cruxes exist; options built from the ledger, ≤ 255
   "instructions": "Is this crux the same disagreement as one of the existing open cruxes listed in state.open_cruxes?",
   "criteria": {"none": "distinct disagreement", "C1": "<C1 statement>", "C2": "<C2 statement>"}}}
```

**Q-set C — convergence** (per open crux both sides addressed this round; state = `{crux, prior_positions {A, B} (from the pre-round snapshot), this_round {A, B} (normalised: NEW-k refs mapped, L1 per_crux included), concessions [{side, crux, moved_by, reason, moved_by_kind: evidence|argument, moved_by_status}], evidence_ids}`)

```python
{"state": {"type": "choice",
   "instructions": "After this round, what is the state of agreement on this crux?",
   "criteria": {
     "agree": "both sides assert the same resolution and any conceding side names what changed its mind",
     "partial": "agreement on part of it, or conditional on something not yet established",
     "disagree": "the positions still conflict"}},
 "both_withdraw": {"type": "bool",   # always included; >= 0.60 => closed_withdrawn (D1)
   "instructions": "Do BOTH sides' positions this round withdraw this crux: each states it is not established or not decidable here AND that its own answer no longer depends on it?",
   "criteria": {"true": "both sides withdraw it and neither answer depends on it", "false": "at least one side still asserts a resolution, relies on it, or is silent about it"}},
 "concession_without_evidence": {"type": "bool",   # only included when a side conceded this round
   "instructions": "Consider the conceding side's stated reason. Is the concession unsupported: it cites no specific new evidence id or specific argument absent from its own prior position, or it defers to the other side's confidence or authority?",
   "criteria": {"true": "no new evidence/argument named, or deference", "false": "names a specific evidence id or argument that was absent from the conceder's prior position"}}}
```

**Q-set E — evidence admission** (per new evidence entry, AFTER the deterministic presence check; state = `{claim, locator, crux, quote_present_verbatim, quote (the debater's quote when present, else null), context_as_fetched_by_orchestrator}`; the orchestrator fetches the locator itself — a debater's paste is never the state). `supports_crux` alone (`Q_E_CRUX`, state = `{claim, locator, quote, crux}`) re-evaluates an existing entry against a different crux when it is cited as `moved_by`.

```python
{"quote_supports_claim": {"type": "bool",
   "instructions": "Does the text at the locator (state.quote when quote_present_verbatim is true, else state.context_as_fetched_by_orchestrator) support the claim as stated (not a weaker or different claim)?",
   "criteria": {"true": "the text establishes the claim", "false": "the text is absent, irrelevant, or supports only a weaker/different claim"}},
 "supports_crux": {"type": "bool",
   "instructions": "Would a careful engineer's belief about the crux change on reading this evidence?",
   "criteria": {"true": "bears on the crux", "false": "tangential or already implied by existing evidence"}}}
```

**Q-set N — late crux / falsification admission** (state = `{synthesis, candidate_crux, argument}`)

```python
{"verdict_changing": {"type": "bool",
   "instructions": "If this crux were resolved against the current synthesis, would the decision (option, door, or blast radius) change?",
   "criteria": {"true": "the decision would change", "false": "only details, confidence, or wording would change"}}}
```

**Q-set X — experiment screen** (state = `{script, cwd}`): `mutates_network` bool ("pushes, publishes, posts, or writes to a remote/network resource"), `touches_outside_sandbox` bool ("writes or deletes outside the given cwd or /tmp").

**Q-set T — tier pre-screen + brief neutrality** (state = framed question + constraints; later the brief): `door` choice {`one_way`: "hard to reverse: migrations, published APIs, data formats", `two_way`: "revert and done"}; `evidence_kind` choice {`empirical`: "settled by measurement or experiment", `judgment`: "trade-off weighing", `lookup`: "settled by reading code/docs"}; `blast` score [`local`, `subsystem`, `product_wide`]; `brief_leans` bool ("does the brief favour, rank, or hint at one option?").

**Q-set R — report gate** (state = `{ledger: {effective_status, debate_state, disclosures, panel, open_crux_ids, withdrawn_crux_ids, unresolved_objection_crux_ids, cruxes [{id, statement, status, stakes, initial {A, B}, final {A, B}, concessions [{side, round, moved_by, moved_by_status}], withdrawn, evidence}], verified_evidence [{id, claim, locator, crux}], falsification {verdict_stands, objections [{id, statement, why_wrong, severity, outcome}]}}, report_header, convergence_section, convergence_section_found}`): `report_matches_ledger` bool ("does the report's Status/Decision/Residual dissent match the ledger's final state and the panel ruling, without new claims? … a claim in the report absent from these is a new claim"). The convergence section is located by the `<!-- convergence -->` marker line the decision-writing skeleton carries (any heading works: Converged or No convergence); fallback = the first `## ` heading mentioning convergence/dissent/split; none ⇒ `convergence_section_found = false` on the card.

Answer shapes returned by `judge().wait()`: bool → `{"type": "bool", "bool": p}`; choice → `{"type": "choice", "choice": label, "probabilities": {label: p}, "confidence": c}`; score → `{"score": s, "probabilities": {…}}`. When jev is unavailable Main supplies the same shapes via `jev_answer(digest, answers)`.
