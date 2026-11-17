// Local, host-side persistence for balance-sentinel state and webhook config.
// Data lives under $DSH_HOME/balance-sentinel (default ~/.dsh/balance-sentinel), never uploaded.
// NOTE: webhook URL is stored locally in plaintext; a future hardening can move it
// to the dsh-credentials service. The directory is created 0o700.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function resolveHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

export function dataDir() {
  return join(resolveHome(), 'balance-sentinel')
}

const LEVELS = new Set(['normal', 'warn', 'critical'])
const KINDS = new Set(['warn', 'critical', 'recovered', 'current'])

function defaultState() {
  return {
    version: 1,
    webhook: { channel: 'none', url: '', secret: '' },
    alert: { level: 'normal', since: null, episodeAt: 0, lastPushAt: 0, lastRecoveryAt: 0 },
    // Single pending slot = merged current state: a newer transition supersedes
    // an undelivered older one, so quiet hours / failures never burst-spam.
    pending: null, // { kind, attempts, hold, ambiguous, nextAt, lastError }
    prefs: { warn: null, critical: null }, // panel overrides; null = config decides
    balance: { value: null, currency: null, at: null, ok: false, reason: null },
    lastResult: { at: null, ok: false, error: null },
    actor: randomUUID(),
  }
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

function normalize(parsed) {
  const d = defaultState()
  const alert = { ...d.alert, ...(parsed.alert || {}) }
  if (!LEVELS.has(alert.level)) alert.level = 'normal'
  const p = parsed.pending
  const pending = p && typeof p === 'object' && KINDS.has(p.kind)
    ? { kind: p.kind, attempts: Number(p.attempts) || 0, hold: !!p.hold, ambiguous: !!p.ambiguous, nextAt: Number(p.nextAt) || 0, lastError: p.lastError || null }
    : null
  return {
    ...d,
    ...parsed,
    webhook: { ...d.webhook, ...(parsed.webhook || {}) },
    alert,
    pending,
    prefs: { warn: numOrNull(parsed.prefs?.warn), critical: numOrNull(parsed.prefs?.critical) },
    balance: { ...d.balance, ...(parsed.balance || {}) },
    lastResult: { ...d.lastResult, ...(parsed.lastResult || {}) },
  }
}

export function loadState(logger) {
  const file = join(dataDir(), 'state.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return defaultState() // missing file = fresh install, not a failure
  }
  try {
    return normalize(JSON.parse(raw))
  } catch (err) {
    try {
      const bak = join(dataDir(), `state.corrupt-${Date.now()}.json`)
      renameSync(file, bak)
      logger?.warn?.(`state.json 损坏，已备份到 ${bak} 并回落默认值：${String(err?.message || err)}`)
    } catch (e) {
      logger?.warn?.(`state.json 损坏且备份失败，回落默认值：${String(err?.message || err)}`)
    }
    return defaultState()
  }
}

// ---- cross-process lock -----------------------------------------------------
// A desktop and a web profile opened together share one DSH_HOME. The lock is
// held for a whole monitor cycle (merge -> decide -> push -> write), not just
// for the write: two processes that each read the same balance and only
// serialise their writes would still both push the same transition.
// A lock older than 60s is treated as stale (holder crashed). While it is held
// a heartbeat rewrites the timestamp every LOCK_TTL_MS/4, so a cycle pushing
// several chunks for minutes still cannot be mistaken for a dead holder.
// Overridable so the concurrency test can watch a TTL expire in seconds instead
// of minutes; production never sets these.
const LOCK_TTL_MS = Number(process.env.SENTINEL_LOCK_TTL_MS) || 60000
const LOCK_HEARTBEAT_MS = Math.max(50, Math.floor(LOCK_TTL_MS / 4))
const lockPath = () => join(dataDir(), 'state.json.lock')
const takeoverPath = () => join(dataDir(), 'state.json.lock.takeover')

let lockDepth = 0
let lockToken = null
let heartbeat = null

const lockStamp = () => JSON.stringify({ pid: process.pid, ts: Date.now(), token: lockToken })

function readLockFile(lp) {
  try {
    const j = JSON.parse(readFileSync(lp, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

// True only while the file still carries our token: a lock that expired and was
// taken over belongs to the new holder, and the old one must stop writing.
function ownsLock() {
  if (lockDepth === 0) return false
  const cur = readLockFile(lockPath())
  return !!cur && cur.token === lockToken
}

function startHeartbeat() {
  if (heartbeat) return
  heartbeat = setInterval(() => { touchStateLock() }, LOCK_HEARTBEAT_MS)
  heartbeat.unref?.() // never keep the process alive just for the lock
}

function stopHeartbeat() {
  if (!heartbeat) return
  clearInterval(heartbeat)
  heartbeat = null
}

// Two instances can both see a stale lock. A short-lived guard file makes the
// takeover itself exclusive, and the token re-read makes a lost race harmless.
function takeOverStaleLock(lp, stamp) {
  const guard = takeoverPath()
  try {
    writeFileSync(guard, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
  } catch {
    // A crashed takeover must not wedge every future one.
    try {
      const g = JSON.parse(readFileSync(guard, 'utf8'))
      if (Date.now() - (g?.ts || 0) > 5000) unlinkSync(guard)
    } catch { /* still held by a live process */ }
    return false
  }
  try {
    const cur = readLockFile(lp)
    if (!cur || Date.now() - (cur.ts || 0) < LOCK_TTL_MS) return false
    try { writeFileSync(lp, stamp, 'utf8') } catch { return false }
    const after = readLockFile(lp)
    return !!after && after.token === lockToken
  } finally {
    try { unlinkSync(guard) } catch { /* already gone */ }
  }
}

function acquireLock(logger) {
  if (lockDepth > 0) { lockDepth++; return true } // re-entrant within one process
  try { mkdirSync(dataDir(), { recursive: true, mode: 0o700 }) } catch { /* surfaced on write */ }
  const lp = lockPath()
  lockToken = randomUUID()
  const stamp = lockStamp()
  try {
    writeFileSync(lp, stamp, { flag: 'wx' }) // exclusive create
    lockDepth = 1
    startHeartbeat()
    return true
  } catch { /* lock exists: maybe stale */ }
  if (takeOverStaleLock(lp, stamp)) { lockDepth = 1; startHeartbeat(); return true }
  const cur = readLockFile(lp)
  logger?.warn?.(cur?.pid
    ? `state.json 被进程 ${cur.pid} 锁定，本次跳过（避免重复推送）`
    : 'state.json 锁定冲突且无法读取锁文件，本次跳过')
  lockToken = null
  return false
}

function releaseLock() {
  if (lockDepth === 0) return
  lockDepth--
  if (lockDepth > 0) return
  stopHeartbeat()
  const lp = lockPath()
  const cur = readLockFile(lp)
  // Only remove the lock we still own (a stale takeover may have replaced it).
  if (!cur || cur.token === lockToken) {
    try { unlinkSync(lp) } catch { /* already gone */ }
  }
  lockToken = null
}

// Acquire the shared lock. Returns a release function, or null when another
// process holds it (caller must then skip this cycle rather than push anyway).
export function acquireStateLock(logger) {
  if (!acquireLock(logger)) return null
  let released = false
  return () => {
    if (released) return
    released = true
    releaseLock()
  }
}

// Refresh the timestamp so a long cycle is not taken over. Returns false once
// the lock is no longer ours (the caller must then abandon its write).
export function touchStateLock() {
  if (lockDepth === 0) return false
  if (!ownsLock()) return false
  try { writeFileSync(lockPath(), lockStamp(), 'utf8') } catch { return false }
  return true
}

// Re-read the shared state while holding the lock. The in-memory copy may be
// minutes old (and the panel may have saved a new webhook from the other
// instance meanwhile), so writing it back untouched would both lose that edit
// and re-push alerts the other instance already delivered.
export function mergeStateFromDisk(state) {
  const disk = readDiskState()
  if (!disk) return false

  // Panel-owned config: the file is the single source of truth.
  if (disk.webhook && typeof disk.webhook === 'object') state.webhook = { ...state.webhook, ...disk.webhook }
  if (disk.prefs && typeof disk.prefs === 'object') state.prefs = { ...(state.prefs || {}), ...disk.prefs }

  // alert/pending are a keyed state machine, not an additive set: pending is
  // deleted when the push finally succeeds. Unioning the in-memory copy would
  // put a deleted pending back, so the file is authoritative here.
  if (disk.alert && typeof disk.alert === 'object') state.alert = { ...state.alert, ...disk.alert }
  state.pending = disk.pending && typeof disk.pending === 'object' ? disk.pending : null
  if (disk.balance && typeof disk.balance === 'object') {
    if (!state.balance?.at || String(disk.balance.at || '') >= String(state.balance.at || '')) state.balance = disk.balance
  }
  if (disk.lastResult && typeof disk.lastResult === 'object') {
    if (!state.lastResult?.at || String(disk.lastResult.at || '') >= String(state.lastResult.at || '')) state.lastResult = disk.lastResult
  }
  return true
}

function readDiskState() {
  try {
    const disk = JSON.parse(readFileSync(join(dataDir(), 'state.json'), 'utf8'))
    return disk && typeof disk === 'object' ? disk : null
  } catch { return null }
}

// Sections a caller can own. The monitor owns the runtime ones; the panel owns
// the webhook and the threshold prefs.
const OWN_RUNTIME = ['alert', 'pending', 'balance', 'lastResult']
const SECTIONS = [...OWN_RUNTIME, 'webhook', 'prefs']

// Compose the document to write. A section the caller does not own is taken from
// the file verbatim — never merged with the caller's memory. Merging looks safer
// but resurrects what the owner deliberately deleted (a pending cleared by a
// successful delivery), and the stale copy then keeps re-adding it on every
// unrelated save.
function mergeForWrite(disk, state, own) {
  if (!disk) return { ...state }
  const out = { ...disk, ...state }
  for (const section of SECTIONS) {
    if (!own.has(section) && disk[section] !== undefined) out[section] = disk[section]
  }
  out.actor = disk.actor || state.actor
  out.version = disk.version ?? state.version
  return out
}

function applyState(target, next) {
  for (const k of Object.keys(next)) target[k] = next[k]
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k]
}

// `own` names the sections this caller just changed. Everything else is merged
// from a fresh read inside the lock, so no write path can publish a stale view
// of another instance's alert state or configuration.
export function saveState(state, logger, opts = {}) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!acquireLock(logger)) return false
  try {
    if (!ownsLock()) {
      logger?.warn?.('state.json 锁已被其他进程接管，本次放弃写入（避免覆盖新状态）')
      return false
    }
    const next = mergeForWrite(readDiskState(), state, new Set(opts.own || OWN_RUNTIME))
    const file = join(dir, 'state.json')
    const tmp = join(dir, `.state-${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* POSIX only; ignore on Windows */ }
    // Keep this instance aligned with what is on disk, so its next save starts
    // from the truth instead of from the snapshot it happened to be holding.
    applyState(state, next)
    return true
  } finally {
    releaseLock()
  }
}