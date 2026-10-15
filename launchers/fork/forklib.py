"""Shared helpers for fork-sync / fork-check / fork-release (stdlib only, /usr/bin/python3 3.9)."""
from __future__ import annotations

import os
import re
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
CONF_FILE = os.path.join(HERE, "fork.conf")
MUST_KEEP_FILE = os.path.join(HERE, "must-keep.json")
# Ambient settings that break the settings tests and leak the wrapper policy into raw runs.
SCRUBBED_ENV = ("PI_CONFIG_FILES", "OMP_SHARED_SECRETS_FILE")

PROG = os.path.basename(sys.argv[0])


def die(msg: str, code: int = 1) -> None:
    print(f"{PROG}: {msg}", file=sys.stderr)
    sys.exit(code)


def warn(msg: str) -> None:
    print(f"{PROG}: WARNING: {msg}", file=sys.stderr)


def load_conf() -> dict:
    conf: dict = {}
    with open(CONF_FILE) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = line.partition("=")
            if not sep or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
                die(f"{CONF_FILE}: malformed line: {raw.rstrip()}")
            value = os.environ.get(f"FORK_{key}", value)
            conf[key] = re.sub(r"\$\{(\w+)\}", lambda m: conf[m.group(1)], value)
    return conf


def run(cmd, *, cwd=None, env=None, timeout=None, capture=True, check=False) -> subprocess.CompletedProcess:
    """Run with stdin closed. capture=True merges nothing: stdout/stderr returned separately."""
    try:
        cp = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            text=True,
        )
    except subprocess.TimeoutExpired:
        die(f"timed out after {timeout}s: {' '.join(cmd)}")
    if check and cp.returncode != 0:
        detail = (cp.stderr or cp.stdout or "").strip() if capture else ""
        die(f"command failed (exit {cp.returncode}): {' '.join(cmd)}" + (f"\n{detail}" if detail else ""))
    return cp


def git(conf: dict, *args: str, check: bool = True, cwd: str | None = None) -> str:
    cp = run(["git", *args], cwd=cwd or conf["CHECKOUT"], check=check)
    return cp.stdout.strip() if cp.returncode == 0 else ""


def current_branch(conf: dict) -> str:
    return git(conf, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)


def fork_branch(conf: dict) -> str:
    branch = conf["FORK_BRANCH"] or current_branch(conf)
    if not branch:
        die(f"{conf['CHECKOUT']}: HEAD is detached and FORK_BRANCH is unset; check out the fork branch")
    return branch


def dirty_lines(conf: dict) -> list:
    out = git(conf, "status", "--porcelain=v1", "--untracked-files=normal")
    return [line for line in out.splitlines() if line]


def operation_in_progress(conf: dict) -> str:
    for name, marker in (
        ("rebase", "rebase-merge"),
        ("rebase", "rebase-apply"),
        ("merge", "MERGE_HEAD"),
        ("cherry-pick", "CHERRY_PICK_HEAD"),
        ("revert", "REVERT_HEAD"),
    ):
        path = git(conf, "rev-parse", "--git-path", marker)
        if not os.path.isabs(path):
            path = os.path.join(conf["CHECKOUT"], path)
        if os.path.exists(path):
            return name
    return ""


def require_clean(conf: dict) -> None:
    op = operation_in_progress(conf)
    if op:
        die(f"{conf['CHECKOUT']}: a {op} is in progress; finish or abort it first")
    lines = dirty_lines(conf)
    if lines:
        shown = "\n  ".join(lines[:20]) + ("\n  …" if len(lines) > 20 else "")
        die(f"{conf['CHECKOUT']}: working tree is dirty; commit or stash first:\n  {shown}")


def describe_tag(conf: dict, rev: str) -> str:
    return git(conf, "describe", "--tags", "--abbrev=0", "--match", "v*", rev, check=False)


def base_tag(conf: dict, ref: str = "HEAD") -> str:
    """Upstream tag the fork stack sits on.

    BASE_TAG (conf or FORK_BASE_TAG env) wins. Otherwise the nearest v* tag reachable from ref:
    fork-sync rebases the stack directly onto a tag and fork commits carry no tags, so that is
    the base. Only when ref reaches no tag at all (shallow clone) fall back to the newest v* tag
    reachable from merge-base(ref, UPSTREAM_REMOTE/UPSTREAM_BRANCH), which lags when the
    upstream branch is stale."""
    if conf["BASE_TAG"]:
        tag = conf["BASE_TAG"]
    else:
        tag = describe_tag(conf, ref)
        if not tag:
            upstream = f"{conf['UPSTREAM_REMOTE']}/{conf['UPSTREAM_BRANCH']}"
            mb = git(conf, "merge-base", ref, upstream, check=False)
            tag = describe_tag(conf, mb) if mb else ""
            if tag:
                warn(f"{ref} reaches no v* tag; using {tag} from merge-base with {upstream}")
    if not tag:
        die(f"cannot derive the base tag of {ref}; set BASE_TAG in {CONF_FILE} or FORK_BASE_TAG")
    if run(["git", "merge-base", "--is-ancestor", tag, ref], cwd=conf["CHECKOUT"]).returncode != 0:
        die(f"base tag {tag} is not an ancestor of {ref}")
    return tag


def bun_env(conf: dict) -> dict:
    """os.environ minus the ambient wrapper policy, pinned Bun first on PATH."""
    env = {k: v for k, v in os.environ.items() if k not in SCRUBBED_ENV}
    env["PATH"] = os.path.dirname(conf["BUN"]) + os.pathsep + env.get("PATH", "")
    return env


def is_uchg(path: str) -> bool:
    try:
        return bool(os.lstat(path).st_flags & stat.UF_IMMUTABLE)
    except FileNotFoundError:
        return False


def print_table(headers: list, rows: list) -> None:
    widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) if rows else len(str(h)) for i, h in enumerate(headers)]

    def fmt(cells):
        return "  ".join(str(c).ljust(w) for c, w in zip(cells, widths)).rstrip()

    print(fmt(headers))
    print(fmt(["-" * w for w in widths]))
    for r in rows:
        print(fmt(r))
