/**
 * e2e.test.mjs
 * 端到端回归测试：合成 FIT → analyzeFile → 校验 CSV + summary JSON。
 * 训练库通过 FIT_DB_PATH 指向临时目录，与真实 ./db/fitness.db 隔离。
 * 运行：npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import index.js（间接加载 db.js）之前设置，保证测试不写真实训练库
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-reader-test-"));
process.env.FIT_DB_PATH = path.join(tmp, "test-fitness.db");

const { analyzeFile } = await import("../index.js");
const { ATHLETE } = await import("../src/settings.js");
const { formatAnomaly } = await import("../src/i18n.js");
const gen = await import("./make_test_fit.mjs");

const inDir = path.join(tmp, "in");
const outDir = path.join(tmp, "out");
fs.mkdirSync(inDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

function writeFit(name, buf) {
  const p = path.join(inDir, name);
  fs.writeFileSync(p, buf);
  return p;
}

test("骑行：30 分钟恒定功率 + 60 秒功率缺失", async () => {
  const fit = writeFit("ride.fit", gen.buildRideFit({ powerGap: [600, 60] }));
  const { csvPath, jsonPath, summary } = await analyzeFile(fit, outDir);

  // 输出文件存在
  assert.ok(fs.existsSync(csvPath));
  assert.ok(fs.existsSync(jsonPath));

  // CSV：表头 + 1800 行（严格 1 秒网格）
  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1801);
  assert.equal(
    lines[0],
    "timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature",
  );
  assert.equal(lines[601].split(",")[1], ""); // 第 600 秒功率缺失留空

  // 指标：恒定 200W → NP = 200
  assert.equal(summary.activity.sport, "cycling");
  assert.equal(summary.activity.duration_sec, 1800);
  assert.equal(summary.power.normalized_power, 200);
  // IF = NP/FTP、TSS = 时长×NP×IF/(FTP×3600)×100（期望值按当前生效 FTP 动态计算，
  // 骑手参数是可调数据而非代码常量，不能写死）
  const ftp = ATHLETE.ftp_watts;
  const expectedIF = Math.round((200 / ftp) * 100) / 100;
  const expectedTSS = Math.round(((1800 * 200 * expectedIF) / (ftp * 3600)) * 100);
  assert.equal(summary.power.intensity_factor, expectedIF);
  assert.equal(summary.power.tss, expectedTSS);
  assert.equal(summary.power.peak_curve["5min"], 200);

  // 功率缺失被标注（结构化：type 语言中立，中文渲染口径不变）；覆盖率 = 1740/1800 ≈ 97%
  assert.ok(
    summary.anomalies.some((a) => a.type === "power_gap" && a.duration_sec === 60),
  );
  assert.ok(
    summary.anomalies.some((a) => formatAnomaly(a, "zh").includes("功率缺失 60s")),
  );
  assert.ok(summary.anomalies.some((a) => formatAnomaly(a, "en").includes("Power missing 60s")));
  assert.equal(summary.data_quality.power_coverage_pct, 97);
  assert.equal(summary.data_quality.record_count, 1800);
  assert.equal(summary.data_quality.missing_seconds, undefined);

  // session 汇总的平均速度（10 m/s = 36 km/h）与卡路里；record 温度统计
  assert.equal(summary.activity.avg_speed_kmh, 36);
  assert.equal(summary.activity.total_calories, 360);
  assert.equal(summary.temperature.avg, 25);
  assert.equal(summary.temperature.min, 25);
  assert.equal(summary.temperature.max, 25);

  // 训练库注入当日 CTL/ATL/TSB（测试库内首次训练，均为小值）
  assert.equal(typeof summary.athlete_context.ctl, "number");
  assert.equal(typeof summary.athlete_context.tsb, "number");
});

test("踏频：剔除滑行 0 rpm 秒（与码表/Strava 口径一致）", async () => {
  // 前半程 90 rpm 踩踏，后半程 0 rpm 滑行 → 平均踏频应为 90 而非 45
  const fit = writeFit(
    "coast.fit",
    gen.buildRideFit({ cadence: (i) => (i < 900 ? 90 : 0) }),
  );
  const { summary } = await analyzeFile(fit, outDir);
  assert.equal(summary.cadence.avg, 90);
});

test("损坏兜底：整段记录缺失 + 无时间戳坏记录被计数标注", async () => {
  const fit = writeFit(
    "broken.fit",
    gen.buildRideFit({
      dropSpans: [
        [300, 45],
        [900, 20],
      ],
      badTimestampOffsets: [100, 200],
    }),
  );
  const { summary } = await analyzeFile(fit, outDir);

  // 记录 1800 - 65(掉段) - 2(无时间戳) = 1733 条
  assert.equal(summary.data_quality.record_count, 1733);
  assert.equal(summary.data_quality.dropped_records_no_timestamp, 2);
  // 缺失秒数 = 45 + 20 + 2（无时间戳的 2 秒同样没有数据）
  assert.equal(summary.data_quality.missing_seconds, 67);
  assert.ok(
    summary.anomalies.some((a) => a.type === "record_gap" && a.duration_sec === 45),
  );
  assert.ok(
    summary.anomalies.some((a) => a.type === "record_gap" && a.duration_sec === 20),
  );
  assert.ok(summary.anomalies.some((a) => formatAnomaly(a, "zh").includes("记录缺失 45s")));
});

test("暂停识别：停车暂停计时不标数据缺失，时长/TSS 剔除暂停", async () => {
  // 前 600s 骑行（10 m/s），600-960s 暂停码表（无记录），恢复后先静止 5s 再继续骑
  const fit = writeFit(
    "paused.fit",
    gen.buildRideFit({
      dropSpans: [[600, 360]],
      speedMS: (i) => (i < 600 || i >= 965 ? 10 : 0),
    }),
  );
  const { summary } = await analyzeFile(fit, outDir);

  // 恢复侧静止 → 判为计时暂停，不产生 record_gap / power_gap
  assert.ok(
    summary.anomalies.some(
      (a) => a.type === "timer_pause" && a.duration_sec === 360,
    ),
  );
  assert.ok(!summary.anomalies.some((a) => a.type === "record_gap"));
  assert.ok(!summary.anomalies.some((a) => a.type === "power_gap"));
  assert.ok(
    summary.anomalies.some((a) => formatAnomaly(a, "zh").includes("计时暂停 360s")),
  );
  assert.ok(
    summary.anomalies.some((a) => formatAnomaly(a, "en").includes("Timer paused 360s")),
  );

  // 缺失秒数剔除暂停（暂停秒数单列）；时长/TSS 只按计时时间计算
  assert.equal(summary.data_quality.missing_seconds, undefined);
  assert.equal(summary.data_quality.pause_seconds, 360);
  assert.equal(summary.activity.duration_sec, 1440);
  const ftp = ATHLETE.ftp_watts;
  const expectedIF = Math.round((200 / ftp) * 100) / 100;
  assert.equal(
    summary.power.tss,
    Math.round(((1440 * 200 * expectedIF) / (ftp * 3600)) * 100),
  );
});

test("事件暂停：FIT timer stop_all→start 事件识别暂停，启发法兜底", async () => {
  // 600-960s 无记录且恢复时直接骑行（启发法不命中），但设备写了暂停事件
  const startMs = Date.UTC(2024, 0, 15, 10, 0, 0);
  const fit = writeFit(
    "paused_event.fit",
    gen.buildRideFit({
      dropSpans: [[600, 360]],
      pauseEvents: [
        { stopMs: startMs + 601 * 1000, startMs: startMs + 959 * 1000 },
      ],
    }),
  );
  const { summary } = await analyzeFile(fit, outDir);
  assert.ok(
    summary.anomalies.some(
      (a) => a.type === "timer_pause" && a.duration_sec === 360,
    ),
  );
  assert.ok(!summary.anomalies.some((a) => a.type === "record_gap"));
  assert.equal(summary.data_quality.pause_seconds, 360);
  assert.equal(summary.activity.duration_sec, 1440);
});

test("累计爬升：优先采用码表自报 total_ascent，缺失时回退自算", async () => {
  const fit = writeFit("ascent.fit", gen.buildRideFit({ totalAscentM: 82 }));
  const { summary } = await analyzeFile(fit, outDir);
  assert.equal(summary.activity.elevation_gain_m, 82);
  assert.equal(summary.activity.elevation_gain_source, "device");

  // 无设备值：恒定海拔自算为 0
  const fit2 = writeFit("ascent_flat.fit", gen.buildRideFit());
  const { summary: s2 } = await analyzeFile(fit2, outDir);
  assert.equal(s2.activity.elevation_gain_m, 0);
  assert.equal(s2.activity.elevation_gain_source, "computed");

  // 无设备值：匀坡自算。步长 0.2m/秒与 FIT 海拔字段 0.2m 量化（scale 5）对齐，
  // 500s × 0.2m = 100m 整数坡，去抖每满 1m 确认一次，恰得 100m
  const fit3 = writeFit(
    "ascent_ramp.fit",
    gen.buildRideFit({ durationSec: 501, altitude: (i) => 100 + i * 0.2 }),
  );
  const { summary: s3 } = await analyzeFile(fit3, outDir);
  assert.equal(s3.activity.elevation_gain_m, 100);
  assert.equal(s3.activity.elevation_gain_source, "computed");
});

test("跑步：配速/步频指标，无功率段，心率漂移走速度口径", async () => {
  const fit = writeFit("run.fit", gen.buildRunFit());
  const { summary } = await analyzeFile(fit, outDir);

  assert.equal(summary.activity.sport, "running");
  assert.equal(summary.power, undefined); // 无功率计 → 整个 power 段省略
  assert.equal(summary.cadence_power, undefined); // 骑行专属分析不出现
  // 12 km/h = 5 min/km
  assert.equal(summary.pace.avg_pace_min_per_km, 5);
  assert.equal(summary.pace.best_1min_pace_min_per_km, 5);
  assert.equal(summary.cadence.avg, 170);
  // 后半程心率 140→150、速度不变 → 漂移 ≈ 6.7%
  assert.equal(summary.heart_rate.hr_drift_pct, 6.7);
  // lap 附平均配速
  assert.equal(summary.segments[0].avg_pace_min_per_km, 5);
});

test("游泳：解析 length 消息，输出泳池/趟数/划水/SWOLF", async () => {
  const fit = writeFit("swim.fit", gen.buildSwimFit());
  const { summary } = await analyzeFile(fit, outDir);

  assert.equal(summary.activity.sport, "swimming");
  assert.equal(summary.swim.lengths_count, 20);
  assert.equal(summary.swim.pool_length_m, 25);
  assert.equal(summary.swim.avg_length_time_sec, 30);
  assert.equal(summary.swim.total_strokes, 360);
  assert.equal(summary.swim.avg_swolf, 48); // 30s + 18 次划水
  assert.equal(summary.activity.distance_km, 0.5); // record 无距离 → session 兜底
  assert.equal(summary.power, undefined);
  assert.equal(summary.data_quality.hr_coverage_pct, 100);
});

test("开发者字段：自定义字段被统计进 summary", async () => {
  const fit = writeFit(
    "devfield.fit",
    gen.buildRideFit({ devField: { name: "core_temperature", value: 38 } }),
  );
  const { summary } = await analyzeFile(fit, outDir);
  assert.deepEqual(summary.developer_fields, {
    core_temperature: { samples: 1800, avg: 38, min: 38, max: 38 },
  });
});
