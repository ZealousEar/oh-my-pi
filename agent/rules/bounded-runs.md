---
name: bounded-runs
description: Every spawned unit of work (subagent, subprocess, pane, CLI run, background job, service) is finite, observable and fail-fast; the owner's time is the budget.
alwaysApply: true
---

# Bounded runs

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

<critical>
Subagents, eval `agent()`/workpool items, finite `bash` jobs, named bash services, Herdr panes, bash/eval child processes and CLI runs (including omp/ompd/ompdev itself) are the SAME thing here: a work unit that spends the owner's time. Every rule below applies to all of them.
</critical>

## Before launch

- Noninteractive children MUST get closed stdin (`</dev/null`, `stdin=subprocess.DEVNULL`, a finite payload then EOF). NEVER inherit an eval kernel's or harness's open stdin.
- Every unit MUST have a deadline you state before launch. Uncalibrated: 300 s. Repeated comparable items: `max(60 s, 3 × canary duration)`, capped by the batch's remaining deadline. `timeout: 0` / unbounded waits only for declared long-lived services.
- New launch path or configuration → run ONE canary first. Check exit status AND the required result shape (the actual answer, not a last line or spinner) before fan-out.
- Capture stdout, stderr, exit status and duration per unit to a retained file/variable on the FIRST pass. A parsing or inspection mistake → re-read the captured output (or `proc://<id>` / `artifact://<id>`); NEVER re-execute to see it.
- Route by kind. Finite work (scripts, benchmarks, CLI runs, test commands) MUST go through `bash` with `async: true` and a `timeout` (a finite job: the timeout is its deadline, the result auto-delivers), or `task`/workpool for agent work. NEVER launch finite work as a named bash service. Pending Wave 2 (not yet on 18.3): these paths will also carry the no-progress notice (`async.noProgressWarnMs`) and the unpausable wall cap (`tools.wallCapMs`); until they land, your stated `timeout` is the only deadline.
- Named bash services (`bash({name, command, ready})`) are for services only (dev servers, watchers, REPLs, anything that needs stdin via `write proc://<name>`). `ready` (log regex or port, `ready.timeout` ≤ 3600 s) bounds readiness detection ONLY; it is NOT a lifetime: a service runs until you stop it. A service MUST therefore get a stated stop deadline you enforce yourself (`write proc://<name>/kill`). Pending Wave 2: the service `lifetime` control (fork feature being ported onto services) will enforce this at launch; until it lands, the stop step is yours. Pick a name absent from `proc://` first: starting under a live service's name REPLACES that service.
- Pane subagents MUST run in the background, never blocking.

## While running

- NEVER hold the foreground (an eval cell, a non-async bash call) on children for more than 120 s. Launch via `bash async`, `task`/workpool, or a background process writing to a file; keep the deadline. `wait` takes no deadline (it returns on the first result or peer message, or after its 30-min safety cap): call it ONLY when every running child already carries its own `timeout`/stop deadline, record that deadline before waiting, and check it on every wake.
- A child that is slower than its canary by 3× or silent for 60 s → read its captured stderr/log tail ONCE (`proc://<id>` shows a running job's latest output or a service's log) before waiting further. A child printing a waiting-on-input or startup-phase diagnostic is stuck: stop it now.
- Independent items MUST run concurrently within the provider/resource limit (unknown limit: start at 2, raise after successes). NEVER loop sequentially over independent slow items.
- Waits that return do not stop the child, and readiness/auto-backgrounding is not termination. On deadline, stop it explicitly (`write proc://<id>/kill` for a job, task or service; kill the process group for a subprocess) and keep its partial output. `proc://` reads never acknowledge delivery: a result you inspected there still arrives once via auto-delivery or `wait`; treat the two as one completion.

## On the first surprise

- The first unexpected timeout, hang or malformed result FREEZES the batch: no further comparable items launch until the cause is found from the captured evidence.
- A fast success from another launch path (e.g. works in bash, hangs from eval) is evidence of a harness difference: diff the launch conditions (stdin, env, cwd, TTY) before retrying.
- NEVER respond to a timeout by only lowering the timeout and re-running the whole batch.

<critical>
Closed stdin, stated deadline, canary first, capture once, never block >120 s, freeze on the first surprise.
</critical>
