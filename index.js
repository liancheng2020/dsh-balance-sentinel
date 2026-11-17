// Host entry for dsh-balance-sentinel: background DeepSeek balance monitoring
// with two-level low-balance alerts pushed to IM webhooks. v1 deliberately has
// no agent tools and no cost estimation — the balance is the official number.

import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { loadState, saveState } from './lib/state.js'
import { createNotifier } from './lib/notify.js'
import { createBalanceSource, startMonitor } from './lib/balance.js'
import { startLocalApi } from './lib/localapi.js'

const { version: PKG_VERSION } = createRequire(import.meta.url)('./package.json')

export const name = 'balance-sentinel'
export const inject = []

export const Config = z.object({
  balance: z.object({
    enabled: z.boolean().default(true),
    pollSeconds: z.number().step(1).min(60).max(3600).default(60),
    warn: z.number().min(0.01).default(20),
    critical: z.number().min(0.01).default(5),
    timezone: z.string().default('Asia/Shanghai'),
    quiet: z.object({
      start: z.string().default(''),
      end: z.string().default(''),
    }).default({ start: '', end: '' }),
    // Optional fallback for hosts without the account service. Prefer the host
    // account (no key) or the DEEPSEEK_API_KEY env; never required.
    apiKey: z.string().default(''),
  }).default({}),
  notify: z.object({
    signature: z.boolean().default(true),
    signatureText: z.string().default(''),
  }).default({}),
  localApi: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
})

export function apply(ctx, config) {
  const log = ctx.logger
  const state = loadState(log)
  const notifier = createNotifier()

  // Feature-detect the host account service via optional inject: cordis forbids
  // reading ctx.remote without declaring it, and older hosts may lack the
  // service entirely — the callback then never runs and the key fallback applies.
  const sourceOpts = { apiKey: config.balance?.apiKey || process.env.DEEPSEEK_API_KEY || '', version: PKG_VERSION }
  ctx.inject(['remote'], (rctx) => {
    // Lazy per-call detection: the account platform may register on remote
    // after this callback runs; undefined means "no account service".
    sourceOpts.remoteGet = (meta) => typeof rctx.remote?.account?.getBalance === 'function'
      ? rctx.remote.account.getBalance(meta)
      : undefined
  })
  // Some host builds expose the account platform as a direct cordis service.
  ctx.inject(['deepseekAccount'], (actx) => {
    sourceOpts.accountGet = (meta) => typeof actx.deepseekAccount?.getBalance === 'function'
      ? actx.deepseekAccount.getBalance(meta)
      : undefined
  })
  const fetchBalance = createBalanceSource(sourceOpts)

  let monitorCtl = null
  ctx.effect(() => {
    monitorCtl = startMonitor({
      fetchBalance, state, notifier, config,
      save: (s) => saveState(s, log),
      logger: log,
      onCycle: (r) => {
        if (r.skipped) return
        if (r.fetch?.ok) log?.debug?.(`余额 ${r.fetch.wallets?.map((w) => `${w.currency} ${w.total}`).join(' / ')}${r.transition ? ` · 跃迁 ${r.transition}` : ''}${r.delivery?.delivered ? ` · 已推送 ${r.delivery.delivered}` : ''}${r.delivery?.failed ? ` · 推送失败 ${r.delivery.error}` : ''}`)
        else log?.warn?.(`余额查询失败：${r.fetch?.reason}${r.fetch?.error ? ' ' + r.fetch.error : ''}`)
      },
    })
    return () => monitorCtl?.stop?.()
  })

  if (config.localApi?.enabled !== false) {
    ctx.effect(() => startLocalApi({
      state, notifier, config, logger: log,
      save: (s, own) => saveState(s, log, { own }),
      poke: () => monitorCtl?.poke?.(),
      diag: () => ({ remote: !!sourceOpts.remoteGet, account: !!sourceOpts.accountGet, key: !!sourceOpts.apiKey }),
    }))
  }

  log?.info?.(`balance-sentinel activated: ${sourceOpts.remoteGet ? 'host account (no key)' : sourceOpts.apiKey ? 'api key fallback' : 'no balance source yet'}`)
}