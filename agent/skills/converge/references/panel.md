# converge — L3 panel (design §1.12)

Judges: `converge-judge-kimi` (J1) and `converge-judge-glm` (J2); models/efforts come from the configured roles frozen in `manifest.expected.judges` (Kimi K3 max via OpenRouter, vendor endpoint `moonshotai/mxfp4`; GLM-5.3 max, `z-ai/fp8`; routing pinned in `P/models.yml` with `allow_fallbacks: false`). Judges are full agents (`read grep write` — `write` for `agent://` messaging only), never jev. Six spawns per panel: 4 verdict + 2 conference. Identity check applies to every batch: `ids = register_spawn(0, stage, …)` → `identity_check(snap, expected_judges(stage, ids), ids)` with `snap = await tool.read(path="proc://")`; a mismatched judge is killed (`cancel_requests`) and retried once, then `unavailable`.

```text
L2 loop (≤5 rounds) → falsification (+ reopen round 6) → dossier() → l3/dossier.md (A first) + l3/dossier-BA.md (B first, labels swapped)
verdict spawns (parallel, 4): J1-AB, J1-BA, J2-AB, J2-BA      ← AB reads dossier.md, BA reads dossier-BA.md (genuinely counterbalanced)
  panel_verdicts: validate each verdict against the FULL 2.5.1 schema (validate_verdict; cite for every score < 5) BEFORE mapping; map BA back to canonical labels;
  per judge: complete iff both orderings valid; consistent iff same winner (or both ∈ {tie, insufficient}); else "inconsistent"
conference spawns (parallel, 2): J1, J2 ← all four verdicts (canonical labels); peer released by Main's `PEER: <agent id>` write to agent://<judge>
  ≤ 3 `agent://` messages each as wake turns (interim yields tagged `turn`, ignored by Main) → each yields 2.5.2 with `turn: "final"`
panel_aggregate(mapped, conferences, accept_changes) → l3/panel.json
```

## Dossier template (`dossier()` renders both files; Main reviews before spawning)

```markdown
# Dossier — converge <run-id> (unconverged | converged)
## Question
<question>            Constraints: {must, prefer, out_of_scope}
## Agreed facts and closed cruxes
- C2 [closed_agree] <statement>   - C5 [scoped_out] <statement>   (+ brief facts by E-0-n id)
## Open cruxes
- C1 (stakes 3) <statement>
## Position A
### C1 — <statement>            ← unconverged: one block per open crux, per side
**Claim:** <positions[A].text>  **Falsifier:** <falsifier[A]>  **Evidence:** E-A-2, E-0-1
## Position B
### C1 — <statement>
**Claim:** …  **Falsifier:** …  **Evidence:** …
## Evidence index
- E-A-2 [verified] <locator> — <claim>    - E-B-1 [UNVERIFIED] …
Judges: score the 7 criteria first, cite every deduction, then pick a winner; `insufficient` is allowed.
```

Converged run: Position A = the synthesis rendered as numbered `### n. <headline>` blocks (`**Claim:**` paragraph, `**Evidence:**` verified ids); Position B = the strongest rejected alternative assembled from the falsification objections in the same block shape — `**Claim:**` = the objection's `why_wrong`, `**Falsifier:**` = its severity, `**Evidence:**` = its cited ids — fatal/material first, ≤ 6 blocks. Both positions pass through the same anonymiser and the same 700-word cap. One contract for both cases (audit value on converged runs). A/B ↔ sides stays the manifest's coin flip; never disclosed to judges.

`dossier-BA.md` is the same document with the two position blocks swapped under the headings, so the BA reader physically meets canonical B first under the label "Position A". Verdict rows from BA spawns are mapped back (`winner`, per-criterion A/B, fatal-flaw sides) before any comparison.

## Anonymisation checklist (Main, before spawning)

- Same block shape, same labels for A and B; each position ≤ 700 words (`_anon` caps and strips).
- Strip model names, vendor strings, effort words, and self-references (`IDENTITY_STRIP` regex: gpt/astra/openai/codex/claude/fable/opus/sonnet/anthropic/kimi/moonshot/glm/z.ai/zhipu/gemini/"as an AI"); read both dossier files once yourself for anything the regex missed (a first-person aside, a tool name only one vendor has).
- No round numbers, no "conceded in round 3", no message excerpts. Evidence entries carry `verified`/`UNVERIFIED` so judges can discount, not who found them.
- Do not order positions by strength.

## Judge prompt (verdict spawn; `spawn_panel("verdict")`)

```text
Mode: verdict. Dossier: `local://converge/<run-id>/l3/dossier.md | dossier-BA.md` (read it whole; the labels A/B in that file are your labels).
Score all 7 criteria 1–5 per side with a `cite` for every score < 5, then winner/margin/decisive_evidence/fatal_flaws/confidence. Cap 25 min.
Hub: `Main` only, `BLOCKED:` only.
```

Criteria (schema 2.5.1, agent-file default): `correctness, constraints, coherence, operational_risk, migration_rollback, evidence_use, uncertainty` — each `{A: 1–5, B: 1–5, note, cite}`; `winner: A|B|tie|insufficient`; `margin` 0–1; `decisive_evidence: [ids]`; `fatal_flaws: [{side, statement, cite}]`; `confidence`. Standing instructions in the agent files: dossier only; criteria before winner; verbosity is not evidence; identity cues are noise; `insufficient` beats a fabricated margin; may re-verify a decisive locator with `read`/`grep` (≤ 10 calls).

`panel_verdicts(raw)` records invalid or missing verdicts (`invalid[key] = reason`) instead of guessing — `validate_verdict` checks the whole 2.5.1 schema (required fields, types, ranges, enums, `fatal_flaws` items, `additionalProperties`) and the cite rule before any field is mapped, so a malformed yield can never crash BA mapping. A judge with a missing/invalid ordering is **incomplete**; a complete judge whose orderings disagree is **inconsistent**: its independent ruling is excluded (disclosed) but it still confers, and its validated conference final counts (§1.12; below). Retry a failed verdict spawn once: `spawn_panel("verdict", who=["J2-BA"], attempt=2)` → `ids = register_spawn(0, "verdict", …)` → `identity_check(snap, expected_judges("verdict", ids), ids)`; still failing ⇒ the judge is unavailable.

## Conference protocol (`spawn_panel("conference", mapped["verdicts"])`, `outputSchema` = 2.5.2)

```text
Mode: conference. You are J1. Dossier: `local://…/l3/dossier.md` (canonical labels).
All four independent verdicts (canonical labels; BA rows were mapped back): ```json …```
Until Main's `PEER: <id>` message arrives, re-read the dossier; that id is the other judge (never guess it). Exchange <= 3 messages with it via `write` path `agent://<id>` (never blocks; `wait` is not available to you): …. When you need the peer's next message and have nothing left to do, yield the conference schema with `turn: "opening"` (first message sent) or `turn: "response"`; the peer's message wakes you — continue. Change your winner only for a cited reason.
`exchange_completed` = true ONLY if you received at least one message from the peer; woken with no peer message 15 min after your last send => false, with `residual_disagreement` saying so.
Your last yield sets `turn: "final"` — only that one counts. Cap 25 min. `agent://Main` only for `BLOCKED:`.
```

- Main sends the two `PEER:` messages (`peer_messages(spawn_ids(0, "conference"))`) right after `register_spawn(0, "conference", …)`; conference ids are never guessed.
- Independent verdicts are frozen before the conference. A conference yield counts only if it validates (`validate_conference`, 2.5.2 + `exchange_completed`) AND `exchange_completed = true`; a missing yield (peer silent 15 min, `failed` receipt), an invalid one, or `exchange_completed = false` leaves that judge's independent verdict as its final and records `missing_conference` / `invalid_conference` / `incomplete_conference` — each is a mandatory `final_status` disclosure even when the judges independently agree.
- Schema 2.5.2: `{final_winner: A|B|tie|insufficient, changed_from_independent: bool, why, residual_disagreement: string|null, agreed_fatal_flaws: [{side, statement, cite}], exchange_completed: bool}` (`exchange_completed` = at least one peer message received). A non-null `residual_disagreement` is disclosed even with a joint winner.
- **Change validation (Main, before aggregating):** a `final_winner` that differs from the judge's independent winner counts ONLY if `changed_from_independent = true` AND you read its `why` and it cites a dossier section or evidence id that plausibly bears on the decisive criterion — then pass `accept_changes={"J2": True}`. A `why` that cites the peer's confidence, tone, or seniority is panel-level sycophancy (F25): do not accept; the independent verdict stands and `unsupported_change` records it for the appendix. For an **inconsistent** judge there is no independent winner to compare with: its conference final counts ONLY with `accept_changes[j] = True` after the same reading of its `why` (the cited resolution of its own inconsistency).

## Aggregation (`panel_aggregate(mapped, conferences, accept_changes)` → `l3/panel.json`)

```json
{"judges": {"J1": {"model": "openrouter/moonshotai/kimi-k3", "AB": {…}, "BA": {…}, "complete": true, "consistent": true, "independent": "A", "final": "A", "conference": {…}, "conference_ok": true},
            "J2": {"model": "openrouter/z-ai/glm-5.3", "AB": {…}, "BA": {…}, "complete": true, "consistent": false, "independent": "inconsistent", "final": "A", "conference": {…}, "conference_ok": true}},
 "conference": {"J1": {…2.5.2…}, "J2": {…}},
 "joint": {"winner": "A"|null, "agreed": "A"|null, "outcome": "judge_selected|tie|insufficient|split|unavailable",
           "reasons": {"J1": "…", "J2": "…"},
           "notes": {"unavailable": [], "inconsistent": ["J2"], "unsupported_change": [], "missing_conference": [], "incomplete_conference": [],
                     "invalid_conference": {}, "residual_disagreement": {}, "conference_final_used": ["J2"]}},
 "split": null | {"J1_reason": "…", "J2_reason": "…", "finals": {"J1": "A", "J2": "B"}},
 "outcome": "…"}
```

- A judge's `final`: complete + consistent ⇒ its independent winner, replaced only by an accepted conference change; complete + inconsistent ⇒ its validated, accepted conference final (else none); incomplete ⇒ none (`unavailable`).
- `joint.winner` ∈ {A, B} iff both finals exist and are the same side → outcome `judge_selected`. Both finals ∈ {tie, insufficient} → outcome `tie`/`insufficient`, `winner = null` (nothing selected). Finals differ → `split` with both reasons. Fewer than two finals → `unavailable` (a panel of one is not a panel; never substitute a model).
- Outcome → report (`final_status()`): debate `unresolved` + `joint.winner` ⇒ Status **Judge-selected**; any other outcome keeps the debate's Status and adds a disclosure line ("panel did not select: tie", "panel split; both reasons reported", "panel unavailable: …"). Every non-empty `notes` entry is a disclosure regardless of outcome ("judge J2 order-inconsistent: independent ruling excluded; validated conference final used", "conference incomplete for J2: peer exchange did not complete", …). A panel `fatal_flaw` agreed by both judges against a converged answer is a candidate crux → reopen rule (shares the single reopen allowance and the round budget; not available ⇒ report as dissent).
- Appendix (≤ 600 words, L3 only): criterion-by-criterion ruling per judge, decisive evidence ids, unsupported changes and inconsistencies, the minority argument worth preserving, and — after the verdict — the A/B ↔ model disclosure from the manifest.
