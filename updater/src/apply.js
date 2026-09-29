// One-shot "apply" step. It runs from the NEW updater image in its own container
// (not part of the compose project), because switching versions recreates the
// running updater and a process cannot survive replacing itself.
//
//   stop old stack → snapshot the database volume → start the new stack → wait for it
//   to be healthy and the catalog loaded → done.   Any failure: stop the new stack,
//   put the snapshot back, start the old stack again, and report what happened.
import { composeArgs } from './updater.js'
import { parseManifest, sha256Hex, validateCompose, verifySignature } from './verify.js'
import { tail } from './docker.js'

const KEEP_SNAPSHOTS = 2
const HEARTBEAT_MS = 5000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Stamps apply.json every few seconds while the helper works, so the (new) updater can
// tell "helper still busy" from "helper died" (see Updater.reconcile).
export async function runApply(ctx) {
  const { state, now = Date.now } = ctx
  const beat = setInterval(() => {
    const a = state.readJson('apply.json', {}) ?? {}
    if (a.phase) state.writeJson('apply.json', { ...a, updatedAt: now() })
  }, HEARTBEAT_MS)
  try { return await applyInner(ctx) } finally { clearInterval(beat) }
}

async function applyInner({ config, state, docker, publicKey, log = () => {}, now = Date.now, wait = sleep }) {
  const target = { version: '?', sequence: 0 }
  const phase = (p) => state.writeJson('apply.json', { ...(state.readJson('apply.json', {}) ?? {}), phase: p, target, updatedAt: now() })

  // `message` is what the student reads; `detail` is the technical reason (logs, `mdp update`).
  const finish = (ok, message, detail) => state.writeJson('apply.json', {
    phase: null, updatedAt: now(),
    lastResult: { ok, version: target.version, sequence: target.sequence, at: now(), message, ...(detail ? { detail } : {}) },
  })
  const compose = (file, ...rest) => docker.run([...composeArgs(config, file), ...rest])

  // 1. Re-verify what the server staged: never trust a file just because it is on disk.
  let pendingFile, prevFile
  try {
    const bytes = state.readBytes('pending', 'release.json')
    if (!verifySignature(bytes, state.readText('pending', 'release.json.sig'), publicKey)) throw new Error('signature is not valid')
    const m = parseManifest(bytes.toString('utf8'))
    Object.assign(target, { version: m.version, sequence: m.sequence })
    if (m.sequence <= config.sequence) throw new Error('not newer than the running version')
    const text = state.readBytes('pending', 'docker-compose.yml')
    if (sha256Hex(text) !== m.composeSha256) throw new Error('compose file does not match the signed release')
    const problems = validateCompose(text.toString('utf8'))
    if (problems.length) throw new Error(problems.join('; '))
    pendingFile = state.path('pending', 'docker-compose.yml')
    // Rolling back needs the compose file that describes what is running now.
    prevFile = state.exists('current', 'docker-compose.yml') ? state.path('current', 'docker-compose.yml')
      : state.exists('launched.yml') ? state.path('launched.yml') : null
    if (!prevFile) throw new Error('the current setup was never recorded (start the app once with mdp start, then try again)')
  } catch (e) {
    log(`refusing to apply: ${e.message}`)
    finish(false, 'The update was not applied. Nothing was changed.', e.message)
    return false
  }

  const image = config.helperImage
  const snapName = `pre-${config.sequence}-to-${target.sequence}.tar.gz`
  let stoppedOld = false

  try {
    phase('stopping')
    const down = await compose(prevFile, 'down')
    if (down.code !== 0) throw new Error(`could not stop the app: ${tail(down.out, 4)}`)
    stoppedOld = true

    phase('backup')
    const snap = await docker.run(['run', '--rm', '-v', `${config.dbVolume}:/data:ro`, '-v', `${config.stateVolume}:/state`,
      '--entrypoint', 'sh', image, '-c', `mkdir -p /state/snapshots && tar czf /state/snapshots/${snapName} -C /data .`])
    if (snap.code !== 0) throw new Error(`could not back up the database: ${tail(snap.out, 4)}`)

    phase('starting')
    const up = await compose(pendingFile, 'up', '-d', '--remove-orphans')
    if (up.code !== 0) throw new Error(`the new version failed to start: ${tail(up.out, 6)}`)

    phase('verifying')
    await waitHealthy({ config, compose, file: pendingFile, wait, now })

    state.writeText('current/docker-compose.yml', state.readText('pending', 'docker-compose.yml'))
    state.writeText('current/release.json', state.readText('pending', 'release.json'))
    state.remove('pending')
    await prune({ config, docker, image })
    finish(true, `Updated to ${target.version}.`)
    return true
  } catch (e) {
    log(`update failed: ${e.message}`)
    return rollback({ e, config, state, docker, compose, pendingFile, prevFile, image, snapName, stoppedOld, phase, finish, wait, now, log })
  }
}

async function rollback({ e, config, docker, compose, pendingFile, prevFile, image, snapName, stoppedOld, phase, finish, wait, now, log }) {
  try {
    phase('rollback')
    await compose(pendingFile, 'down')
    if (stoppedOld) {
      // Restore only if a snapshot exists; if the failure came before it, the data was never touched.
      const restore = await docker.run(['run', '--rm', '-v', `${config.dbVolume}:/data`, '-v', `${config.stateVolume}:/state:ro`,
        '--entrypoint', 'sh', image, '-c',
        `if [ -f /state/snapshots/${snapName} ]; then find /data -mindepth 1 -delete && tar xzf /state/snapshots/${snapName} -C /data; fi`])
      if (restore.code !== 0) throw new Error(`could not restore the database: ${tail(restore.out, 4)}`)
      const up = await compose(prevFile, 'up', '-d', '--remove-orphans')
      if (up.code !== 0) throw new Error(`the previous version would not start: ${tail(up.out, 4)}`)
      await waitHealthy({ config, compose, file: prevFile, wait, now })
    }
    finish(false, 'The update could not be completed, so the previous version was restored. Your plan is unchanged.', e.message)
    return false
  } catch (r) {
    log(`rollback failed: ${r.message}`)
    finish(false, 'The update failed and the app could not be restarted automatically. Your data is safe. Run "mdp start" to bring the app back, and tell the maintainer.', `${e.message}; then: ${r.message}`)
    return false
  }
}

// `docker compose ps` prints one JSON object per line (newer) or one array (older).
function parsePs(out) {
  const t = out.trim()
  if (!t) return []
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : [v] } catch { /* NDJSON */ }
  return t.split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

export async function waitHealthy({ config, compose, file, wait, now }) {
  const deadline = now() + config.healthTimeoutMs
  for (;;) {
    const ps = await compose(file, 'ps', '-a', '--format', 'json')
    const by = Object.fromEntries(parsePs(ps.out).map((c) => [c.Service, c]))
    for (const s of ['migrate', 'seed']) {
      if (by[s]?.State === 'exited' && by[s].ExitCode !== 0) throw new Error(`${s} step failed`)
    }
    const web = by.web, seed = by.seed
    if (web?.Health === 'healthy' && seed?.State === 'exited' && seed.ExitCode === 0) return
    if (now() > deadline) throw new Error('timed out waiting for the new version to become healthy')
    await wait(3000)
  }
}

async function prune({ config, docker, image }) {
  // Keep the newest few snapshots; they are the safety net, not an archive.
  await docker.run(['run', '--rm', '-v', `${config.stateVolume}:/state`, '--entrypoint', 'sh', image, '-c',
    `cd /state/snapshots 2>/dev/null && ls -1t | tail -n +${KEEP_SNAPSHOTS + 1} | xargs -r rm -f`])
}
