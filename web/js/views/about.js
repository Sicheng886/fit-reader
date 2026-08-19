/**
 * views/about.js — 关于页（功能说明 / 最近更新 / 作者）
 */

import { app, esc } from "../common.js";
import { t } from "../i18n.js";

export function renderAbout() {
  app.innerHTML = `
    <div class="view-title"><h1>${esc(t("about.title"))}</h1><span class="sub">${esc(t("about.sub"))}</span></div>

    <div class="panel">
      <div class="panel-title">${esc(t("about.features"))}</div>
      <ul class="about-list">
        ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<li>${t(`about.f${i}`)}</li>`).join("")}
      </ul>
    </div>

    <div class="panel">
      <div class="panel-title">${esc(t("about.updates"))}</div>
      <ul class="about-list">
        ${[0, 1, 2, 3, 4, 5].map((i) => `<li>${t(`about.u${i}`)}</li>`).join("")}
      </ul>
    </div>

    <div class="panel">
      <div class="panel-title">${esc(t("about.author"))}</div>
      <p class="muted">${esc(t("about.author_line"))}</p>
    </div>`;
}
