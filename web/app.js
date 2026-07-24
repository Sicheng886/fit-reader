/**
 * app.js — fit-reader Web 前端（P4）
 * 零依赖 SPA：hash 路由 + 手写 SVG 图表 + 极简 Markdown 渲染。
 * 视图：概览（负荷仪表盘）/ 训练列表 / 训练详情 / 上传分析 / AI 分析。
 */

// ---------------- 工具 ----------------

const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function api(path, opts) {
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

/** 通用弹窗：标题 + HTML 内容，点击遮罩或 × 关闭 */
function showModal(title, bodyHtml) {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">${esc(title)}</div>
        <button class="modal-close" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector(".modal-close").addEventListener("click", () => el.remove());
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
}

const SPORT_LABEL = { cycling: "骑行", running: "跑步", swimming: "游泳" };
const sportLabel = (s) => SPORT_LABEL[s] || s || "未知";
const sportBadge = (s) =>
  `<span class="sport-badge ${esc(s)}">${sportLabel(s)}</span>`;

const CATEGORY_LABEL = {
  training: "训练",
  race: "比赛",
  recovery: "恢复",
  leisure: "休闲",
};
const categoryLabel = (c) => CATEGORY_LABEL[c] ?? c ?? "训练";
const categoryBadge = (c) => {
  const key = c || "training";
  const cls = `cat-badge cat-${esc(key)}`;
  return `<span class="${cls}">${esc(categoryLabel(key))}</span>`;
};

function fmtDur(sec) {
  if (sec == null) return "-";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
const fmtXAxis = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`;
};
const num = (v, d = 0) =>
  v == null ? "-" : Number(v).toFixed(d).replace(/\.0+$/, d === 0 ? "" : "");
const trunc = (s, n = 30) =>
  s == null ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s;

// 分区配色（运动风渐变：灰→蓝→绿→荧光黄→橙→红）
const ZONE_COLORS = {
  Z1: "#5b6670", Z2: "#4aa3ff", Z3: "#3ddc97", Z4: "#d7ff3f",
  Z5: "#ffb03f", Z6: "#ff7a45", Z7: "#ff5d73",
};

const MODE_LABEL = { review: "单次复盘", plan: "周期规划", taper: "赛前减量", compare: "两次对比" };

// TSB 状态简评（与 db.js formNote 同口径）
function formNote(tsb) {
  if (tsb >= 15) return "状态很新鲜，适合比赛或高强度测试";
  if (tsb >= 5) return "状态良好，恢复充分";
  if (tsb >= -10) return "负荷与恢复平衡，可持续训练";
  if (tsb >= -20) return "疲劳积累期，注意睡眠与恢复";
  return "过度疲劳风险，建议安排减量周";
}

// ---------------- 全局状态 ----------------

const state = {
  overview: null, // /api/overview 缓存
  chartToggles: {}, // 详情页时序图系列开关
  firstRun: false, // 训练库未配置骑手参数（首开引导到设置页）
  aiThread: null, // 当前 AI 报告追问会话
};

async function loadOverview(force = false) {
  if (!state.overview || force) state.overview = await api("/api/overview");
  return state.overview;
}

/** 顶栏骑手参数条（启动 / 保存设置 / 采纳 FTP 三处共用） */
function renderAthleteChip(a) {
  a = a || {};
  $("#athleteChip").innerHTML = `FTP <b>${a.ftp_watts ?? "?"}W</b> · HRmax <b>${a.max_hr ?? "?"}</b> · <b>${a.weight_kg ?? "?"}kg</b>`;
}

// ---------------- SVG 图表 ----------------

/**
 * 通用多系列折线图（各系列独立纵轴缩放，图例显示均值）。
 * 对可见序列做简单的中心移动平均平滑，减少采样抖动，让曲线更简洁。
 * series: [{ name, color, unit, points: [y|null...], x0: 起始时间戳秒, step: 秒/点 }]
 */
function drawLineChart(container, series, { height = 280 } = {}) {
  container.innerHTML = "";
  const W = 1000, H = height, PL = 8, PR = 8, PT = 10, PB = 22;
  const iw = W - PL - PR, ih = H - PT - PB;
  const visible = series.filter((s) => s.visible !== false && s.points.some((v) => v != null));
  if (!visible.length) {
    container.innerHTML = `<div class="empty">没有可显示的时序数据</div>`;
    return;
  }
  const n = Math.max(...visible.map((s) => s.points.length));
  const step = visible[0].step ?? 1;
  const x = (i) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

  // 短缺口桥接：码表自动暂停（红绿灯等）造成的秒级缺口在图上用线性插值连起来，
  // 仅影响显示、不改原始数据；超过阈值的长时间停顿（休息/吃饭）仍断开
  const BRIDGE_GAP_SEC = 180;
  const bridge = (pts) => {
    const maxRun = Math.max(1, Math.round(BRIDGE_GAP_SEC / step));
    const out = pts.slice();
    let i = 0;
    while (i < out.length) {
      if (out[i] != null) { i++; continue; }
      let j = i;
      while (j < out.length && out[j] == null) j++;
      const prev = i > 0 ? out[i - 1] : null;
      const next = j < out.length ? out[j] : null;
      if (prev != null && next != null && j - i <= maxRun) {
        for (let k = i; k < j; k++)
          out[k] = prev + ((next - prev) * (k - i + 1)) / (j - i + 1);
      }
      i = j;
    }
    return out;
  };

  // 简单的中心移动平均平滑，窗口半径根据数据长度自动调整，null 保留不跨 gap 填补
  const smooth = (pts) => {
    const radius = Math.max(1, Math.round(n / 400));
    return pts.map((_, i) => {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
        if (pts[j] != null) { sum += pts[j]; count++; }
      }
      return count > 0 ? sum / count : null;
    });
  };

  let svg = "";
  // 网格 + 时间刻度
  for (let g = 0; g <= 4; g++) {
    const y = PT + (g / 4) * ih;
    svg += `<line class="grid" x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}"/>`;
  }
  const totalSec = n * step;
  for (let t = 0; t <= 6; t++) {
    const sec = (t / 6) * totalSec;
    svg += `<text x="${x((sec / totalSec) * (n - 1)).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtXAxis(sec)}</text>`;
  }

  for (const s of visible) {
    const pts = smooth(bridge(s.points));
    const vals = pts.filter((v) => v != null);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const y = (v) => PT + ((max - v) / (max - min)) * ih;
    // null 断段
    let d = "", pen = false;
    pts.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += (pen ? "L" : "M") + `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    if (s.area) {
      const gid = `g${s.name.replace(/\W/g, "")}`;
      svg += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${s.color}" stop-opacity="0.25"/>
        <stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`;
      // 面积图：把路径首尾补到底边（仅当无断段时，否则只画线）
      if (!pts.some((v) => v == null)) {
        svg += `<path d="${d}L${x(n - 1).toFixed(1)},${PT + ih}L${x(0).toFixed(1)},${PT + ih}Z" fill="url(#${gid})"/>`;
      }
    }
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  container.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${height}px">${svg}</svg>`;
}

/** CTL/ATL/TSB 逐日趋势图（共享纵轴 + TSS 背景柱） */
function drawTrendChart(container, daily, { height = 300 } = {}) {
  if (!daily?.length) {
    container.innerHTML = `<div class="empty">训练库为空，先上传或分析若干 FIT 文件</div>`;
    return;
  }
  const W = 1000, H = height, PL = 34, PR = 34, PT = 12, PB = 22;
  const iw = W - PL - PR, ih = H - PT - PB;
  const maxForm = Math.max(...daily.map((d) => Math.max(d.ctl, d.atl)), 10);
  const minForm = Math.min(...daily.map((d) => Math.min(d.tsb, 0)));
  const maxTss = Math.max(...daily.map((d) => d.tss), 1);
  const n = daily.length;
  const x = (i) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yF = (v) => PT + ((maxForm - v) / (maxForm - minForm)) * ih;
  const yT = (v) => PT + ih - (v / maxTss) * ih;

  let svg = "";
  for (let g = 0; g <= 4; g++) {
    const yv = maxForm - (g / 4) * (maxForm - minForm);
    svg += `<line class="grid" x1="${PL}" y1="${PT + (g / 4) * ih}" x2="${W - PR}" y2="${PT + (g / 4) * ih}"/>
            <text x="${PL - 5}" y="${PT + (g / 4) * ih + 3}" text-anchor="end">${Math.round(yv)}</text>`;
  }
  if (minForm < 0)
    svg += `<line class="axis-zero" x1="${PL}" y1="${yF(0)}" x2="${W - PR}" y2="${yF(0)}"/>`;
  // TSS 柱
  const bw = Math.max(1.5, (iw / n) * 0.6);
  for (let i = 0; i < n; i++) {
    if (!daily[i].tss) continue;
    svg += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${yT(daily[i].tss).toFixed(1)}" width="${bw.toFixed(1)}" height="${(PT + ih - yT(daily[i].tss)).toFixed(1)}" fill="rgba(141,154,168,0.25)"/>`;
  }
  // 月份刻度
  let lastM = "";
  for (let i = 0; i < n; i++) {
    const m = daily[i].date.slice(0, 7);
    if (m !== lastM) {
      lastM = m;
      svg += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${m}</text>`;
    }
  }
  const line = (key, color) => {
    const d = daily.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yF(p[key]).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  };
  svg += line("ctl", "#5aa2ff") + line("atl", "#ff5d73") + line("tsb", "#3ddc97");
  container.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}">${svg}</svg>`;
}

/** 分区分布横条 */
function zoneBarsHtml(dist, colors) {
  if (!dist) return `<div class="empty">无分区数据</div>`;
  return `<div class="zone-bars">${Object.entries(dist)
    .map(([z, pct]) => {
      const c = colors[z] || "#888";
      return `<div class="zone-row">
        <span class="z-name">${z}</span>
        <div class="z-track"><div class="z-fill" style="width:${pct}%;background:${c}"></div></div>
        <span class="z-pct">${num(pct, 1)}%</span>
      </div>`;
    })
    .join("")}</div>`;
}

/** 峰功率曲线柱 */
function peakCurveHtml(curve, ftp) {
  if (!curve || !Object.keys(curve).length) return "";
  const max = Math.max(...Object.values(curve));
  return `<div class="panel"><div class="panel-title">峰功率曲线</div>
    <div class="peak-curve">${Object.entries(curve)
      .map(([label, w]) => {
        const pctFtp = ftp ? Math.round((w / ftp) * 100) : null;
        return `<div class="peak-col">
          <span class="p-val">${w}<small class="muted">W</small></span>
          <div class="p-bar" style="height:${Math.max(4, (w / max) * 100)}%"></div>
          <span class="p-label">${label}${pctFtp ? ` · ${pctFtp}%` : ""}</span>
        </div>`;
      })
      .join("")}</div></div>`;
}

// ---------------- 历史 AI 报告 ----------------

async function loadReportList(container, mode = "all") {
  const modes = mode === "all" ? ["review", "plan", "taper", "compare"] : [mode];
  const rows = (await Promise.all(modes.map((m) => api(`/api/ai/reports?mode=${m}`))))
    .flatMap((r, i) => r.reports.map((rep) => ({ ...rep, mode: modes[i] })))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 30);
  if (!rows.length) {
    container.innerHTML = `<div class="empty">暂无 ${mode === "all" ? "" : MODE_LABEL[mode]} 缓存报告</div>`;
    return;
  }
  container.innerHTML = `<div class="table-wrap"><table class="data-table">
    <tr><th>时间</th><th>类别</th><th>关联训练</th><th>操作</th></tr>
    ${rows.map((r) => {
      const extra = r.race_date ? `比赛 ${r.race_date}` : r.compare_with ? `对比 ${esc(r.compare_with)}` : "";
      return `<tr>
        <td>${r.created_at}</td>
        <td>${MODE_LABEL[r.mode] ?? r.mode}</td>
        <td>${esc(r.file_name ?? extra ?? "-")}</td>
        <td><button class="btn ghost" data-id="${r.id}"><span>加载</span></button></td>
      </tr>`;
    }).join("")}
  </table></div>`;
  container.querySelectorAll("button[data-id]").forEach((btn) =>
    btn.addEventListener("click", () => renderCachedReport(Number(btn.dataset.id))),
  );
}

async function renderCachedReport(id) {
  const panel = $("#aiPanel"), body = $("#aiBody");
  if (!panel || !body) return;
  panel.style.display = "";
  body.innerHTML = `<div class="loading">加载报告…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  state.aiThread = null;
  try {
    const r = await api(`/api/ai/report?id=${id}`);
    body.innerHTML = `<div class="ai-result">${r.html || renderMarkdownFallback(r.markdown)}</div>`;
    state.aiThread = {
      file_name: r.file_name,
      messages: [{ role: "assistant", content: r.markdown }],
    };
    attachFollowUp(panel, body);
  } catch (e) {
    body.innerHTML = `<div class="callout">${esc(e.message)}</div>`;
  }
}

/** 服务端未返回 html 时的兜底（已弃用极简 Markdown 渲染，改用 marked 服务端转 HTML） */
function renderMarkdownFallback(md) {
  return `<p>${esc(md).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
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
        <div><dt>AI 分析</dt><dd>服务端把训练数据、负荷走势与指标口径拼装成 Markdown 提示词，调用 OpenAI 兼容接口（默认 Kimi）生成报告；未配置 API Key 时返回完整提示词，可一键复制到任意 AI 使用。</dd></div>
      </div>
    </div>`;
}

// ---------------- 视图：概览 ----------------

async function renderDashboard() {
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

function actRowHtml(a) {
  return `<a class="act-row" href="#/activity/${encodeURIComponent(a.file_name)}">
    <span class="act-date">${esc(a.date)}</span>
    <span class="act-name">${sportBadge(a.sport)}${categoryBadge(a.category)}${esc(a.file_name)}</span>
    <span class="act-stats">
      <span class="act-stat"><span class="v">${fmtDur(a.duration_sec)}</span><br><span class="k">时长</span></span>
      <span class="act-stat"><span class="v">${num(a.distance_km, 1)}</span><br><span class="k">km</span></span>
      <span class="act-stat"><span class="v">${a.np ?? "-"}</span><br><span class="k">NP</span></span>
      <span class="act-stat"><span class="v">${num(a.intensity_factor, 2)}</span><br><span class="k">IF</span></span>
      <span class="act-stat"><span class="v" style="color:var(--volt)">${a.tss ?? "-"}</span><br><span class="k">TSS</span></span>
    </span>
  </a>`;
}

// ---------------- 视图：训练列表 ----------------

async function renderActivities() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const ov = await loadOverview();
  app.innerHTML = `
    <div class="view-title"><h1>训练记录</h1><span class="sub">${(ov.activities || []).length} 次训练</span></div>
    <div class="act-list">${(ov.activities || []).map(actRowHtml).join("") || `<div class="empty">训练库为空</div>`}</div>`;
}

// ---------------- 视图：训练详情 ----------------

function metricHtml(label, value, unit, sub) {
  return `<div class="metric">
    <div class="m-label">${label}</div>
    <div class="m-value">${value}${unit ? `<span class="unit">${unit}</span>` : ""}</div>
    ${sub ? `<div class="m-sub">${sub}</div>` : ""}
  </div>`;
}

async function renderActivityDetail(name) {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const [{ summary }, records] = await Promise.all([
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
      <div class="panel-title">时序曲线（各系列独立纵轴缩放）</div>
      <div class="chart-legend" id="tsLegend"></div>
      <div class="chart-wrap" id="tsChart"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="zone-panels">
      <div class="panel"><div class="panel-title">功率分区（Coggan 7 区）</div>${zoneBarsHtml(p.zone_distribution_pct, ZONE_COLORS)}</div>
      <div class="panel"><div class="panel-title">心率分区（5 区）</div>${zoneBarsHtml(hr.zone_distribution_pct, ZONE_COLORS)}</div>
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
        const cached = await api(`/api/ai/report?id=${reports[0].id}`);
        panel.style.display = "";
        panel.querySelector(".panel-title").innerHTML =
          `AI 复盘报告（已缓存 #${reports[0].id}）` +
          `<button class="btn ghost" id="btnRegenReview" style="margin-left:auto"><span>重新生成</span></button>`;
        body.innerHTML = `<div class="ai-result">${cached.html}</div>`;
        state.aiThread = {
          file_name: name,
          messages: [{ role: "assistant", content: cached.markdown }],
        };
        attachFollowUp(panel, body);
        $("#btnRegenReview").addEventListener("click", () =>
          runAi({ mode: "review", file_name: name }, panel, body),
        );
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

// ---------------- 视图：上传 ----------------

function renderUpload() {
  app.innerHTML = `
    <div class="view-title"><h1>上传分析</h1><span class="sub">FIT 文件 → 逐秒 CSV + 汇总 JSON + 自动入库</span></div>
    <div class="dropzone" id="dz">
      <div class="dz-icon">▲</div>
      <div class="dz-main">拖拽 .fit 文件到这里，或点击选择</div>
      <div class="dz-sub">文件会保存到 input/ 目录并立即分析，结果写入 output/ 与训练库</div>
      <input type="file" id="fileInput" accept=".fit" style="display:none" multiple>
    </div>
    <div class="upload-status" id="upStatus"></div>`;
  const dz = $("#dz"), fi = $("#fileInput"), status = $("#upStatus");
  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files, status);
  });
  fi.addEventListener("change", () => uploadFiles(fi.files, status));
}

async function uploadFiles(files, statusEl) {
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".fit")) {
      statusEl.className = "upload-status err";
      statusEl.textContent = `跳过非 FIT 文件: ${f.name}`;
      continue;
    }
    statusEl.className = "upload-status loading";
    statusEl.textContent = `分析中: ${f.name} …`;
    try {
      const buf = await f.arrayBuffer();
      const r = await api(`/api/upload?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      const s = r.summary;
      statusEl.className = "upload-status ok";
      statusEl.innerHTML = `完成: ${esc(f.name)} — NP ${s.power?.normalized_power ?? "-"}W / TSS ${s.power?.tss ?? "-"}　<a href="#/activity/${encodeURIComponent(r.file_name)}" style="color:var(--volt)">查看详情 →</a>`;
      state.overview = null; // 让概览下次重新拉取
    } catch (e) {
      statusEl.className = "upload-status err";
      statusEl.textContent = `失败: ${f.name} — ${e.message}`;
    }
  }
}

// ---------------- 视图：AI 分析 ----------------

async function renderAI() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const ov = await loadOverview();
  const opts = (ov.activities || [])
    .map((a) => `<option value="${esc(a.file_name)}">${esc(a.date)} · ${sportLabel(a.sport)} · ${esc(trunc(a.file_name))}</option>`)
    .join("");
  const aiInfo = ov.ai || {};
  const cfgNote = aiInfo.configured
    ? `<div class="callout info">AI 已配置：${esc(aiInfo.base_url)} · 模型 ${esc(aiInfo.model)}</div>`
    : `<div class="callout">未配置 FIT_AI_API_KEY — 将生成完整提示词供手动复制到任意 AI（配置后自动直接输出报告）</div>`;

  app.innerHTML = `
    <div class="view-title"><h1>AI 分析</h1><span class="sub">角色 + 指标口径 + 数据 + 问题，一键生成复盘报告</span></div>
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

/** 调 /api/ai 并渲染结果（已配置→Markdown 报告；未配置→提示词 + 复制按钮） */
async function runAi(payload, panel, body) {
  panel.style.display = "";
  body.innerHTML = `<div class="loading">AI 分析中，可能需要 30-60 秒…</div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  state.aiThread = null; // 每次生成新报告时重置追问会话
  try {
    const r = await api("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.markdown) {
      body.innerHTML = `<div class="ai-result">${r.html || renderMarkdownFallback(r.markdown)}</div>`;
      state.aiThread = {
        file_name: payload.file_name,
        messages: [{ role: "assistant", content: r.markdown }],
      };
      attachFollowUp(panel, body);
      // 生成新报告后刷新历史列表
      const list = $("#aiReportList");
      if (list) loadReportList(list, $("#aiReportMode")?.value || "all");
    } else if (r.accepted) {
      body.innerHTML = `<div class="callout info">${esc(r.message || "AI 分析已提交，将在后台生成并保存。")}<br><span class="muted">请稍后从历史报告查看。</span></div>`;
      // 在历史报告页面时刷新列表，让用户能看到后台生成的新报告
      const list = $("#aiReportList");
      if (list) loadReportList(list, $("#aiReportMode")?.value || "all");
    } else if (r.prompt != null) {
      body.innerHTML = `
        <p class="muted" style="margin-bottom:10px">未配置 AI API，以下为完整提示词，复制到任意 AI 即可：</p>
        <button class="btn ghost" id="btnCopyPrompt" style="margin-bottom:12px"><span>复制提示词</span></button>
        <div class="prompt-box">${esc(r.prompt)}</div>`;
      $("#btnCopyPrompt").addEventListener("click", async (e) => {
        await navigator.clipboard.writeText(r.prompt);
        e.target.textContent = "已复制 ✓";
      });
    } else {
      body.innerHTML = `<div class="callout">AI 返回异常：${esc(JSON.stringify(r))}</div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="callout">${esc(e.message)}</div>`;
  }
}

/** 在 AI 报告后附加“继续提问”区 */
function attachFollowUp(panel, body) {
  if (!state.aiThread) return;
  const wrap = document.createElement("div");
  wrap.className = "ai-follow-up";
  wrap.innerHTML = `
    <div class="follow-up-title">继续提问</div>
    <div class="ai-chat" id="aiChat"></div>
    <div class="follow-up-input">
      <textarea id="followQuestion" rows="2" placeholder="基于上方报告继续提问…"></textarea>
      <button class="btn sm" id="btnFollowAsk"><span>提问</span></button>
    </div>`;
  body.appendChild(wrap);

  const input = $("#followQuestion", wrap);
  const btn = $("#btnFollowAsk", wrap);
  const chat = $("#aiChat", wrap);

  const ask = async () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    state.aiThread.messages.push({ role: "user", content: q });
    renderChatBubble(chat, "user", q);
    btn.disabled = true;
    btn.innerHTML = "<span>思考中…</span>";
    try {
      const r = await api("/api/ai/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: state.aiThread.file_name,
          messages: state.aiThread.messages,
        }),
      });
      state.aiThread.messages.push({ role: "assistant", content: r.markdown });
      renderChatBubble(chat, "assistant", r.html || renderMarkdownFallback(r.markdown));
    } catch (e) {
      renderChatBubble(chat, "assistant", `<div class="callout">${esc(e.message)}</div>`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = "<span>提问</span>";
    }
  };

  btn.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
}

function renderChatBubble(container, role, content) {
  const el = document.createElement("div");
  el.className = `chat-bubble ${role}`;
  el.innerHTML =
    role === "user"
      ? `<p>${esc(content)}</p>`
      : `<div class="ai-result">${content}</div>`;
  container.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------- 视图：设置 ----------------

async function renderSettings() {
  app.innerHTML = `<div class="empty loading">加载中…</div>`;
  const { athlete, configured } = await api("/api/athlete");
  const banner =
    state.firstRun && !configured
      ? `<div class="callout info">首次使用：请先设置骑手参数（FTP / 最大心率 / 体重），它们是所有派生指标准确性的前提。保存后存入训练库，之后可随时回到本页调整。</div>`
      : "";
  app.innerHTML = `
    <div class="view-title"><h1>设置</h1><span class="sub">骑手参数保存在训练库中，分析新文件时自动生效</span></div>
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
      <div style="margin-top:16px;display:flex;gap:12px;align-items:center">
        <button class="btn" id="btnSaveAthlete"><span>保存</span></button>
        <span class="muted" id="athleteSaved" style="display:none">已保存 ✓ 后续分析将使用新参数</span>
      </div>
      <p class="muted" style="margin-top:16px;font-size:12px">
        说明：修改参数只影响之后分析的训练；已归档训练的指标按当时口径保留。
        分区定义与算法阈值（间歇/爬坡识别等）仍在 settings.js 中调整。
      </p>
    </div>`;
  $("#btnSaveAthlete").addEventListener("click", async () => {
    const btn = $("#btnSaveAthlete");
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
      state.firstRun = false;
      state.overview = null; // 概览缓存作废，下次加载取新参数
      renderAthleteChip(r.athlete);
      $("#athleteSaved").style.display = "";
    } catch (e) {
      alert(`保存失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------- 路由 ----------------

function setActiveTab(view) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view));
}

async function route() {
  const hash = location.hash || "#/dashboard";
  const [, view, arg] = hash.split("/");
  try {
    // 首次使用且未配置骑手参数：落到设置页引导（用户可手动切走，不强制锁定）
    if (state.firstRun && (!view || view === "dashboard")) {
      setActiveTab("settings");
      await renderSettings();
      return;
    }
    if (view === "activities") { setActiveTab("activities"); await renderActivities(); }
    else if (view === "activity" && arg) { setActiveTab("activities"); await renderActivityDetail(decodeURIComponent(arg)); }
    else if (view === "upload") { setActiveTab("upload"); renderUpload(); }
    else if (view === "ai") { setActiveTab("ai"); await renderAI(); }
    else if (view === "settings") { setActiveTab("settings"); await renderSettings(); }
    else { setActiveTab("dashboard"); await renderDashboard(); }
  } catch (e) {
    app.innerHTML = `<div class="callout">加载失败：${esc(e.message)}</div>`;
  }
}

$("#tabs").addEventListener("click", (e) => {
  const v = e.target.closest(".tab")?.dataset.view;
  if (v) location.hash = `#/${v}`;
});
window.addEventListener("hashchange", route);

// 启动：拉概览填顶栏骑手参数；未配置过骑手参数时首开引导到设置页，再进路由
loadOverview()
  .then((ov) => {
    renderAthleteChip(ov.athlete);
    if (!ov.athlete_configured) state.firstRun = true;
  })
  .catch(() => {})
  .finally(route);
