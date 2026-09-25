#!/bin/sh
# Daily sync of the omp profile layer (~/.omp/profile-layer, branch profile/daily-fork) to
# github.com/ZealousEar/oh-my-pi. Run by launchd (ai.omp.profile-layer-sync) and safe to run by hand.
# Commits everything dirty, refuses to commit anything that looks like a credential, then pushes.
# Result: ~/.omp/profile-layer-sync/status.json (read by `omp-channels`) + sync.log.
set -u
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export PATH
REPO=$HOME/.omp/profile-layer
BRANCH=profile/daily-fork
STATE=$HOME/.omp/profile-layer-sync
mkdir -p "$STATE"
LOG=$STATE/sync.log
LOCK=$STATE/lock

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(now)" "$1" >>"$LOG"; }
status() { # status <result> <message> [commit]
	/usr/bin/python3 -c 'import json,sys; json.dump({"at":sys.argv[1],"result":sys.argv[2],"message":sys.argv[3],"commit":sys.argv[4]}, open(sys.argv[5],"w"))' \
		"$(now)" "$1" "$2" "${3:-}" "$STATE/status.json"
	log "$1: $2${3:+ ($3)}"
}
finish() { rmdir "$LOCK" 2>/dev/null; exit "$1"; }

mkdir "$LOCK" 2>/dev/null || { log "skipped: another sync holds $LOCK"; exit 0; }
cd "$REPO" 2>/dev/null || { status failed "checkout missing: $REPO"; finish 1; }
[ "$(git branch --show-current)" = "$BRANCH" ] || { status failed "checkout is not on $BRANCH"; finish 1; }

git add -A || { status failed "git add failed"; finish 1; }
if ! git diff --cached --quiet; then
	# Credential scan over every ADDED line in the staged diff. A hit unstages everything and
	# blocks the sync; the log names file:line, never the matched text.
	hits=$(git diff --cached -U0 --no-color | /usr/bin/python3 -c '
import re, sys
pat = re.compile(r"""(
    sk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{20,}
  | gh[pousr]_[A-Za-z0-9]{30,} | github_pat_[A-Za-z0-9_]{30,}
  | xox[abprs]-[A-Za-z0-9-]{10,}
  | AKIA[0-9A-Z]{16}
  | AIza[0-9A-Za-z_-]{35}
  | rc_[A-Za-z0-9]{24,}
  | -----BEGIN\ [A-Z\ ]*PRIVATE\ KEY-----
  | (?i:(?:api[_-]?key|secret|token|password|bearer)["\x27]?\s*[:=]\s*["\x27]?(?!\!)[A-Za-z0-9_\-./+=]{24,})
)""", re.X)
path, line = None, 0
for raw in sys.stdin:
    if raw.startswith("+++ "):
        path = raw[6:].strip() if raw.startswith("+++ b/") else raw[4:].strip()
    elif raw.startswith("@@"):
        m = re.search(r"\+(\d+)", raw); line = int(m.group(1)) if m else 0
    elif raw.startswith("+"):
        if pat.search(raw[1:]): print(f"{path}:{line}")
        line += 1
')
	if [ -n "$hits" ]; then
		git reset -q
		status blocked "possible credential in $(printf '%s' "$hits" | tr '\n' ' ')- nothing committed; fix or allow by hand"
		finish 1
	fi
	git commit -q -m "sync(profile): $(now) from $(hostname -s)" || { status failed "git commit failed"; finish 1; }
	log "committed $(git rev-parse --short HEAD)"
fi

git fetch -q origin "$BRANCH" 2>>"$LOG" || { status failed "git fetch failed (network or auth)"; finish 1; }
if [ -n "$(git rev-list "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
	if [ -n "$(git rev-list "HEAD..origin/$BRANCH" 2>/dev/null)" ]; then
		git rebase -q "origin/$BRANCH" 2>>"$LOG" || { git rebase --abort 2>/dev/null; status failed "rebase onto origin/$BRANCH conflicted; resolve by hand"; finish 1; }
	fi
	git push -q origin "HEAD:refs/heads/$BRANCH" 2>>"$LOG" || { status failed "git push failed"; finish 1; }
	status ok "pushed" "$(git rev-parse --short HEAD)"
elif [ -n "$(git rev-list "HEAD..origin/$BRANCH" 2>/dev/null)" ]; then
	git merge -q --ff-only "origin/$BRANCH" 2>>"$LOG" || { status failed "fast-forward from origin failed"; finish 1; }
	status ok "fast-forwarded from origin" "$(git rev-parse --short HEAD)"
else
	status ok "up to date" "$(git rev-parse --short HEAD)"
fi
finish 0
