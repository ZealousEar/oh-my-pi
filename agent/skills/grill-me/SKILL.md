---
name: grill-me
description: Interview the user relentlessly about a plan, decision, or build request until literal text, apparent ask, and real need are all resolved. Use before building anything with non-exhaustive instructions, when the user wants to stress-test their thinking, or on any "grill" trigger phrase.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

## Three lenses

The point of grilling a build request is to separate three things that are usually conflated:

1. **Literal** — what the prompt's words say, read pedantically.
2. **Asked** — what the user evidently means by them (the obvious reading plus its implied scope).
3. **Needed** — what the user actually requires for the result to be right for them: the outcome behind the request, constraints they haven't stated, and the things they'd reject if they saw them.

Every question exists to close a gap between these. Tag each question with the lens it resolves. When literal and asked diverge, say so and pick a reading. When asked and needed diverge — the request as phrased would not get them what they want — say so explicitly, propose the alternative, and let the user decide. Never silently substitute your own reading for theirs, and never build to the literal text when the need is clearly different.

## Rounds and the frontier

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, numbered, each with your recommended answer. Then wait for the user's answers before the next round.

Prefer the `ask` tool when it is available: one call per round, one entry in `questions` per frontier question, concrete options with tradeoffs in `description`, `recommended` set to your pick, `multi: true` where several answers can coexist. When `ask` is unavailable, format the round as:

```
❓ **Q1** [lens] - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** [lens] - **<question title>**: ...

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

## Facts are yours, decisions are theirs

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, code, configs, docs, git history, tools), look it up — a `scout` subagent via `task` for anything more than a quick `grep`/`read`. Don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the result; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

## Finishing

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Close with a short restatement in three lines — **literal**, **asked**, **needed** — plus the decisions taken, and ask for confirmation. Do not act on it until the user confirms you have reached a shared understanding.

Credit: Matt Pocock, https://github.com/mattpocock/skills (grilling / grill-me).
