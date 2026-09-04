/**
 * views/activities.js — 训练列表 + 训练详情
 * 详情页：指标网格 / 分类标记 / 训练备注 / 时序曲线（系列开关）/ 分区分布 /
 * 峰功率曲线 / 赛段 / 爬坡 / 踏频-功率 / 数据质量 / AI 复盘（含追问）。
 * 文案走 i18n.js（t()）；anomalies 与 form_note 由服务端按请求语言渲染。
 */

import {
  $, app, esc, api, num, fmtDur, state, loadOverview,
  sportBadge, ZONE_COLORS, actRowHtml,
} from "../common.js";
import { t, CATEGORY_OPTIONS, formNote, cadenceStyleHint } from "../i18n.js";
import { drawLineChart, zoneBarsHtml, peakCurveHtml } from "../charts.js";
import { runAi, attachFollowUp } from "../ai.js";

// ---------------- 训练列表 ----------------

export async function renderActivities() {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const ov = await loadOverview();
  app.innerHTML = `
    <div class="view-title"><h1>${esc(t("acts.title"))}</h1><span class="sub">${esc(t("acts.count", { n: (ov.activities || []).length }))}</span></div>
    <div class="act-list">${(ov.activities || []).map(actRowHtml).join("") || `<div class="empty">${esc(t("acts.empty"))}</div>`}</div>`;
}

// ---------------- 训练详情 ----------------

function metricHtml(label, value, unit, sub) {
  return `<div class="metric">
    <div class="m-label">${label}</div>
    <div class="m-value">${value}${unit ? `<span class="unit">${unit}</span>` : ""}</div>
    ${sub ? `<div class="m-sub">${sub}</div>` : ""}
  </div>`;
}

export async function renderActivityDetail(name) {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const [{ summary, zone_ranges }, records] = await Promise.all([
    api(`/api/activity?name=${encodeURIComponent(name)}`),
    api(`/api/records?name=${encodeURIComponent(name)}`).catch(() => null),
  ]);
  const a = summary.activity || {};
  const p = summary.power || {};
  const hr = summary.heart_rate || {};
  const ac = summary.athlete_context || {};
  const ftp = ac.ftp_watts;

  // ---- 指标网格（按运动类型组织） ----
  const metrics = [];
  metrics.push(metricHtml(t("m.duration"), fmtDur(a.duration_sec)));
  metrics.push(metricHtml(t("m.distance"), num(a.distance_km, 2), "km"));
  if (a.avg_speed_kmh != null) metrics.push(metricHtml(t("m.avg_speed"), num(a.avg_speed_kmh, 2), "km/h"));
  if (a.elevation_gain_m) metrics.push(metricHtml(t("m.gain"), a.elevation_gain_m, "m"));
  if (a.total_calories != null) metrics.push(metricHtml(t("m.calories"), a.total_calories, "kcal"));
  if (p.normalized_power != null) metrics.push(metricHtml("NP", p.normalized_power, "W", t("m.np_sub", { if: num(p.intensity_factor, 2) })));
  if (p.avg != null) metrics.push(metricHtml(t("m.avg_power"), num(p.avg, 0), "W", p.w_per_kg_avg ? `${num(p.w_per_kg_avg, 2)} W/kg` : ""));
  if (p.max != null) metrics.push(metricHtml(t("m.max_power"), p.max, "W"));
  if (p.tss != null) metrics.push(metricHtml("TSS", p.tss, "", t("m.tss_sub", { vi: num(p.variability_index, 2) })));
  if (hr.avg != null) metrics.push(metricHtml(t("m.avg_hr"), num(hr.avg, 0), "bpm", hr.max ? t("m.max_hr_sub", { max: hr.max }) : ""));
  if (hr.hr_drift_pct != null)
    metrics.push(metricHtml(t("m.hr_drift"), num(hr.hr_drift_pct, 1), "%", Math.abs(hr.hr_drift_pct) < 5 ? t("m.drift_good") : t("m.drift_high")));
  if (summary.cadence?.avg != null)
    metrics.push(metricHtml(a.sport === "running" ? t("m.stride") : t("m.cadence"), num(summary.cadence.avg, 0), a.sport === "running" ? "spm" : "rpm"));
  if (summary.temperature)
    metrics.push(metricHtml(t("m.temp"), num(summary.temperature.avg, 1), "°C", summary.temperature.max != null ? t("m.temp_max", { t: summary.temperature.max }) : ""));
  if (summary.pace) {
    metrics.push(metricHtml(t("m.pace"), fmtPace(summary.pace.avg_pace_min_per_km), "/km"));
    if (summary.pace.best_1min_pace_min_per_km)
      metrics.push(metricHtml(t("m.pace_best"), fmtPace(summary.pace.best_1min_pace_min_per_km), "/km"));
  }
  if (summary.swim) {
    const sw = summary.swim;
    metrics.push(metricHtml(t("m.swim_lengths"), sw.lengths_count));
    if (sw.avg_swolf) metrics.push(metricHtml(t("m.swolf"), sw.avg_swolf));
    if (sw.avg_length_time_sec) metrics.push(metricHtml(t("m.swim_avg"), num(sw.avg_length_time_sec, 1), "s"));
  }
  if (ac.ctl != null) {
    metrics.push(metricHtml(t("m.ctl"), ac.ctl, "", t("m.ctl_sub")));
    metrics.push(metricHtml(t("m.atl"), ac.atl, "", t("m.atl_sub")));
    metrics.push(metricHtml(t("m.tsb"), (ac.tsb > 0 ? "+" : "") + ac.tsb, "", ac.form_note || formNote(ac.tsb)));
  }

  // ---- FTP 估算提示 ----
  let ftpCallout = "";
  const est = p.ftp_estimate;
  if (est && est.suggestion === "consider_update")
    ftpCallout = `<div class="callout">${esc(t("ftp.callout_hi", { est: est.estimated_ftp_w, cur: est.current_ftp_w }))}</div>`;
  else if (est && est.suggestion === "consider_recheck")
    ftpCallout = `<div class="callout info">${esc(t("ftp.callout_lo", { est: est.estimated_ftp_w, cur: est.current_ftp_w }))}</div>`;

  // ---- 时序图 ----
  const seriesDefs = [
    { key: "power", name: t("series.power"), color: "#d7ff3f", unit: "W", area: true },
    { key: "heart_rate", name: t("series.hr"), color: "#ff5d73", unit: "bpm" },
    { key: "cadence", name: a.sport === "running" ? t("series.stride") : t("series.cadence"), color: "#3fd6f5", unit: a.sport === "running" ? "spm" : "rpm" },
    { key: "altitude", name: t("series.altitude"), color: "#8d9aa8", unit: "m" },
    { key: "speed", name: t("series.speed"), color: "#5aa2ff", unit: "km/h" },
    { key: "temperature", name: t("series.temp"), color: "#ffa94d", unit: "°C" },
  ];

  app.innerHTML = `
    <div class="detail-head">
      <a class="back-link" href="#/activities">${esc(t("detail.back"))}</a>
      <h1>${sportBadge(a.sport)}${esc(a.date)}</h1>
      <span class="muted mono" style="font-size:12px">${esc(name)}</span>
      <div class="category-bar">
        <label for="actCategory">${esc(t("cat.label"))}</label>
        <select id="actCategory">
          ${CATEGORY_OPTIONS()
            .map((o) => `<option value="${o.key}" ${summary.activity?.category === o.key ? "selected" : ""}>${esc(o.label)}</option>`)
            .join("")}
        </select>
        <span id="catSaved" class="muted" style="display:none">${esc(t("cat.saved"))}</span>
      </div>
      <span class="spacer"></span>
      <button class="btn" id="btnAiReview"><span>${esc(t("btn.ai_review"))}</span></button>
    </div>
    ${ftpCallout}
    <div class="metric-grid">${metrics.join("")}</div>
    <div class="panel">
      <div class="panel-title">${esc(t("note.title"))}</div>
      <div class="note-form">
        <textarea id="actNote" rows="3" maxlength="2000" placeholder="${esc(t("note.placeholder"))}">${esc(a.note ?? "")}</textarea>
        <div class="note-actions">
          <button class="btn sm" id="btnSaveNote"><span>${esc(t("note.save"))}</span></button>
          <span id="noteSaved" class="muted" style="display:none">${esc(t("note.saved"))}</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("detail.chart_title"))}</div>
      <div class="chart-legend" id="tsLegend"></div>
      <div class="chart-wrap" id="tsChart"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="zone-panels">
      <div class="panel"><div class="panel-title">${esc(t("zone.power"))}</div>${zoneBarsHtml(p.zone_distribution_pct, ZONE_COLORS, zone_ranges?.power)}</div>
      <div class="panel"><div class="panel-title">${esc(t("zone.hr"))}</div>${zoneBarsHtml(hr.zone_distribution_pct, ZONE_COLORS, zone_ranges?.hr)}</div>
    </div>
    ${peakCurveHtml(p.peak_curve, ftp)}
    ${segmentsHtml(summary)}
    ${climbsHtml(summary)}
    ${cadencePowerHtml(summary)}
    ${anomaliesHtml(summary)}
    <div class="panel" id="aiPanel" style="display:none">
      <div class="panel-title">${esc(t("ai.panel"))}</div>
      <div id="aiBody"></div>
    </div>`;

  // 时序图渲染 + 系列开关
  const legend = $("#tsLegend");
  const chartEl = $("#tsChart");
  const redraw = () => {
    if (!records?.points?.length) {
      chartEl.innerHTML = `<div class="empty">${esc(t("detail.no_records"))}</div>`;
      return;
    }
    const series = seriesDefs
      .map((d) => ({
        ...d,
        visible: state.chartToggles[d.key] !== false,
        points: records.points.map((pt) => pt[d.key]),
        step: records.stride ?? 1,
      }))
      .filter((s) => s.points.some((v) => v != null));
    drawLineChart(chartEl, series);
    legend.innerHTML = series
      .map((s) => {
        const vals = s.points.filter((v) => v != null);
        const avg = vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : null;
        return `<button class="legend-chip ${s.visible === false ? "off" : ""}" data-key="${s.key}">
          <span class="dot" style="background:${s.color}"></span>${esc(s.name)}
          <span class="avg">${esc(t("legend.avg", { avg: avg ?? "-", unit: s.unit }))}</span></button>`;
      })
      .join("");
    legend.querySelectorAll(".legend-chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        const k = chip.dataset.key;
        state.chartToggles[k] = state.chartToggles[k] === false ? true : false;
        redraw();
      }),
    );
  };
  redraw();

  // 训练备注：点击按钮保存（空内容表示清除）
  const noteInput = $("#actNote");
  const noteSaved = $("#noteSaved");
  $("#btnSaveNote")?.addEventListener("click", async () => {
    noteSaved.style.display = "none";
    try {
      await api("/api/activity/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, note: noteInput.value }),
      });
      noteSaved.style.display = "";
    } catch (e) {
      alert(t("note.failed", { msg: e.message }));
    }
  });

  // 训练分类：详情页直接标记
  const catSel = $("#actCategory");
  const catSaved = $("#catSaved");
  if (catSel) {
    catSel.addEventListener("change", async () => {
      catSaved.style.display = "none";
      try {
        await api("/api/activity/category", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, category: catSel.value }),
        });
        catSaved.style.display = "";
        state.overview = null; // 列表页分类缓存失效
      } catch (e) {
        alert(t("cat.failed", { msg: e.message }));
      }
    });
  }

  // AI 复盘：自动加载本训练缓存的最新 review 报告；没有则显示按钮，点击生成
  const panel = $("#aiPanel"), body = $("#aiBody");
  if (panel && body) {
    try {
      const reports = (await api(`/api/ai/reports?mode=review`)).reports
        .filter((r) => r.file_name === name);
      if (reports.length) {
        const rep = reports[0];
        panel.style.display = "";
        if (rep.status === "pending") {
          panel.querySelector(".panel-title").innerHTML = t("ai.panel.pending");
          body.innerHTML = `<div class="callout info">${esc(t("ai.panel.pending_hint"))}</div>`;
        } else if (rep.status === "failed") {
          panel.querySelector(".panel-title").innerHTML = t("ai.panel.failed");
          body.innerHTML = `<div class="callout">${esc(t("ai.failed", { err: rep.error || t("ai.err.unknown") }))}</div>`;
        } else {
          const cached = await api(`/api/ai/report?id=${rep.id}`);
          panel.querySelector(".panel-title").innerHTML =
            t("ai.panel.cached", { id: rep.id }) +
            `<button class="btn ghost" id="btnRegenReview" style="margin-left:auto"><span>${esc(t("ai.regen"))}</span></button>`;
          body.innerHTML = `<div class="ai-result">${cached.html}</div>`;
          state.aiThread = {
            file_name: name,
            report_id: cached.id,
            chat_id: null,
          };
          attachFollowUp(panel, body);
          $("#btnRegenReview").addEventListener("click", () =>
            runAi({ mode: "review", file_name: name }, panel, body),
          );
        }
      }
      // 顶部 AI 复盘按钮：已有报告时跳到底部，否则触发后台分析
      $("#btnAiReview").addEventListener("click", () => {
        if (panel.style.display !== "none") {
          panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          runAi({ mode: "review", file_name: name }, panel, body);
        }
      });
    } catch (e) {
      // 即使历史报告接口出错，也不影响训练详情主内容
      $("#btnAiReview").addEventListener("click", () =>
        runAi({ mode: "review", file_name: name }, panel, body),
      );
    }
  }
}

function fmtPace(minPerKm) {
  if (minPerKm == null) return "-";
  const m = Math.floor(minPerKm), s = Math.round((minPerKm - m) * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function segmentsHtml(summary) {
  const segs = summary.segments;
  if (!segs?.length) return "";
  const cols = ["duration", "avg_power", "max_power", "avg_hr", "avg_cadence", "pct_ftp", "distance", "pace"]
    .map((c) => esc(t(`seg.col.${c}`)));
  return `<div class="panel"><div class="panel-title">${esc(t("seg.title", { n: segs.length }))}</div>
    <div style="overflow-x:auto"><table class="data-table">
    <tr><th>${esc(t("seg.name"))}</th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>
    ${segs.map((s) => `<tr><td>${esc(s.name)}</td>
      <td>${fmtDur(s.duration_sec)}</td>
      <td>${s.avg_power ?? "-"}</td><td>${s.max_power ?? "-"}</td>
      <td>${s.avg_hr ?? "-"}</td><td>${s.avg_cadence ?? "-"}</td>
      <td>${s.pct_ftp ?? "-"}</td>
      <td>${s.distance_km ?? "-"}</td>
      <td>${s.avg_pace_min_per_km ? fmtPace(s.avg_pace_min_per_km) : "-"}</td></tr>`).join("")}
    </table></div>
    ${summary.interval_set ? `<p class="muted" style="margin-top:10px;font-size:12px">
      ${esc(t("seg.set", {
        n: summary.interval_set.count,
        dur: fmtDur(summary.interval_set.avg_duration_sec),
        w: summary.interval_set.avg_power,
        pct: summary.interval_set.avg_pct_ftp,
      }))}</p>` : ""}
  </div>`;
}

function climbsHtml(summary) {
  if (!summary.climbs?.length) return "";
  return `<div class="panel"><div class="panel-title">${esc(t("climb.title", { n: summary.climbs.length }))}</div>
    <div class="table-wrap"><table class="data-table">
    <tr><th>${esc(t("climb.col.name"))}</th><th>${esc(t("climb.col.duration"))}</th><th>${esc(t("climb.col.distance"))}</th><th>${esc(t("climb.col.gain"))}</th><th>${esc(t("climb.col.grade"))}</th><th>${esc(t("climb.col.avg_power"))}</th><th>${esc(t("climb.col.avg_hr"))}</th></tr>
    ${summary.climbs.map((c) => `<tr><td>${esc(c.name)}</td><td>${fmtDur(c.duration_sec)}</td>
      <td>${c.distance_m}</td><td>${c.elevation_gain_m}</td><td>${c.avg_grade_pct}</td>
      <td>${c.avg_power ?? "-"}</td><td>${c.avg_hr ?? "-"}</td></tr>`).join("")}
    </table></div></div>`;
}

function cadencePowerHtml(summary) {
  const cp = summary.cadence_power;
  if (!cp) return "";
  const styleHint = cadenceStyleHint(cp.style);
  return `<div class="panel"><div class="panel-title">${esc(t("cad.title"))}</div>
    <div class="metric-grid" style="margin-bottom:0">
      ${metricHtml(t("cad.effort"), fmtDur(cp.sample_sec), "", t("cad.effort_sub"))}
      ${metricHtml(t("cad.avg"), cp.avg_cadence, "rpm")}
      ${metricHtml(t("cad.low"), cp.pct_low_cadence, "%", t("cad.low_sub"))}
      ${metricHtml(t("cad.high"), cp.pct_high_cadence, "%", t("cad.high_sub"))}
      ${metricHtml(t("cad.corr"), cp.cadence_power_corr ?? "-")}
    </div>
    ${styleHint ? `<p class="muted" style="margin-top:10px;font-size:13px">${esc(styleHint)}</p>` : ""}
  </div>`;
}

function anomaliesHtml(summary) {
  const an = summary.anomalies;
  const dq = summary.data_quality || {};
  const dqText = [
    dq.power_coverage_pct != null ? t("dq.power", { p: dq.power_coverage_pct }) : null,
    dq.hr_coverage_pct != null ? t("dq.hr", { p: dq.hr_coverage_pct }) : null,
    dq.dropped_records_no_timestamp ? t("dq.dropped", { n: dq.dropped_records_no_timestamp }) : null,
    dq.missing_seconds ? t("dq.missing", { n: dq.missing_seconds }) : null,
    dq.pause_seconds ? t("dq.paused", { n: dq.pause_seconds }) : null,
  ].filter(Boolean).join(" · ");
  if (!an?.length && !dqText) return "";
  // 异常列表可折叠：超过 5 条默认收起（自动暂停产生的缺失标注可能几十条），点击展开
  const listHtml = an?.length
    ? `<details class="anomaly-details" ${an.length > 5 ? "" : "open"}>
        <summary>${esc(t("dq.summary", { n: an.length }))}</summary>
        <ul class="anomaly-list">${an.map((x) => `<li>⚠ ${esc(x)}</li>`).join("")}</ul>
      </details>`
    : `<p class="muted" style="font-size:13px">${esc(t("dq.clean"))}</p>`;
  return `<div class="panel"><div class="panel-title">${esc(t("dq.title"))}</div>
    ${dqText ? `<p class="muted" style="font-size:12px;margin-bottom:8px">${esc(dqText)}</p>` : ""}
    ${listHtml}
  </div>`;
}
