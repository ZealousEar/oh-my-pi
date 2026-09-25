#!/bin/sh
# Idempotent installer for the omp/ompd/ompdev channel wrappers, doctor, and
# per-channel profile seeds. Never touches ~/.omp/agent (legacy default state),
# /opt/homebrew/bin/omp, ~/.omp-custom, or the pinned binaries themselves.
# Re-run after bumping a pin (new binary under a NEW filename + channels.json edit).
# Also (re)links the synced profile layer (~/.omp/profile-layer, git branch profile/daily-fork of
# ZealousEar/oh-my-pi) into the fork profiles and installs its daily sync job. This script itself
# lives in that layer; the launcher dir holds symlinks to it.
set -eu
L=/Users/farhad/.omp/implementation-2026-09-18/launchers
BIN=/Users/farhad/.local/bin
MAP=/Users/farhad/.omp-channels/channels.json
PROFILES=/Users/farhad/.omp/profiles
MARK='omp channel launcher:'
DOCTOR_MARK='omp-channels: show and verify'
LAYER=/Users/farhad/.omp/profile-layer
LAYER_BRANCH=profile/daily-fork
SYNC_LABEL=ai.omp.profile-layer-sync

die() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }

[ -f "$MAP" ] || die "missing $MAP"
# The ompd/ompdev wrappers refuse to start without the layer's config overlay: check it first.
[ -d "$LAYER/.git" ] || die "profile layer checkout missing: git clone -b $LAYER_BRANCH --single-branch https://github.com/ZealousEar/oh-my-pi.git $LAYER"
[ -r "$LAYER/config/fork-overlay.yml" ] || die "profile layer overlay missing: $LAYER/config/fork-overlay.yml"
for name in omp ompd ompdev omp-channels omp-secret omp-mcp-share omp-relay-share; do
	[ -f "$L/wrappers/$name" ] || die "missing wrapper source $L/wrappers/$name"
done
# Pinned executables must exist and match the recorded digests before wrappers go live.
/usr/bin/python3 - "$MAP" <<'PY'
import hashlib, json, os, sys
m = json.load(open(sys.argv[1]))
for name, ch in m["channels"].items():
    if ch["kind"] != "compiled":
        continue
    exe = ch["executable"]
    if not os.access(exe, os.X_OK):
        sys.exit(f"{name}: executable missing: {exe}")
    h = hashlib.sha256(open(exe, "rb").read()).hexdigest()
    if h != ch["sha256"]:
        sys.exit(f"{name}: sha256 mismatch for {exe}")
print("pinned executables verified")
PY
STOCK=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["channels"]["omp"]["executable"])' "$MAP") ||
	die "cannot resolve pinned stock executable from $MAP"


mkdir -p "$BIN"
place() { # place <name> <marker>
	dst=$BIN/$1
	if [ -e "$dst" ] && ! grep -q "$2" "$dst" 2>/dev/null; then
		die "$dst exists and is not a channel file; refusing to overwrite (move it aside first)"
	fi
	[ -e "$dst" ] && chflags nouchg "$dst"
	cp "$L/wrappers/$1" "$dst.tmp.$$" && chmod 755 "$dst.tmp.$$" && mv -f "$dst.tmp.$$" "$dst"
	# Immutable: the self-updater (which targets the PATH-resolved `omp`) and stray
	# copies cannot replace a wrapper without an explicit chflags nouchg.
	chflags uchg "$dst"
}
for name in omp ompd ompdev; do place "$name" "$MARK"; done
place omp-channels "$DOCTOR_MARK"
place omp-secret "omp-secret: the one place credential-marked settings are written"
place omp-mcp-share "omp-mcp-share: stock channel adopts MCP OAuth logins made in the fork channels"
place omp-relay-share "Pin the machine-global OMP browser relay and canonical Chrome extension"

# Pinned targets and their directories are immutable too: a running channel whose
# executable vanished would re-resolve its worker host via $which("omp"), so the
# executables must not be deletable/renamable/replaceable by accident. The map
# file stays writable (its directory is re-locked at the end of this script).
CH=/Users/farhad/.omp-channels
chflags nouchg "$CH" "$CH/stock" "$CH/fork" 2>/dev/null || true
/usr/bin/python3 - "$MAP" <<'PY'
import json, subprocess, sys
m = json.load(open(sys.argv[1]))
for name, ch in m["channels"].items():
    if ch["kind"] == "compiled":
        subprocess.run(["chflags", "uchg", ch["executable"]], check=True)
PY
# Runtime relay receipts/staging need a writable child under the immutable channel root.
# Create it while the parent is unlocked; the directory itself deliberately stays mutable.
RELAY_STATE=$CH/browser-relay
mkdir -p "$RELAY_STATE"
chmod 755 "$RELAY_STATE"
chflags nouchg "$RELAY_STATE" 2>/dev/null || true

# Immutable policy overlays pinned by the wrappers through PI_CONFIG_FILES.
POL=$CH/policy
mkdir -p "$POL"
chflags nouchg "$POL" "$POL/subscription-only.yml" "$POL/browser-identity.yml" "$POL/stock-tool-policy.yml" "$POL/auth-mode" "$POL/relay-mode" 2>/dev/null || true
cp "$L/profile-seed/disabled-providers.yml" "$POL/subscription-only.yml.tmp.$$" && chmod 644 "$POL/subscription-only.yml.tmp.$$" && mv -f "$POL/subscription-only.yml.tmp.$$" "$POL/subscription-only.yml"
cp "$L/profile-seed/browser-identity.yml" "$POL/browser-identity.yml.tmp.$$" && chmod 644 "$POL/browser-identity.yml.tmp.$$" && mv -f "$POL/browser-identity.yml.tmp.$$" "$POL/browser-identity.yml"
cp "$L/profile-seed/stock-tool-policy.yml" "$POL/stock-tool-policy.yml.tmp.$$" && chmod 644 "$POL/stock-tool-policy.yml.tmp.$$" && mv -f "$POL/stock-tool-policy.yml.tmp.$$" "$POL/stock-tool-policy.yml"
if [ ! -e "$POL/auth-mode" ]; then
	printf 'authority\n' >"$POL/auth-mode"
	chmod 644 "$POL/auth-mode"
fi
if [ ! -e "$POL/relay-mode" ]; then
	printf 'legacy\n' >"$POL/relay-mode"
	chmod 644 "$POL/relay-mode"
	printf 'relay-mode: legacy (%s)\n' "$POL/relay-mode"
fi
chflags uchg "$POL/subscription-only.yml" "$POL/browser-identity.yml" "$POL/stock-tool-policy.yml" "$POL/auth-mode" "$POL/relay-mode" "$POL"
# Shared credential-marked settings overlay (writable, 0600; final PI_CONFIG_FILES entry).
SHARED=$CH/shared
mkdir -p "$SHARED" && chmod 700 "$SHARED"
if [ ! -f "$SHARED/credential-settings.yml" ]; then
	cp "$L/profile-seed/credential-settings.yml" "$SHARED/credential-settings.yml"
fi
chmod 600 "$SHARED/credential-settings.yml"

# Record installed wrapper digests so `omp-channels --verify` can authenticate them.
/usr/bin/python3 - "$MAP" "$BIN" <<'PY'
import hashlib, json, sys
m = json.load(open(sys.argv[1])); b = sys.argv[2]
m["wrapperSha256"] = {n: hashlib.sha256(open(f"{b}/{n}", "rb").read()).hexdigest() for n in ("omp", "ompd", "ompdev", "omp-channels")}
policy_root = m["configRoot"].replace("/.omp", "/.omp-channels/policy")
paths = [f"{policy_root}/subscription-only.yml", f"{policy_root}/browser-identity.yml", f"{policy_root}/stock-tool-policy.yml"]
m.pop("policyOverlay", None)
m["policyOverlays"] = [{"path": path, "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(), "pinnedBy": "wrappers export PI_CONFIG_FILES"} for path in paths]
json.dump(m, open(sys.argv[1], "w"), indent=2)
PY

# The authority must exist before profiles are wired to it (fail closed, never half-configured).
AUTH_TOKEN=$PROFILES/auth-authority/auth-broker.token
[ -r "$AUTH_TOKEN" ] || die "shared credential authority token missing: $AUTH_TOKEN (run shared-auth/install-authority.sh first)"
for profile in stock daily-fork dev-fork; do
	root=$PROFILES/$profile
	mkdir -p "$root/agent/hooks/pre"
	chmod 700 "$root/agent"
	if [ ! -f "$root/agent/config.yml" ]; then
		cp "$L/profile-seed/config.yml" "$root/agent/config.yml"
		printf 'startup:\n  checkUpdate: false  # channels never self-update; the notice would only mislead (see runbook "check for newer stock")\n' >>"$root/agent/config.yml"
		chmod 600 "$root/agent/config.yml"
	fi
	# Subscription-only provider policy for profiles that predate it (idempotent append).
	if ! grep -q '^disabledProviders:' "$root/agent/config.yml"; then
		# omp's own writer may leave no trailing newline; never glue onto its last line.
		[ -n "$(tail -c 1 "$root/agent/config.yml")" ] && printf '\n' >>"$root/agent/config.yml"
		cat "$L/profile-seed/disabled-providers.yml" >>"$root/agent/config.yml"
	fi
	# Ask the pinned runtime to resolve the complete YAML exactly as production does.
	# Only a definite not_configured result is seedable; malformed or conflicting
	# configuration must remain a hard failure rather than being papered over.
	broker_status=$("$STOCK" --profile="$profile" auth-broker status --json 2>&1 || true)
	case $broker_status in
	*'"url":"http://127.0.0.1:41871"'*) ;;
	*'"reason":"not_configured"'*)
		[ -n "$(tail -c 1 "$root/agent/config.yml")" ] && printf '\n' >>"$root/agent/config.yml"
		cat "$L/profile-seed/auth-broker.yml" >>"$root/agent/config.yml"
		;;
	*) die "$profile: broker config oracle could not resolve a seedable configuration: $broker_status" ;;
	esac
	broker_status=$("$STOCK" --profile="$profile" auth-broker status --json 2>&1 || true)
	case $broker_status in
	*'"url":"http://127.0.0.1:41871"'*) ;;
	*) die "$profile: broker config oracle did not resolve http://127.0.0.1:41871 after seeding: $broker_status" ;;
	esac
	if ! cmp -s "$AUTH_TOKEN" "$root/auth-broker.token"; then
		cp "$AUTH_TOKEN" "$root/auth-broker.token.tmp.$$" && chmod 600 "$root/auth-broker.token.tmp.$$" && mv -f "$root/auth-broker.token.tmp.$$" "$root/auth-broker.token"
	fi
	chmod 600 "$root/auth-broker.token"
	hook=$root/agent/hooks/pre/block-channel-self-update.ts
	if [ ! -f "$hook" ] || grep -q 'Channel guard (installed per channel profile' "$hook"; then
		cp "$L/profile-seed/hooks/pre/block-channel-self-update.ts" "$hook"
	fi
done

# Synced profile layer. Fork profiles (ompd, ompdev) get one symlink per layer entry in
# skills/ agents/ rules/ extensions/; every channel links models.yml. A real file at a link
# path is never replaced (move it into the layer first). Links whose layer entry was removed
# are pruned; links to anything outside the layer are left alone.
layer_link() { # layer_link <target> <link>
	if [ -L "$2" ]; then
		[ "$(readlink "$2")" = "$1" ] || ln -sfn "$1" "$2"
	elif [ -e "$2" ]; then
		die "refusing to replace real file $2 with a layer link (move it into $LAYER first)"
	else
		ln -s "$1" "$2"
	fi
}
for profile in daily-fork dev-fork; do
	root=$PROFILES/$profile/agent
	for kind in skills agents rules extensions; do
		mkdir -p "$root/$kind"
		for src in "$LAYER/agent/$kind"/*; do
			[ -e "$src" ] && layer_link "$src" "$root/$kind/$(basename "$src")"
		done
		for l in "$root/$kind"/*; do
			[ -L "$l" ] || continue
			case $(readlink "$l") in "$LAYER"/*) [ -e "$l" ] || rm -f "$l" ;; esac
		done
	done
done
for profile in stock daily-fork dev-fork; do
	layer_link "$LAYER/agent/models.yml" "$PROFILES/$profile/agent/models.yml"
done
# Daily commit + push (launchd). Reload only when the tracked plist changed or the job is absent.
mkdir -p "$HOME/.omp/profile-layer-sync"
plist=$HOME/Library/LaunchAgents/$SYNC_LABEL.plist
if ! cmp -s "$LAYER/sync/$SYNC_LABEL.plist" "$plist"; then
	launchctl bootout "gui/$(id -u)/$SYNC_LABEL" 2>/dev/null || true
	cp "$LAYER/sync/$SYNC_LABEL.plist" "$plist"
fi
launchctl print "gui/$(id -u)/$SYNC_LABEL" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$plist"
chflags uchg "$CH/stock" "$CH/fork" "$CH"
# ~/.omp-channels is locked, but the policy dir was locked above already.
printf 'installed wrappers (uchg) in %s; pinned targets locked under %s; profiles seeded under %s\n' "$BIN" "$CH" "$PROFILES"
