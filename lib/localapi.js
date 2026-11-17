// Loopback-only HTTP bridge so the sidebar panel can show balance/alert state,
// save webhook + thresholds and trigger test pushes. Binds 127.0.0.1; never
// returns the webhook url or secret. CORS is not '*' for blocked origins — a
// random page must not be able to repoint someone's webhook or spam their IM.
// Degrades gracefully: if the port is taken or the client can't reach it, the
// panel shows the reason and a manual state.json path.

import http from 'node:http'
import { withSignature, isWebhookConfigured as configured } from './notify.js'
import { effectiveThresholds } from './balance.js'
import { mergeStateFromDisk } from './state.js'

export const LOCAL_API_PORT = 17430

const CHANNELS = new Set(['none', 'wecom', 'dingtalk', 'feishu', 'bark', 'serverchan', 'telegram', 'generic'])
const MAX_URL = 2048
const MAX_BODY = 8192

// Show only the host so the panel can confirm the endpoint without exposing it.
function hostOf(wh) {
  if (!wh?.url) return ''
  if (wh.channel === 'telegram') return 'api.telegram.org'
  try { return new URL(wh.url).host } catch { return '' }
}

// Loopback origins (dev server / desktop webview) plus opaque origins — a
// file:// page or a custom app scheme arrives as the literal "null".
function originAllowed(origin) {
  if (!origin || origin === 'null') return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  } catch { return false }
}

// A non-http(s) scheme is the host shell itself (dsh-app://app, tape://…).
// It always looks "cross-site" to the browser when it calls 127.0.0.1, so the
// Sec-Fetch-Site rule must not apply to it.
function shellOrigin(origin) {
  if (!origin || origin === 'null') return false
  try {
    const u = new URL(origin)
    return u.protocol !== 'http:' && u.protocol !== 'https:'
  } catch { return false }
}

const fail = (code, message) => ({ ok: false, code, message })
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0, raw = ''
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { resolve(null); req.destroy(); return }
      raw += chunk
    })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}

// Validate the panel submission before it touches state (never trust the client).
function validate(body) {
  const channel = String(body?.channel || '').trim()
  if (!CHANNELS.has(channel)) return { error: fail('bad-channel', '不支持的推送通道') }
  if (channel === 'none') return { value: { channel: 'none', url: '', secret: '' } }

  const url = String(body?.url ?? '').trim()
  if (!url) return { error: fail('bad-url', channel === 'telegram' ? '请填写 Bot Token' : '请填写 webhook 地址') }
  if (url.length > MAX_URL) return { error: fail('bad-url', `地址过长（上限 ${MAX_URL} 字符）`) }

  if (channel === 'telegram') {
    if (!/^[A-Za-z0-9_:.-]{8,200}$/.test(url)) return { error: fail('bad-url', 'Bot Token 格式不正确，形如 123456789:AA...') }
    const chat = String(body?.secret ?? '').trim()
    if (!chat) return { error: fail('bad-secret', '请填写 chat_id') }
    return { value: { channel, url, secret: chat } }
  }

  let parsed
  try { parsed = new URL(url) } catch { return { error: fail('bad-url', '地址格式不正确，需要以 http(s):// 开头') } }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: fail('bad-url', '只支持 http/https 地址') }
  const secret = channel === 'dingtalk' ? String(body?.secret ?? '').trim().slice(0, 256) : ''
  return { value: { channel, url, secret } }
}

// Turn a platform business code into a next step the user can act on.
function hintFor(channel, code, error, status) {
  const e = String(error || '')
  const c = code == null ? '' : String(code)
  if (/no webhook configured/.test(e)) return '先在面板里选择通道并保存地址'
  if (/webhook url empty/.test(e)) return '请补全 webhook 地址后重试'
  if (status === 0) return '网络不可达：确认本机能访问该地址（或被代理/防火墙拦截）'
  if (channel === 'wecom') {
    if (c === '93000') return 'Webhook 地址无效或机器人已被移除，请在群机器人里重新获取'
    if (c === '45009') return '发送太频繁，等几分钟再试'
  }
  if (channel === 'dingtalk') {
    if (c === '300001') return 'access_token 无效，请重新复制机器人 Webhook'
    if (c === '310000') return '加签或关键词校验未通过：核对加签密钥，或给机器人设置关键词白名单'
  }
  if (channel === 'feishu' && (c === '19021' || c === '19024')) return '签名或关键词校验失败，请在机器人安全设置里核对'
  if (channel === 'telegram') {
    if (c === '401') return 'Bot Token 无效，请到 @BotFather 重新获取'
    if (/chat not found/i.test(e)) return 'chat_id 不正确：先把机器人拉进群并让它收到一条消息'
  }
  if (status >= 400) return '地址可达但被拒绝，请核对 URL 与机器人状态'
  return ''
}

export function startLocalApi({ port = LOCAL_API_PORT, state, notifier, config, logger, save, diag, poke }) {
  let lastTest = 0
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin
    const crossSite = req.headers['sec-fetch-site'] === 'cross-site'
    const blocked = !originAllowed(origin) || (crossSite && !shellOrigin(origin))
    // '*' (not the echoed origin) because the host shell uses a custom scheme
    // where browser origin serialisation is not guaranteed to round-trip. The
    // Origin gate above is what actually decides access.
    if (!blocked) res.setHeader('Access-Control-Allow-Origin', '*')
    if (blocked) {
      logger?.debug?.(`本地桥接拒绝了来源 ${origin || '(none)'}${crossSite ? '（cross-site）' : ''}`)
      return json(res, 403, fail('forbidden', '仅允许本机面板访问'))
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '600')
      res.writeHead(204); res.end(); return
    }

    const path = (req.url || '').split('?')[0]
    const needJson = () => String(req.headers['content-type'] || '').includes('application/json')
    try {
      if (req.method === 'GET' && path === '/status') {
        const wh = state.webhook || {}
        const p = state.pending
        return json(res, 200, {
          channel: wh.channel || 'none',
          configured: configured(wh),
          urlHost: hostOf(wh),
          secretSet: !!wh.secret,
          balance: state.balance || null,
          alert: state.alert || null,
          pending: p ? { kind: p.kind, hold: !!p.hold, ambiguous: !!p.ambiguous, attempts: p.attempts || 0, lastError: p.lastError || null } : null,
          thresholds: effectiveThresholds(state, config),
          quiet: config.balance?.quiet || { start: '', end: '' },
          enabled: config.balance?.enabled !== false,
          signature: config.notify?.signature !== false,
          sourceDiag: diag ? diag() : null,
        })
      }

      // Save a webhook. Takes effect on the next cycle — the monitor reads
      // state.webhook at send time, so no host restart is needed.
      if (req.method === 'POST' && path === '/webhook') {
        if (!needJson()) return json(res, 415, fail('bad-content-type', '请求格式不正确'))
        const body = await readJson(req)
        if (!body) return json(res, 400, fail('bad-json', '请求体不是合法 JSON'))
        const { value, error } = validate(body)
        if (error) return json(res, 400, error)

        mergeStateFromDisk(state)
        const wasConfigured = configured(state.webhook)
        const prev = { webhook: state.webhook, pending: state.pending }
        state.webhook = value
        // First connect while already in an alert state: supplement ONE current
        // state notice so the user immediately sees the alert they installed for.
        if (!wasConfigured && configured(value) && state.alert?.level !== 'normal' && !state.pending) {
          state.pending = { kind: 'current', attempts: 0, hold: false, ambiguous: false, nextAt: Date.now(), lastError: null }
        }
        if (save && save(state, ['webhook', 'pending']) === false) {
          state.webhook = prev.webhook; state.pending = prev.pending
          return json(res, 503, fail('busy', '状态文件被占用，请稍后重试'))
        }
        logger?.info?.(`推送通道已更新：${value.channel}`) // never log url/secret
        poke?.()
        return json(res, 200, {
          ok: true, channel: value.channel, configured: configured(value),
          urlHost: hostOf(value), secretSet: !!value.secret,
        })
      }

      // Threshold prefs. Panel-owned; monitor re-reads them every cycle.
      if (req.method === 'POST' && path === '/prefs') {
        if (!needJson()) return json(res, 415, fail('bad-content-type', '请求格式不正确'))
        const body = await readJson(req)
        if (!body) return json(res, 400, fail('bad-json', '请求体不是合法 JSON'))
        const warn = Number(body?.warn)
        const critical = Number(body?.critical)
        if (!Number.isFinite(warn) || !Number.isFinite(critical) || warn <= 0 || critical <= 0) {
          return json(res, 400, fail('bad-thresholds', '阈值需为正数'))
        }
        if (warn <= critical) return json(res, 400, fail('bad-thresholds', '预警阈值需大于告急阈值'))
        mergeStateFromDisk(state)
        const prev = state.prefs
        state.prefs = { warn, critical }
        // A threshold tweak is not a top-up: cancel any queued recovery notice.
        if (state.pending?.kind === 'recovered') state.pending = null
        if (save && save(state, ['prefs', 'pending']) === false) {
          state.prefs = prev
          return json(res, 503, fail('busy', '状态文件被占用，请稍后重试'))
        }
        logger?.info?.(`告警阈值已更新：预警 ${warn} / 告急 ${critical}`)
        poke?.()
        return json(res, 200, { ok: true, thresholds: effectiveThresholds(state, config) })
      }

      // Manual retry for a held / unconfirmed pending alert.
      if (req.method === 'POST' && path === '/alert/retry') {
        mergeStateFromDisk(state)
        if (!state.pending) return json(res, 400, fail('no-pending', '当前没有待发送的告警'))
        if (!configured(state.webhook)) return json(res, 400, fail('not-configured', '还没有配置推送通道'))
        state.pending = { ...state.pending, attempts: 0, hold: false, ambiguous: false, nextAt: Date.now(), lastError: null }
        if (save && save(state, ['pending']) === false) {
          return json(res, 503, fail('busy', '状态文件被占用，请稍后重试'))
        }
        poke?.()
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path === '/test-push') {
        if (!configured(state.webhook)) return json(res, 400, fail('not-configured', '还没有配置推送通道'))
        const now = Date.now()
        if (now - lastTest < 3000) return json(res, 429, fail('too-frequent', '操作太频繁，请 3 秒后再试'))
        lastTest = now
        const r = await notifier.send(state.webhook, '余额哨兵 · 测试推送',
          withSignature('这是一条测试消息：webhook 通道工作正常。', config.notify))
        return json(res, 200, {
          ok: r.ok, error: r.ok ? null : (r.error || ''), chunks: r.chunks || 0,
          status: r.status || 0, code: r.code ?? null, channel: state.webhook.channel,
          hint: r.ok ? '' : hintFor(state.webhook.channel, r.code, r.error, r.status || 0),
        })
      }

      return json(res, 404, fail('not-found', '未知接口'))
    } catch (err) {
      return json(res, 500, fail('internal', String(err?.message || err)))
    }
  })

  server.on('error', (err) => logger?.warn?.(`本地桥接端口 ${port} 不可用（${err.code || err.message}），面板将显示降级说明`))
  server.listen(port, '127.0.0.1', () => logger?.info?.(`本地桥接已监听 127.0.0.1:${port}`))
  return () => { try { server.close() } catch { /* already closed */ } }
}