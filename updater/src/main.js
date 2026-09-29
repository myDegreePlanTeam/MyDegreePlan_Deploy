// node src/main.js [serve|apply|cli <status|check|apply>]
import { readFileSync } from 'node:fs'
import { loadConfig } from './config.js'
import { State } from './state.js'
import { docker } from './docker.js'
import { loadPublicKey } from './verify.js'
import { Updater } from './updater.js'
import { createApiServer, createCliServer } from './server.js'
import { runApply } from './apply.js'

const config = loadConfig()
const state = new State(config.stateDir)
const log = (m) => console.error(`[mdp-updater] ${m}`)   // stderr: stdout is reserved for the cli's JSON

let publicKey = null
try { publicKey = loadPublicKey(readFileSync(config.pubKeyPath, 'utf8')) } catch (e) { log(`no usable release key (${e.message}); updates are disabled`) }

const mode = process.argv[2] ?? 'serve'

if (mode === 'apply') {
  if (!publicKey) { log('cannot apply without a release key'); process.exit(2) }
  const ok = await runApply({ config, state, docker, publicKey, log })
  process.exit(ok ? 0 : 1)
}

if (mode === 'cli') {
  const cmd = process.argv[3] ?? 'status'
  const map = { status: ['GET', '/status'], check: ['POST', '/check'], apply: ['POST', '/apply'] }
  if (!map[cmd]) { console.error('usage: cli status|check|apply'); process.exit(64) }
  const res = await fetch(`http://127.0.0.1:${config.cliPort}${map[cmd][1]}`, { method: map[cmd][0] })
  console.log(JSON.stringify(await res.json(), null, 2))
  process.exit(res.ok ? 0 : 1)
}

const updater = new Updater({ config, state, docker, publicKey, log })
createApiServer({ updater, config }).listen(config.listenPort, '0.0.0.0', () => log(`api on :${config.listenPort}`))
createCliServer({ updater }).listen(config.cliPort, '127.0.0.1')

if (updater.enabled) {
  log(`running ${config.version} (sequence ${config.sequence}); checking ${config.updateUrl}`)
  const tick = () => updater.check({ force: true }).catch((e) => log(`check error: ${e.message}`))
  setTimeout(tick, config.firstCheckMs)
  // ±10% jitter so a whole classroom does not hit the server in the same second.
  const every = () => setTimeout(() => { tick(); every() }, config.checkEveryMs * (0.9 + Math.random() * 0.2))
  every()
} else {
  log(`updates disabled: ${updater.disabledReason}`)
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
