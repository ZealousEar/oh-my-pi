#!/usr/bin/env python3
"""Regenerate the candidate (18.3.x) subscription-only provider policy from the PORT checkout's bundled catalog.
Everything except the approved providers (anthropic, openai-codex subscriptions; openrouter, owner-approved
2026-09-22, key held by the shared authority; typesafe, owner-approved native jev judgment route) and the keyless
local discoverables is denied. Writes ~/.omp-channels-next/policy/subscription-only.yml directly (the candidate
channel's immutable policy) and profile-seed/disabled-providers.yml (what install.sh copies into place).
Re-run after a candidate pin bump; never point this at the live checkout or ~/.omp-channels."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
CHECKOUT = "/Users/farhad/Code/omp-next-2026-09-25"
# typesafe: 18.3.x catalogs the TypeSafe provider natively and judgment draws from the available-model pool
# (disabled providers are excluded), so the overlay's modelRoles.judge: typesafe/jev-1.13.0 pin needs the
# provider allowed here. Owner-approved native jev route; no other paid provider is enabled by this.
ALLOWED = {"anthropic", "openai-codex", "openrouter", "typesafe"}
LOCAL = ["ollama", "llama.cpp", "lm-studio"]
cat = json.load(open(os.path.join(CHECKOUT, "packages", "catalog", "src", "models.json")))
provs = sorted(cat.keys()) if isinstance(cat, dict) else sorted({m.get("provider") for m in cat})
missing = ALLOWED - set(provs)
if missing:
    sys.exit(f"allowed providers absent from the candidate catalog: {', '.join(sorted(missing))}")
# 18.3.x catalogs two pseudo-providers the r13 catalog lacked: "web" (web-search backends, the web/* entries of
# src/priority.json, incl. keyless duckduckgo/public) and "local" (bundled on-device kokoro/whisper/tiny models;
# model-registry.ts #addImplicitDiscoverableProviders treats both as keyless). Denying them is the literal
# subscription-only rule (owner decision pending 2026-09-25); it removes web/* from the web role chain and the
# local dictation/tts/tiny candidates. Move them into ALLOWED once the owner approves.
deny = [p for p in provs if p not in ALLOWED] + LOCAL
block = ("# Subscription-only model policy (approved defaults: Fable via Anthropic OAuth, Sol via\n"
         "# openai-codex OAuth; openrouter owner-approved 2026-09-22, key held by the shared authority;\n"
         "# typesafe owner-approved as the native jev judgment route, pinned by modelRoles.judge).\n"
         "# Every other catalog provider and the keyless local discoverables are\n"
         "# disabled so an API key inherited from the shell environment (e.g. FIREWORKS_API_KEY from\n"
         "# ~/.zshenv) can never become the silently selected default. With no login yet, no model\n"
         "# resolves and the TUI shows the pending-login state instead of a paid fallback.\n"
         f"# Generated from {CHECKOUT}/packages/catalog/src/models.json: {len(provs)} catalog providers\n"
         f"# - {len(ALLOWED)} allowed ({', '.join(sorted(ALLOWED))}) + {len(LOCAL)} keyless local discoverables = {len(deny)} denied ids.\n"
         "disabledProviders:\n" + "".join(f"  - {p}\n" for p in deny))
POLICY = os.path.expanduser("~/.omp-channels-next/policy/subscription-only.yml")
SEED = os.path.join(HERE, "profile-seed", "disabled-providers.yml")

def chflags(flag, path):
    # The candidate policy is uchg-locked like the live one (install.sh:89/102); unlock only for the swap.
    if os.path.exists(path) and subprocess.run(["/usr/bin/chflags", flag, path], stdin=subprocess.DEVNULL, timeout=10).returncode:
        sys.exit(f"chflags {flag} {path} failed")

for out in (POLICY, SEED):
    tmp = f"{out}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(block)
    os.chmod(tmp, 0o644)
    locked = out == POLICY
    if locked:
        chflags("nouchg", out)
    try:
        os.replace(tmp, out)
    finally:
        if locked:
            chflags("uchg", out)
    print(f"{out}: {len(deny)} providers denied ({len(provs)} catalog + {len(LOCAL)} local, {len(ALLOWED)} allowed)")
