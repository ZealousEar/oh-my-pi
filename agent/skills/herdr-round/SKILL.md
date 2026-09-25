---
name: herdr-round
description: Plan and run a multi-agent plan+implement round in Herdr panes. You propose the team once (panes, agent kind, model, effort, owned files, done-when) and the user approves or edits it; then you start the workers, coordinate them through contract, brief and status files, wait on Herdr agent states, integrate on one branch, verify and open a PR. Use when the user says "herdr round" or asks to plan and implement with several agents in Herdr.
---

# Herdr round

A round is one goal split across worker agents in Herdr panes, with you as the only integrator. The user gives:

```text
Herdr round: <goal>.
Done means: <acceptance>.
Limits: <time / model spend>, <anything off-limits>.
```

"your call on the team" skips the plan gate. "max N panes", "reviewer must be <kind>" or "model X for Y" pin a choice.

## 0. Preconditions

- `test "${HERDR_ENV:-}" = 1`. If this fails, do not touch the user's focused session. Either ask the user to start `herdr` in Ghostty or cmux, run `ompd` inside a pane and give the round prompt there, or run the round in an isolated named session you own (verified 2026-09-24):
  1. `hub start` `herdr --session <round> server` (persist on);
  2. drive it with `herdr --session <round> <group> …`;
  3. the user watches with `herdr session attach <round>`.
- Read `skill://herdr`. The installed `herdr` binary is the authority on command syntax: run `herdr pane`, `herdr agent` or `herdr worktree` for group help, and never run bare `herdr`.
- Read the repo's agent rules (AGENTS.md or `.omp/AGENTS.md`). They override this skill: toolchain, who may push or merge, and which checks count.

## 1. Plan (you, not a planning agent)

- Map the goal into slices that own disjoint files. A slice that needs another slice's output gets a written contract (the interface, the output format, and which outcome means what) before anyone starts. The most expensive failure seen so far was a worker blocked for an hour on another worker's outputs, because that contract was implicit.
- Pane count = the number of independent slices, usually 3–4. Limits:
  - Two slices that edit the same file become one slice.
  - Anything that measures time or CPU runs alone in one pane. Concurrent workers and batches inflated OCR timings 2–4× in the speed round.
- Default team by role (propose this; the user may change it):

  | Role | Agent | Model · effort |
  |---|---|---|
  | Subtle logic (algorithms, parsing, timing, concurrency) | ompd | strongest model · high |
  | Tools, harnesses, capture, measurement | ompd | strongest model · medium |
  | Mechanical edits (renames, docs, formatting) | ompd | fast model · low |
  | Review (read-only, after integration) | codex or claude | different model family · high |

  Use ompd for implementation because the repo's `.omp/` extensions and LSP config load only in omp/ompd. `xhigh`/`max` are not worth it for routine work: `max` took about 8× as long as `high` with no accuracy gain in the one bench that measured it.
- Give every worker a model-request cap and an explicit "owns" list.

## 2. Plan gate (one `ask` call)

Unless the user said "your call on the team", ask once. The question text carries the proposal as a table:

| Pane | Agent | Model · effort | Owns | Done when |
|---|---|---|---|---|

- Options: approve (recommended), fewer panes (merged slices named), a different model or effort per role, and anything else still genuinely open.
- Ask only about decisions the repo cannot answer.
- After approval, do not re-ask.

## 3. Files

Keep the round's state in files the user can read, next to the worktrees and outside the repo:

- `<round>/CONTRACT.md`:
  - the goal, the base commit, and the evidence that motivated the round;
  - the worker table (worktree, branch, owns);
  - the contracts;
  - acceptance;
  - rules for every worker: toolchain, no push, no PR, no merge; headless or no-UI constraints; request caps; "messages from Main are steering";
  - MUST notify `main` (`herdr agent prompt main '[<name>] <STATE>: …'`) immediately at DONE / BLOCKED / NEEDS-APPROVAL / named MILESTONE, per `rule://orchestration-notify`; status file first.
- `<round>/brief-<worker>.md`: Target, Change, Acceptance. Include exact files and symbols, what to read first, non-goals, and the evidence to produce. Name the real frames, fixtures or data to test on. MUST name orchestrator address `main`, the Herdr prompt channel, named milestones, time box/deadline, timeout action, and status path.
- `<round>/status/<worker>.md`, kept by the worker: done / in progress / blocked / evidence (commands and results) / "Needs from others" / final plain-language summary. NEEDS-APPROVAL MUST include decision, options, recommendation.
- One worktree per worker, off the base branch, plus one integration worktree for you. Follow repo conventions for shared toolchains: symlink them, and APFS-clone the build dir (`cp -cR`) so no worker builds from scratch.

## 4. Start the workers

Before launching workers, MUST name the orchestrator: `herdr agent rename "$HERDR_PANE_ID" main`. For an isolated named session, target its actual orchestrator pane instead; NEVER rename an unrelated focused pane.

For each worker:

```bash
herdr pane split --current --direction right --cwd <worktree> --no-focus   # alternate right/down; read .result.pane.pane_id
herdr pane run <pane_id> "~/.local/bin/ompd --model <model> --thinking <effort>"
herdr agent get <pane_id>   # MUST report agent omp before prompting
herdr agent rename <pane_id> <name>
herdr agent prompt <name> "You are worker <name> in a team orchestrated by Main. Read <round>/brief-<name>.md (it points to <round>/CONTRACT.md) and carry it out end to end in <worktree>. Keep <round>/status/<name>.md current. Report to agent main via herdr agent prompt main '[<name>] <STATE>: … — see <round>/status/<name>.md' immediately at DONE / BLOCKED / NEEDS-APPROVAL and every milestone in your brief; if that returns agent_blocked, update your status file and retry once after the next milestone."
```

- `agent start --kind omp` launches PATH `omp` = `~/.local/bin/omp`, the stock channel (profile `stock`), not ompd. Start fork workers with the wrapper launch above.
- Detection: the channel wrappers present argv0 `omp` when `HERDR_ENV=1` (`exec -a omp`, same as ompdev and upstream `scripts/omp`). If `agent get` does not report `omp`, inspect `herdr pane process-info --pane <pane_id>` (argv0 MUST be `omp`) and `herdr agent explain <pane_id>`.
- State reporting: the daily-fork profile has Herdr's omp integration installed (`extensions/herdr-omp-agent-state.ts`, v8; inert unless `HERDR_ENV=1`). `agent get` then shows `agent_session.source: herdr:omp` and `agent explain` shows `screen_detection_skip_reason: full_lifecycle_hook_authority`; if instead it shows `manifest: none` + `default_known_agent_idle_fallback`, the extension is not loading and `agent prompt --wait` will fail with `agent_prompt_stalled`. Check with `env PI_CODING_AGENT_DIR=$HOME/.omp/profiles/daily-fork/agent herdr integration status` (the `omp:` line). `herdr integration install omp` refuses when `PI_CODING_AGENT_DIR` is set (Pi and OMP resolve to the same dir); reinstall/update by running it under a temporary `HOME` with `$HOME/.omp/agent/extensions` pre-created, then copy the file into the daily-fork `extensions/`. Stock `omp` and legacy have no integration.
- Verified 2026-09-24:
  - `pane split`, `pane run`, `pane wait-output --regex`, `pane read --source recent-unwrapped` and `pane rename` all work against a named session.
  - A `pane run` sent right after `pane run … clear` can land on the prompt without its Enter: the text sits there unexecuted, and nothing reports it (this cost 45 minutes). After starting a long job, check that its process exists (`pgrep`, or `pane process-info` shows it in the foreground) and send `pane send-keys <pane> enter` if not.
  - End each `pane run` command with `; echo "=@=$?"` and wait on the regex `=@=\d+`. The command line itself never matches, and you get the exit code.
  - `agent start --kind codex` stops at codex's "trust this directory" dialog. Answering it writes to `~/.codex/config.toml`, and a `-c projects…trust_level` override does not satisfy it. Instead run `codex exec --skip-git-repo-check -s workspace-write -c model_reasoning_effort=high -o <reply.txt> "<prompt>"` in a plain pane, and continue later with `codex exec resume <session-id>`.
  - Keep tmux workers from an earlier launch rather than restarting them. Show them in Herdr panes as read-only grouped sessions:
    1. `tmux new-session -d -t <sess> -s <view>`, then `select-window -t <view>:<win>`;
    2. `tmux attach -r -t <view>` in the pane.
- Verified 2026-09-24 (isolated session): installed `ompd` and stock `omp` wrappers both detected as agent `omp` (argv0 `omp`). Without the integration: state stuck at `idle`, `agent prompt --wait` stalled. With it (ompd): `agent prompt --wait` returned exit 0 in 3 s after the reply, `state_change_seq` 1 → 3 (working → idle).
- Still unverified: `agent start --kind omp`; `blocked` reporting at an ask dialog.

## 5. Coordinate

- MUST follow `rule://orchestration-notify`: block on inbound worker prompts, or, ONLY with working lifecycle reporting (§4), `herdr agent wait <name> --timeout <ms>` (all workers, in turn). It returns at `idle`, `done` or `blocked`; read `status/<name>.md` on that event, not on a timer. A settled state alone does not prove completion.
- MUST state each wait timeout, capped to the assignment's remaining time box. Timeout without an event → resume event waiting; at the time box, perform the single silence check below. Without lifecycle reporting, rely on pushed worker prompts, NEVER `agent wait` or `agent prompt --wait`.
- `blocked` means an approval or question UI. Read it with `herdr agent read <name> --source recent`. Resolve it only if it is within the worker's brief; owner decisions and NEEDS-APPROVAL MUST go through `ask` with options + recommendation, then reply to the worker via Herdr (use the UI's input path if `agent prompt` returns `agent_blocked`). NEVER treat timeout/silence as approval.
- Route "Needs from others" yourself with `herdr agent prompt <name> "[Main] …"`. Workers never edit each other's files. If one worker needs another's branch for an end-to-end measurement, tell it to merge that branch into its own.
- While workers run, do integration prep (fast-forward the integration branch, draft docs), not idle polling.
- Backstops, not polling. In the 2026-09-24 round, 2½ hours were lost this way: a reviewer command sat unsent for 45 minutes, and a worker ran 1¾ hours without a status update or a commit. So:
  - **One start check (within 60 s).** After starting any agent, command or one-shot run, confirm its process exists (`pgrep`, or `pane process-info`) and that its output (log file or pane text) has grown. Combine this with §4's agent detection check; NEVER add recurring checks. If not, read the pane. Text left on the prompt needs `pane send-keys <pane> enter`; a dialog goes back to the user or gets a workaround.
  - **One-shot completion.** Tee to a log and block on process exit or the log's end marker, not only on a pane regex. MUST use a stated timeout bounded by the assignment's time box; no log-growth polling.
  - **Single silence check.** At the assignment's time box, if no DONE/BLOCKED push arrived, read status/pane once and decide: steer, interrupt the stuck step, or restart per the brief's timeout action. A restart starts a fresh agent on the same brief, status file and branch, so little is lost. NEVER run 15/30-minute heartbeats or repeated status checks.
  - **Checkpoints.** Each assignment has a time box of about twice its estimate. At the box, the worker commits what passes and updates its status. Size tasks so that losing one session costs at most about 30 minutes.
  - **No agent for small fixes.** A change to one function in one file, or a single run, is done inline. It costs no session, and there is nothing to watch.

## 6. Integrate and verify (you)

1. Merge the worker branches into the integration branch in dependency order.
2. Apply the files you own: README, plan docs, and any cross-cutting change a worker requested.
3. Run the repo's full check (`just verify` or equivalent) and the acceptance runs from CONTRACT.md. Compare against the before numbers. Measurements run one at a time.
4. Verify every worker claim you repeat. `completed` means the worker stopped, not that its work is right.
5. Push the branch and open the PR, using the repo's PR-writer agent if it has one. Record verified facts and what was not checked; the user approves merges.

## 7. Report and clean up

- Tell the user:
  - what changed;
  - the numbers against the before numbers;
  - what was not verified;
  - the decisions still theirs;
  - how to watch or attach (`herdr session attach <name>`).
- After the user merges: close the worker panes (`herdr pane close <pane_id>`), and remove the worktrees and branches you created. Keep the round's CONTRACT and status files unless the user says otherwise.
