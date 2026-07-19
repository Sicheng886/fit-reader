/**
 * index.js (ESM)
 * 解析 Garmin/码表 .fit 文件 → 输出：
 *   1. records.csv   逐秒时序明细（供程序化分析/存档）
 *   2. summary.json  汇总指标（直接喂给 AI 做训练分析）
 *
 * 配置（骑手参数/分区/算法阈值）集中在 settings.js。
 *
 * 用法：
 *   npm install
 *   node index.js <输入.fit 或包含 .fit 的目录> [输出目录]
 */

import fs from "node:fs";
import path from "node:path";
import FitParser from "fit-file-parser";
import {
  upsertActivity,
  computeForm,
  monthlySummary,
  trendMonthly,
  recentActivities,
  recentFormDaily,
} from "./db.js";
import {
  buildReviewPrompt,
  buildPlanPrompt,
  buildTaperPrompt,
  buildComparePrompt,
  thinToWeekly,
} from "./prompts.js";
import {
  ATHLETE,
  POWER_ZONES,
  HR_ZONES,
  INTERVAL_DETECTION,
  CLIMB_DETECTION,
  CADENCE_ANALYSIS,
} from "./settings.js";

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

/** 指定时长（秒）的最大平均功率，要求窗口内数据连续 */
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

/** 记录片段某字段的平均值（跳过 null），不足 1 个有效值返回 null */
function avgField(slice, field, digits = 1) {
  const v = slice.map((r) => r[field]).filter((x) => x != null);
  if (!v.length) return null;
  const f = Math.pow(10, digits);
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * f) / f;
}

/** 记录片段某字段的最大值（跳过 null） */
function maxField(slice, field) {
  const v = slice.map((r) => r[field]).filter((x) => x != null);
  return v.length ? Math.round(Math.max(...v)) : null;
}

/** FTP 自动估算：20 分钟峰功率 × 0.95，并与当前配置对比给出建议 */
function estimateFtp(powers) {
  const peak20 = peakAvg(powers, 1200);
  if (peak20 == null) return null; // 时长不足 20 分钟
  const estimated = Math.round(peak20 * 0.95);
  const current = ATHLETE.ftp_watts;
  const diff = estimated - current;
  let suggestion = "keep";
  if (diff > 3) suggestion = "consider_update"; // 估算明显高于当前，建议更新 FTP
  else if (diff < -5) suggestion = "consider_recheck"; // 明显偏低：状态差或本次非全力，不宜直接下调
  return {
    peak_20min_w: peak20,
    estimated_ftp_w: estimated,
    current_ftp_w: current,
    diff_w: diff,
    suggestion,
  };
}

/**
 * 间歇识别：找出功率 ≥ threshold_pct × FTP 的重复工作段。
 * 低于阈值不超过 merge_gap_sec 视为瞬时掉功率（段内合并）；
 * 时长不足 min_duration_sec 的段丢弃。
 */
function detectIntervals(records) {
  const thr = INTERVAL_DETECTION.threshold_pct * ATHLETE.ftp_watts;
  // 1. 原始过阈段 [startIdx, endIdx]
  const rawSegs = [];
  let s = null;
  for (let i = 0; i < records.length; i++) {
    const p = records[i].power;
    if (p != null && p >= thr) {
      if (s == null) s = i;
    } else if (s != null) {
      rawSegs.push([s, i - 1]);
      s = null;
    }
  }
  if (s != null) rawSegs.push([s, records.length - 1]);

  // 2. 合并间隔过短的相邻段
  const merged = [];
  for (const seg of rawSegs) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] - 1 <= INTERVAL_DETECTION.merge_gap_sec) {
      last[1] = seg[1];
    } else {
      merged.push([...seg]);
    }
  }

  // 3. 过滤短段并统计
  const intervals = [];
  for (const [a, b] of merged) {
    const dur = b - a + 1;
    if (dur < INTERVAL_DETECTION.min_duration_sec) continue;
    const slice = records.slice(a, b + 1);
    const avgP = avgField(slice, "power", 0);
    intervals.push({
      name: `interval_${intervals.length + 1}`,
      start: records[a].timestamp,
      duration_sec: dur,
      avg_power: avgP,
      max_power: maxField(slice, "power"),
      pct_ftp:
        avgP != null ? Math.round((avgP / ATHLETE.ftp_watts) * 100) : null,
      avg_hr: avgField(slice, "heart_rate", 0),
      avg_cadence: avgField(slice, "cadence", 0),
    });
  }
  if (!intervals.length) return null;

  const result = { intervals };
  if (intervals.length >= 2) {
    // 组统计：判断是否为重复组（如 5×5min @ 110% FTP）
    result.interval_set = {
      count: intervals.length,
      avg_duration_sec: Math.round(
        intervals.reduce((a, x) => a + x.duration_sec, 0) / intervals.length,
      ),
      avg_power: Math.round(
        intervals.reduce((a, x) => a + (x.avg_power ?? 0), 0) /
          intervals.length,
      ),
      avg_pct_ftp: Math.round(
        intervals.reduce((a, x) => a + (x.pct_ftp ?? 0), 0) /
          intervals.length,
      ),
    };
  }
  return result;
}

/**
 * 爬坡段提取：用 smooth_sec 窗口计算局部坡度 (Δ海拔/Δ距离)，
 * 连续坡度 ≥ min_grade_pct 的路段为候选段；
 * 段需同时满足累计爬升 ≥ min_gain_m 且长度 ≥ min_distance_m。
 * distance/altitude 数据缺口处自然断段。
 */
function detectClimbs(records) {
  const S = CLIMB_DETECTION.smooth_sec;
  const n = records.length;
  // 1. 逐秒前向窗口坡度（%），数据无效或距离不增则为 null
  const grades = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const j = Math.min(i + S, n - 1);
    const a0 = records[i].altitude,
      a1 = records[j].altitude;
    const d0 = records[i].distance,
      d1 = records[j].distance;
    if (a0 == null || a1 == null || d0 == null || d1 == null) continue;
    const dd = d1 - d0;
    if (dd <= 0) continue;
    grades[i] = ((a1 - a0) / dd) * 100;
  }

  // 2. 连续过阈路段为候选段
  const climbs = [];
  let s = null;
  const flush = (end) => {
    if (s == null) return;
    const slice = records.slice(s, end + 1);
    const d0 = records[s].distance,
      d1 = records[end].distance;
    const distM = d0 != null && d1 != null ? d1 - d0 : 0;
    const gainM = elevationGain(slice.map((r) => r.altitude));
    if (
      distM >= CLIMB_DETECTION.min_distance_m &&
      gainM >= CLIMB_DETECTION.min_gain_m
    ) {
      climbs.push({
        name: `climb_${climbs.length + 1}`,
        start: records[s].timestamp,
        duration_sec: end - s + 1,
        distance_m: Math.round(distM),
        elevation_gain_m: gainM,
        avg_grade_pct: Math.round((gainM / distM) * 1000) / 10,
        avg_power: avgField(slice, "power", 0),
        avg_hr: avgField(slice, "heart_rate", 0),
      });
    }
    s = null;
  };
  for (let i = 0; i < n; i++) {
    if (grades[i] != null && grades[i] >= CLIMB_DETECTION.min_grade_pct) {
      if (s == null) s = i;
    } else {
      flush(i - 1);
    }
  }
  flush(n - 1);

  return climbs.length ? climbs : null;
}

/**
 * 踏频-功率联合分析：只统计功率 ≥ power_floor_pct × FTP 的"发力时段"，
 * 判断低踏频高扭矩 vs 高踏频的发力习惯，并给出踏频与功率的相关系数。
 */
function cadencePowerAnalysis(records) {
  const floor = CADENCE_ANALYSIS.power_floor_pct * ATHLETE.ftp_watts;
  const pts = records.filter(
    (r) => r.power != null && r.power >= floor && r.cadence != null,
  );
  if (pts.length < 60) return null; // 有效样本不足 60 秒不判读

  const cads = pts.map((r) => r.cadence);
  const pwrs = pts.map((r) => r.power);
  const avgCad = cads.reduce((a, b) => a + b, 0) / cads.length;
  const pctLow =
    Math.round(
      (cads.filter((c) => c < CADENCE_ANALYSIS.low_cadence_rpm).length /
        cads.length) *
        1000,
    ) / 10;
  const pctHigh =
    Math.round(
      (cads.filter((c) => c > CADENCE_ANALYSIS.high_cadence_rpm).length /
        cads.length) *
        1000,
    ) / 10;

  // 皮尔逊相关系数
  const avgP = pwrs.reduce((a, b) => a + b, 0) / pwrs.length;
  let num = 0,
    denC = 0,
    denP = 0;
  for (let i = 0; i < pts.length; i++) {
    const dc = cads[i] - avgCad,
      dp = pwrs[i] - avgP;
    num += dc * dp;
    denC += dc * dc;
    denP += dp * dp;
  }
  const corr =
    denC > 0 && denP > 0
      ? Math.round((num / Math.sqrt(denC * denP)) * 100) / 100
      : null;

  // 发力习惯判读
  let styleHint = "踏频功率匹配正常";
  if (pctLow >= 30)
    styleHint = "偏低踏频高扭矩发力（力量型，可考虑提高踏频降低肌肉负担）";
  else if (pctHigh >= 50)
    styleHint = "偏高踏频发力（心肺型，注意高踏频下的心率成本）";

  return {
    sample_sec: pts.length,
    avg_cadence: Math.round(avgCad * 10) / 10,
    pct_low_cadence: pctLow,
    pct_high_cadence: pctHigh,
    cadence_power_corr: corr,
    style_hint: styleHint,
  };
}

// ---------------- 单文件分析流程 ----------------

/** 解析一个 FIT 文件，输出 CSV + summary JSON，返回 { csvPath, jsonPath, summary } */
async function analyzeFile(input, outDir) {
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

  // 圈/赛段（lap）+ 自动识别的间歇段
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
  const intervalResult = detectIntervals(records);
  if (intervalResult) segments.push(...intervalResult.intervals);

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
      ftp_estimate: estimateFtp(powers),
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
    cadence_power: cadencePowerAnalysis(records),
    climbs: detectClimbs(records),
    interval_set: intervalResult?.interval_set,
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
  // 清理 undefined / null 的空壳字段
  for (const k of Object.keys(summary)) {
    if (summary[k] === undefined || summary[k] === null) delete summary[k];
  }
  if (summary.power.ftp_estimate == null) delete summary.power.ftp_estimate;
  if (summary.cadence_power == null) delete summary.cadence_power;

  // ---- 5. 训练库：入库 + 注入当日 CTL/ATL/TSB（失败不中断主流程） ----
  try {
    upsertActivity(path.basename(input), summary);
    const form = computeForm(summary.activity.date);
    if (form) {
      Object.assign(summary.athlete_context, form);
      upsertActivity(path.basename(input), summary); // 库中同步含 form 的最终版
    }
  } catch (e) {
    console.error(`警告: 训练库写入失败（不影响本次输出）: ${e.message}`);
  }

  const jsonPath = path.join(outDir, `${base}.summary.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  return { csvPath, jsonPath, summary };
}

// ---------------- 训练库查询命令 ----------------

/** 逐月训练汇总表（终端打印） */
function printMonthly(n) {
  const rows = monthlySummary(n);
  if (!rows.length) {
    console.log("训练库为空，先分析若干 FIT 文件再查看。");
    return;
  }
  const pad = (s, w) => String(s ?? "-").padEnd(w);
  console.log(
    pad("月份", 9) +
      pad("TSS", 7) +
      pad("时长h", 7) +
      pad("距离km", 9) +
      pad("次数", 5) +
      pad("低/中/高%", 14) +
      "强度类型",
  );
  for (const r of rows) {
    const dist = r.intensity_pct
      ? `${r.intensity_pct.low}/${r.intensity_pct.mid}/${r.intensity_pct.high}`
      : "-";
    console.log(
      pad(r.month, 9) +
        pad(r.tss, 7) +
        pad(r.hours, 7) +
        pad(r.distance_km, 9) +
        pad(r.sessions, 5) +
        pad(dist, 14) +
        (r.intensity_type ?? "-"),
    );
  }
}

/**
 * 生成逐月 CTL/ATL/TSB 趋势图：自包含 HTML（内嵌数据 + 原生 SVG，无外部库）。
 * 柱状为月 TSS，折线为月末 CTL（蓝）/ATL（红）/TSB（绿）。
 */
function writeTrendHtml(months, outPath) {
  const data = trendMonthly().slice(-months);
  if (!data.length) {
    console.log("训练库为空，先分析若干 FIT 文件再生成趋势图。");
    return;
  }
  const W = 900,
    H = 420,
    PL = 50,
    PR = 50,
    PT = 30,
    PB = 50;
  const iw = W - PL - PR,
    ih = H - PT - PB;
  const maxForm = Math.max(...data.map((d) => Math.max(d.ctl, d.atl)), 10);
  const minForm = Math.min(...data.map((d) => Math.min(d.tsb, 0)));
  const maxTss = Math.max(...data.map((d) => d.tss), 1);
  const x = (i) => PL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const yForm = (v) => PT + ((maxForm - v) / (maxForm - minForm)) * ih;
  const yTss = (v) => PT + ih - (v / maxTss) * ih;
  const line = (key, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="2" points="${data
      .map((d, i) => `${x(i).toFixed(1)},${yForm(d[key]).toFixed(1)}`)
      .join(" ")}" />`;
  const bw = Math.min(40, (iw / data.length) * 0.5);
  const bars = data
    .map(
      (d, i) =>
        `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${yTss(d.tss).toFixed(1)}" width="${bw.toFixed(1)}" height="${(PT + ih - yTss(d.tss)).toFixed(1)}" fill="#ddd" />`,
    )
    .join("");
  const labels = data
    .map(
      (d, i) =>
        `<text x="${x(i).toFixed(1)}" y="${H - PB + 18}" font-size="11" text-anchor="middle">${d.month}</text>`,
    )
    .join("");
  const zero =
    minForm < 0
      ? `<line x1="${PL}" y1="${yForm(0).toFixed(1)}" x2="${W - PR}" y2="${yForm(0).toFixed(1)}" stroke="#999" stroke-dasharray="4" />`
      : "";
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Fitness 趋势（CTL/ATL/TSB）</title></head>
<body style="font-family:sans-serif;max-width:960px;margin:24px auto">
<h2>Fitness 趋势（按月）</h2>
<p>灰柱：月 TSS（右轴）　<span style="color:#1f77b4">━ CTL 体能</span>　<span style="color:#d62728">━ ATL 疲劳</span>　<span style="color:#2ca02c">━ TSB 状态</span></p>
<svg width="${W}" height="${H}" style="border:1px solid #ccc">
${bars}${zero}${line("ctl", "#1f77b4")}${line("atl", "#d62728")}${line("tsb", "#2ca02c")}${labels}
<text x="6" y="${PT + 10}" font-size="11">${maxForm}</text>
<text x="6" y="${(PT + ih).toFixed(0)}" font-size="11">${minForm}</text>
<text x="${W - 44}" y="${PT + 10}" font-size="11" fill="#999">${maxTss}</text>
</svg>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin-top:16px">
<tr><th>月份</th><th>TSS</th><th>CTL</th><th>ATL</th><th>TSB</th></tr>
${data.map((d) => `<tr><td>${d.month}</td><td>${d.tss}</td><td>${d.ctl}</td><td>${d.atl}</td><td>${d.tsb}</td></tr>`).join("\n")}
</table>
<div style="margin-top:24px;font-size:13px;color:#444;line-height:1.7">
<h3 style="margin-bottom:8px">指标含义与解读</h3>
<ul style="margin:0;padding-left:20px">
<li><b>TSS（训练压力分数，灰柱）</b>：当月训练负荷总量，由每次训练的强度（IF）与时长计算。单次参考：&lt;150 轻松，第二天可正常训练；150–300 中等，疲劳次日可恢复；&gt;300 较大，需要 1–2 天恢复。</li>
<li><b>CTL（慢性负荷 / 体能，蓝线）</b>：TSS 的 42 天指数加权平均，代表长期训练积累出的"体能底子"。持续缓慢上升 = 体能增长；建议每周增幅不超过 5–7 点，涨太快有过劳/受伤风险；下降则说明训练量不足、体能在流失。</li>
<li><b>ATL（急性负荷 / 疲劳，红线）</b>：TSS 的 7 天指数加权平均，代表近期疲劳程度。红线明显高于蓝线 = 最近练得比平常狠，疲劳在积累。</li>
<li><b>TSB（状态 / 新鲜度，绿线）</b>：CTL − ATL，体能与疲劳的差值，是最直接的"今天状态如何"指标：
<ul style="margin:4px 0;padding-left:20px">
<li>≥ +15：很新鲜，适合比赛或高强度测试</li>
<li>+5 ~ +15：赛前调整（减量）的目标区间</li>
<li>−10 ~ +5：负荷与恢复平衡，可持续训练</li>
<li>−20 ~ −10：疲劳积累期，注意睡眠与恢复</li>
<li>&lt; −20：过度疲劳风险，建议安排减量周</li>
</ul></li>
</ul>
<p style="margin-top:8px;color:#777">典型训练节奏：渐进负荷期 CTL 缓升、TSB 维持在 −10 ~ −30；赛前 1–2 周减量让 ATL 回落，TSB 回升到 +5 ~ +15 出赛。</p>
</div>
</body></html>`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log("趋势图已生成:", outPath);
}

// ---------------- AI 提示词生成命令（P2） ----------------

/** 输出提示词：始终打印 stdout；给了输出路径则同时写 .md 文件 */
function emitPrompt(text, outPath) {
  console.log(text);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, text);
    console.error(`\n提示词已写入: ${outPath}`);
  }
}

/** 读取 summary.json 文件为对象 */
function loadSummaryJson(p) {
  if (!p || !fs.existsSync(p)) {
    console.error(`找不到 summary 文件: ${p ?? "(未提供)"}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** 周期规划提示词：月汇总 + 逐周 CTL/ATL/TSB + 近期训练清单 */
function emitPlanPrompt(weeks, outPath) {
  const daily = recentFormDaily(weeks * 7);
  if (!daily.length) {
    console.log("训练库为空，先分析若干 FIT 文件再生成周期规划提示词。");
    return;
  }
  const text = buildPlanPrompt({
    months: monthlySummary(3),
    formSeries: thinToWeekly(daily),
    recentActivities: recentActivities(10),
  });
  emitPrompt(text, outPath);
}

/** 赛前调整提示词：当前状态 + 走势 + 剩余天数 */
function emitTaperPrompt(raceDate, outPath) {
  if (!raceDate || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
    console.error("用法: node index.js --taper <比赛日期 YYYY-MM-DD> [输出.md]");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const form = computeForm(today);
  if (!form) {
    console.log("训练库为空，先分析若干 FIT 文件再生成赛前调整提示词。");
    return;
  }
  const daysLeft = Math.round(
    (new Date(raceDate + "T00:00:00Z") - new Date(today + "T00:00:00Z")) /
      86400000,
  );
  const text = buildTaperPrompt({
    raceDate,
    daysLeft,
    form,
    formSeries: thinToWeekly(recentFormDaily(56)),
    recentActivities: recentActivities(10),
  });
  emitPrompt(text, outPath);
}

// ---------------- 入口：单文件 / 批量 ----------------

async function main() {
  const input = process.argv[2];

  // ---- 训练库查询子命令 ----
  if (input === "--monthly") {
    printMonthly(Number(process.argv[3]) || 6);
    return;
  }
  if (input === "--trend") {
    const months = Number(process.argv[3]) || 12;
    const out = process.argv[4] || path.resolve("output", "fitness-trend.html");
    writeTrendHtml(months, out);
    return;
  }

  // ---- AI 提示词生成子命令（P2） ----
  if (input === "--review") {
    emitPrompt(buildReviewPrompt(loadSummaryJson(process.argv[3])), process.argv[4]);
    return;
  }
  if (input === "--plan") {
    emitPlanPrompt(Number(process.argv[3]) || 8, process.argv[4]);
    return;
  }
  if (input === "--taper") {
    emitTaperPrompt(process.argv[3], process.argv[4]);
    return;
  }
  if (input === "--compare") {
    const a = loadSummaryJson(process.argv[3]);
    const b = loadSummaryJson(process.argv[4]);
    emitPrompt(buildComparePrompt(a, b), process.argv[5]);
    return;
  }

  if (!input || !fs.existsSync(input)) {
    console.error("用法:");
    console.error("  node index.js <输入.fit 或包含 .fit 的目录> [输出目录]");
    console.error("  node index.js --monthly [月数=6]              逐月训练汇总");
    console.error(
      "  node index.js --trend [月数=12] [输出.html]   生成 CTL/ATL/TSB 趋势图",
    );
    console.error(
      "  node index.js --review <summary.json> [输出.md]   生成单次复盘 AI 提示词",
    );
    console.error(
      "  node index.js --plan [周数=8] [输出.md]           生成周期规划 AI 提示词",
    );
    console.error(
      "  node index.js --taper <比赛日期> [输出.md]        生成赛前减量 AI 提示词",
    );
    console.error(
      "  node index.js --compare <A.json> <B.json> [输出.md] 生成两次训练对比 AI 提示词",
    );
    process.exit(1);
  }

  if (fs.statSync(input).isDirectory()) {
    // ---- 批量模式：扫描目录顶层 *.fit，单文件失败不中断 ----
    const outDir = process.argv[3] || path.resolve("output");
    const files = fs
      .readdirSync(input)
      .filter((f) => f.toLowerCase().endsWith(".fit"));
    if (!files.length) {
      console.error(`目录中没有 .fit 文件: ${input}`);
      process.exit(1);
    }
    fs.mkdirSync(outDir, { recursive: true });

    let ok = 0,
      fail = 0;
    for (const f of files) {
      try {
        const { summary } = await analyzeFile(path.join(input, f), outDir);
        ok++;
        let line = `[OK] ${f} → NP ${summary.power.normalized_power ?? "-"}W / TSS ${summary.power.tss ?? "-"}`;
        const est = summary.power.ftp_estimate;
        if (est?.suggestion === "consider_update")
          line += ` ⚠ FTP 估算 ${est.estimated_ftp_w}W（当前 ${est.current_ftp_w}W，建议更新 settings.js）`;
        console.log(line);
      } catch (e) {
        fail++;
        console.error(`[失败] ${f}: ${e.message}`);
      }
    }
    console.log(`\n批量完成: 成功 ${ok} / 失败 ${fail}，输出目录 ${outDir}`);
    if (ok === 0) process.exit(1);
    return;
  }

  // ---- 单文件模式 ----
  const outDir = process.argv[3] || path.dirname(path.resolve(input));
  const { csvPath, jsonPath, summary } = await analyzeFile(input, outDir);

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
