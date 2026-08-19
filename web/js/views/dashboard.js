/**
 * views/dashboard.js — 概览（负荷仪表盘）
 * CTL/ATL/TSB 大数字 + 负荷趋势图 + 月度汇总 + 最近训练 + FTP 科学估算 + 指标说明弹窗。
 * 文案走 i18n.js（t()）。
 */

import {
  $, app, esc, api, state, loadOverview, renderAthleteChip,
  actRowHtml, showModal,
} from "../common.js";
import { t } from "../i18n.js";
import { drawTrendChart } from "../charts.js";

export async function renderDashboard() {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const ov = await loadOverview();
  const daily = ov.form_daily || [];
  const last = daily[daily.length - 1];

  const heroTile = (label, v, color, note) => `
    <div class="hero-tile" style="--tile-color:${color}">
      <div class="label">${label}</div>
      <div class="value">${v ?? "-"}</div>
      <div class="note">${note ?? ""}</div>
    </div>`;

  const a = ov.athlete || {};
  app.innerHTML = `
    <div class="view-title">
      <h1>${esc(t("dash.title"))}</h1>
      <button class="btn icon" id="glossaryBtn" title="${esc(t("dash.glossary_title"))}">?</button>
      <span class="sub">${esc(t("dash.sub"))}</span>
    </div>
    <div class="hero-grid">
      ${last ? heroTile(t("dash.ctl"), last.ctl, "#5aa2ff", t("dash.ctl_note")) : ""}
      ${last ? heroTile(t("dash.atl"), last.atl, "#ff5d73", t("dash.atl_note")) : ""}
      ${last ? heroTile(t("dash.tsb"), (last.tsb > 0 ? "+" : "") + last.tsb, "#3ddc97", formNoteText(last)) : ""}
      <div class="hero-tile" style="--tile-color:#d7ff3f">
        <div class="label">${esc(t("dash.ftp"))}</div>
        <div class="value" id="ftpTileValue">${a.ftp_watts ?? "-"}<small> W</small></div>
        <div class="note"><button class="btn ghost sm" id="ftpEstBtn"><span>${esc(t("dash.ftp_btn"))}</span></button></div>
      </div>
      ${!last ? `<div class="empty" style="grid-column:1/-1">${esc(t("dash.empty"))}</div>` : ""}
    </div>
    <div id="ftpPanel"></div>
    <div class="panel">
      <div class="panel-title">${esc(t("dash.trend"))}</div>
      <div class="chart-legend">
        <span class="legend-chip"><span class="dot" style="background:#5aa2ff"></span>${esc(t("dash.legend.ctl"))}</span>
        <span class="legend-chip"><span class="dot" style="background:#ff5d73"></span>${esc(t("dash.legend.atl"))}</span>
        <span class="legend-chip"><span class="dot" style="background:#3ddc97"></span>${esc(t("dash.legend.tsb"))}</span>
      </div>
      <div class="chart-wrap" id="trendChart"></div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("dash.monthly"))}</div>
      ${monthlyTableHtml(ov.monthly)}
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("dash.recent"))}</div>
      <div class="act-list">${(ov.activities || []).slice(0, 6).map(actRowHtml).join("") || `<div class="empty">${esc(t("dash.no_acts"))}</div>`}</div>
    </div>`,
  drawTrendChart($("#trendChart"), daily);
  $("#ftpEstBtn")?.addEventListener("click", runFtpEstimate);
  $("#glossaryBtn")?.addEventListener("click", () => showModal(t("dash.glossary_title"), glossaryHtml()));
}

/** TSB 瓦片简评：优先用 athlete_context.form_state 的本地化文本（服务端已按语言渲染） */
function formNoteText(last) {
  if (last?.form_state && FORM_STATE_INDEX[last.form_state] != null) {
    return t(`form.note.${FORM_STATE_INDEX[last.form_state]}`);
  }
  return t(`form.note.${formStateIndex(last?.tsb)}`);
}

const FORM_STATE_INDEX = { fresh: 0, good: 1, balanced: 2, fatigued: 3, overtrained: 4 };
const formStateIndex = (tsb) =>
  tsb == null ? 2 : tsb >= 15 ? 0 : tsb >= 5 ? 1 : tsb >= -10 ? 2 : tsb >= -20 ? 3 : 4;

// ---------------- FTP 科学估算（功率峰曲线 + 心率交叉验证） ----------------

async function runFtpEstimate() {
  const panel = $("#ftpPanel");
  panel.innerHTML = `<div class="panel"><div class="empty loading">${esc(t("ftp.analyzing"))}</div></div>`;
  try {
    const r = await api("/api/ftp-estimate");
    panel.innerHTML = ftpEstimateHtml(r);
    $("#ftpApplyBtn")?.addEventListener("click", () => applyFtp(r.estimate.ftp_w));
  } catch (e) {
    panel.innerHTML = `<div class="panel"><div class="callout">${esc(t("ftp.failed", { msg: e.message }))}</div></div>`;
  }
}

function ftpEstimateHtml(r) {
  const s = r.sample || {};
  const sampleLine = t("ftp.window", {
    days: r.window_days,
    rides: s.cycling_rides ?? 0,
    power: s.usable_power_rides ?? 0,
    hr: s.rides_with_hr ?? 0,
  });
  const needsHtml = r.data_needs?.length
    ? `<div class="callout"><b>${esc(t("ftp.needs"))}</b><ul class="ftp-list">${r.data_needs.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>`
    : "";
  const notesHtml = r.notes?.length
    ? `<div class="callout info"><b>${esc(t("ftp.notes"))}</b><ul class="ftp-list">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
    : "";
  const refsHtml = r.references?.length
    ? `<div class="muted ftp-refs">${esc(t("ftp.refs"))}${r.references.map((x) => ` ${esc(x)}`).join("；")}</div>`
    : "";

  if (r.status !== "ok" || !r.estimate) {
    return `<div class="panel">
      <div class="panel-title">${esc(t("ftp.insufficient"))}</div>
      <div class="muted" style="margin-bottom:12px">${esc(sampleLine)}</div>
      ${needsHtml}${notesHtml}${refsHtml}
    </div>`;
  }

  const e = r.estimate;
  const m = e.methods || {};
  const diff = e.diff_w;
  const diffTxt =
    diff === 0
      ? t("ftp.diff.same")
      : diff > 0
        ? t("ftp.diff.higher", { w: e.current_ftp_w, d: diff })
        : t("ftp.diff.lower", { w: e.current_ftp_w, d: -diff });
  const cp = m.cp_model;
  const cog = m.coggan_20min;
  const hr = m.hr_check || {};
  const zm = hr.zone_mismatch;
  const methodRows = [
    cp
      ? `<tr><td>${esc(t("ftp.method.cp"))}</td><td>${cp.ftp_w}W</td><td class="muted">${esc(t("ftp.method.cp_detail", { p5: cp.p5.watts, d5: cp.p5.date, p20: cp.p20.watts, d20: cp.p20.date, cp: cp.cp_w, wp: cp.w_prime_kj }))}</td></tr>`
      : `<tr><td>${esc(t("ftp.method.cp"))}</td><td>-</td><td class="muted">${esc(t("ftp.method.cp_na"))}</td></tr>`,
    cog
      ? `<tr><td>${esc(t("ftp.method.coggan"))}</td><td>${cog.ftp_w}W</td><td class="muted">${esc(t("ftp.method.coggan_detail", { w: cog.peak_20min_w, date: cog.date }))}</td></tr>`
      : "",
    `<tr><td>${esc(t("ftp.method.hr"))}</td><td>${
      hr.maximal_effort == null ? "-" : hr.maximal_effort ? esc(t("ftp.method.hr_maximal")) : esc(t("ftp.method.hr_not_maximal"))
    }</td><td class="muted">${esc(t("ftp.method.hr_detail", { hr: hr.best20_max_hr ?? "-", thr: hr.threshold_hr ?? "-" }))}${
      zm ? esc(t("ftp.method.hr_zone", { p: zm.power_high_pct, h: zm.hr_high_pct })) : ""
    }${hr.median_hr_drift_pct != null ? esc(t("ftp.method.hr_drift", { d: hr.median_hr_drift_pct })) : ""}</td></tr>`,
  ].join("");

  const applyHtml =
    diff === 0
      ? ""
      : e.confidence === "high"
        ? `<button class="btn sm" id="ftpApplyBtn"><span>${esc(t("ftp.apply", { w: e.ftp_w }))}</span></button>`
        : `<span class="muted">${esc(t("ftp.apply_na"))}</span>`;

  return `<div class="panel">
    <div class="panel-title">${esc(t("ftp.title"))}</div>
    <div class="muted" style="margin-bottom:16px">${esc(sampleLine)}</div>
    <div class="ftp-result">
      <div class="ftp-big">${e.ftp_w}<small> W</small></div>
      <div class="ftp-meta">
        <span class="conf-badge ${esc(e.confidence)}">${esc(CONF_LABEL(e.confidence))}</span>
        <span class="muted">${esc(e.confidence_note ?? "")}</span>
      </div>
      <div class="muted">${esc(t("ftp.range", { lo: e.range_low, hi: e.range_high, diff: diffTxt }))}</div>
      ${applyHtml}
      <span class="ftp-applied muted" style="display:none">${esc(t("ftp.applied"))}</span>
    </div>
    <div class="table-wrap"><table class="data-table" style="margin-top:16px">
      <tr><th>${esc(t("ftp.method.col.method"))}</th><th>${esc(t("ftp.method.col.result"))}</th><th>${esc(t("ftp.method.col.basis"))}</th></tr>
      ${methodRows}
    </table></div>
    ${needsHtml}${notesHtml}${refsHtml}
  </div>`;
}

const CONF_LABEL = (c) =>
  ({ high: t("ftp.conf.high"), medium: t("ftp.conf.medium"), low: t("ftp.conf.low") })[c] ?? c;

async function applyFtp(ftpW) {
  const btn = $("#ftpApplyBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/ftp-apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ftp_w: ftpW }),
    });
    const a = state.overview?.athlete || {};
    state.overview = null; // 概览缓存作废，下次加载取新 FTP
    renderAthleteChip({ ...a, ftp_watts: r.ftp_w });
    if (btn) btn.style.display = "none";
    const done = $(".ftp-applied");
    if (done) done.style.display = "";
    const tile = $("#ftpTileValue");
    if (tile) tile.innerHTML = `${r.ftp_w}<small> W</small>`;
  } catch (e) {
    alert(t("ftp.apply_failed", { msg: e.message }));
    if (btn) btn.disabled = false;
  }
}

function monthlyTableHtml(months) {
  if (!months?.length) return `<div class="empty">${esc(t("month.empty"))}</div>`;
  return `<div class="table-wrap"><table class="data-table">
    <tr><th>${esc(t("month.cols.month"))}</th><th>${esc(t("month.cols.tss"))}</th><th>${esc(t("month.cols.hours"))}</th><th>${esc(t("month.cols.distance"))}</th><th>${esc(t("month.cols.sessions"))}</th><th>${esc(t("month.cols.intensity"))}</th><th>${esc(t("month.cols.type"))}</th></tr>
    ${months.map((m) => {
      const p = m.intensity_pct;
      const stack = p
        ? `<div class="intensity-stack">
             <span style="width:${p.low}%;background:#3ddc97"></span>
             <span style="width:${p.mid}%;background:#ffb03f"></span>
             <span style="width:${p.high}%;background:#ff5d73"></span>
           </div>`
        : "-";
      return `<tr><td>${m.month}</td><td>${m.tss}</td><td>${m.hours}</td><td>${m.distance_km}</td><td>${m.sessions}</td>
        <td>${stack}${p ? `<span class="muted" style="font-size:11px">${p.low}/${p.mid}/${p.high}%</span>` : ""}</td>
        <td>${intensityTypeLabel(m.intensity_type)}</td></tr>`;
    }).join("")}</table></div>`;
}

function intensityTypeLabel(type) {
  const k = `month.type.${type}`;
  return t(k) === k ? "-" : t(k);
}

// ---------------- 指标说明弹窗内容 ----------------

function glossaryHtml() {
  const entry = (key) => {
    const [dt, dd] = t(key);
    return `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
  };
  return `
    <div class="panel">
      <div class="panel-title">${esc(t("gloss.title"))}</div>
      <div class="glossary">
        ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => entry(`gloss.${i}`)).join("")}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("gloss.algo"))}</div>
      <div class="glossary">
        ${[0, 1, 2, 3, 4].map((i) => entry(`gloss.a${i}`)).join("")}
      </div>
    </div>`;
}
