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
- Subagent → `hub send` to `Main`; Herdr pane worker → `herdr agent prompt <orchestrator-name> '[<worker>] <STATE>: … — see <status-path>'`. Separate pane sessions MUST NOT assume a shared hub.
- After requesting approval, MUST continue independent work or wait for Main's reply: `hub wait from:Main` / inbound Herdr prompt; `herdr agent wait` only with working lifecycle reporting. A settled state is NOT approval. NEVER spin or treat a timeout as consent.
- Failed push (`failed` / `agent_blocked`) → MUST retain it in writable status, continue reachable work, retry once after the next milestone. NEVER retry-loop or withhold the final result.

## Orchestrator — owns children and user gates

- Every brief MUST name your address/channel, milestones, time box/deadline, status path (or structured-result location for read-only children), and timeout action.
- After spawning, MUST do independent work or block on `hub wait`, auto-delivered results, or inbound Herdr prompts. `herdr agent wait <name> --timeout <ms>` is allowed ONLY with working lifecycle reporting.
- NEVER timer-loop `hub jobs`, `agent get`, status reads, or pane/log reads. Empty wait wake → resume event waiting, not inspection.
- MAY perform one start check within 60 s: process exists/output grew; resolved model/effort where applicable. MAY perform one silence check at the brief's time box; then steer, stop, or restart per its timeout action.
- MUST bound waits by the brief's deadline. `hub wait` windows grow 5 s→5 min; check the deadline on wake. State Herdr timeouts explicitly, capped to remaining time. Deadline reached → execute the timeout action, NEVER wait forever.
- `NEEDS-APPROVAL` → MUST call `ask` for the owner decision, then reply on the same channel. NEVER approve by silence; NEVER send user answers through hub.

<critical>
Workers MUST push state immediately; orchestrators MUST wait on events, never poll.
</critical>
