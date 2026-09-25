---
name: converge
description: Make two frontier models (Astra and Fable) argue a hard design, architectural, or directional question until they converge, with jev bookkeeping, progress-based stopping, effort escalation, and an optional Kimi/GLM judge panel; ends in a decision report. Use when the user says "converge", asks two models to debate or argue a question, or wants the most trustworthy answer to a one-way-door decision.
---

# converge

You are the orchestrator (Main). Debaters and judges are read-only subagents you spawn per round; jev (`judge()` in your eval kernel) is the clerk; `local://converge/<run-id>/` is the record; the owner speaks through `ask`. References: `references/orchestrator.md` (the eval cell), `references/ledger.md` (schemas, thresholds, jev question sets), `references/packets.md` (packets, L1 protocol, debater rules), `references/panel.md` (L3). Report skill: `skill://decision-writing`.

<critical>
- Orchestrator only: this skill runs in the top-level session. NEVER hand it to a subagent.
- The tier `ask` is mandatory and MUST be tailored to this question (§2). "Your call" ⇒ L2.
- jev is bookkeeping only: materiality, convergence state, evidence support, sycophancy flag, screens. NEVER ask it which side is right. L3 judges are agents.
- Identity check after every spawn batch (§0.4). Mismatch ⇒ cancel, `incomplete_transport`, tell the owner. NEVER report a two-model result you did not verify was two models.
- Files are truth: every round starts with `load()`; nothing load-bearing lives only in your context. Only you write under `local://converge/`.
- NEVER poll. After a batch: one `proc://` identity snapshot ≤ 60 s (`await tool.read(path="proc://")`), a `bash(**wake_timer(deadline_in_s(r, phase)))`, then `wait` / auto-delivered yields / independent work; on EVERY wake run `overdue(snap)` and write its `kill` requests. Children push `BLOCKED:` / `NEEDS-APPROVAL:` to `agent://Main`; their `turn: "final"` yield is DONE (interim wake-turn yields are progress, not replies).
- Blindness in L2/L3 round 1 is yours to keep: packets omit the sibling; the peer's name is never revealed in L2.
</critical>

## 0. Preflight

1. Load and run `references/orchestrator.md`'s cell in your Python eval kernel (once per session) from the file on disk: the kernel's `read()` elides the middle of a file this size, `:raw` included. Get the path with bash `realpath skill://converge/references/orchestrator.md`, then `exec` the ```` ```python ```` block under `## The cell` of `open(path).read()`. The cell prints `converge orchestrator loaded (18.3): …`; anything else ⇒ stop.
2. `new_run(question, tier, experiments, constraints=…, channel=<this session's launcher, e.g. "ompnext">)` after §1–2 (needs the tier). It runs a bounded, closed-stdin `<channel> config get modelRoles --json` and freezes the six `converge-*` roles' model + effort into `manifest.expected` — the running channel's effective settings are the only place a model or effort is chosen (no config.yml fallback: overlays and policy count); a missing binary, missing role (preset tombstone), or empty value fails here, before any spawn. Never point a candidate profile at the stable channel's binary or vice versa. Run id `<YYYYMMDD-HHMM>-<slug≤24>`; root `local://converge/<run-id>/`.
3. `await jev_probe()`: one bool. Failure ⇒ `manifest.jev_backend = "orchestrator"`; you answer every card yourself (§7) and the report says so. Every jev-consulting helper is a coroutine: `await ingest_round(...)`, `await ingest_falsification(...)`, `await report_gate(...)`.
4. **Every spawn batch**: `result = task(**batch)` → `ids = register_spawn(r, phase, {requested name: "<agent id>" | {"agent": …, "job": …}})` from the result's `- <agent id> (job <job id>)` lines = THIS batch's `{side|judge: {agent, job}}`. Names are run/round/phase-specific and never addresses; the agent id addresses `agent://` (messages, `<agent id>.jsonl` costs), the job id addresses `proc://` (identity rows, `proc://<job>/kill`). `spawn_ids(r, phase)` = the merged mapping across retries (peer release via `peer_messages`, kills via `cancel_requests`). `register_spawn` stamps the batch's `deadline_at` (spawn/judge cap).
5. **Identity check** (every batch, debaters and judges): ≤ 60 s after `task`, `snap = await tool.read(path="proc://")` (reads never acknowledge delivery) → `exp = expected_for(r, ids)` for a debater batch, or `exp = expected_judges(stage, ids)` for a judge batch (one or the other, never merged; each raises on the other's roles) → `chk = identity_check(snap, exp, ids)` with `ids` = exactly what `register_spawn` returned for THIS batch: the expectation is built from those ids, and `identity_check` raises if the two do not name the same roles (a spawned id can never go unchecked). Label matching is not allowed (names repeat across rounds); rows are matched by job id, then `agentUrlId`. Every row: identity = expected model, thinking = expected effort (18.3 rows carry no fallback flag — a fallback is a different identity, and the roles' empty `retry.fallbackChains` forbid one). `chk["retry"]` (rows still `pending` — identity fields fill ~20–25 s after spawn) ⇒ re-read `proc://` on the next wake, never sleep. `chk["mismatches"]` ⇒ write every `cancel_requests(ids)` entry, `incomplete_transport`, tell the owner.
6. Experiments on (§6) ⇒ `enable_experiments(repo_cwd)` before round 1 and pass `tools=["run_experiment"]` to `spawn_round`.

## 1. Frame and brief

Extract: `question` (one sentence, decidable); hard constraints (Must / Prefer / Out of scope); success criteria; options already on the table (alphabetical, no recommendation); known facts with locators; assumptions; unknowns. Underspecified ⇒ `rule://grill-first` applies before this skill starts.

**Brief** `brief.md` (`write_brief(text, evidence)`, ≤ 6 000 words, frozen): question; constraints; options alphabetical; facts with locators; assumptions; unknowns; evidence index `E-0-n` (each `path:lines` or URL + quote ≤ 600 chars, gathered by you). NEVER a recommendation, ranking, or "likely" language. Pre-screen with jev T (`door`, `evidence_kind`, `blast`) — cheap, informs the ask descriptions; jev T `brief_leans ≥ 0.60` ⇒ rewrite before spawning. Side assignment A/B ↔ {openai, anthropic} is `new_run`'s coin flip: never disclosed to debaters, judges, or the report body.

## 2. Tier ask (one `ask`, ≤ 2 questions)

Q `tier`: options `L1`, `L2`, `L3`; `recommended: 1` (L2) always. Each `description` MUST be written for THIS question, in order: (a) what the tier catches / misses here — name the concrete risk with the question's own nouns; (b) expected rounds and wall time (§3 table); (c) efforts (`Astra medium / Fable high`; L3 adds `Kimi K3 max + GLM-5.3 max`). Generic boilerplate is a failure.

```json
{"questions": [{"id": "tier", "question": "Which converge tier for: <question>?", "recommended": 1, "options": [
  {"label": "L1 — direct exchange", "description": "Catches: <e.g. the obvious keep-alive vs re-spawn trade-off, fast>. Misses: framing anchoring on whichever side opens — for a one-way door on <X> that matters; a lost peer message degrades it to two monologues. 1 exchange, ~15–25 min. Astra medium / Fable high."},
  {"label": "L2 — blind drafts + ledger (recommended)", "description": "Catches: independent priors on <crux nouns>, sycophantic collapse (moved_by + jev flag), premature stop (escalation before stop). Misses: a shared false premise both models hold about <Y>. 1 blind + ≤4 converge rounds + falsification, ~45–75 min. Astra medium→high / Fable high→xhigh on non-progress."},
  {"label": "L3 — L2 + judge panel", "description": "Adds: two non-OpenAI/Anthropic judges scoring 7 criteria on an anonymised dossier, both orderings; settles an unresolved stakes-3 crux on <Z> as Judge-selected. Costs: +6 judge spawns, ~+45 min. Kimi K3 max + GLM-5.3 max."}]}]}
```

Q `experiments` only if jev T `evidence_kind = empirical ≥ 0.5` or the question names a measurable quantity: `off` (recommended) / `on` — description states what would be measured, where (`/tmp/converge/<run-id>/<side>` worktrees), serialized; choosing `on` IS the approval. Record with `record_ask`. "Other: your call" ⇒ L2, experiments off. Ask timeout ⇒ recommended options.

## 3. Tiers

| Tier | Rounds (max) | Wall cap | Per-spawn cap | Debater spawns | Est. cost |
|---|---|---|---|---|---|
| L1 | 1 exchange | 25 min | 20 min | 2 | $4–8 |
| L2 | 1 blind + 4 converge (rounds 1–5) + 1 reopen (round 6) = 6 | 75 min | 15 min | ≤ 12 | $20–35 |
| L3 | L2 loop (6) + panel | 150 min | 15 min debaters / 25 min judges | ≤ 12 + 6 judge spawns | $30–50 |

Per debater spawn: ≤ 30 tool calls, ≤ 10 `web_search`, position ≤ 700 words, packet ≤ 3 000 words + brief pointer (instructions and every open crux id are never truncated; overflow goes to a named side file; the cell raises `PacketOverflow` rather than ship over the cap). The convergence loop stops by round `max_rounds − 1`; round 6 exists only for the reopen. **Reply gate**: `ingest_round` validates each yield against its COMPLETE phase schema (nested fields, enums, caps, no extra keys) before touching state — `action: retry` ⇒ `spawn_round(r, sides=res["retry"], attempt=2)` with the identical packet, `register_spawn`, identity check of that batch; a second invalid/blocked reply ⇒ that side's failure count +1, the round is forced non-progress, nothing closes from its input; a side failing twice in a run ⇒ `incomplete_transport`. Over the per-spawn cap (`overdue(snap)` on any wake) ⇒ write its `proc://<job>/kill` request and treat that side as an invalid reply.

**L1 — direct exchange** (`references/packets.md`)

```text
spawn_round(1) → task [Cv…R1A, Cv…R1B] (opener = manifest.opener; the NON-opener drafts; each side gets its own outputSchema)
ids = register_spawn(1, "converge", …) → for m in peer_messages(spawn_ids(1)): write(**m)      ← releases peer contact (`PEER: <agent id>`)
  opener  --agent://--> responder : position ≤500 words + cruxes            (opener yields turn "opening"; the message wakes the responder)
  responder --agent://--> opener  : position + cruxes + objections          (responder yields turn "response")
  opener  --agent://--> responder : rebuttal + concessions (moved_by)       (opener yields turn "final")
  responder yields L1 draft (2.4.1 + required objections)   opener yields 2.4.3 concurrence per crux + objections
ingest_round(1, replies) → checkpoint → escalation_needed()? ask §5 → report   (admitted objections stay OPEN cruxes: L1 has no reopen)
```

One round, no effort escalation, no reopen (objections are classified in place; a verdict-changing one becomes an open crux and drives the escalation ask). Peers wait for your `PEER:` message before any contact (ids are allocated by the harness; names repeat). Subagents have no `wait`: the exchange runs as wake turns — each side sends with `write agent://<peer>`, yields its schema tagged `turn` when it needs the peer's next message, and is woken by that message; only the `turn: "final"` yield is a reply (interim yields reach you as job results — ignore them; `ingest_round` raises on one). Each side ≤ 3 messages; a side woken with no peer message 15 min after its last send yields final with `blocked`, and your `overdue()` kills a side past the spawn cap ⇒ retry that side once: `spawn_round(1, sides=[X], attempt=2, extra=l1_transcript(1, <other side>))` → `ids = register_spawn(1, "converge", …)` → `identity_check(snap, expected_for(1, ids), ids)` → `peer_messages(spawn_ids(1))` (the surviving peer is revived by the write); a second failure voids the exchange (non-progress) and the escalation ask follows.

**L2 — blind drafts + ledger-mediated convergence** (default)

```text
round 1  spawn_round(1)  ← brief only, no peer name, "agent://Main only"; register_spawn; identity check; wake timer
         ingest_round(1) : validate replies (full schema) → admit cruxes (jev M, dedupe, caps) → verify evidence (quote presence, then jev E) → Φ₁ → checkpoint(1)
round r≥2 spawn_round(r) ← own last position + open cruxes (ids always; both positions anonymised) + other side's novel claims/evidence + requested
         ingest_round(r) : validate → admit → verify → jev C per crux both sides addressed (state + both_withdraw; moved_by must resolve to evidence verified FOR that crux; sycophancy flag)
                           → Φ_r → progress → checkpoint(r);  action: retry | continue | escalate (next spawn_round uses converge-*-esc) | stop | incomplete_transport
stop (streak 2, Φ_r = 0, round 5, wall) → falsification (§5) → maybe the reopen round 6 → final_status → report
```

**L3 — L2 loop + panel** (`references/panel.md`)

```text
L2 loop → falsification → dossier() [dossier.md A-first + dossier-BA.md B-first] → task(spawn_panel("verdict")) [J1-AB, J1-BA, J2-AB, J2-BA] → register_spawn → identity check
mapped = panel_verdicts(raw) [validate FULL 2.5.1, map BA back, complete/consistent per judge] → task(spawn_panel("conference", mapped["verdicts"])) → register_spawn → peer_messages(spawn_ids(0, "conference")) → ≤3 agent:// messages each, wake turns, `turn: "final"` yields
YOU validate every changed (or inconsistent) judge's cited reason → panel_aggregate(mapped, conferences, accept_changes) → panel.json (conference counts only with exchange_completed)
unresolved + joint winner A|B ⇒ Judge-selected; tie/insufficient/split/unavailable ⇒ debate Status + disclosure; every panel note (inconsistent judge, missing/incomplete conference, unsupported change) is disclosed regardless; an agreed fatal_flaw against a converged answer ⇒ reopen rule
```

## 4. Stopping rule (exact; parameters fixed in `TH`)

- Crux `c` is **material** iff jev M `P(verdict)+P(implementation) ≥ 0.60`; else `wording` (closed, excluded from Φ, kept for the report).
- **stakes** `s_c ∈ {2,3}`: `3` iff `P(verdict) ≥ 0.50` (flips decision or door), else `2`.
- **uncertainty** `u_c = P(disagree) + 0.5·P(partial)` from jev C after each round (round 1: `u_c = 1` for every open crux — nothing has been contested yet).
- `status = closed_agree` iff both sides addressed the crux this round, `u_c ≤ 0.15`, and no concession is flagged. A concession is flagged when jev C `concession_without_evidence ≥ 0.60` OR its `moved_by` is an evidence id that does not resolve to a `verified` entry whose support for THIS crux is established (recorded when filed for it, else re-asked via jev E `supports_crux`); flagged ⇒ `u_c := max(u_c, 0.5)` (`contested_closure` if it would otherwise have closed). A crux one side did not address is untouched (`unaddressed`, never closed). `scoped_out` needs both sides in the same round.
- `status = closed_withdrawn` iff both sides addressed the crux this round and jev C `both_withdraw ≥ 0.60` (each side states it is not established / not decidable here AND its answer no longer depends on it). Excluded from Φ and from the stakes-3 escalation trigger; reported under *Residual dissent* as UNKNOWN with a disclosure. One side withdrawing changes nothing.
- **Φ_r = Σ_{c open after round r} s_c · u_c** (`open` ∪ `contested_closure`).
- **new cited evidence in round r** = entries with `verified = true` — the whitespace-normalised quote is found verbatim at the orchestrator-fetched locator (a quote too short to check defers to jev) AND jev E `quote_supports_claim ≥ 0.70` — attached to an open crux with jev E `supports_crux ≥ 0.60`, id unseen before r. Count `n_r`. `verified` has this one meaning everywhere (packets, dossier, report card, `moved_by`); `quote_present` is a diagnostic field.
- **progress(r)** ⇔ `Φ_r ≤ Φ_{r−1} − ε_r` with `ε_r = max(0.25, 0.10·Φ_{r−1})`, OR `n_r ≥ 1`.

Loop (r starts at 2; round 1 never counts as non-progress):
1. `progress(r)` ⇒ `streak = 0`; continue.
2. first `¬progress(r)` (`streak` 0→1) ⇒ **escalate**: next round spawns `converge-openai-esc` (Astra high) and `converge-anthropic-esc` (Fable xhigh); `manifest.escalated_at = r`. Once per run; both sides together.
3. second consecutive `¬progress` (`streak = 2`) ⇒ **stop**.
4. every round ⇒ `checkpoint(r, …)`; an interrupted run's deliverable is the latest checkpoint.
5. stop or `Φ_r = 0` ⇒ **falsification turn** (§5). Material, verdict-changing objections (jev M material AND jev N `verdict_changing ≥ 0.60`, through the same admission gate and caps) are ALWAYS admitted as open cruxes: run **one** more round (`phase="reopen"`, current effort) if `round + 1 ≤ max_rounds` (`manifest.reopened = true`; never twice); no round left (or L1) ⇒ they stay open and unresolved — the Status follows the open cruxes and the disclosure names them. A `fatal` objection the caps kept from jev also blocks plain Converged.
6. r ≥ 3: a candidate crux is admitted only if jev N `verdict_changing ≥ 0.60` (else `deferred`). r ≤ 2: admitted if material. Per side ≤ 3 new candidates/round (objections included); run cap 12 material cruxes.
7. Hard backstops: the loop stops at round `max_rounds − 1` (the last round is the reopen's), wall cap ⇒ stop as if `streak = 2`. A round with failed input never stops the run on Φ = 0.

Debate state (`terminal_state`, math only): `converged` | `converged_with_dissent` (open cruxes all stakes 2) | `unresolved` (open stakes-3). Effective Status (`final_status()`, what the report says): `converged` + falsification completed for both sides → **Converged**; `converged` without it, or with a cap-deferred fatal objection → **Converged with dissent** + disclosure; `converged_with_dissent` → **Converged with dissent**; `unresolved` → **No convergence**, or **Judge-selected** iff the panel's validated joint winner is A or B; `incomplete_transport` → no report, owner told. `final_status()["disclosures"]` is the complete list the report MUST carry (falsification, unresolved objections, withdrawn cruxes, panel notes, contaminated identities, orchestrator-judged bookkeeping). `finish()` persists both plus the harvested cost.

## 5. Checkpoint, falsification, escalation ask

- **Checkpoint** every round: `checkpoint(r, text)` — best-so-far answer in the decision-writing skeleton, ≤ 600 words; the helper coerces the header to the stopping rule (`**Status:**` := the debate-state label, interim; `**Confidence:**` capped at Low with an open stakes-3 crux, Medium with any open crux), prepends state/`Φ_r`/open/withdrawn cruxes, and copies to `synthesis-latest.md`. Rewrite, never concatenate.
- **Falsification**: `spawn_round(r, phase="falsification")` — both sides, current effort, `synthesis-latest.md` + closed cruxes, "strongest reason the agreed answer is wrong" (schema 2.4.2, ≤ 6 objections). `ingest_falsification(replies)` ⇒ `retry` (invalid/blocked, once) | `reopen` ⇒ `spawn_round(r+1, phase="reopen")` + `ingest_round(r+1, …, phase="reopen")` + checkpoint | `final`. Objections keep `why_wrong` + evidence ids ⇒ report *Residual dissent* / *Failure modes* and the converged dossier's Position B. Wall cap with < 10 min left ⇒ `skip_falsification("wall cap")` — the report then says Converged with dissent + the disclosure, never plain Converged.
- **Tier-escalation ask** (`e = escalation_needed()`): at stop, if `unresolved` OR `Φ_end > 0.5·max_r Φ_r` OR L1 ended with an open stakes-3 crux (withdrawn cruxes never count) ⇒ one `ask`: `accept best-so-far with dissent` is ALWAYS the `recommended` option (a timed-out ask selects it — spend needs a live owner); `escalate to <next tier>` carries the description (which cruxes, what the next tier adds, added time/cost) and, since `e["advise"] == "escalate"` exactly when `e["needed"]`, the words "orchestrator advises escalation". Then `escalate_tier(e["next_tier"], approved=<owner chose escalate>, timed_out=<ask timed out>)` — it updates tier, budgets, and `tier_escalations` atomically and refuses on timeout. L1→L2 continues the ledger without blind drafts (`contaminated_identities`, disclosed); L2→L3 runs the panel on the current ledger. Declined ⇒ report with the residual.

## 6. Experiments (owner-approved only)

`on` ⇒ `enable_experiments(repo_cwd)`: one detached worktree per side at `/tmp/converge/<run-id>/<side>` (owner tree untouched) and the kernel `@tool run_experiment(side, name, script, timeout_s=300)`: the COMPLETE script is jev-X screened (`mutates_network`, `touches_outside_sandbox` ≥ 0.5 ⇒ refused; > 12 000 chars ⇒ refused unscreened), stored under `experiments/<r>-<side>-<name>/`, run with a scrubbed env under a global lock (benchmarks serialized) and a `subprocess` timeout; stdout/stderr/exit/duration/timeout logged even on timeout; returns a summary + `exp:X<n>` — the only valid `exp:` locator. Debaters get it via `spawn_round(r, tools=["run_experiment"])`; no agent-file variant. `off` ⇒ a debater's `experiment_request` rides in its reply; ask the owner before the next round; approval flips the toggle for the rest of the run. `cleanup()` removes the worktrees.

## 7. Failure handling

| Failure | Detection | Action |
|---|---|---|
| jev unavailable / error | helper raises `JevUnavailable(digest, state, questions)` (fails closed) | Answer the same question ids yourself with calibrated probabilities → `jev_answer(digest, answers)` → re-run the same helper (idempotent per round). `jev.json.backend = "orchestrator"`; report *Evidence* says "bookkeeping judged by orchestrator (jev unavailable)". Never silently. |
| OpenRouter judge failure (auth, 4xx, `finish_reason: length`, route unavailable, invalid 2.5.1) | spawn error / `panel_verdicts` `invalid` (full-schema check) / identity mismatch | Retry that spawn once: `spawn_panel(stage, who=["J2-BA"], attempt=2)` → `ids = register_spawn(0, stage, …)` → `identity_check(snap, expected_judges(stage, ids), ids)`; still failing ⇒ that judge is `unavailable`; a panel of one is not a panel: Status = debate's, disclosure `panel unavailable`. Never substitute a model. |
| Debater crash / invalid schema / blocked / timeout | `ingest_round` → `action: retry`; per-spawn cap | Re-spawn those sides once with the identical packet (`spawn_round(r, sides, attempt=2)`), register, identity-check that batch; second failure ⇒ that side's failure count +1, round forced non-progress, nothing closes from its input; two failures of one side in a run ⇒ `incomplete_transport`. Every attempt is persisted raw. |
| Identity row `pending` | `identity_check` → `retry: True` | Not a failure: identity fields fill ~20–25 s after spawn. `wait` (or independent work), re-read `proc://` on the wake, re-check. NEVER `time.sleep` in eval. |
| Identity mismatch | `identity_check` → `mismatches` | Write every `cancel_requests(ids)` entry (`proc://<job>/kill`); `incomplete_transport`; name the role and what it resolved to. |
| Over-cap spawn / silent peer | `overdue(snap)` on any wake (the wake timer guarantees one at the deadline) | Write its `kill` requests; the side is a timeout ⇒ retry once per the row above. L1 / conference: a peer never contacts anyone until your `PEER: <agent id>` message; a child woken with no peer message 15 min after its last send yields `turn: "final"` with `blocked` ⇒ retry once with `extra` = transcript so far. A `Failed:` delivery receipt on your write ⇒ the recipient is gone: treat as that side's failure. Yields auto-deliver; `agent://<id>` recovers a missed one. |
| Your own compaction | — | Every round begins with `load()`; packets are rendered from the ledger, never from memory. |
| Owner does not answer `ask` | ask timeout | Tier ask auto-selects L2; escalation ask auto-selects `accept best-so-far` (it is always the recommended option; `escalate_tier` refuses with `timed_out=True`); experiments stay off. |
| Wall cap | `_wall_exceeded()` on any wake | Stop as `streak = 2`; falsification still runs if ≥ 10 min remain, else `skip_falsification("wall cap")` — disclosed, never plain Converged. |
| Conference judge changed its mind / order-inconsistent judge | `changed_from_independent = true` / `mapped["consistent"][J] == False` | Read the `why`: a cited dossier section / evidence id ⇒ `accept_changes={J: True}` (for an inconsistent judge this is the only way its final counts); deference to the peer ⇒ leave unaccepted (independent verdict stands, recorded `unsupported_change`). `exchange_completed = false` ⇒ conference incomplete: independent verdict stands, disclosed. |
| Child `NEEDS-APPROVAL:` | message from the child (`[<id>] <from>: NEEDS-APPROVAL: …` on your `wait`) | Only you can `ask`: ask the owner, reply with `write` to `agent://<from>`. Children never block a round on approval (they continue reachable work; your reply wakes them if they have yielded); experiments ride in the reply. |

## 8. Report, summary, cleanup

1. `fs = final_status()`. Read `skill://decision-writing`. Render `report.md` from `ledger.json` + `synthesis-latest.md` (+ `panel.json`) — never from transcripts or your memory of the rounds. 900–1 200 words (L1/L2), ≤ 1 600 (L3) + optional judge appendix ≤ 600. Status = `fs["status"]`; every line in `fs["disclosures"]` appears in the header's Confidence basis or the *Evidence* section; `fs["withdrawn"]` goes under *Residual dissent* as UNKNOWN. Keep the skeleton's `<!-- convergence -->` marker line above the convergence section (any action title; the gate locates the section by it). No model names in the body; the appendix MAY disclose the A/B mapping after the verdict.
2. `report_gate(report_md)` ≥ 0.70 (the card carries the effective status, disclosures, panel ruling, every crux with statement, initial and final positions, concessions with `moved_by`, withdrawn cruxes, verified evidence `{id, claim, locator}`, falsification objections with `why_wrong`) ⇒ write `report.md`; below ⇒ rewrite once, then ship with a warning line.
3. Chat summary ≤ 8 lines: Decision, Status, Confidence, Door, Blast radius, residual dissent, `local://converge/<run-id>/report.md`, cost/time from the manifest (`cost_usd` is harvested from the children's session files at every ingest and at `finish()` — the only source of spend; `harvest_costs()` / `manifest.cost_missing` name any job whose file was not found, never an estimate).
4. Repo copy (`docs/decisions/<date>-<slug>.md`) only when the owner asks.
5. Cleanup: kill stragglers (`for m in cancel_requests(spawn_ids(r, phase)): write(**m)`), `finish()`, `cleanup()` (worktrees, `manifest.status = done`). Report `cost_usd` (children) and `jev_cost_usd` (your judge calls, from the parent session file) separately.

<critical>
Tailored tier ask first. Blind round 1 in L2/L3. Identity check every batch; mismatch ⇒ incomplete, never a fake two-model result. jev is a clerk; falsification before any "Converged"; escalate once before stopping. `load()` every round; render packets and the report from the ledger. Push, never poll.
</critical>
