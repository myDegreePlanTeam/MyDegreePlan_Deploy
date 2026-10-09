#!/usr/bin/env bash
# finish_pr.sh: wait for CI, merge a PR, bring local main up to date and delete the PR's local branch, safely.
#
#   bash local-deploy/tools/finish_pr.sh REPO [PR] [--method squash|merge|rebase] [--wait SECONDS] [--delete-remote] [--dry-run]
#
#   PR    the pull request number (the one open_pr.sh printed). Left out, it is the PR of the branch REPO is on. A number
#         guessed from memory once acted on an unrelated, already merged PR (retro 2026-10-09), so when the number is given and
#         REPO is on another branch than that PR's, the script says so.
#   REPO  the folder under MDP/ (MyDegreePlan_Frontend, MyDegreePlan_Prototype, local-deploy); its GitHub name is read
#         from that folder's origin. Run it from MDP/ (the paths below), or from anywhere with the full path.
#
# What it does, in order (and stops at the first problem; nothing after a refusal runs)
#   1. reads the PR. CLOSED (unmerged) is refused; MERGED skips to step 4 (someone merged it in the UI);
#      a conflicting or draft PR is refused.
#   2. waits for CI (`gh pr checks --watch`, default 600 s). Failing or still-pending checks refuse. A repo that reports
#      no checks at all (the Prototype has no CI) is allowed, and said so.
#   3. merges with --method (default squash: that is how this project's PRs land).
#   4. in the repo folder: switches to the base branch, `git fetch --prune`, `git pull --ff-only`.
#   5. deletes the PR's local branch ONLY if its tip is the PR's head commit (what was reviewed and merged) or is already
#      in the base branch. A branch with extra local commits is kept and the count printed: `git branch -d` cannot tell
#      a squash-merged branch from an unmerged one, so this check is the safety, and `-D` is used only after it passes.
#   6. with --delete-remote, also deletes origin/<branch>. Off by default.
#
# Exit codes: 0 done; 1 refused (nothing merged); 2 merged but the local cleanup could not finish (message says why);
# 64 usage. --dry-run prints each step and changes nothing.
#
# Needs: git, gh (logged in). MDP_ROOT overrides the workspace root (the tests use it).
set -u

usage() { echo "usage: bash local-deploy/tools/finish_pr.sh REPO [PR] [--method squash|merge|rebase] [--wait SECONDS] [--delete-remote] [--dry-run]" >&2; exit 64; }

REPO=""; PR=""; METHOD=squash; WAIT=600; DELETE_REMOTE=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --method) [ $# -ge 2 ] || usage; METHOD="$2"; shift ;;
    --wait) [ $# -ge 2 ] || usage; WAIT="$2"; shift ;;
    --delete-remote) DELETE_REMOTE=1 ;;
    --dry-run) DRY=1 ;;
    -*) usage ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; elif [ -z "$PR" ]; then PR="$1"; else usage; fi ;;
  esac
  shift
done
[ -n "$REPO" ] || usage
case "$METHOD" in squash|merge|rebase) ;; *) usage ;; esac
case "$PR" in *[!0-9]*) usage ;; esac
case "$WAIT" in ''|*[!0-9]*) usage ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MDP="${MDP_ROOT:-$(cd "$HERE/../.." && pwd)}"   # this file is MDP/local-deploy/tools/finish_pr.sh
DIR="$MDP/$REPO"
[ -d "$DIR/.git" ] || { echo "finish_pr: $DIR is not a git repo (REPO is a folder under $MDP)" >&2; exit 64; }

say()  { echo "  $*"; }
step() { echo "$*"; }
refuse() { echo "finish_pr: refused, nothing merged: $*" >&2; exit 1; }
partial() { echo "finish_pr: PR #$PR is merged, but $*" >&2; exit 2; }
run() { if [ "$DRY" = 1 ]; then say "(dry run) $*"; else "$@"; fi; }

SLUG="$(cd "$DIR" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
[ -n "$SLUG" ] || refuse "could not read the GitHub repo of $DIR (gh logged in? origin set?)"

PR_GIVEN=1
if [ -z "$PR" ]; then
  PR_GIVEN=0
  CURB="$(git -C "$DIR" branch --show-current 2>/dev/null)"
  { [ -n "$CURB" ] && [ "$CURB" != main ]; } || refuse "no PR number given, and $REPO is on ${CURB:-a detached HEAD}, not on a PR branch"
  PR="$(cd "$DIR" && gh pr list --repo "$SLUG" --head "$CURB" --state all --limit 1 --json number -q '.[0].number' 2>/dev/null)"
  [ -n "$PR" ] || refuse "no PR number given, and no pull request has the head branch $CURB"
  echo "(no PR number given: using #$PR, the pull request of the current branch $CURB)"
fi

step "1. PR #$PR in $SLUG"
read -r STATE BRANCH HEAD BASE MERGEABLE DRAFT <<<"$(cd "$DIR" && gh pr view "$PR" --repo "$SLUG" \
  --json state,headRefName,headRefOid,baseRefName,mergeable,isDraft \
  -q '[.state, .headRefName, .headRefOid, .baseRefName, .mergeable, .isDraft] | join(" ")' 2>/dev/null)"
[ -n "${STATE:-}" ] || refuse "could not read PR #$PR"
say "$STATE: $BRANCH -> $BASE (head ${HEAD:0:7})"
if [ "$PR_GIVEN" = 1 ]; then
  ONB="$(git -C "$DIR" branch --show-current 2>/dev/null)"
  [ "$ONB" = "$BRANCH" ] || say "note: $REPO is on '${ONB:-a detached HEAD}', not on this PR's branch $BRANCH; check that #$PR is the number open_pr.sh printed"
fi

MERGED_ALREADY=0
case "$STATE" in
  MERGED) MERGED_ALREADY=1; say "already merged; skipping to the local cleanup" ;;
  CLOSED) refuse "PR #$PR is closed without being merged" ;;
  OPEN) ;;
  *) refuse "unexpected PR state $STATE" ;;
esac

if [ "$MERGED_ALREADY" = 0 ]; then
  [ "$DRAFT" = true ] && refuse "PR #$PR is a draft"
  [ "$MERGEABLE" = CONFLICTING ] && refuse "PR #$PR has merge conflicts with $BASE"

  step "2. CI"
  if [ "$DRY" = 1 ]; then say "(dry run) would wait up to ${WAIT}s for checks"
  else
    OUT="$(cd "$DIR" && timeout "$WAIT" gh pr checks "$PR" --repo "$SLUG" --watch --interval 10 2>&1)"; CODE=$?
    if [ "$CODE" = 0 ]; then say "all checks pass"
    elif echo "$OUT" | grep -qi "no checks reported"; then say "this repo reports no checks (nothing to wait for)"
    elif [ "$CODE" = 124 ] || [ "$CODE" = 8 ]; then echo "$OUT" | tail -5 >&2; refuse "checks are still pending after ${WAIT}s (re-run with --wait N)"
    else echo "$OUT" | tail -8 >&2; refuse "a check failed"; fi
  fi

  step "3. Merge ($METHOD)"
  if [ "$DRY" = 1 ]; then say "(dry run) gh pr merge $PR --$METHOD"
  else
    MOUT="$(cd "$DIR" && gh pr merge "$PR" --repo "$SLUG" "--$METHOD" 2>&1)"; MCODE=$?
    [ -n "$MOUT" ] && echo "$MOUT" | sed 's/^/  /'
    [ "$MCODE" = 0 ] || refuse "gh pr merge failed"
  fi
fi

step "4. Local $BASE"
cd "$DIR" || partial "cannot enter $DIR"
if [ "$DRY" = 1 ]; then say "(dry run) git checkout $BASE; git fetch --prune; git pull --ff-only"
else
  CUR="$(git branch --show-current)"
  if [ "$CUR" != "$BASE" ]; then
    git checkout -q "$BASE" 2>/dev/null || partial "could not switch to $BASE (uncommitted changes in the way?); $BRANCH not deleted"
  fi
  git fetch -q --prune 2>/dev/null || partial "git fetch failed"
  git pull -q --ff-only 2>/dev/null || partial "$BASE cannot fast-forward (local commits on $BASE?); $BRANCH not deleted"
  say "$BASE is at $(git log --oneline -1 | cut -c1-90)"
fi

step "5. Local branch $BRANCH"
if [ "$BRANCH" = "$BASE" ] || [ "$BRANCH" = main ]; then say "is the base branch; leaving it"
elif ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then say "no local branch of that name"
else
  TIP="$(git rev-parse "refs/heads/$BRANCH")"
  if [ "$TIP" = "$HEAD" ] || git merge-base --is-ancestor "$TIP" "$BASE" 2>/dev/null; then
    if [ "$DRY" = 1 ]; then say "(dry run) would delete $BRANCH (tip ${TIP:0:7} matches the merged PR)"
    else git branch -D "$BRANCH" | sed 's/^/  /'; fi
  else
    EXTRA="$(git rev-list --count "$HEAD..$TIP" 2>/dev/null || echo '?')"
    say "KEPT: $BRANCH is at ${TIP:0:7}, not the merged head ${HEAD:0:7} ($EXTRA commit(s) beyond it that were not in the PR)"
  fi
fi

if [ "$DELETE_REMOTE" = 1 ] && [ "$BRANCH" != "$BASE" ] && [ "$BRANCH" != main ]; then
  step "6. Remote branch origin/$BRANCH"
  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then run git push -q origin --delete "$BRANCH" && say "deleted"
  else say "already gone"; fi
fi
echo "finish_pr: done"
