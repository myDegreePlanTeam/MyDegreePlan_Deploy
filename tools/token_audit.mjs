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
//
// What it measures (from the session transcripts under ~/.claude/projects/<workspace>/*.jsonl)
//   * the size of every Bash / PowerShell / Read / Grep result, by category (git, tests, lint, docker, builds, file reads,
//     python/node edit scripts, ...), with call counts, share and the largest result of each
//   * how often CLAUDE.md was read although it is already loaded, and how many results exceed 8,000 characters
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
  console.error('usage: node local-deploy/tools/token_audit.mjs [--since YYYY-MM-DD] [--label NAME] [--record] [--check-log] [--repos A,B|none] [--dir DIR] [--log LOG] [--metrics TSV]')
  process.exit(64)
}
const known = new Set(['--since', '--until', '--label', '--record', '--check-log', '--repos', '--dir', '--log', '--metrics'])
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

// ---------- transcripts ----------
// Order matters: the first matching category wins.
const CATEGORIES = [
  ['claude-md-read', c => /\bCLAUDE\.md\b/.test(c) && /^(cat|head|sed|tail|type)\b/.test(c)],
  ['tests', c => /vitest|npm (run )?test|node --test|npm run verify|\btest_\w+\.(sh|py|mjs)/.test(c)],
  ['lint', c => /eslint|npm run lint/.test(c)],
  ['git', c => /^git\b|\bgit -C\b/.test(c)],
  ['gh', c => /^gh\b|\bgh (pr|run|api)\b/.test(c)],
  ['docker', c => /\bdocker\b/.test(c)],
  ['edit-tools', c => /multi_replace|json_patch/.test(c)],
  ['edit-scripts', c => /python3? -?\s*<<|python3? - |python3? -c|node -e|node -\s*<</.test(c)],
  ['builds', c => /build:catalog|vite build|npm run build|degrees:|degree-specs\/build|build_courses/.test(c)],
  ['file-reads', c => /^(cat|sed -n|head|tail|less|type)\b/.test(c)],
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
        if (n === 'Bash' || n === 'PowerShell') pending.set(b.id, { category: bashCategory(input.command), what: String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 70) })
        else if (n === 'Read') pending.set(b.id, { category: /CLAUDE\.md$/.test(String(input.file_path)) ? 'claude-md-read' : 'Read tool', what: basename(String(input.file_path ?? '')) })
        else if (n === 'Grep') pending.set(b.id, { category: 'Grep', what: String(input.pattern ?? '').slice(0, 50) })
      } else if (b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const p = pending.get(b.tool_use_id)
        pending.delete(b.tool_use_id)
        const chars = sizeOf(b.content)
        bump(p.category, chars, p.what)
        sessionIds.add(f)
        if (p.category === 'claude-md-read') { claudeReads += 1; claudeChars += chars }
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
out.push(`CLAUDE.md read explicitly ${claudeReads}x (${fmt(claudeChars)} chars; it is already loaded)  results over 8k chars: ${big}`)
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
