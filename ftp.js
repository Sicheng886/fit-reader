/**
 * ftp.js
 * FTP 历史估算（纯函数、无 IO）：基于最近窗口期内全部骑行训练的
 * 功率峰曲线 + 心率响应做联合估算，给出估值、置信度与数据收集建议。
 *
 * 科学参照：
 *   1. 双参数临界功率模型（Morton CP/W′ 模型）：
 *      P(t) = CP + W′/t，用 5min 与 20min 两个锚点解出 CP ≈ FTP；
 *   2. Coggan《Training and Racing with a Power Meter》：
 *      FTP ≈ 20 分钟峰功率 × 0.95；
 *   3. 心率交叉验证：全力 20min 测试心率峰值应接近 LTHR/HRmax 高位；
 *      功率区间与心率区间的系统性偏移提示 FTP 配置漂移；
 *      有氧解耦（hr drift）> 5% 提示疲劳/脱水/高温导致的数据漂移。
 */

import { FTP_ESTIMATION } from "./settings.js";

/** 中位数（输入可含 null，自动过滤；空数组返回 null） */
function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * 从历史骑行估算 FTP。
 * @param {Array} activities 窗口内骑行（db.cyclingSummariesSince 的输出）：
 *   [{ file_name, date, duration_sec, summary }]
 * @param {object} athlete 骑手参数（ATHLETE：ftp_watts / max_hr）
 * @param {object} cfg 阈值配置（默认 settings.js 的 FTP_ESTIMATION）
 * @returns {{status: string, estimate: object|null, data_needs: string[], notes: string[]}}
 */
export function estimateFtpFromHistory(
  activities,
  athlete,
  cfg = FTP_ESTIMATION,
) {
  const dataNeeds = [];
  const notes = [];
  const warnings = []; // 影响置信度的内部标记

  // ---- 1. 样本筛选：仅采信功率覆盖率达标且有 power 段的骑行 ----
  const withPower = activities.filter((a) => a.summary?.power);
  const usable = withPower.filter(
    (a) =>
      (a.summary.data_quality?.power_coverage_pct ?? 100) >=
      cfg.min_coverage_pct,
  );
  const withHr = usable.filter(
    (a) =>
      a.summary?.heart_rate &&
      (a.summary.data_quality?.hr_coverage_pct ?? 0) >= cfg.min_coverage_pct,
  );
  const sample = {
    cycling_rides: activities.length,
    rides_with_power: withPower.length,
    usable_power_rides: usable.length,
    rides_with_hr: withHr.length,
  };

  if (usable.length < cfg.min_rides) {
    dataNeeds.push(
      `窗口内有效功率骑行仅 ${usable.length} 次（需 ≥${cfg.min_rides} 次）：` +
        `请积累更多佩戴功率计的骑行数据后再估算`,
    );
    warnings.push("few_rides");
  }
  if (usable.length && withHr.length < usable.length) {
    dataNeeds.push(
      `仅 ${withHr.length}/${usable.length} 次骑行有合格心率数据：` +
        `后续骑行请全程佩戴心率带，以便心率交叉验证`,
    );
    warnings.push("hr_coverage");
  }

  // ---- 2. 窗口内最佳 5min / 20min 峰功率（CP 模型与 Coggan 法的锚点） ----
  const bestPeak = (key) => {
    let best = null;
    for (const a of usable) {
      const w = a.summary.power.peak_curve?.[key];
      if (w == null) continue;
      if (!best || w > best.watts)
        best = { watts: w, date: a.date, file_name: a.file_name };
    }
    return best;
  };
  const p5 = bestPeak("5min");
  const p20 = bestPeak("20min");

  if (!p20) {
    dataNeeds.push(
      "窗口内没有一次骑行包含连续 20 分钟的数据：" +
        "请安排一次 ≥30 分钟、且含持续 20 分钟高功率输出的骑行（户外长坡或室内台子均可）",
    );
    return {
      status: "insufficient",
      window_days: cfg.window_days,
      sample,
      estimate: null,
      data_needs: dataNeeds,
      notes,
      references: methodReferences(),
    };
  }

  // ---- 3. 方法一：双参数 CP 模型（Morton）：P(t) = CP + W′/t ----
  let cpModel = null;
  if (p5 && p5.watts > p20.watts) {
    const t1 = cfg.cp_short_sec,
      t2 = cfg.cp_long_sec;
    const cp = (p20.watts * t2 - p5.watts * t1) / (t2 - t1);
    if (cp > 0) {
      cpModel = {
        ftp_w: Math.round(cp),
        cp_w: Math.round(cp),
        w_prime_kj: r1(((p5.watts - cp) * t1) / 1000),
        p5,
        p20,
      };
    }
  }
  if (!cpModel) {
    notes.push(
      "CP 模型不可用（5min 与 20min 峰功率形态退化）：CP 法被跳过，仅采用 Coggan 法",
    );
    warnings.push("single_method");
  } else {
    dataNeeds.push(
      "为提高 CP 模型精度：可做一次充分休息后的 3–8 分钟全力骑行（刷新无氧锚点）",
    );
  }

  // ---- 4. 方法二：Coggan 20min × 0.95 ----
  const coggan = {
    ftp_w: Math.round(p20.watts * cfg.coggan_factor),
    peak_20min_w: p20.watts,
    date: p20.date,
    file_name: p20.file_name,
  };

  // ---- 5. 心率交叉验证 ----
  const hrCheck = {
    maximal_effort: null, // true=全力可信 / false=大概率非全力 / null=无心率无法判定
    best20_max_hr: null,
    threshold_hr: null,
    zone_mismatch: null,
    median_hr_drift_pct: null,
  };

  // 5a. 全力判定：20min 峰功率所在骑行的心率峰值是否达到全力阈值
  const anchor = usable.find((a) => a.file_name === p20.file_name);
  const thresholdHr = Math.round(athlete.max_hr * cfg.max_effort_hr_pct);
  hrCheck.threshold_hr = thresholdHr;
  const anchorHr = anchor?.summary.heart_rate;
  if (
    anchorHr &&
    (anchor.summary.data_quality?.hr_coverage_pct ?? 0) >= cfg.min_coverage_pct
  ) {
    hrCheck.best20_max_hr = anchorHr.max ?? null;
    hrCheck.maximal_effort =
      hrCheck.best20_max_hr != null && hrCheck.best20_max_hr >= thresholdHr;
    if (!hrCheck.maximal_effort) {
      notes.push(
        `20min 峰功率所在骑行（${p20.date}）心率峰值仅 ${hrCheck.best20_max_hr}bpm` +
          `（全力阈值 ≥${thresholdHr}bpm）：该 20 分钟大概率不是全力输出，FTP 估值偏保守`,
      );
      dataNeeds.push(
        "需要一次充分休息后的 20 分钟全力测试（佩戴心率带、心率峰值应接近阈值区间），" +
          "作为可靠的 FTP 锚点",
      );
      warnings.push("not_maximal");
    }
  } else {
    notes.push("20min 峰功率所在骑行缺少心率数据，无法判定是否全力输出");
    dataNeeds.push(
      "下次做 20 分钟高功率骑行时请佩戴心率带，用于判定输出是否接近全力",
    );
    warnings.push("not_maximal");
  }

  // 5b. 功率/心率区间一致性（时长加权）：系统性偏移提示 FTP 配置漂移
  let pHighSec = 0,
    hHighSec = 0,
    bothSec = 0;
  for (const a of withHr) {
    const dur = a.duration_sec ?? 0;
    const pz = a.summary.power?.zone_distribution_pct;
    const hz = a.summary.heart_rate?.zone_distribution_pct;
    if (!pz || !hz || dur <= 0) continue;
    pHighSec += ((pz.Z5 ?? 0) + (pz.Z6 ?? 0) + (pz.Z7 ?? 0)) * 0.01 * dur;
    hHighSec += ((hz.Z4 ?? 0) + (hz.Z5 ?? 0)) * 0.01 * dur;
    bothSec += dur;
  }
  if (bothSec > 0) {
    const pPct = r1((pHighSec / bothSec) * 100);
    const hPct = r1((hHighSec / bothSec) * 100);
    const diff = r1(pPct - hPct);
    let direction = "consistent";
    if (diff >= cfg.zone_mismatch_pct) {
      direction = "power_above_hr";
      notes.push(
        `功率高强度（Z5+）时间占比 ${pPct}% 显著高于心率高强度（Z4+）占比 ${hPct}%：` +
          "当前 FTP 配置可能被低估（同样心率下能输出更高功率），或心率带数据异常",
      );
      warnings.push("zone_mismatch");
    } else if (diff <= -cfg.zone_mismatch_pct) {
      direction = "hr_above_power";
      notes.push(
        `心率高强度（Z4+）时间占比 ${hPct}% 显著高于功率高强度（Z5+）占比 ${pPct}%：` +
          "当前 FTP 配置可能被高估，或存在疲劳/高温/脱水导致的心率漂移",
      );
      warnings.push("zone_mismatch");
    }
    hrCheck.zone_mismatch = {
      power_high_pct: pPct,
      hr_high_pct: hPct,
      diff_pct: diff,
      direction,
    };
  }

  // 5c. 有氧解耦：心率漂移中位数超阈值 → 数据漂移提示
  const driftMedian = median(
    withHr.map((a) => a.summary.heart_rate?.hr_drift_pct),
  );
  hrCheck.median_hr_drift_pct = driftMedian != null ? r1(driftMedian) : null;
  if (driftMedian != null && driftMedian > cfg.drift_warn_pct) {
    notes.push(
      `窗口内骑行心率漂移中位数 ${r1(driftMedian)}%（> ${cfg.drift_warn_pct}%）：` +
        "存在明显的有氧解耦（疲劳累积/脱水/高温），近期数据用于 FTP 推断时需谨慎",
    );
    warnings.push("drift");
  }

  // ---- 6. 合成估值与置信度 ----
  const ftps = [cpModel?.ftp_w, coggan.ftp_w].filter((x) => x != null);
  const ftpW = Math.round(ftps.reduce((a, b) => a + b, 0) / ftps.length);
  const rangeLow = Math.min(...ftps);
  const rangeHigh = Math.max(...ftps);
  const consistent =
    ftps.length === 2 &&
    (rangeHigh - rangeLow) / ftpW <= cfg.consistency_pct / 100;

  let confidence = "high";
  if (!consistent) warnings.push("inconsistent");
  if (warnings.includes("inconsistent") || warnings.includes("single_method"))
    confidence = "medium";
  if (
    warnings.includes("not_maximal") ||
    warnings.includes("zone_mismatch") ||
    warnings.includes("drift") ||
    warnings.includes("hr_coverage")
  )
    confidence = "medium";
  if (warnings.includes("few_rides")) confidence = "low";

  const estimate = {
    ftp_w: ftpW,
    range_low: rangeLow,
    range_high: rangeHigh,
    confidence,
    confidence_note: confidenceNote(confidence),
    current_ftp_w: athlete.ftp_watts,
    diff_w: ftpW - athlete.ftp_watts,
    methods: {
      cp_model: cpModel,
      coggan_20min: coggan,
      hr_check: hrCheck,
    },
  };

  return {
    status: "ok",
    window_days: cfg.window_days,
    sample,
    estimate,
    data_needs: dataNeeds,
    notes,
    references: methodReferences(),
  };
}

function confidenceNote(c) {
  if (c === "high") return "两种方法结果一致且心率验证通过，可信度高";
  if (c === "medium")
    return "存在警告项（非全力锚点/区间偏移/心率漂移/单一方法），估值供参考";
  return "样本量不足，估值仅供参考，请按下方清单补充数据后重新估算";
}

function methodReferences() {
  return [
    "Morton 双参数临界功率模型：P(t) = CP + W′/t，由 5min/20min 峰功率解出 CP ≈ FTP",
    "Coggan & Allen《Training and Racing with a Power Meter》：FTP ≈ 20min 峰功率 × 0.95",
    "心率交叉验证：全力阈值测试心率峰值应接近 HRmax 高位；功率/心率区间系统性偏移提示 FTP 配置漂移",
  ];
}
