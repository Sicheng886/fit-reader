/**
 * views/ai.js — AI 报告页（四场景生成入口 + 历史报告列表）
 * 报告生成调用与追问机制在 ../ai.js，本文件只有页面骨架与事件绑定。
 */

import { $, app, esc, loadOverview, trunc } from "../common.js";
import { t, sportLabel } from "../i18n.js";
import { runAi, loadReportList } from "../ai.js";

export async function renderAI() {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const ov = await loadOverview();
  const opts = (ov.activities || [])
    .map((a) => `<option value="${esc(a.file_name)}">${esc(a.date)} · ${esc(sportLabel(a.sport))} · ${esc(trunc(a.file_name))}</option>`)
    .join("");
  const aiInfo = ov.ai || {};
  const cfgNote = aiInfo.configured
    ? `<div class="callout info">${esc(t("aiPage.configured", { url: aiInfo.base_url, model: aiInfo.model }))}</div>`
    : `<div class="callout">${esc(t("aiPage.not_configured"))}</div>`;

  app.innerHTML = `
    <div class="view-title"><h1>${esc(t("aiPage.title"))}</h1><span class="sub">${esc(t("aiPage.sub"))}</span></div>
    ${cfgNote}
    <div class="ai-controls">
      <div class="ai-card">
        <h3>${esc(t("card.review"))}</h3>
        <p>${esc(t("card.review.desc"))}</p>
        <select id="aiReviewSel">${opts}</select>
        <button class="btn" id="btnAiReview"><span>${esc(t("btn.review"))}</span></button>
      </div>
      <div class="ai-card">
        <h3>${esc(t("card.plan"))}</h3>
        <p>${esc(t("card.plan.desc"))}</p>
        <button class="btn" id="btnAiPlan"><span>${esc(t("btn.plan"))}</span></button>
      </div>
      <div class="ai-card">
        <h3>${esc(t("card.taper"))}</h3>
        <p>${esc(t("card.taper.desc"))}</p>
        <input type="date" id="aiRaceDate">
        <button class="btn" id="btnAiTaper"><span>${esc(t("btn.taper"))}</span></button>
      </div>
      <div class="ai-card">
        <h3>${esc(t("card.compare"))}</h3>
        <p>${esc(t("card.compare.desc"))}</p>
        <select id="aiCmpA">${opts}</select>
        <select id="aiCmpB">${opts}</select>
        <button class="btn" id="btnAiCompare"><span>${esc(t("btn.compare"))}</span></button>
      </div>
    </div>
    <div class="panel" id="aiPanel" style="display:none">
      <div class="panel-title">${esc(t("aiPage.output"))}</div>
      <div id="aiBody"></div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("aiPage.history"))}</div>
      <div style="margin-bottom:12px">
        <select id="aiReportMode">
          <option value="all">${esc(t("aiPage.filter.all"))}</option>
          <option value="review">${esc(t("mode.review"))}</option>
          <option value="plan">${esc(t("mode.plan"))}</option>
          <option value="taper">${esc(t("mode.taper"))}</option>
          <option value="compare">${esc(t("mode.compare"))}</option>
        </select>
      </div>
      <div id="aiReportList"><div class="empty">${esc(t("common.loading"))}</div></div>
    </div>`;

  $("#btnAiReview").addEventListener("click", () =>
    runAi({ mode: "review", file_name: $("#aiReviewSel").value }, $("#aiPanel"), $("#aiBody")));
  $("#btnAiPlan").addEventListener("click", () =>
    runAi({ mode: "plan" }, $("#aiPanel"), $("#aiBody")));
  $("#btnAiTaper").addEventListener("click", () => {
    const d = $("#aiRaceDate").value;
    if (!d) { alert(t("aiPage.race_required")); return; }
    runAi({ mode: "taper", race_date: d }, $("#aiPanel"), $("#aiBody"));
  });
  $("#btnAiCompare").addEventListener("click", () =>
    runAi({ mode: "compare", file_name: $("#aiCmpA").value, compare_with: $("#aiCmpB").value }, $("#aiPanel"), $("#aiBody")));
  $("#aiReportMode").addEventListener("change", () =>
    loadReportList($("#aiReportList"), $("#aiReportMode").value));
  await loadReportList($("#aiReportList"));
}
