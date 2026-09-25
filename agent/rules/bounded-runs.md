---
name: bounded-runs
description: Every spawned unit of work (subagent, subprocess, pane, CLI run, background job) is finite, observable and fail-fast; the owner's time is the budget.
alwaysApply: true
---

# Bounded runs

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

<critical>
Subagents, eval `agent()`/workpool items, hub processes, Herdr panes, bash/eval child processes and CLI runs (including omp/ompd/ompdev itself) are the SAME thing here: a work unit that spends the owner's time. Every rule below applies to all of them.
</critical>

## Before launch

- Noninteractive children MUST get closed stdin (`</dev/null`, `stdin=subprocess.DEVNULL`, a finite payload then EOF). NEVER inherit an eval kernel's or harness's open stdin.
- Every unit MUST have a deadline you state before launch. Uncalibrated: 300 s. Repeated comparable items: `max(60 s, 3 × canary duration)`, capped by the batch's remaining deadline. `timeout: 0` / unbounded waits only for declared long-lived services.
- New launch path or configuration → run ONE canary first. Check exit status AND the required result shape (the actual answer, not a last line or spinner) before fan-out.
- Capture stdout, stderr, exit status and duration per unit to a retained file/variable on the FIRST pass. A parsing or inspection mistake → re-read the captured output; NEVER re-execute to see it.
- Route by kind. Finite work (scripts, benchmarks, CLI runs, test commands) MUST go through `bash` with `async: true`, or `task`/workpool for agent work; those paths carry the no-progress notice and the wall cap. NEVER launch finite work through `hub start`, except as below.
- `hub start` is for services only (dev servers, watchers, REPLs). Finite work that genuinely needs hub (e.g. it needs `hub send` input) MUST set `lifetime`.
- Pane subagents MUST run in the background, never blocking.

## While running

- NEVER block the foreground (an eval cell, a bash call, a `hub wait`) on children for more than 120 s. Launch via `bash async`, `task`/workpool, or a background process writing to a file; keep the deadline.
- A child that is slower than its canary by 3× or silent for 60 s → read its captured stderr/log tail ONCE before waiting further. A child printing a waiting-on-input or startup-phase diagnostic is stuck: stop it now.
- Independent items MUST run concurrently within the provider/resource limit (unknown limit: start at 2, raise after successes). NEVER loop sequentially over independent slow items.
- Background waits that expire do not stop the child. On deadline, stop it explicitly (`hub stop`, `cancel`, kill the process group) and keep its partial output.

## On the first surprise

- The first unexpected timeout, hang or malformed result FREEZES the batch: no further comparable items launch until the cause is found from the captured evidence.
- A fast success from another launch path (e.g. works in bash, hangs from eval) is evidence of a harness difference: diff the launch conditions (stdin, env, cwd, TTY) before retrying.
- NEVER respond to a timeout by only lowering the timeout and re-running the whole batch.

<critical>
Closed stdin, stated deadline, canary first, capture once, never block >120 s, freeze on the first surprise.
</critical>
