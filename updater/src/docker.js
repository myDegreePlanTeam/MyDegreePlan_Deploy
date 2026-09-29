// The only place the updater talks to Docker. Arguments are always an array handed
// to spawn() with no shell, so nothing that came from a manifest or a request can
// ever be interpreted as shell syntax.
import { spawn } from 'node:child_process'

export const docker = {
  run(args, { env, timeoutMs = 10 * 60 * 1000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      const keep = (b) => { out += b; if (out.length > 200_000) out = out.slice(-100_000) }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e.message) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.trim() }) })
    })
  },
}

export const tail = (text, n = 12) => String(text).split('\n').slice(-n).join('\n')
