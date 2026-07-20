/**
 * web.test.mjs
 * Web 服务（server.js）端到端测试：
 *   合成 FIT → POST /api/upload → 校验概览/详情/时序/AI 提示词接口与路径安全。
 *
 * 必须在 import server.js 之前设置 FIT_DB_PATH / FIT_OUTPUT_DIR / FIT_INPUT_DIR：
 * db.js 在模块加载时定库路径，server.js 在加载时定输出目录。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-web-test-"));
process.env.FIT_DB_PATH = path.join(tmp, "test.db");
process.env.FIT_OUTPUT_DIR = path.join(tmp, "output");
process.env.FIT_INPUT_DIR = path.join(tmp, "input");
// FTP 写回接口会改写 settings 文件：指向临时副本，隔离真实 settings.js
const FAKE_SETTINGS = path.join(tmp, "settings.js");
fs.copyFileSync(path.resolve("settings.js"), FAKE_SETTINGS);
process.env.FIT_SETTINGS_PATH = FAKE_SETTINGS;
delete process.env.FIT_AI_API_KEY; // 确保走"未配置→返回提示词"分支

const { buildRideFit } = await import("./make_test_fit.mjs");
const { createServer } = await import("../server.js");
const { closeDb, saveAiReport, listAiReports, getAiReport, upsertActivity } = await import("../db.js");

let server, base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  closeDb(); // 先释放 SQLite 句柄，Windows 上才能删库文件
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function getJson(pathname) {
  const resp = await fetch(base + pathname);
  return { status: resp.status, data: await resp.json() };
}

test("静态首页可访问", async () => {
  const resp = await fetch(base + "/");
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.match(html, /FIT/);
  assert.match(resp.headers.get("content-type"), /text\/html/);
});

test("上传合成 FIT → 分析入库并返回 summary", async () => {
  const fit = buildRideFit({ durationSec: 1800, power: 200 });
  const resp = await fetch(`${base}/api/upload?filename=${encodeURIComponent("web_test_ride.fit")}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: fit,
  });
  assert.equal(resp.status, 200);
  const { file_name, summary } = await resp.json();
  assert.equal(file_name, "web_test_ride.fit");
  assert.equal(summary.activity.sport, "cycling");
  assert.ok(summary.power.normalized_power > 150);
  // CSV 与 summary 落盘到隔离输出目录
  assert.ok(fs.existsSync(path.join(tmp, "output", "web_test_ride.records.csv")));
  assert.ok(fs.existsSync(path.join(tmp, "output", "web_test_ride.summary.json")));
});

test("概览接口包含上传的训练", async () => {
  const { status, data } = await getJson("/api/overview");
  assert.equal(status, 200);
  assert.ok(data.athlete.ftp_watts > 0);
  assert.equal(data.ai.configured, false);
  const act = data.activities.find((a) => a.file_name === "web_test_ride.fit");
  assert.ok(act, "activities 里应包含上传的文件");
  assert.ok(act.tss > 0);
});

test("详情接口返回完整 summary", async () => {
  const { status, data } = await getJson(`/api/activity?name=${encodeURIComponent("web_test_ride.fit")}`);
  assert.equal(status, 200);
  assert.ok(data.summary.power.zone_distribution_pct);
});

test("时序接口返回抽稀后的记录", async () => {
  const { status, data } = await getJson(`/api/records?name=${encodeURIComponent("web_test_ride.fit")}`);
  assert.equal(status, 200);
  assert.equal(data.total_seconds, 1800);
  // 1800 秒抽稀到 ≤1400 点：stride=2，约 900 点
  assert.ok(data.points.length >= 800 && data.points.length <= 1400);
  assert.equal(data.stride, 2);
  const p0 = data.points[0];
  assert.equal(p0.power, 200);
  assert.equal(typeof p0.t, "string");
});

test("AI 接口（未配置密钥）退回提示词模式", async () => {
  const resp = await fetch(base + "/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "review", file_name: "web_test_ride.fit" }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.configured, false);
  assert.match(data.prompt, /指标口径/);
  assert.match(data.prompt, /请回答/);
});

test("AI 接口（周期规划）可生成提示词", async () => {
  const resp = await fetch(base + "/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "plan" }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.match(data.prompt, /周期|逐月/);
});

test("路径穿越被拒绝", async () => {
  const r1 = await getJson("/api/activity?name=../settings.js");
  assert.equal(r1.status, 404);
  const r2 = await getJson("/api/records?name=..%2F..%2Fpackage.json");
  assert.equal(r2.status, 404);
});

test("不存在的训练返回 404", async () => {
  const { status } = await getJson("/api/activity?name=nope.fit");
  assert.equal(status, 404);
});

test("上传非 .fit 文件名被拒绝", async () => {
  const resp = await fetch(`${base}/api/upload?filename=evil.txt`, {
    method: "POST",
    body: "hello",
  });
  assert.equal(resp.status, 400);
});

test("AI 报告缓存：每个 mode 仅保留最近 10 条", () => {
  for (let i = 1; i <= 12; i++) {
    saveAiReport("review", { file_name: `ride_${i}.fit` }, "prompt", `report ${i}`);
  }
  const rows = listAiReports("review");
  assert.equal(rows.length, 10);
  assert.equal(rows[0].file_name, "ride_12.fit"); // 最新的在前
  const latest = getAiReport(rows[0].id);
  assert.equal(latest.markdown, "report 12");
  assert.match(latest.prompt, /prompt/);
});

test("FTP 估算接口：基于训练库骑行返回双方法估值", async () => {
  // 插入 3 次合成骑行（日期远离其他测试数据，独占估算窗口）
  const mk = (name, date) =>
    upsertActivity(name, {
      activity: { date, sport: "cycling", duration_sec: 3600, distance_km: 30 },
      power: {
        avg: 130,
        normalized_power: 130,
        intensity_factor: 1.0,
        tss: 100,
        peak_curve: { "5min": 150, "20min": 130 },
        zone_distribution_pct: { Z5: 5 },
      },
      heart_rate: { avg: 150, max: 180, zone_distribution_pct: { Z4: 5 }, hr_drift_pct: 2 },
      data_quality: { power_coverage_pct: 100, hr_coverage_pct: 100 },
    });
  mk("ftp_a.fit", "2099-01-01");
  mk("ftp_b.fit", "2099-01-02");
  mk("ftp_c.fit", "2099-01-03");
  const { status, data } = await getJson("/api/ftp-estimate");
  assert.equal(status, 200);
  assert.equal(data.status, "ok");
  assert.equal(data.sample.usable_power_rides, 3);
  // CP = (130×1200 − 150×300)/900 = 123；Coggan = 130×0.95 → 124
  assert.equal(data.estimate.methods.cp_model.ftp_w, 123);
  assert.equal(data.estimate.methods.coggan_20min.ftp_w, 124);
  assert.equal(data.estimate.ftp_w, 124);
  assert.equal(data.estimate.confidence, "high");
  assert.ok(Array.isArray(data.data_needs));
});

test("FTP 写回接口：改写 settings 副本并进程内即时生效", async () => {
  const resp = await fetch(base + "/api/ftp-apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ftp_w: 131 }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.deepEqual(data, { applied: true, ftp_w: 131 });
  // 改写的是临时副本而非真实 settings.js
  assert.match(fs.readFileSync(FAKE_SETTINGS, "utf8"), /ftp_watts: 131/);
  // 进程内 ATHLETE 立即更新（概览接口可见）
  const ov = await getJson("/api/overview");
  assert.equal(ov.data.athlete.ftp_watts, 131);
});

test("FTP 写回接口：越界数值被拒绝", async () => {
  const resp = await fetch(base + "/api/ftp-apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ftp_w: 10 }),
  });
  assert.equal(resp.status, 400);
});
