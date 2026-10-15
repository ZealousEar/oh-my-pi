
# Research brief: reasoning-effort lapses and subagent value in one power user's omp coding-agent telemetry

You are acting as a scientific researcher. Data below is parsed from 1,261 session transcripts (last 24 days, 83,637 assistant turns: 44,061 main-session, 39,572 subagent). "ctx" = input + cache-read + cache-write tokens billed per turn. "out" = output tokens (for Anthropic models this INCLUDES thinking tokens; for OpenAI Codex models thinking is reported separately as reasoningTokens and is small: mean ≈100/turn, ≤1% of tokens). Turn classes are by the tools called in that turn: hub-only = only `hub` (peer messaging / wait for background jobs), todo-only = only the todo list tool, read/search = only read/grep/glob, bash/eval = shell or code eval, edit/write = any file edit, text-only = no tool call.

## Main-session turns by class
| class | turns | ctx | out | ctx per output token |
|---|---|---|---|---|
| bash/eval | 16411 | 3.95B | 10.34M | 382 |
| read/search | 10280 | 1.79B | 3.40M | 525 |
| edit/write | 5459 | 1.31B | 6.77M | 193 |
| hub-only | 3475 | 0.86B | 1.06M | 817 |
| text-only | 2907 | 0.53B | 2.46M | 215 |
| other | 2553 | 0.44B | 2.08M | 211 |
| todo-only | 1346 | 0.25B | 0.40M | 623 |
| task-spawn | 339 | 0.07B | 0.96M | 73 |

`hub` ops inside hub-only turns: wait 2,202; send 651; start 195; logs 181; jobs 135; list 73; cancel 34; stop 26. Parent context at the moment a subagent is spawned: median 161k tokens.

## Main-session turns by configured thinking level
| level | turns | ctx | out |
|---|---|---|---|
| low | 2412 | 0.42B | 0.85M |
| medium | 11875 | 2.93B | 6.75M |
| high | 9037 | 1.71B | 6.90M |
| xhigh | 4361 | 1.13B | 3.95M |
| max | 14923 | 2.98B | 8.93M |

## Median output tokens (incl. thinking) per turn, Anthropic models, by class × thinking level
| class | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| hub-only | 133 | 136 | 139 | 139 | 136 |
| todo-only | 97 | 150 | 165 | 209 | 290 |
| read/search | 185 | 185 | 249 | 231 | 209 |
| bash/eval | 376 | 407 | 456 | 543 | 659 |
| edit/write | 684 | 697 | 765 | 1096 | 722 |
| text-only | 452 | 624 | 855 | 963 | 994 |

Trivial (hub-only/todo-only) turns run at xhigh/max: 2,043 turns, 0.43B ctx, 0.63M out.

## Subagents (853 runs with parent transcript available)
- Share: 39% of all context tokens, 56% of all output tokens. ctx per output token: main 335, subagent 167.
- Per run: turns p50 31 / p90 92 / max 639; tokens p50 2.15M / p90 15.2M / max 238M; wall time p50 7 min / p90 45 min; final report (yield payload) p50 3.5k chars / p90 18.5k.
- File-read duplication: subagent re-read files the parent had already read: mean 12% of its reads (58 of 756 runs ≥50% duplicated, 0.24B tokens). Parent re-read the subagent's files after it finished: mean 7% (24 runs ≥50%, 0.13B).
- Overhead-dominated runs (≤8 turns): 82 runs, 23M tokens total — negligible.
- Runs with no yield/final output at all: 48 runs, 0.18B tokens.
- Runs >2M tokens that returned <800 chars: 81 runs, 0.74B tokens. Largest:
                                                     proj                   agent  turns       tok  final        mins
210                                        -Code-ChessBot            CudaPipeline    348  45676653    445  191.751100
173                                        -Code-ChessBot                NNUEEval    182  41546474      0   82.945017
157                                        -Code-ChessBot  compiled-qualification    296  40275032    260  140.505750
215                                        -Code-ChessBot            ValidateTool    177  36346660    141  848.974883
33                                         -Code-ChessBot         AuthorityReview    252  29160176     32   58.532017
791  -Code-Agentic Obsidian Vault-Agentic-dissertation-v2                  LaneA3    118  27840418    166   41.857133
207                                        -Code-ChessBot          LabelStockfish    228  27085018    300   71.623017
147                                        -Code-ChessBot       compiled-deadline    193  25463130    460  137.477117
- Long tail: 87 runs >90 turns = 3.40B of 5.84B subagent tokens (58%). Largest:
                                                     proj            agent  turns        tok  reads  final        mins           model
414                                        -Code-ChessBot    CampaignInfra    639  238056891     16   3543  653.802867   claude-opus-5
415                                        -Code-ChessBot     DefenseTrace    437  196497857     21   8608  318.299783   claude-opus-5
172                                        -Code-ChessBot   FieldEstimator    433  174000108      5   8387  246.101567   claude-opus-5
408                                        -Code-ChessBot  TeacherProtocol    332  143515650     16   8066  585.135100   claude-opus-5
554  -Code-Agentic Obsidian Vault-Agentic-dissertation-v2        p06-draft    273  123698847     18   5817   98.463583  claude-fable-5
410                                        -Code-ChessBot        PanelBank    353   99958291     63   1696  702.610683     gpt-6-astra
42                                         -Code-ChessBot         Endgames    286   89028233     17   2437  104.492750   claude-opus-5
254                                        -Code-ChessBot      HarnessLane    270   86563736     21   8082   76.976333   claude-opus-5
- Spawn batch sizes (tasks per `task` call): 1→126 calls, 2→113, 3→51, 4→31, 5→12, 6→11, 7→2, 8→8. i.e. 36% of spawns had no parallelism, only isolation.
- Subagents start fresh (~11k median first-turn context); they inherit the parent's compaction settings (effective threshold ≈850k on 1M models — compaction rarely fires).

## Earlier findings (same user)
- Main sessions: 33 of 124 sessions exceeded 300k context and account for 65% of main tokens; p50 main context 174k.
- Cache hit 97%; nominal $ split cache-read 64%, cache-write 19%, output 14%, input 4%.
- LangWatch case study (287k calls): cost ∝ C^2.5, active context per step 6–8.5k regardless of window, post-compaction correction rate 41.9% vs 17.7% baseline, cost-optimal compaction threshold 220–240k, subagent step count unpredictable (p99 359).

## Questions
1. Identify the obvious lapses: turns or patterns where the marginal benefit is plausibly <5% but token cost is materially higher. Quantify each from the tables (tokens and % of total) and state the mechanism.
2. Does the thinking level (low…max) measurably change behaviour on trivial turns here? What does the class × level table imply about where effort settings matter and where they are pure cost? Be careful: Anthropic output includes thinking, and we cannot observe quality.
3. Subagents: where did they demonstrably help (token efficiency, isolation, parallelism) and where did they not (long-tail runs that behave like unbounded main sessions, empty-result runs, single-task spawns)? Estimate the counterfactual: what would the same work have cost inline in the parent at its median 161k context?
4. Give a ranked list of interventions with expected token savings (absolute and %), each labelled data-supported vs inference, and any that you would NOT do because the quality risk outweighs the saving.
5. What additional measurement would resolve the biggest remaining uncertainty (we cannot observe task quality)?
Be concrete and quantitative. No filler.
