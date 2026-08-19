/**
 * views/chat.js — AI 对话页（左侧对话列表含追问，右侧消息流）
 * 轮询与消息气泡渲染机制在 ../ai.js（与报告追问共用）。
 */

import {
  $, app, esc, api, state, loadOverview, confirmModal, fmtLocalDateTime,
} from "../common.js";
import { t, getLang } from "../i18n.js";
import { pollAiChat, stopChatPolling, chatMessagesHtml } from "../ai.js";

function chatRowHtml(c, activeId) {
  const badge =
    c.mode === "follow_up" ? `<span class="status-badge completed">${esc(t("chat.badge.followup"))}</span>` : "";
  const pending = c.has_pending ? `<span class="status-badge pending">${esc(t("ai.status.pending"))}</span>` : "";
  return `<a class="chat-row ${c.id === activeId ? "active" : ""}" href="#/chat/${c.id}">
    <span class="chat-title">${esc(c.title || t("chat.untitled"))}</span>
    <span class="chat-meta">${badge}${pending}<span class="muted">${fmtLocalDateTime(c.updated_at)}</span></span>
    <button class="btn icon chat-del" data-id="${c.id}" title="${esc(t("chat.del_title"))}">×</button>
  </a>`;
}

/** 对话页：左侧对话列表（含追问），右侧消息流；chatId 为空表示新建对话 */
export async function renderChat(chatId) {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const [ov, chatList, fuList] = await Promise.all([
    loadOverview(),
    api("/api/ai/chats?mode=chat"),
    api("/api/ai/chats?mode=follow_up"),
  ]);
  const aiInfo = ov.ai || {};
  const cfgNote = aiInfo.configured
    ? ""
    : `<div class="callout">${esc(t("chat.not_configured"))}</div>`;
  const chats = [...(chatList.chats || []), ...(fuList.chats || [])].sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : -1,
  );
  app.innerHTML = `
    <div class="view-title"><h1>${esc(t("chat.title"))}</h1><span class="sub">${esc(t("chat.sub"))}</span></div>
    ${cfgNote}
    <div class="chat-layout">
      <div class="chat-side">
        <button class="btn" id="btnNewChat" style="width:100%"><span>${esc(t("chat.new"))}</span></button>
        <div class="chat-list" id="chatList">
          ${chats.map((c) => chatRowHtml(c, chatId)).join("") || `<div class="empty">${esc(t("chat.empty"))}</div>`}
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
      confirmModal(t("chat.delete.title"), t("chat.delete.text"), async () => {
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
      <div class="ai-chat"><div class="empty">${esc(t("chat.new_hint"))}</div></div>
      ${chatInputHtml()}`;
    bindChatInput(main);
    return;
  }
  main.innerHTML = `<div class="empty loading">${esc(t("chat.loading"))}</div>`;
  pollAiChat(chatId, (chat) => {
    if (state.chatState.chatId !== chatId) return; // 已切到别的对话
    const draft = $("#chatQuestion", main)?.value; // 快照重绘时保留正在输入的草稿
    main.innerHTML = `
      <div class="ai-chat">${chatMessagesHtml(chat.messages) || `<div class="empty">${esc(t("chat.no_messages"))}</div>`}</div>
      ${chatInputHtml()}`;
    bindChatInput(main);
    if (draft) $("#chatQuestion", main).value = draft;
    main.querySelector(".ai-chat")?.lastElementChild?.scrollIntoView({ block: "nearest" });
  });
}

const chatInputHtml = () => `
  <div class="follow-up-input">
    <textarea id="chatQuestion" rows="2" placeholder="${esc(t("chat.placeholder"))}"></textarea>
    <button class="btn sm" id="btnChatAsk"><span>${esc(t("chat.send"))}</span></button>
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
          lang: getLang(),
        }),
      });
      state.chatState.chatId = r.chat_id;
      history.replaceState(null, "", `#/chat/${r.chat_id}`);
      renderChatMain(r.chat_id);
    } catch (e) {
      alert(t("chat.failed", { msg: e.message }));
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
