/**
 * views/dashboard.js — 概览（负荷仪表盘）
 * CTL/ATL/TSB 大数字 + 负荷趋势图 + 月度汇总 + 最近训练 + FTP 科学估算 + 指标说明弹窗。
 */

import {
  $, app, esc, api, state, loadOverview, renderAthleteChip,
  formNote, actRowHtml, showModal,
} from "../common.js";
import { drawTrendChart } from "../charts.js";

export async function renderDashboard() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
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
      <h1>负荷仪表盘</h1>
      <button class="btn icon" id="glossaryBtn" title="指标说明与算法口径">?</button>
      <span class="sub">CTL 体能 · ATL 疲劳 · TSB 状态（最近 90 天）</span>
    </div>
    <div class="hero-grid">
      ${last ? heroTile("CTL · 体能", last.ctl, "#5aa2ff", "42 天指数加权，长期训练积累") : ""}
      ${last ? heroTile("ATL · 疲劳", last.atl, "#ff5d73", "7 天指数加权，近期疲劳程度") : ""}
      ${last ? heroTile("TSB · 状态", (last.tsb > 0 ? "+" : "") + last.tsb, "#3ddc97", formNote(last.tsb)) : ""}
      <div class="hero-tile" style="--tile-color:#d7ff3f">
        <div class="label">FTP · 阈值</div>
        <div class="value" id="ftpTileValue">${a.ftp_watts ?? "-"}<small> W</small></div>
        <div class="note"><button class="btn ghost sm" id="ftpEstBtn"><span>科学估算 FTP</span></button></div>
      </div>
      ${!last ? `<div class="empty" style="grid-column:1/-1">训练库为空 — 到「上传」页导入第一个 FIT 文件</div>` : ""}
    </div>
    <div id="ftpPanel"></div>
    <div class="panel">
      <div class="panel-title">负荷趋势（灰柱 = 每日 TSS）</div>
      <div class="chart-legend">
        <span class="legend-chip"><span class="dot" style="background:#5aa2ff"></span>CTL 体能</span>
        <span class="legend-chip"><span class="dot" style="background:#ff5d73"></span>ATL 疲劳</span>
        <span class="legend-chip"><span class="dot" style="background:#3ddc97"></span>TSB 状态</span>
      </div>
      <div class="chart-wrap" id="trendChart"></div>
    </div>
    <div class="panel">
      <div class="panel-title">月度汇总</div>
      ${monthlyTableHtml(ov.monthly)}
    </div>
    <div class="panel">
      <div class="panel-title">最近训练</div>
      <div class="act-list">${(ov.activities || []).slice(0, 6).map(actRowHtml).join("") || `<div class="empty">暂无训练记录</div>`}</div>
    </div>`,
  drawTrendChart($("#trendChart"), daily);
  $("#ftpEstBtn")?.addEventListener("click", runFtpEstimate);
  $("#glossaryBtn")?.addEventListener("click", () => showModal("指标说明与算法口径", glossaryHtml()));
}

// ---------------- FTP 科学估算（功率峰曲线 + 心率交叉验证） ----------------

const CONF_LABEL = { high: "置信度 高", medium: "置信度 中", low: "置信度 低" };

async function runFtpEstimate() {
  const panel = $("#ftpPanel");
  panel.innerHTML = `<div class="panel"><div class="empty loading">正在分析最近窗口期的功率与心率数据…</div></div>`;
  try {
    const r = await api("/api/ftp-estimate");
    panel.innerHTML = ftpEstimateHtml(r);
    $("#ftpApplyBtn")?.addEventListener("click", () => applyFtp(r.estimate.ftp_w));
  } catch (e) {
    panel.innerHTML = `<div class="panel"><div class="callout">FTP 估算失败：${esc(e.message)}</div></div>`;
  }
}

function ftpEstimateHtml(r) {
  const s = r.sample || {};
  const sampleLine = `分析窗口：最近 ${r.window_days} 天 · 骑行 ${s.cycling_rides ?? 0} 次 · 有效功率样本 ${s.usable_power_rides ?? 0} 次 · 含心率 ${s.rides_with_hr ?? 0} 次`;
  const needsHtml = r.data_needs?.length
    ? `<div class="callout"><b>需要补充收集的数据：</b><ul class="ftp-list">${r.data_needs.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>`
    : "";
  const notesHtml = r.notes?.length
    ? `<div class="callout info"><b>数据质量与漂移提示：</b><ul class="ftp-list">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
    : "";
  const refsHtml = r.references?.length
    ? `<div class="muted ftp-refs">算法参照：${r.references.map(esc).join("；")}</div>`
    : "";

  if (r.status !== "ok" || !r.estimate) {
    return `<div class="panel">
      <div class="panel-title">FTP 科学估算 — 数据不足</div>
      <div class="muted" style="margin-bottom:12px">${sampleLine}</div>
      ${needsHtml}${notesHtml}${refsHtml}
    </div>`;
  }

  const e = r.estimate;
  const m = e.methods || {};
  const diff = e.diff_w;
  const diffTxt =
    diff === 0 ? "与当前配置一致" : diff > 0 ? `比当前配置（${e.current_ftp_w}W）高 ${diff}W` : `比当前配置（${e.current_ftp_w}W）低 ${-diff}W`;
  const cp = m.cp_model;
  const cog = m.coggan_20min;
  const hr = m.hr_check || {};
  const zm = hr.zone_mismatch;
  const methodRows = [
    cp
      ? `<tr><td>CP 临界功率模型</td><td>${cp.ftp_w}W</td><td class="muted">5min 峰 ${cp.p5.watts}W（${esc(cp.p5.date)}）+ 20min 峰 ${cp.p20.watts}W（${esc(cp.p20.date)}）→ CP ${cp.cp_w}W / W′ ${cp.w_prime_kj}kJ</td></tr>`
      : `<tr><td>CP 临界功率模型</td><td>-</td><td class="muted">不可用（峰功率形态退化）</td></tr>`,
    cog
      ? `<tr><td>Coggan 20min × 0.95</td><td>${cog.ftp_w}W</td><td class="muted">20min 峰功率 ${cog.peak_20min_w}W（${esc(cog.date)}）</td></tr>`
      : "",
    `<tr><td>心率交叉验证</td><td>${
      hr.maximal_effort == null ? "-" : hr.maximal_effort ? "全力 ✓" : "非全力 ⚠"
    }</td><td class="muted">锚点骑行心率峰值 ${hr.best20_max_hr ?? "-"}bpm（全力阈值 ≥${hr.threshold_hr ?? "-"}bpm）${
      zm ? `；功率/心率高强度占比 ${zm.power_high_pct}%/${zm.hr_high_pct}%` : ""
    }${hr.median_hr_drift_pct != null ? `；心率漂移中位数 ${hr.median_hr_drift_pct}%` : ""}</td></tr>`,
  ].join("");

  const applyHtml =
    diff === 0
      ? ""
      : e.confidence === "high"
        ? `<button class="btn sm" id="ftpApplyBtn"><span>采纳 ${e.ftp_w}W 并保存到训练库</span></button>`
        : `<span class="muted">置信度不足，不建议写回 — 请先按下方清单补充数据后重新估算</span>`;

  return `<div class="panel">
    <div class="panel-title">FTP 科学估算</div>
    <div class="muted" style="margin-bottom:16px">${sampleLine}</div>
    <div class="ftp-result">
      <div class="ftp-big">${e.ftp_w}<small> W</small></div>
      <div class="ftp-meta">
        <span class="conf-badge ${esc(e.confidence)}">${CONF_LABEL[e.confidence] ?? esc(e.confidence)}</span>
        <span class="muted">${esc(e.confidence_note ?? "")}</span>
      </div>
      <div class="muted">参考区间 ${e.range_low}–${e.range_high}W · ${esc(diffTxt)}</div>
      ${applyHtml}
      <span class="ftp-applied muted" style="display:none">已保存到训练库并即时生效</span>
    </div>
    <div class="table-wrap"><table class="data-table" style="margin-top:16px">
      <tr><th>方法</th><th>结果</th><th>依据</th></tr>
      ${methodRows}
    </table></div>
    ${needsHtml}${notesHtml}${refsHtml}
  </div>`;
}

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
    alert(`写回失败：${e.message}`);
    if (btn) btn.disabled = false;
  }
}

function monthlyTableHtml(months) {
  if (!months?.length) return `<div class="empty">暂无月度数据</div>`;
  const typeLabel = { polarized: "极化", pyramidal: "金字塔", sweet_spot: "甜区" };
  return `<div class="table-wrap"><table class="data-table">
    <tr><th>月份</th><th>TSS</th><th>时长 h</th><th>距离 km</th><th>次数</th><th>强度分布（低/中/高）</th><th>类型</th></tr>
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
        <td>${typeLabel[m.intensity_type] ?? "-"}</td></tr>`;
    }).join("")}</table></div>`;
}

// ---------------- 指标说明弹窗内容 ----------------

function glossaryHtml() {
  return `
    <div class="panel">
      <div class="panel-title">指标说明</div>
      <div class="glossary">
        <div><dt>CTL · 体能</dt><dd>慢性训练负荷（Chronic Training Load）。TSS 的 42 天指数加权平均，反映长期训练积累；数值稳步上升代表体能增长，骤降通常意味着停训。</dd></div>
        <div><dt>ATL · 疲劳</dt><dd>急性训练负荷（Acute Training Load）。TSS 的 7 天指数加权平均，反映近期疲劳程度；比赛周或高强度周后通常会冲高。</dd></div>
        <div><dt>TSB · 状态</dt><dd>训练状态平衡（Training Stress Balance）= CTL − ATL。+5~+15 表示身体新鲜、适合比赛或高强度测试；−10 以下表示疲劳累积，需要恢复。</dd></div>
        <div><dt>TSS · 训练负荷</dt><dd>Training Stress Score。综合训练强度与时长：TSS = (秒 × NP × IF) / (FTP × 3600) × 100。1 小时平路 FTP 强度 ≈ 100 TSS。</dd></div>
        <div><dt>FTP · 功能阈值功率</dt><dd>Functional Threshold Power，理论上可稳定维持约 1 小时的平均功率。它是 Coggan 功率分区、IF、TSS 等几乎所有功率指标的锚点。</dd></div>
        <div><dt>NP · 标准化功率</dt><dd>Normalized Power。先对功率做 30 秒滚动平均，再取四次方均值并开四次方根，补偿间歇、爬坡等功率波动带来的额外生理代价。</dd></div>
        <div><dt>IF · 强度因子</dt><dd>Intensity Factor = NP / FTP。IF = 1.0 代表本次训练平均强度约等于 FTP。</dd></div>
        <div><dt>VI · 变异指数</dt><dd>Variability Index = NP / 平均功率。越接近 1，功率输出越平稳；>1.05 通常说明训练起伏较大（如爬坡/间歇）。</dd></div>
        <div><dt>心率漂移（有氧解耦）</dt><dd>前后半程效率因子（功率/心率，无功率时用速度/心率）的相对变化。&lt;5% 是有氧基础扎实的标志；高温、疲劳、脱水时通常会升高。</dd></div>
        <div><dt>功率 / 心率分区</dt><dd>功率按 Coggan 7 区（%FTP）、心率按 5 区（%HRmax）划分。训练强度分布（低 Z1-Z2 / 中 Z3-Z4 / 高 Z5+）是判断周期取向（极化/金字塔/甜区）的核心。</dd></div>
        <div><dt>峰功率曲线</dt><dd>5 秒 / 1 分钟 / 5 分钟 / 20 分钟的最大平均功率，分别对应无氧爆发、无氧耐力、有氧能力、阈值能力。本页「科学估算 FTP」基于最近窗口期的 5min/20min 峰功率。</dd></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">核心算法简介</div>
      <div class="glossary">
        <div><dt>指数加权负荷模型</dt><dd>与 TrainingPeaks 一致：当日 CTL = 前日 CTL + (TSS − 前日 CTL) / 42，ATL = 前日 ATL + (TSS − 前日 ATL) / 7，缺天按 TSS = 0 参与衰减。</dd></div>
        <div><dt>FTP 科学估算</dt><dd>双方法互校：① Morton 双参数临界功率模型 CP+W′/t，解出 CP 近似 FTP；② Coggan 20 分钟峰功率 × 0.95。再用 90% HRmax 全力判定、功率/心率区间偏移、心率漂移中位数做交叉验证；数据不足时返回需要补充收集的数据清单。</dd></div>
        <div><dt>间歇识别</dt><dd>找出功率 ≥ 105% FTP 的连续段，低于阈值但 ≤ 10 秒的瞬时掉功率会被合并，短于 30 秒的段丢弃；识别到 ≥ 2 个重复工作段时输出间歇组统计。</dd></div>
        <div><dt>爬坡段提取</dt><dd>30 秒滑动窗口计算局部坡度，平均坡度 ≥ 3%、段内累计爬升 ≥ 15 m、段长 ≥ 300 m 的连续路段被提取为爬坡段。</dd></div>
        <div><dt>AI 报告</dt><dd>服务端把训练数据、负荷走势与指标口径拼装成 Markdown 提示词，调用 OpenAI 兼容接口（默认 Kimi）生成报告；未配置 API Key 时返回完整提示词，可一键复制到任意 AI 使用。</dd></div>
      </div>
    </div>`;
}
