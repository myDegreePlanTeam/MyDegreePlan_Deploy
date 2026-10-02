#!/usr/bin/env bash
# mdp_status.sh: one terse, read-only snapshot of every repo under MDP/, so a session does not spend five git calls
# rediscovering where things stand (branch, dirty files, behind/ahead origin/main, the PR for the branch, and what
# to do with each other local branch).
#
#   bash local-deploy/tools/mdp_status.sh [REPO...] [--no-fetch] [--no-gh] [--files N]
#
#   REPO      folders under MDP/ to report on (default: every folder that is a git repo)
#   --no-fetch  do not `git fetch --prune` first (default fetches: it updates remote-tracking refs only)
#   --no-gh     skip the GitHub lookups (offline, or gh not logged in); branches are then judged by commit counts alone
#   --files N   list at most N dirty files per repo (default 8)
#
# Per repo it prints: the current branch and how far it is from origin/main, local main vs origin/main, the dirty
# files, the PR for the current branch, and one line per other local branch:
#     in main                     nothing on it that main lacks
#     PR #n merged, tip == head   the branch is exactly what was merged (a squash merge makes `git branch -d` refuse
#                                 these; they are safe to delete)
#     PR #n merged, +K beyond     commits were added after the PR head: keep, they were never reviewed
#     PR #n open / closed unmerged / no PR, +K vs main
# It NEVER deletes, merges, pushes or checks anything out. Deletable branches are listed with a command to copy;
# finish_pr.sh does the guarded deletion after a merge.
#
# Needs: git, and gh (logged in) unless --no-gh. MDP_ROOT overrides the workspace root (the tests use it).
set -u

usage() { echo "usage: bash local-deploy/tools/mdp_status.sh [REPO...] [--no-fetch] [--no-gh] [--files N]" >&2; exit 64; }

REPOS=(); FETCH=1; GH=1; MAXF=8
while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) FETCH=0 ;;
    --no-gh) GH=0 ;;
    --files) [ $# -ge 2 ] || usage; MAXF="$2"; shift ;;
    -*) usage ;;
    *) REPOS+=("$1") ;;
  esac
  shift
done
case "$MAXF" in ''|*[!0-9]*) usage ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MDP="${MDP_ROOT:-$(cd "$HERE/../.." && pwd)}"   # this file is MDP/local-deploy/tools/mdp_status.sh
if [ ${#REPOS[@]} -eq 0 ]; then
  for d in "$MDP"/*/; do [ -e "${d}.git" ] && REPOS+=("$(basename "$d")"); done
fi

# prefers the PR whose head commit is `tip`; otherwise the newest PR for that branch name (gh lists newest first)
pr_for() { # $1 = branch, $2 = tip sha, stdin = "name<TAB>number<TAB>state<TAB>oid" lines
  awk -F'\t' -v b="$1" -v t="$2" '$1==b { if ($4==t) { print; exit } if (!first) first=$0 } END { if (first) print first }' | head -n 1
}

for REPO in "${REPOS[@]}"; do
  D="$MDP/$REPO"
  if [ ! -e "$D/.git" ]; then echo "== $REPO: not a git repo"; continue; fi
  g() { git -C "$D" "$@"; }

  note=""
  if [ "$FETCH" = 1 ]; then g fetch --prune -q 2>/dev/null || note=" (fetch failed: remote data may be stale)"; fi

  CUR="$(g branch --show-current)"; [ -n "$CUR" ] || CUR="(detached at $(g rev-parse --short HEAD))"
  BASE=""
  for c in origin/main origin/master; do g rev-parse -q --verify "$c" >/dev/null && { BASE="$c"; break; }; done

  line="== $REPO  $CUR"
  if [ -n "$BASE" ] && [ "$CUR" != "${BASE#origin/}" ]; then
    read -r behind ahead < <(g rev-list --left-right --count "$BASE"...HEAD)
    line="$line  (+$ahead -$behind vs $BASE)"
  fi
  echo "$line$note"

  if [ -n "$BASE" ] && g rev-parse -q --verify refs/heads/"${BASE#origin/}" >/dev/null; then
    read -r mb ma < <(g rev-list --left-right --count "$BASE"...refs/heads/"${BASE#origin/}")
    [ "$mb" = 0 ] && [ "$ma" = 0 ] || echo "   local ${BASE#origin/}: behind $mb, ahead $ma of $BASE"
  fi

  DIRTY="$(g status --porcelain)"
  if [ -z "$DIRTY" ]; then echo "   clean"; else
    n="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
    echo "   dirty: $n"
    printf '%s\n' "$DIRTY" | head -n "$MAXF" | sed 's/^/     /'
    [ "$n" -gt "$MAXF" ] && echo "     ... +$((n - MAXF)) more"
  fi
  stashes="$(g stash list | wc -l | tr -d ' ')"; [ "$stashes" = 0 ] || echo "   stashes: $stashes"

  PRS=""; ghnote=""
  if [ "$GH" = 1 ]; then
    if ! PRS="$(cd "$D" && gh pr list --state all --limit 100 --json headRefName,number,state,headRefOid \
                 --jq '.[] | [.headRefName, (.number|tostring), .state, .headRefOid] | @tsv' 2>/dev/null)"; then
      PRS=""; ghnote="gh unavailable: PR info skipped"
    fi
  fi
  [ -z "$ghnote" ] || echo "   ($ghnote)"

  if [ "$GH" = 1 ] && [ -z "$ghnote" ] && [ -n "${CUR##\(*}" ] && [ "$CUR" != "${BASE#origin/}" ]; then
    tip="$(g rev-parse HEAD)"; pr="$(printf '%s\n' "$PRS" | pr_for "$CUR" "$tip")"
    pushed="not pushed"; g rev-parse -q --verify "origin/$CUR" >/dev/null && pushed="pushed"
    if [ -n "$pr" ]; then
      IFS=$'\t' read -r _ num state oid <<<"$pr"
      extra=""; [ "$oid" = "$tip" ] || extra=" (local tip differs from the PR head)"
      echo "   PR #$num $state, $pushed$extra"
    else
      echo "   no PR, $pushed"
    fi
  fi

  deletable=()
  while read -r b; do
    [ -n "$b" ] || continue
    [ "$b" = "$CUR" ] && continue
    [ -n "$BASE" ] && [ "$b" = "${BASE#origin/}" ] && continue
    tip="$(g rev-parse "refs/heads/$b")"
    ahead="?"; [ -n "$BASE" ] && ahead="$(g rev-list --count "$BASE..$tip")"
    if [ "$ahead" = 0 ]; then
      echo "   branch $b: in ${BASE#origin/}"; deletable+=("$b"); continue
    fi
    pr=""; [ -n "$PRS" ] && pr="$(printf '%s\n' "$PRS" | pr_for "$b" "$tip")"
    if [ -z "$pr" ]; then
      if [ "$GH" = 0 ] || [ -n "$ghnote" ]; then why="PR state unknown"; else why="no PR"; fi
      echo "   branch $b: $why, +$ahead vs ${BASE#origin/}"
      continue
    fi
    IFS=$'\t' read -r _ num state oid <<<"$pr"
    case "$state" in
      MERGED)
        if [ "$oid" = "$tip" ]; then
          echo "   branch $b: PR #$num merged, tip == head"; deletable+=("$b")
        else
          k="?"; g cat-file -e "$oid^{commit}" 2>/dev/null && k="$(g rev-list --count "$oid..$tip")"
          echo "   branch $b: PR #$num merged, +$k beyond the PR head: keep"
        fi ;;
      OPEN)   echo "   branch $b: PR #$num open, +$ahead vs ${BASE#origin/}" ;;
      CLOSED) echo "   branch $b: PR #$num closed unmerged, +$ahead vs ${BASE#origin/}" ;;
      *)      echo "   branch $b: PR #$num $state, +$ahead vs ${BASE#origin/}" ;;
    esac
  done < <(g for-each-ref --format='%(refname:short)' refs/heads)
  [ ${#deletable[@]} -eq 0 ] || echo "   deletable (not run): git -C $REPO branch -D ${deletable[*]}"
done
exit 0
