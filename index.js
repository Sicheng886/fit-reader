/**
 * index.js (ESM)
 * 解析 Garmin/码表 .fit 文件 → 输出：
 *   1. records.csv   逐秒时序明细（供程序化分析/存档）
 *   2. summary.json  汇总指标（直接喂给 AI 做训练分析）
 *
 * 用法：
 *   npm install
 *   node index.js <输入.fit> [输出目录]
 */

import fs from "node:fs";
import path from "node:path";
import FitParser from "fit-file-parser";

// ============ 骑手参数（改成你自己的，算不准的分析就没意义） ============
const ATHLETE = {
  ftp_watts: 119, // 功能阈值功率
  max_hr: 195, // 最大心率
  weight_kg: 60,
};

// ============ 功率分区（Coggan 7 区，按 FTP 百分比） ============
const POWER_ZONES = [
  { name: "Z1", min: 0.0, max: 0.55 },
  { name: "Z2", min: 0.55, max: 0.75 },
  { name: "Z3", min: 0.75, max: 0.9 },
  { name: "Z4", min: 0.9, max: 1.05 },
  { name: "Z5", min: 1.05, max: 1.2 },
  { name: "Z6", min: 1.2, max: 1.5 },
  { name: "Z7", min: 1.5, max: Infinity },
];

// ============ 心率分区（按最大心率百分比） ============
const HR_ZONES = [
  { name: "Z1", min: 0.0, max: 0.68 },
  { name: "Z2", min: 0.68, max: 0.75 },
  { name: "Z3", min: 0.75, max: 0.85 },
  { name: "Z4", min: 0.85, max: 0.92 },
  { name: "Z5", min: 0.92, max: Infinity },
];

// ---------------- 工具函数 ----------------

function zoneOf(value, zones, base) {
  const r = value / base;
  for (const z of zones) if (r >= z.min && r < z.max) return z.name;
  return null;
}

function zoneDistribution(values, zones, base) {
  const counts = Object.fromEntries(zones.map((z) => [z.name, 0]));
  let total = 0;
  for (const v of values) {
    if (v == null) continue;
    const z = zoneOf(v, zones, base);
    if (z) {
      counts[z]++;
      total++;
    }
  }
  if (!total) return null;
  const pct = {};
  for (const k of Object.keys(counts))
    pct[k] = Math.round((counts[k] / total) * 1000) / 10;
  return pct;
}

/** 30s 滚动平均的四次方均根（Normalized Power），要求窗口内数据连续 */
function normalizedPower(powers) {
  const W = 30;
  if (powers.length < W) return null;
  let sum = 0,
    valid = 0;
  const fourthSum = [];
  for (let i = 0; i < powers.length; i++) {
    const v = powers[i];
    sum += v == null ? 0 : v;
    valid += v == null ? 0 : 1;
    if (i >= W) {
      const old = powers[i - W];
      sum -= old == null ? 0 : old;
      valid -= old == null ? 0 : 1;
    }
    if (i >= W - 1) fourthSum.push(valid === W ? Math.pow(sum / W, 4) : null);
  }
  const ok = fourthSum.filter((x) => x != null);
  if (!ok.length) return null;
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  return Math.round(Math.pow(mean, 0.25));
}

/** 指定时长（秒）的最大平均功率 */
function peakAvg(powers, windowSec) {
  if (powers.length < windowSec) return null;
  let sum = 0,
    valid = 0,
    best = null;
  for (let i = 0; i < powers.length; i++) {
    const v = powers[i];
    sum += v == null ? 0 : v;
    valid += v == null ? 0 : 1;
    if (i >= windowSec) {
      const old = powers[i - windowSec];
      sum -= old == null ? 0 : old;
      valid -= old == null ? 0 : 1;
    }
    if (i >= windowSec - 1 && valid === windowSec) {
      const avg = sum / windowSec;
      if (best == null || avg > best) best = avg;
    }
  }
  return best == null ? null : Math.round(best);
}

/** 心率漂移（有氧解耦）：前后半程 效率因子(功率/心率) 的相对变化，% */
function hrDriftPct(records) {
  const half = Math.floor(records.length / 2);
  const ef = (recs) => {
    const ps = recs.map((r) => r.power).filter((v) => v != null);
    const hs = recs.map((r) => r.heart_rate).filter((v) => v != null);
    if (ps.length < 60 || hs.length < 60) return null;
    const avgP = ps.reduce((a, b) => a + b, 0) / ps.length;
    const avgH = hs.reduce((a, b) => a + b, 0) / hs.length;
    return avgP / avgH;
  };
  const e1 = ef(records.slice(0, half));
  const e2 = ef(records.slice(half));
  if (e1 == null || e2 == null || e1 === 0) return null;
  return Math.round(((e1 - e2) / e1) * 1000) / 10;
}

/** 检测功率连续缺失 > gapSec 的片段 */
function findPowerGaps(records, gapSec = 60) {
  const gaps = [];
  let start = null;
  for (let i = 0; i < records.length; i++) {
    if (records[i].power == null) {
      if (start == null) start = i;
    } else if (start != null) {
      if (i - start >= gapSec) {
        gaps.push({ start: records[start].timestamp, duration_sec: i - start });
      }
      start = null;
    }
  }
  return gaps;
}

/** 累计爬升（带 1m 阈值去抖） */
function elevationGain(alts) {
  let gain = 0,
    last = null,
    pending = 0;
  for (const a of alts) {
    if (a == null) continue;
    if (last == null) {
      last = a;
      continue;
    }
    const d = a - last;
    if (d > 0) {
      pending += d;
      if (pending >= 1) {
        gain += pending;
        last = a;
        pending = 0;
      }
    } else {
      last = a;
      pending = 0;
    }
  }
  return Math.round(gain);
}

// ---------------- 主流程 ----------------

async function main() {
  const input = process.argv[2];
  const outDir = process.argv[3] || path.dirname(path.resolve(input));
  if (!input || !fs.existsSync(input)) {
    console.error("用法: node index.js <输入.fit> [输出目录]");
    process.exit(1);
  }

  const content = fs.readFileSync(input);
  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    lengthUnit: "km",
    mode: "list",
  });

  const data = await new Promise((resolve, reject) =>
    parser.parse(content, (err, d) => (err ? reject(err) : resolve(d))),
  );

  // ---- 1. 整理逐秒记录（重采样到 1s 网格，缺口置 null） ----
  const raw = (data.records || []).filter((r) => r.timestamp);
  if (!raw.length) throw new Error("FIT 中没有 record 数据");
  raw.sort((a, b) => a.timestamp - b.timestamp);

  const t0 = Math.floor(raw[0].timestamp.getTime() / 1000);
  const t1 = Math.floor(raw[raw.length - 1].timestamp.getTime() / 1000);
  const bySec = new Map();
  for (const r of raw) bySec.set(Math.floor(r.timestamp.getTime() / 1000), r);

  const records = [];
  for (let t = t0; t <= t1; t++) {
    const r = bySec.get(t);
    records.push({
      timestamp: new Date(t * 1000).toISOString(),
      power: r?.power ?? null,
      heart_rate: r?.heart_rate ?? null,
      cadence: r?.cadence ?? null,
      altitude: r?.altitude != null ? Math.round(r.altitude * 10) / 10 : null,
      speed: r?.speed != null ? Math.round(r.speed * 100) / 100 : null,
      distance: r?.distance != null ? Math.round(r.distance * 1000) : null, // 米
    });
  }

  // ---- 2. 写 CSV ----
  const base = path.basename(input, path.extname(input));
  const csvPath = path.join(outDir, `${base}.records.csv`);
  const header =
    "timestamp,power,heart_rate,cadence,altitude,speed,distance_m\n";
  const lines = records.map((r) =>
    [
      r.timestamp,
      r.power,
      r.heart_rate,
      r.cadence,
      r.altitude,
      r.speed,
      r.distance,
    ]
      .map((v) => (v == null ? "" : v))
      .join(","),
  );
  fs.writeFileSync(csvPath, header + lines.join("\n"));

  // ---- 3. 计算指标 ----
  const powers = records.map((r) => r.power);
  const hrs = records.map((r) => r.heart_rate);
  const cads = records.map((r) => r.cadence);
  const alts = records.map((r) => r.altitude);

  const avg = (arr) => {
    const v = arr.filter((x) => x != null);
    return v.length
      ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
      : null;
  };
  const max = (arr) => {
    const v = arr.filter((x) => x != null);
    return v.length ? Math.round(Math.max(...v)) : null;
  };

  const avgPower = avg(powers);
  const np = normalizedPower(powers);
  const durationSec = records.length;
  const ifactor =
    np && ATHLETE.ftp_watts
      ? Math.round((np / ATHLETE.ftp_watts) * 100) / 100
      : null;
  const tss =
    np && ifactor
      ? Math.round(
          ((durationSec * np * ifactor) / (ATHLETE.ftp_watts * 3600)) * 100,
        )
      : null;

  const distances = records.map((r) => r.distance).filter((v) => v != null);
  const distanceKm = distances.length
    ? Math.round(
        ((Math.max(...distances) - Math.min(...distances)) / 1000) * 100,
      ) / 100
    : null;

  // 功率峰曲线
  const peakCurve = {};
  for (const [label, sec] of [
    ["5s", 5],
    ["1min", 60],
    ["5min", 300],
    ["20min", 1200],
  ]) {
    const p = peakAvg(powers, sec);
    if (p != null) peakCurve[label] = p;
  }

  // 功率缺失片段 → 异常标注
  const anomalies = [];
  for (const g of findPowerGaps(records)) {
    anomalies.push(`功率缺失 ${g.duration_sec}s，起始 ${g.start}`);
  }
  // 心率跳变检测（相邻秒差 > 25）
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1].heart_rate,
      b = records[i].heart_rate;
    if (a != null && b != null && Math.abs(b - a) > 25) {
      anomalies.push(`心率跳变 ${a}→${b}，位于 ${records[i].timestamp}`);
      if (anomalies.length > 20) break;
    }
  }

  // 圈/赛段
  const segments = (data.laps || [])
    .map((lap, i) => {
      const s = {
        name: lap.name || `lap_${i + 1}`,
        duration_sec:
          lap.total_elapsed_time != null
            ? Math.round(lap.total_elapsed_time)
            : undefined,
        avg_power: lap.avg_power,
        max_power: lap.max_power,
        avg_hr: lap.avg_heart_rate,
        avg_cadence: lap.avg_cadence,
        distance_km:
          lap.total_distance != null
            ? Math.round(lap.total_distance * 100) / 100
            : undefined,
        elevation_gain_m: lap.total_ascent,
      };
      Object.keys(s).forEach((k) => s[k] === undefined && delete s[k]);
      return s;
    })
    .filter((s) => Object.keys(s).length > 1);

  // ---- 4. 汇总 JSON ----
  const summary = {
    activity: {
      date: records[0].timestamp.slice(0, 10),
      sport: data.sport?.sport || data.sessions?.[0]?.sport || "unknown",
      duration_sec: durationSec,
      distance_km: distanceKm,
      elevation_gain_m: elevationGain(alts),
    },
    athlete_context: { ...ATHLETE },
    power: {
      avg: avgPower,
      normalized_power: np,
      max: max(powers),
      variability_index:
        np && avgPower ? Math.round((np / avgPower) * 100) / 100 : null,
      intensity_factor: ifactor,
      tss,
      w_per_kg_avg: avgPower
        ? Math.round((avgPower / ATHLETE.weight_kg) * 100) / 100
        : null,
      peak_curve: peakCurve,
      zone_distribution_pct: zoneDistribution(
        powers,
        POWER_ZONES,
        ATHLETE.ftp_watts,
      ),
    },
    heart_rate: {
      avg: avg(hrs),
      max: max(hrs),
      zone_distribution_pct: zoneDistribution(hrs, HR_ZONES, ATHLETE.max_hr),
      hr_drift_pct: hrDriftPct(records),
    },
    cadence: { avg: avg(cads) },
    segments: segments.length ? segments : undefined,
    anomalies: anomalies.length ? anomalies : undefined,
    data_quality: {
      power_coverage_pct: Math.round(
        (powers.filter((v) => v != null).length / durationSec) * 100,
      ),
      hr_coverage_pct: Math.round(
        (hrs.filter((v) => v != null).length / durationSec) * 100,
      ),
    },
  };
  Object.keys(summary).forEach(
    (k) => summary[k] === undefined && delete summary[k],
  );

  const jsonPath = path.join(outDir, `${base}.summary.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  console.log("完成:");
  console.log("  时序 CSV :", csvPath);
  console.log("  汇总 JSON:", jsonPath);
  console.log("\n汇总预览:");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("解析失败:", e.message);
  process.exit(1);
});
