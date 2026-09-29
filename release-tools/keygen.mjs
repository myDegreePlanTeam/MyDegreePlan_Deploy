// One-time: create the release signing key pair.
//   node release-tools/keygen.mjs [private-key-output-path]
//
// The PUBLIC key goes in updater/release-signing.pub.pem and is committed; it is
// baked into every updater image and is what students' installs trust.
// The PRIVATE key must never be committed. Store it as the GitHub Actions secret
// MDP_SIGNING_KEY (in the protected "release" environment), keep an offline copy in a
// password manager, and delete the file. Whoever holds it can ship code to every
// student's computer.
import { existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSigningKey } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pubPath = resolve(here, '../updater/release-signing.pub.pem')
const privPath = resolve(process.argv[2] ?? 'release-signing.key.pem')

if (existsSync(pubPath) || existsSync(privPath)) {
  console.error(`Refusing to overwrite an existing key:\n  ${existsSync(pubPath) ? pubPath : privPath}\nRotating the key needs a signed release that ships the new public key first (see README).`)
  process.exit(1)
}
const { publicPem, privatePem } = generateSigningKey()
writeFileSync(pubPath, publicPem)
writeFileSync(privPath, privatePem, { mode: 0o600 })
console.log(`Public key:  ${pubPath}   (commit this)`)
console.log(`Private key: ${privPath}   (NEVER commit this)`)
console.log('\nNext: add the private key file\'s contents as the secret MDP_SIGNING_KEY, then delete the file.')
