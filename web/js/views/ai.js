/**
 * views/ai.js — AI 报告页（四场景生成入口 + 历史报告列表）
 * 报告生成调用与追问机制在 ../ai.js，本文件只有页面骨架与事件绑定。
 */

import { $, app, esc, loadOverview, sportLabel, trunc } from "../common.js";
import { runAi, loadReportList } from "../ai.js";

export async function renderAI() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const ov = await loadOverview();
  const opts = (ov.activities || [])
    .map((a) => `<option value="${esc(a.file_name)}">${esc(a.date)} · ${sportLabel(a.sport)} · ${esc(trunc(a.file_name))}</option>`)
    .join("");
  const aiInfo = ov.ai || {};
  const cfgNote = aiInfo.configured
    ? `<div class="callout info">AI 已配置：${esc(aiInfo.base_url)} · 模型 ${esc(aiInfo.model)}</div>`
    : `<div class="callout">未配置 AI 密钥 — 将生成完整提示词供手动复制到任意 AI（到「设置」页填入密钥后可直接输出报告）</div>`;

  app.innerHTML = `
    <div class="view-title"><h1>AI 报告</h1><span class="sub">角色 + 指标口径 + 数据 + 问题，一键生成复盘报告</span></div>
    ${cfgNote}
    <div class="ai-controls">
      <div class="ai-card">
        <h3>单次复盘</h3>
        <p>训练类型判定、强度分布评估、心率漂移解读、周期位置与改进建议。</p>
        <select id="aiReviewSel">${opts}</select>
        <button class="btn" id="btnAiReview"><span>生成复盘</span></button>
      </div>
      <div class="ai-card">
        <h3>周期规划</h3>
        <p>基于月汇总与 CTL 走势，评估体能增长是否安全，给出下周逐日训练建议。</p>
        <button class="btn" id="btnAiPlan"><span>生成规划</span></button>
      </div>
      <div class="ai-card">
        <h3>赛前减量</h3>
        <p>以比赛日 TSB +5~+15 为目标，生成逐日减量计划与赛前 48 小时安排。</p>
        <input type="date" id="aiRaceDate">
        <button class="btn" id="btnAiTaper"><span>生成减量计划</span></button>
      </div>
      <div class="ai-card">
        <h3>两次对比</h3>
        <p>归一化比较 IF / VI / 心率漂移 / 峰功率曲线，判断进步或退步。</p>
        <select id="aiCmpA">${opts}</select>
        <select id="aiCmpB">${opts}</select>
        <button class="btn" id="btnAiCompare"><span>生成对比</span></button>
      </div>
    </div>
    <div class="panel" id="aiPanel" style="display:none">
      <div class="panel-title">AI 输出</div>
      <div id="aiBody"></div>
    </div>
    <div class="panel">
      <div class="panel-title">历史 AI 报告（每类最近 30 条，自动滚动保留）</div>
      <div style="margin-bottom:12px">
        <select id="aiReportMode">
          <option value="all">全部</option>
          <option value="review">单次复盘</option>
          <option value="plan">周期规划</option>
          <option value="taper">赛前减量</option>
          <option value="compare">两次对比</option>
        </select>
      </div>
      <div id="aiReportList"><div class="empty">加载中…</div></div>
    </div>`;

  $("#btnAiReview").addEventListener("click", () =>
    runAi({ mode: "review", file_name: $("#aiReviewSel").value }, $("#aiPanel"), $("#aiBody")));
  $("#btnAiPlan").addEventListener("click", () =>
    runAi({ mode: "plan" }, $("#aiPanel"), $("#aiBody")));
  $("#btnAiTaper").addEventListener("click", () => {
    const d = $("#aiRaceDate").value;
    if (!d) { alert("先选比赛日期"); return; }
    runAi({ mode: "taper", race_date: d }, $("#aiPanel"), $("#aiBody"));
  });
  $("#btnAiCompare").addEventListener("click", () =>
    runAi({ mode: "compare", file_name: $("#aiCmpA").value, compare_with: $("#aiCmpB").value }, $("#aiPanel"), $("#aiBody")));
  $("#aiReportMode").addEventListener("change", () =>
    loadReportList($("#aiReportList"), $("#aiReportMode").value));
  await loadReportList($("#aiReportList"));
}
