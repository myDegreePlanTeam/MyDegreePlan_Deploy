#!/usr/bin/env node
// guard_bash.mjs: a Claude Code PreToolUse hook for the Bash tool. It refuses, before they run, shell commands that are
// known to hang or flood this workspace's shell, or to be silently rewritten by it. Exit 2 with the reason on stderr blocks the call and the reason goes
// back to the model; exit 0 lets it through. Anything it cannot parse is allowed: a guard must never be the reason a
// working command fails.
//
//   hook input (stdin, JSON):  {"tool_name": "Bash", "tool_input": {"command": "..."}}
//   settings:                  .claude/settings.json -> hooks.PreToolUse, matcher "Bash",
//                              command: node "$CLAUDE_PROJECT_DIR/local-deploy/tools/guard_bash.mjs"
//
// What it blocks
//   1. A heredoc with an EMPTY body (`python3 - <<'EOF'` followed at once by `EOF`). On this machine an empty program on
//      stdin makes Python 3.13 start its interactive prompt, which fails on the missing console and loops: one run printed
//      20 MB and held the shell until the timeout (retro 2026-10-02, twice). An empty heredoc is never intended.
//   2. A heredoc that is never closed (the shell would swallow the rest of the command, or wait for input).
//   3. A bare interpreter with no program: `python`, `python3`, `py`, `node` (alone, or with only flags such as -u that keep
//      the prompt open), or `python -` / `node -` with no pipe or redirect feeding it. Each starts a REPL that waits for a
//      console that is not there. `node -v`, `python3 -V`, `--version` and `-h` print and exit, and are allowed.
// To run something deliberately anyway (a repro of the hang under `timeout`), put `# guard_bash: allow` in the command.
// Heredoc BODIES are never scanned for commands: a script that merely contains the text `python3 -` is fine.
//
//   4. A doubled backslash in a python or node script (a heredoc fed to the interpreter, or a -c / -e program) where the pair
//      is followed by a character that makes an escape. The Bash tool delivers a typed pair as ONE backslash (retro 2026-10-02,
//      three times: `'courses\\n'` in a python string became a real newline and broke two test runs; `\\d` lost its
//      backslash). The hook sees the text as typed, before that happens, so it can refuse in time. See backslashProblems().
//      This used to be advice only; it blocks since 2026-10-05. Put the script in a file with the Write tool and run it, or
//      build the backslash with chr(92) / String.fromCharCode(92).
//
// Limits: it is a line scanner, not a shell parser. Quotes are tracked only well enough to ignore `<<EOF` text inside
// a quoted string. It aims for no false blocks on commands written the usual way, and says why when it blocks.
import { readFileSync } from 'node:fs'

const INTERPRETERS = '(?:python3?|py|node)'
// flags that leave the interpreter waiting for a program (so `python3 -u` is a bare prompt) as opposed to ones that
// print and exit (`node -v`, `python3 -V`, `-h`, `--version`), which are fine
const PROMPT_FLAGS = '(?:\\s+-(?:u|B|O|OO|q|i|I|E|s|S|d|[23](?:\\.\\d+)?))*'
// a comment that opts a deliberate command out of every check (e.g. reproducing a hang under `timeout`)
const ALLOW_MARKER = /#\s*guard_bash:\s*allow\b/

export function inspect(command) {
  if (ALLOW_MARKER.test(String(command ?? ''))) return []
  const lines = String(command ?? '').replace(/\r\n/g, '\n').split('\n')
  const problems = []
  const code = [] // the lines that are shell code, with heredoc bodies removed
  let pending = [] // heredocs opened on earlier lines whose bodies are still to come: {tag, dash, openedOn, body}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (pending.length) {
      const h = pending[0]
      const text = h.dash ? line.replace(/^\t+/, '') : line
      if (text === h.tag) {
        if (h.body === 0) problems.push(`the heredoc <<${h.tag} opened on line ${h.openedOn} has an empty body`)
        pending.shift()
      } else h.body += 1
      continue
    }
    code.push(line)
    for (const m of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      if (line[m.index + 2] === '<' || line[m.index - 1] === '<') continue // a here-string, <<<
      if (inQuote(line.slice(0, m.index))) continue // `echo "cat <<EOF"` is text
      pending.push({ tag: m[3], dash: m[1] === '-', openedOn: i + 1, body: 0 })
    }
  }
  for (const h of pending) problems.push(`the heredoc <<${h.tag} opened on line ${h.openedOn} is never closed (no line that is exactly ${h.tag})`)

  // bare interpreters, looked for in the code lines only, one shell segment at a time
  const parts = code.join('\n').split(/(&&|\|\||;|\n|\|)/) // [segment, separator, segment, ...]
  const bare = new RegExp(`^(?:[A-Za-z_]\\w*=\\S*\\s+)*${INTERPRETERS}${PROMPT_FLAGS}$`)
  const dash = new RegExp(`^(?:[A-Za-z_]\\w*=\\S*\\s+)*${INTERPRETERS}${PROMPT_FLAGS}\\s+-$`)
  for (let k = 0; k < parts.length; k += 2) {
    const prevSep = k > 0 ? parts[k - 1] : ''
    const raw = parts[k].trim().replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '')
    const seg = raw.replace(/\s\d*>&?\S*/g, '').trim() // output redirections do not feed stdin
    if (bare.test(seg)) problems.push(`\`${raw}\` is an interpreter with no program: it starts an interactive prompt and waits for a console`)
    else if (dash.test(seg) && !raw.includes('<') && prevSep !== '|') problems.push(`\`${raw}\` reads its program from stdin but nothing is piped or redirected into it`)
  }
  problems.push(...backslashProblems(command))
  return problems
}

// A doubled backslash typed in a Bash command can reach the shell as ONE (verified 2026-10-02 on this machine: printf '%s' 'a\\b'
// printed a\b; the Write and Edit tools keep both). Inside a python or node script that quietly changes what the script means:
// '\\n' in a python string becomes '\n' and the script writes a real newline (it broke two test runs), '\\d' in a node string
// becomes '\d' and loses its backslash, '\\b' becomes a backspace. Only where the character after the pair makes an escape
// that means something else when the pair is one backslash: python n r t b f v 0-7 x u U N and quotes, node any letter, digit,
// quote or backtick. Blocked since 2026-10-05 (it was advice before: about 8% of the 497 python/node scripts in the transcripts
// had one, and some were fine, so a deliberate one needs `# guard_bash: allow`).
const PY_ESCAPE_PAIR = /\\\\[nrtbfv0-7xuUN'"]/
const NODE_ESCAPE_PAIR = /\\\\[A-Za-z0-9'"`]/
const SCRIPT_OPENER = /(?:^|[\s;&|(])(python3?|py|node)\b[^\n]*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/
const INLINE_SCRIPT = /(?:^|[\s;&|(])(python3?|py|node)\s+(?:-[A-Za-z]+\s+)*-[ce]\b/

// the python/node source in a command: heredoc bodies fed to an interpreter, and everything from a `-c` / `-e` onward
function scriptsIn(command) {
  const lines = String(command ?? '').replace(/\r\n/g, '\n').split('\n')
  const found = []
  let open = null // {lang, tag, dash, body: []}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      const text = open.dash ? line.replace(/^\t+/, '') : line
      if (text === open.tag) { found.push({ lang: open.lang, text: open.body.join('\n') }); open = null } else open.body.push(line)
      continue
    }
    const inline = line.match(INLINE_SCRIPT)
    if (inline) found.push({ lang: inline[1] === 'node' ? 'node' : 'python', text: lines.slice(i).join('\n') })
    const m = line.match(SCRIPT_OPENER)
    if (m && !inQuote(line.slice(0, m.index))) open = { lang: m[1] === 'node' ? 'node' : 'python', tag: m[3], dash: /<<-/.test(line), body: [] }
  }
  if (open) found.push({ lang: open.lang, text: open.body.join('\n') })
  return found
}

export function backslashProblems(command) {
  const found = []
  for (const { lang, text } of scriptsIn(command)) {
    const m = text.match(lang === 'node' ? NODE_ESCAPE_PAIR : PY_ESCAPE_PAIR)
    if (!m) continue
    const at = text.slice(Math.max(0, m.index - 20), m.index + 24).replace(/\n/g, ' ')
    found.push(`a doubled backslash in the ${lang} script (…${at}…) reaches the shell as ONE, so that escape means something else: put the script in a file with the Write tool and run it, or build the backslash with ${lang === 'node' ? 'String.fromCharCode(92)' : 'chr(92)'}`)
  }
  return found.slice(0, 3)
}

// is the text before `quote-so-far` inside an unclosed single or double quote?
function inQuote(prefix) {
  let single = false
  let double = false
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]
    if (c === '\\' && !single) { i += 1; continue }
    if (c === "'" && !double) single = !single
    else if (c === '"' && !single) double = !double
  }
  return single || double
}

function main() {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (payload?.tool_name !== 'Bash') return 0
  const command = payload?.tool_input?.command
  if (typeof command !== 'string' || !command.trim()) return 0
  let problems
  try { problems = inspect(command) } catch { return 0 }
  if (!problems.length) return 0
  console.error(`guard_bash: blocked before running:\n  - ${problems.join('\n  - ')}\nFix the command and run it again. (A deliberate one can carry \`# guard_bash: allow\`.)`)
  return 2
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
