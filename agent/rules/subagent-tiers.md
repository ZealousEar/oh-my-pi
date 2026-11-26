---
name: subagent-tiers
description: Route every subagent spawn to the cheapest tier that can do it, and escalate one tier at a time when it fails; effort is chosen per spawn by auto thinking from solutionSpace.
alwaysApply: true
---

# Subagent tiers and escalation

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

## Tiers (model via `modelRoles`; effort via `auto`, clamped by the profile models.yml ceilings)

| tier | agent | role → model | use for |
|---|---|---|---|
| 1 | `sonic` | `@smol` → Haiku | mechanical edits, data collection, renames, propagation of decided text |
| 2 | `task` | `@task` → Sonnet | normal multi-step work with a known approach |
| 3 | `deep` | `@deep` → Fable (≤ high) | open design, hard debugging with no known cause, anything tier 2 failed |

Read-only exploration stays on `scout`; review stays on `reviewer`. Named specialist agents (converge-*, swarm-*, pp-*, ventures-*) keep their own models and are outside this ladder.

## Routing

- MUST start at the lowest tier whose `use for` matches; a tier is chosen from the task, never from its size.
- MUST write `solutionSpace` honestly: it is the auto-thinking input, so understating it lowers effort.
- MAY start at `deep` only when the cause or design is genuinely open; state why in the brief.

## Escalation (one tier per step, at most two steps per slice)

Escalate when a result shows any of:
- the worker reports `BLOCKED`, `ESCALATE: yes`, or yields without the acceptance evidence the brief named;
- its claimed fix fails the brief's acceptance check when you run it;
- it hit its time box or context cap without converging.

Then:
1. Re-spawn the SAME slice on the next tier up, never the same tier with the same brief.
2. Brief MUST carry the failed attempt: its result path or `agent://<id>`, what failed, and the evidence. The next tier starts from that, not from scratch.
3. `deep` failing is the top of the ladder: report to the owner with both attempts; NEVER loop.
4. NEVER escalate for a failure the brief caused (missing file, wrong path, ambiguous acceptance): fix the brief and retry on the same tier once.

## Effort ceilings (owner rule)

Fable and Astra never above `high`, Opus never `max`, in any role, preset, agent or auto-thinking choice, unless the owner explicitly asks for it in that turn. The profile `models.yml` enforces this by clamping their effort ladders; an explicit request means editing those lines for that run and restoring them afterwards.
