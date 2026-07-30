/**
 * views/settings.js — 设置页（骑手参数 / 身份与训练目标 / AI 服务配置，均存训练库）
 */

import { $, app, esc, api, state, renderAthleteChip } from "../common.js";

export async function renderSettings() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const [{ athlete, configured }, { config: ai }, profile] = await Promise.all([
    api("/api/athlete"),
    api("/api/ai-config"),
    api("/api/profile"),
  ]);
  const banner =
    state.firstRun && !configured
      ? `<div class="callout info">首次使用：请先设置骑手参数（FTP / 最大心率 / 体重）与 AI 密钥，它们是所有派生指标与 AI 报告的前提。保存后存入训练库并跳回首页，之后可随时回到本页调整。</div>`
      : "";
  app.innerHTML = `
    <div class="view-title"><h1>设置</h1><span class="sub">参数保存在训练库中，分析新文件时自动生效</span></div>
    ${banner}
    <div class="panel">
      <div class="panel-title">骑手参数</div>
      <div class="settings-form">
        <label>FTP 功能阈值功率（W）
          <input type="number" id="setFtp" min="50" max="500" step="1" value="${athlete.ftp_watts ?? ""}">
        </label>
        <label>最大心率（bpm）
          <input type="number" id="setMaxHr" min="120" max="230" step="1" value="${athlete.max_hr ?? ""}">
        </label>
        <label>体重（kg）
          <input type="number" id="setWeight" min="30" max="200" step="0.1" value="${athlete.weight_kg ?? ""}">
        </label>
      </div>
      <p class="muted" style="margin-top:16px;font-size:12px">
        说明：修改参数只影响之后分析的训练；已归档训练的指标按当时口径保留。
        分区定义与算法阈值（间歇/爬坡识别等）仍在 settings.js 中调整。
      </p>
    </div>
    <div class="panel">
      <div class="panel-title">身份与训练目标</div>
      <div class="settings-form">
        <label>身份（如：上班族 / 运动员 / 学生 / 自由职业）
          <input type="text" id="setIdentity" maxlength="100" placeholder="例如：上班族，只有早晚和周末能训练" value="${esc(profile.identity ?? "")}">
        </label>
        <label>训练目标（想达到什么）
          <textarea id="setGoal" rows="3" maxlength="500" placeholder="例如：半年内 FTP 提升到 250W；备战 10 月 granfondo 完赛；减脂并保持有氧基础…">${esc(profile.goal ?? "")}</textarea>
        </label>
      </div>
      <p class="muted" style="margin-top:16px;font-size:12px">
        说明：填写后，AI 复盘/规划等报告会结合你的身份与目标给出更贴合实际的建议；都留空则不纳入。
      </p>
    </div>
    <div class="panel">
      <div class="panel-title">AI 服务</div>
      <div class="settings-form">
        <label>API 密钥（留空则退化为复制提示词模式）
          <input type="password" id="setAiKey" placeholder="sk-..." value="${esc(ai.api_key ?? "")}" autocomplete="off">
        </label>
        <label>接口地址（OpenAI 兼容）
          <input type="text" id="setAiBaseUrl" value="${esc(ai.base_url ?? "")}">
        </label>
        <label>模型名
          <input type="text" id="setAiModel" value="${esc(ai.model ?? "")}">
        </label>
      </div>
      <details style="margin-top:12px">
        <summary class="muted" style="cursor:pointer;font-size:12px">高级选项（一般无需修改）</summary>
        <div class="settings-form" style="margin-top:12px">
          <label>采样温度（留空表示不传）
            <input type="number" id="setAiTemperature" min="0" max="2" step="0.1" value="${ai.temperature ?? ""}">
          </label>
          <label>总超时（毫秒）
            <input type="number" id="setAiTimeout" min="1000" step="1000" value="${ai.timeout_ms ?? ""}">
          </label>
          <label>流式空闲超时（毫秒）
            <input type="number" id="setAiStall" min="1000" step="1000" value="${ai.stall_ms ?? ""}">
          </label>
          <label style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="setAiStream" style="width:auto" ${ai.stream ? "checked" : ""}> 启用流式输出
          </label>
        </div>
      </details>
      <p class="muted" style="margin-top:16px;font-size:12px">
        说明：密钥保存在本地训练库中，不会上传到其他任何地方；模型名以你的账号可用列表为准。
      </p>
    </div>
    <div style="margin-top:16px;display:flex;gap:12px;justify-content:flex-end;align-items:center">
      <span class="muted" id="settingsSaved" style="display:none">已保存 ✓</span>
      <button class="btn" id="btnSaveSettings"><span>保存</span></button>
    </div>`;
  $("#btnSaveSettings").addEventListener("click", async () => {
    const btn = $("#btnSaveSettings");
    btn.disabled = true;
    try {
      const r = await api("/api/athlete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ftp_watts: Number($("#setFtp").value),
          max_hr: Number($("#setMaxHr").value),
          weight_kg: Number($("#setWeight").value),
        }),
      });
      await api("/api/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: $("#setAiKey").value,
          base_url: $("#setAiBaseUrl").value,
          model: $("#setAiModel").value,
          temperature: $("#setAiTemperature").value,
          timeout_ms: Number($("#setAiTimeout").value),
          stall_ms: Number($("#setAiStall").value),
          stream: $("#setAiStream").checked,
        }),
      });
      await api("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identity: $("#setIdentity").value,
          goal: $("#setGoal").value,
        }),
      });
      state.firstRun = false;
      state.overview = null; // 概览缓存作废，下次加载取新参数
      renderAthleteChip(r.athlete);
      location.hash = "#/dashboard"; // 保存后跳回首页
    } catch (e) {
      alert(`保存失败：${e.message}`);
      btn.disabled = false;
    }
  });

}
