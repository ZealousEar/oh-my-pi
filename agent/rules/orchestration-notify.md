---
name: orchestration-notify
description: Orchestrator↔children workflows push done/blocked/needs-approval/milestone; the orchestrator never polls.
alwaysApply: true
---

# Push state; never poll

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

<critical>
Every orchestrator(n=1)↔children(n≥1) workflow MUST use pushed state, not polling. Select the audience below by assignment, not agent identity.
</critical>

## Worker — spawned by task/workpool, or named a worker in a brief

- MUST push `BLOCKED` immediately with what, why, and what unblocks; `NEEDS-APPROVAL` immediately with decision, options, recommendation. Single-shot subagent (task/agent()/workpool item, any duration): `DONE` = its yield (auto-delivered), NEVER a separate DONE message; spawns expected to exceed 10 min SHOULD push `MILESTONE` at named checkpoints. Persistent workers (Herdr panes, sessions that outlive one assignment) MUST push `MILESTONE` at named checkpoints and `DONE` before their final reply.
- MUST update the brief's status file first when writable. Push `<STATE>: <one line> — see <path>`; keep drafts/evidence in the artifact or structured result.
- Subagent → `write` plain text to `agent://Main` (the receipt reports delivered/failed); Herdr pane worker → `herdr agent prompt <orchestrator-name> '[<worker>] <STATE>: … — see <status-path>'`. Separate pane sessions MUST NOT assume a shared agent registry: `agent://` does not cross them.
- After requesting approval, MUST continue independent work or `wait` for Main's reply / inbound Herdr prompt; `herdr agent wait` only with working lifecycle reporting. `wait` has no sender filter: it returns on the FIRST result or message, so record whose answer you expect, check the delivered `from`, handle or park anything else, and wait again. A settled state is NOT approval. NEVER spin or treat a timeout as consent.
- Failed push (receipt `failed` / `agent_blocked`) → MUST retain it in writable status, continue reachable work, retry once after the next milestone. NEVER retry-loop or withhold the final result.

## Orchestrator — owns children and user gates

- Every brief MUST name your address/channel (registry id for `agent://`, or the Herdr agent name), milestones, time box/deadline, status path (or structured-result location for read-only children), and timeout action.
- After spawning, MUST do independent work or block on `wait`, auto-delivered results, or inbound Herdr prompts. `herdr agent wait <name> --timeout <ms>` is allowed ONLY with working lifecycle reporting.
- NEVER timer-loop `proc://` reads, `agent get`, status reads, or pane/log reads. A `wait` that returns a still-running snapshot (its safety cap) or someone else's message → handle it, then resume event waiting, not inspection.
- MAY perform one start check within 60 s: process exists/output grew; resolved model/effort where applicable. MAY perform one silence check at the brief's time box; then steer, stop, or restart per its timeout action.
- MUST bound waits by the brief's deadline. `wait` carries no caller timeout (first event, or a 30-min safety cap): record the deadline before each wait, check it on every wake, and give every child its own `timeout`/stop step so no wait can outlive the brief. State Herdr timeouts explicitly, capped to remaining time. Deadline reached → execute the timeout action (`write proc://<id>/kill`, pane stop/restart), NEVER wait forever.
- `NEEDS-APPROVAL` → MUST call `ask` for the owner decision, then reply on the same channel (`agent://<worker-id>` or Herdr prompt). NEVER approve by silence; NEVER answer the user through `agent://` writes.

<critical>
Workers MUST push state immediately; orchestrators MUST wait on events, never poll.
</critical>
