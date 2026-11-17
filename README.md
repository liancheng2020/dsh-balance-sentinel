# dsh-balance-sentinel ｜ 余额哨兵

[中文](README.md) | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-balance-sentinel.svg?label=npm)](https://www.npmjs.com/package/dsh-balance-sentinel)
[![npm downloads](https://img.shields.io/npm/dm/dsh-balance-sentinel.svg?label=downloads)](https://www.npmjs.com/package/dsh-balance-sentinel)
[![CI](https://github.com/liancheng2020/dsh-balance-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/liancheng2020/dsh-balance-sentinel/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liancheng2020/dsh-balance-sentinel?label=release)](https://github.com/liancheng2020/dsh-balance-sentinel/releases)
[![license](https://img.shields.io/npm/l/dsh-balance-sentinel.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](https://github.com/liancheng2020/dsh-balance-sentinel#readme)

**DeepSeek 余额不足，自动提醒到飞书／钉钉等 IM。** 后台监控、主动来找你；带官方账号服务的宿主**免填 API Key**（需已登录）。

> **先看三行**
> - 本机 DSH Desktop／本机 Web，**DSH 运行期间才监控**；不支持远程 Web 面板
> - 余额低于阈值自动推送到飞书／钉钉，充值或调阈值后推一条「恢复/解除」
> - 面板里粘 webhook → **保存并发送测试**，保存即生效；装完只需重启一次

**装完就是这样**（面板）与**真实告警**（飞书卡片：告急红 / 预警橙 / 恢复绿）：

| 面板：余额 + 阈值 + 通道 | 低余额告警推送 |
|---|---|
| ![余额哨兵面板：官方余额、告警阈值、推送配置](assets/panel-balance.png) | ![飞书低余额告警卡片](assets/alert-feishu.png) |

## 安装

要求：DSH ≥ `0.2.1-rc.2`、Node ≥ 18。

```sh
# npm（推荐）
dsh plugin --profile web add dsh-balance-sentinel
# 或 GitHub 仓库直装
dsh plugin --profile web add github:liancheng2020/dsh-balance-sentinel
# 或 Release 直链
dsh plugin --profile web add https://github.com/liancheng2020/dsh-balance-sentinel/releases/download/v0.1.0/dsh-balance-sentinel-0.1.0.tgz
```

桌面端：设置 → 插件 → 添加插件，填 `dsh-balance-sentinel`。装完重启一次 DSH。

## 支持范围

- **本机 DSH Desktop／本机 Web**：监控跑在 DSH 进程里，退出即停，重开从本机状态继续。
- **不支持远程 Web 面板**：面板走 `127.0.0.1:17430` 本地桥接，只接受本机页面。
- **免 Key 需宿主内置账号服务且已登录** DeepSeek 账户（免 Key ≠ 无需账户）；否则用 `DEEPSEEK_API_KEY` 或 `balance.apiKey`，都没有时面板给出明确原因。

## 首次使用（两步接通）

1. 打开 **余额哨兵** 面板：立刻看到真实余额，或明确原因（未登录 / 无账号服务 / 网络…）。
2. 「推送配置」选通道 → 粘 webhook（自动识别）→ **保存并发送测试**。飞书／钉钉框内有「如何获取机器人 Webhook」：官方链接 + 三步路径 + 该通道适用的安全设置。**没配通道前只监控不推送**。

接通时余额已低于阈值，会补发一条当前状态（仅一次）。

## 它怎么工作

- **两级阈值**：默认低于 ¥20 推「预警」、低于 ¥5 推「告急」（账户币种，面板可改）；充值或调阈值回到预警之上推一条「恢复/解除」，保存即生效。
- **不刷屏**：同级停留不重推；充值回升推「恢复」（10 分钟冷却防抖），调阈值解除已送达告警立即推「解除」；告警未送达时静默取消；免打扰时段顺延、出窗合并成一条。
- **不漏发**：待发送告警持久化；业务失败 10 分钟退避、3 次后挂起可手动重试；超时等「送达不确定」立即挂起、不自动重发；状态保存失败时落盘备用回执，重启／多实例恢复后仍不重发（不确定的恢复为挂起，不标记成功）。状态与回执都无法落盘时会明确告警「去重无法保证」。
- **不卡死、多实例不重推**：宿主查询 15s 兜底，任何异常后调度继续；desktop + web 共享 `DSH_HOME` 时整周期锁 + 磁盘合并，同一跃迁只推一次。
- **通道**：企微 / 钉钉 / 飞书（消息卡片）/ Bark / Server酱 / Telegram / 通用 Webhook；超长自动分条；HTTP 200 但业务失败同样判失败。
- 余额来自**官方账户同源**，v1 不做成本估算。

## 配置（可选，profile 的 cordis.patch.yml）

```yaml
- id: balance-sentinel
  name: dsh-balance-sentinel
  config:
    balance:
      enabled: true                # 关掉即停监控，面板仅展示
      pollSeconds: 60              # 最小 60
      warn: 20                     # 预警阈值（账户币种）
      critical: 5                  # 告急阈值
      timezone: Asia/Shanghai
      quiet: { start: "", end: "" }  # 免打扰，如 "23:00"–"08:00"
      apiKey: ""                   # 仅老宿主回落用；优先宿主账号/环境变量
    notify:
      signature: true              # 推送尾部署名「via 余额哨兵 · 安装：github:…」，可关
      signatureText: ""
    localApi:
      enabled: true                # 面板桥接 127.0.0.1:17430，可关
```

阈值与通道也可在面板里改，保存即生效，无需重启。

## 隐私与合规

- 状态与 webhook 仅存本机 `$DSH_HOME/balance-sentinel/`（目录 0700），**不上传、默认无遥测**。
- 本地桥接只绑 127.0.0.1、拒绝跨站来源，且不暴露 webhook url/secret；余额查询走宿主账号服务或官方 `/user/balance`，60s+ 间隔、失败退避。代码 MIT。

## 反馈

装不上或推送不通，请带 DSH 版本 / 插件版本 / 系统 / 报错原文到 [Issues](https://github.com/liancheng2020/dsh-balance-sentinel/issues)。

本地验证：`node scripts/selftest.mjs`、`node scripts/selftest-client.mjs`、`node scripts/verify-dedup.mjs`、`node scripts/verify-market.mjs`（纯 node、零依赖）。

同作者另一插件：[AIHOT 雷达](https://github.com/liancheng2020/dsh-aihot-radar)（额度重置监控 + AI 资讯日报）。
