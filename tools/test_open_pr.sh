#!/usr/bin/env bash
# Tests for open_pr.sh: real git repos in a temp dir, a fake `gh` on PATH. Run: bash local-deploy/tools/test_open_pr.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/open_pr.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

# A world: bare origin with main, a clone at $MDP/Repo checked out on feat/x with two local commits (not pushed).
world() {
  T="$ROOT/w$RANDOM$RANDOM"; mkdir -p "$T/bin" "$T/mdp"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/seed" 2>/dev/null
  (cd "$T/seed" && git checkout -q -b main 2>/dev/null; echo base > base.txt && git add . && git commit -qm base && git push -q origin main)
  git clone -q "$T/origin.git" "$T/mdp/Repo" 2>/dev/null
  R="$T/mdp/Repo"
  (cd "$R" && git checkout -q -b feat/x && echo 1 > one.txt && git add . && git commit -qm "feat: one" && echo 2 > two.txt && git add . && git commit -qm "feat: two")
  printf 'Why this change.\n' > "$T/body.md"
  cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "repo view") echo "acme/repo" ;;
  "pr list") printf '%s' "$FAKE_PRLIST" ;;
  "pr create")
    while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$FAKE_BODY_OUT"; shift; done
    [ "${FAKE_CREATE_CODE:-0}" = 0 ] || { echo "create failed"; exit 1; }
    echo "https://github.com/acme/repo/pull/42" ;;
esac
GH
  chmod +x "$T/bin/gh"
  export FAKE_LOG="$T/gh.log" FAKE_BODY_OUT="$T/body.sent" FAKE_PRLIST="" FAKE_CREATE_CODE=0
  : > "$FAKE_LOG"
}
open_pr() { OUT="$(PATH="$T/bin:$PATH" MDP_ROOT="$T/mdp" bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
created() { grep -c "pr create" "$FAKE_LOG"; }
origin_has() { git --git-dir="$T/origin.git" show-ref --verify --quiet "refs/heads/$1"; }

echo "default is a dry run: plan printed, nothing pushed, nothing created"
world; open_pr Repo --title "feat(x): add things" --body-file "$T/body.md"
check "exits 0" '[ $CODE = 0 ]'
check "branch not pushed" '! origin_has feat/x'
check "no gh pr create" '[ "$(created)" = 0 ]'
check "says it is a dry run and how to proceed" 'echo "$OUT" | grep -q "dry run, nothing pushed or created. Re-run with --yes"'
check "lists both commits" 'echo "$OUT" | grep -q "feat: one" && echo "$OUT" | grep -q "feat: two" && echo "$OUT" | grep -q "2 ahead, 0 behind"'
check "names the repo, branch and base" 'echo "$OUT" | grep -q "acme/repo  feat/x -> main"'
check "says what it would push" 'echo "$OUT" | grep -q "push: push -u origin feat/x (new remote branch)"'

echo "--yes pushes and opens the PR"
world; open_pr Repo --title "feat(x): add things" --body-file "$T/body.md" --yes
check "exits 0" '[ $CODE = 0 ]'
check "branch is on origin" 'origin_has feat/x'
check "local branch tracks it" '[ "$(git -C $R rev-parse --abbrev-ref feat/x@{upstream})" = origin/feat/x ]'
check "gh pr create got base, head and title" 'grep "pr create" "$FAKE_LOG" | grep -q -- "--base main --head feat/x --title feat(x): add things"'
check "prints the URL and the finish_pr command" 'echo "$OUT" | grep -q "opened https://github.com/acme/repo/pull/42" && echo "$OUT" | grep -q "finish_pr.sh Repo 42"'
check "attribution line appended to the body" 'grep -q "Generated with \[Claude Code\]" "$FAKE_BODY_OUT" && grep -q "Why this change" "$FAKE_BODY_OUT"'

echo "an attribution already in the body is not duplicated"
world; printf 'Why.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' > "$T/body.md"; open_pr Repo --title "docs: x" --body-file "$T/body.md" --yes
check "exactly one attribution" '[ "$(grep -c "Generated with" "$FAKE_BODY_OUT")" = 1 ]'

echo "body from stdin, and --draft is passed"
world; OUT="$(printf 'From stdin.\n' | PATH="$T/bin:$PATH" MDP_ROOT="$T/mdp" bash "$SCRIPT" Repo --title "docs: x" --body-file - --draft --yes 2>&1)"; CODE=$?
check "exits 0 and sent the stdin body" '[ $CODE = 0 ] && grep -q "From stdin" "$FAKE_BODY_OUT"'
check "gh got --draft" 'grep "pr create" "$FAKE_LOG" | grep -q -- "--draft"'

echo "refuses on the base branch"
world; git -C "$R" checkout -q main; open_pr Repo --title "docs: x" --body-file "$T/body.md" --yes
check "exit 1, nothing created" '[ $CODE = 1 ] && [ "$(created)" = 0 ] && echo "$OUT" | grep -q "you are on main"'

echo "refuses a branch with nothing new"
world; git -C "$R" checkout -q -b empty main; open_pr Repo --title "docs: x" --body-file "$T/body.md" --yes
check "exit 1, nothing pushed" '[ $CODE = 1 ] && ! origin_has empty && echo "$OUT" | grep -q "no commits that origin/main lacks"'

echo "refuses when a PR is already open for the branch"
world; export FAKE_PRLIST="#7 https://github.com/acme/repo/pull/7"; open_pr Repo --title "docs: x" --body-file "$T/body.md" --yes
check "exit 1, no push, no create" '[ $CODE = 1 ] && ! origin_has feat/x && [ "$(created)" = 0 ] && echo "$OUT" | grep -q "already exists for feat/x: #7"'

echo "a rejected push is never forced and creates no PR"
world; (cd "$T/seed" && git checkout -q -b feat/x && echo other > other.txt && git add . && git commit -qm "someone else" && git push -q origin feat/x); open_pr Repo --title "docs: x" --body-file "$T/body.md" --yes
check "exit 1, no PR" '[ $CODE = 1 ] && [ "$(created)" = 0 ] && echo "$OUT" | grep -q "git push failed"'
check "remote branch untouched" '[ "$(git --git-dir=$T/origin.git log -1 --format=%s feat/x)" = "someone else" ]'

echo "PR creation failing after the push exits 2 and says the branch is pushed"
world; export FAKE_CREATE_CODE=1; open_pr Repo --title "docs: x" --body-file "$T/body.md" --yes
check "exit 2" '[ $CODE = 2 ] && origin_has feat/x && echo "$OUT" | grep -q "is pushed, but gh pr create failed"'

echo "notes: odd title, uncommitted changes, behind base"
world; echo more >> "$R/one.txt"; (cd "$T/seed" && echo n > n.txt && git add . && git commit -qm "main moves" && git push -q origin main)
open_pr Repo --title "Add things" --body-file "$T/body.md"
check "title note" 'echo "$OUT" | grep -q "title is not .type(scope): description"'
check "uncommitted note" 'echo "$OUT" | grep -q "1 modified tracked file(s) are NOT committed"'
check "behind note" 'echo "$OUT" | grep -q "1 commit(s) behind origin/main"'

echo "usage and input errors"
world; open_pr Repo --title "docs: x"
check "missing --body-file is 64" '[ $CODE = 64 ]'
open_pr Repo --body-file "$T/body.md"
check "missing --title is 64" '[ $CODE = 64 ]'
open_pr Nope --title "docs: x" --body-file "$T/body.md"
check "unknown repo is 64" '[ $CODE = 64 ]'
: > "$T/empty.md"; open_pr Repo --title "docs: x" --body-file "$T/empty.md" --yes
check "empty body is refused" '[ $CODE = 1 ] && ! origin_has feat/x'
open_pr Repo --title "docs: x" --body-file "$T/nope.md" --yes
check "missing body file is refused" '[ $CODE = 1 ]'

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
