---
name: github
description: Commits are reported with their pushed/LOCAL ONLY status; pushes happen only on explicit request and only through the code-sweep gate; agent worktrees get named branches; GitHub-facing prose goes to the pr-writing agent.
alwaysApply: true
---

# GitHub: commit, push, worktrees, writing

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

A commit is not a push. Work that is committed but never pushed has sat unseen for weeks, while the agent reported it as "committed". This rule keeps the difference visible.

## 1. Reporting a commit

- Every report of a commit MUST state where it is. Quote the status line that eval `commit` prints (`LOCAL ONLY: N commits on <branch> not on <ref> …` or `PUSHED: …`). After a plain `git commit`, run `git rev-list --count HEAD --not --remotes` and report `LOCAL ONLY: N commits not on any remote` when N > 0.
- NEVER say or imply that work is "on GitHub", "saved", "synced" or "done" when the status is LOCAL ONLY.

## 2. Pushing

- NEVER push unless the user explicitly asks for it in this conversation ("push", "push to gh", "sync to gh", "save to gh", or similar). Committing, even "commit everything", is not a request to push.
- When asked, push ONLY through the gate: `~/.omp/profile-layer/bin/code-sweep push --repo <path> [REF…]`. It refuses to run without `--yes`, which you pass only on that explicit request. It scans the outgoing range with gitleaks, checks blob sizes and secret-looking paths, fails closed, and never force-pushes. NEVER use bare `git push`, `git push --force` or `gh repo sync`.
- When the gate blocks a ref, report the reason it printed and stop. NEVER work around it by editing history, bypassing hooks, or pushing by hand.
- Creating a GitHub repository (`code-sweep sweep --create-remote <repo>`, `gh repo create`) needs its own explicit confirmation, and the repository MUST be private.

### Public repos

Anyone can read a public repo, and a push there can't be taken back. This includes the profile layer and omp-fork, which push to the public `ZealousEar/oh-my-pi`.

- Before any push to a public repo, run `code-sweep push --repo <path> [--remote NAME] <branch> --dry-run` and show the user the whole **PUBLIC PUSH PREVIEW** it prints: repo URL and visibility, target branch, commit subjects, changed files, GitHub Pages and `.github/workflows/` warnings, and the public gate result.
- Pass `--allow-public` (together with `--yes`) only after the user has confirmed in this conversation that they have seen the preview and know the repo is PUBLIC. Get a separate confirmation for each repo and each branch. Approval for a private push or an earlier preview doesn't count.
- The public gate is stricter and is a hard block: blobs over 10 MB; archives, databases, dumps, logs and IDE/agent state (`.cursor/`, `.claude/`, `.obsidian/`, `.omp/`); local home paths and private vault paths in added lines. gitleaks findings always block, and reviewed ignores are never applied. Fix the content and show a new preview. NEVER bypass the gate.
- Bulk `sweep --apply --include-public` never pushes scratch branches (`wt/*`, `rescue/*`, `wip/*`, `worktree-*`) or `cursor: empty commit` commits. Each of those needs its own preview, confirmation, and `push --allow-public --yes <branch>`.

## 3. Worktrees for campaigns, hill-climbs and lanes

- Create them on a named branch: `git worktree add -b wt/<name> <path> <start>`. NEVER use `--detach` for work that may produce commits. A detached worktree is only for a throwaway read-only look under the temp dir.
- Name sibling-checkout branches after the checkout (`wt/<checkout-name>`) so two lanes never share a branch name.
- Every commit report from a worktree includes its status line (section 1). The branch gets an upstream when the user asks to push, through the gate.

## 4. GitHub-facing writing

- All prose written for GitHub MUST be delegated to the **`pr-writing` agent** (`task` with `agent: "pr-writing"`). That agent runs on the **`@pr-writing` model role** and autoloads `skill://pr-writing`. This covers PR titles and bodies, long-form commit bodies, READMEs, issues and issue comments, release notes, and repo docs written for GitHub readers.
- NEVER draft that prose inline on another model role. Give the agent the target (PR, README path, issue, release), the source material (diff range, issue, spec, changelog section) and whether it should write the file or yield markdown.
- Posting is a separate step. Before posting a comment, creating an issue or editing a PR, show the target and the text and get the user's confirmation.
