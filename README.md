# MiniChat Online

一个最小可运行的联网聊天软件 Demo，支持：

- Socket.IO 实时通信
- 多浏览器窗口同步消息
- 群聊
- 私聊
- 未读数
- 群成员列表
- 创建群聊 / 创建私聊
- 服务器端内存保存聊天状态

> 注意：这是学习版 Demo。服务器重启后消息会丢失。真正上线时应该接 PostgreSQL / MySQL / MongoDB 保存数据。

## 运行方法

进入项目目录：

```bash
cd minichat-online
```

安装前后端依赖：

```bash
npm run install:all
```

启动后端：

```bash
npm run dev:server
```

再开一个终端，启动前端：

```bash
npm run dev:client
```

打开浏览器：

```text
http://localhost:5173
```

## 怎么测试联网

1. 打开两个浏览器窗口。
2. 分别输入不同昵称，例如 Felix 和 Alice。
3. 都进入“课程项目群”。
4. 一个窗口发消息，另一个窗口会实时收到。

## 如果想让同一个局域网的另一台设备访问

前端 Vite 默认已经使用：

```bash
vite --host 0.0.0.0
```

你还需要：

1. 找到运行后端电脑的局域网 IP，例如 `192.168.1.23`。
2. 启动前端时指定后端地址：

```bash
VITE_SOCKET_URL=http://192.168.1.23:4000 npm run dev:client
```

Windows PowerShell 可以用：

```powershell
$env:VITE_SOCKET_URL="http://192.168.1.23:4000"; npm run dev:client
```

然后其他设备访问：

```text
http://192.168.1.23:5173
```

## 下一步可以升级什么

- 接数据库，保存历史消息
- 做注册登录和密码认证
- 做真正的好友系统
- 做图片/文件上传
- 做离线推送
- 做消息撤回、已读回执
- 做部署上线
