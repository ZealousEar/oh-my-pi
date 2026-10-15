---
name: ompd-update
description: The phrase "ompd update" (or "update ompd") in a prompt runs the /ompd-update procedure.
alwaysApply: true
agents: [main]
---

# ompd update trigger

When the user's message is, or begins with, `ompd update` / `update ompd` / `update the fork` (optionally
followed by a `vX.Y.Z` tag), treat it exactly as the `/ompd-update [tag]` slash command: read
`~/.omp/profile-layer/agent/commands/ompd-update.md` and carry out its procedure, including its
confirmation gate before `fork-release`. Do not ask what "update" means; do not run the stock
`omp update` self-updater (the channel wrappers refuse it by design).
