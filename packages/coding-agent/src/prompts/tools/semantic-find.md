Ranks passages of files you name by how well they answer a natural-language question, and reports separately whether the answer is present at all.

Use when you know roughly *where* the answer lives but not the exact words: "where is the spill threshold decided?", "which function owns retry backoff?". For exact symbols, literal strings, or regexes use `grep` — it is faster and exhaustive.

<instruction>
- `query`: the question in plain language. Not a regex, not a keyword list.
- `paths`: the ONLY content read. Name files, globs (`src/tools/*.ts`), or internal URLs (`artifact://`, `local://`, `agent://`, `skill://`); directories are rejected. Nothing outside `paths` is ever sent.
- `unit`: `line` scores single lines, `paragraph` scores blank-line blocks, `auto` (default) picks per file — lines for short prose, indentation-aware code blocks for source, paragraphs for long prose.
- `limit`: how many passages to return (default 8). `context`: extra lines shown around each hit.
- Caps: at most {{maxFiles}} files, {{maxBytesPerFile}} bytes per file, {{maxPassages}} passages total. Oversized or binary inputs are skipped with a stated reason — never silently half-read.
</instruction>

<output>
Each hit is `path:start-end  score`, then the passage with matched rows marked `*` and context rows marked with a leading space, mirroring `grep`. Re-read any hit verbatim with `read path:start-end`.

`answerPresent` is an independent probability, NOT the ranking. Ranking probabilities sum to 1, so the top passage is only "the closest one" — a low `answerPresent` means the selected files likely do not contain the answer. That is evidence about these files, never proof about the repository.
</output>

<critical>
Scores come from a judgment model. Verify a hit by reading it before acting on it.
</critical>
