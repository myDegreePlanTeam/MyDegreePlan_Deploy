// Final gate before a release is published: check the finished artefacts with the
// UPDATER'S OWN verification code, exactly as a student's install will. If this passes,
// every install will accept the release; if it fails, nothing has been published yet.
//
//   node verify-dist.mjs <dir> [--pub ../updater/release-signing.pub.pem] [--min-sequence-above N]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPublicKey, parseManifest, sha256Hex, updaterImageRef, validateCompose, verifySignature } from '../updater/src/verify.js'

const dir = process.argv[2]
if (!dir) { console.error('usage: verify-dist.mjs <dir> [--pub file]'); process.exit(64) }
const pubIdx = process.argv.indexOf('--pub')
const pubFile = pubIdx > 0 ? process.argv[pubIdx + 1] : new URL('../updater/release-signing.pub.pem', import.meta.url)

const fail = (m) => { console.error(`verify-dist: ${m}`); process.exit(1) }
const manifestBytes = readFileSync(join(dir, 'release.json'))
const compose = readFileSync(join(dir, 'docker-compose.yml'))

if (!verifySignature(manifestBytes, readFileSync(join(dir, 'release.json.sig'), 'utf8'), loadPublicKey(readFileSync(pubFile, 'utf8')))) {
  fail('release.json signature does not verify against the baked-in public key')
}
const m = parseManifest(manifestBytes.toString('utf8'))
if (sha256Hex(compose) !== m.composeSha256) fail('docker-compose.yml does not match the hash in release.json')
const problems = validateCompose(compose.toString('utf8'))
if (problems.length) fail(`compose file failed checks: ${problems.join('; ')}`)
if (!updaterImageRef(compose.toString('utf8'))) fail('compose file has no digest-pinned mdp-updater image')
console.log(`verify-dist: OK — ${m.version} (sequence ${m.sequence}, min ${m.minSequence}) verifies exactly as a student install will`)
