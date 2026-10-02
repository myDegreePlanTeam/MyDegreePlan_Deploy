#!/usr/bin/env bash
# open_pr.sh: push the current branch and open its pull request, safely. The half of the PR flow before finish_pr.sh.
#
#   bash local-deploy/tools/open_pr.sh REPO --title "type(scope): text" --body-file FILE|- [--base main] [--draft] [--yes]
#
#   REPO         the folder under MDP/ (MyDegreePlan_Frontend, MyDegreePlan_Prototype, local-deploy, ...)
#   --title      the PR title; by this project's convention `type(scope): description`
#   --body-file  the PR description (a file, or - for stdin). The "Generated with Claude Code" attribution line is
#                appended when it is not already there
#   --base       the branch to merge into (default main)
#   --draft      open it as a draft
#   --yes        actually push and open the PR. WITHOUT IT NOTHING IS PUSHED OR CREATED: the script prints the plan
#                (branch, commits, title, what would be pushed) and stops. That is the confirmation step.
#
# It does not write the commit or the title or the body: those are judgment, and stay with whoever runs it.
#
# What it checks, in order (it stops at the first problem; nothing is pushed unless every check passed and --yes was given)
#   1. REPO is a git repo, on a branch that is not the base branch, and the branch has commits that the base lacks
#      (after `git fetch origin BASE`, which updates remote-tracking refs only)
#   2. no open PR already exists for the branch (a second one would be a duplicate; push new commits with git push)
#   3. --title and --body-file are given and the body is not empty
# Then, with --yes: `git push -u origin BRANCH` (never --force: a rejected push stops here, and no PR is created), then
# `gh pr create`. Uncommitted changes are listed but are not in the PR.
#
# Exit codes: 0 done, or the dry run; 1 refused (nothing pushed); 2 pushed but the PR could not be created; 64 usage.
# Next step after CI: bash local-deploy/tools/finish_pr.sh REPO N
#
# Needs: git, gh (logged in). MDP_ROOT overrides the workspace root (the tests use it).
set -u

usage() { echo "usage: bash local-deploy/tools/open_pr.sh REPO --title TITLE --body-file FILE|- [--base BRANCH] [--draft] [--yes]" >&2; exit 64; }

REPO=""; TITLE=""; BODYFILE=""; BASE=main; DRAFT=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --title) [ $# -ge 2 ] || usage; TITLE="$2"; shift ;;
    --body-file) [ $# -ge 2 ] || usage; BODYFILE="$2"; shift ;;
    --base) [ $# -ge 2 ] || usage; BASE="$2"; shift ;;
    --draft) DRAFT=1 ;;
    --yes) YES=1 ;;
    -*) usage ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; else usage; fi ;;
  esac
  shift
done
[ -n "$REPO" ] && [ -n "$TITLE" ] && [ -n "$BODYFILE" ] || usage

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MDP="${MDP_ROOT:-$(cd "$HERE/../.." && pwd)}"   # this file is MDP/local-deploy/tools/open_pr.sh
DIR="$MDP/$REPO"
[ -d "$DIR/.git" ] || { echo "open_pr: $DIR is not a git repo (REPO is a folder under $MDP)" >&2; exit 64; }

refuse() { echo "open_pr: refused, nothing pushed: $*" >&2; exit 1; }
say() { echo "  $*"; }
g() { git -C "$DIR" "$@"; }

BRANCH="$(g branch --show-current)"
[ -n "$BRANCH" ] || refuse "HEAD is detached; check out the branch to open a PR for"
[ "$BRANCH" != "$BASE" ] || refuse "you are on $BASE; create a branch first (CLAUDE.md: never work directly on main)"

g fetch -q origin "$BASE" 2>/dev/null || refuse "could not fetch origin/$BASE"
AHEAD="$(g rev-list --count "origin/$BASE..HEAD" 2>/dev/null)" || refuse "origin/$BASE not found"
[ "$AHEAD" -gt 0 ] || refuse "$BRANCH has no commits that origin/$BASE lacks"
BEHIND="$(g rev-list --count "HEAD..origin/$BASE")"

SLUG="$(cd "$DIR" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
[ -n "$SLUG" ] || refuse "could not read the GitHub repo of $DIR (gh logged in? origin set?)"
EXISTING="$(cd "$DIR" && gh pr list --repo "$SLUG" --head "$BRANCH" --state open --json number,url --jq '.[] | "#\(.number) \(.url)"' 2>/dev/null | head -n 1)"
[ -z "$EXISTING" ] || refuse "an open PR already exists for $BRANCH: $EXISTING (push new commits with git push)"

if [ "$BODYFILE" = "-" ]; then BODY="$(cat)"; else
  [ -f "$BODYFILE" ] || refuse "--body-file $BODYFILE does not exist"
  BODY="$(cat "$BODYFILE")"
fi
[ -n "$(printf '%s' "$BODY" | tr -d '[:space:]')" ] || refuse "the PR body is empty"
ATTRIBUTION='🤖 Generated with [Claude Code](https://claude.com/claude-code)'
case "$BODY" in *"Generated with [Claude Code]"*) ;; *) BODY="$BODY"$'\n\n'"$ATTRIBUTION" ;; esac

echo "open_pr: $SLUG  $BRANCH -> $BASE"
echo "  title: $TITLE"
echo "$TITLE" | grep -Eq '^(fix|feat|chore|test|seed|docs|refactor|data|schema)(\([^)]+\))?!?: .+' \
  || say "note: the title is not 'type(scope): description' (types: fix feat chore test seed docs refactor data schema)"
echo "  commits ($AHEAD ahead, $BEHIND behind origin/$BASE):"
g log --format='    %h %s' "origin/$BASE..HEAD" | head -n 10
[ "$AHEAD" -le 10 ] || say "... +$((AHEAD - 10)) more"
[ "$BEHIND" = 0 ] || say "note: $BRANCH is $BEHIND commit(s) behind origin/$BASE (the PR may need a merge or rebase)"
DIRTY="$(g status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
[ "$DIRTY" = 0 ] || say "note: $DIRTY modified tracked file(s) are NOT committed and will not be in the PR"
REMOTE_SHA="$(g rev-parse -q --verify "refs/remotes/origin/$BRANCH" 2>/dev/null || true)"
if [ -z "$REMOTE_SHA" ]; then PUSH="push -u origin $BRANCH (new remote branch)"
elif [ "$REMOTE_SHA" = "$(g rev-parse HEAD)" ]; then PUSH="nothing to push (origin/$BRANCH is already at HEAD)"
else PUSH="push -u origin $BRANCH (updates the existing remote branch)"; fi
say "push: $PUSH"
say "body: $(printf '%s\n' "$BODY" | wc -l | tr -d ' ') lines$([ "$DRAFT" = 1 ] && echo ', opened as a draft')"

if [ "$YES" != 1 ]; then
  echo "open_pr: dry run, nothing pushed or created. Re-run with --yes to do it."
  exit 0
fi

case "$PUSH" in
  nothing*) ;;
  *) PUSHOUT="$(g push -u origin "$BRANCH" 2>&1)" || { echo "$PUSHOUT" | tail -5 | sed 's/^/  /' >&2; refuse "git push failed (rejected? it is never forced); no PR created"; } ;;
esac

TMP="$(mktemp)"; printf '%s\n' "$BODY" > "$TMP"
ARGS=(--repo "$SLUG" --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file "$TMP")
[ "$DRAFT" = 1 ] && ARGS+=(--draft)
URL="$(cd "$DIR" && gh pr create "${ARGS[@]}" 2>&1)"; CODE=$?
rm -f "$TMP"
if [ "$CODE" != 0 ]; then
  echo "$URL" | tail -5 | sed 's/^/  /' >&2
  echo "open_pr: $BRANCH is pushed, but gh pr create failed (see above)" >&2
  exit 2
fi
URL="$(echo "$URL" | tail -n 1)"
echo "open_pr: opened $URL"
echo "  next: bash local-deploy/tools/finish_pr.sh $REPO ${URL##*/}"
