# 当前验证结果

日期：2026-10-23。本轮为文档与资源整理，不更改聊天业务逻辑。早期 CloudBase 验证已移至[历史快照](docs/archive/validation/cloudbase-2026-10-23.md)，不再把旧测试数量当作当前结果。

## 本轮重新执行

| 检查 | 结果 |
| --- | --- |
| Markdown 相对链接检查 | 通过，含归档互链、图片与嵌套许可证徽章；历史路线图章节链接另行核对 |
| `npm run typecheck` | shared、crypto、web、server 四个工作区通过 |
| `npm test` | 20个文件，141/141项通过 |
| `npm run build` | 原消息协议检查、Vite 前端与 Node 服务端构建通过 |
| `npm run package` 与 ZIP 内容检查 | 源码包重新生成；核对文档、许可证及源码内容一致，无已删除旧图片、缓存、运行状态或密钥文件 |
| `git diff --check` | 通过 |

当前环境 Node.js 20.20.2；以上命令实际通过，但项目声明与 Docker 镜像仍要求 Node.js 22+，不据此降低支持版本。没有重新安装依赖或运行 Docker 构建。

本次清理另修正源码打包过滤：排除根目录 `.omx` / `.codex` 前缀运行状态文件，避免把本地运行标识打入源码 ZIP；其余打包边界不变。

## 此前功能开发的浏览器验证

以下已在本地 Chromium 与真实 Node HTTP/WebSocket 服务完成；本轮文档整理没有重复全部端到端场景。

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
