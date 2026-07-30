/**
 * views/upload.js — 上传分析（拖拽/选择 FIT → 分析入库）
 */

import { $, app, esc, api, state } from "../common.js";

export function renderUpload() {
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
