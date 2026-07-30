/**
 * charts.js — 手写 SVG 图表（零依赖）
 * 多系列折线图 / CTL-ATL-TSB 趋势图 / 分区分布横条 / 峰功率曲线柱。
 */

import { fmtXAxis, num } from "./common.js";

/**
 * 通用多系列折线图（各系列独立纵轴缩放，图例显示均值）。
 * 对可见序列做简单的中心移动平均平滑，减少采样抖动，让曲线更简洁。
 * series: [{ name, color, unit, points: [y|null...], x0: 起始时间戳秒, step: 秒/点 }]
 */
export function drawLineChart(container, series, { height = 280 } = {}) {
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
export function drawTrendChart(container, daily, { height = 300 } = {}) {
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

/**
 * 分区分布横条：左区名，中间条形（百分比跟在填充右侧；填充接近 100% 时改放填充色上方），
 * 右侧该区具体范围（ranges: { Z1: "0-72", ... }，由服务端按骑手参数换算）
 */
export function zoneBarsHtml(dist, colors, ranges) {
  if (!dist) return `<div class="empty">无分区数据</div>`;
  return `<div class="zone-bars">${Object.entries(dist)
    .map(([z, pct]) => {
      const c = colors[z] || "#888";
      const label =
        pct >= 85
          ? `<span class="z-pct z-pct-on" style="width:${pct}%">${num(pct, 1)}%</span>`
          : `<span class="z-pct z-pct-after" style="left:calc(${pct}% + 6px)">${num(pct, 1)}%</span>`;
      return `<div class="zone-row">
        <span class="z-name">${z}</span>
        <div class="z-track"><div class="z-fill" style="width:${pct}%;background:${c}"></div>${label}</div>
        <span class="z-range">${ranges?.[z] ?? ""}</span>
      </div>`;
    })
    .join("")}</div>`;
}

/** 峰功率曲线柱 */
export function peakCurveHtml(curve, ftp) {
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
