/**
 * views/chat.js — AI 对话页（左侧对话列表含追问，右侧消息流）
 * 轮询与消息气泡渲染机制在 ../ai.js（与报告追问共用）。
 */

import {
  $, app, esc, api, state, loadOverview, confirmModal, fmtLocalDateTime,
} from "../common.js";
import { pollAiChat, stopChatPolling, chatMessagesHtml } from "../ai.js";

function chatRowHtml(c, activeId) {
  const badge =
    c.mode === "follow_up" ? `<span class="status-badge completed">追问</span>` : "";
  const pending = c.has_pending ? `<span class="status-badge pending">生成中…</span>` : "";
  return `<a class="chat-row ${c.id === activeId ? "active" : ""}" href="#/chat/${c.id}">
    <span class="chat-title">${esc(c.title || "（无标题）")}</span>
    <span class="chat-meta">${badge}${pending}<span class="muted">${fmtLocalDateTime(c.updated_at)}</span></span>
    <button class="btn icon chat-del" data-id="${c.id}" title="删除对话">×</button>
  </a>`;
}

/** 对话页：左侧对话列表（含追问），右侧消息流；chatId 为空表示新建对话 */
export async function renderChat(chatId) {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const [ov, chatList, fuList] = await Promise.all([
    loadOverview(),
    api("/api/ai/chats?mode=chat"),
    api("/api/ai/chats?mode=follow_up"),
  ]);
  const aiInfo = ov.ai || {};
  const cfgNote = aiInfo.configured
    ? ""
    : `<div class="callout">未配置 AI 密钥 — 到「设置」页配置后才能开始对话（历史对话仍可查看）</div>`;
  const chats = [...(chatList.chats || []), ...(fuList.chats || [])].sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : -1,
  );
  app.innerHTML = `
    <div class="view-title"><h1>AI 对话</h1><span class="sub">随时提问，AI 可自行查询训练库数据作答</span></div>
    ${cfgNote}
    <div class="chat-layout">
      <div class="chat-side">
        <button class="btn" id="btnNewChat" style="width:100%"><span>＋ 新建对话</span></button>
        <div class="chat-list" id="chatList">
          ${chats.map((c) => chatRowHtml(c, chatId)).join("") || `<div class="empty">暂无对话</div>`}
        </div>
      </div>
      <div class="chat-main" id="chatMain"></div>
    </div>`;
  $("#btnNewChat").addEventListener("click", () => {
    history.replaceState(null, "", "#/chat");
    renderChatMain(null);
    $("#chatList")?.querySelectorAll(".chat-row.active").forEach((r) => r.classList.remove("active"));
  });
  $("#chatList").querySelectorAll(".chat-del").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      confirmModal("删除对话", "将删除该对话及其全部消息，不可恢复。", async () => {
        await api(`/api/ai/chat?id=${id}`, { method: "DELETE" });
        if (state.chatState.chatId === id) {
          state.chatState.chatId = null;
          history.replaceState(null, "", "#/chat");
        }
        renderChat(state.chatState.chatId);
      });
    }),
  );
  renderChatMain(chatId);
}

/** 对话页右侧：消息流 + 输入框；chatId 非空时拉取快照并轮询 pending */
function renderChatMain(chatId) {
  const main = $("#chatMain");
  if (!main) return;
  state.chatState.chatId = chatId ?? null;
  if (!chatId) {
    stopChatPolling();
    main.innerHTML = `
      <div class="ai-chat"><div class="empty">新对话 — 在下方输入第一个问题，AI 会自行查询训练库数据作答</div></div>
      ${chatInputHtml()}`;
    bindChatInput(main);
    return;
  }
  main.innerHTML = `<div class="empty loading">加载对话…</div>`;
  pollAiChat(chatId, (chat) => {
    if (state.chatState.chatId !== chatId) return; // 已切到别的对话
    const draft = $("#chatQuestion", main)?.value; // 快照重绘时保留正在输入的草稿
    main.innerHTML = `
      <div class="ai-chat">${chatMessagesHtml(chat.messages) || `<div class="empty">暂无消息</div>`}</div>
      ${chatInputHtml()}`;
    bindChatInput(main);
    if (draft) $("#chatQuestion", main).value = draft;
    main.querySelector(".ai-chat")?.lastElementChild?.scrollIntoView({ block: "nearest" });
  });
}

const chatInputHtml = () => `
  <div class="follow-up-input">
    <textarea id="chatQuestion" rows="2" placeholder="向 AI 训练顾问提问，例如：这周状态适合上强度吗？"></textarea>
    <button class="btn sm" id="btnChatAsk"><span>发送</span></button>
  </div>`;

function bindChatInput(main) {
  const input = $("#chatQuestion", main);
  const btn = $("#btnChatAsk", main);
  if (!input || !btn) return;
  const ask = async () => {
    const q = input.value.trim();
    if (!q) return;
    btn.disabled = true;
    try {
      const r = await api("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "chat",
          chat_id: state.chatState.chatId ?? undefined,
          message: q,
        }),
      });
      state.chatState.chatId = r.chat_id;
      history.replaceState(null, "", `#/chat/${r.chat_id}`);
      renderChatMain(r.chat_id);
    } catch (e) {
      alert(`发送失败：${e.message}`);
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
}
