#!/usr/bin/env bash
# Tests for mdp_status.sh: real git repos in a temp dir, a fake `gh` on PATH. Run: bash local-deploy/tools/test_mdp_status.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/mdp_status.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

commit() { # $1 repo dir, $2 file
  (cd "$1" && echo "$2" > "$2" && git add "$2" && git commit -qm "add $2")
}

# A world: bare origin with main, a clone $MDP/Repo, and these local branches:
#   merged-same   squash-merged on origin, local tip == the PR head
#   merged-extra  squash-merged, but one more local commit after the PR head
#   open-one      open PR
#   closed-one    closed unmerged
#   nopr          pushed nowhere, no PR
#   inmain        fully contained in main
# The clone is left on feat/now (the "current" branch) with one dirty file and one untracked file.
world() {
  T="$ROOT/w$RANDOM$RANDOM"; mkdir -p "$T/bin" "$T/mdp"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/seed" 2>/dev/null
  (cd "$T/seed" && git checkout -q -b main 2>/dev/null; echo base > base.txt && git add . && git commit -qm base && git push -q origin main)
  git clone -q "$T/origin.git" "$T/mdp/Repo" 2>/dev/null
  R="$T/mdp/Repo"
  git -C "$R" branch inmain
  for b in merged-same merged-extra open-one closed-one nopr; do
    git -C "$R" checkout -q -b "$b" main; commit "$R" "$b.txt"
  done
  SAME="$(git -C "$R" rev-parse merged-same)"; EXTRA_HEAD="$(git -C "$R" rev-parse merged-extra)"
  OPEN="$(git -C "$R" rev-parse open-one)"; CLOSED="$(git -C "$R" rev-parse closed-one)"
  git -C "$R" checkout -q merged-extra; commit "$R" extra-after-pr.txt
  git -C "$R" checkout -q -b feat/now main; commit "$R" now.txt
  git -C "$R" push -q origin feat/now
  NOW="$(git -C "$R" rev-parse feat/now)"
  # origin moves on by one commit, so the current branch is behind
  (cd "$T/seed" && echo more > more.txt && git add . && git commit -qm more && git push -q origin main)
  # contained in origin/main but not in the (behind) local main: the case where `git branch -d` refuses a safe delete
  git -C "$R" fetch -q && git -C "$R" branch inorigin origin/main
  echo dirty > "$R/base.txt"; echo new > "$R/untracked.txt"
  cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
[ "${FAKE_GH_FAIL:-0}" = 1 ] && exit 1
case "$1 $2" in
  "pr list") printf '%b' "$FAKE_PRS" ;;
esac
GH
  chmod +x "$T/bin/gh"
  export FAKE_LOG="$T/gh.log" FAKE_GH_FAIL=0
  # name, number, state, head oid (tab separated, newest first)
  export FAKE_PRS="feat/now\t12\tOPEN\t$NOW\nmerged-same\t9\tMERGED\t$SAME\nmerged-extra\t8\tMERGED\t$EXTRA_HEAD\nopen-one\t7\tOPEN\t$OPEN\nclosed-one\t6\tCLOSED\t$CLOSED\n"
  : > "$FAKE_LOG"
}
status() { OUT="$(PATH="$T/bin:$PATH" MDP_ROOT="$T/mdp" bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
refs_before() { git -C "$R" for-each-ref --format='%(refname) %(objectname)' refs/heads; }

echo "report on a busy repo"
world; BEFORE="$(refs_before)"; HEADBEFORE="$(git -C "$R" rev-parse HEAD)"; status
check "exits 0" '[ $CODE = 0 ]'
check "names the repo and current branch" 'echo "$OUT" | grep -q "^== Repo  feat/now"'
check "current branch is +1 -1 vs origin/main (one own commit, origin moved on)" 'echo "$OUT" | grep -q "+1 -1 vs origin/main"'
check "local main is behind origin/main" 'echo "$OUT" | grep -q "local main: behind 1, ahead 0"'
check "counts dirty files (modified + untracked)" 'echo "$OUT" | grep -q "dirty: 2"'
check "lists the dirty files" 'echo "$OUT" | grep -q " M base.txt" && echo "$OUT" | grep -q "?? untracked.txt"'
check "current branch PR shown" 'echo "$OUT" | grep -q "PR #12 OPEN, pushed"'
check "branch with nothing new is in origin/main, with no warning when local main has it too" 'echo "$OUT" | grep -q "branch inmain: in origin/main$"'
check "branch contained in origin/main but not in the behind local main says so and how to delete it" 'echo "$OUT" | grep -q "branch inorigin: in origin/main, not yet in local main (behind): git branch -d refuses it; pull first or use -D"'
check "both are offered as deletable" 'echo "$OUT" | grep "deletable (not run)" | grep -q "inorigin"'
check "merged branch with tip == PR head" 'echo "$OUT" | grep -q "branch merged-same: PR #9 merged, tip == head"'
check "merged branch with a later commit is kept" 'echo "$OUT" | grep -q "branch merged-extra: PR #8 merged, +1 beyond the PR head: keep"'
check "open PR branch" 'echo "$OUT" | grep -q "branch open-one: PR #7 open, +1 vs main"'
check "closed PR branch" 'echo "$OUT" | grep -q "branch closed-one: PR #6 closed unmerged, +1 vs main"'
check "branch without a PR" 'echo "$OUT" | grep -q "branch nopr: no PR, +1 vs main"'
check "deletable list holds exactly the safe ones" 'echo "$OUT" | grep "deletable (not run)" | grep -q "inmain" && echo "$OUT" | grep "deletable (not run)" | grep -q "merged-same" && ! echo "$OUT" | grep "deletable (not run)" | grep -Eq "merged-extra|open-one|closed-one|nopr"'
check "changed no branch" '[ "$BEFORE" = "$(refs_before)" ]'
check "left HEAD and the working files alone" '[ "$HEADBEFORE" = "$(git -C $R rev-parse HEAD)" ] && [ "$(cat $R/base.txt)" = dirty ] && [ -f $R/untracked.txt ]'
check "output stays short" '[ "$(echo "$OUT" | wc -l)" -le 20 ]'

echo "--no-gh judges by commit counts only"
world; status --no-gh
check "no gh call made" '[ ! -s "$FAKE_LOG" ]'
check "PR state unknown, not a false 'no PR'" 'echo "$OUT" | grep -q "branch open-one: PR state unknown, +1 vs main" && ! echo "$OUT" | grep -q "no PR,"'
check "still finds the branch contained in origin/main" 'echo "$OUT" | grep -q "branch inmain: in origin/main$"'

echo "gh failing degrades with a note, never a crash"
world; export FAKE_GH_FAIL=1; status
check "exits 0 and says PR info was skipped" '[ $CODE = 0 ] && echo "$OUT" | grep -q "gh unavailable"'
check "no branch is called deletable on counts alone beyond in-main" '! echo "$OUT" | grep "deletable (not run)" | grep -q "merged-same"'

echo "--files caps the dirty list"
world; for i in 1 2 3 4 5; do echo x > "$R/f$i.txt"; done; status --files 2
check "shows 2 files then a remainder line" '[ "$(echo "$OUT" | grep -cE "^     (\?\?| M) ")" = 2 ] && echo "$OUT" | grep -q "\.\.\. +[0-9]* more"'

echo "named repo only, and a missing one"
world; status Repo --no-gh
check "named repo reported" 'echo "$OUT" | grep -q "^== Repo"'
status Nope --no-gh
check "missing repo is reported, not fatal" '[ $CODE = 0 ] && echo "$OUT" | grep -q "Nope: not a git repo"'

echo "usage errors"
world; status --bogus
check "exit 64" '[ $CODE = 64 ]'
status --files abc
check "non-numeric --files is refused" '[ $CODE = 64 ]'

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
