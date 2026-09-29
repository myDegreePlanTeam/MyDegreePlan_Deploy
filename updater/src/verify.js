// Release trust: everything the updater will ever act on is a byte string signed by
// the release key whose public half is baked into this image. Anything that fails
// here is dropped before it can influence what runs on the student's machine.
import { createHash, createPublicKey, verify } from 'node:crypto'

export function loadPublicKey(pem) {
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('release key must be an ECDSA P-256 public key')
  }
  return key
}

// `signature` is base64 of the DER ECDSA-SHA256 signature over the exact `data` bytes.
export function verifySignature(data, signature, publicKey) {
  let sig
  try { sig = Buffer.from(String(signature).trim(), 'base64') } catch { return false }
  if (sig.length < 8 || sig.length > 160) return false
  try { return verify('sha256', data, publicKey, sig) } catch { return false }
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

const isInt = (n) => Number.isSafeInteger(n)

export function parseManifest(text) {
  let m
  try { m = JSON.parse(text) } catch { throw new Error('release.json is not valid JSON') }
  const bad = (why) => { throw new Error(`release.json rejected: ${why}`) }
  if (!m || typeof m !== 'object') bad('not an object')
  if (m.schema !== 1) bad('unsupported schema')
  if (typeof m.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(m.version)) bad('bad version')
  if (!isInt(m.sequence) || m.sequence < 1) bad('bad sequence')
  const minSequence = m.min_sequence ?? 0
  if (!isInt(minSequence) || minSequence < 0) bad('bad min_sequence')
  if (!m.compose || typeof m.compose.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.compose.sha256)) bad('bad compose hash')
  return {
    version: m.version,
    sequence: m.sequence,
    minSequence,
    releasedAt: typeof m.released_at === 'string' ? m.released_at.slice(0, 40) : null,
    notes: typeof m.notes === 'string' ? m.notes.slice(0, 4000) : '',
    composeSha256: m.compose.sha256,
  }
}

// The compose file arrives hash-checked, but it is still inspected before it is ever
// handed to Docker, so a bug in the generator can't silently widen what a release
// may do. Line-based on purpose: the generator emits a fixed, simple YAML shape.
export function validateCompose(text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  let images = 0
  for (const line of lines) {
    const img = /^\s*image:\s*["']?([^"'\s#]+)/.exec(line)
    if (img) {
      images++
      if (!/@sha256:[0-9a-f]{64}$/.test(img[1])) problems.push(`image is not digest-pinned: ${img[1]}`)
    }
    if (/^\s*build:/.test(line)) problems.push('release compose must not build images')
    if (/^\s*(privileged|pid|ipc|userns_mode|network_mode|cap_add|devices):/.test(line)) {
      problems.push(`forbidden setting: ${line.trim()}`)
    }
    // Host paths: only the Docker socket may be bind-mounted from the host.
    const src = /^\s*-\s+["']?([./~][^:"'\s]*):/.exec(line) || /^\s*source:\s*["']?([./~][^"'\s]*)/.exec(line)
    if (src && src[1] !== '/var/run/docker.sock') problems.push(`host path mount not allowed: ${src[1]}`)
  }
  if (images === 0) problems.push('no images found')
  return problems
}

// The one image the apply step is launched from: whatever the `updater` service runs.
// Found by service name, not by the image's repository name, so it holds for any
// registry path. Relies on the generator's fixed layout (services indented two spaces).
export function updaterImageRef(composeText) {
  let inUpdater = false
  for (const line of composeText.split(/\r?\n/)) {
    if (/^  updater:\s*$/.test(line)) { inUpdater = true; continue }
    if (inUpdater && /^\S/.test(line)) return null                    // left the services block
    if (inUpdater && /^  \S/.test(line)) return null                  // next service: no image seen
    if (inUpdater) {
      const m = /^\s+image:\s*["']?(\S+?)["']?\s*$/.exec(line)
      if (m) return /@sha256:[0-9a-f]{64}$/.test(m[1]) ? m[1] : null
    }
  }
  return null
}
