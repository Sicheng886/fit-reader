/**
 * common.js — 前端共享基础（零依赖原生 ES Module）
 * DOM 查询 / HTML 转义 / API 封装（自动带 X-Lang 头）/ 弹窗 / 格式化 / 徽章标签 /
 * 全局状态与概览缓存 / 顶栏骑手参数条 / 训练列表行（dashboard 与 activities 共用）。
 * 用户可见文案统一走 i18n.js 词典（t()），语言见 state.lang。
 */

import { t, getLang, sportLabel, categoryLabel } from "./i18n.js";

export const $ = (sel, el = document) => el.querySelector(sel);
export const app = $("#app");

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function api(path, opts) {
  const headers = { ...(opts?.headers || {}), "X-Lang": getLang() };
  const resp = await fetch(path, { ...opts, headers });
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
        <button class="modal-close" aria-label="${esc(t("common.close"))}">×</button>
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
        <button class="modal-close" aria-label="${esc(t("common.close"))}">×</button>
      </div>
      <div class="modal-body">
        <p style="margin:0 0 16px">${esc(text)}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn ghost" data-act="cancel"><span>${esc(t("common.cancel"))}</span></button>
          <button class="btn" data-act="ok"><span>${esc(t("common.delete"))}</span></button>
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

export const sportBadge = (s) =>
  `<span class="sport-badge ${esc(s)}">${sportLabel(s)}</span>`;

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

/** 将 SQLite UTC 时间字符串（YYYY-MM-DD HH:MM:SS）转换为本地时区显示（按界面语言选 locale） */
export function fmtLocalDateTime(utcStr) {
  if (!utcStr) return "-";
  const d = new Date(`${utcStr}Z`);
  if (Number.isNaN(d.getTime())) return utcStr;
  return d.toLocaleString(getLang() === "en" ? "en-US" : "zh-CN", {
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

// ---------------- 全局状态 ----------------

export const state = {
  lang: "zh", // 界面语言（app.js 启动时经 i18n.setLang 设置）
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
  $("#athleteChip").innerHTML = t("chip.ftp_hr_w", {
    ftp: a.ftp_watts ?? "?",
    hr: a.max_hr ?? "?",
    w: a.weight_kg ?? "?",
  });
}

/** 训练列表行（概览「最近训练」与训练列表页共用） */
export function actRowHtml(a) {
  return `<a class="act-row" href="#/activity/${encodeURIComponent(a.file_name)}">
    <span class="act-date">${esc(a.date)}</span>
    <span class="act-name">${sportBadge(a.sport)}${categoryBadge(a.category)}${esc(a.file_name)}</span>
    <span class="act-stats">
      <span class="act-stat"><span class="v">${fmtDur(a.duration_sec)}</span><br><span class="k">${esc(t("act.duration"))}</span></span>
      <span class="act-stat"><span class="v">${num(a.distance_km, 1)}</span><br><span class="k">km</span></span>
      <span class="act-stat"><span class="v">${a.np ?? "-"}</span><br><span class="k">NP</span></span>
      <span class="act-stat"><span class="v">${num(a.intensity_factor, 2)}</span><br><span class="k">IF</span></span>
      <span class="act-stat"><span class="v" style="color:var(--volt)">${a.tss ?? "-"}</span><br><span class="k">TSS</span></span>
    </span>
  </a>`;
}
