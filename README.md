# MiniChat：真实登录 + 图片版

完成的功能：

- 删除所有测试消息
- 删除所有假用户作为初始用户
- 默认只有一个空的“公共聊天室”
- 昵称唯一
- 首次使用昵称时，输入的密码会初始化为该昵称的密码
- 以后同一昵称必须输入相同密码登录
- 支持文字消息
- 支持图片消息
- 支持创建群聊
- 支持按已注册昵称创建私聊

注意：当前账号、密码哈希、消息仍保存在服务器内存中。服务器重启后会清空。要正式使用，下一步需要接数据库。

## Railway 设置

后端 service Root Directory：

```text
server
```

前端 service Root Directory：

```text
client
```

前端 Variables：

```text
VITE_SOCKET_URL=https://你的后端域名
```

例如：

```text
VITE_SOCKET_URL=https://1-production-1558.up.railway.app
```

## 替换现有项目

把压缩包里的这些文件替换进你现在的仓库：

```text
server/server.js
client/src/App.jsx
client/src/index.css
client/package.json
client/vite.config.js
```

然后本地执行：

```bash
cd client
npm install
cd ..
git add .
git commit -m "add auth and image messages"
git push
```

Railway 重新部署 server 和 client。
