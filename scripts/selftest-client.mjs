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
    const set = (v) => { store.hooks[i] = typeof v === 'function' ? v(store.hooks[i]) : v }
    return [store.hooks[i], set]
  }
  const useEffect = (fn) => { if (ctx.store.ran) return; try { const c = fn(); if (typeof c === 'function') ctx.cleanups.push(c) } catch { /* ignore */ } }
  const useMemo = (fn) => fn()
  function render(el, path = '0') {
    if (el == null || typeof el === 'boolean') return null
    if (typeof el === 'string' || typeof el === 'number') return { text: String(el) }
    if (Array.isArray(el)) return { array: el.map((c, i) => render(c, path + '/' + i)).filter(Boolean) }
    const { type, props, children } = el
    if (typeof type === 'function') {
      const key = path + ':' + (type.name || 'anon')
      if (!stores.has(key)) stores.set(key, { hooks: [], cleanups: [], ran: false })
      const store = stores.get(key); const prev = ctx
      ctx = { hooks: store.hooks, idx: 0, cleanups: store.cleanups, store }
      const out = type({ ...props, children })
      store.ran = true; ctx = prev
      return render(out, path + '>' + (type.name || 'anon'))
    }
    const kids = (children || []).map((c, i) => render(c, path + '/' + i)).filter(Boolean)
    return { type, props, children: kids }
  }
  const dispose = () => { for (const s of stores.values()) for (const c of s.cleanups) { try { c() } catch { /* ignore */ } } }
  return { createElement, useState, useEffect, useMemo, render, dispose }
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

const els = {}
global.document = {
  getElementById: (id) => els[id] || null,
  createElement: (tag) => ({ tag, id: '', textContent: '', style: {} }),
  head: { appendChild: (el) => { if (el.id) els[el.id] = el } },
}

// ---- mock bridge ----
const HOST = {
  channel: 'wecom', configured: true, urlHost: 'qyapi.weixin.qq.com', secretSet: false,
  balance: { value: 12.5, currency: 'CNY', ok: true, reason: null, at: '2026-11-17T08:00:00+08:00' },
  alert: { level: 'warn', since: 't', lastPushAt: 1, lastRecoveryAt: 0 },
  pending: null,
  thresholds: { warn: 20, critical: 5 },
  quiet: { start: '', end: '' },
  enabled: true, signature: true,
}
let statusFails = 0
const posts = []
const fetchMock = async (url, init) => {
  const u = String(url)
  if (u.startsWith('http://127.0.0.1:17430/status')) {
    if (statusFails > 0) { statusFails--; throw new Error('ECONNREFUSED') }
    return { ok: true, status: 200, json: async () => HOST }
  }
  if (u.startsWith('http://127.0.0.1:17430/webhook')) {
    const body = JSON.parse(init?.body || '{}')
    posts.push(['webhook', body])
    const off = body.channel === 'none'
    return { ok: true, status: 200, json: async () => ({ ok: true, channel: body.channel, configured: !off, urlHost: off ? '' : 'qyapi.weixin.qq.com', secretSet: false }) }
  }
  if (u.startsWith('http://127.0.0.1:17430/test-push')) { posts.push(['test-push']); return { ok: true, status: 200, json: async () => ({ ok: true, chunks: 1, channel: 'wecom' }) } }
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
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
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
  return { react, render, dispose: react.dispose }
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
  const txt = textOf(render())
  if (!txt.includes('¥12.50') || !txt.includes('余额预警')) throw new Error(txt.slice(0, 200))
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
  const flat = [...walk(node)]
  const iTh = flat.findIndex((n) => n.text === '告警阈值')
  const iSaved = flat.findIndex((n) => n.text && n.text.includes('阈值已保存'))
  const iPush = flat.findIndex((n) => n.text === '推送配置')
  if (!(iTh > -1 && iSaved > iTh && iPush > iSaved)) throw new Error('saved message must sit below threshold card, above push section')
  if (!flat[iSaved].text.includes('立即生效')) throw new Error('saved message must say immediate, not next cycle')
  dispose()
})
await atest('P6 shortest path: paste url -> save&test -> success', async () => {
  resetHost(); HOST.configured = false; HOST.channel = 'none'
  const { render, dispose } = boot()
  render()
  await sleep(30)
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
  if (!txt.includes('免 Key 需宿主提供账号服务且已登录')) throw new Error('no-key boundary missing')
  b.dispose()

  resetHost()
  b = boot('en')
  b.render()
  await sleep(30)
  txt = textOf(b.render())
  if (!txt.includes('Local DSH Desktop or local web host only')) throw new Error(txt.slice(0, 300))
  if (!txt.includes('remote web panels are not supported')) throw new Error('en support boundary incomplete')
  b.dispose()

  resetHost(); statusFails = 99
  b = boot()
  await sleep(1800)
  txt = textOf(b.render())
  if (!txt.includes('远程 Web 面板')) throw new Error('bridge-down must name the remote-panel case')
  statusFails = 0
  b.dispose()
})

await atest('P13 zh/en catalogs have identical keys', async () => {
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
setTimeout(() => process.exit(process.exitCode), 100).unref()