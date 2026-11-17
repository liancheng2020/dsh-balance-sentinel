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
  assert.equal(s.pending.cause, 'topup')
  assert.equal(s.pending.nextAt, NOW + RECOVERY_COOLDOWN_MS)
})
test('T4 fetch failure never changes level', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(applyBalance(s, { ok: false, reason: 'network' }, TH, NOW + 1), null)
  assert.equal(s.alert.level, 'warn')
  assert.equal(s.balance.reason, 'network')
})
test('T6 threshold-driven recovery of delivered episode notifies now', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  s.alert.lastPushAt = NOW // delivered warn
  assert.equal(applyBalance(s, okFr(10), { warn: 5, critical: 1 }, NOW + 1), 'recovered')
  assert.equal(s.pending.kind, 'recovered')
  assert.equal(s.pending.cause, 'threshold')
  assert.equal(s.pending.nextAt, NOW + 1, 'user-initiated closure: no cooldown')
})
test('T9 threshold-driven recovery undelivered cancels silently', () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(applyBalance(s, okFr(10), { warn: 5, critical: 1 }, NOW + 1), 'recovered')
  assert.equal(s.pending, null, 'warn never delivered: nothing to close')
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
await atest('D3 uncertain delivery holds immediately, no auto re-send', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  let calls = 0
  const amb = { send: async () => { calls++; return { ok: false, status: 0, timeout: true, retryable: false, error: 'abort' } } }
  const r = await deliverPending(s, amb, {}, NOW, false, {})
  assert.equal(r.hold, true)
  assert.equal(s.pending.hold, true)
  assert.equal(s.pending.ambiguous, true)
  assert.ok(/送达未确认/.test(s.pending.lastError))
  assert.equal(await deliverPending(s, amb, {}, NOW + 60 * 60 * 1000, false, {}), null)
  assert.equal(calls, 1, 'held pending never auto re-sends')
})
await atest('D7 body timeout after HTTP 200: uncertain, no re-send', async () => {
  const n = createNotifier({
    timeoutMs: 50,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: () => new Promise((_, rej) => setTimeout(() => rej(new Error('socket hang up')), 80)) }),
  })
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  const r = await deliverPending(s, n, {}, NOW, false, {})
  assert.equal(r.hold, true, 'HTTP 200 + dead body must not be treated as retryable')
  assert.equal(s.pending.attempts, 1)
  assert.ok(/送达未确认/.test(s.pending.lastError))
})
await atest('D8 rate limit (429) is not auto-retried', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  const lim = { send: async () => ({ ok: false, status: 429, timeout: false, retryable: false, error: 'HTTP 429' }) }
  const r = await deliverPending(s, lim, {}, NOW, false, {})
  assert.equal(r.hold, true)
  assert.equal(s.pending.hold, true)
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
  assert.equal(toFeishuCard(formatAlert('recovered', s, TH, {}, 'threshold').title, 'x').header.template, 'green')
})
test('F3 resolved notice explains threshold cause', () => {
  const s = fresh(); s.balance = { value: 10, currency: 'CNY', ok: true }
  const r = formatAlert('recovered', s, TH, {}, 'threshold')
  assert.ok(r.title.includes('解除'))
  assert.ok(r.text.includes('解除原因：阈值调整'))
  const top = formatAlert('recovered', s, TH, {}, 'topup')
  assert.ok(top.title.includes('已恢复'))
  assert.ok(!top.text.includes('解除原因'))
})
test('F2 signature carries install entry, opt-out', () => {
  assert.ok(DEFAULT_SIGNATURE.includes('github:liancheng2020/dsh-balance-sentinel'))
  assert.ok(withSignature('x', {}).endsWith(DEFAULT_SIGNATURE))
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
await atest('S7 direct ready object keeps bonusWallets', async () => {
  const f = createBalanceSource({ remoteGet: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '10.5' }], bonusWallets: [{ currency: 'CNY', balance: '2' }] }) })
  const r = await f()
  assert.equal(r.ok, true)
  assert.equal(r.wallets[0].total, 12.5, 'bonus must not be lost without envelope')
})
await atest('S8 envelope wallet-array keeps top-level bonusWallets', async () => {
  const f = createBalanceSource({ remoteGet: async () => ({ ok: true, value: [{ currency: 'CNY', balance: '7' }], bonusWallets: [{ currency: 'CNY', balance: '1.5' }] }) })
  const r = await f()
  assert.equal(r.ok, true)
  assert.equal(r.wallets[0].total, 8.5)
})
await atest('S9 never-returning host promise: deadline wins, monitor keeps cycling', async () => {
  const src = createBalanceSource({ remoteGet: () => new Promise(() => {}), timeoutMs: 40 })
  const t0 = Date.now()
  const r = await src()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'account-error')
  assert.ok(Date.now() - t0 < 2000, 'host promise may hang, the query may not')
  let cycles = 0
  const ctl = startMonitor({ fetchBalance: src, state: fresh(), notifier: okNotifier, config: { balance: { pollSeconds: 3600 } }, save: () => true, onCycle: () => { cycles++ } })
  ctl.poke()
  await new Promise((r2) => setTimeout(r2, 400))
  ctl.poke()
  await new Promise((r2) => setTimeout(r2, 400))
  assert.ok(cycles >= 2, 'monitor not wedged by hanging host')
  ctl.stop()
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
await atest('B4 prefs validation + save keeps queued recovery + pokes', async () => {
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
  assert.equal(s.pending.kind, 'recovered', 'queued recovery survives threshold save')
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

// ---- M3-M6: fault injection / interleaving (local only, no real webhooks) ----
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

await atest('M3 save failure: keeps cycling, delivered alert never re-sent', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  assert.equal(saveState(s), true) // disk carries the pending warn
  let sends = 0, cycles = 0, failSave = true
  const ctl = startMonitor({
    fetchBalance: async () => okFr(10), state: s,
    notifier: { send: async () => { sends++; return { ok: true, chunks: 1 } } },
    config: { balance: { pollSeconds: 3600 } },
    save: () => (failSave ? false : saveState(s)),
    onCycle: () => { cycles++ },
  })
  for (let i = 0; i < 3; i++) { ctl.poke(); await pause(400) }
  assert.equal(sends, 1, 'delivered once despite failing saves')
  assert.ok(cycles >= 3, 'scheduler survived save failures')
  failSave = false
  ctl.poke(); await pause(400)
  ctl.poke(); await pause(400)
  assert.equal(sends, 1, 'no duplicate after the mark clears on a successful save')
  assert.equal(loadState().pending, null)
  ctl.stop()
})

await atest('M4 prefs save during send: pending untouched, both writes land', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  saveState(s)
  let openSend
  const sent = new Promise((r) => { openSend = r })
  let sendStarted
  const gate = new Promise((r) => { sendStarted = r })
  const ctl = startMonitor({
    fetchBalance: async () => okFr(10), state: s,
    notifier: { send: () => { sendStarted(); return sent.then(() => ({ ok: true, chunks: 1 })) } },
    config: { balance: { pollSeconds: 3600 } },
    save: (st, own) => saveState(st, null, { own }),
  })
  const stop = bridge(17441, s, { save: (st, own) => saveState(st, null, { own }) })
  await wait()
  ctl.poke()
  await gate
  const j = await (await fetch('http://127.0.0.1:17441/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warn: 30, critical: 8 }) })).json()
  assert.equal(j.ok, true, 'config save must succeed mid-delivery')
  assert.equal(loadState().pending.kind, 'warn', 'disk pending not overwritten mid-send')
  assert.equal(s.pending.kind, 'warn', 'shared pending not overwritten mid-send')
  openSend()
  await pause(300)
  assert.equal(s.pending, null)
  const disk = loadState()
  assert.equal(disk.pending, null, 'delivery cleared pending')
  assert.equal(disk.prefs.warn, 30, 'prefs survived the runtime write')
  ctl.stop(); stop()
})

await atest('M5 manual retry during send refused; bridge usable after cycle', async () => {
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  saveState(s)
  let openSend
  const sent = new Promise((r) => { openSend = r })
  let sendStarted
  const gate = new Promise((r) => { sendStarted = r })
  const ctl = startMonitor({
    fetchBalance: async () => okFr(10), state: s,
    notifier: { send: () => { sendStarted(); return sent.then(() => ({ ok: true, chunks: 1 })) } },
    config: { balance: { pollSeconds: 3600 } },
    save: (st, own) => saveState(st, null, { own }),
  })
  const stop = bridge(17442, s, { save: (st, own) => saveState(st, null, { own }) })
  await wait()
  ctl.poke()
  await gate
  const r1 = await (await fetch('http://127.0.0.1:17442/alert/retry', { method: 'POST' })).json()
  assert.equal(r1.code, 'busy', 'retry must not reset the in-flight pending')
  assert.equal(loadState().pending.kind, 'warn')
  openSend()
  await pause(300)
  const r2 = await (await fetch('http://127.0.0.1:17442/alert/retry', { method: 'POST' })).json()
  assert.equal(r2.code, 'no-pending', 'after the cycle the bridge answers normally')
  ctl.stop(); stop()
})

await atest('M6 fetch throw does not wedge the scheduler', async () => {
  let n = 0, cycles = 0, errors = 0
  const ctl = startMonitor({
    fetchBalance: async () => { n++; if (n === 1) throw new Error('boom'); return okFr(10) },
    state: fresh(), notifier: okNotifier, config: { balance: { pollSeconds: 3600 } },
    save: () => true, onCycle: (r) => { cycles++; if (r.error) errors++ },
  })
  ctl.poke(); await pause(400)
  ctl.poke(); await pause(400)
  assert.ok(errors >= 1, 'first cycle reported the throw')
  assert.ok(cycles >= 2, 'second cycle still ran')
  ctl.stop()
})

await atest('M7 first-transition save failure: one send across polls/restart/instances, escalation still sends', async () => {
  const s = fresh()
  assert.equal(saveState(s), true) // disk: normal, pending null
  let cur = 10
  const sends = []
  let failSave = true
  const mk = (st) => startMonitor({
    fetchBalance: async () => okFr(cur), state: st,
    notifier: { send: async (_wh, title) => { sends.push(title); return { ok: true, chunks: 1 } } },
    config: { balance: { pollSeconds: 3600 } },
    save: () => (failSave ? false : saveState(st)),
  })
  const a = mk(s)
  a.poke(); await pause(400) // normal -> warn, delivered, save fails
  a.poke(); await pause(400) // stale disk must not re-create the alert
  assert.equal(sends.length, 1, 'first transition delivered exactly once')
  const b = mk(loadState()) // second instance / restart, disk still normal
  b.poke(); await pause(400)
  assert.equal(sends.length, 1, 'receipt heals another instance too')
  failSave = false
  b.poke(); await pause(400) // heal + successful save clears the receipt
  assert.equal(sends.length, 1)
  assert.equal(loadState().alert.level, 'warn')
  cur = 3
  b.poke(); await pause(400) // genuinely newer transition must still send
  assert.equal(sends.length, 2)
  assert.ok(/告急/.test(sends[1]), 'escalation delivered')
  a.stop(); b.stop()
})

await atest('M8 ambiguous send + failed save: hold survives re-poll/restart/other instance, never marked sent', async () => {
  const s = fresh()
  assert.equal(saveState(s), true) // disk: normal, nothing pending
  let cur = 10
  let failSave = true
  let mode = 'ambiguous'
  const sends = []
  const notifier = {
    send: async (_wh, title) => {
      sends.push(title)
      return mode === 'ambiguous'
        ? { ok: false, status: 0, timeout: true, retryable: false, error: 'timeout' }
        : { ok: true, chunks: 1 }
    },
  }
  const mk = (st) => startMonitor({
    fetchBalance: async () => okFr(cur), state: st, notifier,
    config: { balance: { pollSeconds: 3600 } },
    save: () => (failSave ? false : saveState(st)),
  })
  const a = mk(s)
  a.poke(); await pause(400) // normal -> warn: send times out, save fails
  assert.equal(sends.length, 1)
  assert.equal(s.pending.hold, true)
  assert.equal(s.pending.ambiguous, true)
  assert.equal(s.alert.lastPushAt, 0, 'an unconfirmed push is never stamped as delivered')
  a.poke(); await pause(400) // same process re-poll over the stale disk state
  assert.equal(sends.length, 1, 're-poll must not auto re-send')
  a.stop()

  const r1 = loadState()
  assert.equal(r1.alert.level, 'normal', 'disk really is behind the transition')
  assert.equal(r1.pending, null)
  const b = mk(r1)
  b.poke(); await pause(400) // restart: fresh loadState over the same stale disk
  assert.equal(sends.length, 1, 'restart must not auto re-send')
  assert.equal(r1.pending.hold, true)
  assert.equal(r1.pending.ambiguous, true)
  assert.equal(r1.alert.level, 'warn', 'the restored hold also restores the level it belongs to')
  assert.equal(r1.alert.lastPushAt, 0, 'recovery still does not claim delivery')
  b.stop()

  const c = mk(loadState()) // another instance taking over the same DSH_HOME
  c.poke(); await pause(400)
  assert.equal(sends.length, 1, 'another instance must not auto re-send')
  c.stop()

  cur = 3; mode = 'ok' // a genuinely newer level must still go out
  const d = mk(loadState())
  d.poke(); await pause(400)
  assert.equal(sends.length, 2, 'escalation still sends')
  assert.ok(/告急/.test(sends[1]), 'escalation is the critical notice')
  d.poke(); await pause(400)
  assert.equal(sends.length, 2, 'the delivered escalation is not re-sent either')
  d.stop()
})

await atest('M9 manual retry of a held ambiguous alert sends exactly once', async () => {
  rmSync(join(process.env.DSH_HOME, 'balance-sentinel', 'delivery-receipt.json'), { force: true }) // M8 leaves a delivered note
  const s = fresh()
  applyBalance(s, okFr(10), TH, NOW)
  await deliverPending(s, { send: async () => ({ ok: false, status: 0, timeout: true, retryable: false, error: 'timeout' }) }, {}, NOW, false, {})
  assert.equal(s.pending.hold, true)
  assert.equal(saveState(s), true) // disk carries the held, unconfirmed pending

  const st = loadState()
  const sends = []
  const ctl = startMonitor({
    fetchBalance: async () => okFr(10), state: st,
    notifier: { send: async (_wh, title) => { sends.push(title); return { ok: true, chunks: 1 } } },
    config: { balance: { pollSeconds: 3600 } },
    save: (x) => saveState(x),
  })
  const stop = bridge(17443, st, { save: (tx, own) => saveState(tx, null, { own }) })
  await wait()
  ctl.poke(); await pause(400)
  assert.equal(sends.length, 0, 'a held ambiguous alert never auto-sends')
  const j = await (await fetch('http://127.0.0.1:17443/alert/retry', { method: 'POST' })).json()
  assert.equal(j.ok, true)
  ctl.poke(); await pause(400) // panel poke after the human retry
  assert.equal(sends.length, 1, 'the confirmed retry is delivered once')
  assert.equal(loadState().pending, null)
  assert.ok(st.alert.lastPushAt > 0, 'only a confirmed send stamps lastPushAt')
  ctl.stop(); stop()
})

await atest('M10 state + fallback receipt both unwritable: risk is surfaced, dedup not claimed', async () => {
  const s = fresh()
  assert.equal(saveState(s), true)
  const blocker = join(process.env.DSH_HOME, 'balance-sentinel', 'delivery-receipt.json')
  rmSync(blocker, { force: true, recursive: true }) // start from a clean, note-free home
  mkdirSync(blocker) // a directory here makes every fallback-receipt write fail
  const logs = []
  const logger = { warn: (m) => logs.push(String(m)), info: () => {}, debug: () => {} }
  let sends = 0
  const ctl = startMonitor({
    fetchBalance: async () => okFr(10), state: s,
    notifier: { send: async () => { sends++; return { ok: false, status: 0, timeout: true, retryable: false, error: 'timeout' } } },
    config: { balance: { pollSeconds: 3600 } },
    save: () => false, logger,
  })
  ctl.poke(); await pause(400)
  assert.equal(sends, 1)
  assert.ok(logs.some((m) => /去重无法保证/.test(m)), 'the duplicate risk is logged, not silently assumed away')
  ctl.poke(); await pause(400) // nothing on disk records the attempt
  assert.equal(sends, 2, 'without any writable record the alert is re-sent — the documented limit')
  ctl.stop()
  rmSync(blocker, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100).unref()