// Balance source chain + alert state machine + delivery engine.
// Source chain: host account service (no key) -> env/config API key -> clear
// unavailable reason. The state machine pushes only on level transitions; a
// single pending slot merges undelivered alerts so quiet hours / failures never
// burst-spam, and classified retries make sure none disappears silently.

import { isWebhookConfigured, withSignature, effectiveNotify } from './notify.js'
import { acquireStateLock, mergeStateFromDisk, touchStateLock, dataDir } from './state.js'
import * as T from './time.js'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const TOP_UP_URL = 'https://platform.deepseek.com/'
const RETRY_MS = 10 * 60 * 1000
const MAX_AUTO_RETRY = 3
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
  // The panel refuses an inverted pair, but the YAML cannot: rejecting the whole
  // profile would disable the plugin, so the merged pair is normalised here — the
  // one place every consumer (classification, receipts, /status, panel) reads it.
  // `warn` is the higher line by definition, so an inverted pair is swapped into
  // the only coherent reading; non-positive values fall back to the defaults.
  // An equal pair cannot be repaired by swapping and has no coherent reading of
  // its own (a balance just under the line would jump straight to critical,
  // skipping warn), so it falls back to the defaults too — and /status flags it
  // (thresholdsMisconfigured) so the panel can tell the user to fix the config.
  let warn = state?.prefs?.warn ?? b.warn ?? 20
  let critical = state?.prefs?.critical ?? b.critical ?? 5
  if (!(warn > 0) || !(critical > 0) || warn === critical) return { warn: 20, critical: 5 }
  if (critical > warn) [warn, critical] = [critical, warn]
  return { warn, critical }
}

// The one invalid shape the normaliser cannot repair by swapping: warn equal to
// critical. Everything else loads as a coherent pair, so only equality is worth
// surfacing in /status.
export function thresholdsMisconfigured(state, config = {}) {
  const b = config.balance || {}
  const warn = state?.prefs?.warn ?? b.warn ?? 20
  const critical = state?.prefs?.critical ?? b.critical ?? 5
  return warn > 0 && critical > 0 && warn === critical
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
    let timer
    // The host account promise may never settle; aborting the controller does
    // nothing to it, so the deadline must win the race on its own.
    const deadline = new Promise((_, rej) => {
      timer = setTimeout(() => { ctrl.abort(); rej(new Error(`timeout after ${timeoutMs}ms`)) }, timeoutMs)
    })
    try { return await Promise.race([fn(ctrl.signal), deadline]) } finally { clearTimeout(timer) }
  }
  async function viaAccount() {
    let r
    if (opts.remoteGet) r = await opts.remoteGet(meta)
    if (r === undefined && opts.accountGet) r = await opts.accountGet(meta)
    if (r === undefined) return { ok: false, reason: 'no-source' }
    if (r == null) return { ok: false, reason: 'signed-out' }
    if (r.ok === false) return { ok: false, reason: 'account-failed' }
    // Envelope {ok, value: ready} vs direct ready {status, value: wallets,
    // bonusWallets}: only unwrap when value is itself an object — unwrapping a
    // wallet array would drop the bonusWallets sitting next to it.
    const inner = r && typeof r === 'object' && !Array.isArray(r) ? r.value : undefined
    const payload = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : r
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
        // A signed-out host is precisely the case the key fallback exists for:
        // README promises "host account when signed in, otherwise the key", so
        // only short-circuit when no key can answer. Reporting signed-out while
        // a key is configured would leave the monitor with no usable source.
        if (r.ok || !opts.apiKey) return r
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

export function formatAlert(kind, state, th, notify, cause) {
  const b = state.balance || {}
  const s = sym(b.currency)
  const v = fmt(b.value ?? 0)
  const level = kind === 'current' ? state.alert.level : kind === 'recovered' ? 'normal' : kind
  const resolved = kind === 'recovered' && cause === 'threshold'
  // Keep the plugin name on every title, not just on the test push: with the
  // install footer now opt-in, a forwarded alert has no other way to say where
  // it came from. The prefix is short enough to survive IM title truncation.
  const head = level === 'critical'
    ? `余额哨兵 · DeepSeek 余额告急：${s}${v}，低于 ${s}${fmt(th.critical)}`
    : level === 'warn'
      ? `余额哨兵 · DeepSeek 余额预警：${s}${v}，低于 ${s}${fmt(th.warn)}`
      : resolved
        ? `余额哨兵 · DeepSeek 余额告警已解除：${s}${v}`
        : `余额哨兵 · DeepSeek 余额已恢复：${s}${v}`
  const title = kind === 'current' ? `${head}（当前状态）` : head
  const lines = [`### ${title}`, '']
  if (level !== 'normal') {
    lines.push(`- 当前余额：${s}${v}`, `- 预警阈值：${s}${fmt(th.warn)} · 告急阈值：${s}${fmt(th.critical)}`)
  } else {
    lines.push(`- 当前余额：${s}${v}，高于预警阈值 ${s}${fmt(th.warn)}`)
    if (resolved) lines.push(`- 解除原因：阈值调整（预警 ${s}${fmt(th.warn)} · 告急 ${s}${fmt(th.critical)}），余额高于新预警阈值`)
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
  // Recovery notices close a delivered episode: a real top-up waits out the
  // anti-flap cooldown; a threshold tweak that resolves the alert notifies
  // immediately (user-initiated, no flap risk). Undelivered episodes cancel
  // silently — there is nothing to close.
  const rose = prevBalance == null || primary.total > prevBalance + 1e-9
  const delivered = (state.alert.lastPushAt || 0) >= (state.alert.episodeAt || 0) && (state.alert.lastPushAt || 0) > 0
  if (!delivered) {
    state.pending = null
    return 'recovered'
  }
  if (!rose) {
    state.pending = { kind: 'recovered', cause: 'threshold', attempts: 0, hold: false, ambiguous: false, nextAt: nowMs, lastError: null }
    return 'recovered'
  }
  const readyAt = (state.alert.lastPushAt || 0) + RECOVERY_COOLDOWN_MS
  state.pending = { kind: 'recovered', cause: 'topup', attempts: 0, hold: false, ambiguous: false, nextAt: Math.max(nowMs, readyAt), lastError: null }
  return 'recovered'
}

// Delivery engine. Classification comes from the notifier, not the HTTP status
// alone: timeout/uncertain (request or body died mid-flight) may already have
// landed -> hold immediately, manual retry only; retryable (platform answered
// with a failure) -> 10min backoff, hold after MAX_AUTO_RETRY. A newer transition
// supersedes whatever is pending, so holds never block news.
export async function deliverPending(state, notifier, notify, nowMs, quiet, config = {}) {
  const p = state.pending
  if (!p || p.hold || quiet || nowMs < (p.nextAt || 0)) return null
  if (!isWebhookConfigured(state.webhook)) return null
  // A failed poll keeps the last known number in state.balance but flags it
  // ok:false. Sending now would print that old figure as the current one, so the
  // alert stays pending and is re-classified by the next successful reading —
  // it is neither dropped nor delivered against a stale balance.
  if (!state.balance?.ok) return null
  const th = effectiveThresholds(state, config)
  const { title, text } = formatAlert(p.kind, state, th, notify, p.cause)
  let r
  try {
    r = await notifier.send(state.webhook, title, text)
  } catch (err) {
    r = { ok: false, status: 0, timeout: false, retryable: true, error: String(err?.message || err) }
  }
  if (r.ok) {
    state.alert = { ...state.alert, lastPushAt: nowMs, lastRecoveryAt: p.kind === 'recovered' ? nowMs : state.alert.lastRecoveryAt }
    state.pending = null
    return { delivered: p.kind }
  }
  p.attempts = (p.attempts || 0) + 1
  p.lastError = r.error || `HTTP ${r.status || 0}`
  if (r.timeout) {
    p.hold = true
    p.ambiguous = true
    p.lastError = `送达未确认：${p.lastError}`
  } else if (r.retryable === false || p.attempts >= MAX_AUTO_RETRY) {
    p.hold = true
  } else {
    p.nextAt = nowMs + RETRY_MS
  }
  return { failed: p.kind, error: p.lastError, hold: !!p.hold, ambiguous: !!p.ambiguous }
}

// ---- delivery receipt ------------------------------------------------------
// A push whose outcome the disk does not record needs a lock-free side note,
// because the state save can fail right after the webhook call. Two outcomes:
//  - delivered: the push landed but the save did not, so the disk is behind the
//    delivered transition (level + episode + lastPushAt).
//  - uncertain: the push timed out / died mid-flight, so it may already have
//    landed. A restore must keep hold+ambiguous and must NOT stamp lastPushAt,
//    otherwise the next poll, a restart or another instance treats the episode
//    as new and auto re-sends the same alert.
// Either note is read at the start of a cycle — same process, another instance,
// or after a restart — and cleared as soon as a save succeeds and the disk is
// authoritative again. If neither the state nor this note can be written, the
// duplicate risk is logged instead of being silently assumed away.
const receiptPath = () => join(dataDir(), 'delivery-receipt.json')
const RECEIPT_LEVELS = new Set(['normal', 'warn', 'critical'])
const RECEIPT_KINDS = new Set(['warn', 'critical', 'recovered', 'current'])

function writeReceipt(state, kind, opts = {}) {
  const base = {
    kind, level: state.alert.level, since: state.alert.since || null,
    episodeAt: state.alert.episodeAt || 0, at: Date.now(),
  }
  const body = opts.uncertain
    ? { ...base, status: 'uncertain', attempts: opts.pending?.attempts || 0, lastError: opts.pending?.lastError || null }
    : {
      ...base, status: 'delivered',
      lastPushAt: state.alert.lastPushAt || 0, lastRecoveryAt: state.alert.lastRecoveryAt || 0,
    }
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    writeFileSync(receiptPath(), JSON.stringify(body), 'utf8')
    return true
  } catch { return false }
}

function readReceipt() {
  try {
    const r = JSON.parse(readFileSync(receiptPath(), 'utf8'))
    if (!r || typeof r !== 'object' || !RECEIPT_LEVELS.has(r.level) || !RECEIPT_KINDS.has(r.kind)) return null
    if (r.status === 'uncertain') return r
    if (!Number.isFinite(r.lastPushAt) || r.lastPushAt <= 0) return null
    return r
  } catch { return null }
}

function clearReceipt() { try { unlinkSync(receiptPath()) } catch { /* absent */ } }

// Apply a note to the in-memory state. Returns false when the disk already moved
// past it, so the caller can drop a stale note instead of resurrecting it.
// `since` is the last level-change stamp: the failing save left the disk on the
// pre-transition level, so a note at or after it still describes reality.
function applyReceipt(state, r) {
  if (r.status === 'uncertain') {
    if (String(r.since || '') < String(state.alert.since || '')) return false
    state.alert = {
      ...state.alert, level: r.level, since: r.since || state.alert.since || null,
      episodeAt: r.episodeAt || 0,
    }
    state.pending = {
      kind: r.kind, attempts: Number(r.attempts) || 1, hold: true, ambiguous: true,
      nextAt: 0, lastError: r.lastError || '送达未确认（按备用回执恢复）',
    }
    return true
  }
  if (!(r.lastPushAt > (state.alert.lastPushAt || 0))) return false
  // Restore the delivered transition — not just the pending slot — so
  // applyBalance sees the episode as already communicated and neither
  // re-creates nor re-sends it. A genuinely newer transition still fires.
  state.alert = {
    ...state.alert, level: r.level, episodeAt: r.episodeAt || 0,
    lastPushAt: r.lastPushAt, lastRecoveryAt: r.lastRecoveryAt || 0,
  }
  state.pending = null
  return true
}

export function startMonitor({ fetchBalance, state, notifier, config, save, logger, onCycle }) {
  const bal = config.balance || {}
  if (bal.enabled === false) return { stop: () => {}, poke: () => {} }
  // One poll per minute is the production floor. Overridable the way the lock TTL
  // is (see SENTINEL_LOCK_TTL_MS), so a test can watch several cycles in seconds;
  // production never sets it.
  const floorSec = Number(process.env.SENTINEL_POLL_FLOOR_SEC) || 60
  const intervalMs = Math.max(floorSec, bal.pollSeconds ?? 60) * 1000
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
      // Stopping wins over a query that was already in flight: a monitor that was
      // switched off must not push, record or persist whatever comes back after
      // shutdown. (The request itself cannot be cancelled here.)
      if (stopped) return
      const release = acquireStateLock(logger)
      if (!release) {
        onCycle?.({ fetch: fr, skipped: true })
      } else {
        try {
          mergeStateFromDisk(state)
          // A reading is only as new as the cycle that started the query. Another
          // instance (or a poke that ran while this fetch was in flight) may have
          // recorded one that was issued later and answered first; applying this
          // response would roll the balance back and could re-fire a transition or
          // push from a number the user has already left behind. Drop it entirely:
          // no write, no state change, no delivery.
          // The comparison is `>=` on purpose: the stamp has millisecond
          // resolution, so two instances can issue their queries inside the same
          // millisecond and neither is "older". Whoever recorded first is what
          // the panel already shows, so a tie is treated as superseded too — the
          // alternative is a same-millisecond reply rolling ¥30 back to ¥3.
          const recorded = Date.parse(String(state.lastResult?.at || ''))
          if (Number.isFinite(recorded) && recorded >= now) {
            onCycle?.({ fetch: fr, skipped: true, stale: true })
            return
          }
          // A save failure leaves the disk behind the last webhook call. The
          // note restores either the delivered transition or the uncertain hold
          // (disk still behind, possibly another instance or a restart).
          const receipt = readReceipt()
          if (receipt && !applyReceipt(state, receipt)) clearReceipt() // disk already authoritative
          const th = effectiveThresholds(state, config)
          const quiet = T.isQuietNow(bal.quiet, new Date(now), tz)
          const transition = applyBalance(state, fr, th, now)
          // Merge the panel toggle over the YAML config in one place, so a flip
          // applies to every alert and recovery sent afterwards.
          const delivery = await deliverPending(state, notifier, effectiveNotify(config.notify, state), now, quiet, config)
          let saved = false
          if (touchStateLock()) {
            try { saved = save?.(state) !== false } catch (err) { logger?.warn?.(`状态保存异常：${err?.message || err}`) }
          } else {
            logger?.warn?.('锁已丢失，放弃本轮写入')
          }
          if (saved) {
            clearReceipt()
          } else if (delivery?.delivered) {
            if (!writeReceipt(state, delivery.delivered)) {
              logger?.warn?.('送达回执落盘失败：状态恢复前若重启，本条可能重发')
            }
          } else if (delivery?.ambiguous) {
            // The push may already have landed and the disk still holds the
            // pre-send state. Record the held pending instead of a delivery, so
            // a restore keeps hold/ambiguous and cannot be read as "sent".
            if (!writeReceipt(state, delivery.failed, { uncertain: true, pending: state.pending })) {
              logger?.warn?.('送达不确定，且状态与备用回执均无法落盘：重启或另一实例接管后可能重复推送该告警，去重无法保证')
            }
          } else {
            logger?.warn?.('本轮状态未持久化：下轮、重启或另一实例将按磁盘状态重新判定，未确认送达的告警可能重发')
          }
          onCycle?.({ fetch: fr, transition, delivery, saved })
        } finally {
          release()
        }
      }
    } catch (err) {
      // Query/notify/save threw: log and keep scheduling instead of wedging.
      logger?.warn?.(`监控周期异常：${err?.message || err}`)
      onCycle?.({ error: String(err?.message || err) })
    } finally {
      running = false
      // Re-arm from the finally, never from the happy path: a cycle can return
      // early (a superseded reading, a stop that raced the query) and that must
      // not leave the monitor with no next poll. A silently frozen instance looks
      // exactly like a healthy one until the balance moves.
      if (!stopped) timer = setTimeout(cycle, intervalMs)
    }
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