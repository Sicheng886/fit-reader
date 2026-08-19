/**
 * views/upload.js — 上传分析（拖拽/选择 FIT → 分析入库）
 */

import { $, app, esc, api, state } from "../common.js";
import { t } from "../i18n.js";

export function renderUpload() {
  app.innerHTML = `
    <div class="view-title"><h1>${esc(t("up.title"))}</h1><span class="sub">${esc(t("up.sub"))}</span></div>
    <div class="dropzone" id="dz">
      <div class="dz-icon">▲</div>
      <div class="dz-main">${esc(t("up.drop"))}</div>
      <div class="dz-sub">${esc(t("up.drop_sub"))}</div>
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
      statusEl.textContent = t("up.skipped", { name: f.name });
      continue;
    }
    statusEl.className = "upload-status loading";
    statusEl.textContent = t("up.analyzing", { name: f.name });
    try {
      const buf = await f.arrayBuffer();
      const r = await api(`/api/upload?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      const s = r.summary;
      statusEl.className = "upload-status ok";
      statusEl.innerHTML = `${esc(t("up.done", { name: f.name, np: s.power?.normalized_power ?? "-", tss: s.power?.tss ?? "-" }))}　<a href="#/activity/${encodeURIComponent(r.file_name)}" style="color:var(--volt)">${esc(t("up.view"))}</a>`;
      state.overview = null; // 让概览下次重新拉取
    } catch (e) {
      statusEl.className = "upload-status err";
      statusEl.textContent = t("up.failed", { name: f.name, msg: e.message });
    }
  }
}
