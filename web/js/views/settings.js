/**
 * views/settings.js — 设置页（界面语言 / 骑手参数 / 身份与训练目标 / AI 服务配置，均存训练库）
 * 语言切换即时生效：写 localStorage + 训练库 settings 表 lang 键，然后刷新页面。
 */

import { $, app, esc, api, state, renderAthleteChip } from "../common.js";
import { t, getLang, setStoredLang, setLang } from "../i18n.js";

export async function renderSettings() {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const [{ athlete, configured }, { config: ai }, profile] = await Promise.all([
    api("/api/athlete"),
    api("/api/ai-config"),
    api("/api/profile"),
  ]);
  const banner =
    state.firstRun && !configured
      ? `<div class="callout info">${esc(t("set.banner"))}</div>`
      : "";
  app.innerHTML = `
    <div class="view-title"><h1>${esc(t("set.title"))}</h1><span class="sub">${esc(t("set.sub"))}</span></div>
    ${banner}
    <div class="panel">
      <div class="panel-title">${esc(t("set.lang"))}</div>
      <div class="settings-form">
        <label style="flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap">
          <select id="setLang" style="width:auto">
            <option value="zh" ${getLang() === "zh" ? "selected" : ""}>${esc(t("set.lang.zh"))}</option>
            <option value="en" ${getLang() === "en" ? "selected" : ""}>${esc(t("set.lang.en"))}</option>
          </select>
          <span class="muted" style="font-size:12px">${esc(t("set.lang.hint"))}</span>
        </label>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("set.athlete"))}</div>
      <div class="settings-form">
        <label>${esc(t("set.ftp"))}
          <input type="number" id="setFtp" min="50" max="500" step="1" value="${athlete.ftp_watts ?? ""}">
        </label>
        <label>${esc(t("set.maxhr"))}
          <input type="number" id="setMaxHr" min="120" max="230" step="1" value="${athlete.max_hr ?? ""}">
        </label>
        <label>${esc(t("set.weight"))}
          <input type="number" id="setWeight" min="30" max="200" step="0.1" value="${athlete.weight_kg ?? ""}">
        </label>
      </div>
      <p class="muted" style="margin-top:16px;font-size:12px">
        ${esc(t("set.athlete.note"))}
      </p>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("set.profile"))}</div>
      <div class="settings-form">
        <label>${esc(t("set.identity"))}
          <input type="text" id="setIdentity" maxlength="100" placeholder="${esc(t("set.identity.placeholder"))}" value="${esc(profile.identity ?? "")}">
        </label>
        <label>${esc(t("set.goal"))}
          <textarea id="setGoal" rows="3" maxlength="500" placeholder="${esc(t("set.goal.placeholder"))}">${esc(profile.goal ?? "")}</textarea>
        </label>
      </div>
      <p class="muted" style="margin-top:16px;font-size:12px">
        ${esc(t("set.profile.note"))}
      </p>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("set.ai"))}</div>
      <div class="settings-form">
        <label>${esc(t("set.ai.key"))}
          <input type="password" id="setAiKey" placeholder="sk-..." value="${esc(ai.api_key ?? "")}" autocomplete="off">
        </label>
        <label>${esc(t("set.ai.base_url"))}
          <input type="text" id="setAiBaseUrl" value="${esc(ai.base_url ?? "")}">
        </label>
        <label>${esc(t("set.ai.model"))}
          <input type="text" id="setAiModel" value="${esc(ai.model ?? "")}">
        </label>
      </div>
      <details style="margin-top:12px">
        <summary class="muted" style="cursor:pointer;font-size:12px">${esc(t("set.ai.advanced"))}</summary>
        <div class="settings-form" style="margin-top:12px">
          <label>${esc(t("set.ai.temp"))}
            <input type="number" id="setAiTemperature" min="0" max="2" step="0.1" value="${ai.temperature ?? ""}">
          </label>
          <label>${esc(t("set.ai.timeout"))}
            <input type="number" id="setAiTimeout" min="1000" step="1000" value="${ai.timeout_ms ?? ""}">
          </label>
          <label>${esc(t("set.ai.stall"))}
            <input type="number" id="setAiStall" min="1000" step="1000" value="${ai.stall_ms ?? ""}">
          </label>
          <label style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="setAiStream" style="width:auto" ${ai.stream ? "checked" : ""}> ${esc(t("set.ai.stream"))}
          </label>
        </div>
      </details>
      <p class="muted" style="margin-top:16px;font-size:12px">
        ${esc(t("set.ai.note"))}
      </p>
    </div>
    <div style="margin-top:16px;display:flex;gap:12px;justify-content:flex-end;align-items:center">
      <span class="muted" id="settingsSaved" style="display:none">${esc(t("set.saved"))}</span>
      <button class="btn" id="btnSaveSettings"><span>${esc(t("set.save"))}</span></button>
    </div>`;

  // 语言切换：写 localStorage + 训练库（AI 提示词语言缺省取此值），即时刷新生效
  $("#setLang").addEventListener("change", async (e) => {
    const l = e.target.value === "en" ? "en" : "zh";
    setStoredLang(l);
    setLang(l);
    try {
      await api("/api/lang", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: l }),
      });
    } catch {
      // 语言已本地生效，写库失败不阻断刷新
    }
    location.reload();
  });

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
      alert(t("set.failed", { msg: e.message }));
      btn.disabled = false;
    }
  });
}
