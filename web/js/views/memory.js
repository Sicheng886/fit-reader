/**
 * views/memory.js — AI 记忆页（全部记忆含已取代标记，只删不编辑）
 */

import {
  $, app, esc, api, confirmModal, MEM_CATEGORY_LABEL, MEM_SOURCE_LABEL,
} from "../common.js";

export async function renderMemory() {
  app.innerHTML = `<div class="view-title"><h1>AI 记忆</h1><span class="sub">AI 在报告与对话中记录的用户相关事实</span></div>
    <p class="muted" style="margin-bottom:12px;font-size:12px">
      带日期的记忆会注入后续 AI 调用；同一主题相互矛盾时以日期最新者为准。已取代的记忆不再注入，但保留在库中作变化轨迹。
      记错了就删，AI 会在后续交互中重记。
    </p>
    <div id="memList"><div class="empty loading">加载中…</div></div>`;
  const memList = $("#memList");
  const render = async () => {
    const { memories } = await api("/api/ai/memories");
    if (!memories.length) {
      memList.innerHTML = `<div class="empty">暂无记忆</div>`;
      return;
    }
    memList.innerHTML = `<div class="table-wrap"><table class="data-table">
      <tr><th>日期</th><th>分类</th><th>来源</th><th>内容</th><th>状态</th><th></th></tr>
      ${memories
        .map(
          (m) => `<tr>
        <td class="mono" style="white-space:nowrap">${esc(String(m.created_at ?? "").slice(0, 10))}</td>
        <td>${esc(MEM_CATEGORY_LABEL[m.category] ?? m.category ?? "通用")}</td>
        <td>${esc(MEM_SOURCE_LABEL[m.source] ?? m.source ?? "-")}</td>
        <td>${esc(m.content)}</td>
        <td>${
          m.active
            ? `<span class="status-badge completed">有效</span>`
            : `<span class="status-badge failed" title="已被 #${m.superseded_by} 取代">已取代</span>`
        }</td>
        <td><button class="btn icon mem-del" data-id="${m.id}" title="删除记忆">×</button></td>
      </tr>`,
        )
        .join("")}
    </table></div>`;
    memList.querySelectorAll(".mem-del").forEach((btn) =>
      btn.addEventListener("click", () => {
        confirmModal("删除记忆", "删除后 AI 将不再记得该事实。", async () => {
          await api(`/api/ai/memory?id=${btn.dataset.id}`, { method: "DELETE" });
          render();
        });
      }),
    );
  };
  render().catch(() => {
    memList.innerHTML = `<div class="callout">记忆加载失败</div>`;
  });
}
