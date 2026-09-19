#!/usr/bin/env python3
"""Reproduce the token-economics tables from local omp telemetry.

Legacy mode reads:
  ~/.omp/stats.db            per-message usage
  ~/.omp/agent/agent.db      quota bars (usage_history), model_perf
  ~/.omp/agent/sessions/**   session + subagent transcripts (JSONL)

Legacy mode writes CSVs under ../data/ and is NOT privacy-safe: transcript
tables can contain project/session/agent metadata. Use ``--safe-baseline`` for
the metadata-only, fail-closed report; that mode never reads transcripts,
quota/account rows, raw paths, or raw session identifiers.

The investigation's published legacy tables used:

    python3 docs/investigations/2026-09-token-economics/scripts/analyze.py --since 2026-08-31 --until 2026-09-14
"""
from __future__ import annotations

import argparse
import ast
import csv
import glob
import json
import math
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

HOME = Path(os.path.expanduser("~/.omp"))
OUT = Path(__file__).resolve().parent.parent / "data"

REPO = Path(__file__).resolve().parents[4]
CATALOG = REPO / "packages" / "catalog" / "src" / "models.json"
UNKNOWN = "__unknown__"

# Pinned messages columns from packages/stats/src/db.ts. Known ALTER migrations
# may change order and add a default to premium_requests; other drift is
# rejected before processing metadata.
EXPECTED_MESSAGE_SCHEMA = (
    ("id", "INTEGER", 0, None, 1),
    ("session_file", "TEXT", 1, None, 0),
    ("entry_id", "TEXT", 1, None, 0),
    ("folder", "TEXT", 1, None, 0),
    ("model", "TEXT", 1, None, 0),
    ("provider", "TEXT", 1, None, 0),
    ("api", "TEXT", 1, None, 0),
    ("timestamp", "INTEGER", 1, None, 0),
    ("duration", "INTEGER", 0, None, 0),
    ("ttft", "INTEGER", 0, None, 0),
    ("stop_reason", "TEXT", 1, None, 0),
    ("error_message", "TEXT", 0, None, 0),
    ("input_tokens", "INTEGER", 1, None, 0),
    ("output_tokens", "INTEGER", 1, None, 0),
    ("cache_read_tokens", "INTEGER", 1, None, 0),
    ("cache_write_tokens", "INTEGER", 1, None, 0),
    ("total_tokens", "INTEGER", 1, None, 0),
    ("premium_requests", "REAL", 1, None, 0),
    ("cost_input", "REAL", 1, None, 0),
    ("cost_output", "REAL", 1, None, 0),
    ("cost_cache_read", "REAL", 1, None, 0),
    ("cost_cache_write", "REAL", 1, None, 0),
    ("cost_total", "REAL", 1, None, 0),
    ("cost_no_cache_input", "REAL", 0, None, 0),
    ("cost_unpriced", "INTEGER", 1, "0", 0),
    ("agent_type", "TEXT", 1, "'main'", 0),
)

SAFE_ROW_FIELDS = (
    "provider",
    "model",
    "timestamp",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "cost_total",
    "cost_unpriced",
    "agent_type",
)

CONTEXT_BANDS = (
    (0, 50_000),
    (50_000, 100_000),
    (100_000, 200_000),
    (200_000, 300_000),
    (300_000, 500_000),
    (500_000, 2_000_000),
    (2_000_000, -1),
)


class SafeBaselineError(RuntimeError):
    """Fixed-message failure from the metadata-only path."""


def wcsv(name: str, header: list[str], rows) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def open_readonly_sqlite(path: Path) -> sqlite3.Connection:
    """Open an existing SQLite database without any write-capable fallback."""
    try:
        resolved = path.expanduser().resolve()
        uri = f"file:{quote(str(resolved), safe='/')}?mode=ro"
        con = sqlite3.connect(uri, uri=True)
        con.execute("PRAGMA query_only = ON")
        return con
    except Exception as exc:
        raise SafeBaselineError("unable to open SQLite database read-only") from exc


def parse_utc_date_ms(value: str) -> int:
    """Parse a calendar date as midnight UTC, never in the host timezone."""
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise SafeBaselineError("dates must use YYYY-MM-DD") from exc
    return int(parsed.timestamp() * 1000)


def load_catalog(path: Path) -> tuple[dict[str, set[str]], set[tuple[str, str]]]:
    """Load only the bundled identifier and price-presence whitelist."""
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except Exception as exc:
        raise SafeBaselineError("unable to load the model catalog") from exc
    if not isinstance(raw, dict):
        raise SafeBaselineError("unexpected model catalog schema")

    identifiers: dict[str, set[str]] = {}
    priced: set[tuple[str, str]] = set()
    for provider, models in raw.items():
        if not isinstance(provider, str) or not isinstance(models, dict):
            raise SafeBaselineError("unexpected model catalog schema")
        identifiers[provider] = set()
        for model, card in models.items():
            if not isinstance(model, str) or not isinstance(card, dict):
                raise SafeBaselineError("unexpected model catalog schema")
            identifiers[provider].add(model)
            cost = card.get("cost")
            if not isinstance(cost, dict):
                continue
            rates = [cost.get(key) for key in ("input", "output", "cacheRead", "cacheWrite")]
            if (all(type(rate) in (int, float) and math.isfinite(rate) and rate >= 0 for rate in rates)
                    and any(rate > 0 for rate in rates)):
                priced.add((provider, model))
    return identifiers, priced


def validate_message_schema(con: sqlite3.Connection) -> bool:
    rows = con.execute("PRAGMA table_info(messages)").fetchall()
    actual = {}
    for row in rows:
        default = row[4]
        if row[1] == "premium_requests" and default == "0":
            default = None  # documented ALTER TABLE migration
        actual[row[1]] = (row[2].upper(), row[3], default, row[5])
    expected = {name: (kind, required, default, pk)
                for name, kind, required, default, pk in EXPECTED_MESSAGE_SCHEMA}
    has_unpriced_marker = "cost_unpriced" in actual
    if not has_unpriced_marker:
        del expected["cost_unpriced"]
    if actual != expected:
        raise SafeBaselineError("unexpected stats messages schema")

    # SQLite permits values whose runtime storage class differs from the
    # declared column type. Check every stored field without returning an
    # offending value.
    unpriced = "cost_unpriced" if has_unpriced_marker else "1"
    invalid = con.execute(
        f"""select count(*) from messages where
        typeof(id) != 'integer' or typeof(session_file) != 'text' or typeof(entry_id) != 'text' or
        typeof(folder) != 'text' or typeof(model) != 'text' or typeof(provider) != 'text' or
        typeof(api) != 'text' or typeof(timestamp) != 'integer' or
        typeof(duration) not in ('null', 'integer', 'real') or typeof(ttft) not in ('null', 'integer', 'real') or
        typeof(stop_reason) != 'text' or typeof(error_message) not in ('null', 'text') or
        typeof(input_tokens) != 'integer' or typeof(output_tokens) != 'integer' or
        typeof(cache_read_tokens) != 'integer' or typeof(cache_write_tokens) != 'integer' or
        typeof(total_tokens) != 'integer' or typeof(premium_requests) not in ('integer', 'real') or
        typeof(cost_input) not in ('integer', 'real') or typeof(cost_output) not in ('integer', 'real') or
        typeof(cost_cache_read) not in ('integer', 'real') or
        typeof(cost_cache_write) not in ('integer', 'real') or
        typeof(cost_total) not in ('integer', 'real') or
        typeof(cost_no_cache_input) not in ('null', 'integer', 'real') or
        typeof({unpriced}) != 'integer' or typeof(agent_type) != 'text' or
        timestamp < 0 or coalesce(duration, 0) < 0 or coalesce(ttft, 0) < 0 or
        duration > 1.7976931348623157e308 or ttft > 1.7976931348623157e308 or
        input_tokens < 0 or output_tokens < 0 or cache_read_tokens < 0 or cache_write_tokens < 0 or
        total_tokens < 0 or premium_requests < 0 or cost_input < 0 or cost_output < 0 or
        cost_cache_read < 0 or cost_cache_write < 0 or cost_total < 0 or
        coalesce(cost_no_cache_input, 0) < 0 or {unpriced} not in (0, 1)"""
    ).fetchone()
    if invalid is None or type(invalid[0]) is not int or invalid[0] != 0:
        raise SafeBaselineError("unexpected stats field type or value")
    return has_unpriced_marker


METRIC_KEYS = {
    "messages",
    "usage_observed_messages",
    "usage_unknown_messages",
    "stored_total_tokens",
    "observed_input_tokens",
    "observed_output_tokens",
    "observed_cache_read_tokens",
    "observed_cache_write_tokens",
    "observed_token_buckets",
    "usage_completeness_ratio",
    "price_observed_messages",
    "price_unknown_messages",
    "price_completeness_ratio",
    "unpriced_messages",
    "unpriced_stored_total_tokens",
    "unpriced_observed_token_buckets",
    "observed_priced_subtotal_usd",
}


def new_metrics() -> dict[str, int | float]:
    return {
        "messages": 0,
        "usage_observed_messages": 0,
        "usage_unknown_messages": 0,
        "stored_total_tokens": 0,
        "observed_input_tokens": 0,
        "observed_output_tokens": 0,
        "observed_cache_read_tokens": 0,
        "observed_cache_write_tokens": 0,
        "observed_token_buckets": 0,
        "price_observed_messages": 0,
        "price_unknown_messages": 0,
        "unpriced_messages": 0,
        "unpriced_stored_total_tokens": 0,
        "unpriced_observed_token_buckets": 0,
        "observed_priced_subtotal_usd": 0.0,
    }


def add_safe_row(metrics: dict[str, int | float], row: tuple, price_catalogued: bool) -> tuple[bool, int]:
    _, _, _, inp, out, cache_read, cache_write, stored_total, cost_total, cost_unpriced, _ = row
    integer_values = (inp, out, cache_read, cache_write, stored_total, cost_unpriced)
    if any(type(value) is not int for value in integer_values):
        raise SafeBaselineError("unexpected stats field type or value")
    if type(cost_total) not in (int, float) or not math.isfinite(cost_total):
        raise SafeBaselineError("unexpected stats field type or value")

    observed_buckets = inp + out + cache_read + cache_write
    usage_observed = stored_total > 0 or observed_buckets > 0
    # A recorded zero cannot distinguish free inference from missing pricing.
    price_observed = usage_observed and price_catalogued and cost_unpriced == 0 and cost_total > 0

    metrics["messages"] += 1
    metrics["stored_total_tokens"] += stored_total
    metrics["observed_input_tokens"] += inp
    metrics["observed_output_tokens"] += out
    metrics["observed_cache_read_tokens"] += cache_read
    metrics["observed_cache_write_tokens"] += cache_write
    metrics["observed_token_buckets"] += observed_buckets
    metrics["usage_observed_messages" if usage_observed else "usage_unknown_messages"] += 1
    metrics["price_observed_messages" if price_observed else "price_unknown_messages"] += 1
    if price_observed:
        metrics["observed_priced_subtotal_usd"] += cost_total
    elif usage_observed:
        metrics["unpriced_messages"] += 1
        metrics["unpriced_stored_total_tokens"] += stored_total
        metrics["unpriced_observed_token_buckets"] += observed_buckets
    return usage_observed, inp + cache_read + cache_write


def finish_metrics(metrics: dict[str, int | float]) -> dict[str, int | float]:
    messages = int(metrics["messages"])
    observed = int(metrics["usage_observed_messages"])
    result = dict(metrics)
    result["usage_completeness_ratio"] = observed / messages if messages else 0.0
    result["price_completeness_ratio"] = int(metrics["price_observed_messages"]) / observed if observed else 0.0
    result["observed_priced_subtotal_usd"] = round(float(metrics["observed_priced_subtotal_usd"]), 12)
    return result


def safe_baseline(stats_db: Path, catalog_path: Path, since_ms: int, until_ms: int) -> dict:
    """Build the fixed-shape metadata-only report for ``[since, until)``."""
    if type(since_ms) is not int or type(until_ms) is not int or since_ms < 0 or until_ms <= since_ms:
        raise SafeBaselineError("safe baseline requires a positive half-open UTC window")
    catalog, priced = load_catalog(catalog_path)
    con = open_readonly_sqlite(stats_db)
    try:
        con.execute("BEGIN")
        has_unpriced_marker = validate_message_schema(con)
        fields = [("1 as cost_unpriced" if field == "cost_unpriced" and not has_unpriced_marker else field)
                  for field in SAFE_ROW_FIELDS]
        cursor = con.execute(
            f"""select {", ".join(fields)} from messages
            where timestamp >= ? and timestamp < ? order by timestamp, id""",
            (since_ms, until_ms),
        )
        total = new_metrics()
        by_model: dict[tuple[str, str], dict[str, int | float]] = {}
        by_agent: dict[str, dict[str, int | float]] = {}
        bands = [new_metrics() for _ in CONTEXT_BANDS]

        for row in cursor:
            if len(row) != len(SAFE_ROW_FIELDS):
                raise SafeBaselineError("unexpected stats query shape")
            provider, model, timestamp, *_, agent_type = row
            if not isinstance(provider, str) or not isinstance(model, str) or type(timestamp) is not int:
                raise SafeBaselineError("unexpected stats field type or value")
            known_provider = provider in catalog
            known_model = known_provider and model in catalog[provider]
            safe_provider = provider if known_provider else UNKNOWN
            safe_model = model if known_model else UNKNOWN
            price_catalogued = known_model and (provider, model) in priced
            safe_agent = agent_type if agent_type in ("main", "subagent", "advisor") else UNKNOWN

            usage_observed, context = add_safe_row(total, row, price_catalogued)
            add_safe_row(by_model.setdefault((safe_provider, safe_model), new_metrics()), row, price_catalogued)
            add_safe_row(by_agent.setdefault(safe_agent, new_metrics()), row, price_catalogued)
            if usage_observed:
                for index, (lower, upper) in enumerate(CONTEXT_BANDS):
                    if context >= lower and (upper < 0 or context < upper):
                        add_safe_row(bands[index], row, price_catalogued)
                        break

        report = {
            "schema_version": 1,
            "mode": "metadata-only-safe",
            "cost_unpriced_marker_present": has_unpriced_marker,
            "window": {"start_ms": since_ms, "end_ms": until_ms, "end_exclusive": True},
            "totals": finish_metrics(total),
            "by_provider_model": [
                {"provider": provider, "model": model, **finish_metrics(metrics)}
                for (provider, model), metrics in sorted(by_model.items())
            ],
            "by_agent_type": [
                {"agent_type": agent, **finish_metrics(metrics)} for agent, metrics in sorted(by_agent.items())
            ],
            "context_bands": [
                {
                    "lower_inclusive_tokens": lower,
                    "upper_exclusive_tokens": upper,
                    **finish_metrics(metrics),
                }
                for (lower, upper), metrics in zip(CONTEXT_BANDS, bands, strict=True)
            ],
            "simulations": {"included": False},
            "inference": {"included": False},
        }
        validate_safe_report(report, catalog)
        return report
    except SafeBaselineError:
        raise
    except Exception as exc:
        raise SafeBaselineError("safe baseline query failed") from exc
    finally:
        if con.in_transaction:
            con.rollback()
        con.close()

def validate_metrics(metrics: dict) -> None:
    if set(metrics) != METRIC_KEYS:
        raise SafeBaselineError("unexpected safe output shape")
    for value in metrics.values():
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise SafeBaselineError("unexpected safe output value")


def validate_safe_report(report: dict, catalog: dict[str, set[str]]) -> None:
    """Enforce the final output whitelist independently of query construction."""
    expected = {
        "schema_version",
        "mode",
        "cost_unpriced_marker_present",
        "window",
        "totals",
        "by_provider_model",
        "by_agent_type",
        "context_bands",
        "simulations",
        "inference",
    }
    if set(report) != expected or report["schema_version"] != 1 or report["mode"] != "metadata-only-safe":
        raise SafeBaselineError("unexpected safe output shape")
    if type(report["cost_unpriced_marker_present"]) is not bool:
        raise SafeBaselineError("unexpected safe output value")
    window = report["window"]
    if set(window) != {"start_ms", "end_ms", "end_exclusive"} or window["end_exclusive"] is not True:
        raise SafeBaselineError("unexpected safe output shape")
    if type(window["start_ms"]) is not int or type(window["end_ms"]) is not int:
        raise SafeBaselineError("unexpected safe output value")
    validate_metrics(report["totals"])
    for item in report["by_provider_model"]:
        if set(item) != METRIC_KEYS | {"provider", "model"}:
            raise SafeBaselineError("unexpected safe output shape")
        provider, model = item["provider"], item["model"]
        if provider != UNKNOWN and provider not in catalog:
            raise SafeBaselineError("unsafe provider identifier")
        if model != UNKNOWN and (provider == UNKNOWN or model not in catalog[provider]):
            raise SafeBaselineError("unsafe model identifier")
        validate_metrics({key: item[key] for key in METRIC_KEYS})
    for item in report["by_agent_type"]:
        if set(item) != METRIC_KEYS | {"agent_type"} or item["agent_type"] not in {
            "main",
            "subagent",
            "advisor",
            UNKNOWN,
        }:
            raise SafeBaselineError("unexpected safe output shape")
        validate_metrics({key: item[key] for key in METRIC_KEYS})
    for item, bounds in zip(report["context_bands"], CONTEXT_BANDS, strict=True):
        if set(item) != METRIC_KEYS | {"lower_inclusive_tokens", "upper_exclusive_tokens"}:
            raise SafeBaselineError("unexpected safe output shape")
        if (item["lower_inclusive_tokens"], item["upper_exclusive_tokens"]) != bounds:
            raise SafeBaselineError("unexpected safe output value")
        validate_metrics({key: item[key] for key in METRIC_KEYS})
    if report["simulations"] != {"included": False} or report["inference"] != {"included": False}:
        raise SafeBaselineError("unexpected safe output shape")


def serialize_safe_report(report: dict) -> str:
    try:
        return json.dumps(report, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"
    except (TypeError, ValueError) as exc:
        raise SafeBaselineError("safe output serialization failed") from exc


def write_safe_output(path: Path, payload: str, stats_db: Path, catalog_path: Path) -> None:
    """Protect the input database, its SQLite sidecars, and the trusted catalog."""
    fd: int | None = None
    try:
        database = stats_db.expanduser().resolve(strict=True)
        catalog = catalog_path.resolve(strict=True)
        sidecars = tuple(Path(f"{database}{suffix}") for suffix in ("-wal", "-shm", "-journal"))
        protected_paths = (database, catalog, *sidecars)
        # Reserve sidecar names even when SQLite has not created them yet.
        if path.resolve() in protected_paths:
            raise SafeBaselineError("safe output aliases protected input")
        protected = set()
        for protected_path in protected_paths:
            try:
                stat = protected_path.stat()
            except FileNotFoundError:
                if protected_path in sidecars:
                    continue
                raise
            protected.add((stat.st_dev, stat.st_ino))
        fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o666)
        output_stat = os.fstat(fd)
        if (output_stat.st_dev, output_stat.st_ino) in protected:
            raise SafeBaselineError("safe output aliases protected input")
        os.ftruncate(fd, 0)
        with os.fdopen(fd, "w") as fh:
            fd = None
            fh.write(payload)
    except SafeBaselineError:
        raise
    except Exception as exc:
        raise SafeBaselineError("unable to write safe output") from exc
    finally:
        if fd is not None:
            os.close(fd)


def half_open_band_sql(expression: str, lower: int, upper: int) -> str:
    upper_clause = "" if upper < 0 else f" and {expression} < {upper}"
    return f"{expression} >= {lower}{upper_clause}"


def stats_tables(since_ms: int, until_ms: int, tag: str) -> tuple[float, dict[str, list[int]]]:
    sdb = open_readonly_sqlite(HOME / "stats.db")
    W = f"timestamp >= {since_ms} and timestamp < {until_ms}"
    q = lambda s: sdb.execute(s).fetchall()
    days = tag

    wcsv(
        f"{days}d-by-model.csv",
        ["provider", "model", "messages", "input_M", "cache_read_M", "output_M", "nominal_usd", "errors"],
        [
            (r[0], r[1], r[2], round(r[3], 1), round(r[4], 1), round(r[5], 2), "" if r[6] is None else round(r[6]), r[7])
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
    bands = CONTEXT_BANDS
    wcsv(
        f"{days}d-main-context-distribution.csv",
        ["ctx_lo_k", "ctx_hi_k", "turns", "tokens_M"],
        [
            (lo // 1_000, upper // 1_000 if upper >= 0 else -1, r[0], round(r[1] or 0, 1))
            for lo, upper in bands
            for r in q(
                f"""select count(*), sum(input_tokens+cache_read_tokens+cache_write_tokens)/1e6 from messages
                where {W} and agent_type='main' and
                {half_open_band_sql("input_tokens+cache_read_tokens+cache_write_tokens", lo, upper)}"""
            )
        ],
    )
    peaks = [(0, 150_000), (150_000, 300_000), (300_000, 500_000), (500_000, 2_000_000), (2_000_000, -1)]
    wcsv(
        f"{days}d-sessions-by-peak.csv",
        ["peak_lo_k", "peak_hi_k", "sessions", "tokens_B", "turns"],
        [
            (lo // 1_000, upper // 1_000 if upper >= 0 else -1, r[0], round((r[1] or 0) / 1e9, 2), r[2] or 0)
            for lo, upper in peaks
            for r in q(
                f"""select count(*), sum(tok), sum(turns) from (select session_file,
                max(input_tokens+cache_read_tokens+cache_write_tokens) mx,
                sum(input_tokens+cache_read_tokens+cache_write_tokens) tok, count(*) turns
                from messages where {W} and agent_type='main' group by session_file)
                where {half_open_band_sql("mx", lo, upper)}"""
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
    sdb.close()
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
    con = open_readonly_sqlite(HOME / "agent" / "agent.db")
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
    con.close()


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


def transcript_message_timestamp_ms(entry: dict, message: dict) -> int | None:
    value = message.get("timestamp")
    if type(value) in (int, float) and math.isfinite(value) and value > 0:
        return int(value)
    envelope = entry.get("timestamp")
    if not isinstance(envelope, str):
        return None
    try:
        parsed = datetime.fromisoformat(envelope.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def transcript_tables(days: int) -> None:
    until_ms = int(time.time() * 1000)
    cutoff_ms = until_ms - days * 86400000
    files = [
        f
        for f in glob.glob(str(HOME / "agent" / "sessions" / "**" / "*.jsonl"), recursive=True)
        if "__advisor" not in f
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
                message_ts = transcript_message_timestamp_ms(e, m)
                if message_ts is None or message_ts < cutoff_ms or message_ts >= until_ms:
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
                        kind=kind, proj=proj, sid=sid, agent=agent, ts=message_ts, model=m.get("model"),
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
    ap.add_argument("--since", help="UTC window start, YYYY-MM-DD (safe mode requires it)")
    ap.add_argument("--until", help="exclusive UTC window end, YYYY-MM-DD (safe mode requires it)")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--transcript-days", type=int, default=24)
    ap.add_argument(
        "--safe-baseline",
        action="store_true",
        help="emit only the fail-closed metadata-only JSON report; never reads transcripts or account data",
    )
    ap.add_argument("--stats-db", type=Path, help="safe-mode stats.db input (opened mode=ro)")
    ap.add_argument("--catalog", type=Path, help="safe-mode bundled models.json whitelist")
    ap.add_argument("--safe-output", type=Path, help="write safe JSON to this file instead of stdout")
    a = ap.parse_args()

    if a.safe_baseline:
        try:
            if not a.since or not a.until:
                raise SafeBaselineError("safe baseline requires explicit --since and --until")
            since_ms = parse_utc_date_ms(a.since)
            until_ms = parse_utc_date_ms(a.until)
            report = safe_baseline(a.stats_db or HOME / "stats.db", a.catalog or CATALOG, since_ms, until_ms)
            payload = serialize_safe_report(report)
            if a.safe_output:
                write_safe_output(
                    a.safe_output,
                    payload,
                    a.stats_db or HOME / "stats.db",
                    a.catalog or CATALOG,
                )
            else:
                sys.stdout.write(payload)
        except SafeBaselineError as exc:
            ap.error(str(exc))
        return

    if a.stats_db or a.catalog or a.safe_output:
        ap.error("--stats-db, --catalog, and --safe-output require --safe-baseline")
    print(
        "WARNING: legacy mode is not privacy-safe; it reads transcripts and account metadata. "
        "Use --safe-baseline for metadata-only output.",
        file=sys.stderr,
    )
    try:
        until_ms = parse_utc_date_ms(a.until) if a.until else int(time.time() * 1000)
        since_ms = parse_utc_date_ms(a.since) if a.since else until_ms - a.days * 86400000
    except SafeBaselineError as exc:
        ap.error(str(exc))

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
