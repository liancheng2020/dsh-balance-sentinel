// Market listing self-check (zero deps). Validates the listing YAML, the
// screenshot declaration and the icon against the current awesome-dsh-plugin
// rules, so a PR is not rejected for a formatting slip.
// Run: node scripts/verify-market.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LISTING = join(root, 'market', 'liancheng2020__dsh-balance-sentinel.yml')
const REPO = 'https://github.com/liancheng2020/dsh-balance-sentinel'
const OWNER_REPO = 'liancheng2020/dsh-balance-sentinel'
const RAW = 'https://raw.githubusercontent.com/liancheng2020/dsh-balance-sentinel/main/'
const CATEGORIES = new Set([
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl', 'browser',
  'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
])
const SHOT_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github.com'])

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ }
}

const read = (p) => readFileSync(p, 'utf8')
const field = (yaml, key) => {
  const m = yaml.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))
  return m ? m[1].trim() : null
}

const yaml = existsSync(LISTING) ? read(LISTING) : ''

check('K1 listing: required fields present', () => {
  if (!yaml) throw new Error('missing ' + LISTING)
  for (const k of ['url', 'name', 'category', 'icon']) {
    if (!field(yaml, k)) throw new Error('missing field: ' + k)
  }
  if (!/^description:\s*$/m.test(yaml)) throw new Error('missing description block')
  if (!/^  en: '/m.test(yaml)) throw new Error('description.en missing or not quoted')
  if (!/^  zh: '/m.test(yaml)) throw new Error('description.zh missing or not quoted')
})

check('K2 listing: url/name match this repo', () => {
  if (field(yaml, 'url') !== REPO) throw new Error('url must be ' + REPO)
  if (field(yaml, 'name') !== OWNER_REPO) throw new Error('name must be ' + OWNER_REPO)
})

check('K3 listing: category is a valid value', () => {
  const c = field(yaml, 'category')
  if (!CATEGORIES.has(c)) throw new Error('invalid category: ' + c)
})

check('K4 listing: descriptions end with a period and cover Feishu + DingTalk', () => {
  const en = (yaml.match(/^\s{2}en:\s*'(.*)'\s*$/m) || [])[1] || ''
  const zh = (yaml.match(/^\s{2}zh:\s*'(.*)'\s*$/m) || [])[1] || ''
  if (!en.endsWith('.')) throw new Error('description.en must end with "."')
  if (!zh.endsWith('。')) throw new Error('description.zh must end with "。"')
  if (!/feishu/i.test(en) || !/dingtalk/i.test(en)) throw new Error('description.en must name Feishu and DingTalk')
  if (!zh.includes('飞书') || !zh.includes('钉钉')) throw new Error('description.zh must name 飞书 and 钉钉')
  if (!/local dsh desktop/i.test(en)) throw new Error('description.en must state the local-only support boundary')
})

check('K5 listing: no hand-written npm key', () => {
  if (/^npm:/m.test(yaml) || /^\s{2}npm:/m.test(yaml)) throw new Error('npm: is collected by CI, do not write it')
})

check('K6 icon: GitHub-hosted PNG (SVG is rejected)', () => {
  const icon = field(yaml, 'icon')
  if (!icon.startsWith(RAW)) throw new Error('icon must be a raw.githubusercontent.com URL under this repo')
  if (!icon.toLowerCase().endsWith('.png')) throw new Error('icon must be .png/.jpg/.webp, not SVG')
  const local = join(root, icon.slice(RAW.length))
  if (!existsSync(local)) throw new Error('icon file missing locally: ' + local)
})

check('K7 icon file: PNG, square, >= 128px', () => {
  const icon = field(yaml, 'icon') || ''
  const buf = readFileSync(join(root, icon.slice(RAW.length)))
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
  if (w !== h) throw new Error(`must be square, got ${w}x${h}`)
  if (w < 128) throw new Error('must be at least 128px (shown at ~96px), got ' + w)
})

check('K8 screenshots: 1-8 entries, GitHub-hosted, files exist', () => {
  let j
  try { j = JSON.parse(read(join(root, 'screenshots.json'))) } catch (e) { throw new Error('invalid JSON: ' + e.message) }
  const list = Array.isArray(j) ? j : j?.screenshots
  if (!Array.isArray(list)) throw new Error('expected an array or { "screenshots": [...] }')
  if (list.length < 1 || list.length > 8) throw new Error('need 1-8 screenshots, got ' + list.length)
  for (const url of list) {
    if (typeof url !== 'string') throw new Error('non-string entry')
    if (url.startsWith('/') || url.includes('..')) throw new Error('bad path: ' + url)
    if (/^https:\/\//.test(url)) {
      const host = new URL(url).host
      if (!SHOT_HOSTS.has(host)) throw new Error('third-party image host rejected: ' + host)
      const local = join(root, url.slice(RAW.length).split('?')[0])
      if (url.startsWith(RAW) && !existsSync(local)) throw new Error('screenshot missing locally: ' + local)
    }
  }
})

check('K9 install prerequisites: dsh.bundle + cordis.patch.yml shipped', () => {
  const pkg = JSON.parse(read(join(root, 'package.json')))
  if (!pkg.dsh?.bundle?.patch) throw new Error('package.json must declare dsh.bundle.patch')
  if (!existsSync(join(root, 'cordis.patch.yml'))) throw new Error('cordis.patch.yml missing at repo root')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
