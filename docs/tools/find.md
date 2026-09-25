# find

> Semantic grep: describe what you are looking for and get back files and line ranges that implement it, each with a calibrated relevance score. Shown as `Find` in the UI. With `paths` instead of `path` it runs in **bounded mode**: it ranks passages of exactly the named sources and reports, separately, whether the answer is present in them at all.

## Source
- Entry: `packages/coding-agent/src/tools/jfind/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/find.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/jfind/cascade.ts` — the search strategy and its bounded-parallel request dispatcher
  - `packages/coding-agent/src/tools/jfind/keywords.ts` — query → lexical keywords (quoted phrases, stopword removal, cheap stemming)
  - `packages/coding-agent/src/tools/jfind/lexical.ts` — native grep keyword index, IDF weights, file scoring
  - `packages/coding-agent/src/tools/jfind/tree.ts` — eligible file listing (deny lists, credential filter) and the tagged tree rendering
  - `packages/coding-agent/src/tools/jfind/passages.ts` — byte-bounded windows, sketches, heat-range merging
  - `packages/coding-agent/src/tools/jfind/questions.ts` — the three judgment request shapes; question text in `packages/coding-agent/src/prompts/tools/find-*-question.md`
  - `packages/coding-agent/src/judgment/index.ts` — resolves the `judge` model role that answers every question
  - `packages/tui/src/tools/find.ts` — transcript renderer (score gauges, hyperlinked ranges, live phase progress) and the `FindToolDetails` type
  - `packages/coding-agent/src/tools/jfind/bounded.ts` — bounded mode (`paths`): orchestration, re-read verification, and the model-facing report
  - `packages/coding-agent/src/tools/jfind/excerpts.ts` — bounded mode source selection (files, globs, internal URLs; caps and skip reasons) and passage segmentation
  - `packages/coding-agent/src/tools/jfind/ranking.ts` — bounded mode windowed two-pass ranking plus the independent presence check; question text in `packages/coding-agent/src/prompts/tools/find-select-question.md`, `find-exists-question.md`, `find-exists-criteria.md`
  - `packages/coding-agent/src/judgment/decision.ts` — the metered decision loop (`decideAmongCandidates`, `LoopMeter`, provenance) bounded mode ranks through

It is a TypeScript port of the default (`cascade`) strategy of [jegrep](https://github.com/can1357/jegrep); request shapes, budgets, and ordering match the reference so benchmark results carry over.

## CLI
`omp find "<query>" [path] [-k keyword]... [--hidden] [--json] [-q]` runs the same cascade from the shell (`packages/coding-agent/src/cli/find-cli.ts`): the judge resolves from your settings' `judge` role, progress goes to stderr, and the ranked digest (or `--json` with hits and stats) to stdout. `path` takes the same host paths and internal URLs as the tool, and hits print relative to the shell cwd. Exits 1 when every judgment request failed.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Plain-language description of the behavior or concept to locate. Quoted phrases are matched whole in the lexical pass. Whitespace-only queries are rejected. |
| `grep_keywords` | `string[]` | Yes | Extra identifiers or terms for the lexical pre-ranking, in addition to those derived from `query`. `[]` when nothing specific comes to mind. |
| `path` | `string` | No | Directory or single file to search: a host path or an internal URL (`omp://` for all harness docs, `omp://<file>.md` for one doc, `skill://<name>`, `local://notes`). Paths resolve against the session cwd (`~` expanded, a bare `/` means the workspace root). Omitted or empty defaults to the cwd. A missing path is rejected. A trailing `:start-end` selector on a URL is rejected too — `find` judges whole files. |
| `paths` | `string[]` | No | **Bounded mode.** The only content read: files (relative to the session cwd or absolute), globs (`src/tools/*.ts`, `local://*.md`), or internal URLs (`artifact://`, `local://`, `agent://`, `skill://`, `history://`, …). Directories, `:start-end` selectors, oversized, binary, blank, and unreadable inputs are skipped with a stated reason. Mutually exclusive with `path`. |
| `unit` | `"auto" \| "line" \| "paragraph"` | No | Bounded mode only. `auto` picks per file: lines for short prose, indentation-aware code blocks (≤ 12 lines) for source, paragraphs for long prose (> 400 lines). |
| `limit` | `number` | No | Bounded mode only. Passages to return (default 8, at most 50). |
| `context` | `number` | No | Bounded mode only. Extra lines shown around each hit (default `semanticFind.contextLines`). |

`unit`, `limit`, and `context` without `paths` are rejected; so is `path` together with `paths`.

Internal URLs are searched in place: the native listing and lexical scan and the file reads go through the session's URL filesystem (`InternalUrlFilesystem`, read tier), which is the same one the bash tool uses. Virtual documents need no local files, and file-backed schemes resolve to their host files. Hits under a URL scope are URLs (`omp://tools/read.md`). Open them directly with `read`, including with `:start-end` selectors (`read omp://tools/read.md:50-100`). Hidden files are excluded unless the file is named as the scope. Other hit paths are reported relative to the session cwd, not the searched directory, so `read` and hyperlinks resolve without knowing the scope.

`find.enabled` is `auto` by default: `find` is enabled only when the `judge` model role resolves first to a native System One model (TypeSafe `typesafe/jev-latest`, directly or through OpenRouter), not a prompted on-device or chat model. `on` enables it whichever model judges; `off` disables it. Once enabled it is an essential (top-level) tool, never mounted under `xd://`.

## Outputs
- Single text block, strongest hit first:
  - header `N hit(s) for "query" (τ 0.20), strongest first`
  - per hit: `path  score  N lines judged[, partial]`, then up to three `path:start-end  p  snippet` rows (strongest range first)
  - footer with `listed`, `judged`, files read and bytes sent, request count, input tokens, cost, and wall/API time
  - when requests failed: `E of R requests failed:` followed by up to five distinct phase-prefixed failure messages
- No hits: `no hits for "query" (τ 0.20)` plus the footer; the result is marked `useless`.
- Every request failed (for example no judge configured): the result is an error carrying the failure messages.
- When `path` narrows the search, the header reads `N hit(s) for "query" in <dir>/ …` and the renderer shows `in <dir>/`.
- `details` (`mode: "cascade"`): `query`, `keywords` (lexical keywords used), `threshold`, `hits` (cwd-relative `rel`, `nameScore`, `contentScore`, merged `ranges` with `start`/`end`/`p`/`snippet`, `linesSeen`, `truncated`), `stats`, `elapsedMs`, `cwd` (hyperlink base), and `scopePath` (display form of `path`, absent when searching the cwd).
- Streaming: phase progress (`lexical scan`, `filename ranking 64/128`, `verifying 8 passages in 5 files`, …) is emitted through `onUpdate` and shown in the transcript header while the call runs.

## Flow
1. **Lexical scan.** `listFiles()` walks the root (gitignore-aware, no hidden files, no symlinks) and drops build output, lockfiles, binary extensions, and credential files. A file root is its only entry. `grepIndex()` runs one native grep for all keywords and counts per-keyword occurrences on matching lines. Both run concurrently. `idf()` weights rare keywords higher (clamped to `[0.5, 6]`); `fileScore()` ranks every file by weighted log-frequency plus a bonus for keywords in the path.
2. **Filename ranking.** The top 128 lexical candidates are judged by name in batches of 64: one noul per file over a prefix-folded tree listing (`# e017 name (size)`) and shared criteria.
3. **Passage scoring.** Twenty files are read (the two strongest lexical candidates unconditionally, the rest by name score then lexical rank): up to 4 MB each, cut into 8 KB whole-line windows tagged `L<n>| `, keeping the 24 best-scoring windows (spread evenly through the file when no keyword matches). Each window becomes a 384-byte sketch of its most keyword-dense verbatim lines; sketches are packed 46 per request across files and judged.
4. **Verification.** Sketches scoring ≥ 0.45 (at most 40) are verified as complete passages, grouped per file three to a request. Only verified passages produce ranges; positive ranges (≥ τ = 0.20) that touch or overlap are merged, keeping the max probability. A file is a hit when its best verified passage reaches τ.

Each judged phase drains through a dispatcher with 16 requests in flight before the next begins, so the critical path is three dependent waves.

## Side Effects
- Filesystem: reads up to 20 candidate files (4 MB each); never writes.
- Network: judgment requests through the session's judge role; usage is summarized in the result footer.
- Cancellation: the tool abort signal stops the native scan and in-flight judgments.

## Limits & Caps
- Candidates judged by name: 128; files read: 20; windows per file: 24; window size: 8 KB; sketch: 384 B; passages verified: 40; sketch cutoff 0.45; hit threshold 0.20 (`packages/coding-agent/src/tools/jfind/cascade.ts`).
- Native scan timeout: 30 s. Judge attempts time out per `TypeSafeJudge` (10 s, three attempts).
- Files over 4 MB are scanned by the lexical pass only up to the native grep cap and read only up to 4 MB (trimmed to the last full line).

## Errors
- `ToolError` for an empty `query`, a `path` that does not exist (`Path not found: …`) or is neither a file nor a directory, a URL `:start-end` selector, or a session without a model registry.
- Judge failures are not thrown: a failed request leaves its entries unjudged (filename and verification) or routes them onward as unknown (sketch scoring, so an outage never prunes). Failures are listed in the footer; the result becomes an error only when every request failed.

## Notes
- Scores are absolute yes/no probabilities from the judge, so they are comparable across calls and batches.
- Keyword extraction lowercases, drops tokens shorter than three bytes, stopwords, and pure numbers, and stems `-ing`/`-ed`/`-es`/`-s` when the stem keeps at least four characters.
- Directory folders are never judged; the tree shown to the judge is structure only, which is why the filename batch carries `criteria.folder` for parity with the reference request shape.

## Bounded mode (`paths`)

Use it when you know roughly *where* the answer lives but not the exact words. Nothing outside `paths` is read; there is no lexical prior, no filename ranking, and no discovery — every readable named source is segmented into passages and every passage is scored exactly once.

### Outputs
- Header `find "query" (bounded)`, then `coverage: N sources, N passages, N windows, N passes`, a `N finalists dropped: …` line when the finalist request could not seat every first-pass finalist, one `skipped <path>: <reason>` line per unread input, `answerPresent P — <verdict sentence>`, and `verification (true|false|unknown): <detail>`.
- Each hit is `path:start-end  score P`, then the passage with matched rows `*N:content` and context rows ` N:content`, mirroring `grep`; re-read any hit verbatim with `read path:start-end`. Rows are sanitised (ANSI/control characters stripped, tabs expanded, 512-column cap); verification compares the raw excerpt.
- Footer `provenance: <backend> judge <provider>/<model>, <native|synthetic> distribution, N calls, N attempts, cost $…[, fell back from …]`.
- `answerPresent` is an **independent** probability that the named sources answer the question, with a band sentence: `< 0.35` → `likely absent from the selected files — this is not proof of absence in the repository`, `< 0.7` → `partially addressed`, else `answered in the selected files`. Ranking probabilities sum to 1 across passages, so the top hit is only "the closest one"; the two signals are never combined.
- Every reported range is re-read from its source (host file or internal URL, through the same URL filesystem) and byte-compared with the excerpt before it is reported: `verified: true`, or `false` naming the changed ranges, or `unknown` when nothing could be re-read.
- `details` (`mode: "bounded"`): `answerPresent`, `verdict` (`absent` | `partial` | `present`, `unknown` on failure), `results` (`path`, `resolved`, `startLine`, `endLine`, `score`, `snippet`), `coverage` (`files`, `passages`, `windows`, `passes`, `finalistsDropped`, `skipped[]`), `observation` (digest of the passage set), `verification`, `provenance` (every judgment attempt, failed and nested ones included), `usage` (calls, attempts, tokens, cost), `usageRecorded` (whether the session ledger received the judge's usage under purpose `find`), `elapsedMs`, `cwd`, and `error` when ranking failed.

### Flow
1. Resolve `paths` in order: globs expand exactly as written (`dir/*` stays one level, `**` descends; gitignore-aware, no hidden files) against the host tree or a URL root; every entry is `stat`ed and read in full through the session's URL filesystem, enforcing `semanticFind.maxFiles` (more readable sources than the cap is an error naming the unread ones, never a ranked prefix) and `semanticFind.maxBytesPerFile` (larger files are skipped, never truncated).
2. Segment each source by `unit`; more than `semanticFind.maxPassages` passages is an error suggesting `unit:"paragraph"` or narrower paths. Record an `ObservationIdentity` digest of the passage set.
3. Score every passage once in windows of at most `min(semanticFind.passagesPerRequest, 255)` passages, each window one metered judgment request carrying one `select` Choice over passage ids plus the independent `exists` noul. With more than one window, one more request re-ranks the finalists on a single scale: it seats `max(1, floor(windowSize / windows))` finalists per window so every window is represented; finalists beyond that are counted in `coverage.finalistsDropped`. `answerPresent` is the maximum `exists` answer across requests. Budget: `maxCalls = windows + 1`, a 60 s deadline capped by `tools.maxTimeout`, half of it per request.
4. Render hits with context, re-read them for verification, and report.

### What leaves the machine
Every request goes to the `judge` model role. Per first-pass window it carries the `query`; for each passage in the window its id, `path:start-end`, and passage text up to 1200 characters (longer passages are cut with an ellipsis); and a 160-character whitespace-collapsed preview of each passage as the option rubric. The finalist pass re-sends the same for the seated finalists. Across a whole call this is effectively the text of every readable source named in `paths` (bounded by `semanticFind.maxFiles` × `maxBytesPerFile` and `maxPassages`), plus the query.

### Errors
- `ToolError` for empty `paths`, `path` together with `paths`, over-cap inputs (naming the unread sources or asking to narrow `paths`), nothing readable in `paths` (listing each skip reason), or a session without a model registry.
- A judge error or spent budget after ranking started is a failed tool result (`isError`) reading `find unavailable: <reason>; use grep for exact matches`; `details.error`, `details.provenance`, and `details.usage` still account for every attempt made, and the provenance line names the failed attempt.
- A judge answer naming a passage id that was never offered is an error, never a result.

### Settings
`semanticFind.maxFiles` (24), `semanticFind.maxBytesPerFile` (262144), `semanticFind.maxPassages` (2000), `semanticFind.passagesPerRequest` (200), `semanticFind.contextLines` (2). The tool description shows the first three so the model can size its `paths`.
