# omp profile layer (`profile/daily-fork`)

Personal configuration layer for the fork channels of [oh-my-pi](https://github.com/can1357/oh-my-pi):
`ompd` (profile `daily-fork`) and `ompdev` (profile `dev-fork`). Stock `omp` shares `models.yml` and explicit cross-channel commands, not the fork's general skill/extension set.
This branch has no code history; it is not meant for upstream.

```
agent/skills/       skills (converge, decision-writing, grill-me, herdr-round, …)
agent/agents/       agent definitions (converge debaters/judges, pr-writing)
agent/rules/        always-on rules (orchestration-notify, grill-first, show-me)
agent/extensions/   Herdr state hook and packaged native OpenCode delegation
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

## Native free-model delegation

Restart `omp` or `ompd` after installing the extension, then run one of these commands.

```text
/opencode-free deepseek <task>
/opencode-free glm <task>
/opencode-free cancel
```

The command starts a fresh [OpenCode ACP session](https://opencode.ai/docs/acp/) in the current workspace. OpenCode owns the delegated tools and history; omp displays streaming progress, tool outcomes and the final response without starting a primary-model turn. Existing model roles and presets stay unchanged.

Approve native actions in omp's one-action confirmation prompts. Ctrl-C cancels, including while approval is pending. Each run has a five-minute deadline that includes startup and approval waits, followed by bounded cleanup. Session switches and shutdown cancel and await the owned native process. The command leaves no persistent server.

The child receives an allowlist of runtime environment variables, not inherited trading keys or provider-key variables. OpenCode can still read its own on-disk configuration/auth and files you approve. This is not an OS sandbox.

The command pins `opencode/deepseek-v4.1-flash-free` or `opencode/glm-5.3-flash-free`, restricts the native provider's model roster to that selection, and pins maintenance agents to it. It does not select a paid fallback or forge an OpenCode client header. Free endpoint availability remains subject to OpenCode's service policy. Denying/removing native read/shell tools can cause a misleading `FreeTierError` even inside OpenCode; [upstream issue #51241](https://github.com/anomalyco/opencode/issues/51241) documents that failure. The bridge keeps native tools with approval required.

The package uses the official ACP SDK because stock omp does not expose the fork's internal ACP client package. Install its locked dependencies before running the channel installer.

```sh
bun install --cwd ~/.omp/profile-layer/agent/extensions/opencode-free --frozen-lockfile --ignore-scripts
```

Verification covered real TUI responses in stock omp 18.6.1 and ompd 18.11.2 with OpenCode 1.19.3, an approved write, a rejected write with no file created, Ctrl-C during approval, the explicit cancel command, a native startup-deadline smoke, and shutdown during native streaming with no surviving owned ACP child. `bun test` in the package covers credential filtering and fail-closed permission decisions.

## New machine

```sh
git clone -b profile/daily-fork --single-branch https://github.com/ZealousEar/oh-my-pi.git ~/.omp/profile-layer
bun install --cwd ~/.omp/profile-layer/agent/extensions/opencode-free --frozen-lockfile --ignore-scripts
# then restore the launcher dir symlinks (wrappers, install.sh, profile-seed) and run install.sh
```

Secrets never live here: provider keys are on the shared credential authority or in the macOS Keychain
(`models.yml` reads Featherless's key with `!security find-generic-password -s featherless-api-key -w`).
