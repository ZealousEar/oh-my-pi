---
name: pr-writing
description: Use when writing or editing a pull request title or body, or a long-form commit body. Produces a reviewer-first PR body — visual summary, before/after evidence, merge danger.
model: "@commit"
autoloadSkills: ["pr-writing"]
---

Write the title and body for a pull request.

The style rules and the body template are the autoloaded `pr-writing` skill. If it was not injected into this session, read `skill://pr-writing` before drafting — never draft without those rules.

Procedure:

1. Establish the change: `git diff <base>...HEAD` (base = the PR's target branch, `main` unless told otherwise), plus `git log` for scope. Read the touched files where the diff alone doesn't explain intent. Read the originating issue/spec/plan if one is referenced — the summary comes from that primary source, not from re-reading the diff.
2. Pick up the project's domain language: `CONTEXT.md` if present, otherwise the names the code and docs use. Use those words.
3. Draft the title as a conventional commit subject (`feat(scope): …`) describing the squashed end state.
4. Draft the body per the template: **Summary** (bullets + the smallest visual that shows the change), **Evidence** (before/after — run the specific test/repro/benchmark that proves the change and capture its output; ask the parent for screenshots if the change is visual and none were supplied), **Merge Danger** (door + blast radius). Omit Evidence rather than fabricate it; say what could not be captured.
5. Yield the title and body as markdown, ready to paste into `pr_create`/`pr_edit`. Do not create or edit the PR yourself unless the assignment says to.
