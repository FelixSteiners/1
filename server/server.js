import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID, randomBytes, pbkdf2Sync } from "node:crypto";
import { Server } from "socket.io";

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors({ origin: "*" }));

app.get("/", (_, res) => {
  res.json({
    ok: true,
    name: "MiniChat Server",
    message: "MiniChat server is running.",
    features: ["unique nickname", "password login", "text", "image"]
  });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5 * 1024 * 1024
});

const accounts = new Map();
const connectedSockets = new Map();

let state = {
  users: [],
  conversations: [
    {
      id: "public",
      type: "group",
      title: "公共聊天室",
      description: "无测试消息，无假用户；登录用户会自动加入。",
      ownerId: null,
      memberIds: [],
      unreadByUser: {},
      pinned: true,
      messages: []
    }
  ]
};

function nowLabel() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function normalizeName(name) {
  return String(name || "").trim().slice(0, 20);
}

function avatarOf(name) {
  return name.slice(0, 1).toUpperCase();
}

function hashPassword(password, salt) {
  return pbkdf2Sync(String(password), salt, 100000, 64, "sha512").toString("hex");
}

function makePassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function checkPassword(password, record) {
  return record && hashPassword(password, record.salt) === record.hash;
}

function publicUser(account) {
  return {
    id: account.id,
    name: account.name,
    avatar: account.avatar,
    status: account.status,
    bio: "真实用户"
  };
}

function upsertUser(user) {
  const idx = state.users.findIndex((item) => item.id === user.id);
  if (idx >= 0) state.users[idx] = user;
  else state.users.push(user);
}

function room() {
  return state.conversations.find((c) => c.id === "public");
}

function addUserToPublicRoom(user) {
  const publicRoom = room();
  if (!publicRoom.memberIds.includes(user.id)) {
    publicRoom.memberIds.push(user.id);
    publicRoom.unreadByUser[user.id] = 0;
  }
}

function emitState() {
  io.emit("chat_state", state);
}

function requireLogin(socket) {
  if (!socket.data.userId) {
    socket.emit("error_message", "你还没有登录。");
    return false;
  }
  return true;
}

function addUnread(conversation, senderId) {
  for (const memberId of conversation.memberIds) {
    if (memberId !== senderId) {
      conversation.unreadByUser[memberId] = (conversation.unreadByUser[memberId] || 0) + 1;
    }
  }
}

function validImage(dataUrl) {
  if (typeof dataUrl !== "string") return false;
  if (dataUrl.length > 4 * 1024 * 1024) return false;
  return (
    dataUrl.startsWith("data:image/png;base64,") ||
    dataUrl.startsWith("data:image/jpeg;base64,") ||
    dataUrl.startsWith("data:image/jpg;base64,") ||
    dataUrl.startsWith("data:image/gif;base64,") ||
    dataUrl.startsWith("data:image/webp;base64,")
  );
}

function setOfflineIfNeeded(userId) {
  const stillOnline = [...connectedSockets.values()].some((user) => user.id === userId);
  if (stillOnline) return;
  const account = [...accounts.values()].find((item) => item.id === userId);
  if (!account) return;
  account.status = "offline";
  upsertUser(publicUser(account));
}

io.on("connection", (socket) => {
  socket.emit("chat_state", state);

  socket.on("login", ({ name, password }) => {
    const nickname = normalizeName(name);
    const rawPassword = String(password || "");

    if (!nickname) {
      socket.emit("login_error", "昵称不能为空。");
      return;
    }

    if (rawPassword.length < 4 || rawPassword.length > 40) {
      socket.emit("login_error", "密码长度需要在 4 到 40 位之间。");
      return;
    }

    let account = accounts.get(nickname);

    if (!account) {
      account = {
        id: `user_${randomUUID()}`,
        name: nickname,
        avatar: avatarOf(nickname),
        status: "online",
        password: makePassword(rawPassword)
      };
      accounts.set(nickname, account);
    } else {
      if (!checkPassword(rawPassword, account.password)) {
        socket.emit("login_error", "密码错误。这个昵称已被注册，请输入第一次使用该昵称时设置的密码。");
        return;
      }
      account.status = "online";
    }

    socket.data.userId = account.id;
    socket.data.name = account.name;
    connectedSockets.set(socket.id, publicUser(account));

    const user = publicUser(account);
    upsertUser(user);
    addUserToPublicRoom(user);

    socket.emit("login_success", { currentUser: user, state });
    emitState();
  });

  socket.on("logout", () => {
    const user = connectedSockets.get(socket.id);
    if (user) {
      connectedSockets.delete(socket.id);
      setOfflineIfNeeded(user.id);
      emitState();
    }
    socket.data.userId = null;
  });

  socket.on("mark_read", ({ conversationId }) => {
    if (!requireLogin(socket)) return;
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation || !conversation.memberIds.includes(socket.data.userId)) return;
    conversation.unreadByUser[socket.data.userId] = 0;
    socket.emit("chat_state", state);
  });

  socket.on("send_message", ({ conversationId, text }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);
    const cleanText = String(text || "").trim().slice(0, 1000);

    if (!conversation) {
      socket.emit("error_message", "会话不存在。");
      return;
    }

    if (!conversation.memberIds.includes(socket.data.userId)) {
      socket.emit("error_message", "你不是这个会话的成员，不能发消息。");
      return;
    }

    if (!cleanText) return;

    conversation.messages.push({
      id: randomUUID(),
      sender: socket.data.userId,
      type: "text",
      text: cleanText,
      time: nowLabel(),
      status: "delivered"
    });

    addUnread(conversation, socket.data.userId);
    emitState();
  });

  socket.on("send_image", ({ conversationId, imageData, fileName }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);

    if (!conversation) {
      socket.emit("error_message", "会话不存在。");
      return;
    }

    if (!conversation.memberIds.includes(socket.data.userId)) {
      socket.emit("error_message", "你不是这个会话的成员，不能发图片。");
      return;
    }

    if (!validImage(imageData)) {
      socket.emit("error_message", "图片格式不支持，或图片太大。请上传 4MB 以内的 png、jpg、gif 或 webp。");
      return;
    }

    conversation.messages.push({
      id: randomUUID(),
      sender: socket.data.userId,
      type: "image",
      imageData,
      fileName: String(fileName || "image").slice(0, 100),
      time: nowLabel(),
      status: "delivered"
    });

    addUnread(conversation, socket.data.userId);
    emitState();
  });

  socket.on("create_group", ({ title, description }) => {
    if (!requireLogin(socket)) return;

    const groupTitle = String(title || "").trim().slice(0, 30);

    if (!groupTitle) {
      socket.emit("error_message", "群聊名称不能为空。");
      return;
    }

    const conversation = {
      id: `group_${randomUUID()}`,
      type: "group",
      title: groupTitle,
      description: String(description || "用户创建的群聊").trim().slice(0, 80),
      ownerId: socket.data.userId,
      memberIds: [socket.data.userId],
      unreadByUser: { [socket.data.userId]: 0 },
      pinned: false,
      messages: []
    };

    state.conversations.unshift(conversation);
    socket.emit("conversation_created", { conversationId: conversation.id });
    emitState();
  });

  socket.on("join_group", ({ conversationId }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation || conversation.type !== "group") return;

    if (!conversation.memberIds.includes(socket.data.userId)) {
      conversation.memberIds.push(socket.data.userId);
      conversation.unreadByUser[socket.data.userId] = 0;
      conversation.messages.push({
        id: randomUUID(),
        sender: "system",
        type: "system",
        text: `${socket.data.name} 加入了群聊`,
        time: nowLabel(),
        status: "system"
      });
      emitState();
    }
  });

  socket.on("create_private", ({ targetName }) => {
    if (!requireLogin(socket)) return;

    const nickname = normalizeName(targetName);
    const target = accounts.get(nickname);

    if (!target) {
      socket.emit("error_message", "这个昵称还没有注册，不能创建私聊。");
      return;
    }

    if (target.id === socket.data.userId) {
      socket.emit("error_message", "不能和自己创建私聊。");
      return;
    }

    const existing = state.conversations.find((conversation) => {
      return (
        conversation.type === "private" &&
        conversation.memberIds.includes(socket.data.userId) &&
        conversation.memberIds.includes(target.id)
      );
    });

    if (existing) {
      socket.emit("conversation_created", { conversationId: existing.id });
      return;
    }

    const conversation = {
      id: `private_${randomUUID()}`,
      type: "private",
      title: "",
      description: "私聊",
      ownerId: socket.data.userId,
      memberIds: [socket.data.userId, target.id],
      unreadByUser: { [socket.data.userId]: 0, [target.id]: 0 },
      pinned: false,
      messages: []
    };

    state.conversations.unshift(conversation);
    socket.emit("conversation_created", { conversationId: conversation.id });
    emitState();
  });

  socket.on("reset_demo", () => {
    const onlineUsers = [...connectedSockets.values()];
    state = {
      users: [],
      conversations: [
        {
          id: "public",
          type: "group",
          title: "公共聊天室",
          description: "无测试消息，无假用户；登录用户会自动加入。",
          ownerId: null,
          memberIds: [],
          unreadByUser: {},
          pinned: true,
          messages: []
        }
      ]
    };

    for (const user of onlineUsers) {
      upsertUser(user);
      addUserToPublicRoom(user);
    }

    emitState();
  });

  socket.on("disconnect", () => {
    const user = connectedSockets.get(socket.id);
    if (user) {
      connectedSockets.delete(socket.id);
      setOfflineIfNeeded(user.id);
      emitState();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`MiniChat server running on port ${PORT}`);
  console.log("Allowed client origin: *");
});
