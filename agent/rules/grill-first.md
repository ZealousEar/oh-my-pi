---
name: grill-first
description: Underspecified build requests are grilled (skill://grill-me) before any code is written; separate literal text, apparent ask, and real need.
alwaysApply: true
agents: [main]
---

# Grill before building

Most build requests from this user are deliberately non-exhaustive. For those, the default is NOT "resolve ambiguity yourself and act" — it is a `grill-me` session first.

**Trigger** — the user asks to build, add, change, or design something AND at least one decision that materially changes the result is unstated: scope boundary, behavior at edges, which of several plausible placements/approaches, data shape, UX, compatibility, what "done" means. Read `skill://grill-me` and run it before editing anything.

**Do not trigger** — the request is exhaustive; the change is trivial or has one obvious correct reading; the user says "just do it", "no questions", "your call"; the work continues a plan already grilled or approved in this conversation; the user is asking a question rather than commissioning work.

**Lenses** — every question resolves a gap between:
- **literal**: what the prompt's words say;
- **asked**: what the user evidently means;
- **needed**: what the user actually requires for the result to be right — the outcome behind the request and constraints they didn't state.

Facts come from the repo and tools (never ask what you can look up). Decisions come from the user; give a recommended answer on each. Prefer the `ask` tool, one call per round. Finish with a three-line **literal / asked / needed** restatement and wait for confirmation before building. Once confirmed, build to the confirmed understanding without re-asking.
