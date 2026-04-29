import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { MessageCircle, Send, Users, Plus, LogOut, Wifi, WifiOff, Search, RotateCcw, UserPlus, Image as ImageIcon, X } from "lucide-react";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || `${window.location.protocol}//${window.location.hostname}:4000`;
const NICKNAME_KEY = "minichat-nickname";

function getUserById(id, users, currentUser) {
  if (!id) return null;
  if (id === currentUser?.id) return currentUser;
  return users.find((user) => user.id === id) || null;
}

function getConversationTitle(conversation, users, currentUser) {
  if (!conversation) return "";
  if (conversation.type === "group") return conversation.title;
  const otherId = conversation.memberIds.find((id) => id !== currentUser?.id);
  return getUserById(otherId, users, currentUser)?.name || "私聊";
}

function getUnread(conversation, currentUser) {
  return conversation?.unreadByUser?.[currentUser?.id] || 0;
}

function Avatar({ user, group = false }) {
  return (
    <div className="avatar">
      {group ? <Users size={20} /> : user?.avatar || "?"}
      {!group && user?.status === "online" && <span className="online-dot" />}
    </div>
  );
}

export default function App() {
  const socketRef = useRef(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [state, setState] = useState({ users: [], conversations: [] });
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState("all");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [showPrivate, setShowPrivate] = useState(false);
  const [targetName, setTargetName] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);

  useEffect(() => {
    const socket = io(SOCKET_URL, { reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError("");
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on("connect_error", () => {
      setConnected(false);
      setError(`无法连接后端：${SOCKET_URL}`);
    });

    socket.on("login_success", ({ currentUser, state }) => {
      setCurrentUser(currentUser);
      setState(state);
      localStorage.setItem(NICKNAME_KEY, currentUser.name);
      setActiveId(state.conversations.find((c) => c.memberIds.includes(currentUser.id))?.id || "");
      setLoginMessage("");
      setError("");
    });

    socket.on("login_error", (message) => setLoginMessage(message));
    socket.on("chat_state", (newState) => setState(newState));

    socket.on("conversation_created", ({ conversationId }) => {
      setActiveId(conversationId);
      setShowNewGroup(false);
      setShowPrivate(false);
      setNewGroupName("");
      setTargetName("");
    });

    socket.on("error_message", (message) => setError(message));

    return () => socket.disconnect();
  }, []);

  const activeConversation = state.conversations.find((item) => item.id === activeId);

  const conversations = useMemo(() => {
    return state.conversations
      .filter((conversation) => conversation.memberIds.includes(currentUser?.id))
      .map((conversation) => {
        const lastMessage = conversation.messages.at(-1);
        const lastSender = getUserById(lastMessage?.sender, state.users, currentUser);
        const title = getConversationTitle(conversation, state.users, currentUser);
        return { ...conversation, title, lastMessage, lastSender };
      })
      .filter((conversation) => filter === "all" || conversation.type === filter)
      .filter((conversation) => {
        if (!keyword.trim()) return true;
        const k = keyword.trim().toLowerCase();
        return (
          conversation.title.toLowerCase().includes(k) ||
          conversation.description?.toLowerCase().includes(k) ||
          conversation.lastMessage?.text?.toLowerCase().includes(k) ||
          conversation.lastSender?.name?.toLowerCase().includes(k)
        );
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [state, currentUser, keyword, filter]);

  const members = useMemo(() => {
    if (!activeConversation) return [];
    return activeConversation.memberIds.map((id) => getUserById(id, state.users, currentUser)).filter(Boolean);
  }, [activeConversation, state.users, currentUser]);

  useEffect(() => {
    if (!activeConversation && conversations[0]) setActiveId(conversations[0].id);
  }, [activeConversation, conversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeId, activeConversation?.messages.length]);

  function login(name, password) {
    if (!connected) {
      setLoginMessage("后端未连接。请先确认 server 已经部署成功。");
      return;
    }
    socketRef.current.emit("login", { name, password });
  }

  function logout() {
    socketRef.current?.emit("logout");
    setCurrentUser(null);
    setState({ users: [], conversations: [] });
    setActiveId("");
  }

  function selectConversation(id) {
    setActiveId(id);
    socketRef.current?.emit("mark_read", { conversationId: id });
  }

  function sendMessage() {
    const text = draft.trim();
    if (!text || !activeConversation) return;
    socketRef.current.emit("send_message", { conversationId: activeConversation.id, text });
    setDraft("");
  }

  function createGroup() {
    if (!newGroupName.trim()) {
      setError("群聊名称不能为空。");
      return;
    }
    socketRef.current.emit("create_group", { title: newGroupName.trim(), description: "用户创建的群聊" });
  }

  function createPrivate() {
    if (!targetName.trim()) {
      setError("请输入对方昵称。");
      return;
    }
    socketRef.current.emit("create_private", { targetName: targetName.trim() });
  }

  function chooseImage() {
    if (!activeConversation) return;
    fileInputRef.current?.click();
  }

  function handleImageSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeConversation) return;

    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件。");
      return;
    }

    if (file.size > 4 * 1024 * 1024) {
      setError("图片太大。当前版本请上传 4MB 以内的图片。");
      return;
    }

    setUploadingImage(true);
    const reader = new FileReader();

    reader.onload = () => {
      socketRef.current.emit("send_image", {
        conversationId: activeConversation.id,
        imageData: reader.result,
        fileName: file.name
      });
      setUploadingImage(false);
    };

    reader.onerror = () => {
      setError("图片读取失败。");
      setUploadingImage(false);
    };

    reader.readAsDataURL(file);
  }

  if (!currentUser) {
    return <Login connected={connected} error={error} loginMessage={loginMessage} onLogin={login} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="me">
          <Avatar user={currentUser} />
          <div className="me-text">
            <strong>{currentUser.name}</strong>
            <span className={connected ? "ok" : "bad"}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
              {connected ? "已联网" : "未连接"}
            </span>
          </div>
          <button className="icon-btn" onClick={logout} title="退出登录"><LogOut size={18} /></button>
        </header>

        {error && (
          <div className="error">
            {error}
            <button onClick={() => setError("")}><X size={14} /></button>
          </div>
        )}

        <div className="search">
          <Search size={16} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索会话或消息" />
        </div>

        <div className="filters">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
          <button className={filter === "private" ? "active" : ""} onClick={() => setFilter("private")}>私聊</button>
          <button className={filter === "group" ? "active" : ""} onClick={() => setFilter("group")}>群聊</button>
        </div>

        <div className="actions">
          <button onClick={() => setShowNewGroup(true)}><Plus size={16} /> 新建群聊</button>
          <button onClick={() => setShowPrivate(true)}><UserPlus size={16} /> 新建私聊</button>
        </div>

        {showNewGroup && (
          <div className="mini-panel">
            <label>群聊名称</label>
            <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="例如：高数讨论群" />
            <div className="mini-panel-buttons">
              <button onClick={createGroup}>创建</button>
              <button onClick={() => setShowNewGroup(false)}>取消</button>
            </div>
          </div>
        )}

        {showPrivate && (
          <div className="mini-panel">
            <label>对方昵称</label>
            <input value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="必须是已注册昵称" />
            <div className="mini-panel-buttons">
              <button onClick={createPrivate}>创建</button>
              <button onClick={() => setShowPrivate(false)}>取消</button>
            </div>
          </div>
        )}

        <div className="conversation-list">
          {conversations.map((conversation) => {
            const unread = getUnread(conversation, currentUser);
            return (
              <button key={conversation.id} className={`conversation ${conversation.id === activeId ? "selected" : ""}`} onClick={() => selectConversation(conversation.id)}>
                <Avatar group={conversation.type === "group"} user={getUserById(conversation.memberIds.find((id) => id !== currentUser.id), state.users, currentUser)} />
                <div className="conversation-main">
                  <div className="conversation-title">
                    <strong>{conversation.title}</strong>
                    <span>{conversation.lastMessage?.time || ""}</span>
                  </div>
                  <p>
                    {!conversation.lastMessage
                      ? "暂无消息"
                      : conversation.lastMessage.type === "image"
                        ? `${conversation.lastSender?.name || ""}：发来一张图片`
                        : conversation.type === "group" && conversation.lastSender
                          ? `${conversation.lastSender.name}：${conversation.lastMessage.text}`
                          : conversation.lastMessage.sender === currentUser.id
                            ? `我：${conversation.lastMessage.text}`
                            : conversation.lastMessage.text}
                  </p>
                </div>
                {unread > 0 && conversation.id !== activeId && <b className="badge">{unread}</b>}
              </button>
            );
          })}
        </div>

        <button className="reset" onClick={() => socketRef.current.emit("reset_demo")}>
          <RotateCcw size={16} /> 清空会话数据
        </button>
      </aside>

      <main className="chat">
        {activeConversation ? (
          <>
            <header className="chat-header">
              <Avatar group={activeConversation.type === "group"} user={members.find((member) => member.id !== currentUser.id)} />
              <div>
                <h2>{getConversationTitle(activeConversation, state.users, currentUser)}</h2>
                <p>{activeConversation.type === "group" ? `${members.length} 人 · ${activeConversation.description || "暂无群公告"}` : "私聊"}</p>
              </div>
            </header>

            <section className="messages">
              {activeConversation.messages.length === 0 && <div className="empty-chat-tip">暂无消息，发第一条消息吧。</div>}

              {activeConversation.messages.map((message) => {
                if (message.sender === "system") {
                  return <div className="system-message" key={message.id}>{message.text} · {message.time}</div>;
                }

                const isMe = message.sender === currentUser.id;
                const sender = getUserById(message.sender, state.users, currentUser);

                return (
                  <div className={`message-row ${isMe ? "mine" : ""}`} key={message.id}>
                    {!isMe && <Avatar user={sender} />}
                    <div className="message-content">
                      {activeConversation.type === "group" && !isMe && <div className="sender-name">{sender?.name}</div>}

                      {message.type === "image" ? (
                        <a href={message.imageData} target="_blank" rel="noreferrer">
                          <img className={`chat-image ${isMe ? "mine" : ""}`} src={message.imageData} alt={message.fileName || "image"} />
                        </a>
                      ) : (
                        <div className={`bubble ${isMe ? "mine" : ""}`}>{message.text}</div>
                      )}

                      <div className="time">{message.time}</div>
                    </div>
                    {isMe && <Avatar user={currentUser} />}
                  </div>
                );
              })}

              <div ref={bottomRef} />
            </section>

            <footer className="composer">
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={handleImageSelected} />
              <button className="image-button" onClick={chooseImage} disabled={uploadingImage}><ImageIcon size={18} /></button>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="输入消息，按 Enter 发送，Shift + Enter 换行"
              />
              <button className="send-button" onClick={sendMessage}><Send size={18} />发送</button>
            </footer>
          </>
        ) : (
          <div className="empty"><MessageCircle size={64} /><p>请选择一个会话</p></div>
        )}
      </main>

      {activeConversation?.type === "group" && (
        <aside className="members">
          <h3>群成员</h3>
          {members.map((member) => (
            <div className="member" key={member.id}>
              <Avatar user={member} />
              <div><strong>{member.name}</strong><p>{member.bio}</p></div>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}

function Login({ connected, error, loginMessage, onLogin }) {
  const [name, setName] = useState(localStorage.getItem(NICKNAME_KEY) || "");
  const [password, setPassword] = useState("");

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-top">
          <MessageCircle size={42} />
          <h1>MiniChat</h1>
          <p>首次使用昵称时，该密码会成为此昵称的初始化密码。之后同一昵称必须输入相同密码登录。</p>
        </div>

        <div className={connected ? "connection ok-box" : "connection bad-box"}>
          {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
          {connected ? "后端已连接" : "正在连接后端"}
        </div>

        {error && <div className="error plain">{error}</div>}
        {loginMessage && <div className="error plain">{loginMessage}</div>}

        <label>昵称</label>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="请输入昵称" />

        <label>密码</label>
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          placeholder="首次使用即初始化密码，至少 4 位"
          onKeyDown={(event) => {
            if (event.key === "Enter") onLogin(name, password);
          }}
        />

        <button className="login-button" disabled={!connected} onClick={() => onLogin(name, password)}>进入聊天</button>
        <p className="hint">当前账号和消息仍保存在服务器内存里。服务器重启后会清空。接数据库后才能永久保存。</p>
      </div>
    </div>
  );
}
