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

  const jsonPath = path.join(outDir, `${base}.summary.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  return { csvPath, jsonPath, summary };
}

// ---------------- 入口：单文件 / 批量 ----------------

async function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.error("用法: node index.js <输入.fit 或包含 .fit 的目录> [输出目录]");
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
