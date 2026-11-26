# Profile layer changelog

Dated configuration decisions for the fork channels (`ompd` = profile daily-fork, `ompdev` = dev-fork) and for `agent/models.yml`, which all three profiles (stock, daily-fork, dev-fork) share through symlinks. Each entry records what changed and where, the owner decision, the evidence and the backups. Newest first.

`~/.omp/profiles/<profile>/agent/config.yml` is not in git: `launchers/install.sh` seeds it from `launchers/profile-seed/config.yml` only when it is missing. Entries therefore record its values. `fork-release` and `install.sh` never rewrite a profile `config.yml`, `models.yml` or `config/fork-overlay.yml`. The `launchers/fork/must-keep.json` probes make `fork-check` and `fork-release` fail when a new ompd stops honouring a setting listed there.

## 2026-11-26: compaction 256K/48K, role refresh, converge models, jev 1.14, effort ceilings, `deep` tier

Owner decisions: session `01a21311` (CareerMode): "go with 256k/48k", delete the Rust and Codex Only presets, add the tier ladder with escalation, converge on opencode-go without Kimi K3 (Qwen 4 Max instead), latest jev, the effort ceilings below, pr-writing on Opus low or medium using the pr-writing skill. A same-day review corrected the first implementation (see Fixed in review).

### Changed

| Setting | Before (effective) | After | File |
|---|---|---|---|
| Main compaction trigger | fixed `thresholdTokens: 200000` on every model | `thresholdPercent: 25.6`, `thresholdTokens: -1`, `thresholdMinContextWindow: 512000`: 256,000 on 1M windows; window − 15 % below 512K (Astra 272K → 231,200; Haiku 100K → 85,000) | daily-fork `config.yml` |
| Kept tail | 20,000 (default) | `keepRecentTokens: 48000` | daily-fork `config.yml` |
| Subagent compaction | none | `task.agentCompactionThresholdOverrides`: `task` 150000 (Sonnet 5.5, 1M), `deep` 200000 (Fable 5.2, 1M) | daily-fork `config.yml` |
| `slow`, `plan` | `claude-fable-5-1:medium` | `claude-fable-5-2:medium` | daily-fork `config.yml` |
| `commit` | default | `claude-sonnet-5-5` | daily-fork `config.yml` |
| `tiny` | `gpt-6-sol:low` | `gpt-6.2-sol:low` | daily-fork `config.yml` |
| `reviewer`, `researcher`, `advisor` roles | set | removed (no agent or code path reads them) | daily-fork `config.yml` |
| Presets | Rust, Codex Only, Opus-Fable, Opus-Fable-DS | Rust and Codex Only removed; Opus-Fable-DS mirrors the overlay roles (keep the two in sync) | daily-fork `config.yml` |
| `judge` | `typesafe/jev-1.13.0` | `typesafe/jev-1.14.0`, declared in `models.yml` | `config/fork-overlay.yml`, `agent/models.yml` |
| converge debaters | Astra 6.2 `xhigh`/`max`, Fable 5.2 `xhigh`/`max` | Astra 6.2 `medium`/`high`, Fable 5.2 `medium`/`high` (escalation = medium → high) | `config/fork-overlay.yml` |
| converge L3 judges | unset (panel failed closed, `e451ada`) | J1 seat `converge-judge-kimi` = `opencode-go/qwen4-max:high` (its top level; role and agent name kept because the orchestrator hard-codes them), J2 `converge-judge-glm` = `opencode-go/glm-5.3:max` | `config/fork-overlay.yml`, `agent/agents/converge-judge-*.md`, converge skill |
| `deep` | none | role `anthropic/claude-fable-5-2` (no suffix: `thinkingLevel: auto`), `agent/agents/deep.md`, tier/escalation rule `agent/rules/subagent-tiers.md` | `config/fork-overlay.yml`, layer |
| `pr-writing` | agent on `@commit` | role `anthropic/claude-opus-5-5:medium`; the agent must follow the `pr-writing` skill or yield `BLOCKED` | `config/fork-overlay.yml`, `agent/agents/pr-writing.md` |
| Effort ceilings | catalog ladders (up to `max`) | Fable 5 / 5.1 / 5.2 and Astra 6 / 6.2 (`openai-codex`) top out at `high`; Opus 5 / 5.5 at `xhigh`. Lift only by editing these lines for an explicit owner request. | `agent/models.yml` |

`judge`, `deep`, `pr-writing` and the converge roles live in the overlay so that ompd and ompdev both resolve them, since their agents are layer files shared by both. The profile `config.yml` keeps only roles that differ per profile, so dev-fork keeps its own `default`, `slow`, `plan`, `task` and `smol`.

### Fixed in review (same day, before landing)

- **Empty thinking on Fable and Opus 5.x.** A `models.yml` `thinking` override replaces the catalog's whole thinking object, keeping only `prefixBinding` (`packages/coding-agent/src/config/model-patch.ts`). The first clamps dropped `supportsDisplay: true`, so requests left out `display: "summarized"` and thinking came back empty (0 chars on fable-5-2 and opus-5-5 at `--thinking high`, against 241 on opus-4-8, which has no override). This hit stock omp too, because it shares `models.yml`. Each Anthropic clamp now restates `supportsDisplay: true`. Re-probed: fable-5-2 218 chars, opus-5-5 175, stock omp fable-5-2 243.
- **Fixed 256K trigger on small windows.** `thresholdTokens` is applied before the below-512K window rule, so `thresholdTokens: 256000` made 272K Astra/Sol models compact at 256,000 with 16K of headroom, above the ~253K Codex ceiling that rejected 250K in token-economics decision A1. 262K Featherless models got 6K of headroom. Replaced by `thresholdPercent: 25.6`, which gives the same 256K on 1M windows.
- **scout/sonic caps of 96000 removed.** Both run on `@smol` = Haiku 5.5 (100K window). An agent entry is a fixed trigger, so compaction would have fired at 96,000, later than the 85,000 the window rule gives. The 96K figure in token-economics B12 assumed scouts on a 1M model.
- Stale converge text updated: the judge failure row in `SKILL.md`, the example models in `references/panel.md`, and the `models.yml` header (the OpenRouter Kimi K3 / GLM-5.3 pins are no longer the judge routes).

### Effective compaction trigger by context window

| Window | Before (200000 fixed) | First implementation (256000 fixed) | Landed (25.6 %) |
|---|---|---|---|
| 1,000,000 (Opus, Fable, Sonnet) | 200,000 | 256,000 | 256,000 |
| 1,050,000 | 200,000 | 256,000 | 268,800 |
| 500,000 (Sol 6.1/6.2, `tiny`) | 200,000 | 256,000 | 425,000 |
| 272,000 (Astra 6/6.2, Sol 6 / 5.6) | 200,000 | 256,000 | 231,200 |
| 262,144 (Featherless, abliteration) | 200,000 | 256,000 | 222,823 |
| 100,000 (Haiku 5.5) | 83,616 | 83,616 | 85,000 |

Computed with `resolveThresholdTokens` from `packages/agent/src/compaction/compaction.ts` at fork source `8ed99e9bba`.

### Not changed, by owner choice

- The OpenRouter `openai/gpt-6-astra-pro` and `openai/gpt-6.2-astra-pro` models (and their `:batch` variants) keep `xhigh`/`max`.
- Stock omp's `openrouter/anthropic/claude-fable-5.2`, `claude-opus-5.5` and `openrouter/openai/gpt-6.2-astra` stay unclamped: only the `anthropic` and `openai-codex` providers are clamped.

### Superseded

- Token-economics A1 (main trigger 200K; `docs/investigations/2026-09-token-economics/06-proposed-changes.md`): 256K on 1M windows. The reason A1 rejected 250K (the Codex ceiling) still holds for 272K windows, which now compact at 231,200 as in `12-astra-context-policy.md`.
- `e451ada` (L3 judges unset, Claude/OpenAI-only routing): the judges run on opencode-go again with new models.
- The "Opus MRCR 93 % @256k" figure cited for 256K belongs to Opus 4.6, not Opus 5.x.

### Not yet done

- Doc 12's `keepRecentTokens: 48000` for the dev-fork and stock profiles and for `launchers/profile-seed/config.yml`. The seed also still has the old trigger and fable-5-1 roles.
- No full converge L3 run since the judge change. jev-1.14.0 answered a `judge_batch` call on 2026-11-26.

### Verification (2026-11-26, ompd 19.0.0 r33)

- `ompd config get modelRoles` and `ompdev config get modelRoles` both resolve `judge`, `deep`, `pr-writing` and the converge roles from the overlay. `compaction.*` and `task.agentCompactionThresholdOverrides` resolve to the values above.
- `fork-check --sections probes` passes on `--channel ompd` and `--channel ompdev`. That includes the new must-keep features "Effort ceilings" and "Thinking text survives the effort clamps".

### Backups (outside git)

- `~/.omp/profiles/daily-fork/agent/config.yml.bak-20261126-roles`
- `~/.omp/profiles/daily-fork/agent/models.yml.bak-20261126-caps`
- `~/.omp/implementation-2026-09-18/launchers/backup/2026-11-26-ompd-config/fork-overlay.yml.bak-20261126`
