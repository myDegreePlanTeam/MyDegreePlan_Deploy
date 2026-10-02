// Tests for guard_bash.mjs, the PreToolUse hook that refuses Bash commands known to hang the shell.
// Run: node --test local-deploy/tools/test_guard_bash.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advise, inspect } from './guard_bash.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'guard_bash.mjs')
const lines = (...l) => l.join('\n')
const blocked = (cmd, re) => {
  const p = inspect(cmd)
  assert.ok(p.length > 0, `expected a block for:\n${cmd}`)
  if (re) assert.match(p.join('\n'), re)
}
const allowed = cmd => assert.deepEqual(inspect(cmd), [], `expected no block for:\n${cmd}`)

test('blocks an empty heredoc fed to python3 - (the command that hung on 2026-10-02)', () => {
  blocked(lines("python3 - <<'EOF'", 'EOF'), /empty body/)
  blocked(lines("python3 - 2>/dev/null <<'EOF' || true", 'EOF'), /empty body/)
})

test('blocks the exact incident: a real heredoc, then an empty python one, then more commands', () => {
  blocked(lines(
    'cd /w && cat > note.md <<\'EOF\'', 'real body', 'EOF',
    "python3 - 2>/dev/null <<'EOF' || true", 'EOF',
    "sed -i 's/a/b/' note.md; grep -c b note.md",
  ), /empty body/)
})

test('blocks an empty heredoc to any command, quoted or not, including <<-', () => {
  blocked(lines('cat <<EOF', 'EOF'), /empty body/)
  blocked(lines('cat <<"EOF"', 'EOF'), /empty body/)
  blocked(lines('cat <<-EOF', '\tEOF'), /empty body/)
})

test('blocks a heredoc that is never closed', () => {
  blocked(lines("cat > f <<'EOF'", 'some text'), /never closed/)
  blocked(lines("python3 - <<'EOF'", 'print(1)', 'EOF2'), /never closed/) // the wrong terminator
})

test('blocks a bare interpreter, with or without flags, anywhere in a command', () => {
  for (const c of ['python', 'python3', 'py', 'node', 'python3 -u', 'cd /w && python3', 'ls; python', 'FOO=1 python3', 'git status || node']) blocked(c, /no program/)
})

test('blocks python - or node - with nothing piped or redirected into it', () => {
  blocked('python3 -', /reads its program from stdin/)
  blocked('cd /w && python -', /reads its program from stdin/)
  blocked('python3 - 2>/dev/null', /reads its program from stdin/)
})

test('allows interpreters that have a program', () => {
  for (const c of ['python3 -c "print(1)"', 'python3 script.py', 'python -m unittest test_x', 'node --test x.mjs', 'node scripts/verify.mjs --skip-build', 'python local-deploy/tools/multi_replace.py --dry-run', 'node -e "console.log(1)"', 'py -3 script.py']) allowed(c)
})

test('allows the flags that print and exit, but still blocks the ones that leave a prompt open', () => {
  for (const c of ['node -v', 'node --version', 'python3 -V', 'python --version', 'python3 -h', 'node -h', 'cd /w && node -v && npm -v']) allowed(c)
  for (const c of ['python3 -u', 'python -i', 'node -i', 'py -3']) blocked(c, /no program/)
})

test('replays the shape of the real hangs: python3 with an empty heredoc, then node - with a second tag', () => {
  // 2026-09-29: the first time; 2026-10-02: twice more
  blocked(lines("python3 - <<'EOF' 2>/dev/null || node - <<'EOF2'", 'EOF', 'const fs = require("fs")', 'EOF2'), /empty body/)
  blocked(lines('cd /m && grep -n x f.md | cut -c1-80; cat > n.md <<\'EOF\'', 'body', 'EOF', "python3 - 2>/dev/null <<'EOF' || true", 'EOF', 'sed -i s/a/b/ f.md'), /empty body/)
})

test('the allow marker opts a deliberate command out of every check', () => {
  allowed(lines('# guard_bash: allow', "timeout 8 python3 - <<'EOF'", 'EOF'))
  allowed("python3 # guard_bash: allow")
  blocked(lines("python3 - <<'EOF'", 'EOF', '# guard_bash: nope'), /empty body/) // a different comment does nothing
})

test('allows a program fed by a pipe or a redirect', () => {
  allowed('echo "print(1)" | python3 -')
  allowed('cat script.py | python -')
  allowed('python3 - < script.py')
  allowed('node - < script.js')
})

test('allows heredocs that have a body', () => {
  allowed(lines("python3 - <<'EOF'", 'print(1)', 'EOF'))
  allowed(lines("python local-deploy/tools/multi_replace.py - <<'EOF'", '@@@ file a.txt', '@@@ old', 'x', '@@@ new', 'y', 'EOF'))
  allowed(lines("cat > f <<'EOF'", 'line', 'EOF', 'echo done'))
  allowed(lines('cat <<-EOF', '\tindented', '\tEOF'))
})

test('allows two heredocs opened on one line, each with a body', () => {
  allowed(lines('cat <<A <<B', 'first', 'A', 'second', 'B'))
})

test('does not read inside a heredoc body: code-looking text there is just text', () => {
  allowed(lines("cat > run.sh <<'EOF'", 'python3 -', "python3 - <<'INNER'", 'INNER', 'node', 'EOF'))
})

test('does not mistake quoted text, here-strings or arithmetic for a heredoc', () => {
  allowed('echo "write cat <<EOF to the file"')
  allowed("echo 'python3 - <<EOF'")
  allowed('cat <<< "hello"')
  allowed('echo $((1<<2))')
  allowed('grep -n "<<" file.txt')
})

test('allows ordinary commands, including ones that merely mention an interpreter', () => {
  for (const c of ['git status --short', 'npm run test', 'ls -la', 'echo python3', 'grep -rn "python" src', 'which node', 'node --version', 'python --version']) allowed(c)
})

const hook = input => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('hook protocol: exit 2 and the reason on stderr when it blocks', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines("python3 - <<'EOF'", 'EOF') } })
  assert.equal(r.code, 2)
  assert.match(r.err, /guard_bash: blocked before running/)
  assert.match(r.err, /empty body/)
  assert.equal(r.out, '')
})

test('hook protocol: exit 0 and silence for a good command', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: 'git status --short' } })
  assert.deepEqual([r.code, r.out, r.err], [0, '', ''])
})

test('hook protocol: never blocks on input it cannot use', () => {
  for (const input of ['not json at all', '', '{}', { tool_name: 'Read', tool_input: { file_path: 'x' } }, { tool_name: 'Bash', tool_input: {} }, { tool_name: 'Bash', tool_input: { command: '   ' } }, { tool_name: 'Bash', tool_input: { command: 42 } }]) {
    assert.equal(hook(input).code, 0, JSON.stringify(input))
  }
})

test('a Windows (CRLF) command is judged like a Unix one', () => {
  blocked("python3 - <<'EOF'\r\nEOF", /empty body/)
  allowed("python3 - <<'EOF'\r\nprint(1)\r\nEOF")
})

// Advice about a doubled backslash. Built from a character code on purpose: typed in a Bash command a doubled backslash can
// arrive as one, which is the thing under test.
const BS = String.fromCharCode(92)
const DOUBLE = BS + BS
const noted = (cmd, re) => {
  const n = advise(cmd)
  assert.ok(n.length > 0, `expected advice for:\n${cmd}`)
  if (re) assert.match(n.join('\n'), re)
}
const quiet = cmd => assert.deepEqual(advise(cmd), [], `expected no advice for:\n${cmd}`)

test('advises on the exact incident: a python heredoc whose string holds a doubled backslash before n', () => {
  noted(lines("python - <<'EOF'", `s = "appendFileSync(process.env.ORDER, 'courses${DOUBLE}n')"`, 'EOF'), /python script.*reaches the shell as ONE/)
})

test('advises on python escapes that change meaning, and not on ones that survive as written', () => {
  for (const ch of ['n', 'r', 't', 'b', 'f', 'v', '0', 'x', 'u', "'", '"']) noted(lines("python3 - <<'EOF'", `x = 'a${DOUBLE}${ch}b'`, 'EOF'))
  for (const ch of ['d', 's', 'w', '.', '(', '[', '|']) quiet(lines("python3 - <<'EOF'", `x = r'a${DOUBLE}${ch}b'`, 'EOF')) // python keeps these backslashes anyway
})

test('advises on node, where a lost backslash drops the escape: any letter, digit or quote', () => {
  for (const ch of ['d', 'w', 'n', '1', "'"]) noted(lines("node - <<'EOF'", `const re = '${DOUBLE}${ch}+'`, 'EOF'), /node script/)
  quiet(lines("node - <<'EOF'", `const re = '${DOUBLE}.'`, 'EOF'))
})

test('advises on an inline python -c or node -e program', () => {
  noted(`python3 -c "print('a${DOUBLE}nb')"`, /python script/)
  noted(`cd /w && node -e "console.log('${DOUBLE}d')"`, /node script/)
  noted(`python -u -c "print('${DOUBLE}t')"`, /python script/)
})

test('a single backslash, or none, gets no advice', () => {
  quiet(lines("python3 - <<'EOF'", `x = 'a${BS}nb'`, `y = r'${BS}d+'`, 'EOF'))
  quiet(lines("node - <<'EOF'", `const re = /${BS}d+/`, 'EOF'))
  quiet('git status --short')
})

test('only python and node source is read: a doubled backslash in a plain heredoc or an echo is left alone', () => {
  quiet(lines("cat > f.md <<'EOF'", `path C:${DOUBLE}Users${DOUBLE}x`, 'EOF'))
  quiet(`echo "a${DOUBLE}nb"`)
  quiet(lines("python3 - <<'EOF'", 'print(1)', 'EOF', `echo "a${DOUBLE}nb"`)) // after the heredoc closed
})

test('advice reads the body of the interpreter heredoc, not of an earlier plain one', () => {
  quiet(lines("cat > a.txt <<'EOF'", `x ${DOUBLE}n`, 'EOF', "python3 - <<'EOF'", 'print(1)', 'EOF'))
  noted(lines("cat > a.txt <<'EOF'", 'x', 'EOF', "python3 - <<'EOF'", `print('${DOUBLE}n')`, 'EOF'))
})

test('the allow marker silences advice too, and advice is capped at three notes', () => {
  quiet(lines('# guard_bash: allow', "python3 - <<'EOF'", `x = '${DOUBLE}n'`, 'EOF'))
  const many = lines(...Array.from({ length: 6 }, (_, i) => `python3 - <<'E${i}'\nx = '${DOUBLE}n'\nE${i}`))
  assert.equal(advise(many).length, 3)
})

test('hook protocol: advice goes out as additionalContext on stdout with exit 0 (the command still runs)', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines("python3 - <<'EOF'", `print('a${DOUBLE}nb')`, 'EOF') } })
  assert.equal(r.code, 0)
  const o = JSON.parse(r.out)
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(o.hookSpecificOutput.additionalContext, /advice, the command was not blocked/)
  assert.match(o.hookSpecificOutput.additionalContext, /Write tool/)
  assert.equal(r.err, '')
})

test('hook protocol: a block wins over advice (exit 2, nothing on stdout)', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines("python3 - <<'EOF'", `x = '${DOUBLE}n'`, 'EOF', "python3 - <<'EOF'", 'EOF') } })
  assert.equal(r.code, 2)
  assert.equal(r.out, '')
})
