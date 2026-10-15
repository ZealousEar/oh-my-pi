# 08 — B10: why Anthropic OAuth sessions ran a 5-minute cache, and the fix

## Symptom

`01-baseline-telemetry.md`: 66 % of Anthropic main turns that resume after a 15–60 min idle gap rewrite the whole prefix (99 rebuilds, 35 M cache-write tokens); session JSONLs show `usage.cttl.ephemeral5m` on 606 of 608 Anthropic turns and no `ephemeral1h`. Cache writes were 19 % of nominal spend.

## Cause

The build in use was `~/.omp-custom/omp-18.1.10-presets` (upstream v18.1.10 + the local presets patch). At that version `getCacheControl` in `packages/ai/src/providers/anthropic.ts` was:

```ts
// v18.1.10
const retention = resolveCacheRetention(cacheRetention, "short");
const ttl = retention === "long" && model.compat.supportsLongCacheRetention ? "1h" : undefined;
```

so OAuth requests never carried `ttl: "1h"` unless `PI_CACHE_RETENTION=long` was set. Upstream changed the default in `6019d73540` (2026-09-11, first tag **v18.1.18**):

```ts
// v18.1.18+
const defaultRetention = isOAuthToken && model.compat.supportsLongCacheRetention ? "long" : "short";
const retention = resolveCacheRetention(cacheRetention, defaultRetention);
```

Related commits in the same range that also improve hit rate: `40fbd0e028` (tool array carries a breakpoint on OAuth), `05cf924144` (historical decimation breakpoints), `6388de47f1` / `77f0ff3575` (cache anchors preserved across context hooks, limited to stable prefixes).

## Verification (wire capture, `PI_REQ_DEBUG=1`)

Same prompt, same account, `--model anthropic/claude-opus-5 --no-tools`:

| build | breakpoints on the wire | `anthropic-beta` has `extended-cache-ttl` | server `cache_creation` |
|---|---|---|---|
| v18.1.10 binary | `{"type":"ephemeral"}` ×2 | no | (matches JSONL: `ephemeral5m`) |
| 18.2.4 source (`bun run packages/coding-agent/src/cli.ts`) | `{"type":"ephemeral","ttl":"1h"}` ×2 | no | `{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4903}` |

Anthropic honours `ttl: "1h"` on the OAuth path without the beta header (the 18.2.4 source comment says the same and this capture confirms it). No 10/40/70-minute reuse probe is needed: the server-side bucket is the direct evidence.

## Decision

No omp code change. Rebuild the daily binary from ≥ v18.1.18 — fork `main` is now synced to upstream 18.2.4 (`dbf3afad48`). The local presets patch is partially ported on `feature/model-presets` (schema, resolver, docs, tests pass; the `/models` Presets overlay moved into `@oh-my-pi/pi-tui` in `0d6dbd32fc` and still needs porting).

Cost note: 1 h writes are billed at 2× input vs 1.25× for 5 m, so this trades write price for expiry avoidance. Break-even is ≥ 0.65 avoided rewrites per creation; at the measured 66 % rebuild rate on 15–60 min resumes it pays for itself on main sessions. Short-lived subagents write once and rarely resume; upstream applies 1 h uniformly, which is acceptable at their volume but is the first thing to revisit if B14 telemetry shows subagent cache-write share rising.

## Follow-up measurement

After a week on the new build: `python3 scripts/analyze.py` → `data/14d-cache-write-by-idle-gap.csv`. Expect the 15–60 min rebuild rate to fall from 66 % toward the > 1 h bucket only, and `cache_write_M` in `14d-by-agent-type.csv` to drop by roughly the 35–43 M idle-expiry share.
