/**
 * views/activities.js — 训练列表 + 训练详情
 * 详情页：指标网格 / 分类标记 / 训练备注 / 时序曲线（系列开关）/ 分区分布 /
 * 峰功率曲线 / 赛段 / 爬坡 / 踏频-功率 / 数据质量 / AI 复盘（含追问）。
 */

import {
  $, app, esc, api, num, fmtDur, formNote, state, loadOverview,
  sportBadge, CATEGORY_LABEL, ZONE_COLORS, actRowHtml,
} from "../common.js";
import { drawLineChart, zoneBarsHtml, peakCurveHtml } from "../charts.js";
import { runAi, attachFollowUp } from "../ai.js";

// ---------------- 训练列表 ----------------

export async function renderActivities() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const ov = await loadOverview();
  app.innerHTML = `
    <div class="view-title"><h1>训练记录</h1><span class="sub">${(ov.activities || []).length} 次训练</span></div>
    <div class="act-list">${(ov.activities || []).map(actRowHtml).join("") || `<div class="empty">训练库为空</div>`}</div>`;
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
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
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
  metrics.push(metricHtml("时长", fmtDur(a.duration_sec)));
  metrics.push(metricHtml("距离", num(a.distance_km, 2), "km"));
  if (a.avg_speed_kmh != null) metrics.push(metricHtml("平均速度", num(a.avg_speed_kmh, 2), "km/h"));
  if (a.elevation_gain_m) metrics.push(metricHtml("爬升", a.elevation_gain_m, "m"));
  if (a.total_calories != null) metrics.push(metricHtml("卡路里", a.total_calories, "kcal"));
  if (p.normalized_power != null) metrics.push(metricHtml("NP", p.normalized_power, "W", `IF ${num(p.intensity_factor, 2)}`));
  if (p.avg != null) metrics.push(metricHtml("平均功率", num(p.avg, 0), "W", p.w_per_kg_avg ? `${num(p.w_per_kg_avg, 2)} W/kg` : ""));
  if (p.max != null) metrics.push(metricHtml("最大功率", p.max, "W"));
  if (p.tss != null) metrics.push(metricHtml("TSS", p.tss, "", `VI ${num(p.variability_index, 2)}`));
  if (hr.avg != null) metrics.push(metricHtml("平均心率", num(hr.avg, 0), "bpm", hr.max ? `最大 ${hr.max}` : ""));
  if (hr.hr_drift_pct != null)
    metrics.push(metricHtml("心率漂移", num(hr.hr_drift_pct, 1), "%", Math.abs(hr.hr_drift_pct) < 5 ? "有氧基础扎实" : "漂移偏大"));
  if (summary.cadence?.avg != null)
    metrics.push(metricHtml(a.sport === "running" ? "平均步频" : "平均踏频", num(summary.cadence.avg, 0), a.sport === "running" ? "spm" : "rpm"));
  if (summary.temperature)
    metrics.push(metricHtml("平均温度", num(summary.temperature.avg, 1), "°C", summary.temperature.max != null ? `最高 ${summary.temperature.max}°C` : ""));
  if (summary.pace) {
    metrics.push(metricHtml("平均配速", fmtPace(summary.pace.avg_pace_min_per_km), "/km"));
    if (summary.pace.best_1min_pace_min_per_km)
      metrics.push(metricHtml("最快 1min 配速", fmtPace(summary.pace.best_1min_pace_min_per_km), "/km"));
  }
  if (summary.swim) {
    const sw = summary.swim;
    metrics.push(metricHtml("趟数", sw.lengths_count));
    if (sw.avg_swolf) metrics.push(metricHtml("平均 SWOLF", sw.avg_swolf));
    if (sw.avg_length_time_sec) metrics.push(metricHtml("平均每趟", num(sw.avg_length_time_sec, 1), "s"));
  }
  if (ac.ctl != null) {
    metrics.push(metricHtml("当日 CTL", ac.ctl, "", "训练当日体能"));
    metrics.push(metricHtml("当日 ATL", ac.atl, "", "训练当日疲劳"));
    metrics.push(metricHtml("当日 TSB", (ac.tsb > 0 ? "+" : "") + ac.tsb, "", ac.form_note || formNote(ac.tsb)));
  }

  // ---- FTP 估算提示 ----
  let ftpCallout = "";
  const est = p.ftp_estimate;
  if (est && est.suggestion === "consider_update")
    ftpCallout = `<div class="callout">FTP 估算 ${est.estimated_ftp_w}W（20min 峰功率 × 0.95），高于当前配置 ${est.current_ftp_w}W — 建议到「设置」页更新 FTP</div>`;
  else if (est && est.suggestion === "consider_recheck")
    ftpCallout = `<div class="callout info">FTP 估算 ${est.estimated_ftp_w}W，低于当前配置 ${est.current_ftp_w}W — 可能状态欠佳或本次未尽全力，建议实测确认后再调整</div>`;

  // ---- 时序图 ----
  const seriesDefs = [
    { key: "power", name: "功率", color: "#d7ff3f", unit: "W", area: true },
    { key: "heart_rate", name: "心率", color: "#ff5d73", unit: "bpm" },
    { key: "cadence", name: a.sport === "running" ? "步频" : "踏频", color: "#3fd6f5", unit: a.sport === "running" ? "spm" : "rpm" },
    { key: "altitude", name: "海拔", color: "#8d9aa8", unit: "m" },
    { key: "speed", name: "速度", color: "#5aa2ff", unit: "km/h" },
    { key: "temperature", name: "温度", color: "#ffa94d", unit: "°C" },
  ];

  app.innerHTML = `
    <div class="detail-head">
      <a class="back-link" href="#/activities">← 训练列表</a>
      <h1>${sportBadge(a.sport)}${esc(a.date)}</h1>
      <span class="muted mono" style="font-size:12px">${esc(name)}</span>
      <div class="category-bar">
        <label for="actCategory">分类</label>
        <select id="actCategory">
          ${Object.entries(CATEGORY_LABEL)
            .map(([k, v]) => `<option value="${k}" ${summary.activity?.category === k ? "selected" : ""}>${esc(v)}</option>`)
            .join("")}
        </select>
        <span id="catSaved" class="muted" style="display:none">已保存</span>
      </div>
      <span class="spacer"></span>
      <button class="btn" id="btnAiReview"><span>AI 复盘</span></button>
    </div>
    ${ftpCallout}
    <div class="metric-grid">${metrics.join("")}</div>
    <div class="panel">
      <div class="panel-title">训练备注</div>
      <div class="note-form">
        <textarea id="actNote" rows="3" maxlength="2000" placeholder="自由记录本次训练的体感、路况、天气、状态等（AI 复盘时会纳入考量）…">${esc(a.note ?? "")}</textarea>
        <div class="note-actions">
          <button class="btn sm" id="btnSaveNote"><span>保存备注</span></button>
          <span id="noteSaved" class="muted" style="display:none">已保存 ✓</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">时序曲线（各系列独立纵轴缩放）</div>
      <div class="chart-legend" id="tsLegend"></div>
      <div class="chart-wrap" id="tsChart"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="zone-panels">
      <div class="panel"><div class="panel-title">功率分区（Coggan 7 区）</div>${zoneBarsHtml(p.zone_distribution_pct, ZONE_COLORS, zone_ranges?.power)}</div>
      <div class="panel"><div class="panel-title">心率分区（5 区）</div>${zoneBarsHtml(hr.zone_distribution_pct, ZONE_COLORS, zone_ranges?.hr)}</div>
    </div>
    ${peakCurveHtml(p.peak_curve, ftp)}
    ${segmentsHtml(summary)}
    ${climbsHtml(summary)}
    ${cadencePowerHtml(summary)}
    ${anomaliesHtml(summary)}
    <div class="panel" id="aiPanel" style="display:none">
      <div class="panel-title">AI 复盘报告</div>
      <div id="aiBody"></div>
    </div>`;

  // 时序图渲染 + 系列开关
  const legend = $("#tsLegend");
  const chartEl = $("#tsChart");
  const redraw = () => {
    if (!records?.points?.length) {
      chartEl.innerHTML = `<div class="empty">没有时序数据（records CSV 不在输出目录中）</div>`;
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
          <span class="dot" style="background:${s.color}"></span>${s.name}
          <span class="avg">均 ${avg ?? "-"}${s.unit}</span></button>`;
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
      alert(`备注保存失败：${e.message}`);
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
        alert(`分类保存失败：${e.message}`);
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
          panel.querySelector(".panel-title").innerHTML = "AI 复盘报告（生成中…）";
          body.innerHTML = `<div class="callout info">AI 复盘报告正在后台生成中，请稍后再刷新查看。</div>`;
        } else if (rep.status === "failed") {
          panel.querySelector(".panel-title").innerHTML = "AI 复盘报告（生成失败）";
          body.innerHTML = `<div class="callout">生成失败：${esc(rep.error || "未知错误")}</div>`;
        } else {
          const cached = await api(`/api/ai/report?id=${rep.id}`);
          panel.querySelector(".panel-title").innerHTML =
            `AI 复盘报告（已缓存 #${rep.id}）` +
            `<button class="btn ghost" id="btnRegenReview" style="margin-left:auto"><span>重新生成</span></button>`;
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
  const cols = ["时长", "均功率", "最大功率", "均心率", "均踏频", "%FTP", "距离", "配速"];
  return `<div class="panel"><div class="panel-title">赛段 / 间歇（${segs.length}）</div>
    <div style="overflow-x:auto"><table class="data-table">
    <tr><th>名称</th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>
    ${segs.map((s) => `<tr><td>${esc(s.name)}</td>
      <td>${fmtDur(s.duration_sec)}</td>
      <td>${s.avg_power ?? "-"}</td><td>${s.max_power ?? "-"}</td>
      <td>${s.avg_hr ?? "-"}</td><td>${s.avg_cadence ?? "-"}</td>
      <td>${s.pct_ftp ?? "-"}</td>
      <td>${s.distance_km ?? "-"}</td>
      <td>${s.avg_pace_min_per_km ? fmtPace(s.avg_pace_min_per_km) : "-"}</td></tr>`).join("")}
    </table></div>
    ${summary.interval_set ? `<p class="muted" style="margin-top:10px;font-size:12px">
      间歇组：${summary.interval_set.count} 组 × 均 ${fmtDur(summary.interval_set.avg_duration_sec)} @ ${summary.interval_set.avg_power}W（${summary.interval_set.avg_pct_ftp}% FTP）</p>` : ""}
  </div>`;
}

function climbsHtml(summary) {
  if (!summary.climbs?.length) return "";
  return `<div class="panel"><div class="panel-title">爬坡段（${summary.climbs.length}）</div>
    <div class="table-wrap"><table class="data-table">
    <tr><th>名称</th><th>时长</th><th>长度 m</th><th>爬升 m</th><th>均坡度 %</th><th>均功率</th><th>均心率</th></tr>
    ${summary.climbs.map((c) => `<tr><td>${esc(c.name)}</td><td>${fmtDur(c.duration_sec)}</td>
      <td>${c.distance_m}</td><td>${c.elevation_gain_m}</td><td>${c.avg_grade_pct}</td>
      <td>${c.avg_power ?? "-"}</td><td>${c.avg_hr ?? "-"}</td></tr>`).join("")}
    </table></div></div>`;
}

function cadencePowerHtml(summary) {
  const cp = summary.cadence_power;
  if (!cp) return "";
  return `<div class="panel"><div class="panel-title">踏频-功率分析</div>
    <div class="metric-grid" style="margin-bottom:0">
      ${metricHtml("发力时段", fmtDur(cp.sample_sec), "", "功率 ≥ 75% FTP")}
      ${metricHtml("平均踏频", cp.avg_cadence, "rpm")}
      ${metricHtml("低踏频占比", cp.pct_low_cadence, "%", "< 80rpm")}
      ${metricHtml("高踏频占比", cp.pct_high_cadence, "%", "> 90rpm")}
      ${metricHtml("踏频-功率相关", cp.cadence_power_corr ?? "-")}
    </div>
    <p class="muted" style="margin-top:10px;font-size:13px">${esc(cp.style_hint)}</p>
  </div>`;
}

function anomaliesHtml(summary) {
  const an = summary.anomalies;
  const dq = summary.data_quality || {};
  const dqText = [
    dq.power_coverage_pct != null ? `功率覆盖 ${dq.power_coverage_pct}%` : null,
    dq.hr_coverage_pct != null ? `心率覆盖 ${dq.hr_coverage_pct}%` : null,
    dq.dropped_records_no_timestamp ? `无时间戳丢弃 ${dq.dropped_records_no_timestamp} 条` : null,
    dq.missing_seconds ? `缺失 ${dq.missing_seconds} 秒` : null,
  ].filter(Boolean).join(" · ");
  if (!an?.length && !dqText) return "";
  // 异常列表可折叠：超过 5 条默认收起（自动暂停产生的缺失标注可能几十条），点击展开
  const listHtml = an?.length
    ? `<details class="anomaly-details" ${an.length > 5 ? "" : "open"}>
        <summary>异常标注 ${an.length} 条</summary>
        <ul class="anomaly-list">${an.map((x) => `<li>⚠ ${esc(x)}</li>`).join("")}</ul>
      </details>`
    : `<p class="muted" style="font-size:13px">未发现异常</p>`;
  return `<div class="panel"><div class="panel-title">数据质量与异常</div>
    ${dqText ? `<p class="muted" style="font-size:12px;margin-bottom:8px">${esc(dqText)}</p>` : ""}
    ${listHtml}
  </div>`;
}
