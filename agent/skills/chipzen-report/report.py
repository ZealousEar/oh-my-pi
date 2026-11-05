#!/usr/bin/env python3
"""Chipzen standings + recent-match report for our bots (stdlib only).

    python3 report.py                     # ladder + live season + last 3 matches of every bot in bots.json
    python3 report.py --last 5 --hands    # also print every hand of each match
    python3 report.py --bot Thorp-v2      # one bot only
    python3 report.py --find-dev zealous  # rescan ladder + live season entrants for this developer, save to bots.json

Public API only (https://chipzen.ai/api), ~1 req/s. Matches are immutable and cached in
~/.cache/chipzen-report/. Replay amounts are incremental chips per action; this script reports
everything in big blinds at the hand's blind level.
"""
import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from itertools import combinations
from pathlib import Path

BASE = "https://chipzen.ai/api"
UA = "ChipzenBot-scout/1.0 (owner-approved; contact via chipzen account)"
HERE = Path(__file__).resolve().parent
BOTS_FILE = HERE / "bots.json"
CACHE = Path.home() / ".cache" / "chipzen-report"
_last = [0.0]


def get(path):
    for attempt in range(4):
        wait = 0.7 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        req = urllib.request.Request(BASE + path, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(2 ** attempt)
    raise RuntimeError(f"gave up on {path}")


def cached_match(mid):
    p = CACHE / f"{mid}.json"
    if p.exists():
        return json.loads(p.read_text())
    meta, rep = get(f"/matches/{mid}"), get(f"/matches/{mid}/replay")
    obj = {"match": meta, "replay": rep}
    if meta and meta.get("status") == "completed" and rep:
        CACHE.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, separators=(",", ":")))
    return obj


# ---------- exact / sampled hold'em equity ----------
RANKS = "23456789TJQKA"


def _rank5(cards):
    rs = sorted((RANKS.index(c[0]) for c in cards), reverse=True)
    flush = len({c[1] for c in cards}) == 1
    groups = sorted(Counter(rs).items(), key=lambda t: (t[1], t[0]), reverse=True)
    u = sorted(set(rs), reverse=True)
    straight = None
    if len(u) == 5 and u[0] - u[4] == 4:
        straight = u[0]
    elif u == [12, 3, 2, 1, 0]:
        straight = 3
    if straight is not None and flush:
        return (8, straight)
    if groups[0][1] == 4:
        return (7, groups[0][0], groups[1][0])
    if groups[0][1] == 3 and groups[1][1] == 2:
        return (6, groups[0][0], groups[1][0])
    if flush:
        return (5, *rs)
    if straight is not None:
        return (4, straight)
    order = [r for r, _ in groups]
    if groups[0][1] == 3:
        return (3, *order)
    if groups[0][1] == 2 and groups[1][1] == 2:
        return (2, *order)
    if groups[0][1] == 2:
        return (1, *order)
    return (0, *rs)


def _best(cards):
    return max(_rank5(c) for c in combinations(cards, 5))


def equity(hero, villain, board, samples=1500):
    """Hero's share of the pot vs one known hand. Exact from the flop on, sampled preflop."""
    deck = [r + s for r in RANKS for s in "shdc" if r + s not in hero + villain + board]
    need = 5 - len(board)
    rng = random.Random(0)
    runs = (list(combinations(deck, need)) if need <= 2
            else [rng.sample(deck, need) for _ in range(samples)])
    score = 0.0
    for rest in runs:
        b = board + list(rest)
        h, v = _best(hero + b), _best(villain + b)
        score += 1.0 if h > v else 0.5 if h == v else 0.0
    return score / len(runs)


# ---------- match analysis ----------
def analyse(obj, bot_name, show_hands):
    meta, rep = obj["match"], obj["replay"]
    us = next(p["seat"] for p in meta["participants"] if p["name"] == bot_name)
    opp = next(p for p in meta["participants"] if p["seat"] != us)
    hands = rep["hands"]
    start = {s["seat"]: s["starting_stack"] for s in hands[0]["starting_stacks"]}[us]
    traj = [h["stacks_after"].get(str(us), 0) for h in hands]
    low = min(traj)
    faced = folded = 0
    jams = jam_folds = 0
    big, lines = [], []
    for h in hands:
        bb = h["blinds"]["big_blind"]
        stacks = {s["seat"]: s["starting_stack"] for s in h["starting_stacks"]}
        eff = min(stacks.values()) / bb
        hero = h["hole_cards"].get(str(us), [])
        vill = h["hole_cards"].get(str(1 - us), [])
        delta = (h["stacks_after"].get(str(us), 0) - stacks.get(us, 0)) / bb
        board, last_in_board, street_txt = [], None, []
        for s in h["streets"]:
            acts = s["actions"]
            if s["street"] != "preflop":
                board = list(s["community_cards"]) if len(s["community_cards"]) >= 3 else board + s["community_cards"]
            for i, a in enumerate(acts):
                mine = a["seat"] == us
                if mine and a["action_type"] in ("call", "raise", "bet"):
                    last_in_board = list(board)
                if s["street"] != "preflop" and not mine and a["action_type"] in ("bet", "raise") \
                        and i + 1 < len(acts) and acts[i + 1]["seat"] == us:
                    faced += 1
                    folded += acts[i + 1]["action_type"] == "fold"
                if s["street"] == "preflop" and mine and a["action_type"] == "raise" \
                        and a.get("amount", 0) >= 0.9 * stacks[us]:
                    jams += 1
                    nxt = acts[i + 1] if i + 1 < len(acts) else None
                    jam_folds += bool(nxt and nxt["action_type"] == "fold")
            txt = " ".join(("U" if a["seat"] == us else "V") + a["action_type"][:4]
                           + (f"{a['amount'] / bb:.1f}" if a.get("amount") else "")
                           for a in acts if not a["action_type"].startswith("post"))
            street_txt.append(f"{s['street'][:2]}{''.join(s['community_cards'])}:{txt}")
        line = (f"#{h['hand_number']:>3} bb{bb:<5} eff{eff:6.1f} U{''.join(hero)} V{''.join(vill)} "
                f"Δ{delta:+7.1f} | " + " ; ".join(street_txt))
        lines.append(line)
        if abs(delta) >= 15 and hero and vill and last_in_board is not None:
            big.append((h["hand_number"], delta, equity(hero, vill, last_in_board), line))
    won = meta["participants"][[p["seat"] for p in meta["participants"]].index(us)]["net_chips"] > 0
    print(f"\n--- vs {opp['name']}: {'WIN' if won else 'LOSS'} in {len(hands)} hands "
          f"({meta.get('completed_at', '')[:16]}Z, rated={meta.get('rated')}) "
          f"https://chipzen.ai/match/{meta['id']}")
    print(f"    stack low {low} at hand {traj.index(low) + 1} (start {start}); "
          f"postflop bets faced {faced}, folded {folded}; preflop jams {jams}, opponent folded {jam_folds}")
    for n, d, eq, line in big:
        print(f"    big pot #{n}: {d:+.1f} BB, our equity when our last chips went in {eq:.0%}")
        print(f"      {line}")
    if show_hands:
        print("\n".join("      " + l for l in lines))


def get_ladder():
    entries, page = [], 1
    while True:
        r = get(f"/leaderboard/standings?page={page}&page_size=100&sort=rating&division=sandboxed")
        entries += r["entries"]
        if len(entries) >= r["total"] or not r["entries"]:
            return entries
        page += 1


# ---------- report ----------
def find_dev(dev):
    found = {}
    ladder = get_ladder()
    for e in ladder:
        if e.get("creator_name") == dev:
            found[e["bot_name"]] = e["bot_id"]
    comps = get("/competitions") or []
    live = next((c for c in comps if c["state"] != "complete"), None)
    if live:
        known = {e["bot_id"] for e in ladder}
        for r in get(f"/competitions/{live['number']}/standings")["rows"]:
            if r["bot_id"] in known and r["bot_name"] not in found:
                continue
            p = get(f"/leaderboard/profile/{r['bot_id']}")
            if p and p.get("developer_name") == dev:
                found[p["name"]] = p["bot_id"]
    BOTS_FILE.write_text(json.dumps({"developer": dev, "bots": found}, indent=1) + "\n")
    print(f"saved {len(found)} bot(s) for {dev}: {found}")


def report(bots, last, show_hands):
    ladder = get_ladder()
    comps = get("/competitions") or []
    live = next((c for c in comps if c["state"] != "complete"), comps[0] if comps else None)
    season = fixtures = None
    if live:
        season = get(f"/competitions/{live['number']}/standings")
        fixtures = (get(f"/competitions/{live['number']}/fixtures") or {}).get("fixtures") or []
    print(f"Ladder (sandboxed): {len(ladder)} listed bots. Top 5: "
          + ", ".join(f"{e['bot_name']} {e['rating']:.0f}" for e in ladder[:5]))
    if live:
        rows = season["rows"]
        q = season.get("playoff_qualifiers") or 8
        cut = rows[q - 1] if len(rows) >= q else None
        print(f"Season {live['number']} ({live['state']}): {len(rows)} entrants, top {q} to playoffs, "
              f"registration closed {live['registration_deadline']}, playoffs end {live['playoffs_end_at']}")
        if cut:
            print(f"  cut line #{q}: {cut['bot_name']} {cut['wins']}-{cut['losses']}, {cut['hands_in_wins']} hands in wins")
    for name, bid in bots.items():
        prof = get(f"/leaderboard/profile/{bid}")
        if not prof:
            print(f"\n=== {name}: profile not found")
            continue
        rank = 1 + sum(e["rating"] > prof["rating"] for e in ladder if e["bot_id"] != bid)
        listed = any(e["bot_id"] == bid for e in ladder)
        print(f"\n=== {name} ({prof['status']}, activated {str(prof.get('activated_at'))[:16]}) "
              f"rating {prof['rating']:.0f} -> {'#' if listed else '~#'}{rank} of {len(ladder) + (not listed)} "
              f"{'' if listed else '(not listed on the public ladder) '}| {prof['wins']}-{prof['losses']}, "
              f"{prof['bb_per_100']:+.1f} bb/100 over {prof['bb_hands_counted']} hands"
              f"{' (provisional)' if prof.get('bb_per_100_provisional') else ''}")
        if season:
            row = next((r for r in season["rows"] if r["bot_id"] == bid), None)
            if row:
                same = [r for r in season["rows"] if r["wins"] == row["wins"]]
                print(f"  season #{row['rank']}: {row['wins']}-{row['losses']}, {row['hands_in_wins']} hands in wins "
                      f"({same.index(row) + 1} of {len(same)} on {row['wins']} wins)")
                mine = [f for f in fixtures if bid in (f["bot_a_id"], f["bot_b_id"])]
                for f in mine:
                    opp = f["bot_b_name"] if f["bot_a_id"] == bid else f["bot_a_name"]
                    res = ("W" if f["winner_bot_id"] == bid else "L") if f["state"] == "completed" else f["state"]
                    print(f"    R{f['round_index'] + 1} {f['scheduled_at'][:16]}Z vs {opp:22} {res}")
            else:
                print("  not entered in the live season")
        for r in (prof.get("recent_results") or [])[:last]:
            analyse(cached_match(r["match_id"]), name, show_hands)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--last", type=int, default=3)
    ap.add_argument("--hands", action="store_true", help="print every hand of each match")
    ap.add_argument("--bot", help="only this bot name from bots.json")
    ap.add_argument("--find-dev", help="rediscover our bots by developer handle and save bots.json")
    args = ap.parse_args()
    if args.find_dev:
        find_dev(args.find_dev)
        return 0
    bots = json.loads(BOTS_FILE.read_text())["bots"]
    if args.bot:
        bots = {args.bot: bots[args.bot]}
    report(bots, args.last, args.hands)
    return 0


if __name__ == "__main__":
    sys.exit(main())
