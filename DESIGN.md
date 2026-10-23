# Design
## Source of truth
Active · 2026-10-23。依据 V1 需求及 CloudBase 全量迁移要求；沿用 React/Vite 和现有加密协议，Node.js 同源 HTTP/WebSocket 服务替代 Worker/Durable Object，CloudBase 文档数据库仅存元数据。
## Brand
极简、安静、白色；不使用渐变、插画和装饰动画。
## Product goals
两人邀请聊天、仅本机历史、提醒和单选调查。无账号、群聊、文件或云端记录。
## Personas and jobs
手机浏览器中的两位临时参与者；创建、分享邀请、聊天并完成互动。
## Information architecture
首页创建房间；房间顶部邀请/退出，中间消息，底部 +/输入/发送；互动按到达顺序全屏展示。
## Design principles
复用上游协议；最少操作；明确网络和本地保存错误；未完成提醒可退出房间。
## Visual language
默认白底黑灰文字；夜间为深灰底浅色文字。首页/房间按钮切换并记住选择，首次跟随系统，提醒保留发送者色值。16px 正文，8px 间距基础，16px 圆角气泡；提醒黄边、调查蓝边、回答绿边。
## Components
首页、房间、普通气泡、互动编辑器、全屏提醒/调查；styles.css 统一控制样式。
## Accessibility
语义表单、可见焦点、触控按钮至少44px；全屏弹层带 dialog 语义；自定义背景自动选择黑白文字。
## Responsive behavior
仅移动端设计，100dvh 与安全区内边距，消息区域单独滚动；宽屏保持简单居中列。
## Interaction states
空历史不填演示消息；显示连接/加密准备状态，失败保留输入；待发送互动保留本地等待重连。
## Content voice
简短中文，直接说明动作和失败原因。
## Implementation constraints
仅新增迁移所需的 WebSocket 与 CloudBase 服务端依赖；单容器运行，数据库租约防止多个活动实例，生产禁止本地文件存储；互动内容包装在现有加密文字消息内部，不更改密钥协商/签名/AES-GCM；IndexedDB 按房间与会话隔离。
## Deployment
CloudBase 原生 Git 持续部署，首次仅填环境ID/服务端密钥；Docker 构建先执行类型检查与单测。固定构建版本戳通过数据库请求旧版本安全交接；生产更新串行，回退刷新跟踪标记避免 Docker 缓存。
## Open questions
无阻塞问题。保留上游临时房间语义；本地明文记录不等于设备端加密，README 明示。
