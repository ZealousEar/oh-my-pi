---
name: chipzen-report
description: Use when the user asks about Chipzen leaderboards, season standings, our bot's rating/performance, upcoming fixtures, or how our bot (Thorp-v2 / ChipzenBot) played its recent matches.
---

# Chipzen standings + match review

One command gathers everything (public API, stdlib only, ~10 s; match replays cache in `~/.cache/chipzen-report/`):

```bash
python3 ~/.omp/profile-layer/agent/skills/chipzen-report/report.py </dev/null            # last 3 matches
python3 ~/.omp/profile-layer/agent/skills/chipzen-report/report.py --last 5 --hands </dev/null
```

It prints:
- the ladder top 5 and our hypothetical ladder rank. Our bots have `indexable: false`, so they are **not listed** on the public ladder. Rank = position by rating.
- the live season: entrant count, the playoff cut line, our rank and how many bots share our win count, and all our fixtures with results and scheduled times.
- for each recent match: the result, hands, rated flag, replay URL, our stack low point, postflop bets faced/folded, and preflop jams with how often the opponent folded. Also every pot of 15 BB or more, with our exact equity against the villain's real cards at the point our last chips went in.
- `--hands`: every hand in compact form: `U`=us, `V`=villain, `rais2.0` = **incremental** chips in BB, `Δ` = our net BB.

## Our bots
`bots.json` (next to the script) maps names to bot ids; developer handle **`zealous`**. After a new upload
(every upload is a new bot with a new id), run `report.py --find-dev zealous` (~40 s). It rescans the ladder
and the live season's entrants and rewrites `bots.json`.

## Writing the answer
1. Run the script once and read its output. Re-run only with `--hands` if a match needs hand-level detail.
2. Report: ladder rating/rank, season rank vs the cut line. Seasons rank by wins, then **fewer hands per win**, so slow wins cost places. Then the next fixture with its time.
3. Per match: what decided it (the big pots plus their equity), the opponent's tendency (fold rate to jams, how often we folded to bets), and our leaks. 0% equity on a big loss means we put chips in drawing dead, usually a river value bet into a better hand.
4. Repo context for leaks: `README.md` (strategy) and `HILLCLIMB_STATUS.md` (accepted/rejected changes) in `~/Code/ChipzenBot-hc`.

## Platform facts (DEV-MANUAL §8, checked 2026-11-04)
- Uploads are not versioned. Every upload is a new, independent bot, and an existing bot's image cannot be replaced.
- Season entry is per bot and closes at the season's `registration_deadline` (Monday 23:59 UTC). Round robin runs Tue–Fri, playoffs Sat–Sun. A new upload cannot join a running season; enter it in the next one.
- Free tier: 3 bot slots. Deleting or retiring an entered bot forfeits its season fixtures.
