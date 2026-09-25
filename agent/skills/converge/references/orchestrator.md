# converge — orchestrator cell

One Python cell for Main's eval kernel (state persists across calls; re-run only after a kernel reset). The cell never calls `task`, `ask`, `hub send`, or `hub cancel` — it builds batches, messages, and bookkeeping; Main submits and decides. Disk under `local://converge/<run-id>/` is the only truth: public helpers reload before reading and save after mutating; each round's ingestion is transactional (`rounds/<r>/state-before.json` snapshots the ledger and the ingestion-owned manifest keys; a re-run restores exactly those, never runtime provenance). Models and efforts are read from the configured `modelRoles` at `new_run` and frozen into `manifest.expected`; nothing in the cell names a model.

## Call sequence

```text
Preflight    exec the cell → new_run(question, tier, experiments, sides?, constraints, slug) → jev_probe()
Frame        write_brief(brief_md, evidence=[{claim, locator, quote, crux?}, …])   # E-0-n, frozen
Tier ask     record_ask("tier", answer); record_ask("experiments", answer); enable_experiments(repo_cwd) if on
Round r      load() → batch = spawn_round(r, tools=["run_experiment"] if experiments) → result = task(**batch)
             ids = register_spawn(r, "converge", {requested name: job id from result})          # THIS batch: {"A": …, "B": …}
             L1 only: for m in peer_messages(spawn_ids(r)): hub(**m)                            # releases peer contact (merged ids)
             ≤60 s: snap = await tool.hub(op="jobs", i="identity check") → chk = identity_check(snap, expected_for(r, ids), ids)
             chk["retry"] (rows still pending) → hub wait …, re-snapshot on the wake, identity_check again; NEVER time.sleep in eval
             hub wait … → replies = {"A": <yield>, "B": <yield>} → res = ingest_round(r, replies)
             res["action"] == "retry" → spawn_round(r, sides=res["retry"], attempt=2[, extra=l1_transcript(r, <valid side>)])
                 → ids = register_spawn(…)  → identity_check(snap, expected_for(r, ids), ids)   # expectations derive from THIS batch's ids
                 → L1: for m in peer_messages(spawn_ids(r)): hub(**m)  → ingest_round(r, replies, attempt=2)
             spawn_meta(r, side, job=…, wall_ms=…, tool_calls=…, retries=…)                   # never cost/tokens: harvested from the session file
             checkpoint(r, synthesis_md) → act on res["action"]: continue | escalate (next spawn_round uses -esc agents) | stop | incomplete_transport
Falsify      batch = spawn_round(r, phase="falsification") → task → f = ingest_falsification(replies)   ("retry" → attempt=2)
             f["action"] == "reopen" → spawn_round(r+1, phase="reopen") + ingest_round(r+1, …, phase="reopen") + checkpoint, then final
             f["unresolved"] (admitted objections, no round left) stay OPEN cruxes: the report can never say plain Converged
             wall cap with < 10 min left → skip_falsification("wall cap") instead (disclosed; never plain Converged)
Escalation   e = escalation_needed() → ask (recommended = accept; e["advise"] == "escalate" ⇔ e["needed"] goes in the description)
             → escalate_tier(e["next_tier"], approved=<owner said escalate>, timed_out=<ask timed out>)
L3           dossier() → task(**spawn_panel("verdict")) → ids = register_spawn(0, "verdict", …) → identity_check(snap, expected_judges("verdict", ids), ids)
             one failed judge spawn → spawn_panel("verdict", who=["J2-BA"], attempt=2) → ids = register_spawn(0, "verdict", …) → identity_check(snap, expected_judges("verdict", ids), ids)
             mapped = panel_verdicts({"J1-AB": …, "J1-BA": …, "J2-AB": …, "J2-BA": …})   # full 2.5.1 validation; invalid/missing recorded, never guessed
             task(**spawn_panel("conference", mapped["verdicts"])) → ids → for m in peer_messages(spawn_ids(0, "conference")): hub(**m)
             panel_aggregate(mapped, {"J1": …, "J2": …}, accept_changes={"J2": True})   # only after YOU validated the cited reason
Report       fs = final_status() → report_gate(report_md) ≥ 0.70 → write report → finish() (harvests every spawn's cost) → cleanup()
jev outage   any helper raises JevUnavailable(digest, state, questions) → answer the same ids yourself
             → jev_answer(digest, answers) → re-run the SAME helper with the same arguments (ingestion restores its snapshot)
```

`ingest_round` = validate each reply against the COMPLETE phase schema (`validate_reply` → `_schema_errors`: nested required fields, types, enums, caps, `additionalProperties`; blocked/invalid ⇒ `retry` on attempt 1, failure count + forced non-progress on attempt 2, two failures of one side ⇒ `incomplete_transport`) → `save_replies` (every attempt persisted) → `admit_cruxes` (`_admit_candidate`: statement frozen at ≤ 80 words, per-side cap, jev M + duplicate, run cap, jev N for r ≥ 3) → `verify_evidence` (orchestrator fetches every locator; deterministic whitespace-normalised quote-presence check first — `quote_present`, diagnostics — then jev E; `verified` = the quote is at the locator AND `quote_supports_claim ≥ 0.70`, the one meaning every consumer reads: packets, dossier, report card, n_r, `moved_by`) → `converge_state` (prior positions from the pre-round snapshot; jev C per crux both sides addressed: `state` + `both_withdraw`; `moved_by` evidence ids must resolve to verified entries whose support for THAT crux is established — `_evidence_basis(L, eid, cid, r)` re-asks jev E `supports_crux` for reused/brief evidence; scoped_out needs both sides; sycophancy/invalid basis floor u at 0.5; standing flags refreshed) → `close_round` (Φ_r, progress, streak, escalation, round reserve for the reopen, `rounds/<r>/record.json`, `harvest_costs`). L1 runs the same path once: the responder yields the draft + objections (`SCHEMA_L1_DRAFT`), the opener yields per-crux concurrence (`SCHEMA_L1_CONCURRENCE`); objections go through the same admission gate and admitted ones stay open, unresolved cruxes (no reopen round exists).

Transactional replay: `rounds/<r>/state-before.json` snapshots the ledger and the ingestion-owned manifest keys (`INGEST_MANIFEST_KEYS`: failures, falsification, reopened, escalated_at) — runtime provenance (`jev_backend`, `spawns`, `cost_by_job`, asks, tier) never rolls back, and a cached orchestrator answer re-asserts `jev_backend = "orchestrator"`.

`identity_check(snap, expected, ids)` takes the batch `register_spawn` just returned and an expectation built FROM that batch — `expected_for(r, ids)` for debaters, `expected_judges(stage, ids)` for judges — and raises unless the two name exactly the same roles (a spawned id with no expectation can never pass silently; R12). Names repeat across rounds and retries get suffixes, so label matching is not allowed. It reads `details.jobs[*].resolvedModelIdentity` / `resolvedThinkingLevel` from the `hub jobs` snapshot returned to the kernel (`await tool.hub(...)` returns `{text, details}`). A running row without identity fields is `pending` (the child has not streamed yet, typically the first 20–25 s): the result is `{ok: False, retry: True, pending: [...]}` — re-check after the next `hub wait` wake; a 30 s eval timeout makes `time.sleep` inside eval a failure. `spawn_ids(r, phase)` returns the merged mapping across retries (peer release, `hub cancel`); it is never the identity-check input.

Cost: each child's session file lives beside the parent's (`<session>/<job id>.jsonl`); `harvest_costs` sums its assistant-message `usage.cost.total` into `manifest.cost_by_job` / `cost_usd` (per-round `record.json` gets `spawn[side].cost_usd` and tokens) and is the ONLY source of spend — `spawn_meta` refuses `cost_usd`/`tokens`. It runs at every `close_round`, `ingest_falsification`, `panel_aggregate`, and `finish`; a job whose file is absent is reported in `missing` and `manifest.cost_missing`, never estimated.

Packets: `_fit` budgets every variable section's minimal rendering (heading + continuation note + ellipsis) before allocating content; mandatory + that overhead > 3 000 words ⇒ `PacketOverflow` (no legal fit: shorten the question/constraints/extra); the assembled packet is re-measured before it is written.

Thresholds and question sets are the constants at the top of the cell (`TH`, `Q_*`); `references/ledger.md` documents them.

## The cell

```python
# converge orchestrator cell — paste into Main's Python eval kernel once per session.
# State persists across calls. Disk (local://converge/<run-id>/) is the only truth:
# public helpers reload before reading and save after mutating; ingestion is
# transactional per round (rounds/<r>/state-before.json). Main submits `task`
# batches, sends hub messages, and calls `ask` itself; this cell only builds them.
import datetime as _dt
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

ROOT = "local://converge"

# ---- fixed parameters (design §1.7, §1.9, §1.10) ---------------------------------
TH = dict(material=0.60, stakes3=0.50, close_u=0.15, syco=0.60, quote=0.70, crux=0.60, withdraw=0.60,
          verdict_changing=0.60, duplicate=0.60, eps_floor=0.25, eps_frac=0.10, new_per_side=3, max_material=12,
          brief_leans=0.60, report_gate=0.70, experiment_screen=0.50, max_script_chars=12000,
          statement_words=80, min_quote_chars=12)
BUDGETS = {"L1": dict(max_rounds=1, wall_min=25, spawn_cap_min=20),
           "L2": dict(max_rounds=6, wall_min=75, spawn_cap_min=15),
           "L3": dict(max_rounds=6, wall_min=150, spawn_cap_min=15, judge_cap_min=25)}
PER_SPAWN = dict(tool_calls=30, web_search=10, position_words=700, packet_words=3000)
IDS_SUMMARY_WORDS = 30      # crux statement summary in the mandatory ids block; full statements are a variable section (N3)
# Manifest keys owned by ingestion: the only manifest state a transactional restore rolls back (N2). Everything else
# (jev_backend, spawns, cost_by_job, ask, tier, budgets, …) is runtime provenance and survives a replay.
INGEST_MANIFEST_KEYS = ("failures", "falsification", "reopened", "escalated_at")
# Agent definitions and role names are fixed; models/efforts come from the configured roles at new_run (R15).
FAMILY = {"openai": dict(agent="converge-openai", esc_agent="converge-openai-esc", role="converge-openai", esc_role="converge-openai-esc"),
          "anthropic": dict(agent="converge-anthropic", esc_agent="converge-anthropic-esc", role="converge-anthropic", esc_role="converge-anthropic-esc")}
JUDGE_DEFS = {"J1": dict(agent="converge-judge-kimi", role="converge-judge-kimi"),
              "J2": dict(agent="converge-judge-glm", role="converge-judge-glm")}
OPEN = ("open", "contested_closure")
CLOSED_WITHDRAWN = "closed_withdrawn"   # both sides withdrew the crux (jev C both_withdraw); excluded from Φ and escalation (D1)
SIDES = ("A", "B")
EVID_RE = re.compile(r"^E-(A|B|0)-[0-9]+$")
IDENTITY_STRIP = re.compile(r"\b(gpt[-\w.]*|astra|o\d|openai|codex|claude[-\w.]*|fable|opus|sonnet|anthropic|"
                            r"kimi[-\w.]*|moonshot\w*|glm[-\w.]*|z\.?ai|zhipu|gemini|as an ai( model)?)\b", re.I)
STATUS_LABEL = {"converged": "Converged", "converged_unfalsified": "Converged with dissent",
                "converged_with_dissent": "Converged with dissent", "unresolved": "No convergence",
                "incomplete_transport": "incomplete (no report)"}

SCHEMA_EVIDENCE = {"type": "array", "maxItems": 12, "items": {"type": "object",
    "required": ["id", "claim", "locator", "quote"], "properties": {
        "id": {"type": "string", "pattern": "^E-(A|B)-[0-9]+$"}, "claim": {"type": "string"},
        "locator": {"type": "string"}, "quote": {"type": "string", "maxLength": 600}, "crux": {"type": "string"}}}}
SCHEMA_CRUXES = {"type": "array", "maxItems": 15, "items": {"type": "object",
    "required": ["ref", "statement", "mine", "falsifier"], "properties": {
        "ref": {"type": "string"}, "statement": {"type": "string"}, "mine": {"type": "string"}, "steelman": {"type": "string"},
        "falsifier": {"type": "string"}, "stakes_claim": {"type": "integer", "enum": [2, 3]},
        "evidence": {"type": "array", "items": {"type": "string"}}}}}
SCHEMA_CONCESSIONS = {"type": "array", "items": {"type": "object", "required": ["crux", "moved_by", "reason"],
    "properties": {"crux": {"type": "string"}, "moved_by": {"type": "string"}, "reason": {"type": "string", "maxLength": 400}}}}
SCHEMA_SCOPED = {"type": "array", "items": {"type": "object", "required": ["crux", "why"],
    "properties": {"crux": {"type": "string"}, "why": {"type": "string"}}}}
SCHEMA_OBJECTIONS = {"type": "array", "maxItems": 6, "items": {"type": "object",
    "required": ["statement", "why_wrong", "evidence", "severity"], "properties": {
        "statement": {"type": "string"}, "why_wrong": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "severity": {"type": "string", "enum": ["fatal", "material", "minor"]}}}}
_CONF = {"type": "number", "minimum": 0, "maximum": 1}
SCHEMA_DRAFT = {"type": "object", "required": ["position", "cruxes", "evidence", "confidence"], "additionalProperties": False,
    "properties": {"position": {"type": "string"}, "cruxes": SCHEMA_CRUXES, "evidence": SCHEMA_EVIDENCE,
                   "concessions": SCHEMA_CONCESSIONS, "scoped_out": SCHEMA_SCOPED, "experiment_request": {"type": "string"},
                   "confidence": _CONF, "blocked": {"type": "string"}}}
SCHEMA_FALSIFICATION = {"type": "object", "required": ["objections", "verdict_stands", "confidence"], "additionalProperties": False,
    "properties": {"objections": SCHEMA_OBJECTIONS, "evidence": SCHEMA_EVIDENCE, "verdict_stands": {"type": "boolean"},
                   "confidence": _CONF, "blocked": {"type": "string"}}}
# L1 responder: the converged draft PLUS objections falsifying its own draft (R6).
SCHEMA_L1_DRAFT = {"type": "object", "required": ["position", "cruxes", "evidence", "concessions", "objections", "confidence"],
    "additionalProperties": False,
    "properties": {"position": {"type": "string"}, "cruxes": SCHEMA_CRUXES, "evidence": SCHEMA_EVIDENCE,
                   "concessions": SCHEMA_CONCESSIONS, "scoped_out": SCHEMA_SCOPED, "objections": SCHEMA_OBJECTIONS,
                   "verdict_stands": {"type": "boolean"}, "experiment_request": {"type": "string"}, "confidence": _CONF,
                   "blocked": {"type": "string"}}}
SCHEMA_L1_CONCURRENCE = {"type": "object", "required": ["per_crux", "objections", "confidence"], "additionalProperties": False,
    "properties": {"per_crux": {"type": "array", "items": {"type": "object", "required": ["ref", "state", "why"],
                       "properties": {"ref": {"type": "string"}, "state": {"type": "string", "enum": ["agree", "partial", "disagree"]},
                                      "why": {"type": "string"}}}},
                   "objections": SCHEMA_OBJECTIONS, "evidence": SCHEMA_EVIDENCE, "confidence": _CONF, "blocked": {"type": "string"}}}
_FLAW = {"type": "object", "required": ["side", "statement", "cite"],
         "properties": {"side": {"type": "string", "enum": ["A", "B"]}, "statement": {"type": "string"}, "cite": {"type": "string"}}}
# 2.5.2 + `exchange_completed` (N5): true only when at least one peer message was received; a silent peer yields false.
SCHEMA_CONFERENCE = {"type": "object", "additionalProperties": False,
    "required": ["final_winner", "changed_from_independent", "why", "residual_disagreement", "agreed_fatal_flaws", "exchange_completed"],
    "properties": {"final_winner": {"type": "string", "enum": ["A", "B", "tie", "insufficient"]},
                   "changed_from_independent": {"type": "boolean"}, "why": {"type": "string"},
                   "residual_disagreement": {"type": ["string", "null"]},
                   "agreed_fatal_flaws": {"type": "array", "items": _FLAW},
                   "exchange_completed": {"type": "boolean"}}}
SCHEMA_BY_KIND = {"draft": SCHEMA_DRAFT, "falsification": SCHEMA_FALSIFICATION, "l1_draft": SCHEMA_L1_DRAFT, "l1_concurrence": SCHEMA_L1_CONCURRENCE}
JUDGE_CRITERIA = ("correctness", "constraints", "coherence", "operational_risk", "migration_rollback", "evidence_use", "uncertainty")
_CRITERION = {"type": "object", "required": ["A", "B", "note"], "properties": {
    "A": {"type": "integer", "minimum": 1, "maximum": 5}, "B": {"type": "integer", "minimum": 1, "maximum": 5},
    "note": {"type": "string"}, "cite": {"type": "string"}}}
# 2.5.1 — mirrors the judge agent files' `output` frontmatter (N6); the cite-for-every-deduction rule is checked on top.
SCHEMA_VERDICT = {"type": "object", "additionalProperties": False,
    "required": ["criteria", "winner", "margin", "decisive_evidence", "fatal_flaws", "confidence"],
    "properties": {"criteria": {"type": "object", "required": list(JUDGE_CRITERIA), "additionalProperties": False,
                                "properties": {k: _CRITERION for k in JUDGE_CRITERIA}},
                   "winner": {"type": "string", "enum": ["A", "B", "tie", "insufficient"]},
                   "margin": {"type": "number", "minimum": 0, "maximum": 1},
                   "decisive_evidence": {"type": "array", "items": {"type": "string"}},
                   "fatal_flaws": {"type": "array", "items": _FLAW}, "confidence": _CONF}}

# ---- jev question sets (design §2.7, verbatim) ------------------------------------
Q_M = {"materiality": {"type": "choice",
    "instructions": "Classify what resolving this crux changes for the decision described in state.question.",
    "criteria": {"verdict": "resolving it flips or blocks the decision, or changes the door (reversibility) or blast radius",
                 "implementation": "changes cost, risk, rollout, or design details but not which option wins",
                 "wording": "the sides differ only in terminology, emphasis, or presentation"}}}
Q_C_STATE = {"type": "choice", "instructions": "After this round, what is the state of agreement on this crux?",
    "criteria": {"agree": "both sides assert the same resolution and any conceding side names what changed its mind",
                 "partial": "agreement on part of it, or conditional on something not yet established",
                 "disagree": "the positions still conflict"}}
Q_C_SYCO = {"type": "bool",
    "instructions": "Consider the conceding side's stated reason. Is the concession unsupported: it cites no specific new evidence id or specific argument absent from its own prior position, or it defers to the other side's confidence or authority?",
    "criteria": {"true": "no new evidence/argument named, or deference",
                 "false": "names a specific evidence id or argument that was absent from the conceder's prior position"}}
Q_C_WITHDRAW = {"type": "bool",
    "instructions": "Do BOTH sides' positions this round withdraw this crux: each states it is not established or not decidable here AND that its own answer no longer depends on it?",
    "criteria": {"true": "both sides withdraw it and neither answer depends on it",
                 "false": "at least one side still asserts a resolution, relies on it, or is silent about it"}}
Q_E = {"quote_supports_claim": {"type": "bool",
           "instructions": "Does the text at the locator (state.quote when quote_present_verbatim is true, else state.context_as_fetched_by_orchestrator) support the claim as stated (not a weaker or different claim)?",
           "criteria": {"true": "the text establishes the claim",
                        "false": "the text is absent, irrelevant, or supports only a weaker/different claim"}},
       "supports_crux": {"type": "bool",
           "instructions": "Would a careful engineer's belief about the crux change on reading this evidence?",
           "criteria": {"true": "bears on the crux", "false": "tangential or already implied by existing evidence"}}}
Q_E_CRUX = {"supports_crux": Q_E["supports_crux"]}   # re-evaluation of an existing entry against a different crux (R4)
Q_N = {"verdict_changing": {"type": "bool",
    "instructions": "If this crux were resolved against the current synthesis, would the decision (option, door, or blast radius) change?",
    "criteria": {"true": "the decision would change", "false": "only details, confidence, or wording would change"}}}
Q_X = {"mutates_network": {"type": "bool", "instructions": "Does this script push, publish, post, or write to a remote/network resource?"},
       "touches_outside_sandbox": {"type": "bool", "instructions": "Does this script write or delete outside the given cwd or /tmp?"}}
Q_T = {"door": {"type": "choice", "instructions": "How reversible is the decision in state.question?",
           "criteria": {"one_way": "hard to reverse: migrations, published APIs, data formats", "two_way": "revert and done"}},
       "evidence_kind": {"type": "choice", "instructions": "What kind of evidence settles state.question?",
           "criteria": {"empirical": "settled by measurement or experiment", "judgment": "trade-off weighing",
                        "lookup": "settled by reading code/docs"}},
       "blast": {"type": "score", "instructions": "How wide is the impact if the decision is wrong?",
           "criteria": ["local", "subsystem", "product_wide"]}}
Q_T_BRIEF = {"brief_leans": {"type": "bool", "instructions": "Does the brief favour, rank, or hint at one option?"}}
Q_R = {"report_matches_ledger": {"type": "bool",
    "instructions": "Does the report's Status/Decision/Residual dissent match the ledger's final state and the panel ruling, without new claims? state.ledger carries every crux (statement, initial and final positions, concessions with moved_by, withdrawn cruxes), the verified evidence (id, claim, locator) and the falsification objections (statement, why_wrong, severity); a claim in the report absent from these is a new claim."}}

# ---- storage --------------------------------------------------------------------
RUN = None          # {"manifest": {...}, "ledger": {...}}; reload with load()
_JEV_CACHE = {}     # digest -> answers (orchestrator-supplied after JevUnavailable)
_JEV_MODE = "typesafe"
_EXP_LOCK = threading.Lock()
_MANIFEST_DISK = None   # disk path of the last manifest write; the session directory (child session files) derives from it (D3)


class JevUnavailable(Exception):
    """jev failed closed. Answer the card yourself (same ids, calibrated probabilities), call
    jev_answer(digest, answers), then re-run the helper that raised (ingestion is idempotent per round)."""
    def __init__(self, digest, state, questions, error):
        super().__init__(f"jev unavailable ({error}); answer card {digest} via jev_answer(digest, answers)")
        self.digest, self.state, self.questions, self.error = digest, state, questions, error


def _now():
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")

def _p(rel, run=None):
    return f"{ROOT}/{(run or RUN)['manifest']['run_id']}/{rel}"

def _rj(path, default=None):
    try:
        return json.loads(read(path))
    except FileNotFoundError:
        return default

def _wj(path, obj):
    return write(path, json.dumps(obj, indent=1, ensure_ascii=False))

def _read_or(path, default):
    try:
        return read(path)
    except FileNotFoundError:
        return default

def _words(text):
    return len(re.findall(r"\S+", text or ""))

def _cap_words(text, n):
    parts = re.findall(r"\S+\s*", text or "")
    return text if len(parts) <= n else "".join(parts[:n]).rstrip() + " …"

def _digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:12]

def _text(x):
    return x.decode("utf-8", "replace") if isinstance(x, (bytes, bytearray)) else (x or "")

def _other(side):
    return "B" if side == "A" else "A"

def _norm(text):
    """Whitespace/quote-normalised text for the deterministic quote-presence check (D4)."""
    t = (text or "").translate({0x201C: '"', 0x201D: '"', 0x2018: "'", 0x2019: "'", 0xA0: " "})
    return re.sub(r"\s+", " ", t).strip()

# ---- JSON-schema subset validator (R2/N6): type, enum, required, properties, additionalProperties, items, caps -------
_TYPES = {"string": str, "boolean": bool, "object": dict, "array": list, "null": type(None)}

def _type_ok(v, t):
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "integer":
        return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
    return isinstance(v, _TYPES[t])

def _schema_errors(v, schema, path="$"):
    """First violation as '<path>: <reason>', else None. Covers the keywords the converge schemas use."""
    t = schema.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_type_ok(v, x) for x in ts):
            return f"{path}: expected {'|'.join(ts)}"
    if "enum" in schema and v not in schema["enum"]:
        return f"{path}: not one of {schema['enum']}"
    if isinstance(v, str):
        if "maxLength" in schema and len(v) > schema["maxLength"]:
            return f"{path}: longer than {schema['maxLength']} chars"
        if "pattern" in schema and not re.search(schema["pattern"], v):
            return f"{path}: does not match {schema['pattern']}"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in schema and v < schema["minimum"]:
            return f"{path}: below {schema['minimum']}"
        if "maximum" in schema and v > schema["maximum"]:
            return f"{path}: above {schema['maximum']}"
    if isinstance(v, dict):
        for k in schema.get("required", ()):
            if k not in v:
                return f"{path}.{k}: required"
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = [k for k in v if k not in props]
            if extra:
                return f"{path}: unexpected {extra}"
        for k, sub in props.items():
            if k in v:
                err = _schema_errors(v[k], sub, f"{path}.{k}")
                if err:
                    return err
    if isinstance(v, list):
        if "maxItems" in schema and len(v) > schema["maxItems"]:
            return f"{path}: more than {schema['maxItems']} items"
        if "minItems" in schema and len(v) < schema["minItems"]:
            return f"{path}: fewer than {schema['minItems']} items"
        items = schema.get("items")
        if items:
            for i, x in enumerate(v):
                err = _schema_errors(x, items, f"{path}[{i}]")
                if err:
                    return err
    return None

# ---- configured roles (R15): config.yml is the single source of model/effort -------------
def configured_roles():
    """Effective modelRoles of the running profile: `ompd config get modelRoles`, else the config.yml block."""
    ompd = shutil.which("ompd") or os.path.expanduser("~/.local/bin/ompd")
    try:
        out = subprocess.run([ompd, "config", "get", "modelRoles"], capture_output=True, text=True, timeout=90)
        if out.returncode == 0 and out.stdout.strip():
            return json.loads(out.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    cfg = Path(os.environ.get("PI_CODING_AGENT_DIR") or os.path.expanduser("~/.omp/agent")) / "config.yml"
    roles, inblock = {}, False
    for line in cfg.read_text().splitlines():
        if re.match(r"^modelRoles:\s*$", line):
            inblock = True; continue
        if inblock:
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*(\S+)\s*$", line)
            if m:
                roles[m.group(1)] = m.group(2)
            elif line.strip() and not line.startswith("  "):
                break
    return roles

def _role_expectation(roles, role):
    """'provider/model:effort' -> {model, effort}. Missing role or effort suffix is a setup error (M7 tombstone, D4)."""
    sel = roles.get(role)
    if isinstance(sel, list):
        sel = sel[0] if sel else None
    if not sel:
        raise RuntimeError(f"modelRoles.{role} is not configured (a modelPresets entry may have tombstoned it)")
    i = sel.rfind(":")
    if i <= sel.find("/"):
        raise RuntimeError(f"modelRoles.{role} = {sel!r} carries no :effort suffix; converge roles must")
    return dict(model=sel[:i], effort=sel[i + 1:], selector=sel)

def _expected_from_config(sides, roles=None):
    roles = roles or configured_roles()
    exp = {}
    for side, fam in sides.items():
        f = FAMILY[fam]
        base, esc = _role_expectation(roles, f["role"]), _role_expectation(roles, f["esc_role"])
        exp[side] = dict(family=fam, agent=f["agent"], esc_agent=f["esc_agent"], role=f["role"], esc_role=f["esc_role"],
                         model=base["model"], effort=base["effort"], esc_model=esc["model"], esc_effort=esc["effort"])
    exp["judges"] = {}
    for j, d in JUDGE_DEFS.items():
        e = _role_expectation(roles, d["role"])
        exp["judges"][j] = dict(agent=d["agent"], role=d["role"], model=e["model"], effort=e["effort"])
    return exp

# ---- run lifecycle ----------------------------------------------------------------------
def new_run(question, tier, experiments=False, sides=None, constraints=None, slug=None, roles=None):
    """Create local://converge/<run-id>/ with manifest + empty ledger; freeze the configured roles into manifest.expected."""
    global RUN, _JEV_MODE
    assert tier in BUDGETS, tier
    _JEV_MODE = "typesafe"; _JEV_CACHE.clear()
    slug = re.sub(r"[^a-z0-9]+", "-", (slug or question).lower()).strip("-")[:24]
    run_id = f"{_dt.datetime.now():%Y%m%d-%H%M}-{slug}"
    if sides is None:
        fam = ["openai", "anthropic"]
        random.shuffle(fam)
        sides = {"A": fam[0], "B": fam[1]}
    manifest = dict(run_id=run_id, question=question, constraints=constraints or {}, tier=tier,
                    experiments=bool(experiments), sides=sides, opener=random.choice(SIDES) if tier == "L1" else None,
                    expected=_expected_from_config(sides, roles), budgets=dict(BUDGETS[tier]), per_spawn=PER_SPAWN,
                    jev_backend=_JEV_MODE, started_at=_now(), status="running", terminal_state=None, final_status=None,
                    escalated_at=None, reopened=False, contaminated_identities=False, tier_escalations=[],
                    failures={"A": 0, "B": 0}, falsification=None, panel=None, report=None, report_gate=None,
                    cost_usd=0.0, cost_by_job={}, wall_ms=0, ask={}, experiment_worktrees={}, spawns={})
    ledger = dict(run_id=run_id, tier=tier, round=0, cruxes=[], evidence=[], phi=[], non_progress_streak=0,
                  escalated_at=None, reopened=False, deferred=[], flags=[], ref_map={})
    RUN = {"manifest": manifest, "ledger": ledger}
    save(RUN)
    return RUN

def save(run=None):
    global _MANIFEST_DISK
    run = run or RUN
    _MANIFEST_DISK = _wj(_p("manifest.json", run), run["manifest"])
    _wj(_p("ledger.json", run), run["ledger"])
    return run

def load(run_or_id=None):
    """Reload manifest + ledger from disk (call at the start of every round; survives compaction)."""
    global RUN
    run_id = run_or_id if isinstance(run_or_id, str) else (run_or_id or RUN)["manifest"]["run_id"]
    RUN = {"manifest": _rj(f"{ROOT}/{run_id}/manifest.json"), "ledger": _rj(f"{ROOT}/{run_id}/ledger.json")}
    if RUN["manifest"] is None:
        raise FileNotFoundError(f"{ROOT}/{run_id}/manifest.json")
    return RUN

def record_ask(key, answer):
    load(); RUN["manifest"]["ask"][key] = answer; save()

def write_brief(text, evidence=()):
    """Freeze brief.md; register orchestrator-gathered evidence as E-0-n (verified, never counted as new)."""
    load()
    write(_p("brief.md"), text)
    for i, e in enumerate(evidence, 1):
        RUN["ledger"]["evidence"].append(dict(id=f"E-0-{i}", side="0", round=0, crux=e.get("crux"), claim=e["claim"],
            locator=e["locator"], quote=e.get("quote", "")[:600], verified=True, quote_supports_claim=None,
            supports_crux=None, counted_new_in_round=None))
    save()
    return _p("brief.md")

def escalate_tier(to_tier, approved, timed_out=False, reason=""):
    """Approval-gated tier transition (R13/R14): a timed-out ask never escalates. Updates manifest.tier, ledger.tier,
    budgets, tier_escalations atomically; L1->L2 marks identities contaminated (no blind drafts possible)."""
    load()
    M, L = RUN["manifest"], RUN["ledger"]
    order = ["L1", "L2", "L3"]
    ok = bool(approved) and not timed_out and to_tier in order and order.index(to_tier) > order.index(M["tier"])
    entry = dict(**{"from": M["tier"]}, to=to_tier, at_round=L["round"], approved=bool(approved), timed_out=bool(timed_out),
                 applied=ok, reason=reason, at=_now())
    M["tier_escalations"].append(entry)
    if ok:
        if M["tier"] == "L1":
            M["contaminated_identities"] = True
        M["tier"] = L["tier"] = to_tier
        M["budgets"] = dict(BUDGETS[to_tier])
        L["non_progress_streak"] = 0
    save()
    return dict(changed=ok, tier=M["tier"], budgets=M["budgets"], entry=entry)

# ---- jev wrapper ----------------------------------------------------------------
def jev(state, questions, tag="", r=None):
    """judge() with logging + fail-closed fallback. Raises JevUnavailable when the backend is down and the
    card has no orchestrator answer yet."""
    global _JEV_MODE
    digest = _digest([state, questions])
    entry = dict(at=_now(), tag=tag, digest=digest, state_digest=_digest(state), questions=list(questions),
                 state=state if len(json.dumps(state, default=str)) < 6000 else "<state elided>")
    if digest in _JEV_CACHE:
        answers, backend, error = _JEV_CACHE[digest], "orchestrator", None
        if RUN and RUN["manifest"].get("jev_backend") != "orchestrator":   # provenance survives any replay (N2)
            RUN["manifest"]["jev_backend"] = "orchestrator"; save()
    elif _JEV_MODE == "orchestrator":
        _jev_log(dict(entry, backend="orchestrator", answers=None, error="pending orchestrator answer"), r)
        raise JevUnavailable(digest, state, questions, "backend disabled for this run")
    else:
        t0 = time.time()
        try:
            answers, backend, error = judge(state, questions).wait(), "typesafe", None
        except Exception as exc:  # judgmentFallback=none -> fails closed
            _JEV_MODE = "orchestrator"
            if RUN:
                RUN["manifest"]["jev_backend"] = "orchestrator"; save()
            _jev_log(dict(entry, backend="typesafe", answers=None, error=str(exc), ms=int((time.time() - t0) * 1000)), r)
            raise JevUnavailable(digest, state, questions, exc) from None
        entry["ms"] = int((time.time() - t0) * 1000)
    _jev_log(dict(entry, backend=backend, answers=answers, error=error), r)
    return answers

def jev_answer(digest, answers):
    """Record the orchestrator's own answer for a failed card (same ids; bool -> {"bool": p}, choice ->
    {"choice": label, "probabilities": {...}}), then re-run the helper that raised."""
    _JEV_CACHE[digest] = answers
    return answers

def _jev_log(entry, r=None):
    if not RUN:
        return
    r = r if r is not None else RUN["ledger"].get("round") or 0
    path = _p(f"rounds/{r}/jev.json")
    log = _rj(path, [])
    log.append(entry)
    _wj(path, log)

def _pbool(ans, key):
    v = ans.get(key)
    return float(v["bool"] if isinstance(v, dict) else v)

def _pchoice(ans, key):
    v = ans[key]
    return v["probabilities"] if isinstance(v, dict) and "probabilities" in v else v

def jev_probe():
    """One trivial bool; sets manifest.jev_backend."""
    try:
        jev("The orchestrator is checking that its bookkeeping judge answers.", {"alive": {"type": "bool",
            "instructions": "Is this a check that the judge answers?"}}, tag="probe")
        backend = "typesafe"
    except JevUnavailable:
        backend = "orchestrator"
    if RUN:
        RUN["manifest"]["jev_backend"] = backend; save()
    return backend

# ---- stopping rule math (§1.7) ---------------------------------------------------
def phi(ledger):
    return round(sum(c["stakes"] * c["uncertainty"] for c in ledger["cruxes"] if c["status"] in OPEN), 4)

def progress(ledger, r):
    """progress(r) <=> phi_r <= phi_{r-1} - eps_r OR n_r >= 1; eps_r = max(0.25, 0.10*phi_{r-1}). Round 1 -> None."""
    by = {e["round"]: e for e in ledger["phi"]}
    if r <= 1 or (r - 1) not in by or r not in by:
        return None
    prev, cur = by[r - 1]["phi"], by[r]["phi"]
    eps = max(TH["eps_floor"], TH["eps_frac"] * prev)
    if cur <= prev - eps:
        return True
    return bool(by[r].get("new_evidence", 0) >= 1)

def _open(ledger):
    return [c for c in ledger["cruxes"] if c["status"] in OPEN]

def _material_count(ledger):
    return sum(1 for c in ledger["cruxes"] if c["status"] != "wording" and not c["status"].startswith("merged:"))

def terminal_state(ledger):
    """Debate math only: converged | converged_with_dissent | unresolved. Falsification/panel are applied by final_status()."""
    op = _open(ledger)
    if not op:
        return "converged"
    return "unresolved" if any(c["stakes"] == 3 for c in op) else "converged_with_dissent"

def _falsified(M):
    done = (M.get("falsification") or {}).get("completed") or {}
    return all(done.get(s) for s in SIDES)

def _withdrawn(ledger):
    return [c for c in ledger["cruxes"] if c["status"] == CLOSED_WITHDRAWN]

def _unadjudicated_fatal(M):
    """Fatal falsification objections the caps kept away from jev (N1): never adjudicated, so never silently absorbed."""
    f = M.get("falsification") or {}
    return [o for o in f.get("residual", []) if o.get("severity") == "fatal"
            and str(o.get("outcome", "")).startswith(("deferred:per_side_cap", "deferred:run_cap"))]

def final_status():
    """Effective outcome (R20/R21/R22/N1/N4/N5/D1): debate state, falsification completion, unresolved objections,
    withdrawn cruxes, panel ruling and panel notes -> report Status + every disclosure the report must carry."""
    load()
    L, M = RUN["ledger"], RUN["manifest"]
    debate = terminal_state(L)
    disclosures = []
    state = debate
    f = M.get("falsification") or {}
    if debate == "converged" and not _falsified(M):
        state = "converged_unfalsified"
    if not _falsified(M):
        disclosures.append("falsification " + (f.get("skipped_reason") or "not completed for " + ", ".join(s for s in SIDES if not (f.get("completed") or {}).get(s))))
    unresolved = list(f.get("unresolved") or [])
    if unresolved:   # admitted, verdict-changing objections with no round left: open cruxes, named here (N1)
        disclosures.append("falsification objections admitted with no round left, unresolved: " + ", ".join(unresolved))
    fatal_deferred = _unadjudicated_fatal(M)
    if fatal_deferred:
        if state == "converged":
            state = "converged_with_dissent"
        disclosures.append(f"{len(fatal_deferred)} fatal falsification objection(s) deferred by caps, not adjudicated")
    wd = _withdrawn(L)
    if wd:
        disclosures.append("withdrawn by both sides (UNKNOWN): " + ", ".join(c["id"] for c in wd))
    panel = M.get("panel") or {}
    status = STATUS_LABEL[state]
    if panel:
        if debate == "unresolved" and panel.get("winner") in ("A", "B"):
            status = "Judge-selected"
        elif panel.get("outcome") in ("tie", "insufficient"):
            disclosures.append(f"panel did not select: {panel['outcome']}")
        elif panel.get("outcome") == "split":
            disclosures.append("panel split; both reasons reported")
        elif panel.get("outcome") == "unavailable":
            disclosures.append("panel unavailable: " + json.dumps(panel.get("notes") or panel.get("reasons", {})))
        notes = panel.get("notes") or {}   # mandatory regardless of the joint outcome (N4/N5)
        for j in notes.get("inconsistent", []):
            disclosures.append(f"judge {j} order-inconsistent: independent ruling excluded"
                               + ("; validated conference final used" if j in notes.get("conference_final_used", []) else ""))
        for j in notes.get("missing_conference", []):
            disclosures.append(f"conference missing for {j}")
        for j in notes.get("incomplete_conference", []):
            disclosures.append(f"conference incomplete for {j}: peer exchange did not complete")
        for j, why in (notes.get("invalid_conference") or {}).items():
            disclosures.append(f"conference yield invalid for {j}: {why}")
        for j in notes.get("unsupported_change", []):
            disclosures.append(f"{j} conference change not validated; independent verdict stands")
        for j, txt in (notes.get("residual_disagreement") or {}).items():
            disclosures.append(f"panel residual disagreement ({j}): {_cap_words(txt, 30)}")
    if M.get("contaminated_identities"):
        disclosures.append("L1->L2 continuation: identities contaminated, no blind drafts")
    if M.get("jev_backend") == "orchestrator":
        disclosures.append("bookkeeping judged by orchestrator (jev unavailable)")
    return dict(debate=debate, state=state, status=status, panel=panel or None, disclosures=disclosures,
                open=[dict(id=c["id"], stakes=c["stakes"], u=c["uncertainty"]) for c in _open(L)],
                withdrawn=[dict(id=c["id"], stakes=c["stakes"], statement=c["statement"]) for c in wd],
                unresolved_objections=unresolved, fatal_deferred=len(fatal_deferred))

def escalation_needed(ledger=None):
    """Tier-escalation ask trigger (§1.11). `recommend` is always `accept` (R14: the recommended option is what a
    timed-out ask selects — spend needs a live owner); `advise` is the stance the description argues and equals
    `escalate` exactly when `needed` (D1). Withdrawn cruxes are closed and never trigger."""
    ledger = ledger or load()["ledger"]
    op = _open(ledger)
    phis = [e["phi"] for e in ledger["phi"]] or [0]
    state = terminal_state(ledger)
    reasons = []
    if state == "unresolved":
        reasons.append("open stakes-3 crux: " + ", ".join(c["id"] for c in op if c["stakes"] == 3))
    if phis[-1] > 0.5 * max(phis):
        reasons.append(f"phi stays heavy ({phis[-1]} > 0.5*{max(phis)})")
    if ledger["tier"] == "L1" and any(c["stakes"] == 3 for c in op):
        reasons.append("L1 ended with an open stakes-3 crux")
    nxt = {"L1": "L2", "L2": "L3", "L3": None}[ledger["tier"]]
    needed = bool(reasons) and nxt is not None
    return dict(needed=needed, next_tier=nxt, reasons=reasons, terminal_state=state,
                open=[dict(id=c["id"], stakes=c["stakes"], u=c["uncertainty"], statement=c["statement"]) for c in op],
                withdrawn=[c["id"] for c in _withdrawn(ledger)],
                recommend="accept", advise="escalate" if needed else "accept",
                note="recommend = the ask's `recommended` option (timeout-safe default); advise = the stance the description argues")

# ---- replies: validation + persistence (R2) --------------------------------------------
def _reply_kind(side, phase):
    M = RUN["manifest"]
    if phase == "falsification":
        return "falsification"
    if M["tier"] == "L1":
        return "l1_concurrence" if M["opener"] == side else "l1_draft"
    return "draft"

def validate_reply(reply, kind):
    """None when the reply satisfies the phase contract; else the reason. The complete phase schema is checked (nested
    required fields, types, enums, caps, additionalProperties) before any state is touched (R2)."""
    if not isinstance(reply, dict):
        return "reply is not an object"
    if reply.get("blocked"):
        return f"blocked: {reply['blocked']}"
    err = _schema_errors(reply, SCHEMA_BY_KIND[kind])
    if err:
        return "schema: " + err
    if kind in ("draft", "l1_draft") and not reply["position"].strip():
        return "empty position"
    return None

def save_replies(r, replies, phase="converge", attempt=1, invalid=None):
    """Persist raw yields immutably: every attempt as reply-<side>.a<n>.json; the accepted one as reply-<side>.json."""
    base = "falsification" if phase == "falsification" else f"rounds/{r}"
    for side, reply in replies.items():
        _wj(_p(f"{base}/reply-{side}.a{attempt}.json"), reply)
        if not (invalid or {}).get(side):
            _wj(_p(f"{base}/{side}.json" if phase == "falsification" else f"{base}/reply-{side}.json"), reply)

def _restore_point(rel):
    """Transactional ingestion (R1/N2): first call snapshots the ledger and the ingestion-owned manifest keys; a re-run
    restores exactly those before redoing the step. Runtime provenance (jev_backend, spawns, costs, asks) never rolls back."""
    load()
    before = _rj(_p(rel))
    if before is None:
        _wj(_p(rel), {"manifest": {k: RUN["manifest"].get(k) for k in INGEST_MANIFEST_KEYS}, "ledger": RUN["ledger"]})
    else:
        RUN["ledger"] = before["ledger"]
        for k in INGEST_MANIFEST_KEYS:
            RUN["manifest"][k] = json.loads(json.dumps(before["manifest"].get(k)))
        save()
    return _rj(_p(rel))

# ---- crux admission (shared by rounds and falsification; R18) ----------------------------
def _crux(ledger, cid):
    return next(c for c in ledger["cruxes"] if c["id"] == cid)

def _card_question():
    m = RUN["manifest"]
    return dict(question=m["question"], constraints=m["constraints"])

def _apply_position(L, cid, side, cx, r, event="position", overwrite=True):
    c = _crux(L, cid)
    if cx.get("mine") and (overwrite or side not in c["positions"]):
        c["positions"][side] = dict(text=_cap_words(cx["mine"], 120), round=r)
        c.setdefault("initial", {}).setdefault(side, dict(text=_cap_words(cx["mine"], 120), round=r))   # round-1 split (D2)
    if cx.get("steelman") and (overwrite or side not in c["steelman"]):
        c["steelman"][side] = cx["steelman"]
    if cx.get("falsifier") and (overwrite or side not in c["falsifier"]):
        c["falsifier"][side] = cx["falsifier"]
    for eid in cx.get("evidence") or []:
        if eid not in c["evidence"]:
            c["evidence"].append(eid)
    if event:
        c["history"].append(dict(round=r, event=event, side=side, detail=_cap_words(cx.get("mine", ""), 40)))

def _admit_candidate(side, cand, r, counter, phase="converge", other_text="", create=True, tag=""):
    """One candidate crux through the canonical gate: per-side cap -> jev M (+duplicate) -> run cap -> jev N (r>=3 or
    falsification). cand = {statement, mine, evidence, steelman?, falsifier?}. Returns (cid|None, outcome).
    Statements are frozen at <= TH.statement_words words (N3: packets and cards stay bounded)."""
    L = RUN["ledger"]
    cand = dict(cand, statement=_cap_words(str(cand["statement"]), TH["statement_words"]))
    counter[side] = counter.get(side, 0) + 1
    if counter[side] > TH["new_per_side"]:
        L["deferred"].append(dict(statement=cand["statement"], reason="over per-side cap (3/round)", round=r, side=side, phase=phase))
        return None, "deferred:per_side_cap"
    open_ = _open(L)
    state = dict(_card_question(), crux=cand["statement"], proposer_position=cand.get("mine", ""),
                 other_side_position=_cap_words(other_text, 250), open_cruxes={c["id"]: c["statement"] for c in open_},
                 evidence_summaries=list(cand.get("evidence") or [])[:6])
    qs = dict(Q_M)
    if open_:
        qs["duplicate"] = {"type": "choice",
            "instructions": "Is this crux the same disagreement as one of the existing open cruxes listed in state.open_cruxes?",
            "criteria": dict({"none": "distinct disagreement"}, **{c["id"]: c["statement"][:200] for c in open_[:254]})}
    ans = jev(state, qs, tag=f"M:{tag or side}", r=r)
    if "duplicate" in ans:
        probs = _pchoice(ans, "duplicate")
        dup, pdup = max(((k, float(v)) for k, v in probs.items() if k != "none"), key=lambda kv: kv[1], default=(None, 0.0))
        if dup and pdup >= TH["duplicate"] and any(c["id"] == dup for c in L["cruxes"]):
            if create:
                _apply_position(L, dup, side, cand, r, event="restated", overwrite=False)
            return dup, f"merged:{dup}"
    pm = _pchoice(ans, "materiality")
    pv, pi_, pw = float(pm.get("verdict", 0)), float(pm.get("implementation", 0)), float(pm.get("wording", 0))
    material = pv + pi_ >= TH["material"]
    if material and _material_count(L) >= TH["max_material"]:
        L["deferred"].append(dict(statement=cand["statement"], reason="run cap 12 material cruxes", round=r, side=side, phase=phase))
        return None, "deferred:run_cap"
    vc = None
    if material and (r >= 3 or phase == "falsification"):
        syn = _cap_words(_read_or(_p("checkpoints/synthesis-latest.md"), ""), 500)
        vc = _pbool(jev(dict(synthesis=syn, candidate_crux=cand["statement"], argument=cand.get("mine", "")), Q_N,
                        tag=f"N:{tag or side}", r=r), "verdict_changing")
        if vc < TH["verdict_changing"]:
            L["deferred"].append(dict(statement=cand["statement"], reason=f"not verdict-changing ({vc:.2f})", round=r, side=side, phase=phase))
            return None, f"deferred:not_verdict_changing:{vc:.2f}"
    if not create:
        return None, ("would_admit" if material else "wording") + (f":{vc:.2f}" if vc is not None else "")
    cid = f"C{len(L['cruxes']) + 1}"
    crux = dict(id=cid, statement=cand["statement"], origin=dict(round=r, side=side, phase=phase),
                materiality=dict(verdict=round(pv, 3), implementation=round(pi_, 3), wording=round(pw, 3)),
                stakes=3 if pv >= TH["stakes3"] else 2, positions={}, steelman={}, falsifier={}, evidence=[],
                convergence=None, uncertainty=1.0, weight=0.0, status="open" if material else "wording",
                history=[dict(round=r, event="opened", side=side, phase=phase)])
    crux["weight"] = float(crux["stakes"]) if material else 0.0
    L["cruxes"].append(crux)
    _apply_position(L, cid, side, cand, r, event=None)
    return cid, ("admitted" if material else "wording")

def admit_cruxes(replies, r):
    """Positions for existing refs; NEW-k through _admit_candidate. Returns {side: {"NEW-k": "C<n>"}}; persists ref_map."""
    load()
    L = RUN["ledger"]
    mapping, counter = {}, {}
    for side, reply in replies.items():
        mapping[side] = {}
        for cx in reply.get("cruxes") or []:
            ref = str(cx.get("ref", ""))
            if not ref.upper().startswith("NEW"):
                if any(c["id"] == ref for c in L["cruxes"]):
                    _apply_position(L, ref, side, cx, r)
                else:
                    L["deferred"].append(dict(statement=cx.get("statement", ""), reason=f"unknown ref {ref}", round=r, side=side))
                continue
            cid, outcome = _admit_candidate(side, cx, r, counter, other_text=(replies.get(_other(side)) or {}).get("position", ""), tag=f"{side}:{ref}")
            if cid:
                mapping[side][ref] = cid
    L["ref_map"][str(r)] = mapping
    save()
    return mapping

# ---- evidence (R4 support) -------------------------------------------------------------
def _fetch_locator(locator, quote):
    """Orchestrator fetches the locator itself. Returns (text_window, error)."""
    m = re.match(r"^exp:(X\d+)$", locator)
    if m:
        idx = _rj(_p("experiments/index.json"), {})
        e = idx.get(m.group(1))
        return (None, "unknown experiment id") if not e else (read(e["stdout"])[:2500], None)
    if re.match(r"^https?://", locator):
        try:
            text = read(locator.split("#", 1)[0])
        except Exception as exc:
            return None, f"fetch failed: {exc}"
        return _window(text, quote), None
    m = re.match(r"^(.+?):(\d+)(?:-(\d+))?$", locator)
    if not m:
        return None, "unparseable locator"
    path, a, b = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
    try:
        text = read(path, offset=a, limit=max(1, b - a + 1))
    except Exception as exc:
        return None, f"read failed: {exc}"
    return text[:2500], None

def _window(text, quote, span=1200):
    probe = (quote or "")[:40].strip()
    i = text.find(probe) if probe else -1
    return text[:2 * span] if i < 0 else text[max(0, i - span): i + span]

def _quote_present(fetched, quote):
    """Deterministic presence check (D4): None when the quote is too short to be decisive, else whether the
    whitespace/quote-normalised quote occurs verbatim in the fetched text."""
    q = _norm(quote)
    if len(q) < TH["min_quote_chars"]:
        return None
    return q in _norm(fetched)

def verify_evidence(replies, r, mapping=None):
    """Fetch every locator; deterministic quote-presence check first (D4: `quote_present`, diagnostics), then jev E
    (`quote_supports_claim`, `supports_crux`); append to ledger.evidence. `verified` = the quote is at the locator AND
    supports its claim (N7); n_r counts verified entries that support an open crux and are unseen."""
    load()
    L = RUN["ledger"]
    mapping = mapping or {}
    known = {e["id"]: e for e in L["evidence"]}
    n_new = 0
    for side, reply in replies.items():
        for ev in reply.get("evidence") or []:
            eid = ev["id"]
            if eid in known and known[eid]["locator"] == ev["locator"]:
                continue
            if eid in known:  # id collision with different content -> re-key
                eid = f"E-{side}-{1 + max([int(k.split('-')[-1]) for k in known if k.startswith(f'E-{side}-')] or [0])}"
            crux = mapping.get(side, {}).get(ev.get("crux"), ev.get("crux"))
            quote = (ev.get("quote") or "")[:600]
            fetched, err = _fetch_locator(ev["locator"], quote)
            entry = dict(id=eid, side=side, round=r, crux=crux, claim=ev["claim"], locator=ev["locator"], quote=quote,
                         verified=False, quote_present=None, quote_supports_claim=None, supports_crux=None, supports={},
                         counted_new_in_round=None, fetch_error=err)
            if fetched is not None:
                present = _quote_present(fetched, quote)
                entry["quote_present"] = present
                cstmt = _crux(L, crux)["statement"] if crux and any(c["id"] == crux for c in L["cruxes"]) else "(no crux)"
                card = dict(claim=ev["claim"], locator=ev["locator"], crux=cstmt, quote_present_verbatim=bool(present),
                            quote=quote if present else None,
                            context_as_fetched_by_orchestrator=_window(fetched, quote, 400) if present else fetched)
                ans = jev(card, Q_E, tag=f"E:{eid}", r=r)
                entry["quote_supports_claim"] = round(_pbool(ans, "quote_supports_claim"), 3)
                entry["supports_crux"] = round(_pbool(ans, "supports_crux"), 3)
                # verified = the quote is at the locator (deterministic when checkable, else jev's call) AND it supports the claim (N7)
                entry["verified"] = present is not False and entry["quote_supports_claim"] >= TH["quote"]
                if crux:
                    entry["supports"][crux] = entry["supports_crux"]
            is_open = crux and any(c["id"] == crux for c in _open(L))
            if entry["verified"] and is_open and (entry["supports_crux"] or 0) >= TH["crux"]:
                entry["counted_new_in_round"] = r
                n_new += 1
                c = _crux(L, crux)
                if eid not in c["evidence"]:
                    c["evidence"].append(eid)
            L["evidence"].append(entry)
            known[eid] = entry
    save()
    return n_new

def _evidence_basis(L, eid, cid, r=None):
    """(exists, valid, status) for a `moved_by` evidence id against the crux being conceded (R4). valid iff the entry is
    verified (quote present AND supports its claim) and its support for THIS crux is established: the score recorded when
    it was filed for this crux, else a fresh jev E `supports_crux` against this crux's statement (cached in entry.supports).
    Brief evidence (E-0-n) is verified by construction but still needs support for this crux."""
    e = next((x for x in L["evidence"] if x["id"] == eid), None)
    if not e:
        return False, False, "unknown id"
    if not e.get("verified"):
        return True, False, "unverified"
    sup = e.setdefault("supports", {})
    if e.get("crux") == cid and e.get("supports_crux") is not None:
        sup.setdefault(cid, e["supports_crux"])
    if cid not in sup:
        ans = jev(dict(claim=e["claim"], locator=e["locator"], quote=e.get("quote") or "", crux=_crux(L, cid)["statement"]),
                  Q_E_CRUX, tag=f"E:{eid}:{cid}", r=r)
        sup[cid] = round(_pbool(ans, "supports_crux"), 3)
    ok = sup[cid] >= TH["crux"]
    return True, ok, ("verified" if ok else f"verified but does not support {cid} ({sup[cid]:.2f})")

# ---- convergence state (R3/R4/R5) -----------------------------------------------------
def converge_state(r, replies, prior_cruxes=None, force=False):
    """jev C per open crux after round r (r>=2, or force); both_withdraw closure (D1); sycophancy + crux-specific
    moved_by validation (R4); scoped_out needs both sides; a crux not addressed by both sides this round is left
    untouched (never closed by silence). ledger.flags holds standing flags: a crux re-evaluated or closed this round
    drops its earlier flags (D7)."""
    load()
    L = RUN["ledger"]
    prior = {c["id"]: c for c in (prior_cruxes or [])}
    flags, evaluated = [], set()
    for c in _open(L):
        if r <= 1 and not force:
            c["uncertainty"], c["weight"] = 1.0, float(c["stakes"]); continue
        scoped = {}
        for s, rep in replies.items():
            for k in rep.get("scoped_out") or []:
                if k.get("crux") == c["id"]:
                    scoped[s] = k.get("why", "")
        if set(scoped) == set(SIDES):
            evaluated.add(c["id"])
            c["status"], c["weight"] = "scoped_out", 0.0
            c["scoped_out"] = scoped
            c["history"].append(dict(round=r, event="scoped_out", side="AB", why=scoped)); continue
        this_round = {s: (c["positions"].get(s, {}).get("text", "") if c["positions"].get(s, {}).get("round") == r else "") for s in SIDES}
        if not all(this_round.values()):
            silent = [s for s in SIDES if not this_round[s]]
            c["history"].append(dict(round=r, event="unaddressed", side="".join(silent)))
            flags += [f"unaddressed:{c['id']}:{s}" for s in silent]
            evaluated.add(c["id"])
            continue
        evaluated.add(c["id"])
        conc = [dict(side=s, **k) for s, rep in replies.items() for k in (rep.get("concessions") or []) if k.get("crux") == c["id"]]
        invalid_basis = False
        for k in conc:
            mb = str(k.get("moved_by", "")).strip()
            if EVID_RE.match(mb):
                exists, valid, status = _evidence_basis(L, mb, c["id"], r)
                k["moved_by_kind"] = "evidence"
                k["moved_by_status"] = status
                invalid_basis = invalid_basis or not valid
            else:
                k["moved_by_kind"] = "argument"
                k["moved_by_status"] = "quoted argument (assess in concession_without_evidence)"
        state = dict(crux=c["statement"],
                     prior_positions={s: (prior.get(c["id"], {}).get("positions", {}).get(s, {}) or {}).get("text") for s in SIDES},
                     this_round=this_round, concessions=conc, evidence_ids=c["evidence"])
        qs = {"state": Q_C_STATE, "both_withdraw": Q_C_WITHDRAW}
        if conc:
            qs["concession_without_evidence"] = Q_C_SYCO
        ans = jev(state, qs, tag=f"C:{c['id']}", r=r)
        p = _pchoice(ans, "state")
        pa, pp, pd = float(p.get("agree", 0)), float(p.get("partial", 0)), float(p.get("disagree", 0))
        u = pd + 0.5 * pp
        c["convergence"] = dict(agree=round(pa, 3), partial=round(pp, 3), disagree=round(pd, 3))
        pw = round(_pbool(ans, "both_withdraw"), 3)
        if pw >= TH["withdraw"]:   # both sides dropped it: closed, out of Φ and of the escalation trigger; reported as UNKNOWN (D1)
            c["status"], c["weight"], c["uncertainty"] = CLOSED_WITHDRAWN, 0.0, round(u, 4)
            c["withdrawn"] = dict(round=r, both_withdraw=pw, positions=this_round)
            c["history"].append(dict(round=r, event="withdrawn", side="AB", both_withdraw=pw, jev=c["convergence"]))
            continue
        syco_p = round(_pbool(ans, "concession_without_evidence"), 3) if conc else None
        for k in conc:
            c["history"].append(dict(round=r, event="concession", side=k["side"], moved_by=k.get("moved_by"),
                                     moved_by_status=k["moved_by_status"], flag=dict(concession_without_evidence=syco_p)))
        syco = bool(conc) and (syco_p >= TH["syco"] or invalid_basis)
        if syco:  # a concession without a verified basis never lowers phi below the contested floor
            flags += [f"{'invalid_moved_by' if invalid_basis else 'sycophancy'}:{c['id']}:{k['side']}" for k in conc]
            c["status"] = "contested_closure" if u <= TH["close_u"] else "open"
            u = max(u, 0.5)
        elif u <= TH["close_u"]:
            c["status"] = "closed_agree"
        else:
            c["status"] = "open"
        c["uncertainty"] = round(u, 4)
        c["weight"] = round(c["stakes"] * u, 4) if c["status"] in OPEN else 0.0
        c["history"].append(dict(round=r, event="state", jev=c["convergence"], both_withdraw=pw))
    still_open = {c["id"] for c in _open(L)}
    L["flags"] = [f for f in L["flags"] if _flag_crux(f) in still_open and _flag_crux(f) not in evaluated] + flags
    save()
    return flags

def _flag_crux(flag):
    parts = flag.split(":")
    return parts[1] if len(parts) >= 2 else None

# ---- round close (R19) ---------------------------------------------------------------
def _wall_exceeded():
    M = RUN["manifest"]
    elapsed = (_dt.datetime.now(_dt.timezone.utc) - _dt.datetime.fromisoformat(M["started_at"])).total_seconds() / 60
    return elapsed >= M["budgets"]["wall_min"]

def _escalated(r):
    e = RUN["ledger"]["escalated_at"]
    return e is not None and r > e

def _agents(r):
    return {s: (RUN["manifest"]["expected"][s]["esc_agent"] if _escalated(r) else RUN["manifest"]["expected"][s]["agent"]) for s in SIDES}

def _efforts(r):
    return {s: (RUN["manifest"]["expected"][s]["esc_effort"] if _escalated(r) else RUN["manifest"]["expected"][s]["effort"]) for s in SIDES}

def _last_convergence_round(M):
    """Rounds available to the convergence loop; the final round is reserved for the falsification reopen."""
    return max(1, M["budgets"]["max_rounds"] - 1)

def close_round(r, replies, n_new, phase="converge", spawn=None, flags=(), forced_non_progress=False):
    """Phi_r, progress, streak, escalation decision, rounds/<r>/record.json. Returns next action."""
    load()
    L, M = RUN["ledger"], RUN["manifest"]
    L["round"] = r
    ph = phi(L)
    L["phi"] = [e for e in L["phi"] if e["round"] != r] + [dict(round=r, phi=ph, open=len(_open(L)), new_evidence=n_new, progress=None)]
    prog = progress(L, r)
    if forced_non_progress and r >= 2:
        prog = False
    L["phi"][-1]["progress"] = prog
    L["phi"][-1]["reason"] = None if prog is None else ("forced" if forced_non_progress else "phi_drop" if prog and n_new == 0 else "new_evidence" if prog else "none")
    action = "continue"
    if prog is False:
        L["non_progress_streak"] += 1
        if L["non_progress_streak"] >= 2:
            action = "stop"
        elif L["escalated_at"] is None:
            L["escalated_at"] = M["escalated_at"] = r; action = "escalate"
    elif prog:
        L["non_progress_streak"] = 0
    if (ph == 0 and not forced_non_progress) or r >= _last_convergence_round(M) or _wall_exceeded() or phase == "reopen":
        action = "stop"  # a round with failed input never ends the run on an empty phi
    record = _rj(_p(f"rounds/{r}/record.json"), {}) or {}
    record.update(dict(round=r, phase=phase, effort=_efforts(r), agents=_agents(r), spawn=spawn or record.get("spawn", {}),
                  phi_before=(L["phi"][-2]["phi"] if len(L["phi"]) > 1 else None), phi_after=ph, progress=prog,
                  progress_reason=L["phi"][-1]["reason"], cruxes_opened=[c["id"] for c in L["cruxes"] if c["origin"]["round"] == r and c["origin"].get("phase") != "falsification"],
                  cruxes_closed=[c["id"] for c in L["cruxes"] if any(h.get("round") == r and h.get("event") in ("state", "withdrawn") for h in c["history"]) and c["status"].startswith("closed")],
                  cruxes_deferred=sum(1 for d in L["deferred"] if d["round"] == r), flags=list(flags), jev_backend=M["jev_backend"],
                  checkpoint=f"checkpoints/synthesis-{r}.md", ended_at=_now(), action=action))
    _wj(_p(f"rounds/{r}/record.json"), record)
    save()
    harvest_costs([f"{phase}:{r}"])   # the children have yielded: their session files are complete (D3)
    return dict(round=r, phi=ph, progress=prog, streak=L["non_progress_streak"], n_new=n_new, action=action,
                open=[dict(id=c["id"], s=c["stakes"], u=c["uncertainty"]) for c in _open(L)], flags=list(flags))

# ---- falsification objections (R18/R23) ----------------------------------------------------
def _classify_objections(replies, r):
    """Every objection (why_wrong + evidence ids retained) through _admit_candidate. Material, verdict-changing objections
    are ALWAYS admitted as open cruxes (N1): with a round left they drive the reopen; without one they stay open and
    unresolved, so no budget cap can turn a successful falsifier into plain Converged. Returns {admitted, residual, verdict_stands}."""
    L = RUN["ledger"]
    syn = _cap_words(_read_or(_p("checkpoints/synthesis-latest.md"), ""), 500)
    admitted, residual, counter = [], [], {}
    for side, rep in replies.items():
        for ob in rep.get("objections") or []:
            cand = dict(statement=ob["statement"], mine=ob.get("why_wrong", ""), evidence=list(ob.get("evidence") or []))
            cid, outcome = _admit_candidate(side, cand, r, counter, phase="falsification", other_text=syn, tag=f"F:{side}")
            item = dict(side=side, statement=ob["statement"], why_wrong=ob.get("why_wrong", ""), evidence=cand["evidence"],
                        severity=ob.get("severity", "minor"), outcome=outcome)
            (admitted if cid and outcome == "admitted" else residual).append(dict(item, id=cid) if cid else item)
    order = {"fatal": 0, "material": 1, "minor": 2}
    residual.sort(key=lambda o: order.get(o["severity"], 3))
    return dict(admitted=admitted, residual=residual, verdict_stands={s: rep.get("verdict_stands") for s, rep in replies.items()})

def _mark_unresolved(out, r, why):
    """Admitted objections that no round can contest stay open cruxes; name them for final_status (N1)."""
    L = RUN["ledger"]
    ids = [o["id"] for o in out["admitted"]]
    for cid in ids:
        _crux(L, cid)["history"].append(dict(round=r, event="unresolved_objection", why=why))
    out["unresolved"] = ids
    return out

# ---- ingestion entry points (R1/R2) ---------------------------------------------------------
def ingest_round(r, replies, phase="converge", spawn=None, attempt=1):
    """One call per round attempt. Validates each reply against its phase contract first: an invalid/blocked reply on
    attempt 1 => action `retry` (re-spawn those sides with the identical packet); on attempt 2 => that side's failure
    count rises, the round counts as non-progress, no crux is closed from failed input; a side failing twice in a run
    => `incomplete_transport`. Re-running the same (r, attempt) restarts from rounds/<r>/state-before.json."""
    _restore_point(f"rounds/{r}/state-before.json")
    before = _rj(_p(f"rounds/{r}/state-before.json"))["ledger"]["cruxes"]
    M = RUN["manifest"]
    kinds = {s: _reply_kind(s, phase) for s in SIDES}
    invalid = {s: validate_reply(replies.get(s), kinds[s]) for s in SIDES}
    invalid = {s: why for s, why in invalid.items() if why}
    save_replies(r, replies, phase, attempt, invalid)
    if invalid and attempt == 1:
        _wj(_p(f"rounds/{r}/retry.json"), dict(sides=sorted(invalid), reasons=invalid, at=_now()))
        return dict(round=r, action="retry", retry=sorted(invalid), reasons=invalid)
    for s in invalid:
        M["failures"][s] = M["failures"].get(s, 0) + 1
    save()
    if any(M["failures"][s] >= 2 for s in invalid):
        return dict(round=r, action="incomplete_transport", reasons=invalid, failures=dict(M["failures"]))
    valid = {s: rep for s, rep in replies.items() if s not in invalid}
    flags = [f"invalid:{s}:{why}" for s, why in invalid.items()]
    l1 = M["tier"] == "L1"
    if l1 and invalid:  # L1 needs both sides; a half exchange is void
        return dict(close_round(r, valid, 0, phase, spawn, flags=flags, forced_non_progress=True), invalid=invalid, failures=dict(M["failures"]))
    mapping = admit_cruxes(valid, r)
    n_new = verify_evidence(valid, r, mapping)
    if l1:
        L, opener = RUN["ledger"], M["opener"]
        drafter_map = mapping.get(_other(opener), {})
        for pc in (valid.get(opener) or {}).get("per_crux") or []:
            cid = drafter_map.get(pc.get("ref"), pc.get("ref"))
            if any(c["id"] == cid for c in L["cruxes"]):
                _apply_position(L, cid, opener, dict(mine=f"[{pc.get('state')}] {pc.get('why', '')}"), r)
        save()
    if not invalid:
        flags += converge_state(r, valid, prior_cruxes=before, force=l1)
        if l1:  # falsification is integrated into the single exchange; no reopen round exists in L1
            out = _mark_unresolved(_classify_objections(valid, r), r, "L1 has no reopen round")
            RUN["manifest"]["falsification"] = dict(at=_now(), integrated=True, completed={s: True for s in SIDES}, **out)
            save()
    return dict(close_round(r, valid, n_new, phase, spawn, flags, forced_non_progress=bool(invalid)), invalid=invalid,
                failures=dict(RUN["manifest"]["failures"]))

def ingest_falsification(replies, attempt=1):
    """Transactional (R1): verify evidence and classify against one state, commit objections + reopened together.
    Invalid/blocked reply: attempt 1 => `retry` those sides; attempt 2 => that side's falsification is `incomplete`
    (disclosed by final_status). Reopen only if a round remains (R19) and never twice."""
    _restore_point("falsification/state-before.json")
    L, M = RUN["ledger"], RUN["manifest"]
    r = L["round"]
    invalid = {s: validate_reply(replies.get(s), "falsification") for s in SIDES}
    invalid = {s: why for s, why in invalid.items() if why}
    save_replies(r, replies, "falsification", attempt, invalid)
    if invalid and attempt == 1:
        return dict(action="retry", retry=sorted(invalid), reasons=invalid)
    valid = {s: rep for s, rep in replies.items() if s not in invalid}
    verify_evidence(valid, r)
    L, M = RUN["ledger"], RUN["manifest"]
    can_reopen = (not M["reopened"]) and (r + 1 <= M["budgets"]["max_rounds"])
    out = _classify_objections(valid, r)
    reopen = bool(out["admitted"]) and can_reopen
    if reopen:
        M["reopened"] = L["reopened"] = True
    elif out["admitted"]:
        _mark_unresolved(out, r, "reopen already used" if M["reopened"] else "no round left")
    M["falsification"] = dict(at=_now(), integrated=False, completed={s: s in valid for s in SIDES}, invalid=invalid,
                              reopen_allowed=can_reopen, **out)
    save()
    harvest_costs([f"falsification:{r}"])
    return dict(action="reopen" if reopen else "final", reopen=reopen, **out)

def skip_falsification(reason):
    """Record that falsification did not run (wall cap); final_status discloses it and never reports plain Converged."""
    load()
    RUN["manifest"]["falsification"] = dict(at=_now(), integrated=False, completed={s: False for s in SIDES},
                                            skipped_reason=reason, admitted=[], residual=[], verdict_stands={})
    save()

def finish(terminal=None):
    """Persist debate terminal_state, the effective final status/label, wall time and the harvested cost of every spawn."""
    harvest_costs()
    fs = None if terminal == "incomplete_transport" else final_status()   # loads; take RUN only after it
    load()
    M = RUN["manifest"]
    if fs is None:
        M["terminal_state"] = M["final_status"] = "incomplete_transport"; M["status"] = "incomplete_transport"
    else:
        M["terminal_state"], M["final_status"], M["report_status"] = fs["debate"], fs["state"], fs["status"]
        M["disclosures"] = fs["disclosures"]
        M["status"] = "done"
    M["wall_ms"] = int((_dt.datetime.now(_dt.timezone.utc) - _dt.datetime.fromisoformat(M["started_at"])).total_seconds() * 1000)
    save()
    return M["final_status"]

# ---- packets + spawn batches (§2.8; R8/R12) -------------------------------------------------
def _tag():
    return _digest(RUN["manifest"]["run_id"])[:6]

def _name(kind, r, who):
    """Run/round/phase-specific requested spawn name (R12). kind: R converge, F falsification, O reopen, V verdict, C conference."""
    return f"Cv{_tag()}{kind}{r}{who}"

def _rules_block(tier, l1=False):
    b = RUN["manifest"]["budgets"]
    lines = [
        "## Rules",
        "- Evidence MUST cite `path:L1-L2`, `URL#fragment`, or `exp:X<n>`; quote <= 600 chars verbatim. Uncited claims are assumptions.",
        f"- Position <= {PER_SPAWN['position_words']} words, answer-first. <= {PER_SPAWN['tool_calls']} tool calls, <= {PER_SPAWN['web_search']} web searches.",
        "- Address EVERY open crux listed in this packet; a crux you omit is not agreement and stays open.",
        "- Refer to the other participant only as 'the other side'. Never name or guess models.",
        "- Yield structured output only (the schema given to you). Incomplete => set `blocked`.",
    ]
    if l1:
        lines.append("- Hub: FIRST block with `hub wait from:Main` until Main sends `PEER: <id>`; only that id is your peer (<= 3 messages, fire-and-forget `hub send`, then `hub wait from:<id>`). `Main` for BLOCKED/NEEDS-APPROVAL only. Peer silent 15 min => yield `blocked`.")
    else:
        lines.append("- Hub: `Main` only, and only for `BLOCKED:` / `NEEDS-APPROVAL:` one-liners. NEVER `hub list`, NEVER contact any other agent.")
    lines.append(f"- Budget: {b['spawn_cap_min']} min wall for this spawn; Main cancels over-cap spawns.")
    return "\n".join(lines)

def _open_ids_block():
    """Mandatory: every open crux id with a bounded statement summary (N3); full statements are a variable section."""
    return "## Open cruxes (ids)\n" + ("\n".join(f"- {c['id']} (stakes {c['stakes']}, u={c['uncertainty']:.2f}) — {_cap_words(c['statement'], IDS_SUMMARY_WORDS)}"
                                        for c in _open(RUN["ledger"])) or "- none")

def _open_full_block():
    """Variable: the frozen statements that the ids block summarised (only those longer than the summary cap)."""
    long_ = [c for c in _open(RUN["ledger"]) if _words(c["statement"]) > IDS_SUMMARY_WORDS]
    if not long_:
        return None
    return "## Open cruxes — full statements\n" + "\n".join(f"- {c['id']}: {c['statement']}" for c in long_)

def _open_detail_block(side, cap):
    L = RUN["ledger"]
    out = ["## Open cruxes — positions"]
    for c in _open(L):
        you = _cap_words(c["positions"].get(side, {}).get("text", "(you have not stated a position)"), cap)
        them = _cap_words(c["positions"].get(_other(side), {}).get("text", "(the other side has not stated a position)"), cap)
        out += [f"### {c['id']}", f"- You: {you}", f"- The other side: {them}",
                f"- Their falsifier: {_cap_words(c['falsifier'].get(_other(side), '—'), cap)}",
                f"- Evidence ids: {', '.join(c['evidence']) or '—'}"]
    return "\n".join(out)

def _novel_block(side, r, cap):
    L = RUN["ledger"]
    o = _other(side)
    out = [f"## New from the other side since round {r - 1}"]
    prev = _rj(_p(f"rounds/{r - 1}/reply-{o}.json"), {}) or {}
    refmap = (L.get("ref_map") or {}).get(str(r - 1), {}).get(o, {})
    for cx in prev.get("cruxes") or []:
        cid = refmap.get(cx.get("ref"), cx.get("ref"))
        if cx.get("mine") and any(c["id"] == cid for c in _open(L)):
            out.append(f"- On {cid}: {_cap_words(cx['mine'], cap)}")
    for e in L["evidence"]:
        if e["side"] == o and e["round"] == r - 1:
            out.append(f"- {e['id']} [{'verified' if e['verified'] else 'UNVERIFIED'}] ({e['locator']}): {_cap_words(e['claim'], cap)}")
    return "\n".join(out) if len(out) > 1 else out[0] + "\n- (nothing new)"

def _requested_block(r):
    return "\n".join(["## Requested",
        "- Per open crux: restate the other side's strongest case (`steelman`), state yours (`mine`), name your falsifier.",
        "- Concede only with `moved_by` (a VERIFIED evidence id or the other side's quoted argument) + reason.",
        f"- New cruxes: <= {TH['new_per_side']} as `NEW-1..3`, each with `stakes_claim`." + (" After round 2 a new crux is admitted only if it would change the decision." if r >= 3 else ""),
        "- Cite verified evidence ids; add new evidence only for open cruxes; continue your `E-<side>-n` numbering."])

class PacketOverflow(ValueError):
    """Mandatory packet sections alone exceed the word budget (N3): shorten the question/constraints before spawning."""

def _fit(sections, budget, overflow_path):
    """Mandatory sections kept whole. Every variable section is rendered at least as its heading + continuation note
    (+ the ellipsis _cap_words appends): that overhead is budgeted BEFORE allocation, so `remaining` is the room for
    content only. A legal fit exists iff mandatory + Σ overhead ≤ budget, else PacketOverflow. Variable sections share
    `remaining` by weight (unused share flows on); an over-share section is capped in the packet and written whole to
    the overflow file (R8). The assembled body is re-measured; a strictly shrinking trim loop settles any residue (N3)."""
    note = f"\n(continued in `{overflow_path}` — you MAY read that file)"
    note_words = _words(note)
    mandatory_words = sum(_words(t) for kind, t, _ in sections if kind == "m")
    variable = [(t, w, _words(t.split("\n", 1)[0]) + note_words + 1) for kind, t, w in sections if kind == "v"]  # (text, weight, min words)
    overhead = sum(mn for _, _, mn in variable)
    if mandatory_words + overhead > budget:
        raise PacketOverflow(f"no legal fit: mandatory sections take {mandatory_words} words + {overhead} words of variable-section "
                             f"headings/notes > {budget}; shorten the question, constraints, or extra context")
    remaining = budget - mandatory_words - overhead
    total_w = sum(w for _, w, _ in variable) or 1

    def capped(text, keep):
        return _cap_words(text, keep) + note

    out, spilled, carry = [], [], 0
    for text, weight, mn in variable:
        share = mn + int(remaining * weight / total_w) + carry   # whole-section room incl. its reserved overhead
        n = _words(text)
        if n <= share:
            out.append([text, None]); carry = share - n
        else:
            spilled.append(text)
            keep = share - note_words - 1          # heading + content words kept; ≥ heading words by construction
            out.append([capped(text, keep), keep]); carry = 0
    vi = iter(range(len(out)))
    order = [next(vi) if kind == "v" else None for kind, _, _ in sections]
    def total():
        return sum(_words(out[i][0]) if i is not None else _words(sections[k][1]) for k, i in enumerate(order))
    excess = total() - budget
    while excess > 0:   # each pass strictly shrinks one variable section by ≥ 1 word, or proves no legal fit
        best, room = None, 0
        for i, (text, keep) in enumerate(out):
            src = variable[i][0]
            cur = keep if keep is not None else _words(src)
            floor_ = variable[i][2] - note_words - 1                  # heading words
            if cur - floor_ > room:
                best, room = i, cur - floor_
        if best is None:
            raise PacketOverflow(f"no legal fit: assembled packet is {excess} words over {budget} with every variable section at its heading")
        text, keep = out[best]
        src = variable[best][0]
        cur = keep if keep is not None else _words(src)
        new_keep = max(variable[best][2] - note_words - 1, cur - excess)
        if new_keep >= cur:
            new_keep = cur - 1
        if src not in spilled:
            spilled.append(src)
        out[best] = [capped(src, new_keep), new_keep]
        excess = total() - budget
    body = [out[i][0] if i is not None else sections[k][1] for k, i in enumerate(order)]
    return body, spilled

def packet(side, r, phase="converge", extra=None):
    """Render exactly what a side receives; written to rounds/<r>/packet-<side>.md (falsification/packet-<side>.md).
    Instructions and every open crux id are never truncated; overflow goes to packet-<side>-overflow.md."""
    load()
    M, L = RUN["manifest"], RUN["ledger"]
    tier, brief = M["tier"], _p("brief.md")
    where_dir = "falsification" if phase == "falsification" else f"rounds/{r}"
    overflow_path = _p(f"{where_dir}/packet-{side}-overflow.md")
    head = "\n\n".join([f"# converge {M['run_id']} — tier {tier} — round {r} — you are side {side}",
                        f"Question: {M['question']}", f"Brief (read first): `{brief}`"])
    sections = [("m", head, 0)]
    if phase == "falsification":
        sections += [("m", "## Task\nThe debate has stopped; the synthesis below is the best-so-far answer. Give the strongest reasons it is WRONG.\n"
                           "Each objection: statement, why_wrong, evidence ids (cite), severity fatal|material|minor. `verdict_stands`: your honest overall call. <= 6 objections, strongest first.", 0),
                     ("v", "## Agreed synthesis\n" + _read_or(_p("checkpoints/synthesis-latest.md"), "(missing)"), 3),
                     ("v", "## Closed cruxes\n" + ("\n".join(f"- {c['id']} [{c['status']}] {c['statement']}" for c in L["cruxes"] if c["status"].startswith("closed") or c["status"] == "scoped_out") or "- none"), 1),
                     ("m", _rules_block(tier), 0)]
    elif tier == "L1":
        opener = M["opener"] == side
        sections += [("m", "\n".join(["## L1 protocol (one exchange, hub)",
                     f"- Opener: {'you' if opener else 'the other side'}. Order: opener sends position (<= 500 words) + cruxes; responder sends position + cruxes + objections; opener sends rebuttal + concessions (`moved_by`); then both yield.",
                     ("- You yield: concurrence per crux (`per_crux`: ref, agree|partial|disagree, why) and `objections` falsifying the responder's draft." if opener else
                      "- You yield: the converged draft (`position` <= 700 words), `cruxes` with both positions, `concessions` with `moved_by`, `evidence`, and `objections` falsifying your own draft (`verdict_stands`)."),
                     "- Wait for `PEER: <id>` from Main before any peer message; the peer id is NOT guessable."]), 0),
                     ("m", _rules_block(tier, l1=True), 0)]
    elif r == 1:
        sections += [("m", "## Task\nBlind first draft. Nobody else's position is available; do not seek one.\nAnswer the question; name <= 3 cruxes you consider decisive (`NEW-1..3`) with your falsifier for each; cite evidence.", 0),
                     ("m", _rules_block(tier), 0)]
    else:
        prev = _rj(_p(f"rounds/{r - 1}/reply-{side}.json"), {}) or {}
        sections += [("v", "## Your last position\n" + (prev.get("position") or "(none)"), 2),
                     ("m", _open_ids_block(), 0),
                     ("v", _open_detail_block(side, 120), 4),
                     ("v", _novel_block(side, r, 120), 2),
                     ("m", _requested_block(r), 0),
                     ("m", _rules_block(tier), 0)]
        full = _open_full_block()
        if full:
            sections.insert(3, ("v", full, 1))
    if extra:   # context (an L1 transcript): bounded like any other variable section (N3)
        sections.append(("v", extra, 3))
    body, spilled = _fit(sections, PER_SPAWN["packet_words"], overflow_path)
    text = "\n\n".join(body)
    if _words(text) > PER_SPAWN["packet_words"]:   # re-measure the assembled packet before anything is written (N3)
        raise PacketOverflow(f"assembled packet is {_words(text)} words > {PER_SPAWN['packet_words']}")
    if spilled:
        write(overflow_path, "\n\n".join(spilled))
    write(_p(f"{where_dir}/packet-{side}.md"), text)
    return text

def _schema_for(side, phase):
    M = RUN["manifest"]
    if phase == "falsification":
        return SCHEMA_FALSIFICATION
    if M["tier"] == "L1":
        return SCHEMA_L1_CONCURRENCE if M["opener"] == side else SCHEMA_L1_DRAFT
    return SCHEMA_DRAFT

def spawn_round(r, phase="converge", tools=None, sides=SIDES, attempt=1, extra=None):
    """Build the `task` batch for round r (Main submits it). Names are run/round/phase-specific; -esc agents once
    escalated; explicit outputSchema per role. Retry: sides=[…], attempt=2, extra=<transcript-so-far> (L1)."""
    load()
    M = RUN["manifest"]
    agents = _agents(r)
    kind = {"converge": "R", "falsification": "F", "reopen": "O"}[phase]
    tasks = []
    for side in sides:
        name = _name(kind, r, side) + ("" if attempt == 1 else f"b{attempt}")
        t = dict(name=name, agent=agents[side], task=packet(side, r, phase, extra), outputSchema=_schema_for(side, phase))
        if tools:
            t["tools"] = list(tools)
        tasks.append(t)
    ctx = (f"# Goal\nconverge run {M['run_id']}, tier {M['tier']}, round {r}, phase {phase}.\n"
           f"# Constraints\nRead-only participants; structured yield only; hub per your packet. Per-spawn cap {M['budgets']['spawn_cap_min']} min.\n"
           f"# Contract\nYour packet is the whole assignment; the brief is at {_p('brief.md')}.")
    where = "falsification" if phase == "falsification" else f"rounds/{r}"
    _wj(_p(f"{where}/spawn-{phase}-a{attempt}.json"), dict(tasks=[dict(name=t["name"], agent=t["agent"], side=s) for t, s in zip(tasks, sides)],
                                                          efforts=_efforts(r), at=_now()))
    return dict(i=f"Spawning converge round {r} ({phase})", context=ctx, tasks=tasks)

def _spawn_dir(phase, r):
    return "falsification" if phase == "falsification" else ("l3" if phase in ("verdict", "conference") else f"rounds/{r}")

def register_spawn(r, phase, ids):
    """ids = {requested name: allocated job/agent id} from ONE task result. Returns that batch's {side|judge: id} — the
    set to identity-check. manifest.spawns["<phase>:<r>"] accumulates every batch (R12): `by_who` = the latest id per
    role across retries (see spawn_ids), `batches` = every allocation (costs are harvested for all of them, D3)."""
    load()
    M = RUN["manifest"]
    by_name = {}
    for att in (1, 2, 3):
        for t in (_rj(_p(f"{_spawn_dir(phase, r)}/spawn-{phase}-a{att}.json")) or {}).get("tasks", []):
            by_name[t["name"]] = t.get("side") or t.get("who")
    batch = {by_name.get(n, n): jid for n, jid in ids.items()}
    entry = M["spawns"].setdefault(f"{phase}:{r}", dict(ids={}, by_who={}, batches=[]))
    entry["ids"].update(ids)
    entry["by_who"].update(batch)
    entry["batches"].append(dict(ids=dict(ids), by_who=batch, at=_now()))
    entry["current"] = batch
    save()
    return batch

def spawn_ids(r, phase="converge"):
    """Merged {side|judge: latest id} for a phase/round across retries — the mapping for peer_messages (R12)."""
    load()
    return dict((RUN["manifest"]["spawns"].get(f"{phase}:{r}") or {}).get("by_who", {}))

def peer_messages(who_ids):
    """L1 / conference peer release (R12): {"A": idA, "B": idB} or {"J1": id, "J2": id} -> hub sends for Main. After a
    one-side retry pass spawn_ids(r, phase): the surviving peer (parked after its yield) is revived by the send."""
    keys = list(who_ids)
    assert len(keys) == 2, f"peer release needs exactly two ids (use spawn_ids(r, phase) after a retry): {who_ids}"
    a, b = keys
    return [dict(op="send", to=who_ids[a], message=f"PEER: {who_ids[b]} — you may now exchange with your peer per your packet."),
            dict(op="send", to=who_ids[b], message=f"PEER: {who_ids[a]} — you may now exchange with your peer per your packet.")]

def l1_transcript(r, side):
    """`extra` for an L1 one-side retry: the surviving side's accepted yield rendered as the transcript so far (anonymised)."""
    load()
    rep = _rj(_p(f"rounds/{r}/reply-{side}.json"), {}) or {}
    lines = ["## Transcript so far (the other side's yield; your peer may be revived by Main's PEER message)"]
    if rep.get("position"):
        lines.append("### Position\n" + _anon(rep["position"], 500))
    for cx in rep.get("cruxes") or []:
        lines.append(f"- {cx.get('ref')}: {_cap_words(cx.get('statement', ''), 40)} — their view: {_cap_words(cx.get('mine', ''), 60)}")
    for pc in rep.get("per_crux") or []:
        lines.append(f"- {pc.get('ref')}: [{pc.get('state')}] {_cap_words(pc.get('why', ''), 40)}")
    for ob in rep.get("objections") or []:
        lines.append(f"- objection ({ob.get('severity')}): {_cap_words(ob.get('statement', ''), 40)}")
    return "\n".join(lines)

def expected_for(r, ids):
    """{side: {model, effort}} for identity_check of ONE debater batch: `ids` is exactly what register_spawn returned for
    it, so the expectation covers the spawned sides and nothing else (R12). Model/effort come from the frozen manifest
    and the round's escalation state."""
    load()
    sides = [s for s in ids if s in SIDES]
    unknown = [s for s in ids if s not in SIDES]
    if not ids or unknown:
        raise ValueError(f"expected_for needs the debater batch returned by register_spawn (got {list(ids or [])}); unknown roles {unknown}")
    eff = _efforts(r)
    E = RUN["manifest"]["expected"]
    return {s: dict(model=(E[s]["esc_model"] if _escalated(r) else E[s]["model"]), effort=eff[s]) for s in sides}

def expected_judges(stage, ids):
    """{who: {model, effort}} for ONE panel batch (`ids` = what register_spawn returned: J1-AB…/J1, J2)."""
    E = RUN["manifest"]["expected"]["judges"]
    valid = [f"{j}-{o}" for j in JUDGE_DEFS for o in ("AB", "BA")] if stage == "verdict" else list(JUDGE_DEFS)
    unknown = [w for w in ids if w not in valid]
    if not ids or unknown:
        raise ValueError(f"expected_judges needs the {stage} batch returned by register_spawn (got {list(ids or [])}); unknown roles {unknown}")
    return {n: dict(model=E[n.split("-")[0]]["model"], effort=E[n.split("-")[0]]["effort"]) for n in ids}

def identity_check(snapshot, expected, job_ids):
    """snapshot = `await tool.hub(op="jobs", i=...)` (dict with details.jobs). expected = {who: {model, effort}} for the
    batch; job_ids = {who: job id} — the batch returned by register_spawn, REQUIRED (no label matching: stale jobs from
    earlier rounds share names). The two MUST name the same roles: a spawned id without an expectation, or an expectation
    without an id, is a call-site error (R12). A row whose identity fields are still `pending` (the child has not streamed
    yet) is neither ok nor a mismatch: the result says `retry` — re-check after the next `hub wait` wake, never sleep in eval (D6)."""
    job_ids = job_ids or {}
    missing = [w for w in expected if not job_ids.get(w)]
    unexpected = [w for w in job_ids if w not in expected]
    if missing or unexpected:
        raise ValueError(f"identity_check: expectations and the batch must cover the same roles (no id for {missing}; "
                         f"no expectation for {unexpected}); pass expected_for(r, ids) / expected_judges(stage, ids) with the ids you registered")
    jobs = (snapshot or {}).get("details", {}).get("jobs", []) if isinstance(snapshot, dict) else []
    rows, mismatches, pending = [], [], []
    for who, exp in expected.items():
        job = next((j for j in jobs if j.get("id") == job_ids[who]), None)
        ident = (job or {}).get("resolvedModelIdentity") or ""
        base = ident.split("@", 1)[0]
        level = (job or {}).get("resolvedThinkingLevel")
        fb = (job or {}).get("resolvedModelIsFallback", False)
        is_pending = bool(job) and not ident and job.get("status") in (None, "queued", "pending", "running")
        ok = bool(job) and base == exp["model"] and level == exp["effort"] and not fb
        row = dict(who=who, job=job_ids[who], expected=exp, resolved_model=(job or {}).get("resolvedModel"),
                   identity=ident, thinking=level, fallback=fb, ok=ok, pending=is_pending)
        rows.append(row)
        if is_pending:
            pending.append(who)
        elif not ok:
            mismatches.append(row)
    result = dict(ok=not mismatches and not pending, retry=bool(pending) and not mismatches, pending=pending,
                  rows=rows, mismatches=mismatches, at=_now())
    if RUN:
        r = RUN["ledger"]["round"] + 1
        path = _p(f"rounds/{r}/identity.json")
        _wj(path, (_rj(path, []) or []) + [result])
    return result

def spawn_meta(r, side, **fields):
    """Store per-spawn facts (job, resolved, wall_ms, tool_calls, retries, …) in rounds/<r>/record.json. Cost and token
    counts are never typed here: harvest_costs reads them from the child's session file (N8)."""
    if "cost_usd" in fields or "tokens" in fields:
        raise ValueError("cost_usd/tokens are harvested from the child's session file (harvest_costs), not recorded by hand")
    load()
    path = _p(f"rounds/{r}/record.json")
    rec = _rj(path, {}) or {}
    rec.setdefault("spawn", {}).setdefault(side, {}).update(fields)
    _wj(path, rec)
    return rec["spawn"]

# ---- cost accounting (D3): each child's session file lives beside the parent's, <session>/<job id>.jsonl ----------
def _session_dir():
    """The parent session directory, derived from where local:// lands on disk (…/<session>/local/converge/<run>/)."""
    if _MANIFEST_DISK is None:
        save()
    p = Path(str(_MANIFEST_DISK)).resolve()
    return p.parents[3] if len(p.parents) > 3 and p.parents[2].name == "local" else None

def _job_usage(job_id):
    """Sum of assistant-message usage in the child's session file; None when the file is absent."""
    sd = _session_dir()
    f = (sd / f"{job_id}.jsonl") if sd else None
    if not f or not f.is_file():
        return None
    usd, tin, tout, req = 0.0, 0, 0, 0
    with f.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"usage"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") if isinstance(e, dict) else None
            u = m.get("usage") if isinstance(m, dict) and m.get("role") == "assistant" else None
            if not isinstance(u, dict):
                continue
            req += 1
            tin += int(u.get("input") or 0) + int(u.get("cacheRead") or 0) + int(u.get("cacheWrite") or 0)
            tout += int(u.get("output") or 0)
            usd += float((u.get("cost") or {}).get("total") or 0)
    return dict(usd=round(usd, 4), tokens_in=tin, tokens_out=tout, requests=req)

def harvest_costs(keys=None):
    """Read every registered spawn's usage (all batches, retries included) from its session file into
    manifest.cost_by_job — the single source of spend (N8) — recompute manifest.cost_usd, and copy per-side cost/tokens
    into rounds/<r>/record.json. Idempotent; jobs whose file is absent are reported in `missing` (and manifest.cost_missing)."""
    load()
    M = RUN["manifest"]
    by_job = M.setdefault("cost_by_job", {})
    missing = []
    for key, entry in M["spawns"].items():
        if keys and key not in keys:
            continue
        phase, r = key.split(":")
        for b in entry.get("batches") or [dict(by_who=entry.get("by_who", {}))]:
            for who, jid in b["by_who"].items():
                u = _job_usage(jid)
                if u is None:
                    if jid not in by_job:
                        missing.append(jid)
                    continue
                by_job[jid] = dict(u, who=who, key=key)
                if phase in ("converge", "reopen"):
                    path = _p(f"rounds/{r}/record.json")
                    rec = _rj(path, {}) or {}
                    rec.setdefault("spawn", {}).setdefault(who, {}).update(job=jid, cost_usd=u["usd"], tokens=dict(**{"in": u["tokens_in"], "out": u["tokens_out"]}), requests=u["requests"])
                    _wj(path, rec)
    M["cost_usd"] = round(sum(float(v.get("usd") or 0) for v in by_job.values()), 4)
    M["cost_missing"] = sorted(set([*(M.get("cost_missing") or []), *missing]) - set(by_job))
    save()
    return dict(cost_usd=M["cost_usd"], jobs=len(by_job), missing=missing, session_dir=str(_session_dir()))

# ---- checkpoints -------------------------------------------------------------------
def _coerce_header(text, state, has_stakes3):
    """The synthesis header can never contradict the stopping rule (D5): Status := the debate-state label; Confidence
    is capped at Low with an open stakes-3 crux and at Medium with any open crux. Missing lines are inserted."""
    label = f"{STATUS_LABEL[state]} (interim: debate state, before falsification)"
    cap = "Low" if has_stakes3 else ("Medium" if state != "converged" else None)
    text, n = re.subn(r"^\*\*Status:\*\*.*$", f"**Status:** {label}", text, count=1, flags=re.M)
    if not n:
        text = f"**Status:** {label}\n" + text
    def conf(m):
        level = m.group(1)
        if cap == "Low" or (cap == "Medium" and level == "High"):
            return f"**Confidence:** {cap}{m.group(2)} (capped by the stopping rule: {state})"
        return m.group(0)
    text, n = re.subn(r"^\*\*Confidence:\*\*\s*(High|Medium|Low)(.*)$", conf, text, count=1, flags=re.M)
    if not n and cap:
        text = re.sub(r"^(\*\*Status:\*\*.*$)", rf"\1\n**Confidence:** {cap} — capped by the stopping rule: {state}", text, count=1, flags=re.M)
    return text

def checkpoint(r, text):
    """checkpoints/synthesis-<r>.md (+ synthesis-latest.md copy). Rewrite, never concatenate. text = decision-writing
    skeleton, <= 600 words; its Status/Confidence lines are coerced to terminal_state (D5)."""
    load()
    L = RUN["ledger"]
    state = terminal_state(L)
    op_list = _open(L)
    op = ", ".join(f"{c['id']} (s={c['stakes']},u={c['uncertainty']:.2f})" for c in op_list) or "none"
    wd = ", ".join(c["id"] for c in _withdrawn(L)) or "none"
    head = f"<!-- converge {L['run_id']} · round {r} · state {state} · Φ_{r} = {phi(L)} · open cruxes: {op} · withdrawn: {wd} · {_now()} -->\n"
    body = head + _coerce_header(text.strip(), state, any(c["stakes"] == 3 for c in op_list)) + f"\n\nDebate state: {state}\nOpen cruxes: {op}\nWithdrawn (UNKNOWN): {wd}\nΦ_{r} = {phi(L)}\n"
    write(_p(f"checkpoints/synthesis-{r}.md"), body)
    write(_p("checkpoints/synthesis-latest.md"), body)
    return _p(f"checkpoints/synthesis-{r}.md")

# ---- L3 panel (§1.12; R9/R10/R11/R22/R23) ------------------------------------------------
def _anon(text, cap=700):
    return _cap_words(IDENTITY_STRIP.sub("[redacted]", text or ""), cap)

def _positions_for_dossier():
    """(posA, posB, mode): parallel structure for both. Unconverged: per open crux. Converged: A = synthesis as numbered
    claims; B = rejected alternative from the falsification objections with argument + evidence ids, fatal/material first."""
    M, L = RUN["manifest"], RUN["ledger"]
    op = _open(L)
    if op:
        def render(side):
            return "\n\n".join(f"### {c['id']} — {c['statement']}\n**Claim:** {c['positions'].get(side, {}).get('text', '(no position)')}\n"
                               f"**Falsifier:** {c['falsifier'].get(side, '—')}\n**Evidence:** {', '.join(c['evidence']) or '—'}" for c in op)
        return render("A"), render("B"), "unconverged"
    syn = _read_or(_p("checkpoints/synthesis-latest.md"), "")
    syn = re.sub(r"^<!--.*?-->\n", "", syn, flags=re.S)
    paras = [p.strip() for p in re.split(r"\n\s*\n", syn) if p.strip() and not p.strip().startswith(("Open cruxes:", "Φ_", "Debate state:", "Withdrawn"))]
    posA = "\n\n".join(f"### {i}. {p.splitlines()[0].lstrip('# ').strip()[:80]}\n**Claim:** {p}\n**Falsifier:** —\n**Evidence:** {', '.join(e['id'] for e in L['evidence'] if e['verified'])[:200] or '—'}"
                       for i, p in enumerate(paras[:6], 1))
    f = M.get("falsification") or {}
    objs = [*f.get("admitted", []), *f.get("residual", [])]
    order = {"fatal": 0, "material": 1, "minor": 2}
    objs.sort(key=lambda o: order.get(o.get("severity"), 3))
    posB = "\n\n".join(f"### {i}. {o['statement']}\n**Claim:** {o.get('why_wrong') or '(no argument recorded)'}\n"
                       f"**Falsifier:** severity {o.get('severity')}\n**Evidence:** {', '.join(o.get('evidence') or []) or '—'}" for i, o in enumerate(objs[:6], 1)) or "### 1. (no objections were raised)"
    return posA, posB, "converged"

def dossier():
    """l3/dossier.md (canonical: A first) and l3/dossier-BA.md (position blocks and labels swapped; R9)."""
    load()
    M, L = RUN["manifest"], RUN["ledger"]
    posA, posB, mode = _positions_for_dossier()
    op = _open(L)
    agreed = [f"- {c['id']} [{c['status']}] {c['statement']}" for c in L["cruxes"] if c["status"] in ("closed_agree", "closed_evidence", "scoped_out")]
    withdrawn = [f"- {c['id']} [{CLOSED_WITHDRAWN}] {c['statement']}" for c in _withdrawn(L)]
    ev = [f"- {e['id']} [{'verified' if e['verified'] else 'UNVERIFIED'}] {e['locator']} — {e['claim']}" for e in L["evidence"]]
    def render(first, second):
        return "\n\n".join([
            f"# Dossier — converge {M['run_id']} ({mode})",
            f"## Question\n{M['question']}\n\nConstraints: {json.dumps(M['constraints'])}",
            "## Agreed facts and closed cruxes\n" + ("\n".join(agreed) or "- none"),
            "## Withdrawn by both sides (UNKNOWN; not in dispute, not established)\n" + ("\n".join(withdrawn) or "- none"),
            "## Open cruxes\n" + ("\n".join(f"- {c['id']} (stakes {c['stakes']}) {c['statement']}" for c in op) or "- none"),
            "## Position A\n" + _anon(first), "## Position B\n" + _anon(second),
            "## Evidence index\n" + ("\n".join(ev) or "- none"),
            "Judges: score the 7 criteria first, cite every deduction, then pick a winner; `insufficient` is allowed."])
    write(_p("l3/dossier.md"), render(posA, posB))
    write(_p("l3/dossier-BA.md"), render(posB, posA))
    return _p("l3/dossier.md")

def spawn_panel(stage, verdicts=None, who=None, attempt=1):
    """stage='verdict' -> 4 tasks (J1-AB, J1-BA, J2-AB, J2-BA; BA reads dossier-BA.md); stage='conference' -> 2 tasks.
    Retry one failed spawn: who=["J2-BA"] (or ["J2"]), attempt=2 — same dossier file, suffixed name."""
    load()
    M = RUN["manifest"]
    E = M["expected"]["judges"]
    cap = M["budgets"].get("judge_cap_min", 25)
    suffix = "" if attempt == 1 else f"b{attempt}"
    tasks, spec = [], []
    if stage == "verdict":
        for j in JUDGE_DEFS:
            for order in ("AB", "BA"):
                if who and f"{j}-{order}" not in who:
                    continue
                d = _p("l3/dossier-BA.md" if order == "BA" else "l3/dossier.md")
                name = _name("V", j[1], f"{order}") + suffix
                tasks.append(dict(name=name, agent=E[j]["agent"], outputSchema=SCHEMA_VERDICT, task="\n".join([
                    f"Mode: verdict. Dossier: `{d}` (read it whole; the labels A/B in that file are your labels).",
                    f"Score all 7 criteria 1–5 per side with a `cite` for every score < 5, then winner/margin/decisive_evidence/fatal_flaws/confidence. Cap {cap} min.",
                    "Hub: `Main` only, `BLOCKED:` only."])))
                spec.append(dict(name=name, agent=E[j]["agent"], who=f"{j}-{order}"))
    else:
        v = json.dumps(verdicts or {}, indent=1, ensure_ascii=False)
        for j in JUDGE_DEFS:
            if who and j not in who:
                continue
            name = _name("C", 1, j) + suffix
            tasks.append(dict(name=name, agent=E[j]["agent"], outputSchema=SCHEMA_CONFERENCE, task="\n".join([
                f"Mode: conference. You are {j}. Dossier: `{_p('l3/dossier.md')}` (canonical labels).",
                "All four independent verdicts (canonical labels; BA rows were mapped back):", "```json", v, "```",
                "FIRST block with `hub wait from:Main` until Main sends `PEER: <id>`; that id is the other judge. Exchange <= 3 `hub send` messages, `hub wait from:<id>` between them; change your winner only for a cited reason.",
                "`exchange_completed` = true ONLY if you received at least one message from the peer; a silent peer (15 min) => false, with `residual_disagreement` saying so.",
                f"Yield the conference schema. Cap {cap} min. `Main` only for `BLOCKED:`."])))
            spec.append(dict(name=name, agent=E[j]["agent"], who=j))
    _wj(_p(f"l3/spawn-{stage}-a{attempt}.json"), dict(tasks=spec, at=_now()))
    return dict(i=f"Spawning L3 panel ({stage})", context=f"# Goal\nconverge {M['run_id']} L3 panel, stage {stage}.\n# Constraints\nDossier only; read-only; structured yield.\n# Contract\nSee your task.", tasks=tasks)

def _map_back(verdict, order):
    if order == "AB" or not verdict:
        return verdict
    sw = {"A": "B", "B": "A"}
    v = json.loads(json.dumps(verdict))
    v["winner"] = sw.get(v.get("winner"), v.get("winner"))
    for k, c in (v.get("criteria") or {}).items():
        if isinstance(c, dict) and "A" in c and "B" in c:
            c["A"], c["B"] = c["B"], c["A"]
    for f in v.get("fatal_flaws") or []:
        f["side"] = sw.get(f.get("side"), f.get("side"))
    return v

def validate_verdict(v):
    """None if the verdict satisfies the full 2.5.1 schema (N6) AND carries a cite for every score < 5; else the reason.
    Validation happens before any field is read or mapped."""
    err = _schema_errors(v, SCHEMA_VERDICT)
    if err:
        return "schema: " + err
    for k in JUDGE_CRITERIA:
        c = v["criteria"][k]
        if any(c[s] < 5 for s in SIDES) and not str(c.get("cite", "")).strip():
            return f"criteria.{k} score < 5 without cite"
    return None

def validate_conference(c):
    """None if the conference yield satisfies 2.5.2 (+ exchange_completed); else the reason."""
    err = _schema_errors(c, SCHEMA_CONFERENCE)
    return "schema: " + err if err else None

def panel_verdicts(raw):
    """raw = {"J1-AB": verdict|None, "J1-BA": …}. Invalid/missing verdicts are recorded as such (never guessed).
    Writes l3/verdict-*.json; returns {verdicts (mapped back), invalid, consistent, complete}."""
    load()
    out, invalid = {}, {}
    for j in JUDGE_DEFS:
        for order in ("AB", "BA"):
            key = f"{j}-{order}"
            v = raw.get(key)
            why = validate_verdict(v)
            if v is not None:
                _wj(_p(f"l3/verdict-{key}.json"), v)
            if why:
                invalid[key] = why
            else:
                out[key] = _map_back(v, order)
    cons, complete = {}, {}
    for j in JUDGE_DEFS:
        a, b = out.get(f"{j}-AB"), out.get(f"{j}-BA")
        complete[j] = bool(a and b)
        wa, wb = (a or {}).get("winner"), (b or {}).get("winner")
        cons[j] = complete[j] and ((wa == wb) or ({wa, wb} <= {"tie", "insufficient"}))
    return dict(verdicts=out, invalid=invalid, consistent=cons, complete=complete)

def panel_aggregate(mapped, conferences, accept_changes=None):
    """l3/panel.json (design §1.12; R10/R11/R22/N4/N5). Per judge: the independent ruling counts only with BOTH validated
    verdicts and consistent orderings; an order-inconsistent judge's independent ruling is excluded (disclosed) but its
    conference final still counts when Main validated the cited resolution (accept_changes[j] is True). A conference
    yield counts only if it validates and `exchange_completed` is true; otherwise missing/invalid/incomplete is recorded
    and the independent verdict stands. A consistent judge's changed final counts only with an accepted change (R11).
    joint.winner is A|B only; tie/insufficient/split/unavailable are outcomes, never a selection (R22)."""
    load()
    accept_changes = accept_changes or {}
    verdicts, cons, complete = mapped["verdicts"], mapped["consistent"], mapped.get("complete", {})
    E = RUN["manifest"]["expected"]["judges"]
    judges, finals = {}, {}
    notes = dict(unavailable=[], inconsistent=[], unsupported_change=[], missing_conference=[], incomplete_conference=[],
                 invalid_conference={}, residual_disagreement={}, conference_final_used=[])
    for j in JUDGE_DEFS:
        ab, ba = verdicts.get(f"{j}-AB"), verdicts.get(f"{j}-BA")
        conf = conferences.get(j)
        conf_ok = False
        if conf is None:
            notes["missing_conference"].append(j)
        else:
            why = validate_conference(conf)
            if why:
                notes["invalid_conference"][j] = why
            elif not conf.get("exchange_completed"):
                notes["incomplete_conference"].append(j)
            else:
                conf_ok = True
                if conf.get("residual_disagreement"):
                    notes["residual_disagreement"][j] = conf["residual_disagreement"]
        final, independent = None, None
        if not complete.get(j):
            notes["unavailable"].append(j)
        elif not cons.get(j):
            independent = "inconsistent"; notes["inconsistent"].append(j)
            if conf_ok and accept_changes.get(j) is True:   # §1.12: the validated conference final still counts
                final = conf["final_winner"]; notes["conference_final_used"].append(j)
            elif conf_ok:
                notes["unsupported_change"].append(j)
        else:
            independent = ab["winner"]; final = independent
            if conf_ok and conf.get("final_winner") != independent:
                if conf.get("changed_from_independent") and accept_changes.get(j) is True:
                    final = conf["final_winner"]; notes["conference_final_used"].append(j)
                else:
                    notes["unsupported_change"].append(j)
        finals[j] = final
        judges[j] = dict(model=E[j]["model"], AB=ab, BA=ba, consistent=cons.get(j, False), complete=complete.get(j, False),
                         independent=independent, final=final, conference=conf, conference_ok=conf_ok)
    valid = {j: w for j, w in finals.items() if w in ("A", "B", "tie", "insufficient")}
    reasons = {j: (conferences.get(j) or {}).get("why") for j in JUDGE_DEFS}
    split = None
    if len(valid) == 2 and len(set(valid.values())) == 1 and set(valid.values()) <= set(SIDES):
        agreed = winner = next(iter(valid.values())); outcome = "judge_selected"
    elif len(valid) == 2 and set(valid.values()) <= {"tie", "insufficient"}:   # two non-selections agree: nothing selected
        agreed, winner = None, None
        outcome = "tie" if set(valid.values()) == {"tie"} else "insufficient"
    elif len(valid) == 2:
        agreed, winner, outcome = None, None, "split"
        split = dict(J1_reason=reasons["J1"], J2_reason=reasons["J2"], finals=finals)
    else:
        agreed, winner, outcome = None, None, "unavailable"
    panel = dict(judges=judges, conference=conferences, joint=dict(winner=winner, agreed=agreed, outcome=outcome, reasons=reasons, notes=notes),
                 split=split, outcome=outcome, at=_now())
    for j, c in conferences.items():
        if c is not None:
            _wj(_p(f"l3/conference-{j}.json"), c)
    _wj(_p("l3/panel.json"), panel)
    RUN["manifest"]["panel"] = dict(winner=winner, agreed=agreed, outcome=outcome, reasons=reasons, notes=notes); save()
    harvest_costs(["verdict:0", "conference:0"])
    return panel

# ---- experiments (§1.13; R16/R17) ----------------------------------------------------------
def enable_experiments(repo_cwd=None):
    """Create detached /tmp worktrees per side and define the run_experiment @tool. Call only after owner approval."""
    load()
    M = RUN["manifest"]
    cwd = repo_cwd or os.getcwd()
    for side in SIDES:
        path = f"/tmp/converge/{M['run_id']}/{side}"
        if not os.path.isdir(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            subprocess.run(["git", "worktree", "add", "--detach", path, "HEAD"], cwd=cwd, check=True, capture_output=True, text=True)
        M["experiment_worktrees"][side] = dict(path=path, repo=cwd)
    M["experiments"] = True
    save()

    @tool
    def run_experiment(side: str, name: str, script: str, timeout_s: int = 300) -> str:
        """Run a bash script in your side's throwaway /tmp worktree (serialized, scrubbed env, timeout). Returns a summary and an `exp:X<n>` id you may cite as an evidence locator. Scripts that push/publish/post or write outside the sandbox are refused; scripts over 12000 chars are refused unscreened."""
        load()
        M2 = RUN["manifest"]
        wt = M2["experiment_worktrees"].get(side, {}).get("path")
        if not wt:
            return f"refused: unknown side {side!r}"
        if len(script) > TH["max_script_chars"]:
            return f"refused: script is {len(script)} chars; the safety screen covers at most {TH['max_script_chars']} — split it"
        ans = jev(dict(script=script, cwd=wt), Q_X, tag=f"X:{side}:{name}")   # the COMPLETE script is screened
        bad = [k for k in Q_X if _pbool(ans, k) >= TH["experiment_screen"]]
        if bad:
            return f"refused: screen flagged {', '.join(bad)}; keep the script inside {wt} or /tmp and off the network's write paths"
        idx = _rj(_p("experiments/index.json"), {}) or {}
        xid = f"X{len(idx) + 1}"
        r = RUN["ledger"]["round"] + 1
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "exp"
        base = f"experiments/{r}-{side}-{slug}"
        spath = write(_p(f"{base}/script.sh"), script)
        env = {k: v for k, v in os.environ.items() if not re.search(r"(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)", k, re.I)}
        env.update(HOME=str(Path.home()), TMPDIR="/tmp", CONVERGE_SIDE=side, CONVERGE_EXPERIMENT=xid)
        t0 = time.time()
        with _EXP_LOCK:
            try:
                proc = subprocess.run(["bash", str(spath)], cwd=wt, env=env, capture_output=True, text=True, timeout=timeout_s)
                out, err, code, timed_out = proc.stdout, proc.stderr, proc.returncode, False
            except subprocess.TimeoutExpired as exc:
                out, err, code, timed_out = _text(exc.stdout), _text(exc.stderr) + f"\n[timeout after {timeout_s}s]", -1, True
        ms = int((time.time() - t0) * 1000)
        write(_p(f"{base}/stdout"), out or "")
        write(_p(f"{base}/stderr"), err or "")
        meta = dict(id=xid, side=side, name=name, round=r, cwd=wt, exit=code, timed_out=timed_out, duration_ms=ms, at=_now(),
                    stdout=_p(f"{base}/stdout"), stderr=_p(f"{base}/stderr"), script=_p(f"{base}/script.sh"))
        _wj(_p(f"{base}/meta.json"), meta)
        idx[xid] = meta
        _wj(_p("experiments/index.json"), idx)
        return (f"exp:{xid} exit={code}{' (timeout)' if timed_out else ''} {ms}ms cwd={wt}\n--- stdout (tail) ---\n{(out or '')[-1500:]}"
                f"\n--- stderr (tail) ---\n{(err or '')[-600:]}")
    return ["run_experiment"]

def cleanup():
    """Remove experiment worktrees; mark manifest.status done. Cancel stragglers yourself (hub cancel) before calling."""
    load()
    M = RUN["manifest"]
    for side, wt in list(M.get("experiment_worktrees", {}).items()):
        subprocess.run(["git", "worktree", "remove", "--force", wt["path"]], cwd=wt["repo"], capture_output=True, text=True)
        M["experiment_worktrees"].pop(side, None)
    if M["status"] == "running":
        M["status"] = "done"
    save()
    return M["status"]

# ---- report gate (§1.15; R20/D2) -------------------------------------------------------------
CONVERGENCE_MARKER = "<!-- convergence -->"   # decision-writing skeleton line before the convergence section

def _convergence_section(report_text):
    """(section, found): the section after the `<!-- convergence -->` marker (stable across Converged / No convergence
    headings); fallback = the first `## ` heading mentioning convergence/dissent/split; else ("", False)."""
    i = report_text.find(CONVERGENCE_MARKER)
    if i >= 0:
        m = re.search(r"^## .*?(?=^## |\Z)", report_text[i:], re.S | re.M)
        if m:
            return m.group(0), True
    m = re.search(r"^## [^\n]*(converg|dissent|split|disagree)[^\n]*\n.*?(?=^## |\Z)", report_text, re.S | re.M | re.I)
    return (m.group(0), True) if m else ("", False)

def _first_position(c, side):
    init = (c.get("initial") or {}).get(side)
    if init:
        return init.get("text")
    h = next((h for h in c["history"] if h.get("event") == "position" and h.get("side") == side), None)
    return h.get("detail") if h else None

def report_gate(report_text):
    """jev R on header + convergence section vs the effective outcome. The card (D2) carries: effective status, debate
    state, disclosures, panel; per crux: statement, status, stakes, round-1 positions, final positions, concessions with
    moved_by (+status), withdrawn positions; verified evidence {id, claim, locator}; falsification objections with
    why_wrong and outcome. Returns p; manifest.report_gate records it."""
    fs = final_status()
    L, M = RUN["ledger"], RUN["manifest"]
    f = M.get("falsification") or {}
    cruxes = []
    for c in L["cruxes"]:
        if c["status"].startswith("merged:"):
            continue
        cruxes.append(dict(id=c["id"], statement=c["statement"], status=c["status"], stakes=c["stakes"],
                           initial={s: _cap_words(_first_position(c, s) or "", 60) or None for s in SIDES},
                           final={s: _cap_words(c["positions"].get(s, {}).get("text") or "", 60) or None for s in SIDES},
                           concessions=[dict(side=h.get("side"), round=h.get("round"), moved_by=h.get("moved_by"), moved_by_status=h.get("moved_by_status"))
                                        for h in c["history"] if h.get("event") == "concession"],
                           withdrawn=(c.get("withdrawn") or {}).get("positions"), evidence=c["evidence"]))
    evidence = [dict(id=e["id"], claim=_cap_words(e["claim"], 30), locator=e["locator"], crux=e.get("crux")) for e in L["evidence"] if e.get("verified")][:60]
    objections = [dict(id=o.get("id"), statement=_cap_words(o["statement"], 40), why_wrong=_cap_words(o.get("why_wrong", ""), 40), severity=o.get("severity"), outcome=o.get("outcome"))
                  for o in [*f.get("admitted", []), *f.get("residual", [])]]
    summary = dict(effective_status=fs["status"], debate_state=fs["debate"], disclosures=fs["disclosures"], panel=fs["panel"],
                   open_crux_ids=[o["id"] for o in fs["open"]], withdrawn_crux_ids=[w["id"] for w in fs["withdrawn"]],
                   unresolved_objection_crux_ids=fs["unresolved_objections"], cruxes=cruxes, verified_evidence=evidence,
                   falsification=dict(verdict_stands=f.get("verdict_stands"), objections=objections))
    section, found = _convergence_section(report_text)
    header = report_text.split("\n## ", 1)[0]
    p = _pbool(jev(dict(ledger=summary, report_header=header, convergence_section=section, convergence_section_found=found),
                   Q_R, tag="R"), "report_matches_ledger")
    M["report_gate"] = round(p, 3); M["report_gate_section_found"] = found; save()
    return p

print("converge orchestrator loaded:", ", ".join(["configured_roles", "new_run", "load", "save", "write_brief", "escalate_tier", "jev", "jev_answer",
      "jev_probe", "phi", "progress", "terminal_state", "final_status", "escalation_needed", "validate_reply", "admit_cruxes", "verify_evidence",
      "converge_state", "close_round", "ingest_round", "ingest_falsification", "skip_falsification", "finish", "packet", "spawn_round",
      "register_spawn", "spawn_ids", "peer_messages", "l1_transcript", "expected_for", "expected_judges", "identity_check", "spawn_meta",
      "harvest_costs", "checkpoint", "dossier", "spawn_panel", "validate_verdict", "validate_conference", "panel_verdicts", "panel_aggregate",
      "enable_experiments", "cleanup", "report_gate"]))
```
