# 开发与贡献

当前版本使用 React/Vite + Node.js HTTP/WebSocket，生产部署到 CloudBase，不使用 Cloudflare Worker。上游贡献流程保留在[历史归档](docs/archive/upstream/CONTRIBUTING.md)，不作为当前启动指南。

## 本地开发

需要 Node.js 22+ 和 npm，源码打包另需 Python 3。

```bash
npm ci
npm run build
npm run dev
```

打开 http://localhost:3000；模拟两人时使用独立浏览器或隐私窗口，不要使用共享身份的普通标签页。配置与 HTTPS 要求见 [README](README.md)，部署见 [CloudBase 教程](docs/cloudbase-deploy.md)。

## 提交前检查

```bash
npm run typecheck
npm test
npm run build
```

- 改动保持小而明确，涉及行为变化时补必要回归测试。
- 不提交密码、云密钥、`.env`、本地聊天记录、缓存或测试截图。
- 不增加聊天正文日志或遥测；说明任何服务端可见数据与保留范围变化。
- 调整文档目录时同步修正链接；旧方案放入 `docs/archive/` 并标明历史用途。
- 发布前运行 `npm run package`，然后重新构建，使 `/source.zip` 与发布源码对应。

浏览器检查方法与验证边界见 [TEST-RESULTS.md](TEST-RESULTS.md)。无独立 ESLint 配置，不将上游历史检查脚本视为当前默认构建门槛。

安全问题不要提交公开漏洞细节，参见 [SECURITY.md](SECURITY.md)。贡献继续适用 [AGPL-3.0](LICENSE) 与[行为规范](CODE_OF_CONDUCT.md)。
