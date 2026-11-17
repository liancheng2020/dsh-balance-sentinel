// Two-process alert dedup verification. Both workers share one DSH_HOME and
// run a monitor cycle against the same low balance. The cycle lock must let
// exactly one process decide+push; the later worker must see the persisted
// level and not re-push. Run: node scripts/verify-dedup.mjs

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const stateUrl = pathToFileURL(join(lib, 'state.js')).href
const balanceUrl = pathToFileURL(join(lib, 'balance.js')).href

const home = mkdtempSync(join(tmpdir(), 'sentinel-dedup-'))
const pushLog = join(home, 'pushes.log')
writeFileSync(pushLog, '')

const workerCode = `
import { loadState, saveState, acquireStateLock, mergeStateFromDisk } from '${stateUrl}'
import { applyBalance, deliverPending } from '${balanceUrl}'
import { appendFileSync } from 'node:fs'
await new Promise((r) => setTimeout(r, Number(process.env.DELAY || 0)))
const state = loadState()
state.webhook = { channel: 'generic', url: 'http://x', secret: '' }
const release = acquireStateLock()
if (release) {
  try {
    mergeStateFromDisk(state)
    applyBalance(state, { ok: true, wallets: [{ currency: 'CNY', total: 10 }] }, { warn: 20, critical: 5 }, Date.now())
    await deliverPending(state, { send: async () => { appendFileSync(process.env.PUSH_LOG, 'push\\n'); return { ok: true, chunks: 1 } } }, {}, Date.now(), false, {})
    saveState(state)
  } finally { release() }
}
`

const run = (delay) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
    env: { ...process.env, DSH_HOME: home, PUSH_LOG: pushLog, DELAY: String(delay) },
    stdio: 'inherit',
  })
  child.on('exit', resolve)
})

// Concurrent start (lock must exclude one) + a late second cycle (persisted
// level must exclude a re-push).
await Promise.all([run(0), run(800)])
const count = existsSync(pushLog) ? readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).length : 0
console.log(`\n推送计数: ${count} (应为 1)`)
process.exitCode = count === 1 ? 0 : 1