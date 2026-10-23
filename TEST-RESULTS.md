# 本次验证结果：CloudBase 自动更新整理

日期：2026-10-23。使用 Node.js 22.23.4，在独立 Linux 验证目录运行；未修改项目原有 Windows node_modules。

## 已运行

| 检查 | 结果 |
| --- | --- |
| 全新 `npm ci` | 通过；锁文件包含跨平台可选依赖 |
| `npm run typecheck` | shared、crypto、web、server 四个工作区通过 |
| `npm test` | 15 个文件，101/101 项通过 |
| `npm run build` | 原消息协议检查、Vite 前端、Node 服务端构建通过 |
| `npm ci --omit=dev` 后启动构建产物 | 通过（独立运行目录，仅生产依赖，本地文件元数据模式） |
| 生产环境缺少 CloudBase 配置 | 按预期提示缺少环境 ID / 密钥并拒绝启动，不降级到容器临时文件 |

新增后端测试使用真实 Node HTTP/WebSocket；覆盖创建、房主权限、双人席位、并发加入、身份绑定、邀请重连、元数据恢复、密文不持久化、数据库故障、跨域拒绝、存活/就绪分离。CloudBase SDK 通过模拟数据库验证普通/事务返回值、单实例租约、过期接管、旧实例写入 fencing。

审查发现并修复两个实际问题，均补回归：非法/中途断开的 WebSocket 握手不再锁死房间队列；明确为 null 的过期配置不会被替换成上游默认时限。

## 本轮自动更新回归

- 生产只需提供 `TCB_ENV_ID` / `CLOUDBASE_APIKEY`；默认 CloudBase，仍拒绝生产文件存储。
- 新版本请求交接、旧版停止续租后释放、短时预留防旧版抢回、同版本不互相驱逐、请求过期后故障恢复、损坏版本字段失败关闭。
- 构建将固定版本戳嵌入服务端 bundle，容器重启不重新生成；新增脚本语法检查与实际 esbuild 构建通过。
- 回退刷新命令在临时目录验证：只更新无密钥构建标记，连续两次内容不同；避免 Docker 复用旧版本缓存。
- Dockerfile 在镜像构建前串联类型检查和单测；本地分别运行同一命令链通过，未运行 Docker 本身。
- 官方确认采用原生 Git 绑定 + Webhook 自动部署 + 自动灰度，无需第三方 CI 或新增应用依赖；本地不等于已经给云账号启用 Webhook。

## 浏览器功能验证

执行 `scripts/mobile-smoke.mjs`，连接本地构建后的 Node 服务（仅生产依赖）；两个独立 Chromium 手机尺寸上下文，设置 `TEST_NO_RANDOM_UUID=1` 模拟缺少原生 UUID API。

11 组通过：
1. 邀请加入、无演示消息。
2. 双向实时文字。
3. 自定义 HEX 提醒自动全屏、尺寸覆盖网页。
4. 未确认提醒刷新后恢复。
5. 确认自动回复一个绿色边框 `√`。
6. 提醒/调查排队，单选提交自动返回答案。
7. 重放已接收事件不重复弹窗或回答。
8. 抓取的文字及互动 WebSocket 载荷为密文，协议版本仍为 v3。
9. 双端刷新后保留 IndexedDB 历史及完成状态。
10. 对方离线后重连、轮换密钥并发送本地待发消息。
11. 320/390px 页面无横向溢出，阻塞提醒可退出房间。

复现命令（Playwright 为外部测试工具，不是应用依赖）：

```bash
TEST_NO_RANDOM_UUID=1 TEST_ORIGIN=http://localhost:8819 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chromium node scripts/mobile-smoke.mjs
```

已移除 Cloudflare 运行入口、Wrangler/Vitest 插件依赖及旧平台部署测试；现在测试普通 Node 服务，不再把旧平台测试数计入结果。

## 验证边界

- 没有腾讯云环境凭证：**未执行真实 CloudBase 部署、数据库权限/连通或线上 WebSocket 网关测试**。
- 当前环境没有 Docker：**未运行 `docker build`**；已分别验证同一 npm 构建链和仅生产依赖的运行目录。
- 使用 Chromium 手机尺寸模拟，不是 Safari/Android 真机验收；手机实际访问仍必须 HTTPS。
- 无独立 ESLint 配置，未运行或声称 lint 通过；未进行完整安全审计。
- 本版明确只支持单个活动服务实例，数据库租约防滚动更新双开，不支持水平扩容；发布可能短暂断线。
