# recommend_skills

> Rank the installed skills by how well they fit a task, instead of reading the whole `<skills>` listing.

## Source
- Entry: `packages/coding-agent/src/tools/recommend-skills.ts`
- Ranking engine: `packages/coding-agent/src/extensibility/skill-recommend.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/recommend-skills.md`
- Judgment prompts: `packages/coding-agent/src/prompts/system/skill-recommend-select.md`, `skill-recommend-applicable.md`, `skill-recommend-fits.md`, `skill-recommend-fits-criteria.md`
- Decision contracts: `packages/coding-agent/src/judgment/decision.ts`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `readsSkillUris = true`; stays top-level.
- Registered when `skills.enabled` and `skills.recommend.enabled` (default `true`) are both on.
- Only the active, non-hidden skill catalog is ranked; nothing outside the catalog is read.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `task` | `string` | Yes | What you are about to do, in one or two concrete sentences. |
| `limit` | `number` | No | Ranked skills to return (default 5, max 10). |
| `explicit` | `string[]` | No | Skill names that must appear regardless of ranking. |

`/skill:<name>` and `skill://<name>` mentions inside `task`, and exact skill-name tokens, are treated as explicit selections too.

## Outputs
- A relevance-ordered list: `name — relevance (reason) — description`, explicit selections first and never filtered by `skills.recommend.minRelevance`. Names and descriptions are sanitised before they are echoed (ANSI/control characters stripped, tabs expanded, one line per skill, descriptions cut at 300 characters).
- `mode: semantic` when the judgment backend scored the catalog; `mode: search` when it degraded to deterministic lexical overlap (the failure reason is stated).
- A no-match line when either gate says nothing applies — the window-level "any skill applicable" judgment below 0.35, or every finalist's own `fits` judgment below 0.30 — with the caveat that the heuristic is not proof. A no-match result lists **no** ranked skill: the judge's forced pick is suppressed rather than shown as `relevance 1.00` beside "nothing applies". Explicit selections are still returned.
- Each ranked entry in `details.result.recommendations` also carries `applicable`: the skill's own absolute `fits` probability, answered independently of the other skills (1 for explicit and lexical entries).
- A provenance line: backend, model, `native` vs. `synthetic` probability distribution, calls, and cost (`unknown` when the transport does not price tokens).
- `details.result.attempts` carries every judgment attempt (failed calls included); usage is appended to the session ledger with purpose `skill-recommend` when a ledger is reachable, chained from the branch leaf at the time the call started so overlapping calls never chain off each other.

## Flow
1. Read `skills.recommend.*`, snapshot the enabled catalog, and sanitize skill names into candidate ids (32-char bound, collision suffixes).
2. Serve from the per-recommender LRU cache when the same catalog generation, task, `limit`, and explicit names were asked before.
3. Split the catalog into near-equal windows of at most `skills.recommend.maxCandidatesPerRequest` skills (clamped to `3..254`; the judgment `Choice` cap is 255 and one slot is reserved). Balancing means no window of a multi-window split ever holds fewer than two skills — a lone option's probability is 1 by construction and would outrank every genuinely shared distribution. Each window gets one `Choice` head listing its skills plus a `none` option ("no listed skill applies") and one `any applicable` yes/no head, through `judgeWithMeter`. Mass the judge puts on `none` lifts no skill.
4. Merge windows and put explicit selections first. Drop candidates below `minRelevance`, **except** the single strongest skill (probability × its window's `any applicable`) when `any applicable` is at least 0.5: a flat native distribution would otherwise drop every candidate although the judge said something applies. Order across windows by probability × that window's `any applicable`; ties break by name.
5. Ask the finalists (the ranked skills `limit` admits) about themselves in one more request: one `fits` yes/no head per finalist, each answered on its own ("does this skill do the specific thing the task asks for?") with `true`/`false` criteria and pointing at `skills[i].description` and `task` by path. This is the TypeSafe skill-suggestion cookbook's shape — a `Choice` is relative and settles *which* skill, while each `fits` noul is absolute and can be low for every skill — and it is a second request because the finalists are only known once every window has answered. The fits never reorder the list; they gate the no-match verdict (`max(fits) < 0.30`) and are reported as `applicable`. The request is skipped when the window gate already rejected the catalog. Re-resolve each name against the catalog (verification `catalog-reresolve`).
6. A judge that answers an id it was not offered fails closed (no recommendation); a judge error falls back to lexical ranking. A result whose catalog generation changed while the request was in flight is reported `stale` and not cached.
7. The judge is the session's `judge` role chain (`modelRoles.judge` + `retry.fallbackChains.judge`). An exact pin — a literal `provider/id` with an explicitly empty judge chain — admits no substitute: when the pinned model is undiscovered or uncredentialed the tool reports `mode: search` with `judge unavailable: judgment: pinned judge … is unavailable (…)` and asks no other model. The same holds when no judge model is credentialed at all (`judge unavailable: judgment: no judge model available`). A judge whose transport was reached and failed is reported as `judgment failed: …` with the failed attempt kept in `details.result.attempts`.

## What leaves the machine
- Per window, one judgment request to the `judge` role chain (a native System One model such as TypeSafe when the role routes there, else the prompted `tiny`/`smol`/`default` chat chain and finally the session model) carrying: the `task` text, and for each skill in the window its candidate id, name, and description. One further request carries the `task` and the finalists' id, name, and description. Descriptions are NFKC-normalised, stripped of ANSI/control characters, and cut at 300 characters before they are sent; the prompts declare them untrusted evidence.
- Nothing is sent unless the tool is invoked; `skills.recommend.enabled: false` removes the tool.

## Limits & Caps
- `limit` above 10 is rejected.
- Calls are bounded by the window count plus one (the finalist `fits` request); each attempt is metered with the tool's clamped timeout as the deadline.

## Notes
- Relevance is a ranking signal, not a correctness guarantee — read `skill://<name>` before acting on a recommendation.
- When the judge role answers through a prompted chat model rather than a native judge, the distribution is `synthetic` (a one-hot pick), which the provenance line states (`judge: online judge role chain · model <provider>/<model> · synthetic one-hot`); a native answer reads `judge: native … · native`.
- The cache key includes the judge role configuration, so changing `modelRoles.judge` or its fallback chain mid-session never serves a ranking made by a different judge.
