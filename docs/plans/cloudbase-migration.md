# CloudBase 完整迁移

目标：完全取消 Cloudflare 运行/部署依赖；保留前端、加密协议和房间鉴权。

采用一个 Node.js HTTP/WebSocket 容器同时提供前端与 API，部署 CloudBase 云托管。
原 RoomDurableObject 业务迁移为普通 Room + 串行队列，避免重写协议。
云数据库仅存房间/邀请/准入元数据，不存消息正文或密文；本地开发用 JSON 元数据文件。
云端固定单实例；数据库全局租约防止滚动更新时新旧实例同时持有房间。
前端同源，不额外引入登录、跨域接口或新 UI。

执行顺序：
1. 为 Node HTTP/WS、权限、人数、重启恢复和存储故障写失败测试。
2. 迁移原房间逻辑；实现文件/CloudBase 元数据存储、租约、Node 服务和 10 秒心跳。
3. 替换 npm 构建/启动/测试、移除 Cloudflare 依赖和入口；新增 Docker 与简明教程。
4. 运行单测、typecheck、构建、真实双浏览器互动/密文测试；打包源码。

边界：没有腾讯云凭证时不执行真实云部署，不声称云端验收通过。

本地实现与验证完成：95 项单测、类型检查、构建和 11 组双浏览器检查通过。
部署说明见 docs/cloudbase-deploy.md；真实云部署及 Docker 镜像构建未运行，原因见 TEST-RESULTS.md。
