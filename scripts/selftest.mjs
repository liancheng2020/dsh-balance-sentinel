// Host-side self-test. No framework — plain node:assert + local fake webhooks.
// Covers the reliability gate: transition dedup, recovery cooldown, quiet
// merge, classified retries (business / ambiguous / hold), cross-instance
// merge, bridge origin gate + masking + prefs validation, source chain.

import assert from 'node:assert'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'sentinel-selftest-'))

const { normalizeWallets, pickPrimary, levelOf, effectiveThresholds, applyBalance, deliverPending, formatAlert, createBalanceSource, startMonitor, RECOVERY_COOLDOWN_MS } = await import('../lib/balance.js')
const { mergeStateFromDisk, acquireStateLock, saveState, loadState } = await import('../lib/state.js')
const { createNotifier, chunkContent, withSignature, DEFAULT_SIGNATURE, toFeishuCard } = await import('../lib/notify.js')
const { startLocalApi } = await import('../lib/localapi.js')
const { isQuietNow } = await import('../lib/time.js')

let passed = 0, failed = 0
const test = (name, fn) => { try { fn(); console.log('PASS  ' + name); passed++ } catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ } }
const atest = async (name, fn) => {
  let timer
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout 5s')), 5000) })
  try { await Promise.race([fn(), guard]); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ }
  finally { clearTimeout(timer) }
}

const fresh = () => ({
  webhook: { channel: 'generic', url: 'http://x', secret: '' },
  alert: { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 },
  pending: null, prefs: { warn: null, critical: null },
  balance: { value: null, currency: null, at: null, ok: false, reason: null },
  lastResult: { at: null, ok: false, error: null },
})
const okFr = (total) => ({ ok: true, wallets: [{ currency: 'CNY', total }] })
const TH = { warn: 20, critical: 5 }
const NOW = 1700000000000
const okNotifier = { send: async () => ({ ok: true, chunks: 1 }) }

// ---- N: wallet normalization across the three wire shapes ----
test('N1 remote ready combines recharge + bonus', () => {
  const w = normalizeWallets({ status: 'ready', value: [{ currency: 'CNY', balance: '10.5' }], bonusWallets: [{ currency: 'CNY', balance: '2' }] })
  assert.deepEqual(w, [{ currency: 'CNY', total: 12.5 }])
})
test('N2 REST balance_infos shape', () => {
  assert.deepEqual(normalizeWallets({ balance_infos: [{ currency: 'CNY', total_balance: '8.00' }] }), [{ currency: 'CNY', total: 8 }])
})
test('N3 bare array + primary prefers CNY', () => {
  const w = normalizeWallets([{ currency: 'USD', balance: '3' }, { currency: 'CNY', balance: '9' }])
  assert.equal(pickPrimary(w).currency, 'CNY')
})
test('N4 garbage -> null', () => assert.equal(normalizeWallets({ foo: 1 }), null))

// ---- L: level boundaries ----
test('L1 levelOf boundaries', () => {
  assert.equal(levelOf(20, 20, 5), 'normal')
  assert.equal(levelOf(19.99, 20, 5), 'warn')
  assert.equal(levelOf(5, 20, 5), 'warn')
  assert.equal(levelOf(4.99, 20, 5), 'critical')
})

// ---- T: state machine ----
test('T1 transition enqueues; same level never re-enqueues', () => {
  const s = fresh()
  assert.equal(applyBalance(s, okFr(10), TH, NOW), 'warn')
  assert.equal(s.pending.kind, 'warn')
  assert.equal(applyBalance(s, okFr(10), TH, NOW + 1000), null)
  assert.equal(s.pending.kind, 'warn')
})
test('T2 escalation supersedes pending', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(applyBalance(s, okFr(3), TH, NOW + 1), 'critical')
  assert.equal(s.pending.kind, 'critical')
  assert.equal(s.pending.attempts, 0)
})
test('T3 recovery respects cooldown', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  s.alert.lastPushAt = NOW
  assert.equal(applyBalance(s, okFr(30), TH, NOW + 1000), 'recovered')
  assert.equal(s.pending.nextAt, NOW + RECOVERY_COOLDOWN_MS)
})
test('T4 fetch failure never changes level', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(applyBalance(s, { ok: false, reason: 'network' }, TH, NOW + 1), null)
  assert.equal(s.alert.level, 'warn')
  assert.equal(s.balance.reason, 'network')
})
test('T6 threshold-driven recovery cancels silently', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  s.alert.lastPushAt = NOW // delivered warn
  assert.equal(applyBalance(s, okFr(10), { warn: 5, critical: 1 }, NOW + 1), 'recovered')
  assert.equal(s.pending, null, 'balance did not rise: no recovery notice')
})
test('T7 undelivered episode recovery cancels silently', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(applyBalance(s, okFr(30), TH, NOW + 1), 'recovered')
  assert.equal(s.pending, null, 'warn never delivered: nothing to recover from')
})
test('T5 prefs override config thresholds', () => {
  const s = fresh(); s.prefs = { warn: 30, critical: 8 }
  assert.deepEqual(effectiveThresholds(s, { balance: { warn: 20, critical: 5 } }), { warn: 30, critical: 8 })
})

// ---- D: delivery engine ----
await atest('D1 ok clears pending and stamps lastPushAt', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  const r = await deliverPending(s, okNotifier, {}, NOW, false, {})
  assert.equal(r.delivered, 'warn')
  assert.equal(s.pending, null)
  assert.equal(s.alert.lastPushAt, NOW)
})
await atest('D2 business failure backs off, holds after 3', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  const bad = { send: async () => ({ ok: false, status: 200, code: 93000, error: 'invalid webhook' }) }
  let t = NOW
  for (let i = 0; i < 3; i++) { await deliverPending(s, bad, {}, t, false, {}); t = s.pending.nextAt }
  assert.equal(s.pending.hold, true)
  assert.equal(s.pending.attempts, 3)
})
await atest('D3 ambiguous timeout: one extra attempt then hold unconfirmed', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  const amb = { send: async () => ({ ok: false, status: 0, error: 'abort' }) }
  await deliverPending(s, amb, {}, NOW, false, {})
  assert.equal(s.pending.ambiguous, true)
  assert.equal(s.pending.hold, false)
  await deliverPending(s, amb, {}, s.pending.nextAt, false, {})
  assert.equal(s.pending.hold, true)
  assert.ok(/送达未确认/.test(s.pending.lastError))
})
await atest('D4 unconfigured keeps pending (no loss)', async () => {
  const s = fresh(); s.webhook = { channel: 'none', url: '', secret: '' }
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(await deliverPending(s, okNotifier, {}, NOW, false, {}), null)
  assert.ok(s.pending)
})
await atest('D5 quiet defers; hold never blocks a newer transition', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(await deliverPending(s, okNotifier, {}, NOW, true, {}), null)
  assert.ok(s.pending)
  s.pending.hold = true
  applyBalance(s, okFr(3), TH, NOW + 1)
  assert.equal(s.pending.hold, false)
  assert.equal(s.pending.kind, 'critical')
})
test('D6 quiet window overnight wrap', () => {
  assert.equal(isQuietNow({ start: '23:00', end: '08:00' }, new Date('2026-11-13T00:30:00+08:00')), true)
  assert.equal(isQuietNow({ start: '23:00', end: '08:00' }, new Date('2026-11-13T12:00:00+08:00')), false)
})

// ---- F: message + card semantics ----
test('F1 titles and feishu colours', () => {
  const s = fresh(); s.balance = { value: 3, currency: 'CNY', ok: true }
  s.alert.level = 'critical'
  assert.ok(formatAlert('critical', s, TH, {}).title.includes('告急'))
  assert.equal(toFeishuCard(formatAlert('critical', s, TH, {}).title, 'x').header.template, 'red')
  assert.equal(toFeishuCard(formatAlert('warn', s, TH, {}).title, 'x').header.template, 'orange')
  assert.equal(toFeishuCard(formatAlert('recovered', s, TH, {}).title, 'x').header.template, 'green')
})
test('F2 signature short, no install link, opt-out', () => {
  assert.equal(DEFAULT_SIGNATURE, 'via 余额哨兵')
  assert.ok(!withSignature('x', {}).includes('github'))
  assert.ok(!withSignature('x', { signature: false }).includes('via'))
})

// ---- S: source chain ----
await atest('S1 no source -> no-source', async () => {
  const f = createBalanceSource({})
  assert.equal((await f()).reason, 'no-source')
})
await atest('S2 remote null -> signed-out', async () => {
  const f = createBalanceSource({ remoteGet: async () => null })
  assert.equal((await f()).reason, 'signed-out')
})
await atest('S3 remote envelope ok', async () => {
  const f = createBalanceSource({ remoteGet: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '7' }], bonusWallets: [] } }) })
  const r = await f()
  assert.equal(r.ok, true); assert.equal(r.source, 'account'); assert.equal(r.wallets[0].total, 7)
})
await atest('S4 remote failed falls back to key; 401 unauthorized', async () => {
  const f = createBalanceSource({
    remoteGet: async () => ({ status: 'failed' }),
    apiKey: 'sk-x',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.equal((await f()).reason, 'unauthorized')
})
await atest('S5 key REST ok', async () => {
  const f = createBalanceSource({
    apiKey: 'sk-x',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '6.5' }] }) }),
  })
  const r = await f()
  assert.equal(r.ok, true); assert.equal(r.source, 'key'); assert.equal(r.wallets[0].total, 6.5)
})
await atest('S6 remote throws without key -> account-error', async () => {
  const f = createBalanceSource({ remoteGet: async () => { throw new Error('boom') } })
  assert.equal((await f()).reason, 'account-error')
})

// ---- M: cross-instance merge ----
test('M1 disk authoritative for pending/prefs/webhook', () => {
  mkdirSync(join(process.env.DSH_HOME, 'balance-sentinel'), { recursive: true })
  writeFileSync(join(process.env.DSH_HOME, 'balance-sentinel', 'state.json'), JSON.stringify({
    alert: { level: 'warn', lastPushAt: 123 }, pending: null,
    webhook: { channel: 'wecom', url: 'u', secret: '' }, prefs: { warn: 30, critical: 8 },
  }))
  const s = fresh()
  s.pending = { kind: 'warn', attempts: 1 }
  mergeStateFromDisk(s)
  assert.equal(s.pending, null)
  assert.equal(s.prefs.warn, 30)
  assert.equal(s.webhook.channel, 'wecom')
  assert.equal(s.alert.lastPushAt, 123)
})

test('M2 re-entrant saveState under a held cycle lock persists', () => {
  const s = fresh()
  const rel = acquireStateLock()
  assert.ok(rel)
  s.balance = { value: 9, currency: 'CNY', ok: true, at: 't', reason: null }
  assert.equal(saveState(s), true)
  rel()
  assert.equal(loadState().balance.value, 9)
})

// ---- B: bridge ----
// M1/M2 left a disk state behind; the bridge merges disk-first by design, so
// give the bridge tests a clean slate.
rmSync(join(process.env.DSH_HOME, 'balance-sentinel', 'state.json'), { force: true })
const wait = () => new Promise((r) => setTimeout(r, 100))
const bridge = (port, state, extra = {}) => startLocalApi({ port, state, notifier: createNotifier(), config: { balance: {}, notify: {} }, save: () => true, ...extra })

await atest('B1 status masks secret, exposes balance/alert/thresholds', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'https://qyapi.weixin.qq.com/x?key=SECRET', secret: 's3cret' }
  s.balance = { value: 12.5, currency: 'CNY', ok: true, at: 't' }
  const stop = bridge(17431, s)
  await wait()
  const st = await (await fetch('http://127.0.0.1:17431/status')).json()
  assert.equal(st.configured, true)
  assert.equal(st.urlHost, 'qyapi.weixin.qq.com')
  assert.ok(!JSON.stringify(st).includes('SECRET') && !JSON.stringify(st).includes('s3cret'))
  assert.equal(st.balance.value, 12.5)
  assert.deepEqual(st.thresholds, { warn: 20, critical: 5 })
  stop()
})
await atest('B2 cross-site denied, shell origin accepted', async () => {
  const s = fresh(); s.webhook = { channel: 'none', url: '', secret: '' }
  const stop = bridge(17432, s)
  await wait()
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 17432, path: '/webhook', method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject); req.end('{"channel":"generic","url":"https://evil.example/h"}')
  })
  assert.equal(await raw({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }), 403)
  assert.equal(await raw({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }), 403)
  assert.equal(await raw({ 'Content-Type': 'application/json', Origin: 'dsh-app://app', 'Sec-Fetch-Site': 'cross-site' }), 200)
  stop()
})
await atest('B3 webhook validation + first-connect current supplement', async () => {
  const s = fresh(); s.webhook = { channel: 'none', url: '', secret: '' }
  s.alert.level = 'warn'
  const stop = bridge(17433, s)
  await wait()
  const post = (b) => fetch('http://127.0.0.1:17433/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
  assert.equal((await post({ channel: 'nope', url: 'https://x.y' })).code, 'bad-channel')
  assert.equal((await post({ channel: 'feishu', url: 'ftp://x.y' })).code, 'bad-url')
  const j = await post({ channel: 'wecom', url: 'https://qyapi.weixin.qq.com/x' })
  assert.equal(j.ok, true)
  assert.equal(s.pending.kind, 'current', 'first connect while alerting supplements one current-state notice')
  stop()
})
await atest('B4 prefs validation + save cancels recovered + pokes', async () => {
  const s = fresh()
  let pokes = 0
  const stop = bridge(17434, s, { poke: () => { pokes++ } })
  await wait()
  const post = (b) => fetch('http://127.0.0.1:17434/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
  assert.equal((await post({ warn: 5, critical: 20 })).code, 'bad-thresholds')
  assert.equal((await post({ warn: -1, critical: 2 })).code, 'bad-thresholds')
  s.pending = { kind: 'recovered', attempts: 0, hold: false, ambiguous: false, nextAt: 9e15, lastError: null }
  const j = await post({ warn: 30, critical: 8 })
  assert.equal(j.ok, true)
  assert.deepEqual(j.thresholds, { warn: 30, critical: 8 })
  assert.equal(s.pending, null, 'threshold save cancels queued recovery')
  assert.ok(pokes >= 1, 'monitor poked for immediate re-evaluation')
  stop()
})
await atest('B5 alert retry resets hold; no-pending rejected', async () => {
  const s = fresh()
  s.pending = { kind: 'warn', attempts: 3, hold: true, ambiguous: false, nextAt: 9e15, lastError: 'x' }
  const stop = bridge(17435, s)
  await wait()
  const j = await (await fetch('http://127.0.0.1:17435/alert/retry', { method: 'POST' })).json()
  assert.equal(j.ok, true)
  assert.equal(s.pending.hold, false)
  assert.equal(s.pending.attempts, 0)
  s.pending = null
  const j2 = await (await fetch('http://127.0.0.1:17435/alert/retry', { method: 'POST' })).json()
  assert.equal(j2.code, 'no-pending')
  stop()
})
await atest('B6 test-push reaches webhook', async () => {
  const received = []
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"errcode":0}') })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  const s = fresh(); s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:' + hook.address().port, secret: '' }
  const stop = bridge(17436, s)
  await wait()
  const j = await (await fetch('http://127.0.0.1:17436/test-push', { method: 'POST' })).json()
  assert.equal(j.ok, true)
  assert.ok(received.length >= 1)
  stop(); await new Promise((r) => hook.close(r))
})

// ---- W: wecom chunking still within platform cap ----
await atest('W1 wecom 8000B chunks each <=4096B', async () => {
  const received = []
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"errcode":0}') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const n = createNotifier()
  const text = ('中文测试内容ABCDEF\n'.repeat(600)).slice(0, 8000)
  const r = await n.send({ channel: 'wecom', url: 'http://127.0.0.1:' + srv.address().port }, '标题', text)
  assert.ok(r.chunks >= 2)
  for (const x of received) assert.ok(Buffer.byteLength(x.markdown.content, 'utf8') <= 4096)
  await new Promise((r) => srv.close(r))
})
test('W2 chunkContent UTF-8 safe', () => {
  const text = '中'.repeat(2000)
  const c = chunkContent(text, 3900, 'bytes')
  assert.equal(c.join(''), text)
})

// ---- T8: poke makes saves take effect now, not next interval ----
await atest('T8 poke re-evaluates immediately', async () => {
  let cycles = 0
  const ctl = startMonitor({
    fetchBalance: async () => okFr(10), state: fresh(), notifier: okNotifier,
    config: { balance: { pollSeconds: 3600 } }, save: () => true,
    onCycle: () => { cycles++ },
  })
  ctl.poke()
  await new Promise((r) => setTimeout(r, 700))
  assert.ok(cycles >= 1, 'poke ran a cycle')
  const before = cycles
  ctl.poke()
  await new Promise((r) => setTimeout(r, 700))
  assert.ok(cycles > before, 'second poke ran another cycle')
  ctl.stop()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100).unref()