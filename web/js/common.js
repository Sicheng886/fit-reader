/**
 * common.js — 前端共享基础（零依赖原生 ES Module）
 * DOM 查询 / HTML 转义 / API 封装 / 弹窗 / 格式化 / 徽章标签常量 /
 * 全局状态与概览缓存 / 顶栏骑手参数条 / 训练列表行（dashboard 与 activities 共用）。
 */

export const $ = (sel, el = document) => el.querySelector(sel);
export const app = $("#app");

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function api(path, opts) {
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

/** 通用弹窗：标题 + HTML 内容，点击遮罩或 × 关闭 */
export function showModal(title, bodyHtml) {
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

/** 确认弹窗（删除对话等破坏性操作用），点确认按钮才执行 onOk */
export function confirmModal(title, text, onOk) {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">${esc(title)}</div>
        <button class="modal-close" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <p style="margin:0 0 16px">${esc(text)}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn ghost" data-act="cancel"><span>取消</span></button>
          <button class="btn" data-act="ok"><span>删除</span></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector(".modal-close").addEventListener("click", close);
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  el.querySelector('[data-act="cancel"]').addEventListener("click", close);
  el.querySelector('[data-act="ok"]').addEventListener("click", async () => {
    close();
    await onOk();
  });
}

const SPORT_LABEL = { cycling: "骑行", running: "跑步", swimming: "游泳" };
export const sportLabel = (s) => SPORT_LABEL[s] || s || "未知";
export const sportBadge = (s) =>
  `<span class="sport-badge ${esc(s)}">${sportLabel(s)}</span>`;

export const CATEGORY_LABEL = {
  training: "训练",
  race: "比赛",
  recovery: "恢复",
  leisure: "休闲",
};
export const categoryLabel = (c) => CATEGORY_LABEL[c] ?? c ?? "训练";
export const categoryBadge = (c) => {
  const key = c || "training";
  const cls = `cat-badge cat-${esc(key)}`;
  return `<span class="${cls}">${esc(categoryLabel(key))}</span>`;
};

export function fmtDur(sec) {
  if (sec == null) return "-";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
export const fmtXAxis = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`;
};
export const num = (v, d = 0) =>
  v == null ? "-" : Number(v).toFixed(d).replace(/\.0+$/, d === 0 ? "" : "");
export const trunc = (s, n = 30) =>
  s == null ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s;

/** 将 SQLite UTC 时间字符串（YYYY-MM-DD HH:MM:SS）转换为本地时区显示 */
export function fmtLocalDateTime(utcStr) {
  if (!utcStr) return "-";
  const d = new Date(`${utcStr}Z`);
  if (Number.isNaN(d.getTime())) return utcStr;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

// 分区配色（运动风渐变：灰→蓝→绿→荧光黄→橙→红）
export const ZONE_COLORS = {
  Z1: "#5b6670", Z2: "#4aa3ff", Z3: "#3ddc97", Z4: "#d7ff3f",
  Z5: "#ffb03f", Z6: "#ff7a45", Z7: "#ff5d73",
};

export const MODE_LABEL = { review: "单次复盘", plan: "周期规划", taper: "赛前减量", compare: "两次对比" };

// AI 记忆的分类与来源场景中文名（记忆页列表用）
export const MEM_CATEGORY_LABEL = {
  general: "通用",
  injury: "伤病",
  schedule: "日程",
  goal: "目标",
  preference: "偏好",
};
export const MEM_SOURCE_LABEL = {
  review: "复盘",
  plan: "规划",
  taper: "赛前",
  compare: "对比",
  follow_up: "追问",
  chat: "对话",
};

// TSB 状态简评（与 db.js formNote 同口径）
export function formNote(tsb) {
  if (tsb >= 15) return "状态很新鲜，适合比赛或高强度测试";
  if (tsb >= 5) return "状态良好，恢复充分";
  if (tsb >= -10) return "负荷与恢复平衡，可持续训练";
  if (tsb >= -20) return "疲劳积累期，注意睡眠与恢复";
  return "过度疲劳风险，建议安排减量周";
}

// ---------------- 全局状态 ----------------

export const state = {
  overview: null, // /api/overview 缓存
  chartToggles: {}, // 详情页时序图系列开关
  firstRun: false, // 训练库未配置骑手参数（首开引导到设置页）
  aiThread: null, // 当前 AI 报告追问上下文 { file_name, report_id, chat_id }
  chatState: { chatId: null, pollTimer: null }, // 对话页：当前对话 id + 轮询定时器
};

export async function loadOverview(force = false) {
  if (!state.overview || force) state.overview = await api("/api/overview");
  return state.overview;
}

/** 顶栏骑手参数条（启动 / 保存设置 / 采纳 FTP 三处共用） */
export function renderAthleteChip(a) {
  a = a || {};
  $("#athleteChip").innerHTML = `FTP <b>${a.ftp_watts ?? "?"}W</b> · HRmax <b>${a.max_hr ?? "?"}</b> · <b>${a.weight_kg ?? "?"}kg</b>`;
}

/** 训练列表行（概览「最近训练」与训练列表页共用） */
export function actRowHtml(a) {
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
