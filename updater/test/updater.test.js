import test from 'node:test'
import assert from 'node:assert/strict'
import { Updater } from '../src/updater.js'
import { cfg, composeText, fakeDocker, fakeFetch, keypair, publish, release, tmpState, UPDATER_IMG } from './helpers.js'

function setup({ files, docker = fakeDocker(), config = cfg(), publicKey, seedState } = {}) {
  const keys = keypair()
  const state = tmpState()
  if (seedState) seedState(state)
  const fetchImpl = fakeFetch(files ? files(keys) : {})
  const updater = new Updater({ config, state, docker, publicKey: publicKey === undefined ? keys.publicKey : publicKey, fetchImpl })
  return { keys, state, docker, fetchImpl, updater }
}
const rel = (over) => (k) => publish(release({ privateKey: k.privateKey, ...over }))

test('disabled without a key or without an address', async () => {
  assert.equal(setup({ publicKey: null }).updater.status().state, 'disabled')
  assert.equal(setup({ config: cfg({ updateUrl: '' }) }).updater.status().state, 'disabled')
  assert.equal(setup({ publicKey: null }).updater.status().disabledReason, 'this build has no release signing key')
  // the student's own opt-out: nothing is fetched, and the app never shows an update prompt
  const off = setup({ config: cfg({ updatesOff: true }), files: rel({}) })
  assert.equal(off.updater.status().state, 'disabled')
  assert.match(off.updater.status().disabledReason, /MDP_UPDATES=off/)
  await off.updater.check({ force: true })
  assert.equal(off.fetchImpl.calls.length, 0)
  await assert.rejects(off.updater.apply(), /not enabled/)
})

test('check: a newer signed release makes an update available', async () => {
  const { updater } = setup({ files: rel({ sequence: 20, version: '1.1.0', notes: 'Fixed prereqs.' }) })
  const s = await updater.check({ force: true })
  assert.equal(s.state, 'available')
  assert.equal(s.updateAvailable, true)
  assert.equal(s.latest.version, '1.1.0')
  assert.equal(s.latest.notes, 'Fixed prereqs.')
  assert.equal(s.required, false)
  assert.equal(s.error, null)
})

test('check: same or older sequence is "up to date" (replayed old releases do nothing)', async () => {
  for (const sequence of [10, 3]) {
    const { updater } = setup({ files: rel({ sequence }) })
    const s = await updater.check({ force: true })
    assert.equal(s.state, 'idle')
    assert.equal(s.updateAvailable, false)
  }
})

test('check: min_sequence above the running version makes it required', async () => {
  const { updater } = setup({ files: rel({ sequence: 20, minSequence: 15 }) })
  assert.equal((await updater.check({ force: true })).required, true)
  const ok = setup({ files: rel({ sequence: 20, minSequence: 10 }) })
  assert.equal((await ok.updater.check({ force: true })).required, false)
})

test('check: a bad signature or missing files are ignored and reported, never trusted', async () => {
  const bad = setup({ files: rel({ badSig: true }) })
  const s = await bad.updater.check({ force: true })
  assert.equal(s.updateAvailable, false)
  assert.match(s.error, /signature is not valid/)

  const other = setup({ files: (k) => publish(release({ privateKey: keypair().privateKey })) })   // signed by a different key
  assert.match((await other.updater.check({ force: true })).error, /signature is not valid/)

  const missing = setup({ files: () => ({}) })
  assert.match((await missing.updater.check({ force: true })).error, /404/)
})

test('check: refuses plain http unless the dev switch is on', async () => {
  const { updater } = setup({ config: cfg({ updateUrl: 'http://example.test/rel' }), files: rel({}) })
  assert.match((await updater.check({ force: true })).error, /must be https/)
  const dev = setup({ config: cfg({ updateUrl: 'http://example.test/rel', allowHttp: true }), files: rel({}) })
  assert.equal((await dev.updater.check({ force: true })).updateAvailable, true)
})

test('check: sends no version, id, or account data', async () => {
  let seen
  const keys = keypair()
  const files = publish(release({ privateKey: keys.privateKey }))
  const updater = new Updater({
    config: cfg(), state: tmpState(), docker: fakeDocker(), publicKey: keys.publicKey,
    fetchImpl: async (url, opts) => { seen = opts; return fakeFetch(files)(url) },
  })
  await updater.check({ force: true })
  assert.deepEqual(Object.keys(seen.headers).sort(), ['accept', 'user-agent'])
  assert.equal(seen.headers['user-agent'], 'mdp-updater')
})

test('apply: stages the verified release, pulls, and launches the helper from the NEW updater image', async () => {
  const { updater, state, docker } = setup({ files: rel({ sequence: 20, version: '1.1.0' }) })
  await updater.check({ force: true })
  const s = await updater.apply()
  assert.equal(s.state, 'downloading')
  await updater.job
  assert.equal(state.exists('pending', 'docker-compose.yml'), true)
  assert.equal(state.readText('pending', 'docker-compose.yml'), composeText())

  const pull = docker.calls.find((c) => c.includes('pull'))
  assert.ok(pull.includes('--quiet') && pull.includes('-p') && pull.includes('mydegreeplan'))
  const run = docker.calls.find((c) => c[0] === 'run')
  assert.deepEqual(run.slice(-5), ['--entrypoint', 'node', UPDATER_IMG, 'src/main.js', 'apply'])
  assert.ok(run.includes('/var/run/docker.sock:/var/run/docker.sock'))
  assert.equal(updater.status().state, 'applying')
})

test('apply: secrets reach the helper by name only, never as values on the command line', async () => {
  process.env.POSTGRES_PASSWORD = 'pw-do-not-leak-123'
  try {
    const { updater, docker } = setup({ files: rel({}) })
    await updater.check({ force: true })
    await updater.apply(); await updater.job
    const run = docker.calls.find((c) => c[0] === 'run')
    const i = run.indexOf('POSTGRES_PASSWORD')
    assert.equal(run[i - 1], '-e')
    assert.ok(!run.join(' ').includes('pw-do-not-leak-123'))
  } finally { delete process.env.POSTGRES_PASSWORD }
})

test('apply: a compose file that does not match the signed hash is refused and nothing runs', async () => {
  const { updater, docker } = setup({
    files: (k) => ({ ...publish(release({ privateKey: k.privateKey })), 'docker-compose.yml': `${composeText()}# tampered\n` }),
  })
  await updater.check({ force: true })
  await updater.apply()
  await updater.job
  assert.equal(docker.calls.length, 0)
  const s = updater.status()
  assert.equal(s.state, 'available')
  assert.equal(s.lastResult.ok, false)
  assert.match(s.lastResult.detail, /does not match the signed release/)
  assert.match(s.lastResult.message, /Nothing was changed/)
})

test('apply: an unpinned compose (even if correctly signed) is refused', async () => {
  const bad = composeText({ pinned: false })
  const { updater, docker } = setup({ files: rel({ compose: bad }) })
  await updater.check({ force: true })
  await updater.apply(); await updater.job
  assert.equal(docker.calls.length, 0)
  assert.match(updater.status().lastResult.detail, /not digest-pinned/)
})

test('apply: a failed image download leaves the app untouched and says so', async () => {
  const docker = fakeDocker((a) => (a.includes('pull') ? { code: 1, out: 'manifest unknown' } : null))
  const { updater } = setup({ files: rel({}), docker })
  await updater.check({ force: true })
  await updater.apply(); await updater.job
  assert.equal(docker.calls.some((c) => c[0] === 'run'), false)
  assert.match(updater.status().lastResult.message, /Nothing was changed/)
})

test('apply: rejected when up to date, when disabled, or when one is already running', async () => {
  const idle = setup({ files: rel({ sequence: 5 }) })
  await idle.updater.check({ force: true })
  await assert.rejects(idle.updater.apply(), /up to date/)

  await assert.rejects(setup({ publicKey: null }).updater.apply(), /not enabled/)

  const { updater } = setup({ files: rel({}) })
  await updater.check({ force: true })
  await updater.apply()
  await assert.rejects(updater.apply(), /already in progress/)
  await updater.job
})

test('auto mode applies as soon as a check finds an update; off by default', async () => {
  const off = setup({ files: rel({}) })
  await off.updater.check({ force: true })
  assert.equal(off.updater.status().state, 'available')

  const on = setup({ files: rel({}) })
  on.updater.setAuto(true)
  await on.updater.check({ force: true })
  await on.updater.job
  assert.equal(on.updater.status().state, 'applying')
})

test('reconcile: a fresh in-progress update is never declared finished by anyone but the helper', () => {
  // The NEW updater boots (already at the target sequence) while the helper is still verifying.
  const seed = (phase, ageMs) => (s) => s.writeJson('apply.json', { phase, target: { version: '0.9', sequence: 9 }, updatedAt: Date.now() - ageMs })
  const fresh = setup({ seedState: seed('verifying', 2000) })
  assert.equal(fresh.updater.status().state, 'applying')
  assert.equal(fresh.updater.status().lastResult, null)
})

test('reconcile: a stale record means the helper is gone', () => {
  const seed = (target, ageMs) => (s) => s.writeJson('apply.json', { phase: 'starting', target, updatedAt: Date.now() - ageMs })
  // reached the target and the helper stopped stamping: it finished, then died before writing the result
  const done = setup({ seedState: seed({ version: '0.9', sequence: 9 }, 60 * 1000) })
  assert.equal(done.updater.status().lastResult.ok, true)
  assert.equal(done.updater.status().phase, null)
  // still on the old version, quiet for a while, but not long enough to give up on: wait
  const waiting = setup({ seedState: seed({ version: '2', sequence: 99 }, 60 * 1000) })
  assert.equal(waiting.updater.status().state, 'applying')
  // still on the old version and quiet for 20+ minutes: interrupted
  const dead = setup({ seedState: seed({ version: '2', sequence: 99 }, 30 * 60 * 1000) })
  assert.equal(dead.updater.status().lastResult.ok, false)
  assert.match(dead.updater.status().lastResult.message, /interrupted/)
})
