#!/usr/bin/env python3
"""Reproduce the token-economics tables from local omp telemetry.

Reads only local state:
  ~/.omp/stats.db            per-message usage (14-day windows)
  ~/.omp/agent/agent.db      quota bars (usage_history), model_perf
  ~/.omp/agent/sessions/**   session + subagent transcripts (JSONL)

Writes CSVs next to this script under ../data/. Every table in the
investigation's markdown files is produced here; re-run after a change to
re-baseline. The investigation's published tables used
`--since 2026-08-31 --until 2026-09-14` (stats.db) and transcripts modified in
the 24 days before 2026-09-17.

    python3 docs/investigations/2026-09-token-economics/scripts/analyze.py --since 2026-08-31 --until 2026-09-14
"""
from __future__ import annotations

import argparse
import ast
import csv
import glob
import json
import os
import re
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path

HOME = Path(os.path.expanduser("~/.omp"))
OUT = Path(__file__).resolve().parent.parent / "data"


def wcsv(name: str, header: list[str], rows) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def stats_tables(since_ms: int, until_ms: int, tag: str) -> tuple[float, dict[str, list[int]]]:
    sdb = sqlite3.connect(HOME / "stats.db")
    W = f"timestamp > {since_ms} and timestamp <= {until_ms}"
    q = lambda s: sdb.execute(s).fetchall()
    days = tag

    wcsv(
        f"{days}d-by-model.csv",
        ["provider", "model", "messages", "input_M", "cache_read_M", "output_M", "nominal_usd", "errors"],
        [
            (r[0], r[1], r[2], round(r[3], 1), round(r[4], 1), round(r[5], 2), round(r[6] or 0), r[7])
            for r in q(
                f"""select provider, model, count(*), sum(input_tokens)/1e6, sum(cache_read_tokens)/1e6,
                sum(output_tokens)/1e6, sum(cost_total),
                sum(case when error_message is not null and error_message!='' then 1 else 0 end)
                from messages where {W} group by provider, model order by 7 desc"""
            )
        ],
    )
    wcsv(
        f"{days}d-by-agent-type.csv",
        ["agent_type", "messages", "input_M", "cache_read_M", "cache_write_M", "output_M", "avg_ctx"],
        [
            (r[0], r[1], round(r[2], 1), round(r[3], 1), round(r[4], 1), round(r[5], 2), int(r[6]))
            for r in q(
                f"""select agent_type, count(*), sum(input_tokens)/1e6, sum(cache_read_tokens)/1e6,
                sum(cache_write_tokens)/1e6, sum(output_tokens)/1e6,
                avg(input_tokens+cache_read_tokens+cache_write_tokens) from messages where {W} group by agent_type"""
            )
        ],
    )
    bands = [(0, 50e3), (50e3, 100e3), (100e3, 200e3), (200e3, 300e3), (300e3, 500e3), (500e3, 2e6)]
    wcsv(
        f"{days}d-main-context-distribution.csv",
        ["ctx_lo_k", "ctx_hi_k", "turns", "tokens_M"],
        [
            (int(lo / 1e3), int(hi / 1e3), r[0], round(r[1] or 0, 1))
            for lo, hi in bands
            for r in q(
                f"""select count(*), sum(input_tokens+cache_read_tokens+cache_write_tokens)/1e6 from messages
                where {W} and agent_type='main' and input_tokens+cache_read_tokens+cache_write_tokens between {lo} and {hi}"""
            )
        ],
    )
    peaks = [(0, 150e3), (150e3, 300e3), (300e3, 500e3), (500e3, 2e6)]
    wcsv(
        f"{days}d-sessions-by-peak.csv",
        ["peak_lo_k", "peak_hi_k", "sessions", "tokens_B", "turns"],
        [
            (int(lo / 1e3), int(hi / 1e3), r[0], round((r[1] or 0) / 1e9, 2), r[2] or 0)
            for lo, hi in peaks
            for r in q(
                f"""select count(*), sum(tok), sum(turns) from (select session_file,
                max(input_tokens+cache_read_tokens+cache_write_tokens) mx,
                sum(input_tokens+cache_read_tokens+cache_write_tokens) tok, count(*) turns
                from messages where {W} and agent_type='main' group by session_file) where mx between {lo} and {hi}"""
            )
        ],
    )

    # cache-write anatomy by idle gap (Anthropic main turns; >50k cache_write = prefix rebuild)
    rows = q(
        f"""select session_file, timestamp, cache_write_tokens, model from messages
        where {W} and agent_type='main' and provider='anthropic' order by session_file, timestamp"""
    )
    prev: dict[str, tuple[int, str]] = {}
    gaps: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    allturns: Counter = Counter()
    for s, t, cw, m in rows:
        if s in prev:
            pt, pm = prev[s]
            gap = (t - pt) / 1000
            k = "<1m" if gap < 60 else "1-5m" if gap < 300 else "5-15m" if gap < 900 else "15-60m" if gap < 3600 else ">1h"
            allturns[k] += 1
            if cw > 50000 and m == pm:
                gaps[k][0] += 1
                gaps[k][1] += cw
        prev[s] = (t, m)
    wcsv(
        f"{days}d-cache-write-by-idle-gap.csv",
        ["gap", "turns", "prefix_rebuilds", "rebuild_rate_pct", "rebuild_tokens_M"],
        [
            (k, allturns[k], gaps[k][0], round(gaps[k][0] / max(1, allturns[k]) * 100), round(gaps[k][1] / 1e6))
            for k in ["<1m", "1-5m", "5-15m", "15-60m", ">1h"]
        ],
    )

    # per-session main context series for the compaction simulation
    series = q(
        f"""select session_file, input_tokens+cache_read_tokens+cache_write_tokens from messages
        where {W} and agent_type='main' order by session_file, timestamp"""
    )
    sess: dict[str, list[int]] = defaultdict(list)
    for s, c in series:
        sess[s].append(c)
    actual = sum(c for _, c in series)
    return actual, sess


def sim_main(sess: dict[str, list[int]], th: float, keep: float, base: int = 34000) -> tuple[int, int]:
    """Replay each session's per-turn context growth; reset to base+keep when > th."""
    tot = comps = 0
    for cs in sess.values():
        cur = None
        prev = 0
        for c in cs:
            cur = c if cur is None else cur + max(0, c - prev)
            prev = c
            if cur > th:
                comps += 1
                cur = base + keep
            tot += cur
    return tot, comps


# --------------------------------------------------------------------------- agent.db


def quota_tables() -> None:
    con = sqlite3.connect(HOME / "agent" / "agent.db")
    rows = con.execute(
        """select provider, email, label, window_label, max(used_fraction) from usage_history
        where recorded_at > (select max(recorded_at) from usage_history) - 7*86400000
        group by provider, email, label order by 1,2,3"""
    ).fetchall()
    # Accounts are published as an opaque per-provider index, never an email fragment.
    index: dict[tuple[str, str], int] = {}
    out = []
    for provider, email, label, window, frac in rows:
        key = (provider, email or "")
        index.setdefault(key, len([k for k in index if k[0] == provider]) + 1)
        out.append((provider, f"acct{index[key]}", label, window, frac))
    wcsv("7d-quota-snapshot.csv", ["provider", "account", "label", "window", "max_used_fraction"], out)
    wcsv(
        "model-perf.csv",
        ["model", "samples", "tok_per_s", "ttft_s"],
        [
            (mk, s, round(ot / gm * 1000, 1) if gm else 0, round(tm / ts / 1000, 1) if ts else 0)
            for mk, s, ot, gm, ts, tm in con.execute(
                "select model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms from model_perf order by samples desc"
            )
        ],
    )


# --------------------------------------------------------------------------- transcripts


def parse_args(a):
    if isinstance(a, dict):
        return a
    if not isinstance(a, str):
        return {}
    for fn in (json.loads, ast.literal_eval):
        try:
            v = fn(a)
            return v if isinstance(v, dict) else {}
        except Exception:
            pass
    return {}


def classify(tools: list[str]) -> str:
    if not tools:
        return "text-only"
    if all(x == "hub" for x in tools):
        return "hub-only"
    if all(x == "todo" for x in tools):
        return "todo-only"
    if all(x in ("read", "glob", "grep") for x in tools):
        return "read/search"
    if all(x in ("bash", "eval") for x in tools):
        return "bash/eval"
    if any(x in ("edit", "write") for x in tools):
        return "edit/write"
    if any(x == "task" for x in tools):
        return "task-spawn"
    return "other"


def transcript_tables(days: int) -> None:

    cutoff = time.time() - days * 86400
    files = [
        f
        for f in glob.glob(str(HOME / "agent" / "sessions" / "**" / "*.jsonl"), recursive=True)
        if os.path.getmtime(f) > cutoff and "__advisor" not in f
    ]
    turns: list[dict] = []
    spawns: list[dict] = []
    for f in files:
        base = os.path.basename(f)
        kind = "main" if base.startswith("20") else "sub"
        sid = base[:-6] if kind == "main" else os.path.basename(os.path.dirname(f))
        agent = "main" if kind == "main" else base[:-6]
        proj = f.split("/sessions/")[1].split("/")[0]
        level = "?"
        with open(f, errors="ignore") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("type") == "thinking_level_change":
                    level = e.get("thinkingLevel") or e.get("level") or "?"
                    continue
                if e.get("type") != "message":
                    continue
                m = e["message"]
                if m.get("role") != "assistant":
                    continue
                u = m.get("usage") or {}
                tools = [c for c in m.get("content", []) if c.get("type") == "toolCall"]
                text = sum(len(c.get("text", "")) for c in m.get("content", []) if c.get("type") == "text")
                args = []
                ylen = 0
                ctx = (u.get("input", 0) or 0) + (u.get("cacheRead", 0) or 0) + (u.get("cacheWrite", 0) or 0)
                for c in tools:
                    a = parse_args(c.get("arguments"))
                    args.append((c.get("name"), a))
                    if c.get("name") == "yield":
                        ylen = len(json.dumps(a))
                    if c.get("name") == "task":
                        spawns.append(dict(sid=sid, ctx=ctx, n=len(a.get("tasks") or []) or 1))
                turns.append(
                    dict(
                        kind=kind, proj=proj, sid=sid, agent=agent, ts=m.get("timestamp", 0), model=m.get("model"),
                        provider=m.get("provider"), level=level, reason=u.get("reasoningTokens", 0) or 0,
                        out=u.get("output", 0) or 0, ctx=ctx, tools=[c.get("name") for c in tools], textlen=text,
                        ylen=ylen, args=args, cls=classify([c.get("name") for c in tools]),
                    )
                )
    mains = [t for t in turns if t["kind"] == "main"]
    subs = [t for t in turns if t["kind"] == "sub"]
    levels = ["low", "medium", "high", "xhigh", "max"]
    classes = ["bash/eval", "read/search", "edit/write", "hub-only", "text-only", "other", "todo-only", "task-spawn"]

    wcsv(
        f"{days}d-main-turns-by-class.csv",
        ["class", "turns", "ctx_B", "out_M", "ctx_per_out"],
        [
            (
                c,
                sum(1 for t in mains if t["cls"] == c),
                round(sum(t["ctx"] for t in mains if t["cls"] == c) / 1e9, 2),
                round(sum(t["out"] for t in mains if t["cls"] == c) / 1e6, 2),
                round(sum(t["ctx"] for t in mains if t["cls"] == c) / max(1, sum(t["out"] for t in mains if t["cls"] == c))),
            )
            for c in classes
        ],
    )
    wcsv(
        f"{days}d-main-turns-by-level.csv",
        ["level", "turns", "ctx_B", "out_M"],
        [
            (l, len([t for t in mains if t["level"] == l]), round(sum(t["ctx"] for t in mains if t["level"] == l) / 1e9, 2),
             round(sum(t["out"] for t in mains if t["level"] == l) / 1e6, 2))
            for l in levels
        ],
    )

    def med(c: str, l: str) -> int:
        xs = sorted(t["out"] for t in mains if t["cls"] == c and t["level"] == l and t["provider"] == "anthropic")
        return xs[len(xs) // 2] if xs else 0

    wcsv(
        f"{days}d-anthropic-median-output-by-class-level.csv",
        ["class"] + levels,
        [[c] + [med(c, l) for l in levels] for c in ["hub-only", "todo-only", "read/search", "bash/eval", "edit/write", "text-only"]],
    )
    wcsv(f"{days}d-spawn-batch-sizes.csv", ["tasks_per_call", "calls"], sorted(Counter(min(s["n"], 8) for s in spawns).items()))

    # subagent runs with duplication vs parent
    def reads(ts):
        s = set()
        for t in ts:
            for n, a in t["args"]:
                if n == "read" and isinstance(a.get("path"), str):
                    s.add(re.sub(r":[^/]*$", "", a["path"]).split("?")[0])
        return s

    mainby: dict[str, list[dict]] = defaultdict(list)
    for t in mains:
        mainby[t["sid"]].append(t)
    byrun: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for t in subs:
        byrun[(t["sid"], t["agent"])].append(t)
    rows = []
    for (sid, agent), ts in byrun.items():
        ts.sort(key=lambda t: t["ts"])
        start, end = ts[0]["ts"], ts[-1]["ts"]
        sr = reads(ts)
        mr_after = reads([t for t in mainby.get(sid, []) if t["ts"] > end])
        mr_before = reads([t for t in mainby.get(sid, []) if t["ts"] < start])
        rows.append(
            dict(
                proj=ts[0]["proj"], agent=agent, model=Counter(t["model"] for t in ts).most_common(1)[0][0], turns=len(ts),
                tok=sum(t["ctx"] for t in ts), out=sum(t["out"] for t in ts), reads=len(sr), dup_before=len(sr & mr_before),
                dup_after=len(sr & mr_after), final=max(ts[-1]["ylen"], ts[-1]["textlen"]), mins=round((end - start) / 60000, 1),
                has_parent=sid in mainby,
            )
        )
    keep_cols = ["proj", "agent", "model", "turns", "tok", "out", "reads", "dup_before", "dup_after", "final", "mins"]
    wcsv(
        f"{days}d-subagent-runs.csv",
        keep_cols,
        [[r[c] for c in keep_cols] for r in sorted((r for r in rows if r["has_parent"]), key=lambda r: -r["tok"])],
    )

    # subagent cap simulation on per-run context series
    runs = {k: [t["ctx"] for t in sorted(v, key=lambda t: t["ts"])] for k, v in byrun.items() if len(v) >= 2}
    actual = sum(sum(v) for v in runs.values())

    def sim_sub(ctx_cap=None, keep=24000, turn_cap=None, handoff=8000, penalty_steps=28, base=12000):
        tot = compacts = handoffs = affected = 0
        for v in runs.values():
            cur = prev = v[0]
            n = 0
            hit = False
            g = max(1000, (v[-1] - v[0]) / max(1, len(v) - 1))
            for i, c in enumerate(v):
                if i > 0:
                    cur += max(0, c - prev)
                prev = c
                n += 1
                if ctx_cap and cur > ctx_cap:
                    compacts += 1
                    cur = base + keep
                    hit = True
                tot += cur
                if turn_cap and n >= turn_cap and i < len(v) - 1:
                    handoffs += 1
                    hit = True
                    cur = base + handoff
                    n = 0
                    tot += sum(base + handoff + g * k for k in range(1, penalty_steps + 1))
            affected += hit
        return tot, compacts, handoffs, affected

    policies = [
        ("ctx96k/24k", dict(ctx_cap=96e3)), ("ctx150k/32k", dict(ctx_cap=150e3, keep=32e3)), ("ctx200k/48k", dict(ctx_cap=200e3, keep=48e3)),
        ("turn48+handoff", dict(turn_cap=48)), ("turn90+handoff", dict(turn_cap=90)),
        ("ctx150k/32k+turn90", dict(ctx_cap=150e3, keep=32e3, turn_cap=90)), ("ctx200k/48k+turn120", dict(ctx_cap=200e3, keep=48e3, turn_cap=120)),
        ("turn48+handoff P=10", dict(turn_cap=48, penalty_steps=10)), ("turn48+handoff P=55", dict(turn_cap=48, penalty_steps=55)),
    ]
    out = [("none", round(actual / 1e9, 2), 0, 0, 0, 0)]
    for lbl, kw in policies:
        t, cm, h, a = sim_sub(**kw)
        out.append((lbl, round(t / 1e9, 2), round((t / actual - 1) * 100), cm, h, a))
    wcsv("sim-subagent-caps.csv", ["policy", "tokens_B", "delta_pct", "compactions", "handoffs", "runs_affected"], out)


# --------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="stats.db window start, YYYY-MM-DD (default: --until minus --days)")
    ap.add_argument("--until", help="stats.db window end, YYYY-MM-DD (default: now)")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--transcript-days", type=int, default=24)
    a = ap.parse_args()
    until_ms = int((time.mktime(time.strptime(a.until, "%Y-%m-%d")) if a.until else time.time()) * 1000)
    since_ms = int(time.mktime(time.strptime(a.since, "%Y-%m-%d")) * 1000) if a.since else until_ms - a.days * 86400000

    actual, sess = stats_tables(since_ms, until_ms, str(a.days))
    sims = [("none", "", round(actual / 1e9, 2), 0, 0)]
    for th, keep in ((150e3, 20e3), (180e3, 48e3), (200e3, 48e3), (250e3, 60e3), (300e3, 60e3), (400e3, 60e3)):
        t, cn = sim_main(sess, th, keep)
        sims.append((int(th / 1e3), int(keep / 1e3), round(t / 1e9, 2), round((1 - t / actual) * 100), round(cn / len(sess), 1)))
    wcsv("sim-main-compaction.csv", ["threshold_k", "keep_k", "main_tokens_B", "saving_pct", "compactions_per_session"], sims)
    quota_tables()
    transcript_tables(a.transcript_days)
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
