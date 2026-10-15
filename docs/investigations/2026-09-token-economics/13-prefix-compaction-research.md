# 13 — System-prompt / tool-prefix compaction: measured baseline and external evidence

Question: omp's per-request prefix (system prompt blocks + tool definitions) is ~18k tokens. What have others done to shrink it, and how did they measure the information loss or harness-performance delta per token / per % of window removed?

Method: live measurement of omp's own prefix (2026-09-27), then three parallel web scouts (`m1`, DeepSeek V4.1 Flash) over harness vendors, academic literature, and practitioner writeups; every claim below carries a URL, ✓ = primary source read directly during refinement.

## 1. Measured baseline (omp, this repo, 2026-09-27)

Built with `createAgentSession({ cwd: oh-my-pi })`, tool schemas serialized via `toolWireSchema`. Tokens ≈ chars/4. Tables: `data/prefix-sections.csv`, `data/prefix-tools.csv`.

| pile | chars | ≈ tok | share | owner |
|---|---|---|---|---|
| `AGENTS.md` (`<repo-rules>` in block 1) | 27.8k | 7.0k | 38 % | repo file |
| tool definitions (desc + wire JSON schema, 12 tools) | 18.5k | 4.6k | 26 % | `packages/coding-agent/src/tools/*/prompt.md` + schemas |
| profile always-apply rules (`<generic-rules>`) | 10.7k | 2.7k | 15 % | `~/.omp/profile-layer/agent/rules/*.md` (bounded-runs 4.6k, orchestration-notify 3.7k, grill-first 1.5k, show-me 0.9k) |
| bundled core prompt (`system-prompt.md` minus rules/skills) | 10.2k | 2.5k | 14 % | `prompts/system/system-prompt.md` |
| `<skills>` list (43 × one line) | 4.7k | 1.2k | 7 % | installed skills; `cfgSkillful` defers it |
| **total** | **72.3k** | **≈18k** | | |

Largest single items: `AGENTS.md` (> bundled prompt + all tool text combined); `edit` description 5.2k chars = 28 % of all tool text; `bounded-runs.md` + `orchestration-notify.md` each re-embed the RFC 2119 `<system-conventions>` block already at the top of block 0 (`dedupeAlwaysApplyRules` only catches whole-file containment).

The interactive session adds `ask` and `recommend_skills` (~+0.5k tok over the SDK measurement).

## 2. How others tackled it — five camps

```
Cut resident bytes ──► Vercel: 40KB→8KB, pass rate held at 100 %
Defer / on-demand ───► Anthropic tool search: −85 % tok, selection acc 49→74 %
Change representation ► TSCG: −52 % tok, Phi-4 0→84 % @20 tools; SWE-agent ACI ablations
Cut instruction COUNT ► ManyIFEval: GPT-4o 0.94→0.21 from 1→10 instructions
Stop paying: cache ──► Weinberger & Hozez: −38 % tokens → +6.8 % billed cost
```

**No source publishes "info loss per % of system prompt removed."** All three scouts hit the gap independently. What exists: instruction-count curves, input-length curves, tool-count curves, and $/successful task.

### 2.1 Cut resident bytes, hold the eval constant — Vercel ✓

- Docs index in AGENTS.md: 40 KB → 8 KB (−80 %), pipe-delimited; pass rate unchanged at 100 % vs 53 % baseline (hardened Next.js 16 API suite, retries for variance). https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
- Deferral failed: skill never invoked in 56 % of runs → 53 %, same as no docs; "invoke the skill" instruction → 79 %. Always-on beat on-demand for broad, horizontal knowledge.
- Wording ablation: "You MUST invoke" vs "explore first, then invoke" changed outcomes; instruction-sensitivity confounds length experiments.

### 2.2 Defer / progressive disclosure — Anthropic, Codex, Cursor, Devin

- Tool Search Tool: 58 tools / ~55K tok → ~8.7K (−85 %); Opus 4 tool-selection 49 → 74 %, Opus 4.5 79.5 → 88.1 % (internal MCP evals); worth it only past ~10 tools / >10K tok of definitions. https://www.anthropic.com/engineering/advanced-tool-use ; https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Programmatic tool calling: 43.6K → 27.3K tok (−37 %), GIA 46.5 → 51.2. Code-mode MCP: 150K → 2K. https://www.anthropic.com/engineering/code-execution-with-mcp
- Context editing + memory: +29 % / +39 % on agentic-search eval, −84 % tokens over 100 turns. https://claude.com/blog/context-management
- Claude Code memory docs: "target under 200 lines per CLAUDE.md; longer files reduce adherence"; `.claude/rules/` with `paths:` globs load lazily; auto-memory injects first 200 lines / 25 KB. https://code.claude.com/docs/en/memory
- Codex: AGENTS.md chain hard-capped at 32 KiB (`project_doc_max_bytes`); skills contribute metadata only. https://developers.openai.com/codex/guides/agents-md ; https://openai.com/index/unrolling-the-codex-agent-loop/
- Devin: same 32 KiB cap, truncated + pointer to source path. https://docs.devin.ai/cli/changelog/stable
- Cursor: "under 500 lines", split into glob-scoped rules; no accuracy data. https://cursor.com/docs/rules
- Anthropic Agent Skills: name+description resident, body on trigger; no published token benchmark. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- MCP spec issue #2808: 11 production tools measured 103–1,024 tok each (5–15× minimal); tiered schemas est. −60–70 %. https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2808

### 2.3 Change representation, not just length — TSCG ✓, Less-is-More, SWE-agent

- TSCG: compile JSON tool schemas → structured text; −52–57 % tokens; Phi-4 14B 0 % → 84.4 % at 20 tools; +5 pp on heavy MCP schemas for frontier models. Ablation: format change explains the gain (R² 0.88), raw compression does not (0.03). https://arxiv.org/abs/2605.04107
- Less-is-More: shortlist tools via embedding k-NN before injecting schemas; Llama3.1-8b fails with 46 tools, succeeds with 19; up to −70–80 % execution time. https://arxiv.org/abs/2411.15399
- Adaptive shortlist depth: ~7 tools matches always-50 coverage (90.3 vs 90.8 %) on BFCL-370; Sonnet 4.6 selection 93.1 vs 87.1 %. https://arxiv.org/abs/2605.24660
- SWE-agent ACI ablations (SWE-bench Lite, GPT-4T): full 18.0 % vs shell-only 10.3 %; file viewer 100 lines 18.0 vs full file 12.7; history collapsed beyond last 5 obs 18.0 vs full 15.0 — smaller observations helped. https://arxiv.org/html/2405.15793v1
- mini-swe-agent: delete the tool layer entirely, bash only, >74 % SWE-bench Verified. https://github.com/SWE-agent/mini-swe-agent
- Anthropic "writing tools for agents": consolidate overlapping tools, `response_format` concise (72 tok) vs detailed (206 tok), eval-driven description rewrites. https://www.anthropic.com/engineering/writing-tools-for-agents

### 2.4 Instruction count is the real variable — IFScale ✓, ManyIFEval ✓

- IFScale: 500 instructions, 20 models; best frontier 68 % at max density; three decay shapes (threshold for reasoning models, linear for gpt-4.1 / claude-sonnet-4, exponential for gpt-4o); bias toward earlier instructions. https://arxiv.org/abs/2507.11538
- ManyIFEval / StyleMBPP: GPT-4o prompt-level 0.94 (1 instr) → 0.21 (10); per-instruction accuracy stays flat, so the loss is conjunctional; logistic regression on count alone predicts held-out combinations within ~10 %. Single rule "chars per line" 97–99 % alone → 2–20 % alongside five others. https://arxiv.org/abs/2509.21051
- System-prompt placement: instructions in the system message adhere worse than the same text in the user message for several frontier models. https://arxiv.org/pdf/2502.12197
- HumanLayer ✓: counted ~50 instructions in Claude Code's system prompt via `ANTHROPIC_BASE_URL` proxy; found the `<system-reminder> may or may not be relevant` wrapper around CLAUDE.md; root CLAUDE.md < 60 lines; "prefer pointers to copies". https://www.humanlayer.dev/blog/writing-a-good-claude-md
- Length as such (total window, not prefix): continuous degradation from ~1K, no cliff. Chroma 18 models https://research.trychroma.com/context-rot ; NoLiMa GPT-4o 99.3 → 69.7 % at 32K https://arxiv.org/abs/2502.05167 ; RULER https://arxiv.org/abs/2404.06654 ; Lost in the Middle https://arxiv.org/abs/2307.03172 ; Same Task More Tokens https://arxiv.org/abs/2402.14848

### 2.5 Measure $/successful task, not tokens — Weinberger & Hozez ✓, Manus

- Token Reduction Is Not Cost Reduction: three compressors vs stock Claude Code; −38.4 % tool-output tokens → +6.8 % billed cost; Pearson r = 0.15 tokens↔cost; cache writes/reads dominate input cost; compression changed trajectories (more retrieval, more turns) and reduced patch success on SWE-bench Go. https://arxiv.org/abs/2607.12161
- Prompt-Induced Waste: prompt wording, effort and harness are interacting factors; token counts are trajectory measurements, not targets. https://arxiv.org/abs/2608.01347
- Manus: KV-cache hit rate as the primary metric; input:output ≈ 100:1; stable prefix, append-only, mask tools instead of removing them. https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Anthropic prompt-caching: hit 0.1× base (0.025× for Fable 5.1 / Mythos 5.1), 5 m write 1.25×, 1 h write 2×; tool definitions sit before the breakpoint, so changing them invalidates the prefix. https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### 2.6 Agent-side context compression (adjacent, for completeness)

- ACON: −26–54 % peak tokens on AppWorld / OfficeBench while improving success. https://arxiv.org/abs/2510.00615
- SWE-Pruner: −23–54 % tokens on SWE-bench Verified with improved success; 0.6B skimmer. https://arxiv.org/abs/2601.16746
- LLMLingua family: 2–20× compression; loss concentrates at high ratios and on weaker target models. https://arxiv.org/abs/2310.05736 ; https://arxiv.org/abs/2310.06839 ; https://arxiv.org/abs/2403.12968
- Selective Context: −50 % tokens at −0.023 BERTScore. https://arxiv.org/abs/2310.06201
- OpenHands condenser: "up to 2× cheaper, no degradation" (abstract only). https://arxiv.org/abs/2511.03690

## 3. Measurement methods in use

| method | who | catches |
|---|---|---|
| fixed task suite, pass-rate per config, retries for variance | Vercel | net effect |
| trigger rate + negative controls (`should_trigger: false`) | OpenAI eval-skills https://developers.openai.com/blog/eval-skills ; Vercel | deferral failures |
| instruction-density sweep | IFScale, ManyIFEval | conjunctional collapse |
| tool-catalog scaling (N tools → selection accuracy) | BFCL, TSCG, Trace-Free+ https://arxiv.org/abs/2602.20426 | tool bloat |
| deterministic trace graders over JSONL | OpenAI Codex | process regressions |
| provider-billed $/success + cache hit rate | Weinberger & Hozez, Manus | fake savings |
| ACI ablation (remove one affordance, rerun) | SWE-agent | which tool text earns its keep |
| real-session eval suite + online A/B | Cursor CursorBench https://cursor.com/blog/cursorbench | product-level regressions |

## 4. Implications for omp's prefix

1. The literature's dominant variable is **instruction count**, not bytes. omp's prefix carries several hundred MUST/NEVER lines (AGENTS.md + core prompt + profile rules). IFScale: ~68 % adherence at 500 for the best models; ManyIFEval: failure is conjunctional, so every added rule taxes every other rule.
2. Bytes are cheap once cached (0.1×, 0.025× on Fable). Weinberger's data says shrinking the prefix can raise cost if it changes trajectories. Measure $/successful task and rule adherence, not chars removed.
3. Deferral works for narrow / vertical content (Rust profiles, release procedure, PR checklist, worker-script history) and fails for horizontal rules the model must apply unprompted (Vercel's 56 % non-invocation). Split AGENTS.md accordingly: path-scoped or skill for vertical, resident for horizontal (Bun-over-Node, test-quality filter, logging).
4. `edit` tool text is a representation problem per TSCG / SWE-agent, not a length problem.
5. Profile rules duplicating the RFC 2119 block: extend `dedupeAlwaysApplyRules` to paragraph containment, or strip the block from the rule files.
6. `cfgSkillful` already exists for the skills list; 43 skills × ~110 chars is the cheapest win but also the one Vercel says reduces trigger rate.

## 5. Gaps

- No public ablation of a coding-agent *system prompt's* length on a coding benchmark.
- No rule-recall "needle" benchmark for CLAUDE.md / AGENTS.md-style files.
- Anthropic's own Claude Code prompt/tool token counts unpublished; third-party figures (~8.2K system, ~18.4K tools) are low confidence. https://cline.bot/blog/clines-context-window-explained-maximize-performance-minimize-cost
- No tool-description *length* ablation holding tool count fixed.
- Amp "handoff beats compaction" and OpenHands "2× no degradation" are second-hand / abstract-only.

Scout transcripts (session-local): `agent://ScoutHarnesses`, `agent://ScoutPapers`, `agent://ScoutPractitioners`. Measurement script was throwaway (`/tmp/prompt-breakdown.ts`); reproduce by building a session via `createAgentSession` and summing `session.systemPrompt` blocks plus `toolWireSchema(tool)` per tool in `session.agent.state.tools`.
