// Balance source chain + alert state machine + delivery engine.
// Source chain: host account service (no key) -> env/config API key -> clear
// unavailable reason. The state machine pushes only on level transitions; a
// single pending slot merges undelivered alerts so quiet hours / failures never
// burst-spam, and classified retries make sure none disappears silently.

import { isWebhookConfigured, withSignature } from './notify.js'
import { acquireStateLock, mergeStateFromDisk, touchStateLock } from './state.js'
import * as T from './time.js'

export const TOP_UP_URL = 'https://platform.deepseek.com/'
const RETRY_MS = 10 * 60 * 1000
const MAX_AUTO_RETRY = 3
const AMBIGUOUS_RETRY_MS = 60 * 1000
export const RECOVERY_COOLDOWN_MS = 10 * 60 * 1000

// Accepts the host ready object ({value, bonusWallets}), a bare wallet array,
// or the official REST shape ({balance_infos}). Recharge + bonus are combined,
// matching what the official account page shows as available balance.
export function normalizeWallets(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.value) ? payload.value
      : Array.isArray(payload?.balance_infos) ? payload.balance_infos : null
  if (!list) return null
  const bonus = Array.isArray(payload?.bonusWallets) ? payload.bonusWallets : []
  const sum = {}
  const add = (c, v) => { const n = Number(v); if (c && Number.isFinite(n)) sum[c] = (sum[c] || 0) + n }
  for (const w of list) add(w.currency, w.balance ?? w.total_balance)
  for (const w of bonus) add(w.currency, w.balance)
  const out = Object.entries(sum).map(([currency, total]) => ({ currency, total }))
  return out.length ? out : null
}

export const pickPrimary = (wallets) => wallets?.find((w) => w.currency === 'CNY') || wallets?.[0] || null

export const levelOf = (balance, warn, critical) =>
  balance < critical ? 'critical' : balance < warn ? 'warn' : 'normal'

export function effectiveThresholds(state, config = {}) {
  const b = config.balance || {}
  const warn = state?.prefs?.warn ?? b.warn ?? 20
  const critical = state?.prefs?.critical ?? b.critical ?? 5
  return { warn, critical }
}

export function createBalanceSource(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 15000
  const meta = {
    version: opts.version || '0.1.0',
    locale: 'zh',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
  const withTimeout = async (fn) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try { return await fn(ctrl.signal) } finally { clearTimeout(timer) }
  }
  async function viaAccount() {
    let r
    if (opts.remoteGet) r = await opts.remoteGet(meta)
    if (r === undefined && opts.accountGet) r = await opts.accountGet(meta)
    if (r === undefined) return { ok: false, reason: 'no-source' }
    if (r == null) return { ok: false, reason: 'signed-out' }
    if (r.ok === false) return { ok: false, reason: 'account-failed' }
    const payload = r.value ?? r
    if (!payload || payload.status === 'failed') return { ok: false, reason: 'account-failed' }
    const wallets = normalizeWallets(payload)
    if (!wallets) return { ok: false, reason: 'account-failed' }
    return { ok: true, source: 'account', wallets }
  }
  async function viaKey(signal) {
    const res = await fetchImpl('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json' },
      signal,
    })
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    const wallets = normalizeWallets(await res.json())
    if (!wallets) return { ok: false, reason: 'bad-response' }
    return { ok: true, source: 'key', wallets }
  }
  return async function fetchBalance() {
    if (opts.remoteGet || opts.accountGet) {
      try {
        const r = await withTimeout(() => viaAccount())
        if (r.ok || r.reason === 'signed-out' || !opts.apiKey) return r
      } catch (err) {
        if (!opts.apiKey) return { ok: false, reason: 'account-error', error: String(err?.message || err) }
      }
    }
    if (opts.apiKey) {
      try { return await withTimeout((signal) => viaKey(signal)) }
      catch (err) { return { ok: false, reason: 'network', error: String(err?.message || err) } }
    }
    return { ok: false, reason: 'no-source' }
  }
}

const sym = (c) => (c === 'USD' ? '$' : '¥')
const fmt = (n) => Number(n).toFixed(2)

export function formatAlert(kind, state, th, notify) {
  const b = state.balance || {}
  const s = sym(b.currency)
  const v = fmt(b.value ?? 0)
  const level = kind === 'current' ? state.alert.level : kind
  const head = level === 'critical'
    ? `DeepSeek 余额告急：${s}${v}，低于 ${s}${fmt(th.critical)}`
    : level === 'warn'
      ? `DeepSeek 余额预警：${s}${v}，低于 ${s}${fmt(th.warn)}`
      : `DeepSeek 余额已恢复：${s}${v}`
  const title = kind === 'current' ? `${head}（当前状态）` : head
  const lines = [`### ${title}`, '']
  if (level !== 'normal') {
    lines.push(`- 当前余额：${s}${v}`, `- 预警阈值：${s}${fmt(th.warn)} · 告急阈值：${s}${fmt(th.critical)}`)
  } else {
    lines.push(`- 当前余额：${s}${v}，高于预警阈值 ${s}${fmt(th.warn)}`)
  }
  lines.push(`- 充值：${TOP_UP_URL}`, '', '数据来源：DeepSeek 官方账户余额。')
  return { title, text: withSignature(lines.join('\n'), notify) }
}

// Decide the level transition and enqueue (supersede) the pending slot.
// Returns the transition kind or null. Never pushes here — delivery is separate
// so a failed push stays pending instead of being marked seen.
export function applyBalance(state, fr, th, nowMs) {
  const at = new Date(nowMs).toISOString()
  if (!fr.ok) {
    state.lastResult = { at, ok: false, error: fr.reason }
    state.balance = { ...state.balance, ok: false, reason: fr.reason, at }
    return null
  }
  const primary = pickPrimary(fr.wallets)
  const prevBalance = state.balance?.value
  state.balance = { value: primary.total, currency: primary.currency, at, ok: true, reason: null }
  state.lastResult = { at, ok: true, error: null }
  const level = levelOf(primary.total, th.warn, th.critical)
  const prev = state.alert.level
  if (level === prev) return null
  state.alert = { ...state.alert, level, since: at }
  if (level !== 'normal') {
    if (prev === 'normal') state.alert.episodeAt = nowMs
    state.pending = { kind: level, attempts: 0, hold: false, ambiguous: false, nextAt: nowMs, lastError: null }
    return level
  }
  // Recovery notices are for top-ups, not for threshold tweaks: only queue one
  // when the balance actually rose AND the alert episode was really delivered.
  // Otherwise the obsolete pending is silently cancelled (no noise).
  const rose = prevBalance == null || primary.total > prevBalance + 1e-9
  const delivered = (state.alert.lastPushAt || 0) >= (state.alert.episodeAt || 0) && (state.alert.lastPushAt || 0) > 0
  if (!rose || !delivered) {
    state.pending = null
    return 'recovered'
  }
  const readyAt = (state.alert.lastPushAt || 0) + RECOVERY_COOLDOWN_MS
  state.pending = { kind: 'recovered', attempts: 0, hold: false, ambiguous: false, nextAt: Math.max(nowMs, readyAt), lastError: null }
  return 'recovered'
}

// Delivery engine. Classification: ok -> clear; timeout/network (status 0) ->
// one extra attempt then hold as "delivery unconfirmed"; business/HTTP failures
// -> 10min backoff, hold after MAX_AUTO_RETRY (panel offers manual retry).
// A newer transition supersedes whatever is pending, so holds never block news.
export async function deliverPending(state, notifier, notify, nowMs, quiet, config = {}) {
  const p = state.pending
  if (!p || p.hold || quiet || nowMs < (p.nextAt || 0)) return null
  if (!isWebhookConfigured(state.webhook)) return null
  const th = effectiveThresholds(state, config)
  const { title, text } = formatAlert(p.kind, state, th, notify)
  const r = await notifier.send(state.webhook, title, text)
  if (r.ok) {
    state.alert = { ...state.alert, lastPushAt: nowMs, lastRecoveryAt: p.kind === 'recovered' ? nowMs : state.alert.lastRecoveryAt }
    state.pending = null
    return { delivered: p.kind }
  }
  p.attempts = (p.attempts || 0) + 1
  p.lastError = r.error || `HTTP ${r.status || 0}`
  if (r.status === 0) {
    if (!p.ambiguous) { p.ambiguous = true; p.nextAt = nowMs + AMBIGUOUS_RETRY_MS }
    else { p.hold = true; p.lastError = `送达未确认：${p.lastError}` }
  } else if (p.attempts >= MAX_AUTO_RETRY) {
    p.hold = true
  } else {
    p.nextAt = nowMs + RETRY_MS
  }
  return { failed: p.kind, error: p.lastError, hold: !!p.hold }
}

export function startMonitor({ fetchBalance, state, notifier, config, save, logger, onCycle }) {
  const bal = config.balance || {}
  if (bal.enabled === false) return { stop: () => {}, poke: () => {} }
  const intervalMs = Math.max(60, bal.pollSeconds ?? 60) * 1000
  const tz = T.resolveTz(bal.timezone, logger)
  let stopped = false
  let running = false
  let timer = null

  async function cycle() {
    if (stopped || running) return
    running = true
    try {
      const now = Date.now()
      // Network outside the lock: both instances may read, only one may decide.
      const fr = await fetchBalance()
      const release = acquireStateLock(logger)
      if (!release) {
        onCycle?.({ fetch: fr, skipped: true })
      } else {
        try {
          mergeStateFromDisk(state)
          const th = effectiveThresholds(state, config)
          const quiet = T.isQuietNow(bal.quiet, new Date(now), tz)
          const transition = applyBalance(state, fr, th, now)
          const delivery = await deliverPending(state, notifier, config.notify || {}, now, quiet, config)
          if (touchStateLock()) save?.(state)
          else logger?.warn?.('锁已丢失，放弃本轮写入')
          onCycle?.({ fetch: fr, transition, delivery })
        } finally {
          release()
        }
      }
    } finally {
      running = false
    }
    if (!stopped) timer = setTimeout(cycle, intervalMs)
  }

  // Panel saves (thresholds / webhook) re-evaluate now, not up to a minute later.
  const poke = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(cycle, 300)
  }

  timer = setTimeout(cycle, 3000)
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    poke,
  }
}