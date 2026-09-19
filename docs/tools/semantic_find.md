# semantic_find

> Rank passages of named files by how well they answer a natural-language question, and say separately whether the answer is present at all.

## Source
- Entry: `packages/coding-agent/src/tools/semantic-find.ts`
- Passage selection and segmentation: `packages/coding-agent/src/tools/semantic-find/passages.ts`
- Windowed two-pass ranking and presence check: `packages/coding-agent/src/tools/semantic-find/ranking.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/semantic-find.md`
- Judgment prompts: `packages/coding-agent/src/prompts/system/semantic-find-select.md`, `semantic-find-exists.md`, `semantic-find-exists-criteria.md`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"` — mounted as `xd://semantic_find` (`read xd://semantic_find` for docs, `write xd://semantic_find` with JSON args to run) in ordinary sessions; top-level when explicitly requested.
- Registered only when the session has a model registry; there is no lexical fallback by design (`grep` covers exact matches).

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | The question in plain language; not a regex or keyword list. |
| `paths` | `string[]` | Yes | The only content read: files (relative to the session cwd **or absolute — there is no cwd sandbox**), globs, or internal URLs (`artifact://`, `local://`, `agent://`, `skill://`, `history://` — session and subagent transcripts included). Directories are rejected. |
| `unit` | `"auto" \| "line" \| "paragraph"` | No | `auto` picks per file: lines for short prose, indentation-aware code blocks for source, paragraphs for long prose. |
| `limit` | `number` | No | Passages to return (default 8). |
| `context` | `number` | No | Extra lines shown around each hit (default `semanticFind.contextLines`). |

## Outputs
- Each hit is `path:start-end  score` followed by the passage with matched rows marked `*` and context rows indented, mirroring `grep`; re-read any hit with `read path:start-end`. Rendered rows are sanitised (ANSI/control characters stripped, tabs expanded, 512-column cap); verification compares the raw excerpt.
- `answerPresent`: an independent probability that the selected files answer the question, with a band sentence (`likely absent from the selected files — not proof of absence in the repository`, `partially addressed`, `answered in the selected files`). Ranking probabilities sum to 1 across passages, so the top hit is only "the closest one".
- Every file-backed hit is re-read from disk and byte-compared with the excerpt before it is reported (`verified: true`); a mismatch is reported as `verified: false` naming the range; virtual resources are `verified: "unknown"`.
- `coverage.finalistsDropped` (and a line in the text) states how many first-pass finalists `limit` admitted but the single finalist request could not seat; `0` means the reported order considered every finalist.
- `details.provenance` lists every judgment attempt (failed calls included) and `details.usage` counts calls, attempts, tokens, and cost; usage is appended to the session ledger with purpose `semantic-find` when a ledger is reachable, else `details.usageRecorded = false`.

## What leaves the machine
- Every judgment request goes to `providers.judgmentProvider` (TypeSafe when configured, else the `tiny`/`smol`/`default` chat chain) — not necessarily the session model's provider.
- Per first-pass window it carries: the `query`; for each passage in the window its id, `path:start-end`, and **passage text up to 1200 characters** (longer passages are cut with an ellipsis); and a 160-character whitespace-collapsed preview of each passage as the option rubric. The finalist pass re-sends the same for the seated finalists. Across a whole call this is effectively the text of every readable source named in `paths` (bounded by `semanticFind.maxFiles` × `maxBytesPerFile` and `maxPassages`), plus the query.
- Nothing is sent unless the tool is invoked; without a model registry the tool is not registered.

## Flow
1. Resolve `paths` (globs expanded, internal URLs read through the local protocol handlers), enforcing `semanticFind.maxFiles`, `maxBytesPerFile`, and `maxPassages`; oversized, binary, and unreadable inputs are skipped with a stated reason, never half-read.
2. Segment each source into passages by `unit` and record an `ObservationIdentity` digest of the passage set.
3. Score every passage exactly once in windows of at most `min(semanticFind.passagesPerRequest, 255)`; with more than one window, re-rank the finalists in one more request so the reported order comes from a single distribution. That request seats `max(1, floor(windowSize / windows))` finalists per window, so every window is represented and the request never exceeds the window size; finalists beyond that are counted in `coverage.finalistsDropped`. `maxCalls = windows + 1`.
4. Ask the independent `exists` question in every request; `answerPresent` is the maximum.
5. Question design (the TypeSafe line-by-line search cookbook's shape): each request carries one `select` Choice whose options are passage ids — the passage `text` and `source` live in `passages[]` in the state, and the instructions name them by path (`` `passages` ``, `` `passages[].text` ``, `` `query` ``) — plus the `exists` Noul, a yes/no question with `true`/`false` criteria. There is deliberately no `none` option on the Choice: its probabilities sum to 1, so "still pick the closest one" is instructed and the independent `exists` answer is the no-match signal; the two are reported separately and never combined. `ANSWER_PRESENT_HIGH` (0.7) / `ANSWER_PRESENT_LOW` (0.35) are code constants that only choose the band sentence; Choice `confidence` is not used.
6. Render hits with context, verify them against disk, and record usage.

## Errors
- Over-cap inputs: `ToolError` naming the unread sources or asking to narrow `paths`.
- Judge unresolvable (no registry, no credential): `ToolError` `semantic_find unavailable: <reason>; use grep for exact matches`.
- Judge error or budget exceeded after ranking started: a failed tool result (`isError`) with the same message, whose `details.error`, `details.provenance`, and `details.usage` still account for every attempt made; the provenance line in the text names the failed attempt.
- A judge answer naming a passage id that was never offered is an error, never a result.

## Notes
- Scores come from a judgment model; verify a hit by reading it before acting on it.
- Without a TypeSafe credential the distribution is `synthetic`; the code is distribution-agnostic and `providers.typesafeModel` pins the native backend when one is configured.
