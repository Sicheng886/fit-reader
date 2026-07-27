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
// 临时库无 ai 配置行 → AI_CONFIG 保持出厂默认（api_key=null），走"未配置→返回提示词"分支

const { buildRideFit } = await import("./make_test_fit.mjs");
const { createServer } = await import("../server.js");
const { closeDb, saveAiReport, createPendingAiReport, updateAiReport, listAiReports, getAiReport, upsertActivity, getAthleteState, setActivityCategory, getActivitySummary, getAiConfig, migrateAiEnvToDb } = await import("../src/db.js");
const { AI_CONFIG } = await import("../src/settings.js");

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
  // 分区具体范围：按 athlete_context 的骑手参数换算（Z7/Z5 上限为 ∞ 时给 "下限+"）
  const ftp = data.summary.athlete_context.ftp_watts;
  const maxHr = data.summary.athlete_context.max_hr;
  assert.equal(data.zone_ranges.power.Z2, `${Math.round(0.55 * ftp)}-${Math.round(0.75 * ftp)}`);
  assert.equal(data.zone_ranges.power.Z7, `${Math.round(1.5 * ftp)}+`);
  assert.equal(data.zone_ranges.hr.Z2, `${Math.round(0.68 * maxHr)}-${Math.round(0.75 * maxHr)}`);
  assert.equal(data.zone_ranges.hr.Z5, `${Math.round(0.92 * maxHr)}+`);
});

test("训练分类可标记并在 summary 中合并", async () => {
  const r1 = await getJson(`/api/activity?name=${encodeURIComponent("web_test_ride.fit")}`);
  assert.equal(r1.data.summary.activity.category, "training");

  const post = await fetch(`${base}/api/activity/category`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web_test_ride.fit", category: "race" }),
  });
  assert.equal(post.status, 200);

  const r2 = await getJson(`/api/activity?name=${encodeURIComponent("web_test_ride.fit")}`);
  assert.equal(r2.data.summary.activity.category, "race");

  // 非法分类返回 400
  const bad = await fetch(`${base}/api/activity/category`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web_test_ride.fit", category: "invalid" }),
  });
  assert.equal(bad.status, 400);
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
  assert.equal(p0.temperature, 25);
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

test("AI 报告缓存：每个 mode 仅保留最近 30 条", () => {
  for (let i = 1; i <= 35; i++) {
    saveAiReport("review", { file_name: `ride_${i}.fit` }, "prompt", `report ${i}`);
  }
  const rows = listAiReports("review");
  assert.equal(rows.length, 30);
  assert.equal(rows[0].file_name, "ride_35.fit"); // 最新的在前
  const latest = getAiReport(rows[0].id);
  assert.equal(latest.status, "completed");
  assert.equal(latest.markdown, "report 35");
  assert.match(latest.prompt, /prompt/);
});

test("AI 报告状态：pending 创建、update 回填、接口按状态返回", async () => {
  const pendingId = createPendingAiReport("taper", { race_date: "2099-01-01" }, "taper prompt");
  const completedId = createPendingAiReport("review", { file_name: "status_ride.fit" }, "review prompt");
  updateAiReport(completedId, { markdown: "report body", status: "completed", error: null });
  const failedId = createPendingAiReport("plan", {}, "plan prompt");
  updateAiReport(failedId, { status: "failed", error: "AI 请求超时" });

  // listAiReports 应返回 status / error
  const reviewRows = listAiReports("review");
  const completed = reviewRows.find((r) => r.id === completedId);
  assert.ok(completed);
  assert.equal(completed.status, "completed");
  assert.equal(completed.error, null);

  const planRows = listAiReports("plan");
  const failed = planRows.find((r) => r.id === failedId);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "AI 请求超时");

  // GET /api/ai/report 按状态返回不同 HTTP 码
  const rPending = await getJson(`/api/ai/report?id=${pendingId}`);
  assert.equal(rPending.status, 202);
  assert.equal(rPending.data.status, "pending");

  const rCompleted = await getJson(`/api/ai/report?id=${completedId}`);
  assert.equal(rCompleted.status, 200);
  assert.equal(rCompleted.data.status, "completed");
  assert.ok(rCompleted.data.html);

  const rFailed = await getJson(`/api/ai/report?id=${failedId}`);
  assert.equal(rFailed.status, 502);
  assert.equal(rFailed.data.status, "failed");
  assert.equal(rFailed.data.error, "AI 请求超时");
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

test("骑手参数接口：未配置时返回默认值 + configured=false", async () => {
  const { status, data } = await getJson("/api/athlete");
  assert.equal(status, 200);
  assert.equal(data.configured, false); // 临时库无 athlete 行
  assert.ok(data.athlete.ftp_watts > 0); // 回落到 settings.js 出厂默认值
});

test("FTP 写回接口：写入训练库并进程内即时生效", async () => {
  const resp = await fetch(base + "/api/ftp-apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ftp_w: 131 }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.deepEqual(data, { applied: true, ftp_w: 131 });
  // 写入训练库 settings 表（configured 变为 true）
  const st = getAthleteState();
  assert.equal(st.configured, true);
  assert.equal(st.athlete.ftp_watts, 131);
  // 进程内 ATHLETE 立即更新（概览接口可见）
  const ov = await getJson("/api/overview");
  assert.equal(ov.data.athlete.ftp_watts, 131);
  assert.equal(ov.data.athlete_configured, true);
});

test("骑手参数接口：合法全量与部分更新", async () => {
  const post = (body) =>
    fetch(base + "/api/athlete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  // 全量更新
  const r1 = await post({ ftp_watts: 140, max_hr: 190, weight_kg: 62.5 });
  assert.equal(r1.status, 200);
  const d1 = await r1.json();
  assert.equal(d1.applied, true);
  assert.deepEqual(d1.athlete, { ftp_watts: 140, max_hr: 190, weight_kg: 62.5 });
  // 部分更新：只改体重，其余保留
  const r2 = await post({ weight_kg: 61 });
  assert.equal(r2.status, 200);
  assert.deepEqual((await r2.json()).athlete, { ftp_watts: 140, max_hr: 190, weight_kg: 61 });
  // GET 视角与库一致
  const g = await getJson("/api/athlete");
  assert.equal(g.data.configured, true);
  assert.equal(g.data.athlete.weight_kg, 61);
});

test("骑手参数接口：非法值与空更新被拒绝", async () => {
  const post = (body) =>
    fetch(base + "/api/athlete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ ftp_watts: 10 })).status, 400);
  assert.equal((await post({ max_hr: 999 })).status, 400);
  assert.equal((await post({ weight_kg: -5 })).status, 400);
  assert.equal((await post({})).status, 400);
});

test("FTP 写回接口：越界数值被拒绝", async () => {
  const resp = await fetch(base + "/api/ftp-apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ftp_w: 10 }),
  });
  assert.equal(resp.status, 400);
});

test("AI 配置迁移：老版本 FIT_AI_* 环境变量一次性迁入训练库", () => {
  // 此刻临时库尚无 ai 行；模拟老版本 env 注入后的进程状态
  process.env.FIT_AI_API_KEY = "sk-migrated";
  process.env.FIT_AI_BASE_URL = "https://example.com/v1/";
  process.env.FIT_AI_MODEL = "old-model";
  process.env.FIT_AI_STREAM = "true";
  try {
    assert.equal(migrateAiEnvToDb(), true);
    // 已写库并原地生效（base_url 尾部斜杠被规整）
    assert.equal(AI_CONFIG.api_key, "sk-migrated");
    assert.equal(AI_CONFIG.base_url, "https://example.com/v1");
    assert.equal(AI_CONFIG.model, "old-model");
    assert.equal(AI_CONFIG.stream, true);
    assert.equal(getAiConfig().configured, true);
    // 库中已有 ai 行后不再重复迁移
    process.env.FIT_AI_API_KEY = "sk-other";
    assert.equal(migrateAiEnvToDb(), false);
    assert.equal(AI_CONFIG.api_key, "sk-migrated");
  } finally {
    delete process.env.FIT_AI_API_KEY;
    delete process.env.FIT_AI_BASE_URL;
    delete process.env.FIT_AI_MODEL;
    delete process.env.FIT_AI_STREAM;
  }
});

test("AI 配置接口：查询、校验、更新并即时生效", async () => {
  const post = (body) =>
    fetch(base + "/api/ai-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  // GET 返回当前生效配置（上一个用例迁移进来的值）
  const g = await getJson("/api/ai-config");
  assert.equal(g.status, 200);
  assert.equal(g.data.config.api_key, "sk-migrated");
  assert.equal(g.data.configured, true);
  // 非法值 400
  assert.equal((await post({ base_url: "not-a-url" })).status, 400);
  assert.equal((await post({ model: "  " })).status, 400);
  assert.equal((await post({ temperature: 9 })).status, 400);
  assert.equal((await post({ timeout_ms: 100 })).status, 400);
  assert.equal((await post({})).status, 400);
  // 合法部分更新：改密钥与模型，其余保留
  const r = await post({ api_key: "sk-new", model: "kimi-k2.6" });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.config.api_key, "sk-new");
  assert.equal(d.config.model, "kimi-k2.6");
  assert.equal(d.config.base_url, "https://example.com/v1"); // 未给的字段保留
  // 进程内即时生效：概览 ai 状态与 isAiConfigured 视角一致
  const ov = await getJson("/api/overview");
  assert.equal(ov.data.ai.configured, true);
  assert.equal(ov.data.ai.model, "kimi-k2.6");
  // 清空密钥 → 退回未配置（复制提示词模式）
  const r2 = await post({ api_key: "" });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).config.api_key, null);
  assert.equal(getAiConfig().configured, false);
  const ov2 = await getJson("/api/overview");
  assert.equal(ov2.data.ai.configured, false);
});

test("训练备注：保存/合并进 summary/进入复盘提示词/清除与校验", async () => {
  const post = (body) =>
    fetch(`${base}/api/activity/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  // 保存备注
  const r = await post({ name: "web_test_ride.fit", note: "体感不错，顺风路况好" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).note, "体感不错，顺风路况好");
  // 详情接口把 note 合并进 summary.activity
  const d = await getJson(`/api/activity?name=${encodeURIComponent("web_test_ride.fit")}`);
  assert.equal(d.data.summary.activity.note, "体感不错，顺风路况好");
  // 复盘提示词纳入备注并要求结合分析
  const ai = await (
    await fetch(base + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "review", file_name: "web_test_ride.fit" }),
    })
  ).json();
  assert.match(ai.prompt, /体感不错，顺风路况好/);
  assert.match(ai.prompt, /备注/);
  // 过长 400、不存在的训练 404
  assert.equal((await post({ name: "web_test_ride.fit", note: "x".repeat(2001) })).status, 400);
  assert.equal((await post({ name: "nope.fit", note: "a" })).status, 404);
  // 纯空白 = 清除备注
  const clr = await post({ name: "web_test_ride.fit", note: "   " });
  assert.equal(clr.status, 200);
  assert.equal((await clr.json()).note, null);
  const d2 = await getJson(`/api/activity?name=${encodeURIComponent("web_test_ride.fit")}`);
  assert.equal(d2.data.summary.activity.note, undefined);
});

test("用户背景与训练目标：设置后进入 AI 提示词，可清空", async () => {
  const post = (body) =>
    fetch(base + "/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  // 默认未配置
  const g0 = await getJson("/api/profile");
  assert.equal(g0.status, 200);
  assert.equal(g0.data.configured, false);
  // 非法：超长 400
  assert.equal((await post({ identity: "x".repeat(101) })).status, 400);
  assert.equal((await post({ goal: "x".repeat(501) })).status, 400);
  // 设置身份与目标
  const r = await post({ identity: "上班族", goal: "半年内 FTP 提升到 250W" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).profile.configured, true);
  // 部分更新：只改目标，身份保留
  await post({ goal: "备战 10 月 granfondo" });
  const g = await getJson("/api/profile");
  assert.equal(g.data.identity, "上班族");
  assert.equal(g.data.goal, "备战 10 月 granfondo");
  // 复盘提示词包含用户背景段
  const ai = await (
    await fetch(base + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "review", file_name: "web_test_ride.fit" }),
    })
  ).json();
  assert.match(ai.prompt, /用户背景与训练目标/);
  assert.match(ai.prompt, /上班族/);
  assert.match(ai.prompt, /granfondo/);
  // 周期规划提示词同样包含
  const plan = await (
    await fetch(base + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    })
  ).json();
  assert.match(plan.prompt, /用户背景与训练目标/);
  // 清空 → 未配置，提示词不再含背景段
  await post({ identity: "", goal: "" });
  const g2 = await getJson("/api/profile");
  assert.equal(g2.data.configured, false);
  const ai2 = await (
    await fetch(base + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "review", file_name: "web_test_ride.fit" }),
    })
  ).json();
  assert.doesNotMatch(ai2.prompt, /用户背景与训练目标/);
});
