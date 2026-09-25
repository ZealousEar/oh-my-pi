# converge — packets, L1 protocol, debater rules

`packet(side, r, phase, extra)` in `orchestrator.md` renders every packet from the ledger and writes it to `rounds/<r>/packet-<side>.md` (or `falsification/packet-<side>.md`) — exactly what the side received. This file is the contract those renderings satisfy. Packets NEVER carry: the other side's full reply, any transcript, model or vendor names, the sibling's agent id (L2/L3), Main's opinion.

Limits: packet ≤ 3 000 words + brief pointer; position ≤ 700 words; ≤ 30 tool calls, ≤ 10 `web_search`; per-spawn wall cap from the manifest (L1 20 min, L2/L3 15 min). **Budgeting** (`_fit`): the head, Task/Requested, Rules, and the `## Open cruxes (ids)` list (every id, stakes, u, and a ≤ 30-word statement summary; statements themselves are frozen at ≤ 80 words) are mandatory and never truncated — if they alone exceed the cap the cell raises `PacketOverflow` instead of shipping an over-budget packet; the variable sections (your last position, full crux statements, open-crux positions, novel claims/evidence, agreed synthesis, any `extra`) share the remaining budget by weight; a section over its share is capped in the packet and written whole to `packet-<side>-overflow.md`, which the packet names as permitted reading; the assembled packet is re-measured and never exceeds the cap. Delivery: the packet is the `task` item's `task` text; every item carries an explicit `outputSchema` (draft, L1 draft, L1 concurrence, falsification); the batch `context` is identical for both sides. The harness validates yields permissively; the cell's `validate_reply` checks the complete schema at ingestion and every attempt is persisted raw.

Spawn names are run/round/phase-specific (`Cv<tag>R<r><side>`, `…F<r>…` falsification, `…O<r>…` reopen, `…b2` retry) and never used as hub addresses: only the ids allocated by the `task` result are (`register_spawn`).

## Round 1 — blind (L2, L3)

```markdown
# converge <run-id> — tier L2 — round 1 — you are side A
Question: <question>
Brief (read first): `local://converge/<run-id>/brief.md`

## Task
Blind first draft. Nobody else's position is available; do not seek one.
Answer the question; name <= 3 cruxes you consider decisive (`NEW-1..3`) with your falsifier for each; cite evidence.

## Rules
<rules block>
```

## Round r ≥ 2 — delta packet (L2, L3; also the reopen round)

```markdown
# converge <run-id> — tier L2 — round r — you are side A
Question: <question>
Brief (read first): `local://converge/<run-id>/brief.md`

## Your last position
<this side's previous `position`, verbatim (capped to its share; whole text in the overflow file if capped)>

## Open cruxes (ids)                                   ← mandatory, never truncated (≤ 30-word summaries)
- C1 (stakes 3, u=0.73) — <statement summary>
- C4 (stakes 2, u=1.00) — <statement summary>

## Open cruxes — full statements                       ← variable; only statements longer than the summary
- C1: <frozen statement>

## Open cruxes — positions
### C1
- You: <positions[A].text>
- The other side: <positions[B].text>          ← anonymised; never the model
- Their falsifier: <falsifier[B]>
- Evidence ids: E-A-2, E-B-1

## New from the other side since round r−1
- On C1: <their `mine` for C1 last round, ≤120 words>
- E-B-3 [verified|UNVERIFIED] (<locator>): <claim>

## Requested
- Per open crux: restate the other side's strongest case (`steelman`), state yours (`mine`), name your falsifier.
- Concede only with `moved_by` (a VERIFIED evidence id or the other side's quoted argument) + reason.
- New cruxes: <= 3 as `NEW-1..3`, each with `stakes_claim`. [r ≥ 3:] After round 2 a new crux is admitted only if it would change the decision.
- Cite verified evidence ids; add new evidence only for open cruxes; continue your `E-<side>-n` numbering.

## Rules
<rules block>
```

Escalated rounds use the same packet; only the agent definition changes (`converge-*-esc`). The packet never mentions effort. A retry (attempt 2) uses the identical packet; in L1 Main appends `extra = l1_transcript(r, <valid side>)` (the surviving side's yield rendered as the transcript so far; a variable section, bounded like the rest).

## Falsification packet (both sides, current effort; `outputSchema` = 2.4.2)

```markdown
# converge <run-id> — tier L2 — round r — you are side B
…
## Task
The debate has stopped; the synthesis below is the best-so-far answer. Give the strongest reasons it is WRONG.
Each objection: statement, why_wrong, evidence ids (cite), severity fatal|material|minor. `verdict_stands`: your honest overall call. <= 6 objections, strongest first.

## Agreed synthesis
<checkpoints/synthesis-latest.md>

## Closed cruxes
- C2 [closed_agree] <statement>
- C5 [scoped_out] <statement>

## Rules
<rules block>
```

Reply schema 2.4.2: `{objections: [≤ 6 × {statement, why_wrong, evidence: [id], severity: "fatal"|"material"|"minor"}], evidence?: [2.4.1 evidence objects], verdict_stands: bool, confidence, blocked?}`. Each objection goes through the shared admission gate (per-side cap 3, jev M + duplicate, run cap 12, jev N); a material, verdict-changing objection is ALWAYS admitted as an open crux — it reopens once if a round remains, otherwise (and in L1) it stays open and unresolved (`falsification.unresolved`, disclosed; never plain Converged); everything else is residual with its `why_wrong` and evidence ids retained for the report's *Residual dissent* / *Failure modes* and for the converged dossier's Position B. Objections are strongest-first for a reason: the per-side cap keeps the first three, and a `fatal` objection the caps kept from jev still blocks plain Converged.

## L1 packet + hub protocol (one exchange)

Coin flip picks the opener (`manifest.opener`); the **non-opener drafts** (dilutes first-speaker anchoring). Each side gets its own `outputSchema`: responder = `SCHEMA_L1_DRAFT` (2.4.1 fields + required `concessions` and `objections` + `verdict_stands`), opener = `SCHEMA_L1_CONCURRENCE` (2.4.3).

```markdown
# converge <run-id> — tier L1 — round 1 — you are side A
…
## L1 protocol (one exchange, hub)
- Opener: you | the other side. Order: opener sends position (<= 500 words) + cruxes; responder sends position + cruxes + objections; opener sends rebuttal + concessions (`moved_by`); then both yield.
- [opener] You yield: concurrence per crux (`per_crux`: ref, agree|partial|disagree, why) and `objections` falsifying the responder's draft.
- [responder] You yield: the converged draft (`position` <= 700 words), `cruxes` with both positions, `concessions` with `moved_by`, `evidence`, and `objections` falsifying your own draft (`verdict_stands`).
- Wait for `PEER: <id>` from Main before any peer message; the peer id is NOT guessable.
## Rules
<rules block with: Hub: FIRST block with `hub wait from:Main` until Main sends `PEER: <id>`; only that id is your peer (<= 3 messages, fire-and-forget `hub send`, then `hub wait from:<id>`). `Main` for BLOCKED/NEEDS-APPROVAL only. Peer silent 15 min => yield `blocked`.>
```

```text
Main   task [Cv…R1A, Cv…R1B] → ids = register_spawn(1, "converge", {name: id}) → hub send each side `PEER: <other id>` (peer_messages)
opener     --hub--> responder : opening position (<=500 words) + cruxes
responder  --hub--> opener    : position + cruxes + objections
opener     --hub--> responder : rebuttal + concessions (moved_by)
responder  yields SCHEMA_L1_DRAFT (draft + objections)          ← converged draft
opener     yields SCHEMA_L1_CONCURRENCE {per_crux, objections, confidence}
Main   ingest_round(1, {A, B}) — both replies required; one invalid ⇒ retry that side once: spawn_round(1, sides=[X], attempt=2, extra=l1_transcript(1, <other>)) → ids = register_spawn(1, "converge", …) → identity_check(snap, expected_for(1, ids), ids) [expectations derive from the retried batch's ids] → for m in peer_messages(spawn_ids(1)): hub(**m) [the surviving peer is parked after its yield; the PEER send revives it] → ingest_round(1, replies, attempt=2); a second failure voids the exchange (non-progress) and the escalation ask follows
```

Rules: ≤ 3 hub messages per side, `hub send` fire-and-forget, then repeated `hub wait from:<id>` (never `await:true` for a long reply — it times out at 120 s); a `failed` receipt or 15 min of silence ⇒ yield with `blocked`. L1 has one round, no effort escalation, and no reopen round: objections are classified in place (`falsification.integrated = true`); a heavy ledger triggers the tier-escalation ask (L1→L2 via `escalate_tier` continues the same ledger without blind drafts; the report discloses contaminated identities).

## Debater rules block (rendered into every packet; the agent files restate it)

```markdown
## Rules
- Evidence MUST cite `path:L1-L2`, `URL#fragment`, or `exp:X<n>`; quote <= 600 chars verbatim. Uncited claims are assumptions.
- Position <= 700 words, answer-first. <= 30 tool calls, <= 10 web searches.
- Address EVERY open crux listed in this packet; a crux you omit is not agreement and stays open.
- Refer to the other participant only as 'the other side'. Never name or guess models.
- Yield structured output only (the schema given to you). Incomplete => set `blocked`.
- Hub: `Main` only, and only for `BLOCKED:` / `NEEDS-APPROVAL:` one-liners. NEVER `hub list`, NEVER contact any other agent.   [L1: PEER line instead]
- Budget: <spawn_cap_min> min wall for this spawn; Main cancels over-cap spawns.
```

Hub discipline (all tiers, per `rule://orchestration-notify`): `BLOCKED:` and `NEEDS-APPROVAL:` are pushed to `Main` immediately as one-liners; DONE is the yield (auto-delivered) — no separate message; `MILESTONE:` only when the spawn's budget exceeds 10 min. A `NEEDS-APPROVAL:` that needs the owner is routed by Main through `ask` and answered on the same channel; the child blocks on `hub wait from:Main`, never spins. Experiment requests do not block: `experiment_request` rides in the reply and Main asks before the next round.

## Reply schema 2.4.1 (agent-file default `output`; the caller's `outputSchema` always overrides)

Required: `position` (answer-first markdown ≤ 700 words, no model names), `cruxes` (≤ 15 = every open crux + ≤ 3 `NEW-<k>`: `ref`, `statement`, `mine` ≤ 120 words, `steelman` ≤ 80 words (rounds ≥ 2), `falsifier`, `stakes_claim` 2|3, `evidence` ids), `evidence` (≤ 12: `id` `^E-(A|B)-[0-9]+$`, `claim`, `locator`, `quote` ≤ 600, `crux`), `confidence` 0–1. Optional: `concessions` (`crux`, `moved_by`, `reason` ≤ 400), `scoped_out` (`crux`, `why`), `experiment_request`, `blocked`. Full JSON Schema: `P/agents/converge-openai.md` frontmatter; the cell's `SCHEMA_DRAFT` is the same contract and is passed explicitly on every spawn.
