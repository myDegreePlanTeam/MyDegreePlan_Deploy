// Tests for guard_bash.mjs, the PreToolUse hook that refuses Bash commands known to hang the shell.
// Run: node --test local-deploy/tools/test_guard_bash.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backslashProblems, inspect, liveProfileProblems } from './guard_bash.mjs'

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

test('blocks cat with no file, no heredoc and nothing piped in (it waits on stdin), with or without an output redirect', () => {
  for (const c of ['cat', 'cat > /tmp/dummy', 'cat > /tmp/dummy 2>/dev/null', 'cat >> out.txt', 'cat -n', 'cd /w && cat > f.txt', 'ls; cat', 'FOO=1 cat > f']) blocked(c, /cat with no file/)
  blocked('cat > /tmp/dummy 2>/dev/null; python3 tools/x.py', /cat with no file/) // the call that hung on 2026-10-08
})

test('allows cat when something feeds it or it names a file', () => {
  for (const c of ['cat file.txt', 'cat a b > c', 'cat < in.txt', 'echo hi | cat', 'echo hi | cat > out.txt', 'cat -n file.txt', 'cat /dev/null > f', 'x=$(cat f)']) allowed(c)
  allowed(lines("cat > f.txt <<'EOF'", 'body', 'EOF'))
  allowed(lines('cat <<EOF', 'body', 'EOF'))
  allowed(lines("cat > f <<'EOF'", 'cat', 'EOF')) // the word cat inside a heredoc body is text
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

// A doubled backslash in a python or node script is blocked. Built from a character code on purpose: typed in a Bash command a
// doubled backslash can arrive as one, which is the thing under test.
const BS = String.fromCharCode(92)
const DOUBLE = BS + BS
const noted = (cmd, re) => blocked(cmd, re)
const quiet = cmd => allowed(cmd)

test('blocks the exact incident: a python heredoc whose string holds a doubled backslash before n', () => {
  noted(lines("python - <<'EOF'", `s = "appendFileSync(process.env.ORDER, 'courses${DOUBLE}n')"`, 'EOF'), /python script.*reaches the shell as ONE/)
})

test('blocks python escapes that change meaning, and not ones that survive as written', () => {
  for (const ch of ['n', 'r', 't', 'b', 'f', 'v', '0', 'x', 'u', "'", '"']) noted(lines("python3 - <<'EOF'", `x = 'a${DOUBLE}${ch}b'`, 'EOF'))
  for (const ch of ['d', 's', 'w', '.', '(', '[', '|']) quiet(lines("python3 - <<'EOF'", `x = r'a${DOUBLE}${ch}b'`, 'EOF')) // python keeps these backslashes anyway
})

test('blocks node, where a lost backslash drops the escape: any letter, digit or quote', () => {
  for (const ch of ['d', 'w', 'n', '1', "'"]) noted(lines("node - <<'EOF'", `const re = '${DOUBLE}${ch}+'`, 'EOF'), /node script/)
  quiet(lines("node - <<'EOF'", `const re = '${DOUBLE}.'`, 'EOF'))
})

test('blocks an inline python -c or node -e program', () => {
  noted(`python3 -c "print('a${DOUBLE}nb')"`, /python script/)
  noted(`cd /w && node -e "console.log('${DOUBLE}d')"`, /node script/)
  noted(`python -u -c "print('${DOUBLE}t')"`, /python script/)
})

test('a single backslash, or none, is allowed', () => {
  quiet(lines("python3 - <<'EOF'", `x = 'a${BS}nb'`, `y = r'${BS}d+'`, 'EOF'))
  quiet(lines("node - <<'EOF'", `const re = /${BS}d+/`, 'EOF'))
  quiet('git status --short')
})

test('only python and node source is read: a doubled backslash in a plain heredoc or an echo is left alone', () => {
  quiet(lines("cat > f.md <<'EOF'", `path C:${DOUBLE}Users${DOUBLE}x`, 'EOF'))
  quiet(`echo "a${DOUBLE}nb"`)
  quiet(lines("python3 - <<'EOF'", 'print(1)', 'EOF', `echo "a${DOUBLE}nb"`)) // after the heredoc closed
})

test('the check reads the body of the interpreter heredoc, not of an earlier plain one', () => {
  quiet(lines("cat > a.txt <<'EOF'", `x ${DOUBLE}n`, 'EOF', "python3 - <<'EOF'", 'print(1)', 'EOF'))
  noted(lines("cat > a.txt <<'EOF'", 'x', 'EOF', "python3 - <<'EOF'", `print('${DOUBLE}n')`, 'EOF'))
})

test('the allow marker silences the backslash block too, and it reports at most three', () => {
  quiet(lines('# guard_bash: allow', "python3 - <<'EOF'", `x = '${DOUBLE}n'`, 'EOF'))
  const many = lines(...Array.from({ length: 6 }, (_, i) => `python3 - <<'E${i}'\nx = '${DOUBLE}n'\nE${i}`))
  assert.equal(backslashProblems(many).length, 3)
})

test('hook protocol: a doubled backslash blocks with exit 2 and the fix on stderr', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines("python3 - <<'EOF'", `print('a${DOUBLE}nb')`, 'EOF') } })
  assert.equal(r.code, 2)
  assert.match(r.err, /guard_bash: blocked before running/)
  assert.match(r.err, /reaches the shell as ONE/)
  assert.match(r.err, /Write tool/)
  assert.ok(r.err.includes('chr(92)'))
  assert.equal(r.out, '')
})

test('hook protocol: a node script is pointed at String.fromCharCode(92)', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines("node - <<'EOF'", `const re = '${DOUBLE}d+'`, 'EOF') } })
  assert.equal(r.code, 2)
  assert.ok(r.err.includes('String.fromCharCode(92)'))
})

test('hook protocol: a hang and a doubled backslash are both reported', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines("python3 - <<'EOF'", `x = '${DOUBLE}n'`, 'EOF', "python3 - <<'EOF'", 'EOF') } })
  assert.equal(r.code, 2)
  assert.match(r.err, /empty body/)
  assert.match(r.err, /doubled backslash/)
})

test('hook protocol: the allow marker lets a deliberate doubled backslash through', () => {
  const r = hook({ tool_name: 'Bash', tool_input: { command: lines('# guard_bash: allow', "python3 - <<'EOF'", `x = '${DOUBLE}n'`, 'EOF') } })
  assert.deepEqual([r.code, r.out, r.err], [0, '', ''])
})

// ---- 5. relative paths that belong to another directory ----------------------------------------------------------------------
// A fake workspace: ROOT/{Frontend,Prototype}/.git, Frontend/src/lib/x.js, Prototype/degree-specs/build.mjs, ROOT/tools/run.sh
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { cwdProblems } from './guard_bash.mjs'

const WS = mkdtempSync(join(tmpdir(), 'guard-ws-'))
const FE = join(WS, 'Frontend')
const PR = join(WS, 'Prototype')
for (const d of [join(FE, '.git'), join(FE, 'src', 'lib'), join(PR, '.git'), join(PR, 'degree-specs'), join(WS, 'tools'), join(WS, 'plain')]) mkdirSync(d, { recursive: true })
writeFileSync(join(FE, 'src', 'lib', 'x.js'), '')
writeFileSync(join(PR, 'degree-specs', 'build.mjs'), '')
writeFileSync(join(WS, 'tools', 'run.sh'), '')
const inCwd = (cmd, cwd) => inspect(cmd, { cwd, root: WS })
const cwdBlocked = (cmd, cwd, re) => {
  const p = inCwd(cmd, cwd)
  assert.ok(p.length > 0, `expected a block for ${cmd} in ${cwd}`)
  if (re) assert.match(p.join('\n'), re)
}
const cwdOk = (cmd, cwd) => assert.deepEqual(inCwd(cmd, cwd), [], `expected no block for ${cmd} in ${cwd}`)

test('cwd: a path that exists under a repo folder but not here is blocked, and the message names where it is', () => {
  cwdBlocked('node degree-specs/build.mjs', WS, /degree-specs\/build\.mjs.*exists under .*Prototype/)
  cwdBlocked('sed -n 1,5p src/lib/x.js', WS, /src\/lib\/x\.js.*Frontend/)
  cwdBlocked('bash tools/run.sh', FE, /tools\/run\.sh.*exists under .*Frontend|exists under .*ws-/)
})

test('cwd: the same commands are fine in the directory they were written for', () => {
  cwdOk('node degree-specs/build.mjs', PR)
  cwdOk('sed -n 1,5p src/lib/x.js', FE)
  cwdOk('bash tools/run.sh', WS)
  cwdOk('node ./degree-specs/build.mjs', PR)
})

test('cwd: a command that chooses its own directory is left alone', () => {
  cwdOk('cd Prototype && node degree-specs/build.mjs', WS)
  cwdOk('git -C Prototype log -- degree-specs/build.mjs', WS)
  cwdOk('npm --prefix Frontend run lint src/lib/x.js', WS)
})

test('cwd: a path that exists nowhere is not flagged (the command may create it), nor are flags, urls, absolute paths or branch names', () => {
  cwdOk('mkdir -p src/new/dir && touch src/new/dir/a.js', WS)
  cwdOk('git checkout -b feat/retro-repeats', FE)
  cwdOk('git diff origin/main..HEAD', FE)
  cwdOk('curl https://example.com/src/lib/x.js', WS)
  cwdOk('cat /c/other/src/lib/x.js ~/src/lib/x.js $HOME/src/lib/x.js', WS)
  cwdOk('node build.mjs --out=src/lib/x.js', WS)
  cwdOk('sed -i s/a/b/ notes.txt', WS)
})

test('cwd: a bare word is never a path (src, docs and catalog are as often prose as folders), and a redirect target is a file about to be written', () => {
  cwdOk('grep -rn foo src', WS)
  cwdOk('npm run src', WS)
  cwdOk('git log --oneline', WS)
  cwdOk('echo hi > src/lib/x.js', WS)
  cwdOk('echo hi >> degree-specs/build.mjs', WS)
  cwdOk('git commit -m "fix src/lib/x.js and degree-specs/build.mjs"', WS)
  cwdOk("node -e 'console.log(1) // src/lib/x.js'", WS)
})

test('cwd: heredoc bodies and quoted text are not scanned as commands, but quoted paths still count as arguments', () => {
  cwdOk(lines("cat > note.md <<'EOF'", 'see src/lib/x.js and degree-specs/build.mjs', 'EOF'), WS)
  cwdBlocked('node "degree-specs/build.mjs"', WS, /degree-specs\/build\.mjs/)
})

test('cwd: globs are cut at the wildcard, and at most three paths are reported', () => {
  cwdBlocked('ls src/lib/*.js', WS, /src\/lib/)
  const many = cwdProblems('a src/lib/x.js degree-specs/build.mjs tools/run.sh src', PR, WS)
  assert.ok(many.length <= 3)
})

test('cwd: no cwd in the hook input means no check, and the allow marker opts out', () => {
  assert.deepEqual(inspect('node degree-specs/build.mjs'), [])
  assert.deepEqual(inCwd(lines('# guard_bash: allow', 'node degree-specs/build.mjs'), WS), [])
})

test('hook protocol: a path written for another directory blocks with exit 2 and the fix on stderr', () => {
  const run = cwd => {
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command: 'node degree-specs/build.mjs' } }), encoding: 'utf8', env: { ...process.env, GUARD_BASH_ROOT: WS } })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const bad = run(WS)
  assert.equal(bad.code, 2)
  assert.match(bad.err, /working directory/)
  assert.match(bad.err, /cd <that folder>/)
  assert.deepEqual([run(PR).code, run(PR).err], [0, ''])
  const noCwd = hook({ tool_name: 'Bash', tool_input: { command: 'node degree-specs/build.mjs' } })
  assert.equal(noCwd.code, 0)
})

test('cwd: cleanup of the fake workspace', () => { rmSync(WS, { recursive: true, force: true }) })

// ---- 6. the live Windows-app profile ------------------------------------------------------------------------------------------
const live = `${BS}MyDegreePlan`
test('live profile: a delete that names the AppData MyDegreePlan folder is blocked, in every spelling the incident could take', () => {
  for (const c of [
    `Remove-Item -Recurse -Force "$env:APPDATA${live}"`,
    `Remove-Item -Recurse -Force $env:appdata${live}${BS}IndexedDB`,
    `rm -rf "$APPDATA/MyDegreePlan/Local Storage"`,
    `rm -rf "\${APPDATA}/MyDegreePlan"`,
    `rm -rf /c/Users/brady/AppData/Roaming/MyDegreePlan/CURRENT`,
    `del /s /q %APPDATA%${live}`,
    `cmd /c rd /s /q %appdata%${live}`,
    `find "$APPDATA/MyDegreePlan" -name LOCK -delete`,
    `node -e "require('fs').rmSync(process.env.APPDATA + '/MyDegreePlan', {recursive:true})" # AppData/Roaming/MyDegreePlan`,
    `Get-ChildItem C:${BS}Users${BS}brady${BS}AppData${BS}Roaming${live} | Remove-Item`,
  ]) {
    assert.ok(liveProfileProblems(c).length > 0, `expected a block for: ${c}`)
    assert.match(inspect(c).join('\n'), /live Windows-app profile/)
  }
})

test('live profile: reading it, deleting something else, or a throwaway profile is fine', () => {
  for (const c of [
    `ls "$APPDATA/MyDegreePlan"`,
    `Get-ChildItem $env:APPDATA${live}`,
    `rm -rf "$TEMP/mdp-smoke-1234"`,
    `Remove-Item -Recurse -Force "$env:TEMP${BS}mdp-userdata-99"`,
    `electron . --user-data-dir="$TEMP/mdp-ud" && rm -rf "$TEMP/mdp-ud"`,
    `rm -rf "$APPDATA/MyDegreePlan-test-123"`,
    `rm -rf "$APPDATA/MyDegreePlanDev"`,
    `npm run build`,
  ]) assert.deepEqual(liveProfileProblems(c), [], `expected no block for: ${c}`)
})

test('live profile: only its own marker lifts the block; the generic allow marker does not', () => {
  const del = 'rm -rf "$APPDATA/MyDegreePlan"'
  assert.ok(inspect(`${del} # guard_bash: allow`).length > 0)
  assert.deepEqual(inspect(`${del} # guard: delete-live-profile`), [])
  assert.deepEqual(liveProfileProblems(`Remove-Item -Recurse "$env:APPDATA${live}" # guard: delete-live-profile`), [])
})

test('hook protocol: the PowerShell tool is checked for the live profile only; Bash-only rules do not apply to it', () => {
  const del = `Remove-Item -Recurse -Force "$env:APPDATA${live}"`
  const bad = hook({ tool_name: 'PowerShell', tool_input: { command: del } })
  assert.equal(bad.code, 2)
  assert.match(bad.err, /live Windows-app profile/)
  assert.equal(hook({ tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem src/lib/x.js; node' } }).code, 0)
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf "$APPDATA/MyDegreePlan"' } }).code, 2)
  assert.equal(hook({ tool_name: 'Read', tool_input: { command: del } }).code, 0)
})
