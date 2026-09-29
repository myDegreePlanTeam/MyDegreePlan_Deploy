// Tiny JSON-file store on the state volume. Writes are atomic (temp + rename) so a
// crash or a power cut mid-update never leaves half a file for the next boot.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class State {
  constructor(dir) { this.dir = dir }
  path(...p) { return join(this.dir, ...p) }
  exists(...p) { return existsSync(this.path(...p)) }
  readText(...p) { return readFileSync(this.path(...p), 'utf8') }
  readBytes(...p) { return readFileSync(this.path(...p)) }
  readJson(name, fallback = null) {
    try { return JSON.parse(this.readText(name)) } catch { return fallback }
  }
  writeText(name, text) {
    const file = this.path(name)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  }
  writeJson(name, obj) { this.writeText(name, JSON.stringify(obj, null, 2)) }
  remove(...p) { rmSync(this.path(...p), { recursive: true, force: true }) }
  // Newest-first list of files in a sub-directory.
  list(sub) {
    try {
      return readdirSync(this.path(sub))
        .map((n) => ({ name: n, mtime: statSync(this.path(sub, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => f.name)
    } catch { return [] }
  }
}
