# 开发与贡献

当前技术栈为 React/Vite + Node.js HTTP/WebSocket，开发和生产都使用进程内存保存房间。启动与功能说明见 [README](README.md)，部署见 [CloudBase 指南](docs/cloudbase-deploy.md)。

## 提交前检查

需要 Node.js 22+、npm；源码打包另需 Python 3。

```bash
npm ci
npm run typecheck
npm test
npm run build
```

构建包括消息协议和本地化检查。项目没有独立 ESLint 配置，使用 TypeScript、协议检查和功能测试验证。具体已执行结果见 [TEST-RESULTS.md](TEST-RESULTS.md)，不要把未运行的检查写为通过。

## 浏览器回归

Playwright 是外部测试工具，不是应用依赖。以下为 Bash 示例，浏览器和模块路径按本机安装调整：

```bash
npm install --prefix /tmp/elm-browser-test playwright
/tmp/elm-browser-test/node_modules/.bin/playwright install chromium
export PLAYWRIGHT_MODULE=/tmp/elm-browser-test/node_modules/playwright/index.mjs
```

先构建，再启动本地生产服务：

```bash
npm run build
PORT=5210 npm start
```

另开终端执行需要的检查：

```bash
TEST_ORIGIN=http://127.0.0.1:5210 node scripts/check-room-recovery-browser.mjs
TEST_ORIGIN=http://127.0.0.1:5210 node scripts/mobile-smoke.mjs
```

进程重启回归自行启动和清理独立临时服务，无需预先启动服务：

```bash
node scripts/check-memory-restart-browser.mjs
```

| 脚本 | 用途 | 服务要求 |
| --- | --- | --- |
| `check-room-recovery-browser.mjs` | 双人加密聊天、刷新/关页恢复、断网、准入限制、失效后本地记录 | 已启动的本地服务，设置 `TEST_ORIGIN` |
| `check-memory-restart-browser.mjs` | 真实进程重启、旧房失效、凭证/待发内容保留、本地备份、新房隔离 | 已构建，脚本自行启动服务 |
| `mobile-smoke.mjs` | 手机视口下文字、提醒/调查、去重、待发队列和布局 | 已启动的本地服务，设置 `TEST_ORIGIN` |
| `check-composer-motion-browser.mjs` | 发送焦点与新消息动画 | 脚本自行启动前端测试服务 |
| `check-room-hooks-browser.mjs` | React Hooks 在挂载与重连时收敛 | 脚本自行启动前端测试服务 |
| `check-message-likes-browser.mjs` | 桌面/触控连续点赞、焦点、动画与刷新恢复 | 已启动的本地前端，设置 `TEST_ORIGIN` |

使用已有 Chromium 时，`mobile-smoke.mjs` 设置 `CHROMIUM_PATH`，表中其余脚本设置 `CHROME_PATH`。测试仅使用本地服务，不要把 `TEST_ORIGIN` 指向线上房间。触控模拟不能代替实体手机与系统键盘验收。

其他 `scripts/check-*-browser.mjs` 是专项工具，运行前查看脚本顶部的服务、端口和环境变量约定。

## 常见环境问题

- **HTTPS**：Web Crypto 需要 HTTPS 或 localhost；手机不能通过普通 HTTP 局域网地址使用加密聊天。
- **Windows `EPERM`**：停止本项目 Node 服务及占用文件的程序，在 PowerShell 中执行 `cmd /c rmdir /s /q node_modules`，再运行 `npm ci`。保留源码、锁文件和浏览器网站数据。
- **Windows/WSL 的 esbuild 平台不匹配**：在实际运行环境重新执行 `npm ci`，不要跨操作系统复制 `node_modules`。
- **旧浏览器缺少加密能力**：更新浏览器并使用 HTTPS，不要关闭加密绕过错误。

## 源码打包

```bash
npm run package
npm run build
```

打包输出 `artifacts/mobile-anonymous-chat-v1.zip`，并复制到 `apps/web/public/source.zip`；构建后通过 `/source.zip` 下载。CloudBase Docker 构建会自动执行打包。

源码包排除依赖、构建缓存、运行状态、`.env` 和密钥文件，保留无密钥 `.env.example`。修改源码或文档后应重新打包、构建，确保下载内容对应运行版本。

## 贡献约定

- 行为变化补必要回归测试，保持改动可审查。
- 不提交密码、云密钥、`.env`、本地聊天记录、缓存或测试截图；不记录聊天正文或恢复凭证。
- 新增文档前先更新已有入口；删除过期说明和失效链接，不持续累积已完成计划或测试快照。
- 网络服务不增加数据库、文件元数据存储或聊天历史上传；涉及这些边界的改动须明确说明。
- 安全问题按 [SECURITY.md](SECURITY.md) 私下报告。贡献适用 [AGPL-3.0](LICENSE) 与[行为规范](CODE_OF_CONDUCT.md)。
