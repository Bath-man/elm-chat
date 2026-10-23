# 极简匿名聊天 V1

基于 [shawnbure/elm-chat](https://github.com/shawnbure/elm-chat)，保留 React + Vite、WebSocket 和原有端到端加密；后端已迁移为 Node.js，支持整个项目部署到腾讯 CloudBase 云托管，**运行无需 Cloudflare**。无需账号，仅限两人。

## 本地运行

需要 **Node.js 22+**、npm；生成 ZIP 另需 Python 3。

```bash
npm ci
npm run build
npm run dev
```

打开 **http://localhost:3000**。Vite 将 `/api` 和 WebSocket 代理到本地 Node 服务（8080 端口）。默认 `STORAGE_DRIVER=file`，房间元数据写入 `.data/rooms.json`；此模式只用于本地开发。

运行生产构建：`npm start`，打开 **http://localhost:8080**。环境变量模板见 `.env.example`；模板不会自动加载，请在终端或部署平台设置所需变量。

1. 创建房间 → 点击“邀请” → 复制邀请链接。
2. 用**另一个浏览器、独立隐私窗口或另一台设备**打开链接；同一浏览器的多个普通标签共享房主凭证，不适合模拟两人。
3. 输入文字直接发送；输入框旁“+”可发送提醒、单选调查。
4. 提醒/调查在线收到即自动全屏打开，多条按顺序排队。确认提醒回复 `√`；调查回复选项文字。
5. 任意全屏互动都能“退出房间”；退出不会清除本机未完成互动，重新打开原标签中的链接会恢复。

本机直接使用 localhost 即可测试。真机访问需要 **HTTPS**：Web Crypto 仅在安全上下文（HTTPS 或 localhost）可用。普通 `http://局域网IP` 不是受支持启动方式；建议先部署，再用两台手机访问同一 HTTPS 域名。

### Windows 安装遇到 EPERM

先停止本项目的 Node 开发服务和占用文件的程序，再在项目根目录 PowerShell 执行：

```powershell
cmd /c rmdir /s /q node_modules
npm ci
```

这只删除可重装的依赖目录，不要删除源码和 `package-lock.json`。不需要改用管理员权限或关闭系统安全保护。

## 功能与存储

- 首页和房间顶部支持日间/夜间切换，记住本机选择；首次跟随系统。提醒仍显示发送者指定的背景色。

- 房间最多两个已准入身份，断线仍占席，不能通过新邀请挤入第三人。邀请一次有效，默认 10 分钟。
- 原有 AES-GCM、ECDH 密钥协商、ECDSA 签名、成员变更密钥轮换、身份/邀请校验保留。
- `notice.request`、`notice.ack`、`poll.request`、`poll.answer` 是**原加密文字载荷内**的类型，不是明文 WebSocket 事件；中继只转发密文，不保存聊天正文。
- IndexedDB 保存本机聊天正文和待发送消息；刷新后恢复。互动请求有唯一 ID，回答有稳定关联 ID，重复事件不会生成重复回答。
- 历史默认显示最近约100条，上翻分批加载并保持阅读位置；收到新消息时，仅在底部自动跟随。查找仅覆盖已加载的可见消息。
- 聊天菜单支持「导出记录」「导入记录」：完整历史在浏览器本地使用密码加密为 `.achat`（AES-GCM + PBKDF2，随机盐与 IV），导出不受加载条数限制。导入保留时间、内容和类型，按消息 ID 去重；只保存到本机，不发送给对方，也不触发旧互动。密码错误或文件损坏会提示失败。
- 支持点赞、涂改、置顶、骰子和隐藏文字。连续点赞的爱心独立播放，带小幅随机飘动与渐隐，不互相替换。
- 对方离线时消息显示“待发送”，本机页面重连且对方上线后尝试发送。不是云端离线邮箱，也不提供已读/保证送达回执。
- V1 创建的房间不设置消息或房间自动过期。服务器只持久化房间元数据、邀请和准入身份。
- **本机记录是明文，不是设备端加密备份**。清理网站数据会丢失历史。不要在公用设备使用。
- `.achat` 仅加密导出文件，不会加密 IndexedDB；密码不上传服务器，忘记密码无法解密备份。备份文件和密码请自行妥善保管。
- 身份沿用上游的标签页 sessionStorage，刷新可续用；关闭标签、换浏览器/域名或清除会话可能无法再加入已占席房间。V1 无账号恢复、跨设备历史或历史列表。
- 手机浏览器后台/锁屏时可能暂停 WebSocket；“立即弹出”指页面在线收到事件后立即展示，不是系统推送通知。

## 手机报错排查

- `crypto.randomUUID is not a function`：本版已添加安全兼容实现，使用 `crypto.getRandomValues` 生成 UUID，不使用 `Math.random`；会话、消息、提醒和调查共用此实现。
- **如果手机打开的是 `http://192.168...` 等局域网地址，仅兼容 UUID 仍不够**：浏览器会限制聊天所需的 `crypto.subtle`。请改用 CloudBase 部署生成的 HTTPS 地址，并在手机系统浏览器打开。
- 缺少 HTTPS 或加密能力时，现在显示中文说明，不会以关闭加密的方式继续，也不会进入崩溃页面。
- 更新源码后执行 `npm run build` 并重新部署；本地开发服务需刷新页面。浏览器较旧时请更新 Safari/Chrome。

参考：[randomUUID 的安全上下文要求](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)、[Web Crypto subtle 的安全上下文要求](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle)。

## CloudBase：一次配置，推送自动更新

**首次**：把源码放进自己的 GitHub/GitLab 仓库，在 CloudBase 容器型云托管授权绑定仓库及分支，开启“自动部署”和“自动灰度”。创建 `chat_rooms`、`chat_runtime` 两个数据库集合，客户端读写均拒绝。

运行变量只填两项：

```text
TCB_ENV_ID=你的环境ID
CLOUDBASE_APIKEY=你的服务端APIKey
```

其他使用默认值：根目录 `Dockerfile`、端口 `8080`、最小/最大副本 `0/1`、公网 HTTPS；生产自动选用 CloudBase 存储。密钥保存在自动部署的运行配置中，首次须通过一次 main 提交确认新版本继承，不能只给旧容器临时设置，也不能放进前端或仓库。

**以后**：提交并 push 到绑定分支，CloudBase 自动测试、构建、发布和交接，无需重复上传 ZIP 或填写密钥。回退可在 GitHub 网页 Revert 功能 PR 并合并到 main，无需本地命令或额外版本文件。更新可能短暂断线；新版本按实际用户路由请求租约交接，旧版停止争抢并断开旧连接。旧版流量为 0、最小副本为 0 时由平台回收实例，历史镜像不会自动删除。不支持多活动副本。

**[首次配置与自动更新教程](docs/cloudbase-deploy.md)**（包含 Webhook、健康检查、变量继承和故障处理）。首次账号授权/收费资源需要在你自己的控制台完成，本地无法代办；未声称已经上线。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

实际运行结果和验证边界见 [TEST-RESULTS.md](TEST-RESULTS.md)。现行说明及历史资料入口见[文档索引](docs/README.md)。项目原先没有独立 ESLint 配置，未新增 lint 依赖；使用 TypeScript、协议检查、构建和功能测试验证。

可选手机浏览器自动化脚本：`scripts/mobile-smoke.mjs`。使用外部安装的 Playwright，不是应用运行依赖：

```bash
npm install --prefix /tmp/elm-browser-test playwright
/tmp/elm-browser-test/node_modules/.bin/playwright install chromium
# 先另开终端运行 npm run dev
PLAYWRIGHT_MODULE=/tmp/elm-browser-test/node_modules/playwright/index.mjs node scripts/mobile-smoke.mjs
```

测试会创建临时房间，不会连接线上服务。可用 `TEST_ORIGIN` 指向本地生产构建，`CHROMIUM_PATH` 指向现有 Chromium。

## 源码与 ZIP

```bash
npm run package
```

输出：`artifacts/mobile-anonymous-chat-v1.zip`，并复制到 `apps/web/public/source.zip`。打包排除 node_modules、构建缓存、运行状态、`.env` 等密钥文件（保留无密钥 `.env.example` 模板）；**修改源码后请重新打包，再构建/部署**，页面底部提供对应源码下载。

主要改动：
- `apps/web/src/App.tsx` / `styles.css`：手机首页、房间、原通信接入、本地待发送队列。
- `interactions.ts` / `InteractionDialogs.tsx`：互动载荷、去重、全屏表单。
- `history.ts` / `history-archive.ts`：原生 IndexedDB 分页、合并去重和本地加密备份。
- `apps/server/`：Node HTTP/WebSocket 服务、房间准入和 CloudBase 元数据持久化。

不提供账号、群聊、聊天附件/图片/音视频、云同步或管理后台；`.achat` 是本机记录备份，不是向对方发送文件。保留部分上游工具与未使用前端代码，以免无关大规模重构；其历史文档已归档，不参与本版构建或部署。

## 原项目与许可证

上游：[elm-chat](https://github.com/shawnbure/elm-chat)，基线提交 `4c3c46cafa8cf2af3fff0b9ed2e7d28cc7d08f41`。原 README、变更日志和技术说明保留在[上游归档](docs/archive/upstream/README.md)，许可证原文保留在 [LICENSE](LICENSE)。

本修改版继续使用 **GNU AGPL-3.0**。对外提供修改版网络服务时，应向用户提供对应版本完整源码与构建/运行所需文件，并保留原有许可证和相关声明。本项目提供 `/source.zip` 下载入口；发布前须重新打包以匹配运行版本。
