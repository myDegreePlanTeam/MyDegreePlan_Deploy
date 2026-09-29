import test from 'node:test'
import assert from 'node:assert/strict'
import { runApply } from '../src/apply.js'
import { cfg, composeText, fakeDocker, keypair, norm, release, tmpState, UPDATER_IMG } from './helpers.js'

const psJson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n')
const HEALTHY = psJson([
  { Service: 'migrate', State: 'exited', ExitCode: 0 },
  { Service: 'web', State: 'running', Health: 'healthy' },
  { Service: 'seed', State: 'exited', ExitCode: 0 },
])

function stage({ prev = 'launched', sequence = 20, compose = composeText(), badSig = false } = {}) {
  const keys = keypair()
  const state = tmpState()
  const r = release({ privateKey: keys.privateKey, sequence, compose, badSig })
  state.writeText('pending/release.json', r.manifest)
  state.writeText('pending/release.json.sig', r.sig)
  state.writeText('pending/docker-compose.yml', r.compose)
  if (prev === 'launched') state.writeText('launched.yml', 'name: old\n')
  if (prev === 'current') state.writeText('current/docker-compose.yml', 'name: older\n')
  return { keys, state }
}

const run = async ({ keys, state }, docker, over = {}) => {
  const logs = []
  const ok = await runApply({
    config: cfg({ healthTimeoutMs: 50, ...over }), state, docker, publicKey: keys.publicKey,
    log: (m) => logs.push(m), wait: async () => {}, now: (() => { let t = 0; return () => (t += 10) })(),
  })
  return { ok, logs, result: state.readJson('apply.json').lastResult, apply: state.readJson('apply.json') }
}
// compose file a call operates on, e.g. "pending/docker-compose.yml"; and the verb it ran.
const fileOf = (a) => {
  const f = norm(a[a.indexOf('-f') + 1] ?? '')
  return /(pending|current)\/docker-compose\.yml$/.test(f) ? f.split('/').slice(-2).join('/') : f.split('/').pop()
}
const verbOf = (a) => ['down', 'up', 'ps', 'pull'].find((v) => a.includes(v))
const onPending = (a) => a[0] === 'compose' && fileOf(a) === 'pending/docker-compose.yml'
const verbs = (docker) => docker.calls.map((c) => (c[0] === 'compose' ? `compose:${verbOf(c)}:${fileOf(c)}` : `docker:${c[0]}`))

test('happy path: stop old → snapshot → start new → verify → record as current', async () => {
  const s = stage()
  const docker = fakeDocker((a) => (a.includes('ps') ? { code: 0, out: HEALTHY } : null))
  const r = await run(s, docker)
  assert.equal(r.ok, true)
  assert.deepEqual(verbs(docker).slice(0, 5), [
    'compose:down:launched.yml', 'docker:run', 'compose:up:pending/docker-compose.yml', 'compose:ps:pending/docker-compose.yml', 'docker:run',
  ])
  const snap = docker.calls[1]
  assert.ok(snap.join(' ').includes('tar czf /state/snapshots/pre-10-to-20.tar.gz'))
  assert.ok(snap.includes('mdp_db_data:/data:ro'))               // the snapshot cannot alter the database
  assert.equal(s.state.readText('current', 'docker-compose.yml'), composeText())
  assert.equal(s.state.exists('pending'), false)
  assert.equal(r.result.ok, true)
  assert.equal(r.apply.phase, null)
})

test('rollback uses the last applied compose when there is one', async () => {
  const s = stage({ prev: 'current' })
  const docker = fakeDocker((a) => (onPending(a) && a.includes('up') ? { code: 1, out: 'boom' } : a.includes('ps') ? { code: 0, out: HEALTHY } : null))
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.equal(verbs(docker)[0], 'compose:down:current/docker-compose.yml')
})

test('new version fails to start: old stack restored from the snapshot, plan reported unchanged', async () => {
  const s = stage()
  let pendingUp = false
  const docker = fakeDocker((a) => {
    if (onPending(a) && a.includes('up')) { pendingUp = true; return { code: 1, out: 'image not found' } }
    if (a.includes('ps')) return { code: 0, out: HEALTHY }
    return null
  })
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.equal(pendingUp, true)
  const v = verbs(docker)
  assert.deepEqual(v.slice(-4), ['compose:down:pending/docker-compose.yml', 'docker:run', 'compose:up:launched.yml', 'compose:ps:launched.yml'])
  const restore = docker.calls.find((c) => c[0] === 'run' && c.join(' ').includes('tar xzf'))
  assert.ok(restore.join(' ').includes('find /data -mindepth 1 -delete'))
  assert.ok(restore.includes('mdp_db_data:/data'))
  assert.match(r.result.message, /previous version was restored/)
  assert.match(r.result.message, /plan is unchanged/)
  assert.match(r.result.detail, /image not found/)          // the technical reason is kept, but not in the message
  assert.doesNotMatch(r.result.message, /image not found/)
  assert.equal(s.state.exists('current', 'docker-compose.yml'), false)   // never recorded as current
})

test('unhealthy new version (seed fails) is rolled back too', async () => {
  const s = stage()
  const docker = fakeDocker((a) => {
    if (a.includes('ps')) {
      return { code: 0, out: onPending(a) ? psJson([{ Service: 'seed', State: 'exited', ExitCode: 1 }]) : HEALTHY }
    }
    return null
  })
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.match(r.result.detail, /seed step failed/)
  assert.ok(verbs(docker).includes('compose:up:launched.yml'))
})

test('a version that never becomes healthy times out and rolls back', async () => {
  const s = stage()
  const docker = fakeDocker((a) => {
    if (a.includes('ps')) return { code: 0, out: onPending(a) ? psJson([{ Service: 'web', State: 'running', Health: 'starting' }]) : HEALTHY }
    return null
  })
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.match(r.result.detail, /timed out/)
})

test('if the snapshot itself fails, nothing is started and the old stack comes back untouched', async () => {
  const s = stage()
  const docker = fakeDocker((a) => (a[0] === 'run' && a.join(' ').includes('tar czf') ? { code: 1, out: 'no space' } : a.includes('ps') ? { code: 0, out: HEALTHY } : null))
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.equal(docker.calls.some((c) => onPending(c) && c.includes('up')), false)
  assert.match(r.result.detail, /could not back up the database/)
})

test('if rollback also fails, the message tells the student how to recover and data is untouched', async () => {
  const s = stage()
  const docker = fakeDocker((a) => (a.includes('up') ? { code: 1, out: 'daemon gone' } : null))
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.match(r.result.message, /mdp start/)
})

test('refuses (touching nothing) when the release cannot be verified again', async () => {
  for (const [name, s] of [
    ['bad signature', stage({ badSig: true })],
    ['not newer', stage({ sequence: 10 })],
    ['unpinned compose', stage({ compose: composeText({ pinned: false }) })],
    ['no record of the current setup', stage({ prev: 'none' })],
  ]) {
    const docker = fakeDocker()
    const r = await run(s, docker)
    assert.equal(r.ok, false, name)
    assert.equal(docker.calls.length, 0, `${name}: must not touch docker`)
    assert.match(r.result.message, /Nothing was changed/, name)
  }
})

test('tampering with the staged compose after staging is caught by the helper', async () => {
  const s = stage()
  s.state.writeText('pending/docker-compose.yml', `${composeText()}# swapped\n`)
  const docker = fakeDocker()
  const r = await run(s, docker)
  assert.equal(r.ok, false)
  assert.equal(docker.calls.length, 0)
  assert.match(r.result.detail, /does not match the signed release/)
})

test('the snapshot/restore helper runs from the new updater image', async () => {
  const s = stage()
  const docker = fakeDocker((a) => (a.includes('ps') ? { code: 0, out: HEALTHY } : null))
  await run(s, docker)
  assert.ok(docker.calls.find((c) => c[0] === 'run').includes(UPDATER_IMG))
})
