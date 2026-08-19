/**
 * views/memory.js — AI 记忆页（全部记忆含已取代标记，只删不编辑）
 */

import {
  $, app, esc, api, confirmModal,
} from "../common.js";
import { t, memCategoryLabel, memSourceLabel } from "../i18n.js";

export async function renderMemory() {
  app.innerHTML = `<div class="view-title"><h1>${esc(t("memPage.title"))}</h1><span class="sub">${esc(t("memPage.sub"))}</span></div>
    <p class="muted" style="margin-bottom:12px;font-size:12px">
      ${esc(t("memPage.desc"))}
    </p>
    <div id="memList"><div class="empty loading">${esc(t("common.loading"))}</div></div>`;
  const memList = $("#memList");
  const render = async () => {
    const { memories } = await api("/api/ai/memories");
    if (!memories.length) {
      memList.innerHTML = `<div class="empty">${esc(t("memPage.empty"))}</div>`;
      return;
    }
    memList.innerHTML = `<div class="table-wrap"><table class="data-table">
      <tr><th>${esc(t("memPage.col.date"))}</th><th>${esc(t("memPage.col.cat"))}</th><th>${esc(t("memPage.col.source"))}</th><th>${esc(t("memPage.col.content"))}</th><th>${esc(t("memPage.col.status"))}</th><th></th></tr>
      ${memories
        .map(
          (m) => `<tr>
        <td class="mono" style="white-space:nowrap">${esc(String(m.created_at ?? "").slice(0, 10))}</td>
        <td>${esc(memCategoryLabel(m.category))}</td>
        <td>${esc(memSourceLabel(m.source))}</td>
        <td>${esc(m.content)}</td>
        <td>${
          m.active
            ? `<span class="status-badge completed">${esc(t("memPage.active"))}</span>`
            : `<span class="status-badge failed" title="${esc(t("memPage.superseded_title", { n: m.superseded_by }))}">${esc(t("memPage.superseded"))}</span>`
        }</td>
        <td><button class="btn icon mem-del" data-id="${m.id}" title="${esc(t("memPage.del_title"))}">×</button></td>
      </tr>`,
        )
        .join("")}
    </table></div>`;
    memList.querySelectorAll(".mem-del").forEach((btn) =>
      btn.addEventListener("click", () => {
        confirmModal(t("memPage.delete.title"), t("memPage.delete.text"), async () => {
          await api(`/api/ai/memory?id=${btn.dataset.id}`, { method: "DELETE" });
          render();
        });
      }),
    );
  };
  render().catch(() => {
    memList.innerHTML = `<div class="callout">${esc(t("memPage.failed"))}</div>`;
  });
}
