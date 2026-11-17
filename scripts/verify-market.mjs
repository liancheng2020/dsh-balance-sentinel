// Market display assets self-check (zero deps): the icon and screenshots are
// consumed by the listing, so their format/hosting rules are easy to break
// silently. Run: node scripts/verify-market.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = 'https://raw.githubusercontent.com/liancheng2020/dsh-balance-sentinel/main/'
const SHOT_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github.com'])

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ }
}
const read = (p) => readFileSync(p, 'utf8')

check('K1 icon: PNG, square, >= 128px', () => {
  const p = join(root, 'assets', 'icon-180.png')
  if (!existsSync(p)) throw new Error('missing assets/icon-180.png')
  const buf = readFileSync(p)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG (SVG is rejected by the listing)')
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
  if (w !== h) throw new Error(`must be square, got ${w}x${h}`)
  if (w < 128) throw new Error('must be at least 128px (shown at ~96px), got ' + w)
})

check('K2 screenshots: 1-8 entries, GitHub-hosted, files exist', () => {
  let j
  try { j = JSON.parse(read(join(root, 'screenshots.json'))) } catch (e) { throw new Error('invalid JSON: ' + e.message) }
  const list = Array.isArray(j) ? j : j?.screenshots
  if (!Array.isArray(list)) throw new Error('expected an array or { "screenshots": [...] }')
  if (list.length < 1 || list.length > 8) throw new Error('need 1-8 screenshots, got ' + list.length)
  for (const url of list) {
    if (typeof url !== 'string') throw new Error('non-string entry')
    if (url.startsWith('/') || url.includes('..')) throw new Error('bad path: ' + url)
    if (!/^https:\/\//.test(url)) continue
    const host = new URL(url).host
    if (!SHOT_HOSTS.has(host)) throw new Error('third-party image host rejected: ' + host)
    if (url.startsWith(RAW) && !existsSync(join(root, url.slice(RAW.length).split('?')[0]))) {
      throw new Error('screenshot missing locally: ' + url)
    }
  }
})

check('K3 install prerequisites: dsh.bundle + cordis.patch.yml shipped', () => {
  const pkg = JSON.parse(read(join(root, 'package.json')))
  if (!pkg.dsh?.bundle?.patch) throw new Error('package.json must declare dsh.bundle.patch')
  if (!existsSync(join(root, 'cordis.patch.yml'))) throw new Error('cordis.patch.yml missing at repo root')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
