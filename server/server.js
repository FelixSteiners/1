import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID, randomBytes, pbkdf2Sync } from "node:crypto";
import { Server } from "socket.io";
import pg from "pg";

const { Pool } = pg;

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL. Please add a PostgreSQL database and set DATABASE_URL in Railway.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL
});

const app = express();

app.use(cors({ origin: "*" }));

app.get("/", (_, res) => {
  res.json({
    ok: true,
    name: "MiniChat Server",
    message: "MiniChat server is running.",
    storage: "PostgreSQL",
    features: [
      "unique nickname",
      "first password initializes account",
      "password login",
      "persistent users",
      "persistent conversations",
      "persistent messages",
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

const connectedUsers = new Map();

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

function timeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function publicUserFromRow(row) {
  const online = [...connectedUsers.values()].some((user) => user.id === row.id);

  return {
    id: row.id,
    name: row.nickname,
    avatar: row.avatar || row.nickname.slice(0, 1).toUpperCase(),
    status: online ? "online" : "offline",
    bio: row.bio || "真实用户"
  };
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

  return dataUrl.length <= 4 * 1024 * 1024;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      avatar TEXT NOT NULL,
      bio TEXT DEFAULT '真实用户',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('group', 'private')),
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      owner_id TEXT,
      pinned BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unread_count INTEGER DEFAULT 0,
      joined_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK (type IN ('text', 'image', 'system')),
      text TEXT,
      image_data TEXT,
      file_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_conversation_members_user
      ON conversation_members(user_id);
  `);

  await pool.query(
    `
    INSERT INTO conversations (id, type, title, description, owner_id, pinned)
    VALUES ($1, 'group', '公共聊天室', '这里没有预置假消息和假用户。用户登录后会自动加入。', NULL, true)
    ON CONFLICT (id) DO NOTHING
    `,
    ["public"]
  );
}

async function getUserByNickname(nickname) {
  const result = await pool.query(
    `SELECT * FROM users WHERE nickname = $1 LIMIT 1`,
    [nickname]
  );

  return result.rows[0] || null;
}

async function getUserById(userId) {
  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function createUser(nickname, password) {
  const id = `user_${randomUUID()}`;
  const avatar = nickname.slice(0, 1).toUpperCase();
  const passwordRecord = createPasswordRecord(password);

  const result = await pool.query(
    `
    INSERT INTO users (id, nickname, avatar, bio, password_salt, password_hash)
    VALUES ($1, $2, $3, '真实用户', $4, $5)
    RETURNING *
    `,
    [id, nickname, avatar, passwordRecord.salt, passwordRecord.hash]
  );

  return result.rows[0];
}

async function ensurePublicRoomMembership(userId) {
  await pool.query(
    `
    INSERT INTO conversation_members (conversation_id, user_id, unread_count)
    VALUES ('public', $1, 0)
    ON CONFLICT (conversation_id, user_id) DO NOTHING
    `,
    [userId]
  );
}

async function createSystemMessage(conversationId, text) {
  await pool.query(
    `
    INSERT INTO messages (id, conversation_id, sender_id, type, text)
    VALUES ($1, $2, NULL, 'system', $3)
    `,
    [randomUUID(), conversationId, text]
  );
}

async function isMember(conversationId, userId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM conversation_members
    WHERE conversation_id = $1 AND user_id = $2
    LIMIT 1
    `,
    [conversationId, userId]
  );

  return result.rowCount > 0;
}

async function incrementUnreadForOtherMembers(conversationId, senderId) {
  await pool.query(
    `
    UPDATE conversation_members
    SET unread_count = unread_count + 1
    WHERE conversation_id = $1 AND user_id <> $2
    `,
    [conversationId, senderId]
  );
}

async function buildState() {
  const usersResult = await pool.query(`
    SELECT id, nickname, avatar, bio, created_at
    FROM users
    ORDER BY created_at ASC
  `);

  const conversationsResult = await pool.query(`
    SELECT id, type, title, description, owner_id, pinned, created_at
    FROM conversations
    ORDER BY pinned DESC, created_at ASC
  `);

  const membersResult = await pool.query(`
    SELECT conversation_id, user_id, unread_count
    FROM conversation_members
    ORDER BY joined_at ASC
  `);

  const messagesResult = await pool.query(`
    SELECT id, conversation_id, sender_id, type, text, image_data, file_name, created_at
    FROM messages
    ORDER BY created_at ASC
  `);

  const users = usersResult.rows.map(publicUserFromRow);

  const membersByConversation = new Map();
  const unreadByConversation = new Map();

  for (const member of membersResult.rows) {
    if (!membersByConversation.has(member.conversation_id)) {
      membersByConversation.set(member.conversation_id, []);
    }

    if (!unreadByConversation.has(member.conversation_id)) {
      unreadByConversation.set(member.conversation_id, {});
    }

    membersByConversation.get(member.conversation_id).push(member.user_id);
    unreadByConversation.get(member.conversation_id)[member.user_id] = member.unread_count || 0;
  }

  const messagesByConversation = new Map();

  for (const message of messagesResult.rows) {
    if (!messagesByConversation.has(message.conversation_id)) {
      messagesByConversation.set(message.conversation_id, []);
    }

    messagesByConversation.get(message.conversation_id).push({
      id: message.id,
      sender: message.sender_id || "system",
      type: message.type,
      text: message.text || "",
      imageData: message.image_data || "",
      fileName: message.file_name || "",
      time: timeLabel(message.created_at),
      status: message.type === "system" ? "system" : "delivered"
    });
  }

  const conversations = conversationsResult.rows.map((conversation) => ({
    id: conversation.id,
    type: conversation.type,
    title: conversation.title || "",
    description: conversation.description || "",
    ownerId: conversation.owner_id,
    memberIds: membersByConversation.get(conversation.id) || [],
    unreadByUser: unreadByConversation.get(conversation.id) || {},
    pinned: Boolean(conversation.pinned),
    messages: messagesByConversation.get(conversation.id) || []
  }));

  return { users, conversations };
}

async function emitState() {
  const state = await buildState();
  io.emit("chat_state", state);
}

function requireLogin(socket) {
  if (!socket.data.userId) {
    socket.emit("error_message", "你还没有登录。");
    return false;
  }

  return true;
}

io.on("connection", async (socket) => {
  try {
    socket.emit("chat_state", await buildState());
  } catch (error) {
    console.error(error);
    socket.emit("error_message", "读取聊天数据失败。");
  }

  socket.on("login", async ({ name, password }) => {
    try {
      const nickname = normalizeNickname(name);

      if (!nickname) {
        socket.emit("login_error", "昵称不能为空。");
        return;
      }

      if (!validatePassword(password)) {
        socket.emit("login_error", "密码长度需要在 4 到 40 位之间。");
        return;
      }

      let account = await getUserByNickname(nickname);

      if (!account) {
        account = await createUser(nickname, String(password));
      } else {
        const ok = verifyPassword(String(password), {
          salt: account.password_salt,
          hash: account.password_hash
        });

        if (!ok) {
          socket.emit("login_error", "密码错误。这个昵称已经被注册过，请输入第一次使用该昵称时设置的密码。");
          return;
        }
      }

      socket.data.userId = account.id;
      socket.data.name = account.nickname;
      socket.data.nickname = account.nickname;

      const publicUser = publicUserFromRow(account);

      connectedUsers.set(socket.id, publicUser);

      await ensurePublicRoomMembership(account.id);

      const state = await buildState();

      socket.emit("login_success", {
        currentUser: publicUser,
        state
      });

      io.emit("chat_state", state);
    } catch (error) {
      console.error(error);
      socket.emit("login_error", "登录失败，请检查服务器日志。");
    }
  });

  socket.on("logout", async () => {
    try {
      connectedUsers.delete(socket.id);

      socket.data.userId = null;
      socket.data.name = null;
      socket.data.nickname = null;

      await emitState();
    } catch (error) {
      console.error(error);
    }
  });

  socket.on("mark_read", async ({ conversationId }) => {
    try {
      if (!requireLogin(socket)) return;

      await pool.query(
        `
        UPDATE conversation_members
        SET unread_count = 0
        WHERE conversation_id = $1 AND user_id = $2
        `,
        [conversationId, socket.data.userId]
      );

      socket.emit("chat_state", await buildState());
    } catch (error) {
      console.error(error);
      socket.emit("error_message", "标记已读失败。");
    }
  });

  socket.on("send_message", async ({ conversationId, text }) => {
    try {
      if (!requireLogin(socket)) return;

      const cleanText = String(text || "").trim();

      if (!cleanText) return;

      if (!(await isMember(conversationId, socket.data.userId))) {
        socket.emit("error_message", "你不是这个会话的成员，不能发消息。");
        return;
      }

      await pool.query(
        `
        INSERT INTO messages (id, conversation_id, sender_id, type, text)
        VALUES ($1, $2, $3, 'text', $4)
        `,
        [randomUUID(), conversationId, socket.data.userId, cleanText.slice(0, 1000)]
      );

      await incrementUnreadForOtherMembers(conversationId, socket.data.userId);
      await emitState();
    } catch (error) {
      console.error(error);
      socket.emit("error_message", "发送消息失败。");
    }
  });

  socket.on("send_image", async ({ conversationId, imageData, fileName }) => {
    try {
      if (!requireLogin(socket)) return;

      if (!(await isMember(conversationId, socket.data.userId))) {
        socket.emit("error_message", "你不是这个会话的成员，不能发图片。");
        return;
      }

      if (!isValidImageDataUrl(imageData)) {
        socket.emit("error_message", "图片格式不支持，或图片太大。请上传 4MB 以内的 png、jpg、gif 或 webp。");
        return;
      }

      await pool.query(
        `
        INSERT INTO messages (id, conversation_id, sender_id, type, image_data, file_name)
        VALUES ($1, $2, $3, 'image', $4, $5)
        `,
        [
          randomUUID(),
          conversationId,
          socket.data.userId,
          imageData,
          String(fileName || "image").slice(0, 100)
        ]
      );

      await incrementUnreadForOtherMembers(conversationId, socket.data.userId);
      await emitState();
    } catch (error) {
      console.error(error);
      socket.emit("error_message", "发送图片失败。");
    }
  });

  socket.on("create_group", async ({ title, description }) => {
    try {
      if (!requireLogin(socket)) return;

      const groupTitle = String(title || "").trim().slice(0, 30);

      if (!groupTitle) {
        socket.emit("error_message", "群聊名称不能为空。");
        return;
      }

      const conversationId = `group_${randomUUID()}`;

      await pool.query("BEGIN");

      await pool.query(
        `
        INSERT INTO conversations (id, type, title, description, owner_id, pinned)
        VALUES ($1, 'group', $2, $3, $4, false)
        `,
        [
          conversationId,
          groupTitle,
          String(description || "用户创建的群聊").trim().slice(0, 80),
          socket.data.userId
        ]
      );

      await pool.query(
        `
        INSERT INTO conversation_members (conversation_id, user_id, unread_count)
        VALUES ($1, $2, 0)
        `,
        [conversationId, socket.data.userId]
      );

      await pool.query("COMMIT");

      socket.emit("conversation_created", { conversationId });
      await emitState();
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => {});
      console.error(error);
      socket.emit("error_message", "创建群聊失败。");
    }
  });

  socket.on("join_group", async ({ conversationId }) => {
    try {
      if (!requireLogin(socket)) return;

      const conversationResult = await pool.query(
        `SELECT * FROM conversations WHERE id = $1 AND type = 'group' LIMIT 1`,
        [conversationId]
      );

      if (conversationResult.rowCount === 0) {
        socket.emit("error_message", "群聊不存在。");
        return;
      }

      const alreadyMember = await isMember(conversationId, socket.data.userId);

      if (!alreadyMember) {
        await pool.query(
          `
          INSERT INTO conversation_members (conversation_id, user_id, unread_count)
          VALUES ($1, $2, 0)
          ON CONFLICT (conversation_id, user_id) DO NOTHING
          `,
          [conversationId, socket.data.userId]
        );

        await createSystemMessage(conversationId, `${socket.data.name} 加入了群聊`);
        await emitState();
      }
    } catch (error) {
      console.error(error);
      socket.emit("error_message", "加入群聊失败。");
    }
  });

  socket.on("create_private", async ({ targetName }) => {
    try {
      if (!requireLogin(socket)) return;

      const nickname = normalizeNickname(targetName);

      if (!nickname) {
        socket.emit("error_message", "请输入对方昵称。");
        return;
      }

      const targetAccount = await getUserByNickname(nickname);

      if (!targetAccount) {
        socket.emit("error_message", "这个昵称还没有注册，暂时不能创建私聊。");
        return;
      }

      if (targetAccount.id === socket.data.userId) {
        socket.emit("error_message", "不能和自己创建私聊。");
        return;
      }

      const existing = await pool.query(
        `
        SELECT c.id
        FROM conversations c
        JOIN conversation_members cm1
          ON cm1.conversation_id = c.id AND cm1.user_id = $1
        JOIN conversation_members cm2
          ON cm2.conversation_id = c.id AND cm2.user_id = $2
        WHERE c.type = 'private'
        LIMIT 1
        `,
        [socket.data.userId, targetAccount.id]
      );

      if (existing.rowCount > 0) {
        socket.emit("conversation_created", {
          conversationId: existing.rows[0].id
        });
        return;
      }

      const conversationId = `private_${randomUUID()}`;

      await pool.query("BEGIN");

      await pool.query(
        `
        INSERT INTO conversations (id, type, title, description, owner_id, pinned)
        VALUES ($1, 'private', '', '私聊', $2, false)
        `,
        [conversationId, socket.data.userId]
      );

      await pool.query(
        `
        INSERT INTO conversation_members (conversation_id, user_id, unread_count)
        VALUES ($1, $2, 0), ($1, $3, 0)
        `,
        [conversationId, socket.data.userId, targetAccount.id]
      );

      await pool.query("COMMIT");

      socket.emit("conversation_created", { conversationId });
      await emitState();
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => {});
      console.error(error);
      socket.emit("error_message", "创建私聊失败。");
    }
  });

  socket.on("disconnect", async () => {
    try {
      connectedUsers.delete(socket.id);
      await emitState();
    } catch (error) {
      console.error(error);
    }
  });
});

await initDb();

httpServer.listen(PORT, () => {
  console.log(`MiniChat server running on port ${PORT}`);
  console.log("Storage: PostgreSQL");
  console.log("Allowed client origin: *");
});
