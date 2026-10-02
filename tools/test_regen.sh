#!/usr/bin/env bash
# Tests for regen.sh: a throwaway workspace whose generators are stubs that write a file from a source file, so the
# chain order, change detection, --check restore and failure handling can be driven. Run: bash local-deploy/tools/test_regen.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/regen.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

# Each stub copies its source to its output and appends a line to $T/order, so the chain order is observable.
#   courses.json       <- raw.txt
#   degree_plans.json  <- specs.txt + courses.json
#   catalog.json, catalog.descriptions.json, pools.json  <- degree_plans.json
build_template() {
  T="$ROOT/template"; P="$T/MyDegreePlan_Prototype"; F="$T/MyDegreePlan_Frontend"
  mkdir -p "$P/catalog" "$P/degree-specs" "$F/src/data" "$F/scripts"
  echo raw1 > "$P/raw.txt"; echo specs1 > "$P/specs.txt"
  cat > "$P/catalog/build_courses.mjs" <<'JS'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
appendFileSync(process.env.ORDER, 'courses\n')
if (process.env.FAIL_STEP === 'courses') { console.error('courses blew up'); process.exit(3) }
writeFileSync('courses.json', 'courses from ' + readFileSync('raw.txt', 'utf8'))
JS
  cat > "$P/degree-specs/build.mjs" <<'JS'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
appendFileSync(process.env.ORDER, 'plans\n')
if (process.env.FAIL_STEP === 'plans') { console.error('specs do not validate'); process.exit(1) }
writeFileSync('degree_plans.json', 'plans ' + readFileSync('specs.txt', 'utf8').trim() + ' / ' + readFileSync('courses.json', 'utf8'))
JS
  cat > "$F/scripts/build-catalog.mjs" <<'JS'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
appendFileSync(process.env.ORDER, 'catalog\n')
const plans = readFileSync('../MyDegreePlan_Prototype/degree_plans.json', 'utf8')
writeFileSync('src/data/catalog.json', 'catalog ' + plans)
writeFileSync('src/data/catalog.descriptions.json', 'descriptions\n')
writeFileSync('src/data/pools.json', 'pools\n')
JS
  echo '{"name":"f","private":true,"scripts":{"build:catalog":"node scripts/build-catalog.mjs"}}' > "$F/package.json"
  export ORDER="$ROOT/order"; : > "$ORDER"; unset FAIL_STEP
  regen   # brings every generated file up to date; each case starts from this clean, committed state
  for r in "$P" "$F"; do (cd "$r" && git init -q -b main 2>/dev/null && git add -A 2>/dev/null && git commit -qm base); done
}
# a fresh copy of the template per case (building it costs seconds on Windows, copying it does not)
world() {
  T="$ROOT/w$RANDOM$RANDOM"; cp -r "$ROOT/template" "$T"; P="$T/MyDegreePlan_Prototype"; F="$T/MyDegreePlan_Frontend"
  export ORDER="$T/order"; : > "$ORDER"; unset FAIL_STEP
}
regen() { OUT="$(MDP_ROOT="$T" bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }
sum() { cat "$P/courses.json" "$P/degree_plans.json" "$F/src/data/"*.json | cksum; }

build_template

echo "a clean tree: nothing changes"
world; BEFORE="$(sum)"; regen
check "exits 0" '[ $CODE = 0 ]'
check "runs courses, plans, catalog in that order" '[ "$(tr "\n" " " < "$ORDER")" = "courses plans catalog " ]'
check "reports all five files unchanged" '[ "$(echo "$OUT" | grep -c "  unchanged ")" = 5 ] && ! echo "$OUT" | grep -q CHANGED'
check "says nothing changed" 'echo "$OUT" | grep -q "regen: nothing changed"'
check "wrote the same bytes" '[ "$BEFORE" = "$(sum)" ]'

echo "a source edit flows through the whole chain"
world; echo raw2 > "$P/raw.txt"; regen
check "exits 0" '[ $CODE = 0 ]'
check "lists the three files the edit reaches as changed, the other two as unchanged" '[ "$(echo "$OUT" | grep -c "  CHANGED ")" = 3 ] && echo "$OUT" | grep -q "CHANGED    MyDegreePlan_Prototype/courses.json" && echo "$OUT" | grep -q "unchanged  MyDegreePlan_Frontend/src/data/pools.json" && echo "$OUT" | grep -q "unchanged  MyDegreePlan_Frontend/src/data/catalog.descriptions.json"'
check "the Frontend catalog picked up the new courses" 'grep -q raw2 "$F/src/data/catalog.json"'
check "names both repos, Prototype first" '[ "$(echo "$OUT" | grep -nE "^MyDegreePlan_(Prototype|Frontend) " | head -1 | grep -c Prototype)" = 1 ] && echo "$OUT" | grep -q "^MyDegreePlan_Frontend "'
check "gives an add command with the changed files" 'echo "$OUT" | grep -q "git -C MyDegreePlan_Prototype add courses.json degree_plans.json"'
check "warns that main needs a branch" 'echo "$OUT" | grep -q "on main: make a branch first"'
check "tells the commit order" 'echo "$OUT" | grep -q "Commit MyDegreePlan_Prototype first"'
check "committed nothing" '[ "$(git -C "$P" rev-list --count HEAD)" = 1 ] && [ "$(git -C "$F" rev-list --count HEAD)" = 1 ]'

echo "a line-ending difference alone is not a change"
world; sed -i 's/$/\r/' "$F/src/data/pools.json"; regen
check "pools.json counts as unchanged" 'echo "$OUT" | grep -q "unchanged  MyDegreePlan_Frontend/src/data/pools.json" && echo "$OUT" | grep -q "nothing changed"'

echo "--check on a current tree"
world; BEFORE="$(sum)"; regen --check
check "exits 0 and says current" '[ $CODE = 0 ] && echo "$OUT" | grep -q "check: ok"'
check "files untouched" '[ "$BEFORE" = "$(sum)" ]'

echo "--check on a stale tree"
world; echo raw2 > "$P/raw.txt"; BEFORE="$(sum)"; regen --check
check "exits 1 and says STALE" '[ $CODE = 1 ] && echo "$OUT" | grep -q "check: STALE"'
check "restored every generated file to what it was" '[ "$BEFORE" = "$(sum)" ] && grep -q raw1 "$P/courses.json" && ! grep -rq raw2 "$F/src/data"'
check "prints no commit instructions" '! echo "$OUT" | grep -q "git -C"'

echo "--check restores a file that was missing"
world; rm "$F/src/data/pools.json"; regen --check
check "stale, because the file differs from what the chain writes" '[ $CODE = 1 ]'
check "the missing file is missing again, not left behind" '[ ! -e "$F/src/data/pools.json" ]'

echo "a failing step stops the chain"
world; export FAIL_STEP=plans; echo raw2 > "$P/raw.txt"; regen
check "exits 1" '[ $CODE = 1 ]'
check "names the failing step and shows its output" 'echo "$OUT" | grep -q "FAILED degree_plans.json" && echo "$OUT" | grep -q "specs do not validate"'
check "the catalog step never ran" '! grep -q catalog "$ORDER" && [ "$(tr "\n" " " < "$ORDER")" = "courses plans " ]'
check "still reports what the earlier step changed" 'echo "$OUT" | grep -q "CHANGED    MyDegreePlan_Prototype/courses.json" && echo "$OUT" | grep -q "regen: stopped"'
world; export FAIL_STEP=courses; regen --check
check "--check with a failing step exits 1 and restores" '[ $CODE = 1 ] && echo "$OUT" | grep -q "generated files restored"'
unset FAIL_STEP

echo "usage and setup errors"
world; regen --bogus
check "unknown flag: exit 64" '[ $CODE = 64 ]'
OUT="$(MDP_ROOT="$ROOT/empty" bash "$SCRIPT" 2>&1)"; CODE=$?
check "missing repos: exit 2 with a message" '[ $CODE = 2 ] && echo "$OUT" | grep -q "not found"'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
