# 当前验证结果

日期：2026-10-23。以下为最近一轮房间恢复、发送焦点与消息动画开发时已执行的验证；本次仅同步文档，未重新运行完整测试。早期 CloudBase 验证见[历史快照](docs/archive/validation/cloudbase-2026-10-23.md)。

## 最近一轮代码验证

使用 Node.js 22.23.3、Chromium 148；Playwright 为外部测试工具，未新增应用依赖。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | shared、crypto、web、server 四个工作区通过 |
| `npm test` | 20个文件，154/154项通过 |
| `npm run build` | 原消息协议检查、Vite 前端与 Node 服务端构建通过 |
| `scripts/check-composer-motion-browser.mjs` | Chromium 移动触控模拟及桌面通过：连续发送四条不失焦，主动失焦后不重新聚焦；Enter 与键盘操作发送正常 |
| 同上：消息动画 | 双方新消息独立播放 220ms ease-out；历史、导入、过期标记不播放；更新、同一标记快速重挂载、切换减少动态效果均不重播；滚动与布局不变，无 React/browser 错误 |
| `scripts/check-room-hooks-browser.mjs` | React 开发及生产模式下，挂载、重复状态、重连与暂停接收场景均正常收敛 |
| `scripts/check-room-recovery-browser.mjs` | 真实本地 HTTP/WebSocket：双人加密聊天、双方刷新、关页重开、断网恢复、拒绝第三人及销毁失效通过；新消息动画只播放一次，刷新历史不播放，待发送队列恢复不把动画标记写入历史 |

## 连续点赞 React #185 修复验证

本轮在完整房间 UI 中稳定复现：一次连续触发 300 次点赞后，滚动 Hook 在布局阶段重复提交相同的未读数量和跟随状态，触发 Maximum update depth exceeded（生产模式 React #185）。修复将布局阶段的状态提交限制为值发生变化时执行；公开的滚动操作保留原有状态重置语义。

使用 Node.js 20.20.2、本地 Chromium 与外部 Playwright 验证，未新增项目依赖：

- `scripts/check-message-likes-browser.mjs`：开发及生产构建，桌面和手机触控模拟均完成 301 次点赞，无房间错误页和 React/browser 错误；草稿、焦点保留，爱心清理，翻页和刷新后计数恢复。使用模拟传输与真实 IndexedDB，无需后端。
- 本地真实 HTTP/WebSocket、两个独立浏览器上下文：连续 300 次点赞在双方准确同步，重放事件不重复计数，双方均无崩溃，动画正常清理。
- 现有 V1.1 浏览器检查 14 项通过；焦点/动画检查及滚动 Hook 开发、生产检查通过。
- `npm test`：21 个文件、158 项通过；`npm run typecheck` 四工作区、`npm run build`、脚本语法检查和 `git diff --check` 通过。

## 文档与资源验证说明

此前文档整理已执行相对链接、源码 ZIP 内容及打包过滤检查；本次未重新打包源码 ZIP。发布前仍需按 README 重新打包、构建，使下载源码与部署版本一致。本次文档同步检查相对链接及 `git diff --check`。

## 此前功能开发的浏览器验证

以下已在本地 Chromium 与真实 Node HTTP/WebSocket 服务完成；最近一轮未重复下列全部早期场景。

- 350条历史：首次只显示100条，上翻分批加载，旧记录加载保持位置；旧版 IndexedDB 升级后仍可读取。
- `.achat` 完整历史导出、正确密码导入、错误密码拒绝、重复导入新增0条；导入旧提醒/调查后立即及刷新后均不弹出旧互动。
- 两个独立浏览器上下文的正常加密聊天、提醒确认、调查作答；离开底部时新消息不抢滚动，回到底部后正常跟随。
- 连续点赞产生多颗独立爱心，各自结束后清理；后来的爱心不替换前面的，保留小幅随机轨迹与较慢淡出。

需要复现基础双浏览器检查时，先启动本地服务，再运行已有脚本（Playwright 为外部工具，不是应用依赖）：

```bash
TEST_ORIGIN=http://localhost:8080 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chromium node scripts/mobile-smoke.mjs
```

## 验证边界

- 未使用真实腾讯云凭证：未执行线上 CloudBase 部署、数据库权限、Webhook、变量继承、旧版本缩容或网关验收。
- 未运行 Docker、Safari/Android 真机、实际屏幕阅读器或独立安全审计。手机访问仍需 HTTPS。
- 无独立 ESLint 配置，未声称 lint 通过；保留的上游 Cloudflare 浏览器脚本不计入当前构建或测试结果。
