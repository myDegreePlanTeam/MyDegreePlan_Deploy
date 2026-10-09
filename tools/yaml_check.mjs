#!/usr/bin/env node
// yaml_check.mjs: parse YAML files and print one short line per file. Made for GitHub Actions workflows, which only fail
// after a push ("workflow file issue", or a 422 when dispatching) if a step name or a one-line `run:` value holds an
// unquoted ": " (retro 2026-10-09: three times in one session). js-yaml prints the whole document, twice (about 15k
// characters), on an error; this prints the line and column and the reason only.
//
//   node local-deploy/tools/yaml_check.mjs FILE...
//
//   ok:    .github/workflows/release.yml  (2 jobs, 13 steps)
//   ERROR: .github/workflows/ci.yml  line 14, column 25: bad indentation of a mapping entry
//
// A file with a top-level `jobs` mapping is also checked as a workflow: every job needs `runs-on` (or `uses`) and `steps`,
// and every step needs `run` or `uses`. Anything else is only parsed. Exit 0 when every file is fine, 1 when any is not, 64 usage.
//
// The `yaml` package is the one release-tools already depends on (local-deploy/release-tools, `npm ci`); a sibling repo's copy is
// the fallback. js-yaml's error output was the 15k-character one, which is why it is not used.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.YAML_CHECK_ROOT ? resolve(process.env.YAML_CHECK_ROOT) : resolve(HERE, '..', '..')

export function loadYaml(root = ROOT) {
  // release-tools is next to this folder in the Deploy repo itself (CI checks out only that repo), so it is found without the workspace
  const homes = [join(HERE, '..', 'release-tools'), ...['MyDegreePlan_Desktop', 'MyDegreePlan_Frontend', 'MyDegreePlan_Site'].map(h => join(root, h))]
  for (const dir of homes) {
    if (!existsSync(join(dir, 'node_modules', 'yaml'))) continue
    try { return createRequire(join(dir, 'package.json'))('yaml') } catch { /* try the next one */ }
  }
  return null
}

// The first line of the message is the reason; the rest is a code frame of the document.
function reason(error) {
  const first = String(error?.message ?? error).split('\n')[0].trim().replace(/\s+at line \d+, column \d+:?$/, '')
  const at = error?.linePos?.[0]
  return at ? `line ${at.line}, column ${at.col}: ${first}` : first
}

function workflowProblems(doc) {
  const problems = []
  let steps = 0
  const jobs = doc.jobs
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) return { problems: ['jobs is not a mapping'], jobs: 0, steps }
  for (const [name, job] of Object.entries(jobs)) {
    if (job === null || typeof job !== 'object') { problems.push(`job ${name} is not a mapping`); continue }
    if (job.uses) continue // a reusable workflow call has no steps
    if (!job['runs-on']) problems.push(`job ${name} has no runs-on`)
    if (!Array.isArray(job.steps) || !job.steps.length) { problems.push(`job ${name} has no steps`); continue }
    job.steps.forEach((step, i) => {
      steps += 1
      if (step === null || typeof step !== 'object' || (!step.run && !step.uses)) problems.push(`job ${name}, step ${i + 1}${step?.name ? ` (${String(step.name).slice(0, 40)})` : ''} has neither run nor uses`)
    })
  }
  return { problems, jobs: Object.keys(jobs).length, steps }
}

export function checkYaml(yaml, file, text) {
  let doc
  try { doc = yaml.parse(text) } catch (error) { return { ok: false, line: `ERROR: ${file}  ${reason(error)}` } }
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && 'jobs' in doc) {
    const { problems, jobs, steps } = workflowProblems(doc)
    if (problems.length) return { ok: false, line: `ERROR: ${file}  ${problems.slice(0, 3).join('; ')}` }
    return { ok: true, line: `ok:    ${file}  (${jobs} job${jobs === 1 ? '' : 's'}, ${steps} step${steps === 1 ? '' : 's'})` }
  }
  return { ok: true, line: `ok:    ${file}` }
}

function main(argv) {
  const files = argv.filter(a => !a.startsWith('--'))
  if (!files.length) { console.error('usage: node local-deploy/tools/yaml_check.mjs FILE...'); return 64 }
  const yaml = loadYaml()
  if (!yaml) { console.error('yaml_check: the yaml package is not installed (run npm ci in local-deploy/release-tools)'); return 1 }
  let bad = 0
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { console.log(`ERROR: ${file}  cannot read the file`); bad += 1; continue }
    const result = checkYaml(yaml, file, text)
    console.log(result.line)
    if (!result.ok) bad += 1
  }
  return bad ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)))
