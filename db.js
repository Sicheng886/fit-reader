/**
 * db.js
 * 训练库（SQLite，node:sqlite 内置模块，零第三方依赖）：
 *   - 每次分析后把 summary 入库（按文件名去重，重复分析覆盖更新）
 *   - 基于历史 TSS 计算 CTL / ATL / TSB（体能/疲劳/状态）
 *   - 月汇总、趋势数据与提示词上下文查询（recentActivities / recentFormDaily）
 *
 * 数据库文件固定为 ./db/fitness.db，不存在时自动创建。
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_DIR = path.resolve("db");
const DB_PATH = path.join(DB_DIR, "fitness.db");

let _db = null;

/** 懒打开数据库：目录/文件/表不存在时自动创建 */
function openDb() {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      sport TEXT,
      duration_sec INTEGER,
      distance_km REAL,
      elevation_gain_m REAL,
      tss REAL,
      np REAL,
      avg_power REAL,
      intensity_factor REAL,
      summary_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);
  `);
  return _db;
}

/** 分析结果入库：同一文件名重复分析时覆盖更新 */
export function upsertActivity(fileName, summary) {
  const db = openDb();
  const a = summary.activity;
  const p = summary.power;
  db.prepare(
    `INSERT INTO activities
       (file_name, date, sport, duration_sec, distance_km, elevation_gain_m,
        tss, np, avg_power, intensity_factor, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_name) DO UPDATE SET
       date = excluded.date,
       sport = excluded.sport,
       duration_sec = excluded.duration_sec,
       distance_km = excluded.distance_km,
       elevation_gain_m = excluded.elevation_gain_m,
       tss = excluded.tss,
       np = excluded.np,
       avg_power = excluded.avg_power,
       intensity_factor = excluded.intensity_factor,
       summary_json = excluded.summary_json`,
  ).run(
    fileName,
    a.date,
    a.sport ?? null,
    a.duration_sec ?? null,
    a.distance_km ?? null,
    a.elevation_gain_m ?? null,
    p.tss ?? null,
    p.normalized_power ?? null,
    p.avg ?? null,
    p.intensity_factor ?? null,
    JSON.stringify(summary),
  );
}

/** 取出 [起始, endDate] 范围内逐日 TSS（按天聚合，缺天补 0）→ [{ date, tss }] */
function dailyTssSeries(endDate) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, SUM(COALESCE(tss, 0)) AS tss
       FROM activities WHERE date <= ? GROUP BY date ORDER BY date`,
    )
    .all(endDate);
  if (!rows.length) return [];
  // 补齐缺天（TSS = 0，休息日同样参与 CTL/ATL 衰减）
  const series = [];
  const byDate = new Map(rows.map((r) => [r.date, r.tss]));
  const cur = new Date(rows[0].date + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    series.push({ date: d, tss: byDate.get(d) ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return series;
}

/**
 * CTL / ATL / TSB（指数加权，口径与 TrainingPeaks 一致）：
 *   CTL_d = CTL_{d-1} + (TSS_d − CTL_{d-1}) / 42   慢性负荷（体能）
 *   ATL_d = ATL_{d-1} + (TSS_d − ATL_{d-1}) / 7    急性负荷（疲劳）
 *   TSB   = CTL − ATL                              状态（正值=新鲜）
 * 初始值 0，计算到 date 当天（含）。
 */
export function computeForm(date) {
  const series = dailyTssSeries(date);
  if (!series.length) return null;
  let ctl = 0,
    atl = 0;
  for (const d of series) {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
  }
  const tsb = ctl - atl;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    ctl: r1(ctl),
    atl: r1(atl),
    tsb: r1(tsb),
    form_note: formNote(tsb),
  };
}

/**
 * 最近 N 天逐日负荷序列：[{ date, tss, ctl, atl, tsb }]。
 * 与 computeForm 同一递推口径，供周期规划/赛前调整提示词取走势数据。
 */
export function recentFormDaily(days = 56) {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  const series = dailyTssSeries(row.d);
  let ctl = 0,
    atl = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const daily = series.map((d) => {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    return { date: d.date, tss: r1(d.tss), ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) };
  });
  return daily.slice(-days);
}

/** 最近 n 条训练简明清单（供提示词上下文，按日期倒序） */
export function recentActivities(n = 10) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, duration_sec, distance_km, tss, np, intensity_factor
       FROM activities ORDER BY date DESC LIMIT ?`,
    )
    .all(n);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    date: r.date,
    duration_min: r.duration_sec == null ? null : Math.round(r.duration_sec / 60),
    distance_km: r1(r.distance_km),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    intensity_factor: r.intensity_factor == null ? null : r1(r.intensity_factor),
  }));
}

/** TSB 中文简评（供 athlete_context / AI 参考） */
function formNote(tsb) {
  if (tsb >= 15) return "状态很新鲜，适合比赛或高强度测试";
  if (tsb >= 5) return "状态良好，恢复充分";
  if (tsb >= -10) return "负荷与恢复平衡，可持续训练";
  if (tsb >= -20) return "疲劳积累期，注意睡眠与恢复";
  return "过度疲劳风险，建议安排减量周";
}

/**
 * 最近 n 个月汇总（按自然月）：
 * 月 TSS / 时长 / 距离 / 次数，以及 低(Z1-Z2)/中(Z3-Z4)/高(Z5-Z7) 强度时间占比与类型判读。
 */
export function monthlySummary(n = 6) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, duration_sec, distance_km, tss, summary_json
       FROM activities ORDER BY date DESC`,
    )
    .all();

  const months = new Map();
  for (const r of rows) {
    const m = r.date.slice(0, 7); // YYYY-MM
    if (!months.has(m)) {
      months.set(m, {
        month: m,
        tss: 0,
        duration_sec: 0,
        distance_km: 0,
        count: 0,
        low: 0, // 各区加权秒数
        mid: 0,
        high: 0,
      });
    }
    const agg = months.get(m);
    const dur = r.duration_sec ?? 0;
    agg.tss += r.tss ?? 0;
    agg.duration_sec += dur;
    agg.distance_km += r.distance_km ?? 0;
    agg.count += 1;
    // 强度分布：zone_distribution_pct × 时长 加权累计
    try {
      const z = JSON.parse(r.summary_json).power?.zone_distribution_pct;
      if (z && dur > 0) {
        agg.low += ((z.Z1 ?? 0) + (z.Z2 ?? 0)) * 0.01 * dur;
        agg.mid += ((z.Z3 ?? 0) + (z.Z4 ?? 0)) * 0.01 * dur;
        agg.high += ((z.Z5 ?? 0) + (z.Z6 ?? 0) + (z.Z7 ?? 0)) * 0.01 * dur;
      }
    } catch {
      // 存档 JSON 损坏时跳过强度分布，不影响其他字段
    }
  }

  const result = [...months.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, n)
    .map((w) => {
      const zoneTotal = w.low + w.mid + w.high;
      const pct = (x) =>
        zoneTotal > 0 ? Math.round((x / zoneTotal) * 1000) / 10 : null;
      const lowPct = pct(w.low),
        midPct = pct(w.mid),
        highPct = pct(w.high);
      let intensity_type = null;
      if (lowPct != null) {
        // 极化：大量低强度 + 高强度多于中强度；金字塔：低>中>高；其余归为甜区/阈值取向
        if (lowPct >= 75 && highPct > midPct) intensity_type = "polarized";
        else if (lowPct > midPct && midPct > highPct)
          intensity_type = "pyramidal";
        else intensity_type = "sweet_spot";
      }
      return {
        month: w.month,
        tss: Math.round(w.tss),
        hours: Math.round((w.duration_sec / 3600) * 10) / 10,
        distance_km: Math.round(w.distance_km * 10) / 10,
        sessions: w.count,
        intensity_pct:
          lowPct != null ? { low: lowPct, mid: midPct, high: highPct } : null,
        intensity_type,
      };
    });
  return result;
}

/**
 * 逐月趋势：每月 { month, tss, ctl, atl, tsb }。
 * tss 为当月合计；ctl/atl/tsb 取该月最后一天的值（逐日递推得到，衰减口径不变）。
 */
export function trendMonthly() {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  const series = dailyTssSeries(row.d);
  let ctl = 0,
    atl = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const months = new Map();
  for (const d of series) {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    const m = d.date.slice(0, 7);
    const agg = months.get(m) ?? { month: m, tss: 0 };
    agg.tss += d.tss;
    agg.ctl = r1(ctl); // 遍历按日期升序，月末值自然覆盖
    agg.atl = r1(atl);
    agg.tsb = r1(ctl - atl);
    months.set(m, agg);
  }
  return [...months.values()].map((m) => ({ ...m, tss: r1(m.tss) }));
}
