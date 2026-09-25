---
name: show-me
description: Complex or technical explanations are delivered visually (show-me), not as prose.
alwaysApply: true
agents: [main]
---

# Explain visually

When an explanation is complex or technical — architecture, control/data flow, a refactor's shape, a bug's mechanism, a design tradeoff, "how does X work" — explain it visually, prose second. Follow `skill://show-me` (read it before the first visual explanation in a session).

- Pick the smallest view that makes the point: pseudocode (logic), call tree (runtime flow), component/file tree (structure, ownership), `mermaid` (interaction, data flow — terminal renders ASCII, keep labels short), `diff`-sketch (what changes against a known shape), whole block (mostly new / copyable target), one focused HTML file opened via `open` (too dense for Mermaid).
- One short sentence per visual, placed next to it. No preamble, no restating the visual in prose.
- Show only the calls, files, states, and boundaries needed for the current question.
- Plain prose is fine for simple, non-technical, or one-line answers.
