#!/usr/bin/env bash
# Tests for start_branch.sh: real git repos in a temp dir. Run: bash local-deploy/tools/test_start_branch.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/start_branch.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

# A world: bare origin with main (one commit), a clone at $MDP/Repo on main, and a second clone ($T/other) used to move origin.
world() {
  T="$ROOT/w$RANDOM$RANDOM"; mkdir -p "$T/mdp"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/other" 2>/dev/null
  (cd "$T/other" && git checkout -q -b main 2>/dev/null; echo base > base.txt && git add . && git commit -qm base && git push -q origin main)
  git clone -q "$T/origin.git" "$T/mdp/Repo" 2>/dev/null
  R="$T/mdp/Repo"
}
advance_origin() { (cd "$T/other" && echo "$1" > "$1.txt" && git add . && git commit -qm "origin $1" && git push -q origin main); }
start() { OUT="$(MDP_ROOT="$T/mdp" bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
branch() { git -C "$R" branch --show-current; }

echo "from main: creates the branch at origin/main"
world; start Repo feat/x
check "exits 0 and is on the new branch" '[ $CODE = 0 ] && [ "$(branch)" = feat/x ]'
check "says where it is and the next step" 'echo "$OUT" | grep -q "on feat/x, at origin/main" && echo "$OUT" | grep -q "open_pr.sh Repo"'
check "no naming note for type/name" '! echo "$OUT" | grep -q "not .type/short-name"'

echo "fast-forwards main first, so the branch starts at the newest origin/main"
world; advance_origin two; start Repo fix/y
check "branch has the commit pushed to origin after the clone" '[ $CODE = 0 ] && [ -f "$R/two.txt" ]'
check "local main was fast-forwarded too" '[ "$(git -C $R rev-parse main)" = "$(git -C $R rev-parse origin/main)" ]'

echo "from another branch: leaves it, starts from main"
world; git -C "$R" checkout -q -b old/work; echo w > "$R/w.txt"; git -C "$R" add .; git -C "$R" commit -qm "unpushed work"
advance_origin three; start Repo docs/z
check "on the new branch, without the old branch's file" '[ $CODE = 0 ] && [ "$(branch)" = docs/z ] && [ ! -f "$R/w.txt" ] && [ -f "$R/three.txt" ]'
check "notes the unpushed branch it left" 'echo "$OUT" | grep -q "leaving old/work, which has 1 commit"'
check "old branch is untouched" 'git -C $R rev-parse -q --verify refs/heads/old/work >/dev/null'

echo "no note for a branch that exists on origin"
world; git -C "$R" checkout -q -b pushed/one; echo w > "$R/w.txt"; git -C "$R" add .; git -C "$R" commit -qm c; git -C "$R" push -q -u origin pushed/one
start Repo feat/q
check "silent about it" '[ $CODE = 0 ] && ! echo "$OUT" | grep -q "leaving"'

echo "refuses uncommitted tracked changes"
world; echo changed >> "$R/base.txt"; start Repo feat/x
check "exit 1, still on main, change kept" '[ $CODE = 1 ] && [ "$(branch)" = main ] && grep -q changed "$R/base.txt" && echo "$OUT" | grep -q "uncommitted tracked changes"'

echo "untracked files do not block"
world; echo u > "$R/untracked.txt"; start Repo feat/x
check "creates the branch" '[ $CODE = 0 ] && [ "$(branch)" = feat/x ] && [ -f "$R/untracked.txt" ]'

echo "refuses a branch that already exists"
world; git -C "$R" branch feat/x; start Repo feat/x
check "locally: exit 1" '[ $CODE = 1 ] && echo "$OUT" | grep -q "already exists locally"'
world; git -C "$T/other" push -q origin main:refs/heads/feat/x; start Repo feat/x
check "on origin: exit 1, still on main" '[ $CODE = 1 ] && [ "$(branch)" = main ] && echo "$OUT" | grep -q "already exists on origin"'

echo "refuses when local main has commits origin lacks, and goes back to where it was"
world; echo m > "$R/m.txt"; git -C "$R" add .; git -C "$R" commit -qm "local main commit"; git -C "$R" checkout -q -b side
advance_origin four; start Repo feat/x
check "exit 1 and says why" '[ $CODE = 1 ] && echo "$OUT" | grep -q "cannot be fast-forwarded"'
check "back on the branch it started from" '[ "$(branch)" = side ]'

echo "--base starts from another branch"
world; git -C "$T/other" checkout -q -b release; echo r > "$T/other/r.txt"; git -C "$T/other" add .; git -C "$T/other" commit -qm rel; git -C "$T/other" push -q origin release
start Repo feat/r --base release
check "branch holds the release commit" '[ $CODE = 0 ] && [ -f "$R/r.txt" ] && echo "$OUT" | grep -q "at origin/release"'

echo "a name that is not type/name gets a note, not a refusal"
world; start Repo mywork
check "exit 0 with the note" '[ $CODE = 0 ] && echo "$OUT" | grep -q "not .type/short-name"'

echo "usage and input errors"
world; start Repo
check "missing branch is 64" '[ $CODE = 64 ]'
start Nope feat/x
check "unknown repo is 64" '[ $CODE = 64 ]'
start Repo "bad name"
check "invalid branch name is refused" '[ $CODE = 1 ] && echo "$OUT" | grep -q "not a valid branch name"'
start Repo main
check "the base itself is refused" '[ $CODE = 1 ]'

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
