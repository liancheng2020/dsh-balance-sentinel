// Local, host-side persistence for balance-sentinel state and webhook config.
// Data lives under $DSH_HOME/balance-sentinel (default ~/.dsh/balance-sentinel), never uploaded.
// NOTE: webhook URL is stored locally in plaintext; a future hardening can move it
// to the dsh-credentials service. The directory is created 0o700.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

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
    // Legacy footer preference from the removed panel switch. Only `false` is
    // still read (an explicit "never append"); `true` and `null` now mean nothing
    // because there is no built-in line left to enable.
    notify: { signature: null },
    balance: { value: null, currency: null, at: null, ok: false, reason: null },
    lastResult: { at: null, ok: false, error: null },
    // Last panel "send test" outcome. Configuring a webhook proves nothing about
    // delivery, so the panel needs this to say "configured, untested" instead of
    // implying the channel works. Cleared whenever the channel/url/secret changes.
    verify: null, // { at, ok, channel, error }
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
  const rawVerify = parsed.verify
  // `fp` pins the verdict to the webhook it ran against; `persisted` is only
  // false for a verdict that lives in memory and will be lost on restart. A
  // record read back from disk was obviously persisted, so it defaults to true.
  const verify = rawVerify && typeof rawVerify === 'object' && typeof rawVerify.ok === 'boolean'
    ? {
      at: Number(rawVerify.at) || null,
      ok: rawVerify.ok,
      channel: String(rawVerify.channel || ''),
      error: rawVerify.error ? String(rawVerify.error) : null,
      fp: rawVerify.fp ? String(rawVerify.fp) : null,
      persisted: rawVerify.persisted !== false,
    }
    : null
  return {
    ...d,
    ...parsed,
    webhook: { ...d.webhook, ...(parsed.webhook || {}) },
    alert,
    pending,
    prefs: { warn: numOrNull(parsed.prefs?.warn), critical: numOrNull(parsed.prefs?.critical) },
    // Anything that is not a real boolean means "nothing recorded"; `true` is kept
    // only so an old file round-trips, and nothing reads it any more.
    notify: { signature: parsed.notify?.signature === true ? true : parsed.notify?.signature === false ? false : null },
    balance: { ...d.balance, ...(parsed.balance || {}) },
    lastResult: { ...d.lastResult, ...(parsed.lastResult || {}) },
    verify,
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

// Age of a lock file plus what could be read from it. The heartbeat stamp is the
// best evidence while the payload parses; one that does not parse at all (a
// crash between create and write, a truncated write, a full disk) falls back to
// the filesystem mtime — the only honest signal left, and exactly what keeps a
// lock created a moment ago from being stolen while it is still being filled in.
// Returns null when there is no lock file at all.
function lockState(lp) {
  let stat
  try { stat = statSync(lp) } catch { return null }
  const cur = readLockFile(lp)
  const ts = Number(cur?.ts)
  const stamped = Number.isFinite(ts) && ts > 0 ? ts : null
  const age = stamped == null ? Date.now() - (Number(stat.mtimeMs) || 0) : Date.now() - stamped
  return { age, cur, readable: stamped != null }
}

// The takeover guard has the same failure mode as the lock: a crashed takeover
// leaves a file behind, and a half-written one must not block every later
// attempt. Age it the same way.
function guardAge(guard) {
  const cur = readLockFile(guard)
  const ts = Number(cur?.ts)
  if (Number.isFinite(ts) && ts > 0) return Date.now() - ts
  try { return Date.now() - (Number(statSync(guard).mtimeMs) || 0) } catch { return Infinity }
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
    if (guardAge(guard) > 5000) { try { unlinkSync(guard) } catch { /* raced away */ } }
    return false
  }
  try {
    const cur = lockState(lp)
    // No file (it vanished between attempts), or a holder younger than the TTL:
    // leave it alone. An unreadable file only qualifies once its mtime is older
    // than the TTL, i.e. older than any live cycle could need to write it.
    if (!cur || cur.age <= LOCK_TTL_MS) return false
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
  if (takeOverStaleLock(lp, stamp)) {
    logger?.info?.('已接管超时锁：原持有者既不更新心跳也不释放，按崩溃处理')
    lockDepth = 1
    startHeartbeat()
    return true
  }
  const info = lockState(lp)
  const pid = Number(info?.cur?.pid) || 0
  logger?.warn?.(pid
    ? `state.json 被进程 ${pid} 锁定，本次跳过（避免重复推送）`
    : info && !info.readable
      ? 'state.json 锁文件不可读但仍在有效期内（可能刚创建、尚未写完），本次跳过'
      : 'state.json 锁定冲突且锁文件已消失，本次跳过')
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

// True while this process is inside a monitor cycle (merge -> push -> write).
// The lock is re-entrant in-process, so panel writes use this to refuse
// pending-owning mutations during a send instead of overwriting the in-flight
// slot through the shared object.
export function stateLockHeld() {
  return lockDepth > 0
}

// Refresh the timestamp so a long cycle is not taken over. Returns false once
// the lock is no longer ours (the caller must then abandon its write).
export function touchStateLock() {
  if (lockDepth === 0) return false
  if (!ownsLock()) return false
  try { writeFileSync(lockPath(), lockStamp(), 'utf8') } catch { return false }
  return true
}

// Identity of a webhook config that can travel through state and /status
// without exposing the url/secret. A test verdict only describes the endpoint it
// ran against, so this pins one to the other. Lives here because both the bridge
// (writing verdicts) and the merge below (validating them) need the same value.
export function webhookFingerprint(wh) {
  return createHash('sha256')
    .update(`${wh?.channel || 'none'}|${wh?.url || ''}|${wh?.secret || ''}`)
    .digest('hex')
    .slice(0, 16)
}

// Which verdict survives when memory and disk disagree. A verdict that never
// reached the file is newer than the one the file still holds, so it keeps
// winning while it is at least as recent; an already-persisted one is the file's
// to decide (another instance may have tested in the meantime).
function pickVerify(mine, theirs) {
  const keepMine = !!mine && mine.persisted === false
    && Number(mine.at || 0) >= Number(theirs?.at || 0)
  return keepMine ? mine : (theirs ?? null)
}

// A verdict only describes the webhook it was produced from: once the
// channel/url/secret changes, it is meaningless and must be dropped. Both merge
// paths (read-from-disk and write-to-disk) go through here so neither can keep a
// verdict alive across a config change.
function reconcileVerify(mine, theirs, webhook) {
  // Filter by channel first, then compare times. Picking by time first and
  // discarding afterwards loses a valid record: a newer unpersisted verdict for
  // the OLD webhook would win the race and then be thrown away, taking the
  // file's perfectly good result for the CURRENT webhook with it.
  const fp = webhookFingerprint(webhook)
  const usable = (v) => (v && (!v.fp || v.fp === fp) ? v : null)
  return pickVerify(usable(mine), usable(theirs))
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
  // The legacy footer preference is panel-owned too: an older build may have
  // recorded an explicit "off" while this instance was idle, and reading stale
  // memory would drop that opt-out.
  if (disk.notify && typeof disk.notify === 'object') state.notify = { ...(state.notify || {}), ...disk.notify }

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
  // A verdict that could not be written lives only in memory; the file still
  // holds the one before it. Taking the file unconditionally would resurrect an
  // old green "succeeded" over a newer failed test the user just watched fail.
  if (disk.verify !== undefined) state.verify = reconcileVerify(state.verify, disk.verify, state.webhook)
  else if (state.verify?.fp && state.verify.fp !== webhookFingerprint(state.webhook)) state.verify = null
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
// `notify` is panel-owned like webhook/prefs: a monitor save from an instance
// that still holds an older copy must take the file's, or simply saving a
// balance would drop a recorded "never append" opt-out.
const SECTIONS = [...OWN_RUNTIME, 'webhook', 'prefs', 'verify', 'notify']

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
  // Same rule as the read path: an unwritten newer verdict must not be replaced
  // by the older one still in the file when the caller re-writes some other
  // section (a monitor cycle), or the panel's red "failed" reverts to green.
  if (!own.has('verify')) out.verify = reconcileVerify(state.verify, disk.verify ?? null, out.webhook)
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
    // `persisted` describes the in-memory copy, not the document: anything that
    // reaches the file has by definition been persisted, so the flag is dropped
    // here. A write that throws never gets this far, so memory keeps saying
    // "not persisted" exactly when that is still true.
    if (next.verify && 'persisted' in next.verify) {
      const written = { ...next.verify }
      delete written.persisted
      next.verify = written
    }
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