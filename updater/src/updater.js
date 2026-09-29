// The long-running half of the updater: finds out whether a newer signed release
// exists, and (on request) downloads + verifies it and hands over to the one-shot
// apply helper. It never decides *what* to run from anything but a signed manifest.
import { PASS_ENV } from './config.js'
import { parseManifest, sha256Hex, updaterImageRef, validateCompose, verifySignature } from './verify.js'
import { dirname } from 'node:path'
import { tail } from './docker.js'

export const ACTIVE_PHASES = new Set(['downloading', 'stopping', 'backup', 'starting', 'verifying', 'rollback'])
const STALE_MS = 20 * 60 * 1000
const HEARTBEAT_STALE_MS = 45 * 1000   // the helper stamps apply.json every 5s
const MAX_MANIFEST = 64 * 1024
const MAX_COMPOSE = 256 * 1024

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function composeArgs(config, file) {
  return ['compose', '-p', config.project, '-f', file, '--project-directory', dirname(file)]
}

export class Updater {
  constructor({ config, state, docker, publicKey, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now }) {
    Object.assign(this, { config, state, docker, publicKey, fetchImpl, log, now })
    this.checking = false
    this.lastCheckAt = 0
    this.reconcile()
  }

  get disabledReason() {
    if (this.config.updatesOff) return 'update checks are turned off (MDP_UPDATES=off in .env)'
    if (!this.publicKey) return 'this build has no release signing key'
    if (!this.config.updateUrl) return 'no update address is configured'
    return null
  }
  get enabled() { return this.disabledReason === null }

  get current() { return { version: this.config.version, sequence: this.config.sequence } }

  // ── persisted pieces ────────────────────────────────────────────────────────
  get settings() { return { auto: false, ...(this.state.readJson('settings.json', {}) ?? {}) } }
  setAuto(auto) { this.state.writeJson('settings.json', { auto: !!auto }); return this.settings }
  get applyState() { return this.state.readJson('apply.json', {}) ?? {} }
  setApply(patch) { this.state.writeJson('apply.json', { ...this.applyState, ...patch, updatedAt: this.now() }) }
  get found() { return this.state.readJson('status.json', {}) ?? {} }

  // Only the apply helper may declare an update finished or rolled back, and it stamps
  // apply.json every few seconds while it works. So a *fresh* in-progress record is left
  // alone (the new updater starts before the new version is verified, and must not
  // announce success early). A stale one means the helper is gone: if the running version
  // reached the target it finished and died before writing the result; otherwise it was
  // interrupted.
  reconcile() {
    const a = this.applyState
    if (!a.phase || !ACTIVE_PHASES.has(a.phase)) return
    const age = this.now() - (a.updatedAt ?? 0)
    if (age < HEARTBEAT_STALE_MS) return
    if (a.target && this.config.sequence >= a.target.sequence) {
      this.state.writeJson('apply.json', {
        phase: null, updatedAt: this.now(),
        lastResult: { ok: true, version: a.target.version, sequence: a.target.sequence, at: this.now(), message: 'Updated.' },
      })
    } else if (age > STALE_MS) {
      this.state.writeJson('apply.json', {
        phase: null, updatedAt: this.now(),
        lastResult: { ok: false, version: a.target?.version, sequence: a.target?.sequence, at: this.now(), message: 'The update was interrupted. Your plan is unchanged.' },
      })
    }
  }

  status() {
    this.reconcile()
    const a = this.applyState
    const f = this.found
    const active = !!a.phase && ACTIVE_PHASES.has(a.phase)
    const latest = f.latest ?? null
    const updateAvailable = !!latest && latest.sequence > this.config.sequence
    const required = updateAvailable && this.config.sequence < (latest.minSequence ?? 0)
    let state = 'idle'
    if (!this.enabled) state = 'disabled'
    else if (active) state = a.phase === 'downloading' ? 'downloading' : 'applying'
    else if (updateAvailable) state = 'available'
    return {
      state,
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      current: this.current,
      latest,
      updateAvailable,
      required,
      phase: active ? a.phase : null,
      target: active ? a.target ?? null : null,
      lastResult: a.lastResult ?? null,
      checkedAt: f.checkedAt ?? null,
      error: f.error ?? null,
      auto: this.settings.auto,
    }
  }

  // ── network ─────────────────────────────────────────────────────────────────
  async #get(url, max) {
    const u = new URL(url)
    if (u.protocol !== 'https:' && !(this.config.allowHttp && u.protocol === 'http:')) throw new Error('update address must be https')
    const res = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'mdp-updater', accept: '*/*' },   // deliberately no version, id or account data
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`${u.host} answered ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw new Error('download is larger than expected')
    return buf
  }

  async fetchManifest() {
    const base = this.config.updateUrl
    const bytes = await this.#get(`${base}/release.json`, MAX_MANIFEST)
    const sig = (await this.#get(`${base}/release.json.sig`, 1024)).toString('utf8')
    if (!verifySignature(bytes, sig, this.publicKey)) throw new Error('release signature is not valid; ignoring it')
    return { manifest: parseManifest(bytes.toString('utf8')), bytes, sig }
  }

  async check({ force = false } = {}) {
    if (!this.enabled) return this.status()
    if (this.checking) return this.status()
    if (!force && this.now() - this.lastCheckAt < 30_000) return this.status()
    this.checking = true
    this.lastCheckAt = this.now()
    try {
      const { manifest } = await this.fetchManifest()
      this.state.writeJson('status.json', {
        latest: {
          version: manifest.version, sequence: manifest.sequence, minSequence: manifest.minSequence,
          notes: manifest.notes, releasedAt: manifest.releasedAt,
        },
        checkedAt: this.now(), error: null,
      })
    } catch (e) {
      this.log(`check failed: ${e.message}`)
      this.state.writeJson('status.json', { ...this.found, checkedAt: this.now(), error: e.message })
    } finally {
      this.checking = false
    }
    const s = this.status()
    if (s.updateAvailable && s.auto && s.state === 'available') {
      this.apply().catch((e) => this.log(`auto-update not started: ${e.message}`))
    }
    return this.status()
  }

  // ── apply ───────────────────────────────────────────────────────────────────
  // Validates the request synchronously, then does the slow work in the background;
  // callers poll status(). The app keeps running until the helper takes over.
  async apply() {
    if (!this.enabled) throw new HttpError(409, 'Updates are not enabled on this install.')
    const s = this.status()
    if (s.state === 'downloading' || s.state === 'applying') throw new HttpError(409, 'An update is already in progress.')
    if (!s.updateAvailable) throw new HttpError(409, 'Already up to date.')
    this.setApply({ phase: 'downloading', target: { version: s.latest.version, sequence: s.latest.sequence }, lastResult: null })
    this.job = this.#prepare().catch((e) => {
      this.log(`update failed before switching: ${e.message}`)
      this.state.writeJson('apply.json', {
        phase: null, updatedAt: this.now(),
        lastResult: { ok: false, at: this.now(), message: 'Could not download the update. Nothing was changed.', detail: e.message },
      })
    })
    return this.status()
  }

  async #prepare() {
    // Fetch again rather than trusting whatever check() cached.
    const { manifest, bytes, sig } = await this.fetchManifest()
    if (manifest.sequence <= this.config.sequence) throw new Error('already up to date')
    this.setApply({ phase: 'downloading', target: { version: manifest.version, sequence: manifest.sequence } })

    const compose = await this.#get(`${this.config.updateUrl}/docker-compose.yml`, MAX_COMPOSE)
    if (sha256Hex(compose) !== manifest.composeSha256) throw new Error('compose file does not match the signed release')
    const text = compose.toString('utf8')
    const problems = validateCompose(text)
    if (problems.length) throw new Error(`compose file failed checks: ${problems.join('; ')}`)
    const helperImage = updaterImageRef(text)
    if (!helperImage) throw new Error('compose file has no updater image')

    this.state.remove('pending')
    this.state.writeText('pending/release.json', bytes.toString('utf8'))
    this.state.writeText('pending/release.json.sig', sig)
    this.state.writeText('pending/docker-compose.yml', text)
    this.state.writeJson('pending/meta.json', { helperImage })

    const file = this.state.path('pending', 'docker-compose.yml')
    const pull = await this.docker.run([...composeArgs(this.config, file), 'pull', '--quiet'])
    if (pull.code !== 0) throw new Error(`image download failed: ${tail(pull.out, 4)}`)

    await this.docker.run(['rm', '-f', this.config.helperName])
    const args = ['run', '-d', '--rm', '--name', this.config.helperName,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${this.config.stateVolume}:/state`,
      '-e', 'STATE_DIR=/state', '-e', `MDP_HELPER_IMAGE=${helperImage}`]
    for (const name of PASS_ENV) if (name !== 'STATE_DIR' && process.env[name] !== undefined) args.push('-e', name)
    args.push('--entrypoint', 'node', helperImage, 'src/main.js', 'apply')
    const started = await this.docker.run(args)
    if (started.code !== 0) throw new Error(`could not start the update step: ${tail(started.out, 4)}`)
    this.setApply({ phase: 'stopping' })
  }
}
