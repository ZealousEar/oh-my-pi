# omp profile layer (`profile/daily-fork`)

Personal configuration layer for the fork channels of [oh-my-pi](https://github.com/can1357/oh-my-pi):
`ompd` (profile `daily-fork`) and `ompdev` (profile `dev-fork`). Stock `omp` shares only `models.yml`.
This branch has no code history; it is not meant for upstream.

```
agent/skills/       skills (converge, decision-writing, grill-me, herdr-round, …)
agent/agents/       agent definitions (converge debaters/judges, pr-writing)
agent/rules/        always-on rules (orchestration-notify, grill-first, show-me)
agent/extensions/   herdr-omp-agent-state.ts (Herdr-managed; reinstall overwrites)
agent/models.yml    OpenRouter routing for converge judges; Featherless provider
config/fork-overlay.yml   PI_CONFIG_FILES overlay: converge roles, fallback chains, jev, skill sources
launchers/          channel wrappers, install.sh, profile-seed (this machine's paths)
sync/               daily commit + push (launchd ai.omp.profile-layer-sync)
```

## How it is wired

- Checkout: `~/.omp/profile-layer`. Each profile entry (`~/.omp/profiles/<p>/agent/{skills,agents,rules,extensions}/<name>`, `models.yml`) is a symlink into it, so editing either side edits git.
- `ompd`/`ompdev` load `config/fork-overlay.yml` first in `PI_CONFIG_FILES`; the launcher policy overlays load after it and win. The wrappers refuse to start if the overlay is missing.
- `launchers/install.sh` (reached through symlinks in the launcher dir) recreates every link, prunes links to removed entries, and installs the sync job. `omp-channels` reports the layer's link health, uncommitted/unpushed counts and the last sync.
- `sync/profile-sync.sh` runs daily at 04:20: `git add -A`, a credential scan over added lines (a hit blocks the commit and is reported by `omp-channels`), commit, rebase if needed, push. Status: `~/.omp/profile-layer-sync/status.json`.

## New machine

```sh
git clone -b profile/daily-fork --single-branch https://github.com/ZealousEar/oh-my-pi.git ~/.omp/profile-layer
# then restore the launcher dir symlinks (wrappers, install.sh, profile-seed) and run install.sh
```

Secrets never live here: provider keys are on the shared credential authority or in the macOS Keychain
(`models.yml` reads Featherless's key with `!security find-generic-password -s featherless-api-key -w`).
