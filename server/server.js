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
    storage: "memory",
    warning: "账号和消息保存在服务器内存中，服务器重启后会清空。",
    features: [
      "empty initial messages",
      "unique nickname",
      "first password initializes account",
      "password login",
      "text messages",
      "image messages"
    ]
  });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5 * 1024 * 1024
});

/**
 * 当前版本：内存存储版
 * 1. 不需要 DATABASE_URL
 * 2. 不需要 PostgreSQL
 * 3. 不需要 pg 包
 * 4. Railway 后端重启后，账号、密码、群聊、消息都会清空
 */
const accounts = new Map();
const connectedUsers = new Map();

let state = makeInitialState();

function makeInitialState() {
  return {
    users: [],
    conversations: [
      {
        id: "public",
        type: "group",
        title: "公共聊天室",
        description: "这里没有预置假消息和假用户。用户登录后会自动加入。",
        ownerId: null,
        memberIds: [],
        unreadByUser: {},
        pinned: true,
        messages: []
      }
    ]
  };
}

function normalizeNickname(name) {
  return String(name || "").trim().slice(0, 20);
}

function validatePassword(password) {
  const raw = String(password || "");
  return raw.length >= 4 && raw.length <= 40;
}

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
}

function createPasswordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record) return false;
  const hash = hashPassword(password, record.salt);
  return hash === record.hash;
}

function nowLabel() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function publicUser(account) {
  return {
    id: account.id,
    name: account.name,
    avatar: account.avatar,
    status: account.status,
    bio: account.bio
  };
}

function ensureUserInState(user) {
  const index = state.users.findIndex((item) => item.id === user.id);

  if (index >= 0) {
    state.users[index] = user;
  } else {
    state.users.push(user);
  }
}

function markUserOfflineIfNoConnection(userId) {
  const stillConnected = [...connectedUsers.values()].some((user) => user.id === userId);
  if (stillConnected) return;

  for (const account of accounts.values()) {
    if (account.id === userId) {
      account.status = "offline";
      ensureUserInState(publicUser(account));
      return;
    }
  }
}

function getPublicRoom() {
  return state.conversations.find((conversation) => conversation.id === "public");
}

function addUserToPublicRoom(user) {
  const room = getPublicRoom();
  if (!room) return;

  if (!room.memberIds.includes(user.id)) {
    room.memberIds.push(user.id);
    room.unreadByUser[user.id] = 0;
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

function isMember(conversation, userId) {
  return conversation.memberIds.includes(userId);
}

function addUnreadForOtherMembers(conversation, senderId) {
  for (const memberId of conversation.memberIds) {
    if (memberId !== senderId) {
      conversation.unreadByUser[memberId] = (conversation.unreadByUser[memberId] || 0) + 1;
    }
  }
}

function createSystemMessage(conversation, text) {
  conversation.messages.push({
    id: randomUUID(),
    sender: "system",
    type: "system",
    text,
    time: nowLabel(),
    status: "system"
  });
}

function isValidImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return false;

  const allowedPrefix =
    dataUrl.startsWith("data:image/png;base64,") ||
    dataUrl.startsWith("data:image/jpeg;base64,") ||
    dataUrl.startsWith("data:image/jpg;base64,") ||
    dataUrl.startsWith("data:image/gif;base64,") ||
    dataUrl.startsWith("data:image/webp;base64,");

  if (!allowedPrefix) return false;

  // 约 4MB 字符串上限，避免把服务器内存打爆
  return dataUrl.length <= 4 * 1024 * 1024;
}

function getAccountByUserId(userId) {
  for (const account of accounts.values()) {
    if (account.id === userId) return account;
  }

  return null;
}

io.on("connection", (socket) => {
  socket.emit("chat_state", state);

  socket.on("login", ({ name, password }) => {
    const nickname = normalizeNickname(name);

    if (!nickname) {
      socket.emit("login_error", "昵称不能为空。");
      return;
    }

    if (!validatePassword(password)) {
      socket.emit("login_error", "密码长度需要在 4 到 40 位之间。");
      return;
    }

    let account = accounts.get(nickname);

    if (!account) {
      const passwordRecord = createPasswordRecord(String(password));

      account = {
        id: `user_${randomUUID()}`,
        name: nickname,
        avatar: nickname.slice(0, 1).toUpperCase(),
        status: "online",
        bio: "真实用户",
        password: passwordRecord,
        createdAt: new Date().toISOString()
      };

      accounts.set(nickname, account);
    } else {
      if (!verifyPassword(String(password), account.password)) {
        socket.emit("login_error", "密码错误。这个昵称已经被注册过，请输入第一次使用该昵称时设置的密码。");
        return;
      }

      account.status = "online";
    }

    socket.data.userId = account.id;
    socket.data.name = account.name;
    socket.data.nickname = account.name;

    const user = publicUser(account);

    connectedUsers.set(socket.id, user);
    ensureUserInState(user);
    addUserToPublicRoom(user);

    socket.emit("login_success", {
      currentUser: user,
      state
    });

    emitState();
  });

  socket.on("logout", () => {
    const current = connectedUsers.get(socket.id);

    if (current) {
      connectedUsers.delete(socket.id);
      markUserOfflineIfNoConnection(current.id);
      emitState();
    }

    socket.data.userId = null;
    socket.data.name = null;
    socket.data.nickname = null;
  });

  socket.on("mark_read", ({ conversationId }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (!isMember(conversation, socket.data.userId)) return;

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

    if (!isMember(conversation, socket.data.userId)) {
      socket.emit("error_message", "你不是这个会话的成员，不能发消息。");
      return;
    }

    conversation.messages.push({
      id: randomUUID(),
      sender: socket.data.userId,
      type: "text",
      text: cleanText.slice(0, 1000),
      time: nowLabel(),
      status: "delivered"
    });

    addUnreadForOtherMembers(conversation, socket.data.userId);
    emitState();
  });

  socket.on("send_image", ({ conversationId, imageData, fileName }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);

    if (!conversation) {
      socket.emit("error_message", "会话不存在。");
      return;
    }

    if (!isMember(conversation, socket.data.userId)) {
      socket.emit("error_message", "你不是这个会话的成员，不能发图片。");
      return;
    }

    if (!isValidImageDataUrl(imageData)) {
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

    addUnreadForOtherMembers(conversation, socket.data.userId);
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
      description: String(description || "新建群聊").trim().slice(0, 80),
      ownerId: socket.data.userId,
      memberIds: [socket.data.userId],
      unreadByUser: {
        [socket.data.userId]: 0
      },
      pinned: false,
      messages: []
    };

    state.conversations.unshift(conversation);

    socket.emit("conversation_created", {
      conversationId: conversation.id
    });

    emitState();
  });

  socket.on("join_group", ({ conversationId }) => {
    if (!requireLogin(socket)) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);

    if (!conversation || conversation.type !== "group") {
      socket.emit("error_message", "群聊不存在。");
      return;
    }

    if (!conversation.memberIds.includes(socket.data.userId)) {
      conversation.memberIds.push(socket.data.userId);
      conversation.unreadByUser[socket.data.userId] = 0;
      createSystemMessage(conversation, `${socket.data.name} 加入了群聊`);
      emitState();
    }
  });

  socket.on("create_private", ({ targetName }) => {
    if (!requireLogin(socket)) return;

    const nickname = normalizeNickname(targetName);

    if (!nickname) {
      socket.emit("error_message", "请输入对方昵称。");
      return;
    }

    const targetAccount = accounts.get(nickname);

    if (!targetAccount) {
      socket.emit("error_message", "这个昵称还没有注册，暂时不能创建私聊。");
      return;
    }

    if (targetAccount.id === socket.data.userId) {
      socket.emit("error_message", "不能和自己创建私聊。");
      return;
    }

    const existing = state.conversations.find((conversation) => {
      if (conversation.type !== "private") return false;

      return (
        conversation.memberIds.includes(socket.data.userId) &&
        conversation.memberIds.includes(targetAccount.id)
      );
    });

    if (existing) {
      socket.emit("conversation_created", {
        conversationId: existing.id
      });
      return;
    }

    const conversation = {
      id: `private_${randomUUID()}`,
      type: "private",
      title: "",
      description: "私聊",
      ownerId: socket.data.userId,
      memberIds: [socket.data.userId, targetAccount.id],
      unreadByUser: {
        [socket.data.userId]: 0,
        [targetAccount.id]: 0
      },
      pinned: false,
      messages: []
    };

    state.conversations.unshift(conversation);

    socket.emit("conversation_created", {
      conversationId: conversation.id
    });

    emitState();
  });

  socket.on("disconnect", () => {
    const current = connectedUsers.get(socket.id);

    if (current) {
      connectedUsers.delete(socket.id);
      markUserOfflineIfNoConnection(current.id);
      emitState();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`MiniChat server running on port ${PORT}`);
  console.log("Storage: memory only");
  console.log("Allowed client origin: *");
});
