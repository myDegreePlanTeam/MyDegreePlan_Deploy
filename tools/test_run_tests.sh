#!/usr/bin/env bash
# Tests for run_tests.sh: a fake tools folder of tiny suites. Run: bash local-deploy/tools/test_run_tests.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/run_tests.sh"
PASS=0; FAIL=0
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/         /'; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "$OUT"; fi; }

# $1 = folder; adds a passing and a failing bash suite, a node suite, a python suite and two 2-second suites
fake_tools() {
  mkdir -p "$1"
  printf '#!/usr/bin/env bash\necho "noisy line from a passing suite"\necho "3 passed, 0 failed"\n' > "$1/test_a_pass.sh"
  printf '#!/usr/bin/env bash\necho "starting"\necho "  FAIL the broken check"\necho "2 passed, 1 failed"\nexit 1\n' > "$1/test_b_fail.sh"
  printf "import { test } from 'node:test'\ntest('works', () => {})\ntest('works too', () => {})\n" > "$1/test_c_node.mjs"
  printf 'import unittest\nclass T(unittest.TestCase):\n    def test_one(self):\n        self.assertTrue(True)\nif __name__ == "__main__":\n    unittest.main()\n' > "$1/test_d_py.py"
  printf '#!/usr/bin/env bash\nsleep 2\necho "1 passed, 0 failed"\n' > "$1/test_e_sleep.sh"
  printf '#!/usr/bin/env bash\nsleep 2\necho "1 passed, 0 failed"\n' > "$1/test_f_sleep.sh"
}
run() { OUT="$(TOOLS_DIR="$D" bash "$SCRIPT" "$@" 2>&1)"; CODE=$?; }

D="$ROOT/all"; fake_tools "$D"

echo "discovery"
run --list
check "finds the .sh, .mjs and .py suites and nothing else" '[ "$(echo "$OUT" | wc -l | tr -d " ")" = 6 ] && echo "$OUT" | grep -qx "test_c_node.mjs" && echo "$OUT" | grep -qx "test_d_py.py"'
touch "$D/helper.sh" "$D/notatest.mjs"; run --list
check "ignores files that are not test_*" '[ "$(echo "$OUT" | wc -l | tr -d " ")" = 6 ]'

echo "results"
run
check "exit 1 when any suite fails" '[ $CODE = 1 ]'
check "a green suite is one line with its own count" 'echo "$OUT" | grep -Eq "^  ok +test_a_pass.sh +3 passed"'
check "node and python suites are summarised" 'echo "$OUT" | grep -Eq "^  ok +test_c_node.mjs +2 pass" && echo "$OUT" | grep -Eq "^  ok +test_d_py.py +1 tests?"'
check "a red suite is FAIL with the tail of its output" 'echo "$OUT" | grep -Eq "^  FAIL +test_b_fail.sh +exit 1" && echo "$OUT" | grep -q "the broken check"'
check "output of passing suites is not echoed" '! echo "$OUT" | grep -q "noisy line from a passing suite"'
check "final line counts the passes" 'echo "$OUT" | grep -q "run_tests: 5 of 6 passed"'

echo "all green"
G="$ROOT/green"; fake_tools "$G"; rm "$G/test_b_fail.sh"; D="$G"; run
check "exit 0 and 5 of 5" '[ $CODE = 0 ] && echo "$OUT" | grep -q "run_tests: 5 of 5 passed"'

echo "parallel by default, sequential with --jobs 1"
t0=$(date +%s); run e_sleep f_sleep; t1=$(date +%s); PAR=$((t1 - t0))
t0=$(date +%s); run e_sleep f_sleep --jobs 1; t1=$(date +%s); SEQ=$((t1 - t0))
check "--jobs 1 runs the two 2-second suites one after the other (4 seconds or more)" '[ $SEQ -ge 4 ]'
check "by default they overlap: at least a second faster than one at a time" '[ $((SEQ - PAR)) -ge 1 ]'
check "it says how many at a time" 'echo "$OUT" | grep -q "2 suite(s), 1 at a time"'

echo "filters and usage"
D="$ROOT/all"; run pass
check "a NAME selects only matching suites" '[ $CODE = 0 ] && echo "$OUT" | grep -q "1 suite(s)" && ! echo "$OUT" | grep -q test_b_fail'
run nothing_matches_this
check "no match is 64" '[ $CODE = 64 ]'
run --jobs 0
check "--jobs 0 is 64" '[ $CODE = 64 ]'
run --jobs abc
check "--jobs abc is 64" '[ $CODE = 64 ]'
run --bogus
check "unknown option is 64" '[ $CODE = 64 ]'
mkdir -p "$ROOT/empty"; D="$ROOT/empty"; run
check "a folder with no suites is 64" '[ $CODE = 64 ]'

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
