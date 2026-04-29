import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  MessageCircle,
  Send,
  Users,
  Plus,
  LogOut,
  Wifi,
  WifiOff,
  Search,
  RotateCcw,
  UserPlus
} from "lucide-react";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:4000";
const NICKNAME_KEY = "minichat-online-nickname";

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

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [state, setState] = useState({ users: [], conversations: [] });
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError("");
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("connect_error", () => {
      setConnected(false);
      setError(`无法连接后端：${SOCKET_URL}`);
    });

    socket.on("login_success", ({ currentUser, state }) => {
      setCurrentUser(currentUser);
      setState(state);
      localStorage.setItem(NICKNAME_KEY, currentUser.name);
      setActiveId(state.conversations[0]?.id || "");
    });

    socket.on("chat_state", (newState) => {
      setState(newState);
    });

    socket.on("conversation_created", ({ conversationId }) => {
      setActiveId(conversationId);
    });

    socket.on("error_message", (message) => {
      setError(message);
    });

    return () => socket.disconnect();
  }, []);

  const activeConversation = state.conversations.find((item) => item.id === activeId);

  const conversations = useMemo(() => {
    return state.conversations
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
    return activeConversation.memberIds
      .map((id) => getUserById(id, state.users, currentUser))
      .filter(Boolean);
  }, [activeConversation, state.users, currentUser]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeId, activeConversation?.messages.length]);

  function login(name) {
    if (!connected) {
      setError("后端未连接。请先运行 server。");
      return;
    }
    socketRef.current.emit("login", { name });
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
    socketRef.current.emit("send_message", {
      conversationId: activeConversation.id,
      text
    });
    setDraft("");
  }

  if (!currentUser) {
    return <Login connected={connected} error={error} onLogin={login} />;
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
          <button className="icon-btn" onClick={logout}><LogOut size={18} /></button>
        </header>

        {error && <div className="error">{error}</div>}

        <div className="search">
          <Search size={16} />
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索会话或消息" />
        </div>

        <div className="filters">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
          <button className={filter === "private" ? "active" : ""} onClick={() => setFilter("private")}>私聊</button>
          <button className={filter === "group" ? "active" : ""} onClick={() => setFilter("group")}>群聊</button>
        </div>

        <div className="actions">
          <button onClick={() => socketRef.current.emit("create_group", {
            title: "新建联网群聊",
            description: "这是一个新建的 Socket.IO 群聊"
          })}>
            <Plus size={16} /> 新建群聊
          </button>
          <button onClick={() => socketRef.current.emit("create_private")}>
            <UserPlus size={16} /> 新建私聊
          </button>
        </div>

        <div className="conversation-list">
          {conversations.map((conversation) => {
            const unread = getUnread(conversation, currentUser);
            return (
              <button
                key={conversation.id}
                className={`conversation ${conversation.id === activeId ? "selected" : ""}`}
                onClick={() => selectConversation(conversation.id)}
              >
                <Avatar
                  group={conversation.type === "group"}
                  user={getUserById(conversation.memberIds.find((id) => id !== currentUser.id), state.users, currentUser)}
                />
                <div className="conversation-main">
                  <div className="conversation-title">
                    <strong>{conversation.title}</strong>
                    <span>{conversation.lastMessage?.time}</span>
                  </div>
                  <p>
                    {conversation.type === "group" && conversation.lastSender
                      ? `${conversation.lastSender.name}：`
                      : conversation.lastMessage?.sender === currentUser.id
                      ? "我："
                      : ""}
                    {conversation.lastMessage?.text}
                  </p>
                </div>
                {unread > 0 && conversation.id !== activeId && <b className="badge">{unread}</b>}
              </button>
            );
          })}
        </div>

        <button className="reset" onClick={() => socketRef.current.emit("reset_demo")}>
          <RotateCcw size={16} /> 重置服务器演示数据
        </button>
      </aside>

      <main className="chat">
        {activeConversation ? (
          <>
            <header className="chat-header">
              <Avatar group={activeConversation.type === "group"} user={members.find((m) => m.id !== currentUser.id)} />
              <div>
                <h2>{getConversationTitle(activeConversation, state.users, currentUser)}</h2>
                <p>
                  {activeConversation.type === "group"
                    ? `${members.length} 人 · ${activeConversation.description || "暂无群公告"}`
                    : "Socket.IO 实时私聊"}
                </p>
              </div>
            </header>

            <section className="messages">
              {activeConversation.messages.map((message) => {
                if (message.sender === "system") {
                  return <div className="system-message" key={message.id}>{message.text} · {message.time}</div>;
                }

                const isMe = message.sender === currentUser.id;
                const sender = getUserById(message.sender, state.users, currentUser);

                return (
                  <div className={`message-row ${isMe ? "mine" : ""}`} key={message.id}>
                    {!isMe && <Avatar user={sender} />}
                    <div>
                      {activeConversation.type === "group" && !isMe && <div className="sender-name">{sender?.name}</div>}
                      <div className={`bubble ${isMe ? "mine" : ""}`}>{message.text}</div>
                      <div className="time">{message.time}</div>
                    </div>
                    {isMe && <Avatar user={currentUser} />}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </section>

            <footer className="composer">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="输入消息，按 Enter 发送，Shift + Enter 换行"
              />
              <button onClick={sendMessage}><Send size={18} />发送</button>
            </footer>
          </>
        ) : (
          <div className="empty">
            <MessageCircle size={64} />
            <p>请选择一个会话</p>
          </div>
        )}
      </main>

      {activeConversation?.type === "group" && (
        <aside className="members">
          <h3>群成员</h3>
          <button onClick={() => socketRef.current.emit("add_random_member", { conversationId: activeConversation.id })}>
            <UserPlus size={16} /> 随机添加成员
          </button>
          {members.map((member) => (
            <div className="member" key={member.id}>
              <Avatar user={member} />
              <div>
                <strong>{member.name}</strong>
                <p>{member.bio}</p>
              </div>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}

function Login({ connected, error, onLogin }) {
  const [name, setName] = useState(localStorage.getItem(NICKNAME_KEY) || "Felix");

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-top">
          <MessageCircle size={42} />
          <h1>MiniChat Online</h1>
          <p>联网聊天 Demo：支持群聊、私聊、未读数和实时同步。</p>
        </div>

        <div className={connected ? "connection ok-box" : "connection bad-box"}>
          {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
          {connected ? "后端已连接" : "正在连接后端"}
        </div>

        {error && <div className="error">{error}</div>}

        <label>你的昵称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Enter") onLogin(name);
        }} />

        <button className="login-button" disabled={!connected} onClick={() => onLogin(name)}>
          进入联网聊天
        </button>

        <p className="hint">先运行 server，再运行 client。默认后端地址：http://localhost:4000</p>
      </div>
    </div>
  );
}
