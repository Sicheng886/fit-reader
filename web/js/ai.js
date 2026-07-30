/**
 * ai.js — AI 报告与对话的共享机制（详情页 / AI 报告页 / 对话页三方共用，故独立于视图）
 * 历史报告列表与缓存加载、报告生成调用、报告追问（follow_up）、
 * 对话轮询（202 快照回填）、消息气泡渲染。
 */

import {
  $, esc, api, state, confirmModal, MODE_LABEL, fmtLocalDateTime,
} from "./common.js";

// ---------------- 历史 AI 报告 ----------------

export async function loadReportList(container, mode = "all") {
  const modes = mode === "all" ? ["review", "plan", "taper", "compare"] : [mode];
  const rows = (await Promise.all(modes.map((m) => api(`/api/ai/reports?mode=${m}`))))
    .flatMap((r, i) => r.reports.map((rep) => ({ ...rep, mode: modes[i] })))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 30);
  if (!rows.length) {
    container.innerHTML = `<div class="empty">暂无 ${mode === "all" ? "" : MODE_LABEL[mode]} 缓存报告</div>`;
    return;
  }
  container.innerHTML = `<div class="table-wrap"><table class="data-table">
    <tr><th>时间</th><th>类别</th><th>关联训练</th><th>状态</th><th>操作</th></tr>
    ${rows.map((r) => {
      const extra = r.race_date ? `比赛 ${r.race_date}` : r.compare_with ? `对比 ${esc(r.compare_with)}` : "";
      const statusBadge =
        r.status === "pending"
          ? `<span class="status-badge pending">生成中…</span>`
          : r.status === "failed"
            ? `<span class="status-badge failed" title="${esc(r.error || "未知错误")}">失败</span>`
            : `<span class="status-badge completed">完成</span>`;
      const action =
        r.status === "pending"
          ? `<span class="muted">—</span>`
          : r.status === "failed"
            ? `<button class="btn ghost" data-id="${r.id}"><span>查看原因</span></button>`
            : `<button class="btn ghost" data-id="${r.id}"><span>加载</span></button>`;
      return `<tr>
        <td>${fmtLocalDateTime(r.created_at)}</td>
        <td>${MODE_LABEL[r.mode] ?? r.mode}</td>
        <td>${esc(r.file_name ?? extra ?? "-")}</td>
        <td>${statusBadge}</td>
        <td>${action}</td>
      </tr>`;
    }).join("")}
  </table></div>`;
  container.querySelectorAll("button[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => renderCachedReport(Number(btn.dataset.id))),
  );
}

export async function renderCachedReport(id) {
  const panel = $("#aiPanel"), body = $("#aiBody");
  if (!panel || !body) return;
  panel.style.display = "";
  body.innerHTML = `<div class="loading">加载报告…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  state.aiThread = null;
  try {
    const r = await api(`/api/ai/report?id=${id}`);
    if (r.status === "pending") {
      body.innerHTML = `<div class="callout info">报告正在生成中，请稍后再刷新查看。</div>`;
      return;
    }
    body.innerHTML = `<div class="ai-result">${r.html || renderMarkdownFallback(r.markdown)}</div>`;
    state.aiThread = {
      file_name: r.file_name,
      report_id: r.id,
      chat_id: null,
    };
    attachFollowUp(panel, body);
  } catch (e) {
    body.innerHTML = `<div class="callout">${esc(e.message)}</div>`;
  }
}

/** 服务端未返回 html 时的兜底（已弃用极简 Markdown 渲染，改用 marked 服务端转 HTML） */
export function renderMarkdownFallback(md) {
  return `<p>${esc(md).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/** 调 /api/ai 并渲染结果（已配置→Markdown 报告；未配置→提示词 + 复制按钮） */
export async function runAi(payload, panel, body) {
  panel.style.display = "";
  body.innerHTML = `<div class="loading">AI 报告生成中，可能需要 30-60 秒…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  state.aiThread = null; // 每次生成新报告时重置追问会话
  try {
    const r = await api("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.markdown) {
      body.innerHTML = `<div class="ai-result">${r.html || renderMarkdownFallback(r.markdown)}</div>`;
      state.aiThread = {
        file_name: payload.file_name,
        report_id: r.id ?? null,
        chat_id: null,
      };
      attachFollowUp(panel, body);
      // 生成新报告后刷新历史列表
      const list = $("#aiReportList");
      if (list) loadReportList(list, $("#aiReportMode")?.value || "all");
    } else if (r.accepted) {
      body.innerHTML = `<div class="callout info">${esc(r.message || "AI 报告已提交，将在后台生成并保存。")}<br><span class="muted">请稍后从历史报告查看。</span></div>`;
      // 在历史报告页面时刷新列表，让用户能看到后台生成的新报告
      const list = $("#aiReportList");
      if (list) loadReportList(list, $("#aiReportMode")?.value || "all");
    } else if (r.prompt != null) {
      body.innerHTML = `
        <p class="muted" style="margin-bottom:10px">未配置 AI API，以下为完整提示词，复制到任意 AI 即可：</p>
        <button class="btn ghost" id="btnCopyPrompt" style="margin-bottom:12px"><span>复制提示词</span></button>
        <div class="prompt-box">${esc(r.prompt)}</div>`;
      $("#btnCopyPrompt").addEventListener("click", async (e) => {
        await navigator.clipboard.writeText(r.prompt);
        e.target.textContent = "已复制 ✓";
      });
    } else {
      body.innerHTML = `<div class="callout">AI 返回异常：${esc(JSON.stringify(r))}</div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="callout">${esc(e.message)}</div>`;
  }
}

/** 在 AI 报告后附加“继续提问”区（追问对话入库持久化：提交后可离开，回来从报告页继续） */
export function attachFollowUp(panel, body) {
  if (!state.aiThread) return;
  const wrap = document.createElement("div");
  wrap.className = "ai-follow-up";
  wrap.innerHTML = `
    <div class="follow-up-title" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span>继续提问（快问快答，回答 ≤200 字）</span>
      <button class="btn sm ghost" id="btnClearFollowUp" style="display:none"><span>清除追问</span></button>
    </div>
    <div class="ai-chat" id="aiChat"></div>
    <div class="follow-up-input">
      <textarea id="followQuestion" rows="2" placeholder="基于上方报告继续提问，AI 将结合本次训练的具体数据在 200 字以内作答…"></textarea>
      <button class="btn sm" id="btnFollowAsk"><span>提问</span></button>
    </div>`;
  body.appendChild(wrap);

  const input = $("#followQuestion", wrap);
  const btn = $("#btnFollowAsk", wrap);
  const chat = $("#aiChat", wrap);
  const clearBtn = $("#btnClearFollowUp", wrap);

  clearBtn.addEventListener("click", () => {
    if (!state.aiThread?.chat_id) return;
    confirmModal("清除追问", "将删除该报告下的全部追问消息，不可恢复。", async () => {
      await api(`/api/ai/chat?id=${state.aiThread.chat_id}`, { method: "DELETE" });
      state.aiThread.chat_id = null;
      chat.innerHTML = "";
      clearBtn.style.display = "none";
    });
  });

  // 按当前 aiThread 渲染对话快照（轮询回填与首次加载共用；切到别的报告后旧回调自动失效）
  const renderThread = (c) => {
    if (!state.aiThread || state.aiThread.chat_id !== c.id) return;
    chat.innerHTML = chatMessagesHtml(c.messages);
    chat.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // 打开报告时找回该报告的既有追问对话并渲染历史（有 pending 则继续轮询）
  if (state.aiThread.report_id) {
    api(`/api/ai/chats?mode=follow_up&report_id=${state.aiThread.report_id}`)
      .then((r) => {
        if (!r.chat_id || !state.aiThread) return;
        state.aiThread.chat_id = r.chat_id;
        clearBtn.style.display = "";
        pollAiChat(r.chat_id, renderThread);
      })
      .catch(() => {});
  }

  const ask = async () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    btn.disabled = true;
    btn.innerHTML = "<span>思考中…</span>";
    try {
      const r = await api("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "follow_up",
          chat_id: state.aiThread.chat_id ?? undefined,
          report_id: state.aiThread.report_id ?? undefined,
          file_name: state.aiThread.file_name ?? undefined,
          message: q,
        }),
      });
      state.aiThread.chat_id = r.chat_id;
      clearBtn.style.display = "";
      pollAiChat(r.chat_id, renderThread);
    } catch (e) {
      chat.insertAdjacentHTML(
        "beforeend",
        `<div class="chat-bubble assistant"><div class="callout">${esc(e.message)}</div></div>`,
      );
    } finally {
      btn.disabled = false;
      btn.innerHTML = "<span>提问</span>";
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

// ---------------- 对话轮询与消息渲染（追问与直接对话共用） ----------------

/** 停止对话轮询（route 入口统一调用，hashchange 即停） */
export function stopChatPolling() {
  if (state.chatState.pollTimer) {
    clearTimeout(state.chatState.pollTimer);
    state.chatState.pollTimer = null;
  }
}

/**
 * 轮询对话直到没有 pending 消息：每次拿到快照（含 202）都调 onSnapshot(chat)，
 * 服务端返回 202 时 ~1.5s 后继续；出错（对话被删/网络异常）静默停止。
 */
export function pollAiChat(id, onSnapshot) {
  stopChatPolling();
  const tick = async () => {
    try {
      const resp = await fetch(`/api/ai/chat?id=${id}`);
      const chat = await resp.json();
      if (!resp.ok && resp.status !== 202) return;
      onSnapshot(chat);
      if (resp.status === 202) {
        state.chatState.pollTimer = setTimeout(tick, 1500);
      }
    } catch {
      // 轮询失败静默停止，用户可手动刷新
    }
  };
  tick();
}

/** 消息数组 → 气泡 HTML（pending 显示占位，failed 显示错误，completed 用服务端渲染的 html） */
export function chatMessagesHtml(messages) {
  return (messages || [])
    .map((m) => {
      if (m.role === "user")
        return `<div class="chat-bubble user"><p>${esc(m.content)}</p></div>`;
      if (m.status === "pending")
        return `<div class="chat-bubble assistant pending"><p class="muted">思考中…</p></div>`;
      if (m.status === "failed")
        return `<div class="chat-bubble assistant"><div class="callout">生成失败：${esc(m.error || "未知错误")}</div></div>`;
      return `<div class="chat-bubble assistant"><div class="ai-result">${m.html || renderMarkdownFallback(m.content)}</div></div>`;
    })
    .join("");
}
