---
description: Update the ompd fork to the latest upstream omp release (fork-sync → fork-check → confirm → fork-release → push)
argument-hint: "[vX.Y.Z]"
---

Carry out the ompd fork update procedure. Target tag: `$ARGUMENTS` if given, otherwise the latest
upstream release. Tooling lives in `~/.omp/profile-layer/launchers/fork/` (`fork-sync`, `fork-check`,
`fork-release`; `STACK.md` lists the fork commits being carried; `must-keep.json` the features that
must survive). The fork checkout is `~/Code/omp-fork`; the release checkout is never edited by hand
outside this procedure. Run every long step with `bash async` and a stated timeout; run `git` only
inside `~/Code/omp-fork` or `~/.omp/profile-layer`.

# Procedure

1. **Target.** `curl -s https://api.github.com/repos/can1357/oh-my-pi/releases/latest | jq -r .tag_name`.
   Compare with the current base: `fork-check --sections probes` prints `on vX.Y.Z`. Already on the latest →
   report that and stop.
2. **Preflight.** `~/Code/omp-fork` must be clean and on the current stack branch (`fork/stack-<base>`).
   `git -C ~/Code/omp-fork fetch --no-tags origin tag <tag>` then `fork-sync --dry-run <tag>`; show the
   commit list that will be replayed.
3. **Sync.** `fork-sync <tag>`. Exit 0 → go to 5. Exit 2 → a real conflict:
   - Resolve it in the checkout: upstream structure/APIs win, the fork feature is fully re-applied on top.
     Evidence: `git show <fork-commit> -- <file>`, `git show <tag>:<file>`, `git log -p <oldbase>..<tag> -- <file>`.
     If upstream now implements the fork feature, keep upstream and drop the fork duplicate — record it.
     Delegate heavy conflicts (relay, browser, task, computer) to `task` subagents, one per commit.
   - Code-mode `declarations.d.ts` style modify/delete conflicts where upstream removed the file: `git rm` it.
   - `git add` the resolved files, `GIT_EDITOR=true git -c rerere.enabled=true -c rerere.autoUpdate=true rebase --continue`,
     repeat until the rebase finishes. Never `--skip` a fork commit.
   - After the rebase: `git branch -m fork/stack-<tag-without-v>` and
     `git branch --set-upstream-to=fork/fork/stack-<tag-without-v>` (create on first push).
4. **Native addon.** `fork-sync` refreshes it on success; after a manual conflict finish, verify the stamp:
   `python3 -c 'import sys; sys.path.insert(0,"~/.omp/profile-layer/launchers/fork".replace("~",__import__("os").environ["HOME"])); import forklib_native as n; print(n.read_stamp("…/packages/natives/native/pi_natives.darwin-arm64.node"), n.expected_version("…/omp-fork"))'`
   — both must print the new version. Otherwise fetch `@oh-my-pi/pi-natives-darwin-arm64@<ver>` from npm,
   verify the tarball sha512 against `npm view … dist.integrity`, and copy the `.node` into place.
5. **Check.** `fork-check --log-dir /tmp/fork-check-<tag>` (timeout 3600 s, async). Every FAIL must be
   explained from its log: a fallout of the port is fixed in the checkout and committed as
   `fix(port): follow-ups after rebasing the fork stack onto <tag>` (a plain commit on top of the stack —
   do NOT autosquash into earlier stack commits); upstream-new tests that need the fork's automation grant get
   `grantBrowserFixtureScope` with their targets; incidental assertions broken by upstream wording changes are
   deleted, not re-pinned. Known environmental failures (headless Chromium rAF never fires on this host,
   `worktree` recursive-submodule test) are reported, not fixed. Re-run until `fork-check: PASS`.
6. **Confirm.** Stop and ask (ask tool) before releasing. Show: target tag, number of upstream commits,
   conflicts resolved per commit, features dropped as upstream duplicates, fork-check result, the new rN
   (previous + 1, read from `channels.json` `channels.ompd.executable`). Proceed only on an explicit yes.
7. **Release.** `fork-release --notes "<one-line summary>" r<N>` (timeout 1800 s, async). It builds, pins,
   relocks, runs `omp-channels --verify` and the must-keep probes through `ompd`. Then smoke:
   `ompd --version`, `ompd gc --json | jq .agentDir`, `ompd models --json | jq -r '.models|map(.provider)|unique'`,
   `ompd config get modelPresets | jq -r 'keys'`. Failure → `fork-release --rollback`, report.
8. **Publish.** `git -C ~/Code/omp-fork push fork fork/stack-<ver>`; tag the previous fork `main` as
   `archive/main-<YYYY-MM-DD>` and push the tag; `git -C ~/Code/omp-fork push --force-with-lease=main:<old-main-sha> fork fork/stack-<ver>:main`;
   `git -C ~/.omp/profile-layer push origin HEAD`. Then `omp-channels --verify` must show `layer … unpushed=0`.
9. **Report.** Versions per channel (`omp`, `ompd`, `ompdev`), rN + sha256, conflict table, dropped
   duplicates, environmental test failures, and the rollback command.

# Never

- Edit `channels.json`, wrappers, `BUILD-MANIFEST.json`, or `~/.omp-channels/fork/*` by hand — `fork-release` owns them.
- Overwrite a pinned executable in place; versioned filenames only.
- Release while `fork-check` fails or the tree is dirty; skip the confirmation in step 6.
- Rewrite stack history below the follow-up commit (rerere resolutions are keyed to it).
