#!/usr/bin/env node
// token_audit.mjs: a measured, read-only audit of where a Claude Code workspace spends tool-output tokens, plus a check
// that fixes logged in the retro log stayed fixed. The retro (.claude/skills/retro) is qualitative: its costs are
// estimates ("~4 turns"). This is the measured side, so a change can be judged by a number instead of a feeling.
//
//   node local-deploy/tools/token_audit.mjs [--since WHEN] [--until WHEN] [--label NAME] [--record] [--check-log]
//        [--repos A,B|none] [--dir TRANSCRIPT_DIR] [--log LOG] [--metrics TSV]
//
//   (default)    print the report; write nothing
//   --since/--until  only count tool calls in the window: WHEN is YYYY-MM-DD or YYYY-MM-DDTHH:MM (UTC, as the transcripts
//                stamp them); --until is exclusive. A baseline is "everything before the change", a later row is "since it".
//   --record     also append one row to the metrics file (default .claude/retro/metrics.tsv), after printing the change
//                against the previous row. This is the only thing that ever writes.
//   --check-log  list FIXED lines in the retro log whose problem was logged again later (see below)
//   --repos      repo folders under MDP/ for the git snapshot (default: every folder with a .git; "none" skips it)
//   --commands   instead of the report: how often each shell command ran (by program and subcommand, `git -C * log`,
//                `gh pr view`), sorted into auto-allowed (never prompts), SUGGEST (read-only, not yet allowed, with the
//                `Bash(... *)` pattern), JUDGE (project and package scripts), WRITES and RUNS CODE (never a wildcard rule),
//                minus what .claude/settings.json and settings.local.json already allow; MCP tools that read by name get a
//                section too. --min N (default 3) hides rarer commands, --top N (default 20) caps each list, --all-projects
//                reads every workspace under ~/.claude/projects, not just this one. It prints; the permissions skill
//                (/fewer-permission-prompts) or a person edits the settings.
//
// What it measures (from the session transcripts under ~/.claude/projects/<workspace>/*.jsonl)
//   * the size of every Bash / PowerShell / Read / Grep result, by category (git, tests, lint, docker, builds, file reads,
//     python/node edit scripts, ...), with call counts, share and the largest result of each
//   * how often CLAUDE.md was read IN FULL although it is already loaded (a ranged lookup is fine and counted apart), and
//     how many results exceed 8,000 characters
//   * tokens are characters / 4, an estimate; characters are exact, except an image, which is priced at a flat 6,000
//     characters (its base64 size says nothing about what it costs)
// And, for orientation (weak proxies for code quality, not a verdict): per repo, commits in the window, the share that
// are `fix`, reverts, and the most-touched file; and the retro log's entry, near-miss and REPEAT counts.
//
// FIXED lines (the "fixed marker"). When a logged friction is fixed, append a line to .claude/retro/log.md:
//     FIXED | 2026-10-02 | match: edit scripts?|multi.?replace | tools/multi_replace.py and json_patch.mjs
//   i.e. FIXED | date | match: <case-insensitive regex> | how. The regex may contain `|` (alternation) but not a space
//   between pipes; `how` must not contain " | " (the last " | " ends the regex). Every entry written AFTER that line
//   (file order is time order) that matches the regex is reported as RECURRED. A match is a prompt to look, not proof:
//   the retro decides. A recurrence that a LATER FIXED line also matches is already dealt with (the fix for the
//   recurrence): it is counted as handled, not reported, so it does not come back in every later retro.
//
// Read-only apart from --record. Needs only node.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MDP = resolve(process.env.MDP_ROOT ?? join(HERE, '..', '..')) // this file is MDP/local-deploy/tools/token_audit.mjs

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  if (!args[i + 1] || args[i + 1].startsWith('--')) usage(`${name} needs a value`)
  return args[i + 1]
}
function usage(msg) {
  if (msg) console.error(`token_audit: ${msg}`)
  console.error('usage: node local-deploy/tools/token_audit.mjs [--since YYYY-MM-DD] [--label NAME] [--record] [--check-log] [--commands [--sample KEY] [--min N] [--top N] [--all-projects]] [--repos A,B|none] [--dir DIR] [--log LOG] [--metrics TSV]')
  process.exit(64)
}
const known = new Set(['--since', '--until', '--label', '--record', '--check-log', '--repos', '--dir', '--log', '--metrics', '--commands', '--sample', '--min', '--top', '--all-projects'])
for (const a of args) if (a.startsWith('--') && !known.has(a)) usage(`unknown option ${a}`)

const WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/
const since = opt('--since', '')
const until = opt('--until', '')
if (since && !WHEN.test(since)) usage('--since wants YYYY-MM-DD or YYYY-MM-DDTHH:MM')
if (until && !WHEN.test(until)) usage('--until wants YYYY-MM-DD or YYYY-MM-DDTHH:MM')
const inWindow = ts => {
  const t = String(ts ?? '')
  if (since && t.slice(0, since.length) < since) return false
  if (until && t.slice(0, until.length) >= until) return false
  return true
}
const label = opt('--label', '')
const dir = opt('--dir', join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', MDP.replace(/[:\\/]/g, '-')))
const logPath = opt('--log', join(MDP, '.claude', 'retro', 'log.md'))
const metricsPath = opt('--metrics', join(MDP, '.claude', 'retro', 'metrics.tsv'))
const reposArg = opt('--repos', '')

const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)))
const tok = chars => '~' + fmt(chars / 4)

// ---------- --commands: which shell commands recur, and which are worth allowlisting ----------
// Counts every command (not every call: `cd x && git log | head` is three) in the Bash tool calls, keyed by program and
// subcommand, then sorts each into: auto-allowed (never prompts), read-only and not yet allowed (a pattern is suggested),
// needs a judgement (a project script, a package script), writes, or runs arbitrary code (never a wildcard rule). Rules
// already in .claude/settings.json / settings.local.json are removed from the suggestions. MCP tools whose names read
// (read/get/list/search/view/find/status/context/logs) are listed the same way. Read-only: it prints, it never edits settings.
const BS = String.fromCharCode(92)
const AUTO_ANY = new Set('cal uptime cat head tail wc stat strings hexdump od nl id uname free df du locale groups nproc basename dirname realpath cut paste tr column tac rev fold expand unexpand fmt comm cmp numfmt readlink diff true false sleep which type expr seq tsort pr echo ls cd xargs file sed sort man help netstat ps base64 grep egrep fgrep sha256sum sha1sum md5sum tree date hostname lsof pgrep tput ss fd fdfind rg jq uniq history arch ifconfig pyright find printf test pwd whoami alias'.split(' '))
const SHELL_BUILTIN = new Set('export set unset local declare readonly read trap exit return break continue shift wait source . : [ [[ (( eval-skip done fi esac } for case select function in then do else elif while until if time nohup'.split(' '))
const GIT_READ = new Set('status log diff show blame branch tag remote ls-files ls-remote config rev-parse rev-list describe reflog shortlog cat-file for-each-ref worktree merge-base check-ignore name-rev grep whatchanged count-objects'.split(' '))
const GIT_WRITE = new Set('add commit checkout switch restore merge push pull rebase reset clean rm mv stash cherry-pick revert apply am init clone submodule gc prune bisect'.split(' '))
const GH_READ = new Set('pr view,pr list,pr diff,pr checks,pr status,issue view,issue list,issue status,run view,run list,workflow list,workflow view,repo view,release view,release list,auth status'.split(','))
const GH_WRITE = new Set('pr create,pr merge,pr edit,pr close,pr comment,pr ready,pr reopen,issue create,issue edit,issue close,issue comment,workflow run,release create,release delete,secret set,secret delete,run rerun,run cancel,repo create,repo delete'.split(','))
const READ_EXTRA = new Set('gh secret list,gh run watch,docker compose ps,docker compose logs,kubectl get,kubectl describe,kubectl logs,npm ls,npm view,pip list,pip show'.split(','))
const RUNS_CODE = new Set('python python3 py node bash sh zsh fish npx bunx uvx deno bun ruby perl php lua sudo ssh eval exec make just cargo go curl wget powershell pwsh cmd'.split(' '))
const FS_WRITE = new Set('rm mv cp mkdir rmdir touch chmod chown ln tee dd kill pkill tar unzip zip patch install'.split(' '))
const INTERP = new Set('python python3 py node bash sh zsh'.split(' '))

function stripHeredocs(text) {
  const out = []
  let tag = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (tag) { if (line.trim() === tag) tag = null; continue }
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line)
    if (m && line[m.index + 2] !== '<' && line[m.index - 1] !== '<') tag = m[2]
  }
  return out.join('\n')
}
// split at top-level && || ; | & and newlines, never inside quotes, a backslash pair or $( ), dropping # comments
function splitSegments(command) {
  const text = stripHeredocs(String(command ?? ''))
  const segs = []
  let cur = ''
  let q = null
  let depth = 0
  const push = () => { if (cur.trim()) segs.push(cur.trim()); cur = '' }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      cur += c
      if (c === BS && q === '"') cur += text[++i] ?? ''
      else if (c === q) q = null
      continue
    }
    if (c === BS) { cur += c + (text[++i] ?? ''); continue }
    if (c === "'" || c === '"') { q = c; cur += c; continue }
    if (c === '$' && text[i + 1] === '(') { depth += 1; cur += c; continue }
    if (c === ')' && depth > 0) { depth -= 1; cur += c; continue }
    if (depth > 0) { cur += c; continue }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) { while (i < text.length && text[i] !== '\n') i++; i -= 1; continue }
    if (c === '\n' || c === ';') { push(); continue }
    if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) { cur += c; continue } // 2>&1, >&2, &>file are redirections
    if (c === '&' || c === '|') { if (text[i + 1] === c) i += 1; push(); continue }
    cur += c
  }
  push()
  return segs
}
const WRAPPERS = new Set(['timeout', 'time', 'nohup', 'env', 'command', 'nice'])
const unq = t => t.replace(/^(['"])(.*)\1$/, '$2')
function commandKey(segment) {
  let t = (segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map(unq)
  for (let guard = 0; t.length && guard < 6; guard++) {
    if (/^[A-Za-z_]\w*=\$\(/.test(t[0])) { t[0] = t[0].replace(/^[A-Za-z_]\w*=\$\(/, ''); if (!t[0]) t = t.slice(1) } // out=$(gh run view ...): the command is inside
    else if (/^[A-Za-z_]\w*=/.test(t[0])) t = t.slice(1)
    else if (t[0] === '!' || t[0] === '(' || t[0] === '{') t = t.slice(1)
    else if (WRAPPERS.has(t[0])) t = t.slice(t[0] === 'timeout' ? 2 : 1)
    else if (['then', 'do', 'else', 'if', 'while', 'until'].includes(t[0])) t = t.slice(1)
    else break
  }
  if (t.length && /^[({]+./.test(t[0])) t[0] = t[0].replace(/^[({]+/, '') // `(cd x && ...)`: the paren is glued to the word
  if (!t.length) return null
  const first = t[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  if (SHELL_BUILTIN.has(first) || first === 'for' || first === 'case' || first === 'select' || first === 'function' || /^[)}]/.test(first)) return null
  const flagsOut = (from) => { const r = []; for (let i = from; i < t.length && r.length < 2; i++) if (!t[i].startsWith('-')) r.push(t[i]); return r }
  if (first === 'git') {
    let i = 1
    let dashC = false
    while (i < t.length && t[i].startsWith('-')) { if (t[i] === '-C') dashC = true; i += t[i] === '-C' || t[i] === '-c' ? 2 : 1 }
    const sub = t[i] ?? ''
    return { key: dashC ? `git -C * ${sub}` : `git ${sub}`, prog: 'git', sub, dashC }
  }
  if (['gh', 'docker', 'kubectl', 'npm', 'pnpm', 'yarn', 'pip', 'cargo'].includes(first)) {
    const [a = '', b = ''] = flagsOut(1)
    const two = (first === 'gh' && a !== 'api') || (first === 'npm' && a === 'run') || (first === 'docker' && a === 'compose')
    return { key: `${first} ${a}${two && b ? ' ' + b : ''}`.trim(), prog: first, sub: a, sub2: b }
  }
  if (INTERP.has(first) || ['npx', 'bunx', 'uvx'].includes(first)) {
    const i = t.findIndex((x, n) => n > 0 && (!x.startsWith('-') || x === '-c' || x === '-e' || x === '-'))
    const arg = i < 0 ? '' : t[i].replace(/^\.\//, '')
    return { key: `${first} ${arg}`.trim(), prog: first, sub: arg }
  }
  return { key: first, prog: first, sub: '' }
}
function classify(k) {
  const { prog, sub, sub2, dashC } = k
  if (prog === 'git') {
    if (GIT_READ.has(sub)) return dashC ? 'readonly' : 'auto'
    if (GIT_WRITE.has(sub)) return 'write'
    return sub === 'fetch' ? 'judge' : 'judge'
  }
  if (prog === 'gh') {
    const pair = `${sub} ${sub2}`
    if (GH_READ.has(pair)) return 'auto'
    if (READ_EXTRA.has(`gh ${pair}`)) return 'readonly'
    if (sub === 'api') return 'never'
    return GH_WRITE.has(pair) ? 'write' : 'judge'
  }
  if (prog === 'docker') {
    if (['ps', 'images', 'logs', 'inspect'].includes(sub)) return 'auto'
    if (READ_EXTRA.has(`docker ${sub} ${sub2}`.trim())) return 'readonly'
    return ['exec', 'run'].includes(sub) ? 'never' : 'write'
  }
  if (READ_EXTRA.has(`${prog} ${sub}`.trim())) return 'readonly'
  if (INTERP.has(prog)) return sub === '-c' || sub === '-e' || sub === '-' || !sub ? 'never' : 'judge'
  if (['npm', 'pnpm', 'yarn'].includes(prog)) return sub === 'run' ? 'judge' : sub === 'install' || sub === 'i' || sub === 'ci' ? 'write' : 'judge'
  if (RUNS_CODE.has(prog)) return 'never'
  if (FS_WRITE.has(prog)) return 'write'
  if (AUTO_ANY.has(prog)) return 'auto'
  return 'judge'
}
const globToRe = g => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
function allowedRules() {
  const rules = []
  for (const f of ['settings.json', 'settings.local.json']) {
    try { for (const r of JSON.parse(readFileSync(join(MDP, '.claude', f), 'utf8')).permissions?.allow ?? []) rules.push(String(r)) } catch { /* no such file */ }
  }
  return rules
}
function commandsReport() {
  const top = Number(opt('--top', '20'))
  const min = Number(opt('--min', '3'))
  if (!Number.isInteger(top) || top < 1 || !Number.isInteger(min) || min < 1) usage('--top and --min want positive whole numbers')
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const dirs = flag('--all-projects') ? (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(root, d.name)) : []) : [dir]
  if (!dirs.some(existsSync)) { console.error(`token_audit: no transcripts at ${dirs[0]} (pass --dir or --all-projects)`); process.exit(2) }
  const byKey = new Map()
  const mcp = new Map()
  let bashCalls = 0
  let total = 0
  const sessionsSeen = new Set()
  for (const d of dirs.filter(existsSync)) {
    for (const f of readdirSync(d).filter(n => n.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
        if (!line.includes('"tool_use"')) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (!inWindow(o.timestamp)) continue
        for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
          if (b?.type !== 'tool_use') continue
          sessionsSeen.add(f)
          if (typeof b.name === 'string' && b.name.startsWith('mcp__')) { mcp.set(b.name, (mcp.get(b.name) ?? 0) + 1); continue }
          if (b.name !== 'Bash' || typeof b.input?.command !== 'string') continue
          bashCalls += 1
          for (const seg of splitSegments(b.input.command)) {
            const k = commandKey(seg)
            if (!k || !k.key) continue
            total += 1
            const e = byKey.get(k.key) ?? { k, n: 0, samples: [] }
            e.n += 1
            if (e.samples.length < 3) e.samples.push(seg.replace(/\s+/g, ' ').slice(0, 140))
            byKey.set(k.key, e)
          }
        }
      }
    }
  }
  const rules = allowedRules()
  const allowRes = rules.filter(r => r.startsWith('Bash(')).flatMap(r => { try { return [globToRe(r.slice(5, -1).replace(/:\*$/, ' *').replace(/ \*$/, '*'))] } catch { return [] } })
  const isAllowed = key => { const rep = key.replace(/\*/g, 'R') + ' x'; return allowRes.some(re => re.test(rep)) }
  const groups = { auto: 0, allowed: 0, readonly: [], judge: [], write: [], never: [] }
  for (const { k, n } of byKey.values()) {
    const c = classify(k)
    if (c === 'auto') groups.auto += n
    else if (isAllowed(k.key)) groups.allowed += n
    else groups[c].push({ key: k.key, n })
  }
  const rank = a => a.filter(x => x.n >= min).sort((x, y) => y.n - x.n || x.key.localeCompare(y.key))
  const o = []
  o.push(`token_audit --commands  ${since || until ? `${since ? 'since ' + since : ''}${until ? ' until ' + until : ''}` : 'all sessions'}  (${sessionsSeen.size} sessions, ${bashCalls} Bash calls, ${total} commands; listing those seen ${min}+ times)`)
  o.push(`not listed: ${groups.auto} auto-allowed (never prompt), ${groups.allowed} already covered by a rule in .claude/settings*.json`)
  const ro = rank(groups.readonly)
  const sampleKey = opt('--sample', '')
  if (sampleKey) {
    const hit = byKey.get(sampleKey)
    console.log(hit ? `${sampleKey}: ${hit.n} time(s), classified ${classify(hit.k)}${isAllowed(sampleKey) ? ', already allowed' : ''}\n` + hit.samples.map(s => '  ' + s).join('\n') : `${sampleKey}: not seen`)
    return
  }
  o.push(`SUGGEST (read-only, not allowed yet):${ro.length ? '' : ' none'}`)
  for (const x of ro.slice(0, top)) o.push(`  ${String(x.n).padStart(5)}  Bash(${x.key} *)`)
  const mc = [...mcp].filter(([name, n]) => n >= min && /(^|_)(read|get|list|search|view|find|status|context|logs)(_|$)/.test(name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')) && !/(javascript|computer|batch|navigate|click|type|form_input|create|delete|send|write|set_|update)/.test(name))
    .filter(([name]) => !rules.some(r => r === name || r === name.split('__').slice(0, 2).join('__') || r === name.split('__').slice(0, 2).join('__') + '__*'))
    .sort((a, b) => b[1] - a[1])
  o.push(`SUGGEST MCP (read-only by name, not allowed yet):${mc.length ? '' : ' none'}`)
  for (const [name, n] of mc.slice(0, top)) o.push(`  ${String(n).padStart(5)}  ${name}`)
  const jd = rank(groups.judge)
  o.push(`JUDGE (project scripts, package scripts, unknown: allow the exact command only if it is read-only):${jd.length ? '' : ' none'}`)
  for (const x of jd.slice(0, top)) o.push(`  ${String(x.n).padStart(5)}  ${x.key}`)
  const wr = rank(groups.write)
  const nv = rank(groups.never)
  const brief = a => a.slice(0, 8).map(x => `${x.key} ${x.n}`).join(', ')
  o.push(`WRITES (never allowlist): ${wr.length ? brief(wr) : 'none'}`)
  o.push(`RUNS CODE (never a wildcard rule): ${nv.length ? brief(nv) : 'none'}`)
  console.log(o.join('\n'))
}
if (flag('--commands')) { commandsReport(); process.exit(0) }

// ---------- transcripts ----------
// Order matters: the first matching category wins.
const CATEGORIES = [
  // a whole-file read of CLAUDE.md (already loaded at session start). A ranged read (sed -n, head, tail, or cat piped to
  // one of them) is a legitimate lookup and falls through to file-reads.
  // `cat > file <<EOF` that merely mentions CLAUDE.md is a write, not a read.
  ['claude-md-read', c => /\bCLAUDE\.md\b/.test(c) && /^(cat|type)\b/.test(c) && !/^(cat|type)\s*>/.test(c) && !/<</.test(c) && !/\|\s*(head|sed|tail)\b/.test(c)],
  ['tests', c => /vitest|npm (run )?test|node --test|npm run verify|\btest_\w+\.(sh|py|mjs)/.test(c)],
  ['lint', c => /eslint|npm run lint/.test(c)],
  ['git', c => /^git\b|\bgit -C\b/.test(c)],
  ['gh', c => /^gh\b|\bgh (pr|run|api)\b/.test(c)],
  ['docker', c => /\bdocker\b/.test(c)],
  ['edit-tools', c => /multi_replace|json_patch/.test(c)],
  ['edit-scripts', c => /python3? -?\s*<<|python3? - |python3? -c|node -e|node -\s*<</.test(c)],
  ['builds', c => /build:catalog|vite build|npm run build|degrees:|degree-specs\/build|build_courses/.test(c)],
  ['file-reads', c => /^(cat|sed -n|head|tail|less|type)\b/.test(c) && !/^(cat|type)\s*>/.test(c) && !/<</.test(c)], // not `cat > f <<EOF`, a write
]
const bashCategory = cmd => {
  const c = String(cmd).replace(/\s+/g, ' ').trim().replace(/^(cd [^&;]+(&&|;) ?)+/, '').replace(/^\S+=\S+ /, '')
  for (const [name, test] of CATEGORIES) if (test(c)) return name
  return 'other'
}
const sizeOf = content =>
  typeof content === 'string' ? content.length
    : Array.isArray(content) ? content.reduce((n, p) => n + (typeof p === 'string' ? p.length : p?.type === 'image' ? 6000 : (p?.text?.length ?? JSON.stringify(p).length)), 0)
    : JSON.stringify(content ?? '').length

const cats = {}
const sessionIds = new Set()
let calls = 0
let totalChars = 0
let big = 0
let claudeReads = 0
let claudeChars = 0
let claudeRanged = 0
const biggest = []
const bump = (name, chars, label2) => {
  const c = (cats[name] ??= { calls: 0, chars: 0, max: 0 })
  c.calls += 1; c.chars += chars; c.max = Math.max(c.max, chars)
  calls += 1; totalChars += chars
  if (chars > 8000) big += 1
  biggest.push({ chars, what: `${name}: ${label2}` })
}

if (!existsSync(dir)) {
  console.error(`token_audit: no transcripts at ${dir} (pass --dir)`)
  process.exit(2)
}
for (const f of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
  const pending = new Map() // tool_use id -> { category, what }
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use') {
        if (!inWindow(o.timestamp)) continue
        const n = b.name
        const input = b.input ?? {}
        if (n === 'Bash' || n === 'PowerShell') {
          const category = bashCategory(input.command)
          const cmd = String(input.command ?? '').replace(/\s+/g, ' ').trim().replace(/^(cd [^&;]+(&&|;) ?)+/, '')
          pending.set(b.id, { category, ranged: category !== 'claude-md-read' && /\bCLAUDE\.md\b/.test(cmd) && /^(cat|head|sed|tail|type)\b/.test(cmd) && !/^(cat|type)\s*>/.test(cmd) && !/<</.test(cmd),
            what: String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 70) })
        } else if (n === 'Read') {
          const isClaudeMd = /CLAUDE\.md$/.test(String(input.file_path))
          const isRange = input.offset != null || input.limit != null
          pending.set(b.id, { category: isClaudeMd && !isRange ? 'claude-md-read' : 'Read tool', ranged: isClaudeMd && isRange, what: basename(String(input.file_path ?? '')) })
        }
        else if (n === 'Grep') pending.set(b.id, { category: 'Grep', what: String(input.pattern ?? '').slice(0, 50) })
      } else if (b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const p = pending.get(b.tool_use_id)
        pending.delete(b.tool_use_id)
        const chars = sizeOf(b.content)
        bump(p.category, chars, p.what)
        sessionIds.add(f)
        if (p.category === 'claude-md-read') { claudeReads += 1; claudeChars += chars }
        else if (p.ranged) claudeRanged += 1
      }
    }
  }
}
const sessions = sessionIds.size
const perSession = sessions ? totalChars / sessions : 0

// ---------- repos ----------
const sinceForGit = since.slice(0, 10) || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
const git = (repo, ...a) => execFileSync('git', ['-C', join(MDP, repo), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const repoNames = reposArg === 'none' ? []
  : reposArg ? reposArg.split(',').filter(Boolean)
  : readdirSync(MDP, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(MDP, d.name, '.git'))).map(d => d.name).sort()
const repoRows = []
for (const r of repoNames) {
  try {
    const subjects = git(r, 'log', `--since=${sinceForGit}`, '--format=%s').split('\n').filter(Boolean)
    const files = {}
    for (const l of git(r, 'log', `--since=${sinceForGit}`, '--name-only', '--format=').split('\n').filter(Boolean)) files[l] = (files[l] ?? 0) + 1
    const top = Object.entries(files).sort((a, b) => b[1] - a[1])[0]
    repoRows.push({
      name: r, commits: subjects.length,
      fix: subjects.filter(s => /^fix\b/i.test(s)).length,
      reverts: subjects.filter(s => /^revert\b/i.test(s)).length,
      hot: top ? `${top[0]} x${top[1]}` : '-',
    })
  } catch { /* not a repo, or git missing: skip it */ }
}

// ---------- retro log ----------
const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : []
const isEntry = l => /^\d{4}-\d{2}-\d{2} \|/.test(l)
const entries = logLines.map((text, i) => ({ text, n: i + 1 })).filter(e => isEntry(e.text) && (!since || e.text.slice(0, 10) >= since.slice(0, 10)) && (!until || e.text.slice(0, 10) <= until.slice(0, 10)))
const nearMiss = entries.filter(e => /\| near-miss \|/.test(e.text)).length
const repeats = entries.filter(e => /\| REPEAT\b/.test(e.text)).length

// ---------- report ----------
const out = []
out.push(`token audit  ${since || until ? `${since ? 'since ' + since : ''}${since && until ? ' ' : ''}${until ? 'until ' + until : ''}` : 'all sessions'}  (chars exact, tokens = chars/4 estimate)`)
out.push(`sessions ${sessions}  calls ${calls}  result chars ${fmt(totalChars)} (${tok(totalChars)} tok)  per session ${fmt(perSession)} (${tok(perSession)} tok)`)
out.push('category        calls     chars  share    max')
for (const [name, c] of Object.entries(cats).sort((a, b) => b[1].chars - a[1].chars).slice(0, 10)) {
  out.push(`${name.padEnd(14)} ${String(c.calls).padStart(6)} ${fmt(c.chars).padStart(9)} ${String(Math.round((100 * c.chars) / (totalChars || 1))).padStart(5)}% ${fmt(c.max).padStart(6)}`)
}
out.push(`CLAUDE.md read in full ${claudeReads}x (${fmt(claudeChars)} chars; it is already loaded), ${claudeRanged} ranged lookup(s) (fine)  results over 8k chars: ${big}`)
out.push('largest: ' + biggest.sort((a, b) => b.chars - a.chars).slice(0, 4).map(b => `${fmt(b.chars)} ${b.what.slice(0, 44)}`).join(' | '))
if (repoRows.length) {
  out.push(`repos since ${sinceForGit}:`)
  for (const r of repoRows) out.push(`  ${r.name.padEnd(24)} ${String(r.commits).padStart(3)} commits, ${r.commits ? Math.round((100 * r.fix) / r.commits) : 0}% fix, ${r.reverts} revert, most touched ${r.hot}`)
}
out.push(`retro log${since ? ' (window)' : ''}: ${entries.length} entries, ${nearMiss} near-miss, ${repeats} REPEAT`)

// ---------- fixed marker ----------
const fixed = []
logLines.forEach((text, i) => {
  const m = /^FIXED \| ([^|]*?) \| match: (.+) \| (.*)$/.exec(text) // greedy: the LAST " | " ends the regex
  if (m) fixed.push({ at: i, date: m[1].trim(), re: m[2].trim(), how: m[3].trim() })
})
if (flag('--check-log') || fixed.length) {
  const usable = []
  for (const f of fixed) {
    try { usable.push({ ...f, test: new RegExp(f.re, 'i') }) } catch { out.push(`FIXED line ${f.at + 1}: bad regex /${f.re}/`) }
  }
  const recurred = []
  let handled = 0
  for (const f of usable) {
    for (let i = f.at + 1; i < logLines.length; i++) {
      if (!isEntry(logLines[i]) || !f.test.test(logLines[i])) continue
      // a later FIXED line that matches this entry is the fix for this very recurrence
      if (usable.some(g => g !== f && g.at > i && g.test.test(logLines[i]))) handled += 1
      else recurred.push({ f, n: i + 1, text: logLines[i] })
    }
  }
  out.push(`fixed marker: ${fixed.length} fixed, ${recurred.length} recurrence(s) to look at${handled ? ` (${handled} already handled by a later FIXED)` : ''}`)
  for (const r of recurred) out.push(`  RECURRED line ${r.n}: ${r.text.split('|').slice(2, 4).join('|').trim().slice(0, 100)}  <- fixed ${r.f.date} by ${r.f.how.slice(0, 60)}`)
}

// ---------- change since the previous recorded row, then record ----------
const COLS = ['date', 'label', 'sessions', 'calls', 'result_chars', 'chars_per_session', 'git_chars', 'tests_chars', 'lint_chars', 'file_read_chars', 'claude_md_reads', 'edit_script_calls', 'over_8k', 'near_miss', 'repeat']
const chars = n => Math.round(cats[n]?.chars ?? 0)
const row = [new Date().toISOString().slice(0, 10), label || (since || until ? `${since ? 'since-' + since : ''}${until ? 'until-' + until : ''}` : 'all'), sessions, calls, Math.round(totalChars), Math.round(perSession), chars('git'), chars('tests'), chars('lint'),
  chars('file-reads') + chars('Read tool'), claudeReads, cats['edit-scripts']?.calls ?? 0, big, nearMiss, repeats]
if (existsSync(metricsPath)) {
  const prev = readFileSync(metricsPath, 'utf8').split('\n').filter(l => l && !l.startsWith('date\t')).pop()
  if (prev) {
    const p = prev.split('\t')
    const was = Number(p[5])
    out.push(`vs last row (${p[0]} ${p[1]}): per session ${fmt(was)} -> ${fmt(perSession)} chars (${was ? Math.round((100 * (perSession - was)) / was) : 0}%)`)
  }
}
if (flag('--record')) {
  mkdirSync(dirname(metricsPath), { recursive: true })
  if (!existsSync(metricsPath)) appendFileSync(metricsPath, COLS.join('\t') + '\n')
  appendFileSync(metricsPath, row.join('\t') + '\n')
  out.push(`recorded to ${metricsPath}`)
}
console.log(out.join('\n'))
