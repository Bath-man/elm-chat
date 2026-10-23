# 文档索引

## 当前版本

| 文档 | 用途 |
| --- | --- |
| [项目说明](../README.md) | 本地运行、功能、存储边界、记录备份和源码打包 |
| [CloudBase 部署](cloudbase-deploy.md) | 首次配置、Git 自动更新、回退与故障处理 |
| [当前架构](architecture.md) | Node 服务、加密通信和本地历史的边界 |
| [设计约定](../DESIGN.md) | 当前页面和交互约定 |
| [验证结果](../TEST-RESULTS.md) | 最近验证与未验证范围 |
| [贡献指南](../CONTRIBUTING.md) | 开发检查和文档维护 |
| [安全政策](../SECURITY.md) / [行为规范](../CODE_OF_CONDUCT.md) / [许可证](../LICENSE) | 保留的项目规范与许可 |

## 历史归档

- [上游 README](archive/upstream/README.md)、[上游变更日志](archive/upstream/CHANGELOG.md)及其 `docs/`：保留出处、协议设计和历史排查资料。Cloudflare、文件传输、旧 UI、自动过期等说明不能直接用于当前版本。
- [上游协议 v3 设计](archive/upstream/docs/message-protocol-v2.md)：原文件名保留为 v2；用于理解沿用的通信协议，不是新的协议版本或当前产品功能列表。
- CloudBase 已完成计划：[迁移](archive/plans/cloudbase-migration.md)、[自动更新旧方案](archive/plans/cloudbase-auto-update.md)、[最终优化](archive/plans/cloudbase-final-optimization.md)。其中版本戳/回退标记方案已废弃，当前操作以部署教程为准。
- [早期 CloudBase 验证快照](archive/validation/cloudbase-2026-10-23.md)：仅代表当时环境、功能和测试数量。

归档文档之间的相对链接和两张有引用的上游截图一并保留。删除了无引用的旧演示图片；`apps/web/public/` 中仍被上游页面源码/脚本引用的图片暂不删除，避免破坏保留工具。

`artifacts/` 中的浏览器截图和 ZIP 是可再生本地产物，不作为正式文档；截图已清理，后续由测试脚本生成。发布仍须重新打包源码并构建。
