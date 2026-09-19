import csv
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import analyze


SCHEMA = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_file TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    api TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    duration INTEGER,
    ttft INTEGER,
    stop_reason TEXT NOT NULL,
    error_message TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    premium_requests REAL NOT NULL,
    cost_input REAL NOT NULL,
    cost_output REAL NOT NULL,
    cost_cache_read REAL NOT NULL,
    cost_cache_write REAL NOT NULL,
    cost_total REAL NOT NULL,
    cost_no_cache_input REAL,
    cost_unpriced INTEGER NOT NULL DEFAULT 0,
    agent_type TEXT NOT NULL DEFAULT 'main',
    UNIQUE(session_file, entry_id)
)
"""


class SafeBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db_path = self.root / "stats.db"
        self.catalog_path = self.root / "models.json"
        self.catalog_path.write_text(
            json.dumps(
                {
                    "known-provider": {
                        "known-model": {
                            "cost": {"input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.25}
                        }
                    }
                }
            )
        )
        con = sqlite3.connect(self.db_path)
        con.execute(SCHEMA)
        con.commit()
        con.close()
        self.start = analyze.parse_utc_date_ms("2026-08-20")
        self.end = analyze.parse_utc_date_ms("2026-08-21")

    def tearDown(self):
        self.temp.cleanup()

    def insert(
        self,
        *,
        timestamp,
        provider="known-provider",
        model="known-model",
        agent_type="main",
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=0,
        total_tokens=None,
        cost_total=0.0,
        cost_unpriced=0,
        private="fixture-private",
        db_path=None,
    ):
        if total_tokens is None:
            total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
        con = sqlite3.connect(db_path or self.db_path)
        con.execute(
            """INSERT INTO messages (
                session_file, entry_id, folder, model, provider, api, timestamp,
                duration, ttft, stop_reason, error_message,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                total_tokens, premium_requests, cost_input, cost_output,
                cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input,
                cost_unpriced, agent_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)""",
            (
                private,
                private + "-entry-" + str(timestamp),
                private + "-folder",
                model,
                provider,
                private + "-api",
                timestamp,
                "stop",
                private + "-error",
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                total_tokens,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                cost_total,
                cost_unpriced,
                agent_type,
            ),
        )
        con.commit()
        con.close()

    def run_safe_cli(self, output_path):
        return subprocess.run(
            [
                sys.executable,
                str(Path(analyze.__file__)),
                "--safe-baseline",
                "--stats-db",
                str(self.db_path),
                "--catalog",
                str(self.catalog_path),
                "--safe-output",
                str(output_path),
                "--since",
                "2026-08-20",
                "--until",
                "2026-08-21",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_half_open_boundaries_cache_and_unknown_accounting_are_safe(self):
        secret = "DO-NOT-LEAK-private-project-session-agent"
        # Exactly 50k context belongs only to [50k, 100k), and cache tokens
        # remain distinct while contributing to the observed bucket subtotal.
        self.insert(
            timestamp=self.start,
            input_tokens=25_000,
            output_tokens=10_000,
            cache_read_tokens=20_000,
            cache_write_tokens=5_000,
            total_tokens=60_000,
            cost_total=1.25,
            private=secret,
        )
        # Exactly 100k context belongs only to [100k, 200k); its explicit
        # unpriced marker excludes the row from the observed subtotal.
        self.insert(
            timestamp=self.start + 1,
            input_tokens=50_000,
            output_tokens=10_000,
            cache_read_tokens=40_000,
            cache_write_tokens=10_000,
            total_tokens=110_000,
            cost_total=999.0,
            cost_unpriced=1,
            private=secret + "-second",
        )
        # An uncatalogued pair with observed usage and an explicit stored zero
        # is still unpriced; neither the identifier nor a free-cost claim may
        # escape.
        self.insert(
            timestamp=self.start + 2,
            provider=secret,
            model=secret,
            agent_type=secret,
            input_tokens=7,
            total_tokens=7,
            private=secret + "-unknown-price",
        )
        # All-zero numeric usage is unknown, not a free request.
        self.insert(timestamp=self.start + 3, private=secret + "-unknown-usage")
        # The exclusive endpoint is outside the report.
        self.insert(timestamp=self.end, input_tokens=1, total_tokens=1, private=secret + "-end")

        report = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        payload = analyze.serialize_safe_report(report)

        self.assertNotIn(secret, payload)
        totals = report["totals"]
        self.assertEqual(totals["messages"], 4)
        self.assertEqual(totals["usage_observed_messages"], 3)
        self.assertEqual(totals["usage_unknown_messages"], 1)
        self.assertEqual(totals["stored_total_tokens"], 170_007)
        self.assertEqual(totals["observed_input_tokens"], 75_007)
        self.assertEqual(totals["observed_output_tokens"], 20_000)
        self.assertEqual(totals["observed_cache_read_tokens"], 60_000)
        self.assertEqual(totals["observed_cache_write_tokens"], 15_000)
        self.assertEqual(totals["observed_token_buckets"], 170_007)
        self.assertEqual(totals["price_observed_messages"], 1)
        self.assertEqual(totals["price_unknown_messages"], 3)
        self.assertEqual(totals["unpriced_messages"], 2)
        self.assertEqual(totals["unpriced_stored_total_tokens"], 110_007)
        self.assertEqual(totals["unpriced_observed_token_buckets"], 110_007)
        self.assertEqual(totals["observed_priced_subtotal_usd"], 1.25)
        self.assertEqual(report["context_bands"][0]["messages"], 1)
        self.assertEqual(report["context_bands"][1]["messages"], 1)
        self.assertEqual(report["context_bands"][2]["messages"], 1)
        self.assertEqual(report["simulations"], {"included": False})
        self.assertEqual(report["inference"], {"included": False})
        self.assertTrue(
            any(
                row["provider"] == analyze.UNKNOWN and row["model"] == analyze.UNKNOWN
                for row in report["by_provider_model"]
            )
        )
        self.assertTrue(any(row["agent_type"] == analyze.UNKNOWN for row in report["by_agent_type"]))

    def test_zero_cost_without_free_price_provenance_is_unknown(self):
        self.insert(timestamp=self.start, input_tokens=100, cost_total=0)
        report = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        self.assertEqual(report["totals"]["price_observed_messages"], 0)
        self.assertEqual(report["totals"]["unpriced_observed_token_buckets"], 100)
        self.catalog_path.write_text(json.dumps({
            "known-provider": {"known-model": {
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
            }}
        }))
        report = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        self.assertEqual(report["totals"]["price_unknown_messages"], 1)


    def test_cli_rejects_direct_symlink_and_hardlink_input_aliases_without_truncation(self):
        protected = {
            "database": self.db_path,
            "catalog": self.catalog_path,
        }
        expected_bytes = {name: path.read_bytes() for name, path in protected.items()}

        for protected_name, protected_path in protected.items():
            for alias_kind in ("direct", "symlink", "hardlink"):
                with self.subTest(protected=protected_name, alias=alias_kind):
                    # Each alias must exercise a valid fixture even when the
                    # pre-fix CLI corrupted an input in an earlier subtest.
                    for name, path in protected.items():
                        path.write_bytes(expected_bytes[name])
                    if alias_kind == "direct":
                        output_path = protected_path
                    else:
                        output_path = self.root / f"{protected_name}-{alias_kind}-output"
                        if alias_kind == "symlink":
                            output_path.symlink_to(protected_path)
                        else:
                            os.link(protected_path, output_path)

                    result = self.run_safe_cli(output_path)

                    for name, path in protected.items():
                        self.assertEqual(path.read_bytes(), expected_bytes[name])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn(str(self.root), result.stderr)
                    if alias_kind != "direct":
                        output_path.unlink()

    def test_cli_protects_live_sqlite_sidecars_through_a_database_symlink(self):
        real_db = self.db_path
        database_alias = self.root / "input-alias.db"
        database_alias.symlink_to(real_db)
        self.db_path = database_alias
        owner = sqlite3.connect(real_db)
        owner.execute("PRAGMA journal_mode=WAL")
        owner.execute("BEGIN")
        owner.execute("SELECT COUNT(*) FROM messages").fetchone()
        self.insert(timestamp=self.start, input_tokens=123, cost_total=0.25, db_path=real_db)
        sidecars = {suffix: Path(str(real_db) + suffix) for suffix in ("-wal", "-shm")}
        original = {path: path.read_bytes() for path in (real_db, *sidecars.values())}
        try:
            control_output = self.root / "control-report.json"
            control = self.run_safe_cli(control_output)
            self.assertEqual(control.returncode, 0, control.stderr)
            self.assertEqual(json.loads(control_output.read_text())["totals"]["observed_input_tokens"], 123)
            for suffix, sidecar in sidecars.items():
                for alias_kind in ("direct", "symlink", "hardlink"):
                    with self.subTest(sidecar=suffix, alias=alias_kind):
                        output = sidecar
                        if alias_kind != "direct":
                            output = self.root / f"output{suffix}-{alias_kind}"
                            if alias_kind == "symlink":
                                output.symlink_to(sidecar)
                            else:
                                os.link(sidecar, output)
                        try:
                            result = self.run_safe_cli(output)
                            self.assertEqual(real_db.read_bytes(), original[real_db])
                            self.assertEqual(sidecars["-wal"].read_bytes(), original[sidecars["-wal"]])
                            self.assertNotEqual(result.returncode, 0)
                            self.assertNotIn(str(self.root), result.stderr)
                        finally:
                            # Restore only disposable fixture bytes before
                            # SQLite next touches its mmap/checkpoint state.
                            for file, content in original.items():
                                file.write_bytes(content)
                            if output != sidecar:
                                output.unlink()
        finally:
            self.db_path = real_db
            owner.close()

    def test_cli_writes_distinct_safe_output(self):
        output_path = self.root / "safe-report.json"
        output_path.write_text("stale output")
        expected_db = self.db_path.read_bytes()
        expected_catalog = self.catalog_path.read_bytes()

        result = self.run_safe_cli(output_path)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(output_path.read_text())["mode"], "metadata-only-safe")
        self.assertEqual(self.db_path.read_bytes(), expected_db)
        self.assertEqual(self.catalog_path.read_bytes(), expected_catalog)

    def test_migrated_column_order_and_default_preserve_populated_aggregates(self):
        migrated = self.root / "migrated.db"
        schema = SCHEMA.replace("    premium_requests REAL NOT NULL,\n", "").replace(
            "    cost_unpriced INTEGER NOT NULL DEFAULT 0,\n", ""
        ).replace("    agent_type TEXT NOT NULL DEFAULT 'main',\n", "")
        con = sqlite3.connect(migrated)
        con.execute(schema)
        con.execute("ALTER TABLE messages ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE messages ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'")
        con.execute("ALTER TABLE messages ADD COLUMN cost_unpriced INTEGER NOT NULL DEFAULT 0")
        con.commit()
        con.close()

        fixtures = [
            {
                "timestamp": self.start,
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_tokens": 30,
                "cache_write_tokens": 10,
                "total_tokens": 200,
                "cost_total": 1.25,
            },
            {
                "timestamp": self.start + 1,
                "agent_type": "subagent",
                "input_tokens": 2_000_000,
                "output_tokens": 5,
                "total_tokens": 2_000_050,
                "cost_unpriced": 1,
            },
        ]
        for db_path in (self.db_path, migrated):
            for fixture in fixtures:
                self.insert(db_path=db_path, **fixture)

        original = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        migrated_report = analyze.safe_baseline(migrated, self.catalog_path, self.start, self.end)

        self.assertEqual(migrated_report, original)
        self.assertEqual(original["totals"]["messages"], 2)
        self.assertEqual(original["totals"]["stored_total_tokens"], 2_000_250)
        self.assertEqual(original["totals"]["observed_token_buckets"], 2_000_165)
        self.assertEqual(original["totals"]["price_observed_messages"], 1)
        self.assertEqual(original["totals"]["unpriced_messages"], 1)
        self.assertNotEqual(
            original["totals"]["stored_total_tokens"],
            original["totals"]["observed_token_buckets"],
        )
        for partition in ("by_provider_model", "by_agent_type"):
            for metric in ("messages", "stored_total_tokens", "observed_token_buckets", "unpriced_messages"):
                self.assertEqual(
                    sum(row[metric] for row in original[partition]),
                    original["totals"][metric],
                )
        self.assertEqual(
            sum(row["messages"] for row in original["context_bands"]),
            original["totals"]["usage_observed_messages"],
        )
        self.assertEqual(
            sum(row["stored_total_tokens"] for row in original["context_bands"]),
            original["totals"]["stored_total_tokens"],
        )
        self.assertEqual(original["context_bands"][-1]["messages"], 1)

    def test_legacy_distributions_keep_two_million_boundary_and_overflow(self):
        for offset, context in enumerate((1_999_999, 2_000_000, 2_500_000_000)):
            self.insert(
                timestamp=self.start + offset,
                input_tokens=context,
                total_tokens=context,
                private=f"session-{offset}",
            )

        original_home, original_out = analyze.HOME, analyze.OUT
        legacy_out = self.root / "legacy-output"
        analyze.HOME = self.root
        analyze.OUT = legacy_out
        try:
            analyze.stats_tables(self.start, self.end, "synthetic")
        finally:
            analyze.HOME, analyze.OUT = original_home, original_out

        with open(legacy_out / "syntheticd-main-context-distribution.csv", newline="") as fh:
            contexts = list(csv.DictReader(fh))
        self.assertEqual(sum(int(row["turns"]) for row in contexts), 3)
        self.assertEqual(
            contexts[-1],
            {"ctx_lo_k": "2000", "ctx_hi_k": "-1", "turns": "2", "tokens_M": "2502.0"},
        )

        with open(legacy_out / "syntheticd-sessions-by-peak.csv", newline="") as fh:
            peaks = list(csv.DictReader(fh))
        self.assertEqual(sum(int(row["sessions"]) for row in peaks), 3)
        self.assertEqual(sum(int(row["turns"]) for row in peaks), 3)
        self.assertEqual(
            peaks[-1],
            {
                "peak_lo_k": "2000",
                "peak_hi_k": "-1",
                "sessions": "2",
                "tokens_B": "2.5",
                "turns": "2",
            },
        )

    def test_fractional_provider_timings_do_not_invalidate_usage(self):
        self.insert(timestamp=self.start, input_tokens=100, cost_total=0.25)
        con = sqlite3.connect(self.db_path)
        con.execute("UPDATE messages SET duration = 12.5, ttft = 1.25")
        con.commit()
        con.close()
        report = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        self.assertEqual(report["totals"]["observed_input_tokens"], 100)
        self.assertEqual(report["totals"]["observed_priced_subtotal_usd"], 0.25)

    def test_pre_marker_schema_keeps_tokens_but_prices_unknown(self):
        self.insert(timestamp=self.start, input_tokens=100, cost_total=0.25)
        con = sqlite3.connect(self.db_path)
        con.execute("ALTER TABLE messages DROP COLUMN cost_unpriced")
        con.close()
        report = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        self.assertFalse(report["cost_unpriced_marker_present"])
        self.assertEqual(report["totals"]["observed_input_tokens"], 100)
        self.assertEqual(report["totals"]["price_observed_messages"], 0)
        self.assertEqual(report["totals"]["unpriced_observed_token_buckets"], 100)
        con = sqlite3.connect(self.db_path)
        self.assertNotIn("cost_unpriced", [row[1] for row in con.execute("PRAGMA table_info(messages)")])
        con.close()

    def test_unexpected_schema_and_dynamic_field_types_fail_closed(self):
        con = sqlite3.connect(self.db_path)
        con.execute("ALTER TABLE messages ADD COLUMN unexpected TEXT")
        con.commit()
        con.close()
        with self.assertRaisesRegex(analyze.SafeBaselineError, "unexpected stats messages schema"):
            analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)

        bad_db = self.root / "bad-types.db"
        con = sqlite3.connect(bad_db)
        con.execute(SCHEMA)
        con.execute(
            """INSERT INTO messages (
                session_file, entry_id, folder, model, provider, api, timestamp, stop_reason,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
                premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write,
                cost_total, cost_unpriced, agent_type
            ) VALUES ('s', 'e', 'f', 'known-model', 'known-provider', 'a', ?, 'stop',
                'not-a-number', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'main')""",
            (self.start,),
        )
        con.commit()
        con.close()
        with self.assertRaisesRegex(analyze.SafeBaselineError, "unexpected stats field type or value"):
            analyze.safe_baseline(bad_db, self.catalog_path, self.start, self.end)

    def test_connection_is_query_only_and_output_validator_rejects_unknown_ids(self):
        con = analyze.open_readonly_sqlite(self.db_path)
        try:
            self.assertEqual(con.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                con.execute("CREATE TABLE forbidden (value INTEGER)")
        finally:
            con.close()

        report = analyze.safe_baseline(self.db_path, self.catalog_path, self.start, self.end)
        report["by_provider_model"].append(
            {"provider": "private-provider", "model": analyze.UNKNOWN, **analyze.finish_metrics(analyze.new_metrics())}
        )
        catalog, _ = analyze.load_catalog(self.catalog_path)
        with self.assertRaisesRegex(analyze.SafeBaselineError, "unsafe provider identifier"):
            analyze.validate_safe_report(report, catalog)

    def test_utc_dates_and_transcript_message_timestamps_are_deterministic(self):
        self.assertEqual(analyze.parse_utc_date_ms("1970-01-02"), 86_400_000)
        self.assertEqual(
            analyze.transcript_message_timestamp_ms(
                {"timestamp": "2026-08-20T00:00:00Z"}, {"timestamp": 123_456}
            ),
            123_456,
        )
        self.assertEqual(
            analyze.transcript_message_timestamp_ms({"timestamp": "1970-01-02T00:00:00Z"}, {}),
            86_400_000,
        )


if __name__ == "__main__":
    unittest.main()
