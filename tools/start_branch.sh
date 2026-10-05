#!/usr/bin/env bash
# start_branch.sh: start a work branch the way CLAUDE.md asks, in one step: fetch, check out the base branch, fast-forward it
# to origin, create the new branch from it. The first half of the PR flow (open_pr.sh and finish_pr.sh are the rest).
#
#   bash local-deploy/tools/start_branch.sh REPO BRANCH [--base main]
#
#   REPO    the folder under MDP/ (MyDegreePlan_Frontend, MyDegreePlan_Prototype, MyDegreePlan_Site, local-deploy)
#   BRANCH  the new branch, by convention `type/short-name` (fix feat chore test seed docs refactor data schema)
#   --base  the branch to start from (default main)
#
# Refuses, and changes nothing, when: the working tree has uncommitted tracked changes (they would be carried onto the new
# branch or block the checkout: commit or park them deliberately), the branch already exists locally or on origin, or the base
# cannot be fast-forwarded (the local base has commits origin lacks). Untracked files are left alone. Never deletes, resets or
# forces anything. Prints a note, and still goes ahead, when it leaves a branch that has commits not on origin/BASE and not
# pushed, so a forgotten branch is visible.
#
# Exit codes: 0 done, 1 refused (nothing changed), 64 usage. MDP_ROOT overrides the workspace root (the tests use it).
set -u

usage() { echo "usage: bash local-deploy/tools/start_branch.sh REPO BRANCH [--base BRANCH]" >&2; exit 64; }

REPO=""; BRANCH=""; BASE=main
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || usage; BASE="$2"; shift ;;
    -*) usage ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; elif [ -z "$BRANCH" ]; then BRANCH="$1"; else usage; fi ;;
  esac
  shift
done
[ -n "$REPO" ] && [ -n "$BRANCH" ] || usage

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MDP="${MDP_ROOT:-$(cd "$HERE/../.." && pwd)}"   # this file is MDP/local-deploy/tools/start_branch.sh
DIR="$MDP/$REPO"
[ -d "$DIR/.git" ] || { echo "start_branch: $DIR is not a git repo (REPO is a folder under $MDP)" >&2; exit 64; }

refuse() { echo "start_branch: refused, nothing changed: $*" >&2; exit 1; }
g() { git -C "$DIR" "$@"; }

git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || refuse "'$BRANCH' is not a valid branch name"
[ "$BRANCH" != "$BASE" ] || refuse "the new branch is the base branch"

DIRTY="$(g status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || refuse "uncommitted tracked changes would come along: $(echo "$DIRTY" | wc -l | tr -d ' ') file(s), first: $(echo "$DIRTY" | head -n 1 | sed 's/^ *//')"

g fetch -q origin "$BASE" 2>/dev/null || refuse "could not fetch origin/$BASE"
g rev-parse -q --verify "refs/remotes/origin/$BASE" >/dev/null || refuse "origin/$BASE not found"
if g rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then refuse "branch $BRANCH already exists locally (check it out, or pick another name)"; fi
if g ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then refuse "branch $BRANCH already exists on origin"; fi

CURRENT="$(g branch --show-current)"
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$BASE" ]; then
  LEFT="$(g rev-list --count "origin/$BASE..$CURRENT" 2>/dev/null || echo 0)"
  if [ "$LEFT" -gt 0 ] && ! g rev-parse -q --verify "refs/remotes/origin/$CURRENT" >/dev/null; then
    echo "  note: leaving $CURRENT, which has $LEFT commit(s) not on origin/$BASE and no branch on origin"
  fi
fi

if g rev-parse -q --verify "refs/heads/$BASE" >/dev/null; then
  g checkout -q "$BASE" || refuse "could not check out $BASE"
  g merge -q --ff-only "origin/$BASE" >/dev/null 2>&1 || { [ -n "$CURRENT" ] && [ "$CURRENT" != "$BASE" ] && g checkout -q "$CURRENT"; refuse "local $BASE cannot be fast-forwarded to origin/$BASE (it has commits origin lacks)"; }
  g checkout -q -b "$BRANCH" || refuse "could not create $BRANCH"
else
  g checkout -q -b "$BRANCH" "origin/$BASE" || refuse "could not create $BRANCH from origin/$BASE"
fi

echo "start_branch: $REPO is on $BRANCH, at origin/$BASE ($(g log -1 --format='%h %s' | cut -c1-70))"
echo "$BRANCH" | grep -Eq '^(fix|feat|chore|test|seed|docs|refactor|data|schema)/.+' \
  || echo "  note: the name is not 'type/short-name' (types: fix feat chore test seed docs refactor data schema)"
echo "  next: commit with explicit paths, then: bash local-deploy/tools/open_pr.sh $REPO --title \"type(scope): text\" --body-file - --yes"
