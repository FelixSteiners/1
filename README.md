# MiniChat No SQL Fixed

这个版本删除了 PostgreSQL / DATABASE_URL / pg 依赖，恢复为服务器内存存储版。

包含：

- 不需要 DATABASE_URL
- 不需要 PostgreSQL
- 不需要 pg 包
- 删除清空会话数据功能
- 删除 reset_demo 后端事件
- 默认没有假消息、假用户
- 昵称唯一
- 首次使用昵称时初始化密码
- 后续同昵称必须输入相同密码
- 支持文字消息
- 支持图片消息

注意：因为这是内存存储版，Railway 后端重启后，账号、密码、消息都会清空。
