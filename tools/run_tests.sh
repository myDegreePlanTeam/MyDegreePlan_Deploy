#!/usr/bin/env bash
# run_tests.sh: run every test suite in local-deploy/tools in parallel and print one line per suite.
#
#   bash local-deploy/tools/run_tests.sh [NAME...] [--jobs N] [--list]
#
#   NAME     run only the suites whose file name contains NAME (e.g. finish_pr)
#   --jobs   how many suites at once (default: all of them, at most 8; 1 runs them one after another)
#   --list   print the suites it found and stop
#
# Suites are discovered, not listed here: every tools/test_*.sh (bash), test_*.mjs (node --test) and test_*.py (python
# unittest) is one. Adding a test file adds it to this run and to CI, which calls this script. A slow suite
# (test_finish_pr.sh takes about two minutes on Windows) used to push a hand-written chain past the tool timeout.
#
# A green suite is one line: `ok    test_open_pr.sh   30 passed  (12s)`. A red one is `FAIL` plus the last 15 lines of its
# own output. Exit 0 if every suite passed, 1 if any failed, 64 usage. Read-only: it runs tests, and they work in temp dirs.
#
# TOOLS_DIR overrides the folder to scan (the tests of this script use it).
set -u

usage() { echo "usage: bash local-deploy/tools/run_tests.sh [NAME...] [--jobs N] [--list]" >&2; exit 64; }

NAMES=(); JOBS=""; LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --jobs) [ $# -ge 2 ] || usage; JOBS="$2"; shift ;;
    --list) LIST=1 ;;
    -*) usage ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done
case "$JOBS" in ''|[1-9]|[1-9][0-9]) ;; *) usage ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${TOOLS_DIR:-$HERE}"

SUITES=()
for f in "$TOOLS"/test_*.sh "$TOOLS"/test_*.mjs "$TOOLS"/test_*.py; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ ${#NAMES[@]} -gt 0 ]; then
    hit=0; for n in "${NAMES[@]}"; do case "$name" in *"$n"*) hit=1 ;; esac; done
    [ "$hit" = 1 ] || continue
  fi
  SUITES+=("$name")
done
[ ${#SUITES[@]} -gt 0 ] || { echo "run_tests: no test suites found in $TOOLS${NAMES[*]:+ matching ${NAMES[*]}}" >&2; exit 64; }
if [ "$LIST" = 1 ]; then printf '%s\n' "${SUITES[@]}"; exit 0; fi
[ -n "$JOBS" ] || { JOBS=${#SUITES[@]}; [ "$JOBS" -le 8 ] || JOBS=8; }

PY=""
for c in python3 python; do "$c" -c 'import sys' >/dev/null 2>&1 && { PY="$c"; break; }; done

OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT

run_suite() { # $1 = file name; writes $OUT/<name>.out, .code and .secs
  local name="$1" start end code=0
  start=$(date +%s)
  case "$name" in
    *.sh)  (cd "$TOOLS" && bash "$name") >"$OUT/$name.out" 2>&1 || code=$? ;;
    *.mjs) (cd "$TOOLS" && node --test "$name") >"$OUT/$name.out" 2>&1 || code=$? ;;
    *.py)  if [ -n "$PY" ]; then (cd "$TOOLS" && "$PY" -m unittest "${name%.py}") >"$OUT/$name.out" 2>&1 || code=$?
           else echo "no working python on PATH" >"$OUT/$name.out"; code=127; fi ;;
  esac
  end=$(date +%s)
  echo "$code" >"$OUT/$name.code"; echo $((end - start)) >"$OUT/$name.secs"
}

# what a suite says about itself, in a few words (empty if it says nothing recognisable)
summary() { # $1 = file name
  local f="$OUT/$1.out" s
  case "$1" in
    *.sh)  s="$(grep -Eo '[0-9]+ passed, [0-9]+ failed' "$f" | tail -n 1)"
           [ -z "$s" ] || s="${s%, 0 failed}" ;;
    *.mjs) s="$(grep -Eo 'pass [0-9]+' "$f" | tail -n 1 | sed 's/pass \([0-9]*\)/\1 pass/')" ;;
    *.py)  s="$(grep -Eo '^Ran [0-9]+ tests?' "$f" | tail -n 1 | sed 's/^Ran \([0-9]*\) tests\?/\1 tests/')" ;;
  esac
  printf '%s' "$s"
}

echo "run_tests: ${#SUITES[@]} suite(s), $JOBS at a time"
T0=$(date +%s)
running=0
for s in "${SUITES[@]}"; do
  run_suite "$s" &
  running=$((running + 1))
  if [ "$running" -ge "$JOBS" ]; then wait -n 2>/dev/null || wait; running=$((running - 1)); fi
done
wait

FAILED=0
for s in "${SUITES[@]}"; do
  code="$(cat "$OUT/$s.code" 2>/dev/null || echo 1)"; secs="$(cat "$OUT/$s.secs" 2>/dev/null || echo '?')"
  if [ "$code" = 0 ]; then
    printf '  ok    %-26s %-14s (%ss)\n' "$s" "$(summary "$s")" "$secs"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL  %-26s exit %s (%ss)\n' "$s" "$code" "$secs"
    tail -n 15 "$OUT/$s.out" | sed 's/^/          /'
  fi
done
echo "run_tests: $((${#SUITES[@]} - FAILED)) of ${#SUITES[@]} passed ($(( $(date +%s) - T0 ))s)"
[ "$FAILED" = 0 ]
