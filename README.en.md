# dsh-balance-sentinel ｜ Balance Sentinel · DeepSeek balance alerts

[中文](README.md) | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-balance-sentinel.svg?label=npm)](https://www.npmjs.com/package/dsh-balance-sentinel)
[![npm downloads](https://img.shields.io/npm/dm/dsh-balance-sentinel.svg?label=downloads)](https://www.npmjs.com/package/dsh-balance-sentinel)
[![CI](https://github.com/liancheng2020/dsh-balance-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/liancheng2020/dsh-balance-sentinel/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liancheng2020/dsh-balance-sentinel?label=release)](https://github.com/liancheng2020/dsh-balance-sentinel/releases)
[![license](https://img.shields.io/npm/l/dsh-balance-sentinel.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](https://github.com/liancheng2020/dsh-balance-sentinel#readme)

A DeepSeek Harness plugin: **DeepSeek balance monitoring** + **two-tier low-balance alerts pushed to Feishu / DingTalk and more** + **key-free on hosts with the built-in account service, zero runtime dependencies**

> **Three lines first**
> - **Monitored while DSH runs**, stops when it exits; no remote web panel
> - Low balance pushes to Feishu / DingTalk; a top-up or threshold change sends one "recovered"/"resolved"
> - Paste a webhook in the panel → **Save and send test**; effective on save, one restart after install

**What you get** (the panel) and **a real alert** (Feishu card: critical red / warn orange / recovered green):

| Panel: balance + thresholds + channel | Low-balance alert push |
|---|---|
| ![Balance Sentinel panel: official balance, thresholds, push settings](assets/panel-balance.png) | ![Feishu low-balance alert card](assets/alert-feishu.png) |

## Install

Requires DSH ≥ `0.2.1-rc.2`, Node ≥ 18.

```sh
# straight from GitHub (works any time — start here)
dsh plugin --profile web add github:liancheng2020/dsh-balance-sentinel
# or npm (published to npm alongside each Release)
dsh plugin --profile web add dsh-balance-sentinel
# or the pinned Release tarball
dsh plugin --profile web add https://github.com/liancheng2020/dsh-balance-sentinel/releases/download/v0.1.3/dsh-balance-sentinel-0.1.3.tgz
```

Any one of the three is enough; if the npm/Release line is not live yet, use the first. Desktop app: Settings → Plugins → add `dsh-balance-sentinel` or `github:liancheng2020/dsh-balance-sentinel`. Restart DSH once.

**Where it runs**: local DSH desktop or local web host only — monitoring lives in the DSH process and **stops when DSH exits** (reopening resumes from the local state file); **no remote web panel** (the bridge binds `127.0.0.1:17430` and only accepts pages from this machine). **Key-free host accounts are supported**: the host must expose the account service with a signed-in account (key-free ≠ account-free); otherwise use `DEEPSEEK_API_KEY` or `balance.apiKey` — with neither, the panel states the exact reason.

> Current version `0.1.3` (see [CHANGELOG](CHANGELOG.md)).

## First use (two steps)

1. Open the **Balance Sentinel** panel: your real balance immediately, or a clear reason (signed out / no account service / network…).
2. Click **Set it up**, pick a channel, paste the webhook (auto-detected) → **Save and send test**. The Feishu/DingTalk form includes "How to get a bot webhook": official doc + three-step path + the security settings that channel supports. **Until a channel is saved it watches without pushing**.

Saving only gets you to "configured, not tested"; the badge turns into "last test succeeded" once a test push actually lands, and into "last test failed" (with the reason and time) when it does not. Editing the channel or credentials clears the old result, so a stale "verified" can never pass for a working endpoint.

If the balance is already below a threshold when you connect, one current-state notice is sent (once).

## How it works

- **Two levels**: below 20 pushes "warn", below 5 pushes "critical" (account currency, panel-editable); a top-up or a threshold tweak back above warn pushes one "recovered"/"resolved" notice, effective immediately on save.
- **No spam**: same level never repeats; a real top-up pushes "recovered" (10-min anti-flap cooldown); a threshold tweak that resolves a delivered alert pushes "resolved" immediately; undelivered alerts cancel silently; quiet hours defer and merge into a single push afterwards.
- **Failures are traceable and retryable**: pending alerts persist; business failures back off 10 min and hold after 3 (manual retry in the panel); timeouts and dead response bodies are "delivery unconfirmed" — held immediately, never auto re-sent; a failed state save writes a fallback receipt, so restarts and multiple instances still do not re-send it (unconfirmed restores as held, never as sent). If neither the state nor the receipt can be written, the duplicate risk is logged explicitly.
- **No wedge, no duplicate across instances**: host queries have a 15s deadline and the scheduler survives any exception; desktop + web sharing `DSH_HOME` push each transition exactly once (whole-cycle lock + disk merge).
- **Channels**: WeCom / DingTalk / Feishu (card) / Bark / ServerChan / Telegram / generic webhook; auto-chunking; HTTP-200 business failures count as failures.
- **Follows the host skin**: the panel reads `data-ds-dark-theme`, so a light skin gets white cards, hairline borders and a soft shadow, with badges, toasts and native select menus switching with it.
- Balance is the **official account number**; v1 ships no cost estimates.

## Config (optional, profile cordis.patch.yml)

```yaml
- id: balance-sentinel
  name: dsh-balance-sentinel
  config:
    balance:
      enabled: true
      pollSeconds: 60              # min 60
      warn: 20
      critical: 5
      timezone: Asia/Shanghai
      quiet: { start: "", end: "" }  # e.g. "23:00"–"08:00"
      apiKey: ""                   # fallback for older hosts only
    notify:
      signature: false             # off by default (same switch in the panel, no config edit needed); true appends the "via …" install line
      signatureText: ""            # custom text; setting only this also turns the footer on
    localApi:
      enabled: true                # panel bridge on 127.0.0.1:17430
```

Thresholds and channel are also editable in the panel; saving applies without a restart.

## Privacy & compliance

- State and webhook live only in `$DSH_HOME/balance-sentinel/` (dir 0700). **No uploads, no telemetry by default.**
- The bridge binds 127.0.0.1 only, rejects cross-site origins and never exposes the webhook url/secret; balance queries use the host account service or the official `/user/balance` API, ≥60s interval, backoff on failure. MIT licensed.

## Feedback

Install or push problems? Open an [Issue](https://github.com/liancheng2020/dsh-balance-sentinel/issues) with DSH version / plugin version / OS / raw error.

Local verification: `node scripts/selftest.mjs`, `node scripts/selftest-client.mjs`, `node scripts/verify-dedup.mjs`, `node scripts/verify-market.mjs` (plain node, zero deps).

Same author: [AIHOT Radar](https://github.com/liancheng2020/dsh-aihot-radar) (quota-reset monitoring + AI news digest).
