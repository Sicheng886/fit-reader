/**
 * records.js
 * records CSV 读取与文件名安全化（供 server.js 的 /api/records 与 tools.js 的
 * get_activity_records 工具复用；从 server.js 抽出，outputDir 改为显式参数）。
 */

import fs from "node:fs";
import path from "node:path";

/** 文件名安全化：只取 basename，防止路径穿越 */
export function safeName(name) {
  if (!name || typeof name !== "string") return null;
  const base = path.basename(name);
  return base === name && !base.includes("..") ? base : null;
}

/**
 * 解析 records CSV → 抽稀后的时序数组（null 表示缺口）。
 * startSec / endSec 为相对训练开始的秒数时间窗（先截取再抽稀），
 * 供 AI 工具只取片段（如"最后 10 分钟功率"）而不必取全程。
 *
 * @param {string} fileName 训练文件名（.fit 或裸名均可）
 * @param {{ outputDir: string, maxPoints?: number, startSec?: number, endSec?: number }} opts
 * @returns {{ points: Array, total_seconds: number, stride: number } | null} 文件不存在返回 null
 */
export function loadRecords(
  fileName,
  { outputDir, maxPoints = 1400, startSec, endSec } = {},
) {
  const base = path.basename(fileName, path.extname(fileName));
  const csvPath = path.join(outputDir, `${base}.records.csv`);
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  let rows = lines.slice(1); // 跳过表头

  // 时间窗截取：按首行时间戳为 0 点计算每行相对秒数
  const hasWindow = startSec != null || endSec != null;
  if (hasWindow && rows.length) {
    const t0 = Date.parse(rows[0].split(",")[0]);
    if (Number.isFinite(t0)) {
      rows = rows.filter((row) => {
        const sec = (Date.parse(row.split(",")[0]) - t0) / 1000;
        if (!Number.isFinite(sec)) return false;
        if (startSec != null && sec < startSec) return false;
        if (endSec != null && sec > endSec) return false;
        return true;
      });
    }
  }

  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const num = (s) => (s === "" || s == null ? null : Number(s));
  const out = [];
  for (let i = 0; i < rows.length; i += stride) {
    const c = rows[i].split(",");
    out.push({
      t: c[0],
      power: num(c[1]),
      heart_rate: num(c[2]),
      cadence: num(c[3]),
      altitude: num(c[4]),
      speed: num(c[5]),
      distance_m: num(c[6]),
      // 旧版 CSV 没有温度列，c[7] 为 undefined 时归一为 null（避免 NaN 进图表）
      temperature: num(c[7]),
    });
  }
  return { points: out, total_seconds: rows.length, stride };
}
