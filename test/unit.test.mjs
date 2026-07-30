/**
 * unit.test.mjs
 * 指标算法纯函数的单元测试（node:test，零依赖）。
 * 运行：npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizedPower,
  peakAvg,
  zoneDistribution,
  elevationGain,
  findPowerGaps,
  findMissingSpans,
  estimateFtp,
  detectIntervals,
  hrDriftPct,
  collectDeveloperFields,
} from "../index.js";
import { estimateFtpFromHistory } from "../src/ftp.js";
import { compactSummaryForPrompt } from "../src/prompts.js";
import { simulateForm, generateWorkout } from "../src/planning.js";
import { ATHLETE, FORM_SIMULATION, WORKOUT_TEMPLATES } from "../src/settings.js";

// 构造逐秒记录对象的辅助函数
const rec = (i, fields = {}) => ({
  timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  power: null,
  heart_rate: null,
  cadence: null,
  altitude: null,
  speed: null,
  distance: null,
  ...fields,
});

test("normalizedPower: 恒定功率时 NP 等于该功率", () => {
  assert.equal(normalizedPower(Array(300).fill(200)), 200);
});

test("normalizedPower: 缺口窗口不参与计算", () => {
  // 中间一个 null：覆盖该秒的 30s 窗口被跳过，其余窗口仍为 200
  const arr = Array(300).fill(200);
  arr[150] = null;
  assert.equal(normalizedPower(arr), 200);
});

test("normalizedPower: 数据不足 30 秒返回 null", () => {
  assert.equal(normalizedPower(Array(29).fill(200)), null);
});

test("peakAvg: 递增序列取窗口最大值，要求窗口连续", () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(peakAvg(arr, 10), 96); // avg(91..100) = 95.5 → 96
  // 峰值窗口含 null 则该窗口被跳过：孤立尖峰被两个 null 夹住，
  // 任何覆盖尖峰的窗口都因不连续而被排除
  const withGap = Array(100).fill(100);
  withGap[45] = null;
  withGap[50] = 500;
  withGap[55] = null;
  assert.equal(peakAvg(withGap, 10), 100);
});

test("zoneDistribution: 按基数比例分区并输出百分比", () => {
  const zones = [
    { name: "L", min: 0, max: 0.5 },
    { name: "H", min: 0.5, max: Infinity },
  ];
  assert.deepEqual(zoneDistribution([40, 60, null], zones, 100), {
    L: 50,
    H: 50,
  });
  assert.equal(zoneDistribution([null, null], zones, 100), null);
});

test("elevationGain: 1m 阈值去抖，小抖动不计爬升", () => {
  assert.equal(elevationGain([0, 0.4, 0.8, 1.2]), 1); // 累计 1.2m → 计 1.2 → 取整 1
  assert.equal(elevationGain([0, 0.3, 0, 0.3, 0]), 0); // 抖动被压掉
  // 100→110 计 10m，下降到 105 后 105→120 再计 15m，合计 25m
  assert.equal(elevationGain([null, 100, 110, 105, 120]), 25);
});

test("findPowerGaps: 只报告连续缺失超过阈值的片段", () => {
  const records = Array.from({ length: 200 }, (_, i) =>
    rec(i, { power: i >= 50 && i < 120 ? null : 200 }),
  );
  const gaps = findPowerGaps(records); // 默认 60s 阈值
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].duration_sec, 70);
  assert.equal(findPowerGaps(records, 80).length, 0);
});

test("findMissingSpans: 整条记录（全字段 null）缺失检测", () => {
  const records = Array.from({ length: 100 }, (_, i) =>
    i >= 30 && i < 45 ? rec(i) : rec(i, { power: 100, heart_rate: 120 }),
  );
  const spans = findMissingSpans(records, 10);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 15);
  // 阈值大于缺失时长则不报告
  assert.equal(findMissingSpans(records, 20).length, 0);
});

test("estimateFtp: 20 分钟峰功率 × 0.95，并给出更新建议", () => {
  const est = estimateFtp(Array(1200).fill(200));
  assert.equal(est.peak_20min_w, 200);
  assert.equal(est.estimated_ftp_w, 190);
  assert.equal(est.current_ftp_w, ATHLETE.ftp_watts);
  assert.equal(est.suggestion, "consider_update"); // 190 明显高于 118
  // 不足 20 分钟 → null
  assert.equal(estimateFtp(Array(1199).fill(200)), null);
  // 明显偏低 → 不建议直接下调
  assert.equal(estimateFtp(Array(1200).fill(60)).suggestion, "consider_recheck");
});

test("detectIntervals: 识别重复过阈工作段并给出组统计", () => {
  // 3×(120s @ 150W) 间歇，夹 120s @ 80W 恢复，前后各 60s 热身/放松
  const thr = ATHLETE.ftp_watts * 1.05; // 123.9
  const records = [];
  const push = (n, power) => {
    for (let k = 0; k < n; k++)
      records.push(rec(records.length, { power, heart_rate: 140, cadence: 90 }));
  };
  push(60, 80);
  for (let s = 0; s < 3; s++) {
    push(120, 150);
    push(120, 80);
  }
  assert.ok(150 >= thr);
  const r = detectIntervals(records);
  assert.equal(r.intervals.length, 3);
  assert.equal(r.intervals[0].duration_sec, 120);
  assert.equal(r.intervals[0].avg_power, 150);
  assert.equal(r.interval_set.count, 3);
  // 全程低于阈值 → null
  const easy = Array.from({ length: 300 }, (_, i) => rec(i, { power: 80 }));
  assert.equal(detectIntervals(easy), null);
});

test("hrDriftPct: 心率上升而输出不变时漂移为正（功率口径）", () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    rec(i, { power: 200, heart_rate: i < 300 ? 130 : 140 }),
  );
  // ef1 = 200/130, ef2 = 200/140 → drift = 1 − 130/140 ≈ 7.1%
  assert.equal(hrDriftPct(records, "power"), 7.1);
});

test("hrDriftPct: 支持速度口径（跑步无功率计）", () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    rec(i, { speed: 12, heart_rate: i < 300 ? 140 : 150 }),
  );
  // drift = 1 − 140/150 ≈ 6.7%
  assert.equal(hrDriftPct(records, "speed"), 6.7);
});

test("collectDeveloperFields: 只统计白名单外的数值字段", () => {
  const raw = [
    { timestamp: new Date(), power: 200, core_temperature: 38.5, note: "x" },
    { timestamp: new Date(), power: 210, core_temperature: 39.5 },
    { timestamp: new Date(), power: 220 },
  ];
  const dev = collectDeveloperFields(raw);
  assert.deepEqual(dev, {
    core_temperature: { samples: 2, avg: 39, min: 38.5, max: 39.5 },
  });
  assert.equal(collectDeveloperFields([{ timestamp: new Date(), power: 1 }]), null);
});

// ---------------- FTP 历史估算（ftp.js：CP 模型 + Coggan + 心率交叉验证） ----------------

// 构造一次合成骑行（FTP 估算输入：db.cyclingSummariesSince 的元素形状）
const mkRide = (
  name,
  date,
  { p5 = 150, p20 = 130, hrMax = 180, pz = { Z5: 5 }, hz = { Z4: 5 }, drift = 2, dur = 3600 } = {},
) => ({
  file_name: name,
  date,
  duration_sec: dur,
  summary: {
    power: {
      peak_curve: {
        ...(p5 != null ? { "5min": p5 } : {}),
        ...(p20 != null ? { "20min": p20 } : {}),
      },
      zone_distribution_pct: pz,
    },
    heart_rate: { max: hrMax, zone_distribution_pct: hz, hr_drift_pct: drift },
    data_quality: { power_coverage_pct: 100, hr_coverage_pct: 100 },
  },
});
const FTP_ATHLETE = { ftp_watts: 118, max_hr: 195 };
const threeRides = (opts) => [
  mkRide("a.fit", "2026-07-01", opts),
  mkRide("b.fit", "2026-07-03", opts),
  mkRide("c.fit", "2026-07-05", opts),
];

test("estimateFtpFromHistory: 双方法一致且心率验证通过 → 高置信", () => {
  const r = estimateFtpFromHistory(threeRides(), FTP_ATHLETE);
  assert.equal(r.status, "ok");
  // CP = (130×1200 − 150×300) / 900 = 123.3 → 123；W′ = (150−123.3)×300 = 8kJ
  assert.equal(r.estimate.methods.cp_model.ftp_w, 123);
  assert.equal(r.estimate.methods.cp_model.w_prime_kj, 8);
  // Coggan = 130 × 0.95 = 123.5 → 124；两法均值 123.5 → 124
  assert.equal(r.estimate.methods.coggan_20min.ftp_w, 124);
  assert.equal(r.estimate.ftp_w, 124);
  assert.equal(r.estimate.confidence, "high");
  assert.equal(r.estimate.methods.hr_check.maximal_effort, true);
  assert.equal(r.estimate.diff_w, 124 - FTP_ATHLETE.ftp_watts);
});

test("estimateFtpFromHistory: 无 20min 峰功率 → 数据不足并给出收集清单", () => {
  const r = estimateFtpFromHistory(threeRides({ p20: null }), FTP_ATHLETE);
  assert.equal(r.status, "insufficient");
  assert.equal(r.estimate, null);
  assert.ok(r.data_needs.length > 0);
  assert.match(r.data_needs.join("\n"), /20 分钟/);
});

test("estimateFtpFromHistory: 样本次数不足 → 低置信并提示补充数据", () => {
  const r = estimateFtpFromHistory([mkRide("a.fit", "2026-07-01")], FTP_ATHLETE);
  assert.equal(r.status, "ok");
  assert.equal(r.estimate.confidence, "low");
  assert.match(r.data_needs.join("\n"), /更多佩戴功率计的骑行/);
});

test("estimateFtpFromHistory: 锚点骑行心率未达全力阈值 → 降置信并建议全力测试", () => {
  // 全力阈值 = round(195×0.9) = 176bpm，心率峰值 150 未达
  const r = estimateFtpFromHistory(threeRides({ hrMax: 150 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.maximal_effort, false);
  assert.equal(r.estimate.confidence, "medium");
  assert.match(r.data_needs.join("\n"), /全力测试/);
});

test("estimateFtpFromHistory: 功率强度显著高于心率响应 → 判定系统性偏移", () => {
  const r = estimateFtpFromHistory(
    threeRides({ pz: { Z5: 30 }, hz: { Z4: 5 } }),
    FTP_ATHLETE,
  );
  const zm = r.estimate.methods.hr_check.zone_mismatch;
  assert.equal(zm.direction, "power_above_hr");
  assert.match(r.notes.join("\n"), /低估/);
});

test("estimateFtpFromHistory: 心率漂移超阈值 → 数据漂移提示", () => {
  const r = estimateFtpFromHistory(threeRides({ drift: 8 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.median_hr_drift_pct, 8);
  assert.match(r.notes.join("\n"), /有氧解耦/);
});

test("estimateFtpFromHistory: 缺 5min 峰功率时 CP 模型退化，仅用 Coggan 法", () => {
  const r = estimateFtpFromHistory(threeRides({ p5: null }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.cp_model, null);
  assert.equal(r.estimate.ftp_w, r.estimate.methods.coggan_20min.ftp_w);
  assert.match(r.notes.join("\n"), /CP 模型不可用/);
});

// ---------------- prompts.js 提交前数据压缩 ----------------

test("compactSummaryForPrompt: 少量 anomalies 时保持原样", () => {
  const s = { anomalies: ["记录缺失 25s，起始 2026-07-24T13:54:16.000Z"] };
  const out = compactSummaryForPrompt(s);
  assert.deepEqual(out.anomalies, s.anomalies);
  assert.equal(out.anomalies_summary, undefined);
});

test("compactSummaryForPrompt: 大量 anomalies 聚合为按类型统计", () => {
  const anomalies = [
    "功率缺失 78s，起始 2026-07-24T13:43:40.000Z",
    "功率缺失 65s，起始 2026-07-24T14:36:53.000Z",
    "记录缺失 25s，起始 2026-07-24T13:54:16.000Z",
    "记录缺失 15s，起始 2026-07-24T13:55:26.000Z",
    "记录缺失 41s，起始 2026-07-24T14:01:38.000Z",
    "心率跳变 95→148，位于 2026-07-24T14:05:00.000Z",
  ];
  const out = compactSummaryForPrompt({ anomalies });
  assert.equal(out.anomalies, undefined);
  const byType = Object.fromEntries(out.anomalies_summary.map((g) => [g.type, g]));
  assert.deepEqual(byType["功率缺失"], {
    type: "功率缺失",
    count: 2,
    first_at: "2026-07-24T13:43:40.000Z",
    total_sec: 143,
    max_sec: 78,
  });
  assert.equal(byType["记录缺失"].count, 3);
  assert.equal(byType["记录缺失"].total_sec, 81);
  assert.equal(byType["心率跳变"].count, 1);
  assert.equal(byType["心率跳变"].total_sec, undefined);
});

test("compactSummaryForPrompt: 超长 segments 保留首尾并标注省略", () => {
  const segments = Array.from({ length: 30 }, (_, i) => ({ name: `lap_${i + 1}` }));
  const out = compactSummaryForPrompt({ segments });
  assert.equal(out.segments.length, 16); // 前10 + 占位 + 后5
  assert.equal(out.segments[0].name, "lap_1");
  assert.equal(out.segments[9].name, "lap_10");
  assert.match(out.segments[10].name, /省略 15 段/);
  assert.equal(out.segments[15].name, "lap_30");
});

test("compactSummaryForPrompt: 不修改原对象", () => {
  const s = {
    anomalies: Array.from({ length: 8 }, (_, i) => `记录缺失 ${10 + i}s，起始 T${i}`),
  };
  compactSummaryForPrompt(s);
  assert.equal(s.anomalies.length, 8);
});

// ============ src/planning.js：未来负荷推演 + 课表生成 ============

test("simulateForm: TSS 全 0 时 CTL/ATL 按 1/42、1/7 衰减", () => {
  const { projection, end_form } = simulateForm({
    startCtl: 42,
    startAtl: 14,
    plan: [{ date: "2026-08-01", tss: 0 }],
    cfg: FORM_SIMULATION,
  });
  // ctl = 42 + (0-42)/42 = 41；atl = 14 + (0-14)/7 = 12；tsb = 29
  assert.deepEqual(projection[0], ["2026-08-01", 41, 12, 29]);
  assert.deepEqual(end_form, { ctl: 41, atl: 12, tsb: 29 });
});

test("simulateForm: 恒定 TSS 下 CTL/ATL 向该 TSS 收敛", () => {
  const plan = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    tss: 100,
  }));
  const { end_form } = simulateForm({ startCtl: 0, startAtl: 0, plan, cfg: FORM_SIMULATION });
  assert.ok(end_form.ctl > 70 && end_form.ctl < 100, `ctl 应向 100 收敛，实际 ${end_form.ctl}`);
  assert.ok(end_form.atl > 90 && end_form.atl <= 100, `atl 应快速逼近 100，实际 ${end_form.atl}`);
});

test("simulateForm: TSB 持续低于 -30 达 7 天触发深度疲劳警示", () => {
  // atl 恒 50（每日 tss=50 保持），ctl 从 0 缓慢爬升，前 7 天 tsb 均 < -30
  const plan = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-08-0${i + 1}`,
    tss: 50,
  }));
  const { risk_flags } = simulateForm({ startCtl: 0, startAtl: 50, plan, cfg: FORM_SIMULATION });
  const flag = risk_flags.find((f) => f.type === "tsb_low_sustained");
  assert.ok(flag, "应触发 tsb_low_sustained");
  assert.equal(flag.days, 7);
  assert.equal(flag.start, "2026-08-01");
  assert.equal(flag.end, "2026-08-07");
});

test("simulateForm: CTL 周增幅超 10% 触发过度训练警示", () => {
  // start ctl=10，每日 tss=200 → ctl 快速拉升，周增幅远超 10%
  const plan = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    tss: 200,
  }));
  const { risk_flags } = simulateForm({ startCtl: 10, startAtl: 10, plan, cfg: FORM_SIMULATION });
  assert.ok(risk_flags.some((f) => f.type === "ctl_ramp_high"), "应触发 ctl_ramp_high");
});

test("simulateForm: 温和计划不触发任何风险", () => {
  // start ctl=50，每日 tss=50 → ctl/atl 稳定在 50 附近，tsb≈0
  const plan = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    tss: 50,
  }));
  const { risk_flags } = simulateForm({ startCtl: 50, startAtl: 50, plan, cfg: FORM_SIMULATION });
  assert.deepEqual(risk_flags, []);
});

test("generateWorkout: 稳态课（endurance）全程一个强度，瓦数与 TSS 口径正确", () => {
  const w = generateWorkout({
    target: "endurance",
    durationMinutes: 60,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.steady.minutes, 60);
  assert.deepEqual(w.steady.power_watts, [112, 150]); // 56%–75% × 200
  // TSS = 3600s × 0.68² / 36 = 46.2
  assert.equal(w.estimated_tss, 46.2);
});

test("generateWorkout: 甜区课组装进 60 分钟且各段合计等于总时长", () => {
  const w = generateWorkout({
    target: "sweet_spot",
    durationMinutes: 60,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.warmup.minutes, 15);
  assert.equal(w.main_sets.reps, 2);
  assert.equal(w.main_sets.set_minutes, 15);
  assert.equal(w.main_sets.rest_minutes, 5);
  assert.deepEqual(w.main_sets.power_watts, [176, 188]); // 88%–94% × 200
  const total =
    w.warmup.minutes +
    w.main_sets.reps * w.main_sets.set_minutes +
    (w.main_sets.reps - 1) * w.main_sets.rest_minutes +
    w.cooldown.minutes;
  assert.equal(total, 60);
  // TSS = 15min@0.5 + 2×15min@0.91 + 5min@0.5 + 10min@0.5 ≈ 53.9
  assert.equal(w.estimated_tss, 53.9);
});

test("generateWorkout: VO2max 组间休息与单组等时", () => {
  const w = generateWorkout({
    target: "vo2max",
    durationMinutes: 50,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.main_sets.reps, 4);
  assert.equal(w.main_sets.set_minutes, 3);
  assert.equal(w.main_sets.rest_minutes, 3); // 等时休息
  assert.deepEqual(w.main_sets.power_watts, [212, 240]); // 106%–120% × 200
});

test("generateWorkout: 时长装不下最小组数时报错", () => {
  const w = generateWorkout({
    target: "sweet_spot",
    durationMinutes: 20,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.match(w.error, /装不下/);
});

test("generateWorkout: TSB 过低自动降级为恢复课并附说明", () => {
  const w = generateWorkout({
    target: "threshold",
    durationMinutes: 60,
    ftpWatts: 200,
    tsb: -25,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.target, "recovery");
  assert.ok(w.steady, "降级后应为稳态恢复课");
  assert.match(w.notes[0], /自动降级为恢复骑/);
});

test("generateWorkout: 未知课表类型报错", () => {
  const w = generateWorkout({
    target: "hill_reps",
    durationMinutes: 60,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.match(w.error, /未知课表类型/);
});
