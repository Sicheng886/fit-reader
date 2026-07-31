/**
 * app.js — fit-reader Web 前端入口（P4）
 * 零依赖 SPA（浏览器原生 ES Module，无构建步骤）：hash 路由 + 顶栏导航 + 首开引导。
 * 共享基础在 js/common.js，SVG 图表在 js/charts.js，AI 报告/对话机制在 js/ai.js，
 * 各视图在 js/views/ 下（概览/训练/详情/上传/AI 报告/对话/记忆/设置）。
 */

import { $, app, esc, state, loadOverview, renderAthleteChip } from "./js/common.js";
import { stopChatPolling } from "./js/ai.js";
import { renderDashboard } from "./js/views/dashboard.js";
import { renderActivities, renderActivityDetail } from "./js/views/activities.js";
import { renderUpload } from "./js/views/upload.js";
import { renderAI } from "./js/views/ai.js";
import { renderChat } from "./js/views/chat.js";
import { renderSettings } from "./js/views/settings.js";
import { renderMemory } from "./js/views/memory.js";
import { renderAbout } from "./js/views/about.js";

// ---------------- 路由 ----------------

function setActiveTab(view) {
  document.querySelectorAll(".tab[data-view]").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view));
  // 记忆/设置/关于都属于三点菜单，保持菜单按钮高亮
  document.querySelector(".tab.menu-trigger")?.classList.toggle(
    "active",
    view === "memory" || view === "settings" || view === "about",
  );
}

function toggleMenu(show) {
  const menu = $("#settingsMenu .tab-menu");
  const trigger = $("#settingsMenu .menu-trigger");
  if (!menu || !trigger) return;
  menu.classList.toggle("open", show);
  trigger.setAttribute("aria-expanded", String(show));
}

// 点击三点菜单外部自动收起
document.addEventListener("click", (e) => {
  if (!e.target.closest("#settingsMenu")) toggleMenu(false);
});

async function route() {
  stopChatPolling(); // 切换视图即停止对话轮询（hashchange 触发 route）
  toggleMenu(false); // 路由切换时收起三点菜单
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
    else if (view === "chat") { setActiveTab("chat"); await renderChat(arg ? Number(arg) : null); }
    else if (view === "memory") { setActiveTab("memory"); await renderMemory(); }
    else if (view === "settings") { setActiveTab("settings"); await renderSettings(); }
    else if (view === "about") { setActiveTab("about"); renderAbout(); }
    else { setActiveTab("dashboard"); await renderDashboard(); }
  } catch (e) {
    app.innerHTML = `<div class="callout">加载失败：${esc(e.message)}</div>`;
  }
}

$("#tabs").addEventListener("click", (e) => {
  const trigger = e.target.closest(".menu-trigger");
  if (trigger) {
    e.preventDefault();
    const menu = $("#settingsMenu .tab-menu");
    toggleMenu(!menu.classList.contains("open"));
    return;
  }
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
