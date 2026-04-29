import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";

const PORT = process.env.PORT || 4000;

const app = express();

// Demo 阶段先允许所有来源连接，方便 Railway 前端访问后端
app.use(cors({ origin: "*" }));

app.get("/", (_, res) => {
  res.json({
    ok: true,
    name: "MiniChat Online Server",
    message: "Socket.IO server is running."
  });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const connectedUsers = new Map();

const demoUsers = [
  { id: "u1", name: "林同学", avatar: "林", status: "online", bio: "正在学习高数" },
  { id: "u2", name: "王助教", avatar: "王", status: "online", bio: "课程助教" },
  { id: "u3", name: "陈同学", avatar: "陈", status: "offline", bio: "项目小组成员" },
  { id: "u4", name: "赵同学", avatar: "赵", status: "online", bio: "负责前端页面" },
  { id: "u5", name: "刘同学", avatar: "刘", status: "offline", bio: "负责数据库设计" }
];

function nowLabel() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function makeInitialState() {
  return {
    users: [...demoUsers],
    conversations: [
      {
        id: "g1",
        type: "group",
        title: "课程项目群",
        description: "Socket.IO 联网群聊演示。多个浏览器窗口登录不同名字即可实时聊天。",
        ownerId: "u2",
        memberIds: ["u1", "u2", "u3", "u4", "u5"],
        unreadByUser: {},
        pinned: true,
        messages: [
          {
            id: randomUUID(),
            sender: "u2",
            text: "大家先把联网功能跑起来：一个终端开 server，一个终端开 client。",
            time: "系统初始化",
            status: "delivered"
          },
          {
            id: randomUUID(),
            sender: "u4",
            text: "前端通过 socket.emit 发送消息，通过 socket.on 接收服务器广播。",
            time: "系统初始化",
            status: "delivered"
          }
        ]
      },
      {
        id: "g2",
        type: "group",
        title: "宿舍闲聊群",
        description: "另一个群聊，用来测试多个会话。",
        ownerId: "u3",
        memberIds: ["u1", "u3", "u4"],
        unreadByUser: {},
        pinned: false,
        messages: [
          {
            id: randomUUID(),
            sender: "u3",
            text: "晚上有人去吃夜宵吗？",
            time: "系统初始化",
            status: "delivered"
          }
        ]
      }
    ]
  };
}

let state = makeInitialState();

function emitState() {
  io.emit("chat_state", state);
}

function addSystemMessage(conversationId, text) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;

  conversation.messages.push({
    id: randomUUID(),
    sender: "system",
    text,
    time: nowLabel(),
    status: "system"
  });
}

function ensureUserInState(user) {
  const index = state.users.findIndex((item) => item.id === user.id);

  if (index >= 0) {
    state.users[index] = user;
  } else {
    state.users.push(user);
  }
}

function addUserToDefaultGroup(user) {
  const group = state.conversations.find((item) => item.id === "g1");
  if (!group) return;

  if (!group.memberIds.includes(user.id)) {
    group.memberIds.push(user.id);
    group.unreadByUser[user.id] = 0;
    addSystemMessage(group.id, `${user.name} 加入了群聊`);
  }
}

function createBotUser() {
  const n = state.users.filter((user) => user.id.startsWith("bot_")).length + 1;

  const bot = {
    id: `bot_${randomUUID()}`,
    name: `演示联系人 ${n}`,
    avatar: String(n),
    status: "online",
    bio: "服务器生成的演示私聊对象"
  };

  state.users.push(bot);
  return bot;
}

function requireLogin(socket) {
  if (!socket.data.userId) {
    socket.emit("error_message", "你还没有登录。");
    return false;
  }

  return true;
}

io.on("connection", (socket) => {
  socket.emit("chat_state", state);

  socket.on("login", ({ name }) => {
    const displayName = String(name || "匿名用户").trim().slice(0, 20) || "匿名用户";

    const user = {
      id: `real_${socket.id}`,
      name: displayName,
      avatar: displayName.slice(0, 1).toUpperCase(),
      status: "online",
      bio: "真实联网用户"
    };

    socket.data.userId = user.id;
    socket.data.name = user.name;
    connectedUsers.set(socket.id, user);

    ensureUserInState(user);
    addUserToDefaultGroup(user);

    socket.emit("login_success", {
      currentUser: user,
      state
    });

    emitState();
  });

  socket.on("logout", () => {
    const user = connectedUsers.get(socket.id);

    if (user) {
      user.status = "offline";
      ensureUserInState(user);
      connectedUsers.delete(socket.id);
      emitState();
    }

    socket.data.userId = null;
  });

  socket.on("mark_read", ({ conversationId }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;

    conversation.unreadByUser[socket.data.userId] = 0;
    socket.emit("chat_state", state);
  });

  socket.on("send_message", ({ conversationId, text }) => {
    if (!requireLogin(socket)) return;

    const cleanText = String(text || "").trim();
    if (!cleanText) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);

    if (!conversation) {
      socket.emit("error_message", "会话不存在。");
      return;
    }

    if (!conversation.memberIds.includes(socket.data.userId)) {
      socket.emit("error_message", "你不是这个会话的成员，不能发消息。");
      return;
    }

    conversation.messages.push({
      id: randomUUID(),
      sender: socket.data.userId,
      text: cleanText.slice(0, 1000),
      time: nowLabel(),
      status: "delivered"
    });

    for (const memberId of conversation.memberIds) {
      if (memberId !== socket.data.userId) {
        conversation.unreadByUser[memberId] = (conversation.unreadByUser[memberId] || 0) + 1;
      }
    }

    emitState();

    if (conversation.type === "private") {
      const botId = conversation.memberIds.find((id) => id.startsWith("bot_"));

      if (botId) {
        setTimeout(() => {
          conversation.messages.push({
            id: randomUUID(),
            sender: botId,
            text: "收到，这是服务器模拟回复。真正上线时这里会变成对方用户的真实消息。",
            time: nowLabel(),
            status: "delivered"
          });

          conversation.unreadByUser[socket.data.userId] =
            (conversation.unreadByUser[socket.data.userId] || 0) + 1;

          emitState();
        }, 700);
      }
    }
  });

  socket.on("create_private", () => {
    if (!requireLogin(socket)) return;

    const bot = createBotUser();

    const conversation = {
      id: `p_${randomUUID()}`,
      type: "private",
      title: "",
      description: "联网私聊演示",
      ownerId: socket.data.userId,
      memberIds: [socket.data.userId, bot.id],
      unreadByUser: { [socket.data.userId]: 0 },
      pinned: false,
      messages: [
        {
          id: randomUUID(),
          sender: bot.id,
          text: "你好，这是一个由服务器创建的联网私聊。",
          time: nowLabel(),
          status: "delivered"
        }
      ]
    };

    state.conversations.unshift(conversation);

    socket.emit("conversation_created", {
      conversationId: conversation.id
    });

    emitState();
  });

  socket.on("create_group", ({ title, description }) => {
    if (!requireLogin(socket)) return;

    const allRealUserIds = [...connectedUsers.values()].map((user) => user.id);

    const memberIds = Array.from(
      new Set([socket.data.userId, ...allRealUserIds, "u1", "u2", "u4"])
    );

    const unreadByUser = {};
    for (const id of memberIds) {
      unreadByUser[id] = 0;
    }

    const conversation = {
      id: `g_${randomUUID()}`,
      type: "group",
      title: String(title || "新建群聊").trim().slice(0, 30) || "新建群聊",
      description: String(description || "这是一个通过 Socket.IO 创建的联网群聊")
        .trim()
        .slice(0, 80),
      ownerId: socket.data.userId,
      memberIds,
      unreadByUser,
      pinned: false,
      messages: [
        {
          id: randomUUID(),
          sender: "system",
          text: `${socket.data.name} 创建了群聊`,
          time: nowLabel(),
          status: "system"
        }
      ]
    };

    state.conversations.unshift(conversation);

    socket.emit("conversation_created", {
      conversationId: conversation.id
    });

    emitState();
  });

  socket.on("add_random_member", ({ conversationId }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation || conversation.type !== "group") return;

    const available = state.users.filter((user) => !conversation.memberIds.includes(user.id));

    if (available.length === 0) {
      socket.emit("error_message", "没有可添加的演示成员了。");
      return;
    }

    const newMember = available[Math.floor(Math.random() * available.length)];

    conversation.memberIds.push(newMember.id);
    conversation.unreadByUser[newMember.id] = 0;

    addSystemMessage(conversation.id, `${newMember.name} 加入了群聊`);
    emitState();
  });

  socket.on("reset_demo", () => {
    state = makeInitialState();

    for (const user of connectedUsers.values()) {
      user.status = "online";
      ensureUserInState(user);
      addUserToDefaultGroup(user);
    }

    emitState();
  });

  socket.on("disconnect", () => {
    const user = connectedUsers.get(socket.id);

    if (user) {
      user.status = "offline";
      ensureUserInState(user);
      connectedUsers.delete(socket.id);
      emitState();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`MiniChat server running on port ${PORT}`);
  console.log("Allowed client origin: *");
});