// Reproducible client self-test: minimal DOM + hooks-aware React stub render
// the real client.js and assert on output. Covers first-use flow (real balance
// or clear reason, banner, shortest path save+test), threshold validation,
// held-alert retry, bridge-down degradation, i18n.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientCode = readFileSync(join(here, '..', 'client.js'), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function createMiniReact() {
  const stores = new Map()
  let ctx = null
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false && c !== true) })
  const useState = (init) => {
    const store = ctx.store, i = ctx.idx++
    if (store.hooks.length <= i) store.hooks[i] = typeof init === 'function' ? init() : init
    // React runs a functional update during the NEXT render, not at call time.
    // Applying it eagerly here would hide a real class of bug: an updater that
    // compares against a closure variable which the caller reassigns on the very
    // next line. That is what left the threshold inputs empty in the real panel
    // while every test stayed green.
    const set = (v) => {
      if (typeof v === 'function') { store.queue.push([i, v]); return }
      store.hooks[i] = v
    }
    return [store.hooks[i], set]
  }
  // Dependency-aware: a real component re-runs an effect when deps change, and
  // several behaviors (toast auto-hide, panels reloading on refresh) depend on it.
  const useEffect = (fn, deps) => {
    const store = ctx.store, i = ctx.idx++
    const prev = store.effects[i]
    const same = prev && deps !== undefined &&
      prev.deps && prev.deps.length === deps.length && deps.every((d, k) => d === prev.deps[k])
    if (same) return
    if (prev && prev.cleanup) { try { prev.cleanup() } catch { /* ignore */ } }
    let cleanup = null
    try { const c = fn(); if (typeof c === 'function') cleanup = c } catch { /* ignore */ }
    store.effects[i] = { deps, cleanup }
  }
  const useRef = (init) => {
    const store = ctx.store, i = ctx.idx++
    if (!store.refs[i]) store.refs[i] = { current: init }
    return store.refs[i]
  }
  const useMemo = (fn) => fn()
  // Pending functional updates are applied at the top of a render pass, the way
  // React does it, so a test cannot accidentally depend on eager application.
  const flushPending = () => {
    for (const s of stores.values()) {
      while (s.queue.length) { const [i, fn] = s.queue.shift(); s.hooks[i] = fn(s.hooks[i]) }
    }
  }
  let depth = 0
  function render(el, path = '0') {
    if (depth === 0) flushPending()
    depth++
    try { return renderNode(el, path) } finally { depth-- }
  }
  function renderNode(el, path) {
    if (el == null || typeof el === 'boolean') return null
    if (typeof el === 'string' || typeof el === 'number') return { text: String(el) }
    if (Array.isArray(el)) return { array: el.map((c, i) => render(c, path + '/' + i)).filter(Boolean) }
    const { type, props, children } = el
    if (typeof type === 'function') {
      const key = path + ':' + (type.name || 'anon')
      if (!stores.has(key)) stores.set(key, { hooks: [], effects: [], refs: [], ran: false, queue: [] })
      const store = stores.get(key); const prev = ctx
      ctx = { hooks: store.hooks, idx: 0, store }
      const out = type({ ...props, children })
      store.ran = true; ctx = prev
      return render(out, path + '>' + (type.name || 'anon'))
    }
    const kids = (children || []).map((c, i) => render(c, path + '/' + i)).filter(Boolean)
    return { type, props, children: kids }
  }
  const dispose = () => {
    for (const s of stores.values()) for (const e of s.effects) if (e && e.cleanup) { try { e.cleanup() } catch { /* ignore */ } }
  }
  return { createElement, useState, useEffect, useRef, useMemo, render, dispose }
}

function* walk(node) {
  if (!node) return
  if (node.array) { for (const c of node.array) yield* walk(c); return }
  yield node
  for (const c of node.children || []) yield* walk(c)
}
const textOf = (node) => [...walk(node)].filter((n) => n.text != null).map((n) => n.text).join('')
const findButton = (node, label) => [...walk(node)].find((n) => n.type === 'button' && textOf(n).includes(label)) || null
const findById = (node, id) => [...walk(node)].find((n) => n.props && n.props.id === id) || null
// The setup form never opens by itself, so a test opens it the way a user does:
// through the CTA in the unconfigured state.
const openSetup = async (render) => {
  const btn = findButton(render(), '现在配置')
  if (!btn) throw new Error('no "现在配置" entry point')
  await btn.props.onClick()
  render()
}

const els = {}
const docListeners = {}
// DSH marks the dark skin with this body attribute; the panel follows it.
const bodyAttrs = new Set(['data-ds-dark-theme'])
global.document = {
  visibilityState: 'visible',
  body: {
    hasAttribute: (n) => bodyAttrs.has(n),
    setAttribute: (n) => bodyAttrs.add(n),
    removeAttribute: (n) => bodyAttrs.delete(n),
  },
  getElementById: (id) => els[id] || null,
  createElement: (tag) => ({ tag, id: '', textContent: '', style: {} }),
  head: { appendChild: (el) => { if (el.id) els[el.id] = el } },
  addEventListener: (t, fn) => { (docListeners[t] || (docListeners[t] = [])).push(fn) },
  removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn) },
  dispatch: (t) => { for (const fn of (docListeners[t] || []).slice()) fn() },
}

// ---- mock bridge ----
const HOST = {
  channel: 'wecom', configured: true, urlHost: 'qyapi.weixin.qq.com', secretSet: false,
  balance: { value: 12.5, currency: 'CNY', ok: true, reason: null, at: '2026-11-17T08:00:00+08:00' },
  alert: { level: 'warn', since: 't', lastPushAt: 1, lastRecoveryAt: 0 },
  pending: null,
  thresholds: { warn: 20, critical: 5 },
  quiet: { start: '', end: '' },
  // Mirrors the bridge default: the install footer is off unless enabled.
  enabled: true, signature: false,
}
let statusFails = 0
let statusCalls = 0
let webhookFails = 0
let testPushFails = 0
let testPushStale = 0
let testPushUnpersisted = 0
let testPushThrottled = 0
// Hold the next /status response so a poll can be issued and answered out of
// order (the response is frozen at request time, like a real slow request).
let statusHold = 0
const heldStatus = []
// One-shot override for the next successful save, so a test can repoint the
// webhook to another channel/host (the mock otherwise echoes the old one).
let webhookReply = null
const releaseStatus = () => {
  const h = heldStatus.shift()
  if (!h) return false
  h.resolve({ ok: true, status: 200, json: async () => h.snap })
  return true
}
const posts = []
const fetchMock = async (url, init) => {
  const u = String(url)
  if (u.startsWith('http://127.0.0.1:17430/status')) {
    statusCalls++
    if (statusFails > 0) { statusFails--; throw new Error('ECONNREFUSED') }
    if (statusHold > 0) {
      statusHold--
      const snap = JSON.parse(JSON.stringify(HOST))
      return new Promise((resolve) => { heldStatus.push({ snap, resolve }) })
    }
    return { ok: true, status: 200, json: async () => HOST }
  }
  if (u.startsWith('http://127.0.0.1:17430/webhook')) {
    const body = JSON.parse(init?.body || '{}')
    posts.push(['webhook', body])
    if (webhookReply) { const r = webhookReply; webhookReply = null; return { ok: true, status: 200, json: async () => r } }
    const off = body.channel === 'none'
    if (webhookFails > 0) {
      webhookFails--
      return { ok: true, status: 200, json: async () => ({ ok: false, code: 'bad-url', message: 'URL 格式不对' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, channel: body.channel, configured: !off, urlHost: off ? '' : 'qyapi.weixin.qq.com', secretSet: false }) }
  }
  if (u.startsWith('http://127.0.0.1:17430/test-push')) {
    posts.push(['test-push'])
    // The bridge answers 429 with no verdict at all: the request was refused, so
    // nothing is known about delivery.
    if (testPushThrottled > 0) {
      testPushThrottled--
      return { ok: true, status: 429, json: async () => ({ ok: false, code: 'too-frequent', message: '操作太频繁，请 3 秒后再试' }) }
    }
    const verdict = (ok, extra = {}) => ({
      at: Date.now(), ok, channel: 'wecom', error: ok ? null : 'errcode 93000 invalid webhook', persisted: true, ...extra,
    })
    if (testPushStale > 0) {
      testPushStale--
      return { ok: true, status: 200, json: async () => ({ ok: true, stale: true, chunks: 1, channel: 'wecom' }) }
    }
    if (testPushUnpersisted > 0) {
      testPushUnpersisted--
      return { ok: true, status: 200, json: async () => ({ ok: false, error: 'errcode 93000 invalid webhook', code: 93000, persisted: false, verify: verdict(false, { persisted: false }) }) }
    }
    if (testPushFails > 0) {
      testPushFails--
      return { ok: true, status: 200, json: async () => ({ ok: false, error: 'errcode 93000 invalid webhook', code: 93000, hint: 'Webhook 地址无效', verify: verdict(false) }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, chunks: 1, channel: 'wecom', verify: verdict(true) }) }
  }
  if (u.startsWith('http://127.0.0.1:17430/notify')) {
    const body = JSON.parse(init?.body || '{}')
    posts.push(['notify', body])
    HOST.signature = !!body.signature
    return { ok: true, status: 200, json: async () => ({ ok: true, signature: HOST.signature }) }
  }
  if (u.startsWith('http://127.0.0.1:17430/prefs')) {
    const body = JSON.parse(init?.body || '{}')
    posts.push(['prefs', body])
    return { ok: true, status: 200, json: async () => ({ ok: true, thresholds: { warn: body.warn, critical: body.critical } }) }
  }
  if (u.startsWith('http://127.0.0.1:17430/alert/retry')) { posts.push(['alert/retry']); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  throw new Error('unexpected fetch ' + u)
}

function boot(lang = 'zh') {
  const react = createMiniReact()
  let mod = null
  // Intervals are captured instead of scheduled so a poll can be fired on demand
  // (deterministic, and no stray timers between tests).
  const intervals = []
  const sandbox = {
    console, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; intervals.push(t); return t },
    clearInterval: (t) => { if (t) t.cleared = true },
    fetch: fetchMock, document: global.document, navigator: {},
    Intl, Date, URL, JSON, Math, Number, String, Object, Array, Promise, Error, Boolean, RegExp,
  }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = { load: (m) => { mod = m } }
  vm.createContext(sandbox)
  vm.runInContext(clientCode, sandbox)
  let Panel = null
  const out = mod.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require ' + name)
  })
  out.apply({
    locale: { getLocale: () => ({ active: lang }), subscribe: () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (desc, Comp) => { if (desc.name === 'main') Panel = Comp },
    },
  })
  const render = () => react.render(react.createElement(Panel))
  const tick = () => { for (const t of intervals.slice()) if (!t.cleared) t.fn() }
  return { react, render, dispose: react.dispose, tick, intervals }
}

let passed = 0, failed = 0
const atest = async (name, fn) => {
  let timer
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout 6s')), 6000) })
  try { await Promise.race([fn(), guard]); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ }
  finally { clearTimeout(timer) }
}
const resetHost = () => Object.assign(HOST, {
  channel: 'wecom', configured: true, urlHost: 'qyapi.weixin.qq.com',
  balance: { value: 12.5, currency: 'CNY', ok: true, reason: null, at: 't' },
  alert: { level: 'warn' }, pending: null, thresholds: { warn: 20, critical: 5 },
  quiet: { start: '', end: '' }, enabled: true,
})

await atest('P1 hero shows official balance + level badge', async () => {
  resetHost()
  const { render, dispose } = boot()
  render()
  await sleep(30)
  const node = render()
  const txt = textOf(node)
  if (!txt.includes('¥12.50') || !txt.includes('余额预警')) throw new Error(txt.slice(0, 200))
  // Re-entering the panel used to leave both threshold inputs blank with a red
  // "must be positive" warning: the first /status must seed the drafts.
  const warnIn = findById(node, 'sentinel-warn')
  const critIn = findById(node, 'sentinel-crit')
  if (warnIn.props.value !== '20' || critIn.props.value !== '5') {
    throw new Error('threshold drafts not seeded: ' + JSON.stringify([warnIn.props.value, critIn.props.value]))
  }
  dispose()
})
await atest('P2 unavailable: clear reason + retry', async () => {
  resetHost(); HOST.balance = { ok: false, reason: 'signed-out', value: null, currency: null, at: null }
  const { render, dispose } = boot()
  render()
  await sleep(30)
  const node = render()
  const txt = textOf(node)
  if (!txt.includes('未登录 DeepSeek 账户') || !findButton(node, '重试')) throw new Error(txt.slice(0, 300))
  dispose()
})
await atest('P3 unconfigured: monitoring-on banner + CTA', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  const { render, dispose } = boot()
  render()
  await sleep(30)
  const node = render()
  const txt = textOf(node)
  if (!txt.includes('监控中，通知未接通') || !findButton(node, '现在配置')) throw new Error(txt.slice(0, 300))
  // The push card keeps the wording of dsh-aihot-radar (push.setup), so the two
  // panels read alike; the banner keeps its own "现在配置" CTA.
  if (!findButton(node, '配置推送')) throw new Error('the push card entry must read "配置推送"')
  dispose()
})
await atest('P4 held alert: reason + manual retry hits /alert/retry', async () => {
  resetHost(); HOST.pending = { kind: 'warn', hold: true, ambiguous: false, attempts: 3, lastError: 'invalid webhook' }
  const { render, dispose } = boot()
  render()
  await sleep(30)
  let node = render()
  const btn = findButton(node, '重试发送')
  if (!btn || !textOf(node).includes('告警发送受阻')) throw new Error('no hold line')
  await btn.props.onClick()
  await sleep(30)
  if (!posts.some(([p]) => p === 'alert/retry')) throw new Error('retry not posted')
  dispose()
})
await atest('P5 thresholds: invalid blocked, valid dirty saves', async () => {
  resetHost()
  const { render, dispose } = boot()
  render()
  await sleep(30)
  let node = render()
  findById(node, 'sentinel-crit').props.onChange({ target: { value: '25' } })
  node = render()
  if (!textOf(node).includes('预警阈值大于告急阈值')) throw new Error('no validation message')
  if (findButton(node, '保存阈值').props.disabled !== true) throw new Error('save should be disabled')
  findById(node, 'sentinel-warn').props.onChange({ target: { value: '30' } })
  findById(node, 'sentinel-crit').props.onChange({ target: { value: '8' } })
  node = render()
  const save = findButton(node, '保存阈值')
  if (save.props.disabled) throw new Error('save should be enabled')
  await save.props.onClick()
  await sleep(30)
  if (!posts.some(([p, b]) => p === 'prefs' && b.warn === 30 && b.critical === 8)) throw new Error('prefs not posted')
  node = render()
  const toast = [...walk(node)].find((n) => n.props && String(n.props.className || '').includes('sentinel-toast'))
  if (!toast) throw new Error('confirmation must be the floating toast, not an inline block')
  if (!textOf(toast).includes('阈值已保存') || !textOf(toast).includes('立即生效')) {
    throw new Error('saved toast must say immediate, not next cycle')
  }
  dispose()
})
await atest('P6 shortest path: paste url -> save&test -> success', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await openSetup(render)
  let node = render()
  findById(node, 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } })
  node = render()
  const btn = findButton(node, '保存并发送测试')
  await btn.props.onClick()
  await sleep(60)
  node = render()
  if (!posts.some(([p]) => p === 'webhook') || !posts.some(([p]) => p === 'test-push')) throw new Error('save/test not posted')
  if (!textOf(node).includes('测试推送成功')) throw new Error('no success feedback')
  const flat = [...walk(node)]
  const iPush = flat.findIndex((n) => n.text === '推送配置')
  const iOk = flat.findIndex((n) => n.text && n.text.includes('测试推送成功'))
  if (!(iPush > -1 && iOk > iPush)) throw new Error('push feedback must stay below push section')
  dispose()
})
await atest('P7 en: full English, no Chinese residue', async () => {
  resetHost()
  const { render, dispose } = boot('en')
  render()
  await sleep(30)
  const txt = textOf(render())
  if (!txt.includes('Balance Sentinel') || /[一-鿿]/.test(txt)) throw new Error(txt.slice(0, 300))
  dispose()
})
await atest('P8 bridge down: degradation box + snippet', async () => {
  resetHost(); statusFails = 99
  const { render, dispose } = boot()
  await sleep(1800)
  const node = render()
  const txt = textOf(node)
  if (!txt.includes('面板拿不到宿主状态') || !findButton(node, '复制配置片段')) throw new Error(txt.slice(0, 300))
  statusFails = 0
  dispose()
})
await atest('P9 monitor off + quiet hours lines', async () => {
  resetHost(); HOST.enabled = false; HOST.quiet = { start: '23:00', end: '08:00' }
  const { render, dispose } = boot()
  render()
  await sleep(30)
  const txt = textOf(render())
  if (!txt.includes('后台监控已关闭') || !txt.includes('免打扰')) throw new Error(txt.slice(0, 300))
  dispose()
})
await atest('P10 threshold-resolved pending shows 解除 label', async () => {
  resetHost(); HOST.pending = { kind: 'recovered', cause: 'threshold', hold: false, ambiguous: false, attempts: 0, lastError: null }
  const { render, dispose } = boot()
  render()
  await sleep(30)
  const txt = textOf(render())
  if (!txt.includes('「解除」通知待发送')) throw new Error(txt.slice(0, 300))
  dispose()
})

await atest('P11 feishu/dingtalk form: official webhook help, save&test kept', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await openSetup(render)
  let node = render()
  findById(node, 'sentinel-chan').props.onChange({ target: { value: 'feishu' } })
  node = render()
  const hrefs = () => [...walk(node)].filter((n) => n.type === 'a').map((n) => String(n.props.href || ''))
  if (!hrefs().some((u) => u.includes('open.feishu.cn/document/client-docs/bot-v3/add-custom-bot'))) throw new Error('feishu doc link missing')
  const txt = textOf(node)
  if (!txt.includes('如何获取机器人 Webhook')) throw new Error('help entry title missing')
  if (!txt.includes('签名校验')) throw new Error('feishu security hint missing')
  if (!findButton(node, '保存并发送测试')) throw new Error('save&test must stay')
  findById(node, 'sentinel-chan').props.onChange({ target: { value: 'dingtalk' } })
  node = render()
  if (![...walk(node)].some((n) => n.type === 'a' && String(n.props.href).includes('open.dingtalk.com/document/orgapp/custom-robot-access'))) throw new Error('dingtalk doc link missing')
  const dt = textOf(node)
  if (!dt.includes('加签密钥') || !dt.includes('自定义关键词')) throw new Error('dingtalk security hint missing')
  dispose()
})
await atest('P12 support boundary shown in zh/en; bridge-down names remote panel', async () => {
  resetHost()
  let b = boot()
  b.render()
  await sleep(30)
  let txt = textOf(b.render())
  if (!txt.includes('仅支持本机 DSH Desktop') || !txt.includes('不支持远程 Web 面板')) throw new Error(txt.slice(0, 300))
  if (!txt.includes('支持宿主账号免填 Key：需宿主提供账号服务且已登录')) throw new Error('no-key boundary missing')
  b.dispose()

  resetHost()
  b = boot('en')
  b.render()
  await sleep(30)
  txt = textOf(b.render())
  if (!txt.includes('Local DSH Desktop or local web host only')) throw new Error(txt.slice(0, 300))
  if (!txt.includes('remote web panels are not supported')) throw new Error('en support boundary incomplete')
  if (!txt.includes('Key-free host accounts are supported')) throw new Error('en key-free boundary must stay conditional')
  b.dispose()

  resetHost(); statusFails = 99
  b = boot()
  await sleep(1800)
  txt = textOf(b.render())
  if (!txt.includes('远程 Web 面板')) throw new Error('bridge-down must name the remote-panel case')
  statusFails = 0
  b.dispose()
})

// Regression: a server-side rejection used to return before clearing `busy`, so
// the save button stayed on "保存中…" and disabled forever.
await atest('P13 save failure clears busy; edit then retry succeeds', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  webhookFails = 1
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await openSetup(render)
  let node = render()
  findById(node, 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } })
  node = render()
  await findButton(node, '仅保存').props.onClick()
  await sleep(80)
  node = render()
  if (!textOf(node).includes('URL 格式不对')) throw new Error('server rejection must be shown')
  const retryBtn = findButton(node, '仅保存')
  if (!retryBtn) throw new Error('button stuck on 保存中 after a failed save')
  if (retryBtn.props.disabled) throw new Error('button must be re-enabled after a failed save')
  findById(node, 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ok' } })
  node = render()
  await findButton(node, '仅保存').props.onClick()
  await sleep(80)
  node = render()
  const txt = textOf(node)
  if (!txt.includes('已保存，立即生效')) throw new Error('retry after fixing the input must succeed')
  if (!txt.includes('已配置，待测试')) throw new Error('saved-but-untested must not read as connected')
  webhookFails = 0
  dispose()
})
await atest('P14 configured vs connected: untested / verified / failed', async () => {
  resetHost(); HOST.verify = null
  let b = boot(); b.render(); await sleep(30)
  let txt = textOf(b.render())
  if (!txt.includes('已配置，待测试')) throw new Error('untested state missing: ' + txt.slice(0, 200))
  if (txt.includes('最近测试成功')) throw new Error('must not claim delivery before a test')
  b.dispose()

  resetHost(); HOST.verify = { at: Date.now(), ok: true, channel: 'wecom', error: null }
  b = boot(); b.render(); await sleep(30)
  txt = textOf(b.render())
  if (!txt.includes('最近测试成功')) throw new Error('verified state missing')
  b.dispose()

  resetHost(); HOST.verify = { at: Date.now(), ok: false, channel: 'wecom', error: 'errcode 93000 invalid webhook' }
  b = boot(); b.render(); await sleep(30)
  txt = textOf(b.render())
  if (!txt.includes('最近测试失败') || !txt.includes('93000')) throw new Error('failed state must carry the reason: ' + txt.slice(0, 240))
  b.dispose()
})
// Regression: re-entering the panel once showed two empty threshold inputs plus
// a red "must be positive" line, because the drafts were seeded only by a /status
// that may land late (or not at all). An untouched draft must fall back to the
// host value instead of rendering ''.
await atest('P15 thresholds never render blank; fallback when host omits them', async () => {
  resetHost(); delete HOST.thresholds
  const { render, dispose } = boot()
  render()
  await sleep(30)
  const node = render()
  const w = findById(node, 'sentinel-warn').props.value
  const c = findById(node, 'sentinel-crit').props.value
  if (w !== '20' || c !== '5') throw new Error('blank/incorrect fallback: ' + JSON.stringify([w, c]))
  if (textOf(node).includes('需为正数')) throw new Error('validation error shown for untouched defaults')
  dispose()
})
await atest('P16 save&test failure still re-enables the button', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  testPushFails = 1
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await openSetup(render)
  let node = render()
  findById(node, 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } })
  node = render()
  await findButton(node, '保存并发送测试').props.onClick()
  await sleep(120)
  node = render()
  const txt = textOf(node)
  if (!txt.includes('93000')) throw new Error('test failure must be surfaced: ' + txt.slice(0, 240))
  if (txt.includes('保存中') || txt.includes('发送中')) throw new Error('button stuck busy after a failed test')
  if (!findButton(node, '发送测试推送')) throw new Error('test button not restored')
  testPushFails = 0
  dispose()
})
// A verdict can arrive after another page repointed the webhook; the panel must
// say it was discarded instead of letting it read as the new channel's result.
await atest('P17 stale verdict is explained, never shown as success', async () => {
  resetHost()
  testPushStale = 1
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await findButton(render(), '发送测试推送').props.onClick()
  await sleep(80)
  const txt = textOf(render())
  if (!txt.includes('推送配置已变更')) throw new Error('stale verdict must be explained: ' + txt.slice(0, 240))
  if (txt.includes('测试推送成功')) throw new Error('stale verdict must not read as success')
  dispose()
})
await atest('P18 unpersisted verdict is shown and labelled', async () => {
  resetHost()
  testPushUnpersisted = 1
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await findButton(render(), '发送测试推送').props.onClick()
  await sleep(80)
  const txt = textOf(render())
  if (!txt.includes('93000')) throw new Error('failure must still be shown: ' + txt.slice(0, 240))
  if (!txt.includes('重启后会丢失')) throw new Error('unpersisted result must say so')
  dispose()
})
// The panel must follow the host skin attribute, not the OS preference: a dark
// app on a light desktop keeps the dark palette (and a dark <select> popup).
// Grey for "saved but untested" read as a disabled control; each state now owns
// a token so the dot and the badge cannot drift back to a neutral grey.
await atest('P19 each connection state gets its own colour', async () => {
  const cases = [
    [null, '已配置，待测试', 'brand-primary'],
    [{ at: Date.now(), ok: true, channel: 'wecom', error: null }, '最近测试成功', 'state-success-primary'],
    [{ at: Date.now(), ok: false, channel: 'wecom', error: 'errcode 93000' }, '最近测试失败', 'state-error-primary'],
  ]
  for (const [verify, label, token] of cases) {
    resetHost(); HOST.verify = verify
    const b = boot()
    b.render()
    await sleep(30)
    const node = b.render()
    const badge = [...walk(node)].find((n) => n.props && n.props.style && n.props.style.color
      && String(n.props.style.color).includes(token) && textOf(n).includes(label))
    if (!badge) throw new Error(`state "${label}" must use ${token}`)
    b.dispose()
  }
})
// A standalone test used to update only the inline result: the badge kept the
// previous green "succeeded" until the next poll landed.
await atest('P20 a failed test flips the badge without waiting for a poll', async () => {
  resetHost()
  HOST.verify = { at: Date.now() - 60000, ok: true, channel: 'wecom', error: null, persisted: true }
  testPushFails = 1
  const { render, dispose } = boot()
  render()
  await sleep(30)
  if (!textOf(render()).includes('最近测试成功')) throw new Error('precondition: old success should be visible')
  await findButton(render(), '发送测试推送').props.onClick()
  await sleep(80)
  const txt = textOf(render())
  if (!txt.includes('最近测试失败')) throw new Error('badge must flip immediately: ' + txt.slice(0, 240))
  if (txt.includes('最近测试成功')) throw new Error('the old success must not stay on screen')
  testPushFails = 0
  dispose()
})
// The light skin's vivid state colours land near 2:1 on white, so the headline
// amount switches to a darkened value through a custom property.
await atest('P21 light skin darkens the headline amount', async () => {
  resetHost()
  bodyAttrs.delete('data-ds-dark-theme')
  const b = boot()
  b.render()
  await sleep(30)
  const node = b.render()
  const amount = [...walk(node)].find((n) => n.props && n.props.style && n.props.style.color
    && String(n.props.style.color).includes('--sentinel-val-'))
  if (!amount) throw new Error('amount must use a skin-aware colour variable')
  const sheet = els['sentinel-style'] ? els['sentinel-style'].textContent : ''
  if (!sheet.includes('--sentinel-val-warn: #9c5c00')) throw new Error('light warn ink missing from the sheet')
  if (!sheet.includes('--sentinel-val-critical: #c62828')) throw new Error('light critical ink missing from the sheet')
  bodyAttrs.add('data-ds-dark-theme')
  b.dispose()
})
await atest('P22 host skin drives colorScheme and the light palette', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  bodyAttrs.add('data-ds-dark-theme')
  let b = boot(); b.render(); await sleep(30)
  await openSetup(() => b.render())
  let sel = findById(b.render(), 'sentinel-chan')
  if (sel.props.style.colorScheme !== 'dark') throw new Error('dark skin must open a dark menu: ' + sel.props.style.colorScheme)
  const sheet = els['sentinel-style'] ? els['sentinel-style'].textContent : ''
  if (!sheet.includes('body:not([data-ds-dark-theme]) .sentinel-panel')) throw new Error('light palette override missing from the injected sheet')
  if (!sheet.includes('--sentinel-surface')) throw new Error('surface variable missing from the injected sheet')
  b.dispose()

  bodyAttrs.delete('data-ds-dark-theme')
  b = boot(); b.render(); await sleep(30)
  await openSetup(() => b.render())
  sel = findById(b.render(), 'sentinel-chan')
  if (sel.props.style.colorScheme !== 'light') throw new Error('light skin must open a light menu: ' + sel.props.style.colorScheme)
  b.dispose()
  bodyAttrs.add('data-ds-dark-theme')
})

// A label added to the inline dictionary but never exported leaves the locale
// packs (shipped for translators and for other surfaces) silently incomplete —
// that is exactly how push.setup went missing.
await atest('P23b exported locale packs match the inline dictionary', async () => {
  const unesc = (v) => v.replace(/\\n/g, '\n').replace(/\\'/g, "'")
  const inline = (lang) => {
    const i = clientCode.indexOf(`      ${lang}: {`)
    const j = lang === 'zh' ? clientCode.indexOf('      en: {', i) : clientCode.indexOf('\n    }', i)
    const out = {}
    for (const m of clientCode.slice(i, j).matchAll(/'([\w.]+)':\s*'((?:\\'|[^'])*)'/g)) out[m[1]] = unesc(m[2])
    return out
  }
  const flatten = (o) => {
    const out = {}
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2
      else out[k] = v
    }
    return out
  }
  for (const lang of ['zh', 'en']) {
    const pack = flatten(JSON.parse(readFileSync(join(here, '..', 'locale', `${lang}.json`), 'utf8')))
    const mine = inline(lang)
    const missing = Object.keys(mine).filter((k) => !(k in pack))
    if (missing.length) throw new Error(`${lang} pack is missing: ${missing.join(', ')}`)
    const drift = Object.keys(mine).filter((k) => k in pack && mine[k] !== pack[k])
    if (drift.length) throw new Error(`${lang} pack drifted on: ${drift.join(', ')}`)
  }
})
await atest('P23 zh/en catalogs have identical keys', async () => {
  const iZh = clientCode.indexOf('      zh: {')
  const iEn = clientCode.indexOf('      en: {')
  if (iZh < 0 || iEn < 0 || iEn < iZh) throw new Error('catalogs not found')
  const keysOf = (s) => [...s.matchAll(/'([a-zA-Z][\w.]*)':/g)].map((m) => m[1])
  const zh = new Set(keysOf(clientCode.slice(iZh, iEn)))
  const en = new Set(keysOf(clientCode.slice(iEn, clientCode.indexOf('\n    }', iEn))))
  const missEn = [...zh].filter((k) => !en.has(k))
  const missZh = [...en].filter((k) => !zh.has(k))
  if (missEn.length || missZh.length) throw new Error(`missing en: ${missEn.join(',') || '-'} | missing zh: ${missZh.join(',') || '-'}`)
})

await atest('P24 threshold save confirms via top toast, gone in 2s', async () => {
  resetHost()
  const { render, dispose } = boot()
  render()
  await sleep(30)
  let node = render()
  findById(node, 'sentinel-warn').props.onChange({ target: { value: '30' } })
  node = render()
  const save = findButton(node, '保存阈值')
  if (save.props.disabled) throw new Error('save should be enabled')
  await save.props.onClick()
  await sleep(80)
  node = render()
  const toast = [...walk(node)].find((n) => n.props && String(n.props.className || '').includes('sentinel-toast'))
  if (!toast) throw new Error('no toast after saving thresholds')
  if (!textOf(toast).includes('阈值已保存')) throw new Error('toast text: ' + textOf(toast))
  await sleep(2100)
  if (textOf(render()).includes('阈值已保存')) throw new Error('toast should fade after 2s and leave no inline copy')
  dispose()
})
await atest('P25 error notice is not auto-dismissed', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  const { render, dispose } = boot()
  render()
  await sleep(30)
  await openSetup(render)
  let node = render()
  findById(node, 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } })
  node = render()
  webhookFails = 1
  await findButton(node, '保存并发送测试').props.onClick()
  await sleep(80)
  if (!textOf(render()).includes('URL 格式不对')) throw new Error('error not shown')
  await sleep(3200)
  if (!textOf(render()).includes('URL 格式不对')) throw new Error('error must stay until the next action')
  webhookFails = 0
  dispose()
})

await atest('P26 poll clears a stale pending banner without any click', async () => {
  resetHost(); HOST.pending = { kind: 'warn', cause: null, hold: false, ambiguous: false, attempts: 0, lastError: null }
  const b = boot()
  b.render()
  await sleep(30)
  if (!textOf(b.render()).includes('有一条「预警」通知待发送')) throw new Error('pending banner missing')
  if (!b.intervals.length || b.intervals[0].ms !== 15000) throw new Error('expected a 15s poll')
  HOST.pending = null // the monitor delivered the alert
  b.tick()
  await sleep(40)
  if (textOf(b.render()).includes('待发送')) throw new Error('poll did not clear the banner')
  b.dispose()
})
await atest('P27 polls pause while hidden and refresh on return', async () => {
  resetHost()
  const listenersBefore = (docListeners.visibilitychange || []).length
  const b = boot()
  b.render()
  await sleep(30)
  const base = statusCalls
  global.document.visibilityState = 'hidden'
  b.tick(); await sleep(30)
  if (statusCalls !== base) throw new Error('must not poll while hidden')
  global.document.visibilityState = 'visible'
  global.document.dispatch('visibilitychange'); await sleep(30)
  if (statusCalls !== base + 1) throw new Error('returning to the panel must refresh once')
  // Unmount has to leave nothing behind: no live interval, no document listener.
  b.dispose()
  if (!b.intervals.length || !b.intervals[0].cleared) throw new Error('unmount must clear the poll interval')
  if ((docListeners.visibilitychange || []).length !== listenersBefore) throw new Error('unmount must drop the visibilitychange listener')
  const afterDispose = statusCalls
  global.document.dispatch('visibilitychange'); await sleep(30)
  if (statusCalls !== afterDispose) throw new Error('a disposed panel must not poll')
  global.document.visibilityState = 'visible'
})
await atest('P28 background poll keeps in-progress threshold edits', async () => {
  resetHost()
  const b = boot()
  b.render()
  await sleep(30)
  let node = b.render()
  findById(node, 'sentinel-warn').props.onChange({ target: { value: '30' } })
  node = b.render()
  if (findById(node, 'sentinel-warn').props.value !== '30') throw new Error('draft not applied')
  b.tick(); await sleep(40)
  node = b.render()
  if (findById(node, 'sentinel-warn').props.value !== '30') throw new Error('poll overwrote an unsaved edit')
  b.dispose()
})

// Regression: a throttled test pushed the panel into "failed" for a request that
// never left the machine. A 429 carries no verdict, so it must only be reported.
await atest('P29 a 429 test keeps the last success and only warns', async () => {
  resetHost()
  HOST.verify = { at: Date.now() - 60000, ok: true, channel: 'wecom', error: null, persisted: true }
  testPushThrottled = 1
  const b = boot()
  b.render()
  await sleep(30)
  if (!textOf(b.render()).includes('最近测试成功')) throw new Error('precondition: the last success must be visible')
  await findButton(b.render(), '发送测试推送').props.onClick()
  await sleep(80)
  const txt = textOf(b.render())
  if (!txt.includes('操作太频繁')) throw new Error('429 must be explained: ' + txt.slice(0, 240))
  if (!txt.includes('最近测试成功')) throw new Error('a refused request must not rewrite the badge')
  if (txt.includes('最近测试失败')) throw new Error('no verdict came back, so nothing may read as failed')
  b.dispose()
})

// Regression: a /status that was already in flight when the test failed used to
// land afterwards and put the old green verdict back on the badge.
await atest('P30 a late /status cannot undo a newer failed test', async () => {
  resetHost()
  HOST.verify = { at: Date.now() - 60000, ok: true, channel: 'wecom', error: null, persisted: true }
  const b = boot()
  b.render()
  await sleep(30)
  if (!textOf(b.render()).includes('最近测试成功')) throw new Error('precondition: the old success must be visible')
  statusHold = 1
  b.tick() // poll leaves now, carrying the old success; its answer is held back
  await sleep(20)
  if (!heldStatus.length) throw new Error('the poll was not held')
  testPushFails = 1
  await findButton(b.render(), '发送测试推送').props.onClick()
  await sleep(80)
  if (!textOf(b.render()).includes('最近测试失败')) throw new Error('precondition: the test must fail first')
  releaseStatus() // the slow poll finally answers
  await sleep(40)
  const txt = textOf(b.render())
  if (!txt.includes('最近测试失败')) throw new Error('a stale poll resurrected the old success: ' + txt.slice(0, 240))
  if (txt.includes('最近测试成功')) throw new Error('the old success must not come back')
  testPushFails = 0
  b.dispose()
})

// Regression: saving a new webhook used to be undone by a /status that was
// already in flight — the panel fell back to the previous address and to its
// "last test succeeded" badge, hiding that the new endpoint was never tested.
await atest('P31 a late /status cannot undo a saved webhook', async () => {
  resetHost()
  HOST.verify = { at: Date.now() - 60000, ok: true, channel: 'wecom', error: null, persisted: true }
  const b = boot()
  b.render()
  await sleep(30)
  let txt = textOf(b.render())
  if (!txt.includes('qyapi.weixin.qq.com') || !txt.includes('最近测试成功')) throw new Error('precondition: old address + success must be visible')
  statusHold = 1
  b.tick() // poll leaves now, carrying the old webhook; its answer is held back
  await sleep(20)
  if (!heldStatus.length) throw new Error('the poll was not held')

  await findButton(b.render(), '修改').props.onClick()
  findById(b.render(), 'sentinel-chan').props.onChange({ target: { value: 'dingtalk' } })
  findById(b.render(), 'sentinel-url').props.onChange({ target: { value: 'https://oapi.dingtalk.com/robot/send?access_token=t' } })
  webhookReply = { ok: true, channel: 'dingtalk', configured: true, urlHost: 'oapi.dingtalk.com', secretSet: true }
  await findButton(b.render(), '仅保存').props.onClick()
  await sleep(80)
  txt = textOf(b.render())
  if (!txt.includes('oapi.dingtalk.com') || !txt.includes('已配置，待测试')) throw new Error('precondition: the saved webhook must be shown: ' + txt.slice(0, 240))
  if (txt.includes('qyapi.weixin.qq.com')) throw new Error('precondition: the old address must be gone')

  // Keep the mock host in step with the save, so only the held response can be stale.
  HOST.channel = 'dingtalk'; HOST.urlHost = 'oapi.dingtalk.com'; HOST.verify = null
  releaseStatus() // the slow poll finally answers with the old webhook
  await sleep(40)
  txt = textOf(b.render())
  if (!txt.includes('oapi.dingtalk.com')) throw new Error('a stale poll restored the old address: ' + txt.slice(0, 240))
  if (txt.includes('qyapi.weixin.qq.com')) throw new Error('the replaced address must not come back')
  if (!txt.includes('已配置，待测试')) throw new Error('the new endpoint must stay untested: ' + txt.slice(0, 240))
  if (txt.includes('最近测试成功')) throw new Error('the old verdict must not return for the new webhook')
  b.dispose()
})

// Regression: a /status that had been superseded by a save still ran the
// unconfigured branch, which used to reopen the setup form under a summary that
// already said "configured".
await atest('P32 a stale /status cannot reopen the form after saving', async () => {
  resetHost()
  Object.assign(HOST, { configured: false, channel: 'none', urlHost: '', secretSet: false, verify: null })
  const b = boot()
  b.render()
  await sleep(30)
  await openSetup(() => b.render())
  if (!findById(b.render(), 'sentinel-url')) throw new Error('precondition: the CTA must open the setup form')

  statusHold = 1
  await findButton(b.render(), '刷新').props.onClick()
  b.render() // the refresh restarts the poll effect; that first /status is held
  await sleep(20)
  if (!heldStatus.length) throw new Error('the refresh poll was not held')

  findById(b.render(), 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } })
  webhookReply = { ok: true, channel: 'wecom', configured: true, urlHost: 'qyapi.weixin.qq.com', secretSet: false }
  await findButton(b.render(), '仅保存').props.onClick()
  await sleep(80)
  let node = b.render()
  if (findById(node, 'sentinel-url')) throw new Error('precondition: a successful save must close the form')
  if (!textOf(node).includes('已配置，待测试')) throw new Error('precondition: the saved channel must read untested')

  // Keep the mock host in step with the save, so only the held response is stale.
  Object.assign(HOST, { configured: true, channel: 'wecom', urlHost: 'qyapi.weixin.qq.com' })
  releaseStatus() // the obsolete "not configured" snapshot finally answers
  await sleep(40)
  node = b.render()
  if (findById(node, 'sentinel-url')) throw new Error('an obsolete /status reopened the setup form')
  const txt = textOf(node)
  if (!txt.includes('已配置，待测试')) throw new Error('the summary must still read untested: ' + txt.slice(0, 240))
  b.dispose()
})

// First use reads as a monitor, not as a form to fill in: the unconfigured state
// is announced by the banner, and nothing (not even a refresh) opens the form.
await atest('P33 the panel never opens the setup form by itself', async () => {
  resetHost()
  Object.assign(HOST, { configured: false, channel: 'none', urlHost: '', secretSet: false, verify: null })
  const b = boot()
  b.render()
  await sleep(30)
  let node = b.render()
  if (findById(node, 'sentinel-url')) throw new Error('the setup form must not open on first load')
  if (!textOf(node).includes('监控中，通知未接通')) throw new Error('the banner must announce the unconfigured state')

  await findButton(node, '刷新').props.onClick()
  b.render() // the refresh restarts the poll effect
  await sleep(30)
  node = b.render()
  if (findById(node, 'sentinel-url')) throw new Error('a refresh must not open the setup form')

  await openSetup(() => b.render())
  node = b.render()
  if (!findById(node, 'sentinel-url')) throw new Error('the CTA must still open the form')
  if (textOf(node).includes('还没有配置推送通道')) throw new Error('the form must not repeat the banner explanation')
  b.dispose()
})

// With no auto-open, the first-use form is reachable only by an explicit click,
// so it also needs an explicit way out that never touches the saved webhook.
await atest('P34 an unconfigured form can be cancelled without saving', async () => {
  resetHost()
  Object.assign(HOST, { configured: false, channel: 'none', urlHost: '', secretSet: false, verify: null })
  const b = boot()
  b.render()
  await sleep(30)
  await openSetup(() => b.render())
  if (!findById(b.render(), 'sentinel-url')) throw new Error('precondition: the CTA must open the form')
  const before = posts.length
  findById(b.render(), 'sentinel-url').props.onChange({ target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } })
  await findButton(b.render(), '取消').props.onClick()
  let node = b.render()
  if (findById(node, 'sentinel-url')) throw new Error('cancel must close the form')
  if (posts.length !== before) throw new Error('cancel must not save anything: ' + JSON.stringify(posts.slice(before)))
  if (!textOf(node).includes('监控中，通知未接通')) throw new Error('the banner must still explain the unconfigured state')
  await openSetup(() => b.render())
  if (!findById(b.render(), 'sentinel-url')) throw new Error('the form must be reachable again after cancelling')
  b.dispose()
})

// The footer switch is the only way a user who never edits YAML can opt in, so it
// has to start off and round-trip through the bridge.
await atest('P35 the push card can switch the install footer', async () => {
  resetHost()
  HOST.signature = false
  const b = boot()
  b.render()
  await sleep(30)
  let box = findById(b.render(), 'sentinel-sig')
  if (!box) throw new Error('the push card must offer the footer switch')
  if (box.props.checked) throw new Error('the footer must start off')
  const label = textOf(b.render())
  if (!label.includes('（默认关闭')) throw new Error('the hint must read as a bracketed note: ' + label.slice(0, 200))
  if (label.includes(' 默认关闭')) throw new Error('a full-width bracket must not be preceded by a space')
  await box.props.onChange({ target: { checked: true } })
  await sleep(20)
  box = findById(b.render(), 'sentinel-sig')
  if (!box.props.checked) throw new Error('the switch must stay on once the bridge accepts it')
  const sent = posts.filter(([p]) => p === 'notify').pop()
  if (!sent || sent[1].signature !== true) throw new Error('the switch must be saved as true: ' + JSON.stringify(sent))
  await box.props.onChange({ target: { checked: false } })
  await sleep(20)
  if (findById(b.render(), 'sentinel-sig').props.checked) throw new Error('the switch must turn off again')
  b.dispose()
})

// One line per fact: endpoint and test time share a line, the failure reason keeps
// its own, and the "no restart needed" sentence moves to where saving happens.
await atest('P36 the push card keeps one line per fact', async () => {
  resetHost()
  HOST.verify = { at: Date.now(), ok: true, channel: 'wecom', error: null, persisted: true }
  const b = boot()
  b.render()
  await sleep(30)
  let node = b.render()
  let txt = textOf(node)
  if (!txt.includes('qyapi.weixin.qq.com')) throw new Error('the endpoint must stay visible')
  if (!/\d{2}:\d{2}:\d{2}/.test(txt)) throw new Error('the test time must stay visible: ' + txt.slice(0, 200))
  if (txt.includes('当前地址') || txt.includes('最近测试成功：')) {
    throw new Error('address and time must share one line: ' + txt.slice(0, 200))
  }
  if (txt.includes('保存即生效')) throw new Error('the save explanation belongs in the form, not the card')
  if (!txt.includes('开启后告警尾部会多一行署名')) throw new Error('the card must keep the footer explanation')
  // Actions stay left-aligned under the switch, never pushed to the right edge.
  const actionRow = [...walk(node)].find((n) => n.props?.style?.display === 'flex'
    && [...walk(n)].some((c) => c.props?.type === 'button' && textOf(c).includes('发送测试推送')))
  if (!actionRow) throw new Error('the push actions must sit in their own row')
  if (actionRow.props.style.marginLeft === 'auto' || actionRow.props.style.justifyContent === 'flex-end') {
    throw new Error('actions must stay left-aligned')
  }
  const flexRow = (n, gap) => [...walk(n)].some((x) => x.props?.style?.display === 'flex'
    && x.props.style.flexWrap === 'wrap' && x.props.style.marginTop === gap)
  if (!flexRow(node, 10)) throw new Error('the action row must sit 10px below the switch')
  // Two equal actions, so both buttons share one style object (no outline pair).
  const btnStyle = (label) => findButton(node, label).props.style
  if (JSON.stringify(btnStyle('修改')) !== JSON.stringify(btnStyle('发送测试推送'))) {
    throw new Error('the edit button must match the test button')
  }

  await findButton(node, '修改').props.onClick()
  node = b.render()
  txt = textOf(node)
  if (!txt.includes('保存即生效')) throw new Error('the form should explain what saving does')
  if (!flexRow(node, 10)) throw new Error('the form buttons must be spaced from the switch')
  b.dispose()
})

// Same ordering rule as a webhook save: a /status issued before the toggle still
// reports the old value and must not flip the checkbox back under the user.
await atest('P37 a late /status cannot undo the footer switch', async () => {
  resetHost()
  HOST.signature = false
  const b = boot()
  b.render()
  await sleep(30)
  statusHold = 1
  b.tick(); await sleep(20)
  if (!heldStatus.length) throw new Error('the poll was not held')
  const box = findById(b.render(), 'sentinel-sig')
  await box.props.onChange({ target: { checked: true } })
  await sleep(20)
  if (!findById(b.render(), 'sentinel-sig').props.checked) throw new Error('precondition: the switch must be on')
  releaseStatus() // the held snapshot still says "off"
  await sleep(40)
  if (!findById(b.render(), 'sentinel-sig').props.checked) {
    throw new Error('a stale /status turned the footer switch back off')
  }
  b.dispose()
})

// The form's "turn off" button lands in the same slot as the summary's "修改"
// button, so React recycles one DOM node for the two. A borderColor override
// that only exists inside the form is cleared on the way back, and the recycled
// "修改" then falls back to currentColor: a hard ring around a plain secondary
// action that reads as "still selected" long after the editor closed.
await atest('P38 the edit button keeps its hairline border after cancelling', async () => {
  resetHost()
  const b = boot()
  b.render()
  await sleep(30)
  let node = b.render()
  await findButton(node, '修改').props.onClick()
  node = b.render()
  const off = findButton(node, '关闭推送')
  if (!off) throw new Error('precondition: the form must offer the turn-off action')
  if ('borderColor' in off.props.style) throw new Error('the turn-off button must not add a borderColor override')
  if (!/^1px solid /.test(String(off.props.style.border))) {
    throw new Error('the turn-off button must own its border: ' + off.props.style.border)
  }
  await findButton(node, '取消').props.onClick()
  node = b.render()
  const edit = findButton(node, '修改')
  if (!edit) throw new Error('cancelling must bring the summary back')
  if (!/^1px solid /.test(String(edit.props.style.border))) throw new Error('the edit button must keep its own border')
  // Hover must never repaint the border in the brand colour: that is the ring a
  // recycled node would show once its inline colour is gone.
  const sheet = els['sentinel-style'] ? els['sentinel-style'].textContent : ''
  const hoverRule = (sheet.match(/\.sentinel-panel button:hover[^{]*\{[^}]*\}/) || [''])[0]
  if (/brand-primary/.test(hoverRule)) throw new Error('hover must not paint the border in the brand colour')
  if (!/border-color:\s*var\(--dsw-alias-border-l2/.test(hoverRule)) throw new Error('hover must keep the hairline border: ' + hoverRule)
  if (!/button:focus-visible[^{]*\{[^}]*outline/.test(sheet)) throw new Error('keyboard focus must keep a ring')
  b.dispose()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100).unref()