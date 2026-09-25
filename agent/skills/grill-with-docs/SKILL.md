---
name: grill-with-docs
description: Grilling session that also builds the project's domain model — sharpens terminology and updates CONTEXT.md and ADRs inline as decisions land. Use when a plan or design touches domain concepts, or the user says "grill with docs".
---

Run two skills together for this session:

1. Read `skill://grill-me` and run the interview exactly as it describes (design tree, rounds, frontier, three lenses, recommended answers, facts from the environment not the user).
2. Read `skill://domain-modeling` and apply it inside every round: challenge terms against `CONTEXT.md`, sharpen fuzzy language into canonical terms, stress-test relationships with concrete scenarios, cross-check claims against the code, and update `CONTEXT.md` (glossary only) the moment a term is resolved. Offer an ADR only when the decision is hard to reverse, surprising without context, and the result of a real trade-off.

Use the project's canonical terms (from `CONTEXT.md`) in every question, recommendation, and the closing restatement.

Credit: Matt Pocock, https://github.com/mattpocock/skills (grill-with-docs).
