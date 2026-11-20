// Client half: a sidebar panel showing the official DeepSeek balance, alert
// state, threshold prefs and webhook config. Bilingual (zh/en) following the
// host locale; styled with --dsw-alias-* tokens. The catalog below mirrors
// locale/*.json (build-free plugin: the module loader cannot require JSON).
window.__ModuleLoader__.load({
  id: 'dsh-balance-sentinel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const LOCAL_API = 'http://127.0.0.1:17430'
    const REPO = 'https://github.com/liancheng2020/dsh-balance-sentinel'
    const TOP_UP = 'https://platform.deepseek.com/'
    const RESULT_TTL = 3000 // confirmations fade; failures stay until the next action
    const POLL_MS = 15000 // panel refresh; the bridge is loopback-only and cheap
    // Official "how to get a custom bot webhook" pages, shown next to the form.
    const BOT_DOC = {
      feishu: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
      dingtalk: 'https://open.dingtalk.com/document/orgapp/custom-robot-access',
    }
    const CHANNELS = ['wecom', 'dingtalk', 'feishu', 'bark', 'serverchan', 'telegram', 'generic']
    const URL_HINT = {
      wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
      dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=…',
      feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
      bark: 'https://api.day.app/your-key',
      serverchan: 'https://sctapi.ftqq.com/SCT….send',
      telegram: '123456789:AA…',
      generic: 'https://example.com/webhook',
    }
    const CHANNEL_BY_HOST = {
      'qyapi.weixin.qq.com': 'wecom',
      'oapi.dingtalk.com': 'dingtalk',
      'open.feishu.cn': 'feishu',
      'api.day.app': 'bark',
      'sctapi.ftqq.com': 'serverchan',
      'api.telegram.org': 'telegram',
    }
    const detectChannel = (raw) => {
      const s = String(raw || '').trim()
      if (!s) return ''
      if (/^\d+:[\w-]{10,}$/.test(s)) return 'telegram'
      try {
        return CHANNEL_BY_HOST[new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).host] || ''
      } catch { return '' }
    }
    const WEBHOOK_SNIPPET = '{ "webhook": { "channel": "wecom", "url": "<你的 webhook 地址>", "secret": "" } }'

    const L = {
      zh: {
        'meta.title': '余额哨兵', 'sub': 'DeepSeek 余额监控 · 低余额主动提醒', 'refresh': '刷新',
        'hero.topup': '去充值', 'hero.checkedAt': '核对于 {t}', 'hero.source': '官方账户同源 · 免估算',
        'level.normal': '余额正常', 'level.warn': '余额预警', 'level.critical': '余额告急',
        'reason.title': '余额暂不可用', 'reason.retry': '重试',
        'reason.no-source': '宿主没有账号服务，也未提供 API Key。带官方「设置→账号与余额」的宿主支持免填 Key；否则在配置 balance.apiKey 或环境变量 DEEPSEEK_API_KEY 提供 Key。',
        'reason.signed-out': '宿主未登录 DeepSeek 账户：请在官方「设置→账号与余额」登录后重试。',
        'reason.unauthorized': 'API Key 无效或过期：请更新 Key，或改用宿主账号登录（免填 Key）。',
        'reason.account-failed': '宿主账号服务查询失败，稍后自动重试。',
        'reason.account-error': '宿主账号服务调用异常，稍后自动重试。',
        'reason.network': '网络不可达：确认本机能访问 api.deepseek.com（或被代理/防火墙拦截）。',
        'reason.bad-response': '余额接口返回异常，稍后自动重试。',
        'reason.http': '余额接口 HTTP {c}，稍后自动重试。',
        'banner': '监控中，通知未接通：配置通道后，低余额会自动推到你的 IM。', 'bannerCta': '现在配置',
        'kind.warn': '预警', 'kind.critical': '告急', 'kind.recovered': '恢复', 'kind.resolved': '解除', 'kind.current': '当前状态',
        'alert.pending': '有一条「{k}」通知待发送。', 'alert.hold': '告警发送受阻：{e}', 'alert.retry': '重试发送',
        'alert.retried': '已触发重试，立即补发。',
        'monitor.off': '后台监控已关闭（balance.enabled=false），面板仅展示。',
        'support.scope': '仅支持本机 DSH Desktop／本机 Web：DSH 运行时监控，退出后停止；不支持远程 Web 面板连接。支持宿主账号免填 Key：需宿主提供账号服务且已登录。',
        'quiet.on': '免打扰 {s}–{e}，期间告警顺延、出窗合并推送。',
        'th.title': '告警阈值', 'th.warn': '预警阈值', 'th.critical': '告急阈值', 'th.save': '保存阈值',
        'th.saved': '阈值已保存，立即生效。', 'th.bad': '需为正数，且预警阈值大于告急阈值。',
        'th.hint': '低于预警值推「预警」，低于告急值推「告急」；充值或调阈值回到预警值之上推一条「恢复/解除」。告警未送达时静默取消，不补发。',
        'sec.push': '推送配置', 'push.channel': '推送通道：{c}', 'push.on': '已配置', 'push.off': '未配置',
        'push.untested': '已配置，待测试', 'push.verified': '最近测试成功', 'push.failed': '最近测试失败',
        'push.untestedHint': '通道已保存，但还没有测试过发送：点「发送测试推送」确认能收到，别等真告警时才发现地址不通。',
        'push.failedWhy': '失败原因：{e}',
        'push.testStale': '测试期间推送配置已变更，本次结果未计入当前通道。',
        'push.notPersisted': '结果未写入状态文件，重启后会丢失。',
        'chan.none': '未配置', 'chan.wecom': '企业微信', 'chan.dingtalk': '钉钉', 'chan.feishu': '飞书',
        'chan.bark': 'Bark', 'chan.serverchan': 'Server酱', 'chan.telegram': 'Telegram', 'chan.generic': '通用 Webhook',
        'push.hint': '低余额/恢复通知将推送到这里，保存即生效，无需重启。',
        'push.empty': '还没有配置推送通道。填好地址保存，余额不足时自动提醒到 IM。',
        'push.field.channel': '推送通道', 'push.field.url': 'Webhook 地址', 'push.field.token': 'Bot Token',
        'push.field.secret': '加签密钥（可选）', 'push.field.chat': 'chat_id',
        'push.saveTest': '保存并发送测试', 'push.save': '仅保存', 'push.saving': '保存中…',
        'push.edit': '修改', 'push.setup': '配置推送', 'push.cancel': '取消', 'push.saved': '已保存，立即生效。',
        'push.signature': '附上安装链接', 'push.signatureHint': '（默认关闭，开启后告警尾部会多一行署名）',
        'push.signatureTitle': '默认关闭；开启后告警尾部会多一行署名与安装链接',
        'push.disable': '关闭推送', 'push.disableConfirm': '确认关闭？', 'push.disabled': '已关闭推送，可随时重新配置。',
        'push.test': '发送测试推送', 'push.testing': '发送中…',
        'push.testOk': '测试推送成功：{c} 通道正常，发出 {n} 条。',
        'push.help': '如何获取机器人 Webhook',
        'help.feishu.steps': '1. 群聊右上角「…」→ 设置 → 群机器人 → 添加机器人 → 自定义机器人。\n2. 复制 Webhook 地址（open.feishu.cn/open-apis/bot/v2/hook/…）。\n3. 安全设置：本插件发送消息卡片，未实现签名校验，请勿勾选「签名校验」；需要限制来源时用「IP 白名单」（要求固定出口 IP），关键词校验对卡片消息不保证生效。',
        'help.dingtalk.steps': '1. 群设置 → 机器人 → 添加机器人 → 自定义（通过 Webhook 接入）。\n2. 安全设置选「加签」时，把密钥填到上面的「加签密钥」；选「自定义关键词」时填 余额。\n3. 复制 Webhook 地址（oapi.dingtalk.com/robot/send?access_token=…）。',
        'bridge.title': '面板拿不到宿主状态：本地桥接未启动、端口被占用、页面环境拦截，或你在其他机器打开了远程 Web 面板（不支持）。可复制配置手填到 state.json 的 webhook 字段，保存后重启 DSH。',
        'bridge.path': '或手动编辑：', 'bridge.retry': '重试', 'bridge.snippet': '复制配置片段',
        'bridge.snippetCopied': '配置片段已复制，粘到 state.json 的 webhook 字段后重启 DSH。',
        'copyFail': '复制失败，请手动复制：',
        'foot.source': '数据来源', 'foot.feedback': '反馈/报障', 'foot.sibling': '同作者：AIHOT 雷达',
      },
      en: {
        'meta.title': 'Balance Sentinel', 'sub': 'DeepSeek balance watch · proactive low-balance alerts', 'refresh': 'Refresh',
        'hero.topup': 'Top up', 'hero.checkedAt': 'checked at {t}', 'hero.source': 'Official account source · no estimates',
        'level.normal': 'Balance OK', 'level.warn': 'Low balance', 'level.critical': 'Critical balance',
        'reason.title': 'Balance unavailable', 'reason.retry': 'Retry',
        'reason.no-source': 'No host account service and no API key. Hosts with the official "Account & Balance" page support key-free accounts; otherwise set balance.apiKey in config or the DEEPSEEK_API_KEY env var.',
        'reason.signed-out': 'The host is not signed in to a DeepSeek account: sign in via the official "Account & Balance" page, then retry.',
        'reason.unauthorized': 'API key invalid or expired: update the key, or sign in with the host account (no key needed).',
        'reason.account-failed': 'Host account service query failed; retrying automatically.',
        'reason.account-error': 'Host account service call errored; retrying automatically.',
        'reason.network': 'Network unreachable: make sure this machine can reach api.deepseek.com (proxy/firewall?).',
        'reason.bad-response': 'Unexpected balance API response; retrying automatically.',
        'reason.http': 'Balance API HTTP {c}; retrying automatically.',
        'banner': 'Watching, but notifications are not connected: set a channel and low balance will push to your IM.', 'bannerCta': 'Set it up',
        'kind.warn': 'low', 'kind.critical': 'critical', 'kind.recovered': 'recovered', 'kind.resolved': 'resolved', 'kind.current': 'current state',
        'alert.pending': 'A "{k}" notice is waiting to be sent.', 'alert.hold': 'Alert delivery blocked: {e}', 'alert.retry': 'Retry send',
        'alert.retried': 'Retry triggered; sending immediately.',
        'monitor.off': 'Background monitoring is off (balance.enabled=false); the panel is display-only.',
        'support.scope': 'Local DSH Desktop or local web host only: monitoring runs while DSH is running and stops when it exits; remote web panels are not supported. Key-free host accounts are supported: the host needs the account service and a signed-in account.',
        'quiet.on': 'Quiet hours {s}–{e}: alerts defer and merge into one push afterwards.',
        'th.title': 'Alert thresholds', 'th.warn': 'Warn below', 'th.critical': 'Critical below', 'th.save': 'Save thresholds',
        'th.saved': 'Thresholds saved; effective immediately.', 'th.bad': 'Positive numbers required, warn above critical.',
        'th.hint': 'Below warn pushes "low", below critical pushes "critical"; a top-up or a threshold tweak back above warn pushes one "recovered"/"resolved" notice. Undelivered alerts cancel silently.',
        'sec.push': 'Push settings', 'push.channel': 'Push channel: {c}', 'push.on': 'Configured', 'push.off': 'Not set',
        'push.untested': 'Configured, not tested', 'push.verified': 'Last test succeeded', 'push.failed': 'Last test failed',
        'push.untestedHint': 'The webhook is saved but has never been tested: hit "Send test push" now, so a dead endpoint cannot stay hidden until a real alert needs it.',
        'push.failedWhy': 'Failure: {e}',
        'push.testStale': 'The push config changed while the test was running; this result was discarded.',
        'push.notPersisted': 'Result not written to the state file; it will be lost on restart.',
        'chan.none': 'Not set', 'chan.wecom': 'WeCom', 'chan.dingtalk': 'DingTalk', 'chan.feishu': 'Feishu',
        'chan.bark': 'Bark', 'chan.serverchan': 'ServerChan', 'chan.telegram': 'Telegram', 'chan.generic': 'Generic webhook',
        'push.hint': 'Low-balance / recovery notices push here. Saving applies immediately, no restart.',
        'push.empty': 'No push channel yet. Save a URL and get IM alerts when the balance runs low.',

        'push.field.channel': 'Channel', 'push.field.url': 'Webhook URL', 'push.field.token': 'Bot Token',
        'push.field.secret': 'Sign secret (optional)', 'push.field.chat': 'chat_id',
        'push.saveTest': 'Save and send test', 'push.save': 'Save only', 'push.saving': 'Saving…',
        'push.edit': 'Edit', 'push.setup': 'Set up push', 'push.cancel': 'Cancel', 'push.saved': 'Saved; effective immediately.',
        'push.signature': 'Append the install link', 'push.signatureHint': '(off by default, adds a signature line on alerts)',
        'push.signatureTitle': 'Off by default; when on, alerts end with a signature line and install link',
        'push.disable': 'Turn off', 'push.disableConfirm': 'Confirm?', 'push.disabled': 'Push turned off; configure it again anytime.',
        'push.test': 'Send test push', 'push.testing': 'Sending…',
        'push.testOk': 'Test push via {c} succeeded, {n} message(s) sent.',
        'push.help': 'How to get a bot webhook',
        'help.feishu.steps': '1. Group "…" menu → Settings → Group bots → Add bot → Custom bot.\n2. Copy the webhook URL (open.feishu.cn/open-apis/bot/v2/hook/…).\n3. Security: this plugin posts message cards and does not implement signature verification, so do not enable "Signature verification"; to restrict callers use an IP allowlist (fixed egress IP). Keyword checks do not reliably apply to card messages.',
        'help.dingtalk.steps': '1. Group settings → Bots → Add bot → Custom (via webhook).\n2. With "Sign" enabled, paste the secret into "Sign secret" above; with "Keyword" enabled, use 余额 (it appears in every alert title).\n3. Copy the webhook URL (oapi.dingtalk.com/robot/send?access_token=…).',
        'bridge.title': 'The panel cannot reach the host: bridge not running, port taken, the page environment blocks it, or this is a remote web panel opened from another machine (not supported). Copy the config into the webhook field of state.json and restart DSH.',
        'bridge.path': 'Or edit it yourself:', 'bridge.retry': 'Retry', 'bridge.snippet': 'Copy config snippet',
        'bridge.snippetCopied': 'Snippet copied; paste into the webhook field of state.json, then restart DSH.',
        'copyFail': 'Copy failed, copy manually: ',
        'foot.source': 'Data source', 'foot.feedback': 'Feedback', 'foot.sibling': 'Same author: AIHOT Radar',
      },
    }

    let LOCALE = null
    let LANG = 'zh'
    const activeLang = () => { try { return LOCALE?.getLocale?.().active === 'en' ? 'en' : 'zh' } catch { return 'zh' } }
    const tr = (key, lang) => (L[lang] && L[lang][key]) || L.zh[key] || key
    function t(key, vars) {
      let s = tr(key, LANG)
      if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k])
      return s
    }
    function useActiveLang() {
      const [lang, setLang] = useState(activeLang)
      useEffect(() => {
        if (!LOCALE || typeof LOCALE.subscribe !== 'function') return
        const un = LOCALE.subscribe(() => setLang(activeLang()))
        return () => { if (typeof un === 'function') un() }
      }, [])
      return lang
    }

    // DSH marks the dark skin with <body data-ds-dark-theme> — the same contract
    // the host's own UI reads. Follow that attribute instead of guessing from a
    // colour probe: a light skin can still use a dark brand colour, and a probe
    // would put the panel in the wrong mode on first paint.
    function useDarkSkin() {
      const [dark, setDark] = useState(true)
      useEffect(() => {
        const body = typeof document !== 'undefined' ? document.body : null
        if (!body) return
        const read = () => setDark(typeof body.hasAttribute === 'function' ? body.hasAttribute('data-ds-dark-theme') : true)
        read()
        if (typeof MutationObserver === 'undefined') return
        const mo = new MutationObserver(read)
        mo.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => mo.disconnect()
      }, [])
      return dark
    }

    const T = {
      text: 'var(--dsw-alias-label-primary, #e8e8ea)',
      sub: 'var(--dsw-alias-label-secondary, #a0a0a8)',
      tertiary: 'var(--dsw-alias-label-tertiary, #6e6e78)',
      dimmed: 'var(--dsw-alias-label-dimmed, #50505a)',
      base: 'var(--dsw-alias-bg-base, #0e0e11)',
      layer1: 'var(--dsw-alias-bg-layer-1, #1a1a1f)',
      layer2: 'var(--dsw-alias-bg-layer-2, #232329)',
      border: 'var(--dsw-alias-border-l2, #2e2e36)',
      borderSoft: 'var(--dsw-alias-border-l1, #26262c)',
      brand: 'var(--dsw-alias-brand-primary, #5b8cff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #2a2a32)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
      success: 'var(--dsw-alias-state-success-primary, #34c759)',
      error: 'var(--dsw-alias-state-error-primary, #ff4d4f)',
    }
    // Theme-following fills: color-mix() resolves against the host's --dsw-alias-*
    // tokens, so one declaration is correct in both skins. The rgba() literals
    // this replaces were tuned on the dark skin and turn into grey smudges on a
    // white canvas.
    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`
    const mix = (color, pct, base) => `color-mix(in srgb, ${color} ${pct}%, ${base})`
    // Ink for text painted in a state colour: pulled towards the label colour so
    // it darkens on white and lightens on black. The raw warn orange is only
    // ~2:1 on a white card, which is why badges and amounts use this instead.
    const ink = (color) => mix(color, 58, T.text)
    // Ink for a badge filled with a saturated state colour: it must contrast with
    // that colour (not with the page), so it is a constant in both skins.
    const INK_ON_SOLID = '#0e0e11'
    const css = {
      // The canvas comes from a custom property so the light skin can swap it for
      // an opaque neutral (see the injected sheet); an inline bg would win over it.
      panel: { boxSizing: 'border-box', padding: '20px 22px', color: T.text, fontSize: 13, lineHeight: 1.6, overflowY: 'auto', height: '100%', background: 'var(--sentinel-canvas, var(--dsw-alias-bg-base, #0e0e11))' },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
      titleWrap: { display: 'flex', alignItems: 'center', gap: 10 },
      iconBadge: { width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${tint(T.brand, 18)}, ${tint(T.warn, 14)})`, border: `1px solid ${T.border}`, color: T.brand, flex: 'none' },
      h1: { fontSize: 17, fontWeight: 650, margin: 0, letterSpacing: '0.2px', display: 'flex', alignItems: 'center', gap: 8 },
      live: { width: 7, height: 7, borderRadius: '50%', background: T.success },
      sub: { color: T.tertiary, fontSize: 12, margin: '3px 0 0' },
      btn: { fontSize: 12, padding: '6px 14px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.layer1, color: T.sub, cursor: 'pointer', transition: 'all .15s ease', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' },
      btnPrimary: { fontSize: 12, padding: '6px 14px', borderRadius: 8, border: `1px solid ${tint(T.brand, 45)}`, background: tint(T.brand, 16), color: T.brand, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' },
      hero: { background: `linear-gradient(135deg, ${tint(T.brand, 10)}, var(--sentinel-surface, #1a1a1f) 60%)`, border: 'var(--sentinel-line-w, 1px) solid var(--sentinel-line, #2e2e36)', boxShadow: 'var(--sentinel-shadow, none)', borderRadius: 12, padding: '16px 18px', marginBottom: 14 },
      heroVal: { fontSize: 30, fontWeight: 700, lineHeight: 1.2 },
      metaDim: { fontSize: 11.5, color: T.tertiary, margin: '2px 0' },
      banner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '9px 12px', marginBottom: 14, borderRadius: 10, border: 'var(--sentinel-line-w, 1px) solid var(--sentinel-line, #26262c)', borderLeft: `3px solid ${T.brand}`, background: tint(T.brand, 10) },
      bannerText: { fontSize: 12, color: T.sub },
      card: { background: 'var(--sentinel-surface, #1a1a1f)', border: 'var(--sentinel-line-w, 1px) solid var(--sentinel-line, #26262c)', boxShadow: 'var(--sentinel-shadow, none)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 },
      cardTitle: { fontWeight: 600, fontSize: 13, color: T.text, display: 'flex', alignItems: 'center', gap: 7 },
      // A bare semantic colour at 10.5px is unreadable on a white card, so the ink
      // is pulled towards the label colour (dark in the light skin, a touch
      // lighter in the dark one) while the fill keeps the state's hue.
      badgeSoft: (c) => ({ fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20, color: ink(c), border: `1px solid ${tint(c, 55)}`, background: tint(c, 12), whiteSpace: 'nowrap', flex: 'none' }),
      field: { marginBottom: 9 },
      fieldLabel: { display: 'block', fontSize: 11.5, color: T.tertiary, marginBottom: 4 },
      helpBox: { padding: '9px 11px', marginBottom: 9, borderRadius: 8, border: 'var(--sentinel-line-w, 1px) dashed var(--sentinel-dash, #2e2e36)', background: 'var(--sentinel-canvas, var(--dsw-alias-bg-base, #0e0e11))' },
      input: { boxSizing: 'border-box', width: '100%', font: 'inherit', fontSize: 12, padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.base, color: T.text, outline: 'none' },
      // Native <select> popups ignore most styling: colorScheme is what makes
      // Chromium render the list dark instead of grey-on-grey. It is applied at
      // the call site from useDarkSkin() (see pushForm) rather than pinned here,
      // or the light skin would still open a dark menu.
      select: { boxSizing: 'border-box', width: '100%', font: 'inherit', fontSize: 12, padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.base, color: T.text, outline: 'none', cursor: 'pointer' },
      option: { background: T.layer1, color: T.text },
      link: { color: T.brand, textDecoration: 'none', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3, transition: 'opacity .15s' },
      error: { color: ink(T.error), fontSize: 12.5, padding: '12px 14px', background: tint(T.error, 8), border: `1px solid ${tint(T.error, 30)}`, borderRadius: 10, marginBottom: 12 },
      warnBox: { color: ink(T.warn), fontSize: 12, padding: '10px 12px', background: tint(T.warn, 8), border: `1px solid ${tint(T.warn, 30)}`, borderRadius: 10, marginBottom: 12 },
      bridgeBox: { padding: '12px 14px', background: 'var(--sentinel-surface, #1a1a1f)', border: 'var(--sentinel-line-w, 1px) dashed var(--sentinel-dash, #2e2e36)', borderRadius: 10, marginBottom: 12 },
      pathLine: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: T.brand, marginTop: 6, wordBreak: 'break-all' },
      h2: { fontSize: 12, fontWeight: 600, margin: '0 0 10px', color: T.sub, textTransform: 'uppercase', letterSpacing: '0.6px' },
      foot: { marginTop: 8, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11.5, color: T.sub, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    }

    function toastAnchor() {
      const fallback = { position: 'fixed', left: '50%', top: 16, transform: 'translateX(-50%)', zIndex: 999, pointerEvents: 'none' }
      if (typeof document === 'undefined') return fallback
      try {
        const panel = document.querySelector('.sentinel-panel')
        const pr = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : null
        if (!pr || !pr.width) return fallback
        return { position: 'fixed', left: Math.round(pr.left + pr.width / 2), top: Math.max(8, Math.round(pr.top + 14)), maxWidth: Math.max(200, Math.round(pr.width - 28)), transform: 'translateX(-50%)', zIndex: 999, pointerEvents: 'none' }
      } catch { return fallback }
    }

    function BellIcon({ size = 20 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M18 9a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 15 18 9' }),
        h('path', { d: 'M10.3 20a2 2 0 0 0 3.4 0' }),
        h('circle', { cx: 18, cy: 5, r: 2.6, fill: 'currentColor', stroke: 'none' }))
    }

    const sym = (c) => (c === 'USD' ? '$' : '¥')
    // Critical uses a fixed red: some skins tint --dsw-alias-state-error-primary
    // pink, which turned a real 告急 amount into a near-white number.
    const levelColor = (l) => l === 'critical' ? '#ff4d4f' : l === 'warn' ? T.warn : T.success
    // The balance amount is the panel's headline. The raw warn orange measures
    // about 2:1 on a white card, so the light skin gets a darkened value through
    // a custom property while the dark skin keeps the vivid one.
    const levelVal = (l) => l === 'critical' ? 'var(--sentinel-val-critical, #ff4d4f)'
      : l === 'warn' ? 'var(--sentinel-val-warn, #f5a623)' : 'var(--sentinel-val-success, #34c759)'
    const fmtTime = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleTimeString(LANG === 'en' ? 'en-US' : 'zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) } catch { return String(iso) } }

    function SentinelPanel() {
      LANG = useActiveLang()
      const dark = useDarkSkin()
      const [nonce, setNonce] = useState(0)
      const [host, setHost] = useState(null)
      const [bridgeErr, setBridgeErr] = useState('')
      const [retry, setRetry] = useState(0)
      const [editing, setEditing] = useState(false)
      const [form, setForm] = useState({ channel: 'wecom', url: '', secret: '' })
      const [busy, setBusy] = useState('')
      const [result, setResultState] = useState(null)
      const [offConfirm, setOffConfirm] = useState(false)
      // null = "still showing the host's value". The inputs render the threshold
      // in that case instead of an empty string, so a slow /status, a remount, or
      // any path where the seed never ran can no longer leave a blank field with
      // a red "must be positive" warning under it.
      const [warnDraft, setWarnDraft] = useState(null)
      const [critDraft, setCritDraft] = useState(null)
      const thTouched = useRef(false) // user typed in a threshold field
      // Monotonic tokens for what the panel already knows locally. A /status
      // request captures both when it leaves; anything that lands afterwards
      // cannot be reflected in its response (see load()).
      const verdictSeq = useRef(0) // a test verdict was folded into the badge
      const configSeq = useRef(0)  // a save/disable replaced the webhook itself
      const [toast, setToast] = useState(null)

      useEffect(() => {
        if (!toast) return
        const id = setTimeout(() => setToast(null), 2000)
        return () => clearTimeout(id)
      }, [toast])

      // Inline result: a confirmation ("saved") is noise a few seconds later, so it
      // fades on its own; failures stay until the next action so they can be read.
      // Every write goes through showResult, which also cancels a pending fade so a
      // stale timer can never wipe a newer (possibly error) message.
      const resultTimer = useRef(null)
      useEffect(() => () => clearTimeout(resultTimer.current), [])
      const showResult = (r) => {
        clearTimeout(resultTimer.current)
        resultTimer.current = r && r.ok ? setTimeout(() => setResultState(null), RESULT_TTL) : null
        setResultState(r)
      }

      useEffect(() => {
        const sheet = `
          /* Surfaces follow the host skin the way dsh-context does: the dark skin
             keeps the layer-1 fill and lets the wallpaper show through, while the
             light skin gets an opaque neutral canvas, hairline borders and the
             host's level-1 shadow so cards read as objects instead of grey mush. */
          .sentinel-panel { --sentinel-surface: var(--dsw-alias-bg-layer-1, #1a1a1f); --sentinel-line: var(--dsw-alias-border-l1, #26262c); --sentinel-dash: var(--dsw-alias-border-l2, #2e2e36); --sentinel-line-w: 1px; --sentinel-shadow: none; --sentinel-canvas: var(--dsw-alias-bg-base, #0e0e11); --sentinel-val-warn: var(--dsw-alias-state-warn-primary, #f5a623); --sentinel-val-critical: #ff4d4f; --sentinel-val-success: var(--dsw-alias-state-success-primary, #34c759); }
          /* Light skin: the vivid state colours land at ~2:1 on white, so the
             headline amount uses a darkened ink. These values measure above 5:1
             against #ffffff and #f4f6f8. */
          body:not([data-ds-dark-theme]) .sentinel-panel { --sentinel-surface: var(--dsw-alias-bg-layer-1, #ffffff); --sentinel-line: var(--dsw-alias-border-l3, #e3e6ea); --sentinel-dash: var(--dsw-alias-border-l4, #d5d9de); --sentinel-line-w: 0.5px; --sentinel-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0,0,0,0.06)); --sentinel-canvas: var(--dsw-static-neutral-bluish-75, #f4f6f8); --sentinel-val-warn: #9c5c00; --sentinel-val-critical: #c62828; --sentinel-val-success: #1f7a35; }
          .sentinel-panel::-webkit-scrollbar { width: 8px; }
          .sentinel-panel::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 8px; }
          /* Quiet interaction states for every button in the panel. The border is
             never recoloured on hover: a recycled button node can end up without
             its own inline border colour (see the "turn off" button in the form),
             and a brand-coloured hover rule then draws a bright ring around a
             plain action like "修改" — which reads as "still selected" and, once
             the pointer leaves, can survive the whole render. Focus is the same
             deal: we draw the ring ourselves, and only for keyboard focus, so a
             mouse click never leaves one behind. */
          .sentinel-panel button { outline: none; -webkit-tap-highlight-color: transparent; }
          .sentinel-panel button:hover:not(:disabled) { border-color: ${T.border}; color: ${T.text}; background: ${T.hover}; box-shadow: none; }
          .sentinel-panel button:active:not(:disabled) { transform: scale(0.98); }
          .sentinel-panel button:focus { outline: none; box-shadow: none; }
          .sentinel-panel button:focus-visible { outline: 1px solid ${tint(T.brand, 55)}; outline-offset: 1px; }
          .sentinel-link:hover { opacity: 0.75; }
          .sentinel-toast { position: fixed; z-index: 999; pointer-events: none; display: flex; align-items: flex-start; gap: 8px; box-sizing: border-box; max-width: 80vw; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; transform: translateX(-50%); }
          .sentinel-toast-ok { background: ${tint(T.success, 16)}; border: 1px solid ${tint(T.success, 65)}; color: ${T.text}; }
          .sentinel-toast-err { background: ${tint(T.error, 14)}; border: 1px solid ${tint(T.error, 65)}; color: ${T.text}; }
          .sentinel-toast-icon { width: 18px; height: 18px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: ${INK_ON_SOLID}; background: ${T.success}; }
          .sentinel-toast-err .sentinel-toast-icon { background: ${T.error}; color: #fff; }
          .sentinel-toast-body { min-width: 0; }
          .sentinel-toast-title { font-weight: 650; }
          .sentinel-toast-sub { font-size: 12.5px; color: ${T.sub}; word-break: break-word; }
          /* fixed red: some skins tint --dsw-alias-state-error-primary pink.
             Follow the host's skin attribute rather than the OS preference: the
             two can disagree (dark app on a light desktop). */
          .sentinel-th-bad { color: #ff4d4f; }
          body:not([data-ds-dark-theme]) .sentinel-th-bad { color: #d93025; }
          @media (prefers-reduced-motion: reduce) { .sentinel-toast { animation: none !important; } }
        `
        let el = document.getElementById('sentinel-style')
        if (!el) {
          el = document.createElement('style')
          el.id = 'sentinel-style'
          document.head.appendChild(el)
        }
        if (el.textContent !== sheet) el.textContent = sheet
      }, [])

      useEffect(() => {
        let cancelled = false
        let timer = null
        let attempt = 0
        const load = async () => {
          // Ordering tokens taken when the request leaves, not when it returns.
          const issued = verdictSeq.current
          const issuedConfig = configSeq.current
          try {
            const res = await fetch(LOCAL_API + '/status', { headers: { Accept: 'application/json' } })
            if (!res.ok) throw new Error('http ' + res.status)
            const j = await res.json()
            if (cancelled) return
            // One gate for the whole response. A save/disable that finished while
            // this request was in flight owns the webhook section, so the snapshot
            // predates it: drop it before touching state AND before the side
            // effects below. `configured` drives the setup form, so letting an
            // obsolete "not configured" snapshot through re-opened the form over
            // a channel the user had just saved.
            if (configSeq.current > issuedConfig) return
            attempt = 0
            setBridgeErr('')
            setHost((prev) => {
              if (!prev) return j
              // Checked again at apply time: a save can complete between the
              // gate above and this updater being flushed.
              if (configSeq.current > issuedConfig) return prev
              // A /status issued before the newest test result cannot contain
              // it. Taking the snapshot verbatim put the previous green verdict
              // back over a failure the user had just watched happen; keep the
              // verdict the panel already shows in that case.
              if (verdictSeq.current > issued && j.channel === prev.channel) return { ...j, verify: prev.verify }
              return j
            })
            // The setup form never opens by itself. An unconfigured channel is
            // announced by the banner (with its own CTA), so first use reads as
            // the monitor it is instead of a form to fill in; opening it stays a
            // deliberate click, and no refresh can pop it open again.
            //
            // Refresh the draft only while the user has not typed in the field.
            // This must be a synchronous ref read, not a functional setState that
            // compares against a closure variable: React runs that updater later,
            // so a variable written on the next line was already the new value and
            // the comparison wrongly concluded "the user is editing" — which left
            // both inputs empty on first load.
            if (!thTouched.current) {
              setWarnDraft(String(j.thresholds?.warn ?? 20))
              setCritDraft(String(j.thresholds?.critical ?? 5))
            }
          } catch (e) {
            if (cancelled) return
            if (attempt < 2) { attempt++; timer = setTimeout(load, attempt * 500); return }
            setBridgeErr(String(e?.message || e)); setHost(null)
          }
        }
        load()
        // The panel is a live view: without this it keeps showing "pending" long
        // after the monitor delivered the alert. Polls pause while hidden.
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }
        const id = setInterval(tick, POLL_MS)
        const onVisible = () => { if (document.visibilityState !== 'hidden') load() }
        if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisible)
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
          clearInterval(id)
          if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisible)
        }
      }, [nonce, retry])

      const copyText = (text) => new Promise((resolve) => {
        const fallback = () => {
          try {
            if (!document.body) return resolve(false)
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            const ok = document.execCommand('copy')
            ta.remove()
            resolve(ok)
          } catch { resolve(false) }
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => resolve(true), fallback)
        } else fallback()
      })
      const copySnippet = () => copyText(WEBHOOK_SNIPPET).then((ok) => setToast({ ok, title: ok ? t('bridge.snippetCopied') : t('copyFail'), body: ok ? '' : WEBHOOK_SNIPPET }))

      const post = async (path, body) => {
        const res = await fetch(LOCAL_API + path, body === undefined
          ? { method: 'POST' }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        return res.json()
      }
      const refreshSoon = (ms = 400) => setTimeout(() => setNonce((n) => n + 1), ms)

      // Shared by the standalone test button and the save+test flow. It owns no
      // busy state on purpose: the caller keeps one busy window, so a failed save
      // or a failed test can never leave a button stuck on "Saving…".
      // Fold a verdict into the panel state right away. Waiting for the next poll
      // left the badge showing the previous "succeeded" next to a message saying
      // the test just failed, for up to a full poll interval.
      const applyVerify = (j) => {
        // Only a response that carries a verdict is a test result. A refused
        // request (429 "操作太频繁", a rejected body, a dead bridge) says
        // nothing about delivery, so inventing a verdict from `ok:false` used to
        // paint a red "failed" over the last known-good result.
        const v = j && j.verify
        if (!v || j.stale) return
        // This verdict is newer than any snapshot still in flight.
        verdictSeq.current += 1
        setHost((prev) => {
          if (!prev) return prev
          // A verdict for another endpoint (saved from a second window) must not
          // land on this channel's badge.
          if (v.channel && prev.channel && v.channel !== prev.channel) return prev
          // Never let an older verdict overwrite a newer one that is already shown.
          if (prev.verify && Number(prev.verify.at || 0) > Number(v.at || 0)) return prev
          return { ...prev, verify: v }
        })
      }

      const sendTest = async () => {
        const j = await post('/test-push')
        // The config was repointed while this request was in flight, so the
        // verdict belongs to a webhook that is no longer in use: say so instead
        // of letting the user read it as the state of the current channel.
        if (j.stale) { showResult({ ok: false, message: t('push.testStale') }); return j }
        applyVerify(j)
        const warn = j.persisted === false ? t('push.notPersisted') : ''
        showResult(j.ok
          ? { ok: true, message: t('push.testOk', { c: j.channel || '', n: j.chunks || 1 }), hint: warn }
          : { ok: false, message: j.message || j.error || '', hint: [j.hint, warn].filter(Boolean).join(' ') })
        return j
      }

      const testPush = async () => {
        setBusy('test'); showResult(null)
        try { await sendTest() } catch (e) { showResult({ ok: false, message: String(e?.message || e) }) }
        finally { setBusy('') }
      }

      const saveWebhook = async (thenTest) => {
        setBusy('save'); showResult(null)
        try {
          const j = await post('/webhook', form)
          if (!j.ok) { showResult({ ok: false, message: j.message || '' }); return }
          // This response now owns the webhook section: a /status still in
          // flight was built from the previous address and must not land.
          configSeq.current += 1
          // The server decides what happens to the old test result: an unchanged
          // webhook keeps it, any edit drops it. Trust the response instead of
          // blanking locally and flashing "untested" on a no-op re-save.
          setHost((prev) => ({ ...(prev || {}), channel: j.channel, configured: j.configured, urlHost: j.urlHost, secretSet: j.secretSet, verify: j.verify ?? null }))
          setEditing(false)
          setForm({ channel: j.channel, url: '', secret: '' })
          if (!thenTest) {
            showResult({ ok: true, message: t('push.saved') })
            refreshSoon()
            return
          }
          // Save succeeded and the user asked for a test: stay inside the same
          // busy window (relabel to "sending") — never flash an enabled button
          // between saving and testing.
          setBusy('test')
          await sendTest()
          refreshSoon()
        } catch (e) { showResult({ ok: false, message: String(e?.message || e) }) }
        finally { setBusy('') }
      }

      const disablePush = async () => {
        if (!offConfirm) { setOffConfirm(true); return }
        setOffConfirm(false); setBusy('save'); showResult(null)
        try {
          const j = await post('/webhook', { channel: 'none' })
          if (!j.ok) { showResult({ ok: false, message: j.message || '' }); return }
          // Same rule as a save: a poll issued before this point still says the
          // channel was configured.
          configSeq.current += 1
          setHost((prev) => ({ ...(prev || {}), channel: 'none', configured: false, urlHost: '', secretSet: false, verify: null }))
          setEditing(false)
          showResult({ ok: true, message: t('push.disabled') })
        } catch (e) { showResult({ ok: false, message: String(e?.message || e) }) }
        finally { setBusy('') }
      }

      const savePrefs = async () => {
        setBusy('prefs'); showResult(null)
        try {
          const j = await post('/prefs', { warn: Number(warnShown), critical: Number(critShown) })
          if (!j.ok) { showResult({ ok: false, message: j.message || t('th.bad'), scope: 'th' }); return }
          setHost((prev) => (prev ? { ...prev, thresholds: j.thresholds } : prev))
          // Saved values are now the host's values: let polls follow them again.
          thTouched.current = false
          // Threshold saves confirm via the floating toast, so the card does not
          // grow a line (and push the sections below) just to take it away again.
          // Failures stay inline next to the inputs they refer to.
          showResult(null)
          setToast({ ok: true, title: t('th.saved'), n: Date.now() })
          refreshSoon(900)
        } catch (e) { showResult({ ok: false, message: String(e?.message || e), scope: 'th' }) }
        finally { setBusy('') }
      }

      const retryAlert = async () => {
        setBusy('retry'); showResult(null)
        try {
          const j = await post('/alert/retry')
          showResult(j.ok ? { ok: true, message: t('alert.retried') } : { ok: false, message: j.message || '' })
          refreshSoon()
        } catch (e) { showResult({ ok: false, message: String(e?.message || e) }) }
        finally { setBusy('') }
      }

      const openForm = () => {
        setForm({ channel: host?.channel && host.channel !== 'none' ? host.channel : 'wecom', url: '', secret: '' })
        showResult(null); setOffConfirm(false); setEditing(true)
      }
      const scrollToPush = () => setTimeout(() => {
        try { document.getElementById('sentinel-push')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch { /* noop */ }
      }, 60)

      const bal = host?.balance
      const level = host?.alert?.level || 'normal'
      const pending = host?.pending
      const th = host?.thresholds || { warn: 20, critical: 5 }
      // An untouched draft shows the host value; only user typing replaces it.
      const warnShown = warnDraft === null ? String(th.warn) : warnDraft
      const critShown = critDraft === null ? String(th.critical) : critDraft
      const warnN = Number(warnShown), critN = Number(critShown)
      const thValid = Number.isFinite(warnN) && Number.isFinite(critN) && warnN > 0 && critN > 0 && warnN > critN
      const thDirty = warnN !== th.warn || critN !== th.critical

      const hero = () => {
        if (!host) return null
        if (bal?.ok) {
          return h('div', { style: css.hero },
            h('div', { style: css.row },
              h('span', { style: css.cardTitle }, h(BellIcon, { size: 16 }), t('meta.title')),
              h('span', { style: css.badgeSoft(levelColor(level)) }, t('level.' + level))),
            h('div', { style: { ...css.heroVal, color: levelVal(level) } }, `${sym(bal.currency)}${Number(bal.value).toFixed(2)}`),
            h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
              h('a', { style: css.link, className: 'sentinel-link', href: TOP_UP, target: '_blank', rel: 'noreferrer' }, t('hero.topup'), h('span', null, '↗')),
              h('span', { style: css.metaDim }, t('hero.checkedAt', { t: fmtTime(bal.at) }))),
            h('div', { style: css.metaDim }, t('hero.source')))
        }
        const reason = bal?.reason || 'no-source'
        const text = reason.startsWith('http-') ? t('reason.http', { c: reason.slice(5) }) : t('reason.' + reason)
        return h('div', { style: css.warnBox },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('reason.title')),
          h('div', null, text),
          h('button', { type: 'button', style: { ...css.btn, marginTop: 8 }, className: 'sentinel-btn', onClick: () => setNonce((n) => n + 1) }, t('reason.retry')))
      }

      // Feishu/DingTalk: the webhook lives behind a few group-settings clicks, and
      // the security choice decides whether pushes land. Link the official page and
      // list only the settings this notifier actually satisfies.
      const webhookHelp = () => {
        const ch = form.channel
        if (!BOT_DOC[ch]) return null
        return h('div', { style: css.helpBox },
          h('a', { style: css.link, className: 'sentinel-link', href: BOT_DOC[ch], target: '_blank', rel: 'noreferrer' }, t('push.help'), h('span', null, '↗')),
          h('div', { style: { ...css.metaDim, marginTop: 6, whiteSpace: 'pre-line' } }, t('help.' + ch + '.steps')))
      }

      // Footer opt-in lives in the panel: send the whole switch, never a delta, so
      // the checkbox and the state file cannot disagree after a failed write.
      const toggleSignature = async (on) => {
        setBusy('sig'); showResult(null)
        try {
          const j = await post('/notify', { signature: !!on })
          if (!j.ok) { showResult({ ok: false, message: j.message || '' }); return }
          // Same rule as a webhook save: a /status issued before this write still
          // reports the old switch, and letting it land would flip the checkbox
          // back under the user.
          configSeq.current += 1
          setHost((prev) => ({ ...(prev || {}), signature: !!j.signature }))
        } catch (e) { showResult({ ok: false, message: String(e?.message || e) }) }
        finally { setBusy('') }
      }

      const signatureToggle = (extra) => h('label', {
        htmlFor: 'sentinel-sig',
        // The full sentence lives in the tooltip: on the card it was the longest
        // line for the least important control.
        title: t('push.signatureTitle'),
        style: { display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 10, cursor: busy ? 'default' : 'pointer', fontSize: 12, ...extra },
      },
      h('input', {
        type: 'checkbox', id: 'sentinel-sig', checked: !!host?.signature, disabled: !!busy,
        style: { margin: '2px 0 0', accentColor: T.brand },
        onChange: (e) => toggleSignature(e.target.checked),
      }),
      h('span', { style: { color: T.sub, lineHeight: 1.5 } },
        h('span', { style: { color: T.text } }, t('push.signature')),
        // Chinese full-width brackets sit flush against the label; the Latin
        // parenthesis needs a small gap to stay legible.
        h('span', { style: { ...css.metaDim, marginLeft: LANG === 'en' ? 4 : 0 } }, t('push.signatureHint'))))

      const pushForm = () => h('div', { style: css.card },
        h('div', { style: css.field },
          h('label', { style: css.fieldLabel, htmlFor: 'sentinel-chan' }, t('push.field.channel')),
          h('select', {
            id: 'sentinel-chan', style: { ...css.select, colorScheme: dark ? 'dark' : 'light' }, value: form.channel,
            onChange: (e) => setForm({ channel: e.target.value, url: '', secret: '' }),
          }, CHANNELS.map((c) => h('option', { key: c, value: c, style: css.option }, t('chan.' + c))))),
        h('div', { style: css.field },
          h('label', { style: css.fieldLabel, htmlFor: 'sentinel-url' }, form.channel === 'telegram' ? t('push.field.token') : t('push.field.url')),
          h('input', {
            id: 'sentinel-url', style: css.input, value: form.url, spellCheck: false, autoComplete: 'off',
            placeholder: URL_HINT[form.channel] || '',
            onChange: (e) => {
              const url = e.target.value
              setForm({ ...form, url, channel: detectChannel(url) || form.channel })
            },
          })),
        (form.channel === 'dingtalk' || form.channel === 'telegram') ? h('div', { style: css.field },
          h('label', { style: css.fieldLabel, htmlFor: 'sentinel-secret' }, t(form.channel === 'telegram' ? 'push.field.chat' : 'push.field.secret')),
          h('input', {
            id: 'sentinel-secret', style: css.input, value: form.secret, spellCheck: false, autoComplete: 'off',
            onChange: (e) => setForm({ ...form, secret: e.target.value }),
          })) : null,
        webhookHelp(),
        signatureToggle(),
        // Breathing room between the switch and the actions: without it the two
        // rows read as one block and the buttons crowd the checkbox label.
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          // Also offered before the first save: the form no longer opens by
          // itself, so whoever opened it (by mistake or just to look) needs a way
          // back to the summary without saving anything.
          h('button', { type: 'button', style: css.btn, disabled: !!busy, onClick: () => { setEditing(false); setOffConfirm(false); showResult(null) } }, t('push.cancel')),
          host?.configured ? h('button', {
            type: 'button', disabled: !!busy,
            // The red border is a shorthand, not a borderColor override: this
            // button sits at the same position in the row as the "修改" button of
            // the summary, so React recycles one DOM node for both. When the
            // extra borderColor key disappears on the way back, React clears that
            // inline colour and the recycled node falls back to currentColor —
            // a hard grey ring around "修改" that no longer matches its siblings.
            style: { ...css.btn, color: offConfirm ? T.error : T.sub, border: `1px solid ${offConfirm ? T.error : T.border}` },
            onClick: disablePush,
          }, offConfirm ? t('push.disableConfirm') : t('push.disable')) : null,
          h('button', { type: 'button', style: css.btn, disabled: !!busy, onClick: () => saveWebhook(false) }, t('push.save')),
          h('button', {
            type: 'button', disabled: !!busy,
            style: busy ? { ...css.btnPrimary, opacity: 0.6, cursor: 'not-allowed' } : css.btnPrimary,
            onClick: () => saveWebhook(true),
          }, busy === 'test' ? t('push.testing') : busy === 'save' ? t('push.saving') : t('push.saveTest'))),
        // Where this sentence is actually useful: it explains what saving does,
        // so it belongs next to the save buttons, not in the summary card.
        h('div', { style: { ...css.metaDim, marginTop: 8 } }, t('push.hint')))

      // "Configured" is not "connected": a stored webhook proves nothing until a
      // test push comes back. Four states, and only a tested-good one is green —
      // an old success is dropped server-side the moment the webhook changes.
      const verifyInfo = host?.verify || null
      const connState = !host?.configured ? 'off' : !verifyInfo ? 'untested' : verifyInfo.ok ? 'verified' : 'failed'
      // One colour per state, so the dot and the badge agree and neither reads as
      // "disabled": grey means nothing is set up, blue means set up but unproven,
      // green and red mean the last test actually landed or failed.
      const connColor = connState === 'verified' ? T.success
        : connState === 'failed' ? T.error
          : connState === 'untested' ? T.brand
            : T.sub // off: a secondary grey, not the dimmed token (too faint on white)
      // Address and test time share one line: the pill on the title row already
      // says whether that test passed, so spelling out "最近测试成功" here only
      // added words. The failure reason stays on its own line — it is the one
      // thing worth reading twice.
      const testTime = verifyInfo && verifyInfo.at ? fmtTime(verifyInfo.at) : ''
      const persistedNote = verifyInfo && verifyInfo.persisted === false ? t('push.notPersisted') : ''
      const metaLine = [host?.urlHost, (connState === 'verified' || connState === 'failed') ? testTime : '', persistedNote]
        .filter(Boolean).join(' · ')
      const detailLine = connState === 'failed' ? t('push.failedWhy', { e: verifyInfo.error || '' })
        : connState === 'untested' ? t('push.untestedHint')
          : ''

      const pushSummary = () => h('div', { style: css.card },
        h('div', { style: css.row },
          h('span', { style: css.cardTitle },
            h('span', {
              style: {
                width: 8, height: 8, borderRadius: '50%', flex: 'none', background: connColor,
                // A soft ring keeps the state readable by more than hue alone and
                // stops the dot from looking like a stray speck on a wide card.
                boxShadow: connState === 'off' ? 'none' : `0 0 0 3px ${tint(connColor, 20)}`,
              },
            }),
            t('push.channel', { c: t('chan.' + host.channel) })),
          h('span', { style: css.badgeSoft(connColor) }, t('push.' + connState))),
        metaLine ? h('div', { style: css.metaDim }, metaLine) : null,
        // Failure text uses the same mixed ink as css.error: some skins tint the
        // raw error token pink, which is unreadable at 11.5px on a light card.
        detailLine ? h('div', { style: { ...css.metaDim, color: connState === 'failed' ? ink(T.error) : undefined } }, detailLine) : null,
        host.configured ? null : h('div', { style: css.metaDim }, t('push.empty')),
        // The switch keeps its own line and the explanation stays with it: this is
        // the only place a user learns what the toggle does. Actions sit below it,
        // left-aligned like the rest of the panel.
        signatureToggle(),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', disabled: !!busy || !host.configured, className: 'sentinel-btn',
            style: busy || !host.configured ? { ...css.btn, opacity: 0.5, cursor: 'not-allowed' } : css.btn,
            onClick: testPush,
          }, busy === 'test' ? t('push.testing') : t('push.test')),
          // With no auto-open this button is the section's only way in, so it has
          // to say what it does ("configure") rather than "save" — there is
          // nothing saved at this point, it just opens the form. Same wording as
          // dsh-aihot-radar's push card (push.setup), so the two panels read alike.
          // Same weight as the test button next to it: two equal actions, not a
          // primary/secondary pair.
          h('button', { type: 'button', disabled: !!busy, className: 'sentinel-btn', style: css.btn, onClick: openForm }, host.configured ? t('push.edit') : t('push.setup'))))

      const resultBlock = (r, extra) => h('div', { style: { marginTop: 8, ...extra } },
        h('div', { style: { color: r.ok ? T.success : T.error, fontSize: 12 } }, r.message),
        r.hint ? h('div', { style: { ...css.metaDim, marginTop: 4 } }, r.hint) : null)

      return h('div', { style: css.panel, className: 'sentinel-panel' },
        h('div', { style: css.head },
          h('div', { style: css.titleWrap },
            h('div', { style: css.iconBadge }, h(BellIcon, { size: 21 })),
            h('div', null,
              h('div', { style: css.h1 }, t('meta.title'), h('span', { style: { ...css.live, background: levelColor(level) }, title: t('level.' + level), 'aria-hidden': true })),
              h('div', { style: css.sub }, t('sub')))),
          h('button', { type: 'button', style: css.btn, className: 'sentinel-btn', onClick: () => setNonce((n) => n + 1) }, t('refresh'))),

        hero(),

        h('div', { style: { ...css.metaDim, marginBottom: 12 } }, t('support.scope')),

        host && host.enabled && !host.configured ? h('div', { style: css.banner },
          h('span', { style: css.bannerText }, t('banner')),
          h('button', { type: 'button', style: css.btn, onClick: () => { openForm(); scrollToPush() } }, t('bannerCta'))) : null,
        host && !host.enabled ? h('div', { style: css.warnBox }, t('monitor.off')) : null,
        host && host.quiet?.start ? h('div', { style: css.metaDim }, t('quiet.on', { s: host.quiet.start, e: host.quiet.end })) : null,
        pending ? h('div', { style: pending.hold ? css.warnBox : css.metaDim },
          pending.hold ? t('alert.hold', { e: pending.lastError || '' }) : t('alert.pending', { k: pending.kind === 'recovered' && pending.cause === 'threshold' ? t('kind.resolved') : t('kind.' + pending.kind) }),
          pending.hold ? h('button', { type: 'button', style: { ...css.btn, marginLeft: 8 }, disabled: !!busy, onClick: retryAlert }, t('alert.retry')) : null) : null,

        host ? h('div', { style: css.card },
          h('div', { style: css.h2 }, t('th.title')),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { ...css.field, flex: 1, minWidth: 110 } },
              h('label', { style: css.fieldLabel, htmlFor: 'sentinel-warn' }, t('th.warn')),
              h('input', { id: 'sentinel-warn', style: css.input, value: warnShown, inputMode: 'decimal', onChange: (e) => { thTouched.current = true; setWarnDraft(e.target.value) } })),
            h('div', { style: { ...css.field, flex: 1, minWidth: 110 } },
              h('label', { style: css.fieldLabel, htmlFor: 'sentinel-crit' }, t('th.critical')),
              h('input', { id: 'sentinel-crit', style: css.input, value: critShown, inputMode: 'decimal', onChange: (e) => { thTouched.current = true; setCritDraft(e.target.value) } }))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('button', { type: 'button', disabled: !!busy || !thValid || !thDirty, style: thValid && thDirty ? css.btnPrimary : { ...css.btnPrimary, opacity: 0.5, cursor: 'not-allowed' }, onClick: savePrefs }, t('th.save')),
            !thValid ? h('span', { style: { fontSize: 11.5 }, className: 'sentinel-th-bad' }, t('th.bad')) : null),
          h('div', { style: { ...css.metaDim, marginTop: 8 } }, t('th.hint'))) : null,
        result && result.scope === 'th' ? resultBlock(result, { marginBottom: 12 }) : null,

        h('div', { id: 'sentinel-push' },
          h('div', { style: css.h2 }, t('sec.push')),
          !host ? h('div', { style: css.bridgeBox },
            h('div', { style: css.metaDim }, t('bridge.title')),
            h('div', { style: css.pathLine }, `GET ${LOCAL_API}/status${bridgeErr ? ' → ' + bridgeErr : ''}`),
            h('div', { style: { ...css.metaDim, marginTop: 6 } }, t('bridge.path')),
            h('div', { style: css.pathLine }, '~/.dsh/balance-sentinel/state.json'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('button', { type: 'button', style: css.btn, onClick: () => setRetry((n) => n + 1) }, t('bridge.retry')),
              h('button', { type: 'button', style: css.btn, onClick: copySnippet }, t('bridge.snippet'))))
            : h('div', null, editing ? pushForm() : pushSummary())),

        result && result.scope !== 'th' ? resultBlock(result) : null,

        h('div', { style: css.foot },
          t('foot.source'), h('a', { style: css.link, className: 'sentinel-link', href: TOP_UP, target: '_blank', rel: 'noreferrer' }, 'DeepSeek', h('span', null, '↗')),
          h('a', { style: css.link, className: 'sentinel-link', href: REPO + '/issues', target: '_blank', rel: 'noreferrer' }, t('foot.feedback'), h('span', null, '↗')),
          h('a', { style: { ...css.link, marginLeft: 'auto' }, className: 'sentinel-link', href: 'https://github.com/liancheng2020/dsh-aihot-radar', target: '_blank', rel: 'noreferrer' }, t('foot.sibling'))),

        toast ? h('div', {
          className: 'sentinel-toast ' + (toast.ok ? 'sentinel-toast-ok' : 'sentinel-toast-err'),
          role: 'status', 'aria-live': 'polite', style: toastAnchor(),
        },
        h('span', { className: 'sentinel-toast-icon' }, toast.ok ? '✓' : '!'),
        h('span', { className: 'sentinel-toast-body' },
          h('span', { className: 'sentinel-toast-title' }, toast.title),
          toast.body ? h('span', { className: 'sentinel-toast-sub' }, toast.body) : null)) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        LOCALE = ctx.locale
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'balance-sentinel', order: 61, label: () => tr('meta.title', activeLang()), locale: 'balance-sentinel',
        }, BellIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'balance-sentinel', locale: 'balance-sentinel',
        }, SentinelPanel))
      },
    }
  },
})