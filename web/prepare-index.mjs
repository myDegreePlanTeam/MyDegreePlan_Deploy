// Docker-build-only edits to index.html (the source file is left untouched so the
// Vercel build is unaffected):
//   1. Remove every Google Fonts request. They would tell Google each time a
//      student opens the planner; the CSS falls back to system fonts instead.
//   2. Load /config.js (written by the web container at start-up) before the app,
//      so supabaseClient.js can pick up the per-install API key.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'index.html'
let html = readFileSync(file, 'utf8')

html = html
  .replace(/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/gis, '')
  .replace(/<noscript>\s*<\/noscript>/gi, '')
  .replace('</head>', '    <script src="/config.js"></script>\n  </head>')

// Fail the build rather than ship a page that still calls out.
if (/fonts\.(googleapis|gstatic)\.com/i.test(html)) {
  console.error('prepare-index: a Google Fonts reference survived the strip')
  process.exit(1)
}
if (!html.includes('/config.js')) {
  console.error('prepare-index: could not inject /config.js (no </head> found)')
  process.exit(1)
}

writeFileSync(file, html)
console.log('prepare-index: index.html ready for the local build')
