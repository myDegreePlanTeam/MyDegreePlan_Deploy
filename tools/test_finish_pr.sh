#!/usr/bin/env bash
# Tests for finish_pr.sh: real git repos in a temp dir, a fake `gh` on PATH. Run: bash local-deploy/tools/test_finish_pr.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/finish_pr.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false   # no CRLF warnings from the Windows config
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

# A fresh world: bare origin with main, a clone at $MDP/Repo, and branch feat/x pushed with one commit.
# The clone is left ON feat/x, as it is when someone finishes a PR from its own branch.
world() {
  T="$ROOT/w$RANDOM$RANDOM"; mkdir -p "$T/bin" "$T/mdp"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/seed" 2>/dev/null
  (cd "$T/seed" && git checkout -q -b main 2>/dev/null; echo base > base.txt && git add . && git commit -qm base && git push -q origin main)
  git clone -q "$T/origin.git" "$T/mdp/Repo" 2>/dev/null
  (cd "$T/mdp/Repo" && git checkout -q -b feat/x && echo x > x.txt && git add . && git commit -qm "feat x" && git push -q origin feat/x)
  HEADSHA="$(git -C "$T/mdp/Repo" rev-parse feat/x)"
  cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "repo view") echo "acme/repo" ;;
  "pr view") echo "$FAKE_PR" ;;
  "pr list") echo "${FAKE_PR_LIST-7}" ;;
  "pr checks") echo "$FAKE_CHECKS_OUT"; exit "${FAKE_CHECKS_CODE:-0}" ;;
  "pr merge")
    [ "${FAKE_MERGE_CODE:-0}" = 0 ] || { echo "merge failed"; exit 1; }
    w="$(mktemp -d)"; git clone -q "$FAKE_ORIGIN" "$w" 2>/dev/null
    (cd "$w" && git merge -q --squash origin/feat/x && git commit -qm "feat x (#7)" && git push -q origin main) ;;
esac
GH
  chmod +x "$T/bin/gh"
  export FAKE_LOG="$T/gh.log" FAKE_ORIGIN="$T/origin.git" FAKE_CHECKS_CODE=0 FAKE_CHECKS_OUT="all pass" FAKE_MERGE_CODE=0
  export FAKE_PR="OPEN feat/x $HEADSHA main MERGEABLE false"
  : > "$FAKE_LOG"
}
finish() { OUT="$(PATH="$T/bin:$PATH" MDP_ROOT="$T/mdp" bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
merged_log() { grep -c "pr merge" "$FAKE_LOG"; }
branch_exists() { git -C "$T/mdp/Repo" show-ref --verify --quiet refs/heads/feat/x; }
origin_has_x() { git --git-dir="$T/origin.git" show main:x.txt >/dev/null 2>&1; }

echo "happy path (squash, run from the PR branch)"
world; finish Repo 7
check "exits 0" '[ $CODE = 0 ]'
check "merged on origin" 'origin_has_x'
check "local main fast-forwarded to the squash commit" '[ "$(git -C $T/mdp/Repo rev-parse main)" = "$(git --git-dir=$T/origin.git rev-parse main)" ]'
check "left on main" '[ "$(git -C $T/mdp/Repo branch --show-current)" = main ]'
check "branch deleted though git -d would refuse a squash" '! branch_exists'
check "squash method passed to gh" 'grep -q -- "pr merge 7 --repo acme/repo --squash" "$FAKE_LOG"'

echo "--method merge is passed through"
world; finish Repo 7 --method merge
check "gh got --merge" 'grep -q -- "--merge" "$FAKE_LOG"'

echo "a branch with extra local commits is kept"
world; (cd "$T/mdp/Repo" && echo more > more.txt && git add . && git commit -qm "unpushed extra"); finish Repo 7
check "exits 0 and merges" '[ $CODE = 0 ] && origin_has_x'
check "branch kept" 'branch_exists'
check "says how many commits were not in the PR" 'echo "$OUT" | grep -q "KEPT.*1 commit"'

echo "failing checks refuse before merging"
world; export FAKE_CHECKS_CODE=1 FAKE_CHECKS_OUT="test fail 3s"; finish Repo 7
check "exit 1" '[ $CODE = 1 ]'
check "gh pr merge never called" '[ "$(merged_log)" = 0 ]'
check "branch and origin untouched" 'branch_exists && ! origin_has_x'

echo "pending checks refuse"
world; export FAKE_CHECKS_CODE=8 FAKE_CHECKS_OUT="test pending"; finish Repo 7
check "exit 1 and no merge" '[ $CODE = 1 ] && [ "$(merged_log)" = 0 ]'

echo "a repo with no CI is allowed"
world; export FAKE_CHECKS_CODE=1 FAKE_CHECKS_OUT="no checks reported on the 'feat/x' branch"; finish Repo 7
check "merges and says so" '[ $CODE = 0 ] && origin_has_x && echo "$OUT" | grep -q "no checks"'

echo "already merged elsewhere: no merge call, still cleans up"
world; (w="$ROOT/m$RANDOM"; git clone -q "$T/origin.git" "$w" 2>/dev/null; cd "$w" && git merge -q --squash origin/feat/x && git commit -qm "feat x (#7)" && git push -q origin main)
export FAKE_PR="MERGED feat/x $HEADSHA main UNKNOWN false"; finish Repo 7
check "exit 0, gh pr merge not called" '[ $CODE = 0 ] && [ "$(merged_log)" = 0 ]'
check "main pulled and branch deleted" '! branch_exists && [ "$(git -C $T/mdp/Repo rev-parse main)" = "$(git --git-dir=$T/origin.git rev-parse main)" ]'

echo "closed, draft and conflicting PRs refuse"
for state in "CLOSED feat/x HEAD main UNKNOWN false" "OPEN feat/x HEAD main MERGEABLE true" "OPEN feat/x HEAD main CONFLICTING false"; do
  world; export FAKE_PR="${state/HEAD/$HEADSHA}"; finish Repo 7
  check "refuses: ${state%% feat*} / $(echo "$state" | awk '{print $5, $6}')" '[ $CODE = 1 ] && [ "$(merged_log)" = 0 ] && branch_exists'
done

echo "merge failure refuses and keeps everything"
world; export FAKE_MERGE_CODE=1; finish Repo 7
check "exit 1, branch kept" '[ $CODE = 1 ] && branch_exists'

echo "--dry-run changes nothing"
world; finish Repo 7 --dry-run
check "exit 0, no merge, branch kept, still on the PR branch" '[ $CODE = 0 ] && [ "$(merged_log)" = 0 ] && branch_exists && [ "$(git -C $T/mdp/Repo branch --show-current)" = feat/x ]'

echo "local main with its own commits cannot fast-forward: exit 2, branch kept"
world; (cd "$T/mdp/Repo" && git checkout -q main && echo local > local.txt && git add . && git commit -qm "local main commit" && git checkout -q feat/x); finish Repo 7
check "exit 2 and the merge did happen" '[ $CODE = 2 ] && origin_has_x'
check "branch kept and the reason printed" 'branch_exists && echo "$OUT" | grep -q "cannot fast-forward"'

echo "--delete-remote removes origin/branch"
world; finish Repo 7 --delete-remote
check "origin has no feat/x" '! git --git-dir="$T/origin.git" show-ref --verify --quiet refs/heads/feat/x'

echo "no PR number: the PR of the branch the repo is on"
world; finish Repo
check "exits 0 and merges PR 7" '[ $CODE = 0 ] && origin_has_x && grep -q -- "pr merge 7 --repo acme/repo --squash" "$FAKE_LOG"'
check "looks the PR up by the current branch" 'grep -q -- "pr list --repo acme/repo --head feat/x" "$FAKE_LOG"'
check "says which PR it picked" 'echo "$OUT" | grep -q "no PR number given: using #7"'
check "branch deleted as usual" '! branch_exists'
world; (cd "$T/mdp/Repo" && git checkout -q main); finish Repo
check "on main with no number: refuses, merges nothing" '[ $CODE = 1 ] && [ "$(merged_log)" = 0 ] && echo "$OUT" | grep -q "not on a PR branch"'
world; export FAKE_PR_LIST=""; finish Repo
check "a branch with no pull request: refuses, merges nothing" '[ $CODE = 1 ] && [ "$(merged_log)" = 0 ] && echo "$OUT" | grep -q "no pull request has the head branch feat/x"'
unset FAKE_PR_LIST

echo "a number given while the repo is on another branch: merges as asked but says so"
world; (cd "$T/mdp/Repo" && git checkout -q main); finish Repo 7
check "note names both branches" 'echo "$OUT" | grep -q "note: Repo is on .main., not on this PR.s branch feat/x"'
world; finish Repo 7
check "no note when the branch matches" '! echo "$OUT" | grep -q "^  note:"'

echo "usage errors"
world; finish
check "no args -> 64" '[ $CODE = 64 ]'
finish Repo abc
check "non-numeric PR -> 64" '[ $CODE = 64 ]'
finish Repo 7 --method rebase-ish
check "bad method -> 64" '[ $CODE = 64 ]'
finish NoSuchRepo 7
check "unknown folder -> 64" '[ $CODE = 64 ]'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
