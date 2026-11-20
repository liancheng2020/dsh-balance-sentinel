// Host-side self-test. No framework — plain node:assert + local fake webhooks.
// Covers the reliability gate: transition dedup, recovery cooldown, quiet
// merge, classified retries (business / ambiguous / hold), cross-instance
// merge, bridge origin gate + masking + prefs validation, source chain.

import assert from 'node:assert'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'sentinel-selftest-'))

const { normalizeWallets, pickPrimary, levelOf, effectiveThresholds, thresholdsMisconfigured, applyBalance, deliverPending, formatAlert, createBalanceSource, startMonitor, RECOVERY_COOLDOWN_MS } = await import('../lib/balance.js')
const { mergeStateFromDisk, acquireStateLock, saveState, loadState, webhookFingerprint } = await import('../lib/state.js')
const { createNotifier, chunkContent, withSignature, signatureEnabled, effectiveNotify, toFeishuCard, toPlainText } = await import('../lib/notify.js')
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
// The panel refuses warn < critical, but the YAML cannot: warn: 5 / critical: 20
// used to load as-is and classify balance 10 as critical. The merged pair is
// normalised in effectiveThresholds — warn is the higher line, so an inverted
// pair is swapped; non-positive values fall back to the defaults. An equal pair
// cannot be repaired by swapping (balance just under the line would jump
// straight to critical, skipping warn), so it falls back to the defaults too
// and /status flags it for the panel.
test('F9 an inverted YAML threshold pair cannot reach classification', () => {
  assert.deepEqual(effectiveThresholds({ prefs: {} }, { balance: { warn: 5, critical: 20 } }), { warn: 20, critical: 5 })
  assert.equal(levelOf(10, 20, 5), 'warn', 'balance 10 must not be critical under the swapped pair')
  assert.deepEqual(effectiveThresholds({ prefs: { warn: 15, critical: 3 } }, { balance: { warn: 5, critical: 20 } }),
    { warn: 15, critical: 3 }, 'validated panel prefs still win')
  assert.deepEqual(effectiveThresholds({ prefs: { warn: 15, critical: null } }, { balance: { warn: 8, critical: 20 } }),
    { warn: 20, critical: 15 }, 'a config value filling a null must not invert the pair either')
  assert.deepEqual(effectiveThresholds(null, { balance: { warn: 0, critical: 5 } }), { warn: 20, critical: 5 },
    'non-positive values fall back to the defaults')
  // warn == critical: swapping is a no-op, so balance 9.5 would be classified
  // critical with the warn line never reachable. Fall back to the defaults and
  // flag it so the panel can tell the user the config needs fixing.
  assert.deepEqual(effectiveThresholds(null, { balance: { warn: 10, critical: 10 } }), { warn: 20, critical: 5 },
    'an equal pair falls back to the defaults')
  assert.deepEqual(effectiveThresholds({ prefs: { warn: 10, critical: 10 } }, {}), { warn: 20, critical: 5 },
    'an equal pair via panel prefs cannot exist, but the merge point still guards it')
  assert.ok(thresholdsMisconfigured(null, { balance: { warn: 10, critical: 10 } }), 'the equal pair is flagged')
  assert.ok(!thresholdsMisconfigured(null, { balance: { warn: 5, critical: 20 } }), 'an inverted pair is repaired, not flagged')
  assert.ok(!thresholdsMisconfigured({ prefs: {} }, { balance: { warn: 20, critical: 5 } }), 'a valid pair is not flagged')
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
test('F1b every alert title leads with the plugin name', () => {
  const s = fresh(); s.balance = { value: 3, currency: 'CNY', ok: true }; s.alert.level = 'critical'
  // With no footer line any more, the title is the only place a forwarded card
  // still says where it came from.
  for (const [kind, cause, word] of [['critical', undefined, '告急'], ['warn', undefined, '预警'], ['recovered', 'topup', '已恢复'], ['recovered', 'threshold', '解除']]) {
    const title = formatAlert(kind, s, TH, {}, cause).title
    assert.ok(title.startsWith('余额哨兵 · '), kind + ' title must lead with the plugin name: ' + title)
    assert.ok(title.includes(word), kind + ' title must still say ' + word + ': ' + title)
  }
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
test('F2 the footer is only ever the user\'s own text: no built-in install line', () => {
  const noFooter = (t) => !t.includes('安装：') && !t.includes('github:liancheng2020') && !t.includes('via DeepSeek')
  const s = fresh(); s.balance = { value: 3, currency: 'CNY', ok: true }; s.alert.level = 'critical'
  // 1) default (no notify config at all): the alert, the recovery notice and the
  //    test message leave with nothing appended, and a Feishu card grows no note.
  assert.ok(noFooter(formatAlert('critical', s, TH, {}).text), 'default alert must not carry a footer')
  assert.ok(noFooter(formatAlert('recovered', s, TH, {}, 'topup').text), 'default recovery must not carry one')
  assert.equal(withSignature('x', {}), 'x', 'default must not append anything')
  assert.equal(withSignature('x', { signature: true }), 'x', 'a leftover signature: true adds nothing on its own')
  assert.equal(toFeishuCard('t', withSignature('body', {})).elements.filter((e) => e.tag === 'note').length, 0,
    'no footer means no note element')
  // 2) a custom line is appended verbatim and reaches the card body as written.
  assert.equal(withSignature('x', { signatureText: '  自定义尾注  ' }), 'x\n\n自定义尾注')
  const card = JSON.stringify(toFeishuCard('t', withSignature('body', { signatureText: '自定义尾注' })))
  assert.ok(card.includes('自定义尾注'), 'the card must carry the user\'s text: ' + card)
  assert.ok(toPlainText(withSignature('body', { signatureText: '自定义尾注' })).endsWith('自定义尾注'))
  // A link in the user's own footer must keep its target when flattened: plain
  // channels have no markdown, and a label without a URL is a dead end.
  assert.equal(toPlainText('尾注：[文档](https://example.com/a)'), '尾注：文档 https://example.com/a')
  assert.equal(toPlainText('bare https://example.com/b'), 'bare https://example.com/b', 'bare URLs stay untouched')
  // 3) an explicit off wins over the text, and the old opt-in cannot re-enable it.
  assert.equal(withSignature('x', { signature: false, signatureText: '自定义尾注' }), 'x', 'explicit off must win')
  assert.equal(withSignature('x', { signature: true, signatureText: '自定义尾注' }), 'x\n\n自定义尾注',
    'the old opt-in neither adds nor removes the custom text')
  // 4) the built-in line is gone from the source, not merely switched off: no
  //    constant and no repo spec may survive to be appended again.
  const src = readFileSync(new URL('../lib/notify.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('DEFAULT_SIGNATURE') && !src.includes('INSTALL_SPEC') && !src.includes('github:liancheng2020'),
    'lib/notify.js must not ship a built-in install line')
})
// Regression: the host config store materialises schema defaults into the saved
// object, so `default(false)` made "unset" indistinguishable from an explicit
// opt-out and dropped the custom footer of every signatureText-only user.
await atest('F4 an unset signature keeps the custom footer after config parsing', async () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(/signature:\s*z\.boolean\(\)(?!\.)/.test(src), 'notify.signature must stay optional (no default)')
  assert.ok(!/signature:\s*z\.boolean\(\)\.default\(/.test(src), 'a default would be written into users\' saved config')
  let Config
  try { ({ Config } = await import('../index.js')) } catch { return console.log('SKIP  host schema package not installed') }
  const onlyText = Config({ notify: { signatureText: '自定义尾注' } })
  assert.equal(onlyText.notify.signature, undefined, 'parsing must not invent a signature value')
  assert.equal(signatureEnabled(onlyText.notify), true, 'signatureText alone must keep the footer')
  assert.equal(signatureEnabled(Config({}).notify), false, 'an untouched config stays off')
  assert.equal(signatureEnabled(Config({ notify: { signature: false, signatureText: '自定义尾注' } }).notify), false,
    'an explicit false is still honoured')
  assert.equal(signatureEnabled(Config({ notify: { signature: true } }).notify), false,
    'signature: true alone adds nothing now that the built-in line is gone')
})
test('F5 a legacy panel tick cannot turn a footer on; only its "off" survives', () => {
  // The old switch's "on" meant "append the built-in install line". That line is
  // gone, so the tick must be inert — but a recorded "off" is still the user's
  // explicit preference and keeps suppressing a custom text.
  assert.equal(signatureEnabled(effectiveNotify({}, { notify: { signature: true } })), false,
    'a stale tick must not produce a footer')
  assert.equal(signatureEnabled(effectiveNotify({ signatureText: '自定义尾注' }, { notify: { signature: true } })), true,
    'custom text is the only way in; the stale tick neither adds nor removes it')
  assert.equal(signatureEnabled(effectiveNotify({ signature: true }, { notify: { signature: false } })), false)
  assert.equal(signatureEnabled(effectiveNotify({ signatureText: 'x' }, { notify: { signature: false } })), false,
    'an explicit off beats the custom text')
  assert.equal(signatureEnabled(effectiveNotify({ signature: true }, { notify: { signature: null } })), false,
    'config signature: true no longer adds anything by itself')
  assert.equal(signatureEnabled(effectiveNotify({}, { notify: { signature: null } })), false)
  assert.equal(signatureEnabled(effectiveNotify({ signatureText: 'x' }, {})), true, 'custom text still enables')
})
// The identity fields are the only thing a Bark group list or a self-hosted
// collector sees: they must name THIS plugin, not the plugin the adapters were
// copied from.
await atest('F6 bark group and generic source identify as balance-sentinel', async () => {
  const bodies = []
  const n = createNotifier({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return { ok: true, status: 200, text: async () => '{"code":200}', headers: { get: () => 'application/json' } }
    },
  })
  await n.send({ channel: 'bark', url: 'https://api.day.app/key', secret: '' }, 't', 'body')
  await n.send({ channel: 'generic', url: 'https://hooks.example/x', secret: '' }, 't', 'body')
  assert.equal(bodies[0].group, 'balance-sentinel', 'bark group must name this plugin')
  assert.equal(bodies[1].source, 'balance-sentinel', 'generic source must name this plugin')
})

// Simulated push through the real adapters: Telegram and Bark render no markdown,
// so a link the user put in their footer must arrive as "label url" — the URL
// used to be dropped, leaving only the label in the group chat.
await atest('F7 plain-text channels keep the target of a footer link', async () => {
  const sent = []
  const n = createNotifier({
    fetchImpl: async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => '{"ok":true,"code":200}', headers: { get: () => 'application/json' } }
    },
  })
  const text = withSignature('当前余额：¥3.00', { signatureText: '用量说明：[控制台](https://platform.deepseek.com/usage)' })
  assert.ok(text.includes('[控制台](https://platform.deepseek.com/usage)'), 'precondition: the footer is a markdown link')
  await n.send({ channel: 'telegram', url: '123:ABC', secret: '42' }, '余额预警', text)
  await n.send({ channel: 'bark', url: 'https://api.day.app/k', secret: '' }, '余额预警', text)
  assert.equal(sent.length, 2)
  const flats = [sent[0].body.text, sent[1].body.body]
  for (const body of flats) {
    assert.ok(body.includes('https://platform.deepseek.com/usage'), 'the link target must survive plain text: ' + body)
    assert.ok(body.includes('控制台'), 'the label must stay readable: ' + body)
    assert.ok(!body.includes(']('), 'no markdown source may leak into a plain channel: ' + body)
  }
})

// Delivery granularity is the whole message: a footer that pushes the alert over
// a channel limit gets chunked (wecom / telegram / feishu), and a partial
// failure re-sends the chunks that already landed. The footer is therefore
// capped so every alert stays single-chunk.
test('F8 an over-long footer is truncated to one chunk', () => {
  const text = withSignature('body', { signatureText: '长'.repeat(600) })
  assert.ok(text.endsWith('…'), 'truncation must be visible')
  assert.equal(text.length, 4 + 2 + 201, 'footer capped at 200 chars plus the ellipsis: ' + text.length)
  assert.equal(chunkContent(text, 3800, 'chars').length, 1, 'telegram must take it in one piece')
  assert.equal(chunkContent(text, 3900, 'bytes').length, 1, 'wecom must take it in one piece')
  assert.equal(withSignature('x', { signatureText: '自定义尾注' }), 'x\n\n自定义尾注', 'normal footers are untouched')
  // Truncation counts code points, not UTF-16 units: a footer of astral
  // characters (emoji) must never end in a lone surrogate.
  const emojiFoot = withSignature('x', { signatureText: '😀'.repeat(120) + '字'.repeat(90) }).slice(3)
  assert.equal(Array.from(emojiFoot).length, 201, 'capped at 200 code points plus the ellipsis')
  assert.ok(emojiFoot.endsWith('字…'), 'an emoji must not be cut in half')
  // A markdown link the cap would split is omitted whole: a half-drawn
  // `[label](url` would render as literal noise in markdown channels.
  const linkFoot = withSignature('x', { signatureText: 'a'.repeat(190) + ' [文档](https://example.com/long/path)' }).slice(3)
  assert.ok(!linkFoot.includes('['), 'a split link is dropped entirely: ' + linkFoot)
  assert.ok(linkFoot.endsWith('…'), 'the rest still truncates with an ellipsis')
  const fitFoot = withSignature('x', { signatureText: 'a'.repeat(150) + ' [文档](https://example.com/p)' }).slice(3)
  assert.ok(fitFoot.includes('[文档](https://example.com/p)'), 'a link that fits survives untouched')
  const labelFoot = withSignature('x', { signatureText: 'a'.repeat(195) + ' [文档](https://example.com/long/path)' }).slice(3)
  assert.ok(!labelFoot.includes('['), 'a cut inside the label drops the link too')
  // The dropped link's start index is a code-point index; slicing the joined
  // string would count UTF-16 units again and cut the emoji right before it.
  const mixedFoot = withSignature('x', { signatureText: '😀'.repeat(190) + ' [文档](https://example.com/long/path)' }).slice(3)
  assert.ok(!mixedFoot.includes('['), 'the split link after emoji is dropped')
  assert.ok(mixedFoot.endsWith(' …'), 'the emoji right before the link stays whole')
  assert.equal(Array.from(mixedFoot.replace(/…$/, '')).length, 191, '190 emoji + the space, counted in code points')
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

// README promises "host account when signed in, otherwise the key". A signed-out
// host used to short-circuit before the key path, so a configured key never ran.
await atest('S10 signed-out host with a key falls back to the REST key', async () => {
  const urls = []
  const f = createBalanceSource({
    remoteGet: async () => null,
    apiKey: 'sk-x',
    fetchImpl: async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '9' }] }) }
    },
  })
  const r = await f()
  assert.equal(r.ok, true, 'the key must be used when the host is signed out')
  assert.equal(r.source, 'key')
  assert.equal(r.wallets[0].total, 9)
  assert.ok(urls[0].includes('api.deepseek.com'), 'fallback must hit the documented REST endpoint')
})
// When neither source can answer, the reason must describe the real blocker:
// the key was tried and rejected, not "signed out".
await atest('S11 signed-out host + rejected key reports unauthorized', async () => {
  const f = createBalanceSource({
    remoteGet: async () => null,
    apiKey: 'sk-x',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.equal((await f()).reason, 'unauthorized')
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

// ---- C: lock recovery ----
// A lock whose payload cannot be read used to block every instance forever: the
// takeover path needed a parseable stamp and gave up on a corrupt file. Only a
// lock that is BOTH unreadable AND older than the TTL may be recovered — one
// created a moment ago (still being written) and a live one must be left alone.
const lockFile = () => join(process.env.DSH_HOME, 'balance-sentinel', 'state.json.lock')
const ageFile = (p, ms) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t) }

test('C1 a corrupt lock older than the TTL is recovered', () => {
  mkdirSync(join(process.env.DSH_HOME, 'balance-sentinel'), { recursive: true })
  writeFileSync(lockFile(), '{"pid":123,') // truncated payload, no readable ts
  ageFile(lockFile(), 120000)
  const rel = acquireStateLock()
  assert.ok(rel, 'an expired unreadable lock must not block forever')
  rel()
  assert.equal(existsSync(lockFile()), false, 'our lock must be released again')
})

test('C2 a corrupt lock created just now is left alone', () => {
  writeFileSync(lockFile(), '') // the window between create and write
  assert.equal(acquireStateLock(), null, 'a lock still being written must not be stolen')
  unlinkSync(lockFile())
})

test('C3 a live lock with a fresh heartbeat is never taken over', () => {
  writeFileSync(lockFile(), JSON.stringify({ pid: 4242, ts: Date.now(), token: 'other' }))
  assert.equal(acquireStateLock(), null)
  unlinkSync(lockFile())
})

test('C4 a readable lock past the TTL is still recovered', () => {
  writeFileSync(lockFile(), JSON.stringify({ pid: 4242, ts: Date.now() - 120000, token: 'dead' }))
  const rel = acquireStateLock()
  assert.ok(rel, 'a crashed holder must not block the next cycle')
  rel()
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
  stop()
  hook.closeAllConnections?.()
  await new Promise((r) => hook.close(r))
})
// The default must leave the machine without any install link — and with the
// built-in line gone, the old `signature: true` opt-in cannot add one either.
// Assert on the body the bridge actually posts, not only on the formatter.
await atest('B6b test-push body carries no footer unless the user configured text', async () => {
  const received = []
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"errcode":0}') })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  const s = fresh(); s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:' + hook.address().port, secret: '' }
  const bodyOf = () => received.map((x) => x.markdown?.content || '').join('\n')
  const hasInstallLine = (t) => t.includes('安装：') || t.includes('github:liancheng2020')

  let stop = bridge(17444, s) // default config: notify {}
  await wait()
  await (await fetch('http://127.0.0.1:17444/test-push', { method: 'POST' })).json()
  stop()
  const off = bodyOf()
  assert.ok(off.includes('测试消息'), 'the test message itself must still be sent: ' + off)
  assert.ok(!hasInstallLine(off), 'default test push must not carry an install line: ' + off)

  received.length = 0
  stop = bridge(17445, s, { config: { balance: {}, notify: { signature: true } } })
  await wait()
  await (await fetch('http://127.0.0.1:17445/test-push', { method: 'POST' })).json()
  stop()
  const legacyOn = bodyOf()
  assert.ok(!hasInstallLine(legacyOn), 'a leftover signature: true must not add a footer: ' + legacyOn)

  received.length = 0
  stop = bridge(17448, s, { config: { balance: {}, notify: { signatureText: '自定义尾注' } } })
  await wait()
  await (await fetch('http://127.0.0.1:17448/test-push', { method: 'POST' })).json()
  stop()
  const custom = bodyOf()
  assert.ok(custom.endsWith('自定义尾注'), 'the user\'s own text must be sent: ' + custom)

  hook.closeAllConnections?.()
  await new Promise((r) => hook.close(r))
})
// The switch is gone and its endpoint with it: nothing may flip a footer back on.
// A legacy "off" left in state still suppresses a custom text, all the way to the
// wire — that is the one part of the old switch that is deliberately kept.
await atest('B6c the removed switch is unreachable; a legacy off still suppresses the footer', async () => {
  const received = []
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"errcode":0}') })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:' + hook.address().port, secret: '' }
  s.notify = { signature: true } // what an old build recorded when the box was ticked
  const cfg = { config: { balance: {}, notify: { signatureText: '自定义尾注' } } }
  const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then((r) => r.json())
  const status = (port) => fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json())
  const bodyOf = () => received.map((x) => x.markdown?.content || '').join('\n')

  let stop = bridge(17446, s, cfg)
  await wait()
  assert.equal((await status(17446)).signature, true, 'the custom text is the footer, with or without the stale tick')
  const res = await fetch('http://127.0.0.1:17446/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature: false }),
  })
  assert.equal(res.status, 404, 'the footer switch endpoint must be gone')
  received.length = 0
  await post(17446, '/test-push')
  assert.ok(bodyOf().includes('自定义尾注'), 'the custom footer must still be sent: ' + bodyOf())
  stop()

  s.notify = { signature: false } // an explicit opt-out recorded by the old panel
  stop = bridge(17447, s, cfg)
  await wait()
  assert.equal((await status(17447)).signature, false, 'a legacy off must report off')
  received.length = 0
  await post(17447, '/test-push')
  assert.ok(!bodyOf().includes('自定义尾注'), 'a legacy off must suppress the custom text: ' + bodyOf())
  stop()

  hook.closeAllConnections?.()
  await new Promise((r) => hook.close(r))
})

// ---- V: configured != connected (test result is remembered, and invalidated) ----
await atest('B7 test-push records the result; a new webhook clears it', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  const stop = bridge(17437, s, { notifier: { send: async () => ({ ok: true, chunks: 1, status: 200 }) } })
  await wait()
  await (await fetch('http://127.0.0.1:17437/test-push', { method: 'POST' })).json()
  let st = await (await fetch('http://127.0.0.1:17437/status')).json()
  assert.equal(st.verify.ok, true, 'a delivered test must be recorded')
  assert.equal(st.verify.channel, 'wecom')
  // Re-saving the same webhook must keep the result: a no-op edit is not a
  // re-test, and blanking it would flash "untested" for an unchanged endpoint.
  const same = await (await fetch('http://127.0.0.1:17437/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'wecom', url: 'http://127.0.0.1:1/a' }),
  })).json()
  assert.equal(same.verify?.ok, true, 'unchanged webhook keeps its test result')
  // Repointing the webhook must invalidate the old "verified": otherwise the
  // panel keeps claiming delivery for an endpoint that was never tested.
  const w = await (await fetch('http://127.0.0.1:17437/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'wecom', url: 'http://127.0.0.1:1/b' }),
  })).json()
  assert.equal(w.ok, true)
  st = await (await fetch('http://127.0.0.1:17437/status')).json()
  assert.equal(st.verify, null, 'editing the webhook must drop the stale test result')
  stop()
})
await atest('B8 failed test-push records ok:false with the reason', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  const stop = bridge(17438, s, {
    notifier: { send: async () => ({ ok: false, chunks: 1, status: 200, code: 93000, error: 'invalid webhook' }) },
  })
  await wait()
  await (await fetch('http://127.0.0.1:17438/test-push', { method: 'POST' })).json()
  const st = await (await fetch('http://127.0.0.1:17438/status')).json()
  assert.equal(st.verify.ok, false)
  assert.ok(String(st.verify.error).includes('invalid webhook'))
  stop()
})
await atest('B9 a verdict is pinned to the tested webhook; a repoint discards it', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  let release
  const gate = new Promise((r) => { release = r })
  const stop = bridge(17439, s, { notifier: { send: async () => { await gate; return { ok: true, chunks: 1, status: 200 } } } })
  await wait()
  // Start testing A, then have another page save B while A's send is in flight.
  const pending = fetch('http://127.0.0.1:17439/test-push', { method: 'POST' }).then((r) => r.json())
  await wait()
  const w = await (await fetch('http://127.0.0.1:17439/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'wecom', url: 'http://127.0.0.1:1/b' }),
  })).json()
  assert.equal(w.ok, true)
  release()
  const j = await pending
  assert.equal(j.stale, true, 'a verdict for a replaced webhook must be flagged stale')
  const st = await (await fetch('http://127.0.0.1:17439/status')).json()
  assert.equal(st.verify, null, "A's success must never certify B")
  stop()
})
await atest('B10 failed test beats an older success even when the save fails', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  s.verify = { at: 1, ok: true, channel: 'wecom', error: null, fp: 'old', persisted: true }
  const stop = bridge(17440, s, {
    save: () => false, // state file locked / unwritable
    notifier: { send: async () => ({ ok: false, chunks: 1, status: 200, code: 93000, error: 'invalid webhook' }) },
  })
  await wait()
  const j = await (await fetch('http://127.0.0.1:17440/test-push', { method: 'POST' })).json()
  assert.equal(j.ok, false)
  assert.equal(j.persisted, false, 'the response must admit the result was not written')
  const st = await (await fetch('http://127.0.0.1:17440/status')).json()
  assert.equal(st.verify.ok, false, 'the previous green success must not survive a failed test')
  assert.equal(st.verify.persisted, false, 'the panel must know it was not persisted')
  stop()
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
  // Keep-alive sockets would make close() wait out keepAliveTimeout (5s on node
  // 18), which tripped the per-test watchdog on CI. Drop them before closing.
  srv.closeAllConnections?.()
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

// Two instances answer out of order (slow first query, fast second one). The
// late reply was issued before the newer reading, so it must be dropped whole:
// no rollback of balance, no level change, no push.
await atest('R1 an out-of-order reply cannot roll the balance back or push', async () => {
  const dir = join(process.env.DSH_HOME, 'balance-sentinel')
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'state.json.lock'), { force: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    webhook: { channel: 'generic', url: 'http://x', secret: '' },
    alert: { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 },
    pending: null, balance: { value: null, currency: null, at: null, ok: false, reason: null },
    lastResult: { at: null, ok: false, error: null },
  }))
  const a = loadState()
  const b = loadState()
  const sends = []
  const mk = (st, total, delay) => startMonitor({
    fetchBalance: () => new Promise((r) => setTimeout(() => r(okFr(total)), delay)),
    state: st,
    notifier: { send: async (_wh, title) => { sends.push(title); return { ok: true, chunks: 1 } } },
    config: { balance: { pollSeconds: 3600 } },
    save: (st2) => saveState(st2),
  })
  const older = mk(a, 8, 260)  // issued first, answers last
  const newer = mk(b, 30, 60)  // issued later, answers first
  older.poke()
  await pause(70)
  newer.poke()
  await pause(900)
  assert.deepEqual(sends, [], 'a superseded reading must not push')
  const disk = loadState()
  assert.equal(disk.balance.value, 30, 'the newer reading must win: ' + JSON.stringify(disk.balance))
  assert.equal(disk.alert.level, 'normal', 'the stale reading must not change the level')
  older.stop(); newer.stop()
})

// Dropping a reply must not take the scheduler with it: the early exit used to
// skip the tail that re-arms the timer, so that instance stopped polling until
// something poked it again. The 1s floor (test-only env, production is 60s) lets
// the automatic next cycle happen inside the test.
await atest('R1b a superseded reply still leaves the next poll armed', async () => {
  process.env.SENTINEL_POLL_FLOOR_SEC = '1'
  const dir = join(process.env.DSH_HOME, 'balance-sentinel')
  const mon = []
  try {
    mkdirSync(dir, { recursive: true })
    rmSync(join(dir, 'state.json.lock'), { force: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      webhook: { channel: 'generic', url: 'http://x', secret: '' },
      alert: { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 },
      pending: null, balance: { value: null, currency: null, at: null, ok: false, reason: null },
      lastResult: { at: null, ok: false, error: null },
    }))
    const a = loadState()
    const callsA = []
    const ctlA = startMonitor({
      fetchBalance: () => { callsA.push(1); return new Promise((r) => setTimeout(() => r(okFr(3)), 240)) },
      state: a,
      notifier: { send: async () => ({ ok: true, chunks: 1 }) },
      config: { balance: { pollSeconds: 1 } },
      save: (st) => saveState(st),
    })
    const b = loadState()
    const ctlB = startMonitor({
      fetchBalance: () => new Promise((r) => setTimeout(() => r(okFr(30)), 40)),
      state: b,
      notifier: { send: async () => ({ ok: true, chunks: 1 }) },
      config: { balance: { pollSeconds: 1 } },
      save: (st) => saveState(st),
    })
    mon.push(ctlA, ctlB)
    ctlA.poke()          // issued first, answers last -> superseded
    await pause(70)
    ctlB.poke()          // issued later, answers first -> recorded
    await pause(1700)    // long enough for the 1s automatic re-arm to fire once
    assert.ok(callsA.length >= 2, 'the dropped cycle must still re-arm the poll (calls: ' + callsA.length + ')')
  } finally {
    for (const c of mon) c.stop()
    delete process.env.SENTINEL_POLL_FLOOR_SEC
  }
})

// Same-millisecond ties: the stamp has millisecond resolution, so two instances
// can issue their queries at the same instant and neither is "older". The
// already-accepted reading must stand — otherwise ¥3 recorded after ¥30 rolls the
// balance back and alerts again.
await atest('R1c a same-millisecond reply cannot roll an accepted balance back', async () => {
  const dir = join(process.env.DSH_HOME, 'balance-sentinel')
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'state.json.lock'), { force: true })
  const fixed = Date.now()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    webhook: { channel: 'generic', url: 'http://x', secret: '' },
    alert: { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 },
    pending: null,
    balance: { value: 30, currency: 'CNY', at: new Date(fixed - 1000).toISOString(), ok: true, reason: null },
    lastResult: { at: new Date(fixed).toISOString(), ok: true, error: null },
  }))
  const s = loadState()
  const sends = []
  const cycles = []
  const realNow = Date.now
  let ctl
  try {
    // Pin this cycle to the exact millisecond the recorded reading carries.
    Date.now = () => fixed
    ctl = startMonitor({
      fetchBalance: async () => okFr(3),
      state: s,
      notifier: { send: async (_wh, title) => { sends.push(title); return { ok: true, chunks: 1 } } },
      config: { balance: { pollSeconds: 3600 } },
      save: (st) => saveState(st),
      onCycle: (r) => cycles.push(r),
    })
    ctl.poke()
    await pause(500)
  } finally {
    Date.now = realNow
    ctl?.stop()
  }
  assert.deepEqual(sends, [], 'a tie must not push')
  const disk = loadState()
  assert.equal(disk.balance.value, 30, 'the accepted balance must not roll back: ' + JSON.stringify(disk.balance))
  assert.equal(disk.alert.level, 'normal', 'a tie must not change the level')
  assert.ok(cycles.some((r) => r.stale), 'the cycle must report a superseded reading')
})

// Stopping while the balance call is in flight: the answer arrives after stop
// and must be ignored, not delivered.
await atest('R2 stopping mid-query never sends the late answer', async () => {
  const dir = join(process.env.DSH_HOME, 'balance-sentinel')
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'state.json.lock'), { force: true })
  const s = loadState()
  s.webhook = { channel: 'generic', url: 'http://x', secret: '' }
  s.alert = { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 }
  s.balance = { value: null, currency: null, at: null, ok: false, reason: null }
  s.lastResult = { at: null, ok: false, error: null }
  s.pending = null
  saveState(s)
  let answer
  let started
  const gate = new Promise((r) => { started = r })
  let sends = 0
  const ctl = startMonitor({
    fetchBalance: () => { started(); return new Promise((r) => { answer = r }) },
    state: s,
    notifier: { send: async () => { sends++; return { ok: true, chunks: 1 } } },
    config: { balance: { pollSeconds: 3600 } },
    save: (st) => saveState(st),
  })
  ctl.poke()
  await gate      // the cycle is now waiting on the balance source
  ctl.stop()
  answer(okFr(10)) // low balance: would transition to warn and push
  await pause(300)
  assert.equal(sends, 0, 'a stopped monitor must not push what an old query returned')
  assert.equal(loadState().balance.value, null, 'nothing may be recorded after stop')
})

// A failed poll leaves the last known value in state.balance. That number must
// not be presented as the current balance: the alert waits for a real reading.
await atest('R3 a failed poll holds the pending alert until a fresh balance lands', async () => {
  const dir = join(process.env.DSH_HOME, 'balance-sentinel')
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'state.json.lock'), { force: true })
  const s = loadState()
  s.webhook = { channel: 'generic', url: 'http://x', secret: '' }
  s.alert = { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 }
  s.balance = { value: null, currency: null, at: null, ok: false, reason: null }
  s.lastResult = { at: null, ok: false, error: null }
  s.pending = null
  applyBalance(s, okFr(10), TH, NOW) // warn, pending warn
  saveState(s)
  let fail = true
  const sends = []
  const ctl = startMonitor({
    fetchBalance: async () => (fail ? { ok: false, reason: 'network' } : okFr(9)),
    state: s,
    notifier: { send: async (_wh, title) => { sends.push(title); return { ok: true, chunks: 1 } } },
    config: { balance: { pollSeconds: 3600 } },
    save: (st) => saveState(st),
  })
  ctl.poke()
  await pause(500)
  assert.equal(sends.length, 0, 'the old number must not be sent as the current balance')
  assert.ok(loadState().pending, 'the pending alert must survive the failed poll')
  fail = false
  ctl.poke()
  await pause(500)
  assert.equal(sends.length, 1, 'once a real balance is classified, the alert goes out')
  assert.equal(loadState().pending, null)
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

// Real temp state file: the disk still holds an older success while memory holds
// a failure that could not be written. A monitor cycle merges before deciding,
// and that merge used to resurrect the old green verdict.
await atest('M11 an unwritten verdict beats the older success on disk', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  s.verify = { at: 1000, ok: true, channel: 'wecom', error: null, fp: webhookFingerprint(s.webhook), persisted: true }
  assert.equal(saveState(s, undefined, { own: ['webhook', 'verify'] }), true)

  // The panel's failed test could not be written: it exists only in memory.
  s.verify = { at: 2000, ok: false, channel: 'wecom', error: 'invalid webhook', fp: webhookFingerprint(s.webhook), persisted: false }
  mergeStateFromDisk(s) // what any monitor cycle does before deciding
  assert.equal(s.verify.ok, false, 'a newer unwritten failure must survive the merge')
  assert.equal(s.verify.persisted, false, 'and must keep saying it was not persisted')
  mergeStateFromDisk(s)
  assert.equal(s.verify.ok, false, 'and stay stable across cycles')
  assert.equal(loadState().verify.ok, true, 'the file itself still holds the old success')
})
await atest('M12 a verdict dies with the config it was tested against', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  s.verify = { at: 1000, ok: true, channel: 'wecom', error: null, fp: webhookFingerprint(s.webhook), persisted: true }
  assert.equal(saveState(s, undefined, { own: ['webhook', 'verify'] }), true)

  // Another page repoints the webhook and clears the verdict on disk.
  const disk = loadState()
  disk.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/b', secret: '' }
  disk.verify = null
  assert.equal(saveState(disk, undefined, { own: ['webhook', 'verify'] }), true)

  // Memory still holds an unwritten failure produced by the OLD webhook.
  s.verify = { at: 2000, ok: false, channel: 'wecom', error: 'invalid webhook', fp: webhookFingerprint(s.webhook), persisted: false }
  mergeStateFromDisk(s)
  assert.equal(s.webhook.url, 'http://127.0.0.1:1/b', 'config comes from disk')
  assert.equal(s.verify, null, 'the old verdict must not outlive its config')
})

// End-to-end: a real monitor cycle (disk merge at the start, real saveState at
// the end) must not swap the unwritten failure back for the older success, and
// once that cycle does write it, the verdict stops claiming "not persisted".
await atest('M13 a full monitor cycle keeps the newer failed verdict and persists it', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  s.verify = { at: 1000, ok: true, channel: 'wecom', error: null, fp: webhookFingerprint(s.webhook), persisted: true }
  assert.equal(saveState(s, undefined, { own: ['webhook', 'verify'] }), true) // disk: older success

  // Panel: the new test failed AND its save failed — memory only.
  s.verify = { at: 2000, ok: false, channel: 'wecom', error: 'invalid webhook', fp: webhookFingerprint(s.webhook), persisted: false }

  const ctl = startMonitor({
    fetchBalance: async () => okFr(10),
    state: s,
    notifier: okNotifier,
    config: { balance: { pollSeconds: 3600 } },
    save: (x) => saveState(x),
  })
  ctl.poke()
  await pause(400)
  ctl.stop()

  assert.equal(s.verify.ok, false, 'the failed verdict must survive a full cycle')
  assert.notEqual(s.verify.persisted, false, 'a verdict the cycle did write is no longer unpersisted')
  assert.equal(loadState().verify.ok, false, 'the file now holds the failure')
})
await atest('M14 a cycle does not carry a verdict onto a replaced webhook', async () => {
  const s = fresh()
  s.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  s.verify = { at: 1000, ok: true, channel: 'wecom', error: null, fp: webhookFingerprint(s.webhook), persisted: true }
  assert.equal(saveState(s, undefined, { own: ['webhook', 'verify'] }), true)

  // Another page repoints the webhook on disk while memory still holds an
  // unwritten failure produced by the old one.
  const disk = loadState()
  disk.webhook = { channel: 'wecom', url: 'http://127.0.0.1:1/b', secret: '' }
  disk.verify = null
  assert.equal(saveState(disk, undefined, { own: ['webhook', 'verify'] }), true)
  s.verify = {
    at: 2000, ok: false, channel: 'wecom', error: 'invalid webhook',
    fp: webhookFingerprint({ channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }), persisted: false,
  }

  const ctl = startMonitor({
    fetchBalance: async () => okFr(10),
    state: s,
    notifier: okNotifier,
    config: { balance: { pollSeconds: 3600 } },
    save: (x) => saveState(x),
  })
  ctl.poke()
  await pause(400)
  ctl.stop()

  assert.equal(s.webhook.url, 'http://127.0.0.1:1/b', 'config comes from disk')
  assert.equal(s.verify, null, 'a verdict for the old webhook must not follow the config')
  assert.equal(loadState().verify, null, 'and it must not be written back either')
})

// The footer switch is panel-owned config: another instance must not be able to
// undo it just by saving a balance, in either direction.
await atest('M15 another instance cannot undo the footer switch', async () => {
  for (const sig of [false, true]) {
    const panel = loadState()
    panel.notify = { signature: sig }
    assert.equal(saveState(panel, undefined, { own: ['notify'] }), true, 'panel save must succeed')

    // A monitor instance that still holds the old "follow config" value and only
    // owns runtime sections.
    const monitor = loadState()
    monitor.notify = { signature: null }
    monitor.alert = { ...monitor.alert, level: sig ? 'warn' : 'critical' }
    assert.equal(saveState(monitor, undefined, { own: ['alert'] }), true)
    assert.equal(loadState().notify.signature, sig, 'a routine save must not overwrite ' + sig)

    // Read path: an idle instance with stale memory has to adopt the file's value.
    const idle = loadState()
    idle.notify = { signature: null }
    mergeStateFromDisk(idle)
    assert.equal(idle.notify.signature, sig, 'mergeStateFromDisk must adopt ' + sig)
  }
})
// A newer unwritten verdict for the OLD webhook must not win on time and then be
// thrown away, taking the file's valid record for the current webhook with it:
// filter by channel first, compare times second.
await atest('M15 a stale verdict for another webhook keeps the current record', async () => {
  const s = fresh()
  const A = { channel: 'wecom', url: 'http://127.0.0.1:1/a', secret: '' }
  const B = { channel: 'wecom', url: 'http://127.0.0.1:1/b', secret: '' }
  s.webhook = B
  s.verify = { at: 1000, ok: true, channel: 'wecom', error: null, fp: webhookFingerprint(B), persisted: true }
  assert.equal(saveState(s, undefined, { own: ['webhook', 'verify'] }), true)

  const stale = { at: 2000, ok: false, channel: 'wecom', error: 'stale', fp: webhookFingerprint(A), persisted: false }
  s.verify = { ...stale }
  mergeStateFromDisk(s)
  assert.equal(s.verify.ok, true, 'the valid record for the current webhook must win')
  assert.equal(s.verify.fp, webhookFingerprint(B))

  // The regular save path (a monitor cycle) must not change that verdict either.
  s.verify = { ...stale }
  assert.equal(saveState(s), true)
  assert.equal(s.verify.ok, true, 'a monitor-cycle save must keep the current record')
  assert.equal(loadState().verify.ok, true, 'and the file still holds it')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100).unref()