---
name: pr-writing
description: Use when writing or editing a pull request title or body, or a long-form commit body. Reviewer-first shape — visual summary, before/after evidence, merge danger.
---

# Writing a PR body / title

Goal: make human review as fast and simple as possible. The reviewer wants four answers — what changed, why, does it work, what could go wrong — and the diff already answers the first two badly. Don't write essays. Skip preambles. Bullet points for the little prose you do write. Use the project's own domain language (from `CONTEXT.md` when one exists; otherwise the names the code uses).

Only the final aggregate squash-merge state matters. Never mention intermediate PR history (size went from +6k to +1k, split from one commit into three, rebased, etc.).

## Template

```markdown
## Summary

<one or two bullets: what + why, from the originating issue/spec, not from re-reading the diff>

<diagram, diff-sketch, or tree>

## Evidence

- **Before:** <screenshot / output / failing test run>
  **After:** <screenshot / output / passing test run>

## Merge Danger

**Door:** <one-way or two-way>

<optional: one line why>

**Blast Radius:** <one-word description>

<optional: potential ramifications of merge>
```

Add a `## Left out` section only when something an attentive reviewer would expect was deliberately not done (and say why).

## Summary

Pick the smallest visual that makes the key point clear. Views, from `skill://show-me`:

- **pseudocode** — logic or an algorithm.
- **call tree** — runtime control flow.
- **component tree** — UI structure with the state/module boundaries that matter.
- **shallow file tree** — file responsibility or a broad refactor.
- **mermaid** — component interaction, control flow, data flow (`sequenceDiagram`, `flowchart`, `stateDiagram`).
- **`diff` sketch** — when the point is what changes and the surrounding shape already exists; match the diff shape to the topic (component / file-layout / call-tree / control-flow). This is usually the best choice for a PR.
- **whole block** — when most of it is new, when omitted context would hide ownership or order, or when the reader needs a copyable target shape.

Example diff-sketch of a control-flow change:

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write new content
+  invalidate cache
```

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to understand the change. One or two views is normal; all of them is wrong. Code refs (`path:line`) are welcome.

## Evidence

Concrete proof the change works, as a **before / after** pair.

- **S-tier: screenshots or short videos** — for anything visual, directly or indirectly. Present as a two-column table (Before | After) with the uploaded images.
- **A-tier: execution output** — the exact test that failed before and passes after (name it, show the relevant lines, pseudocode is fine), console output, a reproduction script's output.
- **Benchmarks** — always a table of before/after: baseline from the target branch, candidate from the PR.

A green run that tests nothing is not evidence; show *which* behavior the run proves. Never write "ran tests" / "validation passed" as prose — either show the evidence or leave the section out.

## Merge Danger

- **Door**: two-way if the PR is cheap to roll back (revert and you're done); one-way if it involves destructive actions, migrations, data/format changes, published APIs, or anything hard to reverse. Say which and, when one-way, why.
- **Blast Radius**: the potential scope of impact if it's wrong — one word (e.g. `none`, `local`, `consumers`, `layout`, `mobile`, `data`, `auth`, `all-users`), then optionally one line of ramifications: consumers that break, layout shift, mobile responsiveness, performance, security surface.

## Long-form

For truly impressive, difficult, or high-risk/wide-scope changes the body may read like a short technical blog: context, the storytelling of the design, code samples, before/after visuals — still inside the template above, still no intermediate PR history.

Credits: template from Matt Pocock's `/pr` (https://github.com/mattpocock/skills); visual views from Dex Horthy's `/show-me` (https://github.com/humanlayer/skills).
