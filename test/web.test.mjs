/**
 * web.test.mjs
 * Web 服务（server.js）端到端测试：
 *   合成 FIT → POST /api/upload → 校验概览/详情/时序/AI 提示词接口与路径安全；
 *   AI 对话（ai_chats/ai_chat_messages）：db CRUD 直测 + 接口端到端（mock AI + 轮询）。
 *
 * 必须在 import server.js 之前设置 FIT_DB_PATH / FIT_OUTPUT_DIR / FIT_INPUT_DIR：
 * db.js 在模块加载时定库路径，server.js 在加载时定输出目录。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-web-test-"));
process.env.FIT_DB_PATH = path.join(tmp, "test.db");
process.env.FIT_OUTPUT_DIR = path.join(tmp, "output");
process.env.FIT_INPUT_DIR = path.join(tmp, "input");
// 临时库无 ai 配置行 → AI_CONFIG 保持出厂默认（api_key=null），走"未配置→返回提示词"分支

const { buildRideFit } = await import("./make_test_fit.mjs");
const { createServer } = await import("../server.js");
const { closeDb, saveAiReport, createPendingAiReport, updateAiReport, listAiReports, getAiReport, upsertActivity, getAthleteState, setActivityCategory, getActivitySummary, getAiConfig, migrateAiEnvToDb, createAiChat, addAiChatMessage, updateAiChatMessage, touchAiChat, listAiChats, getAiChat, findFollowUpChat, deleteAiChat, saveMemory, listMemories, listAllMemories, deleteMemory } = await import("../src/db.js");
const { buildMemorySection } = await import("../src/prompts.js");
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

test("AI 接口（已配置密钥 + mock 服务）走 agentic 工具调用完成报告", async () => {
  // mock chat/completions：首轮返回 tool_calls，次轮返回正文
  const seenBodies = [];
  const mockAi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      const msg =
        seenBodies.length === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_athlete_profile", arguments: "{}" },
                },
              ],
            }
          : { content: "agentic 复盘报告正文" };
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  await new Promise((r) => mockAi.listen(0, "127.0.0.1", r));
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${mockAi.address().port}/v1`,
    stream: false,
    agentic: true,
  });
  try {
    const resp = await fetch(base + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "review", file_name: "web_test_ride.fit" }),
    });
    assert.equal(resp.status, 202);
    const { report_id } = await resp.json();

    // 轮询报告直至 completed（后台 runAgentLoop 异步生成）
    let report;
    for (let i = 0; i < 50; i++) {
      const r = await getJson(`/api/ai/report?id=${report_id}`);
      if (r.status === 200) {
        report = r.data;
        break;
      }
      if (r.data?.status === "failed")
        assert.fail(`报告生成失败: ${r.data.error}`);
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.ok(report, "报告应在 5 秒内完成");
    assert.equal(report.status, "completed");
    assert.match(report.markdown, /agentic 复盘报告正文/);

    // 首轮请求：带 tools 定义，提示词含工具使用指引段
    assert.ok(Array.isArray(seenBodies[0].tools), "首轮应挂 tools");
    assert.match(seenBodies[0].messages[0].content, /数据查询与计算工具/);
    // 次轮请求：tool 结果以 role:"tool" 回填（get_athlete_profile 返回含 ftp_watts）
    const toolMsg = seenBodies[1].messages.at(-1);
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.match(toolMsg.content, /ftp_watts/);
  } finally {
    Object.assign(AI_CONFIG, saved);
    mockAi.close();
  }
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

// ---------------- AI 对话（阶段二：持久化 + 直接对话） ----------------

test("AI 对话 db CRUD：状态机 / 列表聚合 / findFollowUpChat / 级联删除", () => {
  const cid = createAiChat("chat", { title: "测试对话" });
  assert.ok(cid > 0);
  addAiChatMessage(cid, "user", "这周状态如何？");
  const mid = addAiChatMessage(cid, "assistant", "", "pending");
  touchAiChat(cid);

  // pending 快照 + 列表聚合
  let chat = getAiChat(cid);
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[1].status, "pending");
  let row = listAiChats("chat").find((c) => c.id === cid);
  assert.equal(row.message_count, 2);
  assert.equal(row.has_pending, true);

  // pending → completed 回填
  updateAiChatMessage(mid, { content: "TSB 为正，可以上强度", status: "completed", error: null });
  chat = getAiChat(cid);
  assert.equal(chat.messages[1].status, "completed");
  assert.match(chat.messages[1].content, /TSB/);
  row = listAiChats("chat").find((c) => c.id === cid);
  assert.equal(row.has_pending, false);

  // pending → failed 回填
  const mid2 = addAiChatMessage(cid, "assistant", "", "pending");
  updateAiChatMessage(mid2, { status: "failed", error: "AI 请求超时" });
  chat = getAiChat(cid);
  assert.equal(chat.messages[2].status, "failed");
  assert.equal(chat.messages[2].error, "AI 请求超时");

  // findFollowUpChat：取该报告最新的 follow_up 对话
  const fid = createAiChat("follow_up", { report_id: 424242, file_name: "a.fit", title: "追问" });
  assert.equal(findFollowUpChat(424242), fid);
  assert.equal(findFollowUpChat(313131), null);

  // 级联删除：对话与消息一起消失；不存在返回 0 / null
  assert.equal(deleteAiChat(fid), 1);
  assert.equal(getAiChat(fid), null);
  assert.equal(deleteAiChat(fid), 0);
  assert.equal(getAiChat(999999), null);
});

test("AI 对话滚动清理：每个 mode 仅保留最近 50 个，消息级联删除", () => {
  const firstIds = [];
  for (let i = 1; i <= 55; i++) {
    const id = createAiChat("chat", { title: `滚动 ${i}` });
    addAiChatMessage(id, "user", `问题 ${i}`);
    if (i <= 5) firstIds.push(id);
  }
  const rows = listAiChats("chat", 100);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].title, "滚动 55"); // 最新在前
  for (const id of firstIds) assert.equal(getAiChat(id), null); // 被挤出的连消息一起删
});

test("旧 POST /api/ai/follow-up 接口已删除（404）", async () => {
  const r = await fetch(base + "/api/ai/follow-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 404);
});

test("AI 对话接口校验：未配置密钥 / mode / message / 对话不存在", async () => {
  const post = (body) =>
    fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const saved = { ...AI_CONFIG };
  try {
    // 未配置密钥 → 400（前端提示去设置页配置）
    AI_CONFIG.api_key = null;
    const r0 = await post({ mode: "chat", message: "hi" });
    assert.equal(r0.status, 400);
    assert.match((await r0.json()).error, /密钥/);

    AI_CONFIG.api_key = "test-key";
    assert.equal((await post({ mode: "nope", message: "hi" })).status, 400);
    assert.equal((await post({ mode: "chat", message: "  " })).status, 400);
    assert.equal((await post({ mode: "chat", message: "x".repeat(2001) })).status, 400);
    assert.equal((await post({ mode: "chat", chat_id: 999999, message: "hi" })).status, 404);
    // GET / DELETE 参数校验
    assert.equal((await getJson("/api/ai/chat?id=abc")).status, 400);
    assert.equal((await getJson("/api/ai/chat?id=999999")).status, 404);
    assert.equal((await getJson("/api/ai/chats?mode=nope")).status, 400);
    const del = await fetch(`${base}/api/ai/chat?id=999999`, { method: "DELETE" });
    assert.equal(del.status, 404);
  } finally {
    Object.assign(AI_CONFIG, saved);
  }
});

test("AI 直接对话（mock 服务）：202 → 轮询取回答，系统段与历史消息口径正确", async () => {
  const seenBodies = [];
  const mockAi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "建议今天做二区恢复骑 60 分钟" } }] }));
    });
  });
  await new Promise((r) => mockAi.listen(0, "127.0.0.1", r));
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${mockAi.address().port}/v1`,
    stream: false,
    agentic: true,
  });
  const pollChat = async (id) => {
    for (let i = 0; i < 50; i++) {
      const resp = await fetch(`${base}/api/ai/chat?id=${id}`);
      const data = await resp.json();
      if (resp.status === 200) return data;
      if (data.messages?.some((m) => m.status === "failed"))
        assert.fail(`对话生成失败: ${data.messages.find((m) => m.status === "failed").error}`);
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.fail("对话应在 5 秒内完成");
  };
  try {
    // 新建对话 → 202 + pending 占位
    const resp = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "chat", message: "今天该怎么练？" }),
    });
    assert.equal(resp.status, 202);
    const { chat_id, message_id } = await resp.json();
    assert.ok(chat_id > 0 && message_id > 0);

    const chat = await pollChat(chat_id);
    assert.equal(chat.title, "今天该怎么练？");
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[0].role, "user");
    assert.equal(chat.messages[1].status, "completed");
    assert.match(chat.messages[1].content, /二区恢复骑/);
    assert.ok(chat.messages[1].html, "assistant completed 消息应附 marked html");

    // mock 侧：系统段 = 角色 + 指标口径 + 对话指令 + 工具指引；历史只带 user 正文
    const msgs = seenBodies[0].messages;
    assert.match(msgs[0].content, /自行车教练/);
    assert.match(msgs[0].content, /指标口径/);
    assert.match(msgs[0].content, /数据查询与计算工具/);
    assert.equal(msgs.at(-1).role, "user");
    assert.equal(msgs.at(-1).content, "今天该怎么练？");
    assert.ok(!msgs.some((m) => m.content === ""), "pending 占位不进入上下文");

    // 继续同一对话：chat_id 复用，历史带上轮问答
    const resp2 = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "chat", chat_id, message: "那明天呢？" }),
    });
    assert.equal(resp2.status, 202);
    const chat2 = await pollChat(chat_id);
    assert.equal(chat2.messages.length, 4);
    const msgs2 = seenBodies[1].messages;
    assert.ok(msgs2.some((m) => m.role === "assistant" && /二区恢复骑/.test(m.content)));

    // 对话列表包含该对话且无 pending
    const list = await getJson("/api/ai/chats?mode=chat");
    const row = list.data.chats.find((c) => c.id === chat_id);
    assert.ok(row);
    assert.equal(row.has_pending, false);
    assert.equal(row.message_count, 4);

    // 删除 → 再查 404
    const del = await fetch(`${base}/api/ai/chat?id=${chat_id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await getJson(`/api/ai/chat?id=${chat_id}`)).status, 404);
  } finally {
    Object.assign(AI_CONFIG, saved);
    mockAi.close();
  }
});

test("AI 追问（mock 服务）：报告正文 + 压缩训练数据进入提示词，report_id 可找回对话", async () => {
  const reportId = saveAiReport("review", { file_name: "web_test_ride.fit" }, "p", "# 复盘报告正文");
  const seenBodies = [];
  const mockAi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "漂移 3% 属正常范围" } }] }));
    });
  });
  await new Promise((r) => mockAi.listen(0, "127.0.0.1", r));
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${mockAi.address().port}/v1`,
    stream: false,
    agentic: true,
  });
  try {
    // 该报告还没有追问对话
    const r0 = await getJson(`/api/ai/chats?mode=follow_up&report_id=${reportId}`);
    assert.equal(r0.status, 200);
    assert.equal(r0.data.chat_id, null);

    const resp = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "follow_up",
        report_id: reportId,
        file_name: "web_test_ride.fit",
        message: "心率漂移怎么看？",
      }),
    });
    assert.equal(resp.status, 202);
    const { chat_id } = await resp.json();

    // report_id 找回既有追问对话
    const r1 = await getJson(`/api/ai/chats?mode=follow_up&report_id=${reportId}`);
    assert.equal(r1.data.chat_id, chat_id);

    // 轮询取回答
    let chat;
    for (let i = 0; i < 50; i++) {
      const resp2 = await fetch(`${base}/api/ai/chat?id=${chat_id}`);
      const data = await resp2.json();
      if (resp2.status === 200) { chat = data; break; }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.ok(chat, "追问应在 5 秒内完成");
    assert.match(chat.messages[1].content, /漂移 3%/);

    // mock 侧系统段：≤200 字快答指令 + 工具查询不计字数 + 报告正文 + 压缩训练数据
    const sys = seenBodies[0].messages[0].content;
    assert.match(sys, /200 字以内/);
    assert.match(sys, /工具查询/);
    assert.match(sys, /复盘报告正文/);
    assert.match(sys, /本次训练数据/);
  } finally {
    Object.assign(AI_CONFIG, saved);
    mockAi.close();
  }
});

// ---------------- AI 记忆（阶段三） ----------------

test("AI 记忆 db CRUD：校验 / 非法 category 归 general / 取代链 / 删除", () => {
  // 校验：空内容与超长
  assert.throws(() => saveMemory({ content: "" }), /不能为空/);
  assert.throws(() => saveMemory({ content: "x".repeat(501) }), /500/);
  assert.throws(() => saveMemory({ content: "ok", supersedes_id: 999999 }), /不存在/);

  // 非法 category 归 general
  const id1 = saveMemory({ content: "用户右膝有旧伤，长时间高扭矩不适", category: "nonsense", source: "chat" });
  assert.ok(id1 > 0);

  // 取代链：新记忆取代旧记忆，旧记忆标记 superseded_by 且不再注入
  const id2 = saveMemory({ content: "用户膝盖已康复，可正常高扭矩训练", category: "injury", source: "chat", supersedes_id: id1 });
  const all = listAllMemories();
  const m1 = all.find((m) => m.id === id1);
  const m2 = all.find((m) => m.id === id2);
  assert.equal(m1.active, false);
  assert.equal(m1.superseded_by, id2);
  assert.equal(m1.category, "general"); // 非法 category 已归 general
  assert.equal(m2.active, true);
  assert.equal(m2.category, "injury");
  const active = listMemories();
  assert.ok(!active.some((m) => m.id === id1), "被取代的记忆不应注入");
  assert.ok(active.some((m) => m.id === id2));

  // 删除：存在删 1，再删 0
  assert.equal(deleteMemory(id2), 1);
  assert.equal(deleteMemory(id2), 0);
  deleteMemory(id1); // 清理残留，避免影响后续滚动清理测试
});

test("AI 记忆滚动清理：超过 100 条先删最旧已取代，不足再删最旧有效；注入限 30 条", () => {
  // 先清掉可能残留的已取代记忆，保证计数可控
  for (const m of listAllMemories().filter((m) => !m.active)) deleteMemory(m.id);

  // 造 3 条已取代记忆
  const supersededIds = [];
  for (let i = 0; i < 3; i++) {
    const a = saveMemory({ content: `旧事实 ${i}` });
    saveMemory({ content: `新事实 ${i}`, supersedes_id: a });
    supersededIds.push(a);
  }
  // 补有效记忆使总数超出 100 共 3 条 → 恰好清掉 3 条最旧已取代
  const nowCount = listAllMemories().length;
  const need = 100 - nowCount + 3;
  for (let i = 0; i < need; i++) saveMemory({ content: `有效记忆 ${i}` });
  let all = listAllMemories();
  assert.equal(all.length, 100);
  for (const id of supersededIds)
    assert.ok(!all.some((m) => m.id === id), "已取代记忆应被优先清理");

  // 已取代耗尽后再溢出 → 删最旧有效记忆
  const oldestValid = all.map((m) => m.id).slice(-2); // id DESC 末尾两条 = 最旧
  saveMemory({ content: "溢出 1" });
  saveMemory({ content: "溢出 2" });
  all = listAllMemories();
  assert.equal(all.length, 100);
  for (const id of oldestValid)
    assert.ok(!all.some((m) => m.id === id), "已取代不足时应删最旧有效记忆");

  // 注入上限：100 条有效记忆只取最近 30 条
  assert.equal(listMemories().length, 30);
  assert.equal(listMemories(5).length, 5);
});

test("buildMemorySection：空记忆返回空串，非空含日期标注 / 冲突规则 / save_memory 指引", () => {
  assert.equal(buildMemorySection([]), "");
  assert.equal(buildMemorySection(null), "");
  // listMemories 返回 id DESC，段落内应反转为时间正序
  const s = buildMemorySection([
    { id: 8, content: "用户目标改到 10 月 granfondo", category: "goal", created_at: "2026-07-02 09:00:00" },
    { id: 7, content: "用户右膝有旧伤", category: "injury", created_at: "2026-07-01 10:00:00" },
  ]);
  assert.match(s, /用户记忆/);
  assert.match(s, /\[2026-07-01\] \(#7, 伤病\) 用户右膝有旧伤/);
  assert.match(s, /\[2026-07-02\] \(#8, 目标\)/);
  assert.ok(s.indexOf("#7") < s.indexOf("#8"), "应按日期正序");
  assert.match(s, /最新者为准/);
  assert.match(s, /save_memory/);
  assert.match(s, /supersedes_id/);
});

test("AI 记忆 e2e：save_memory 工具入库带 source，memories 接口与删除", async () => {
  // mock chat/completions：首轮返回 save_memory tool_calls，次轮返回正文
  const seenBodies = [];
  const mockAi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      const msg =
        seenBodies.length === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: "call_m1",
                  type: "function",
                  function: {
                    name: "save_memory",
                    arguments: JSON.stringify({
                      content: "用户下周出差只能骑台子",
                      category: "schedule",
                    }),
                  },
                },
              ],
            }
          : { content: "已记下，出差期间给你安排台子训练" };
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  await new Promise((r) => mockAi.listen(0, "127.0.0.1", r));
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${mockAi.address().port}/v1`,
    stream: false,
    agentic: true,
  });
  let memId = null;
  try {
    // 直接对话触发 save_memory（source 应为 chat）
    const resp = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "chat", message: "下周出差只能骑台子，帮我记着" }),
    });
    assert.equal(resp.status, 202);
    const { chat_id } = await resp.json();
    for (let i = 0; i < 50; i++) {
      const r = await fetch(`${base}/api/ai/chat?id=${chat_id}`);
      if (r.status === 200) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }

    // 记忆已入库，source/category 正确
    const mem = (await getJson("/api/ai/memories")).data.memories.find((m) =>
      /出差只能骑台子/.test(m.content),
    );
    assert.ok(mem, "memories 接口应返回新记忆");
    memId = mem.id;
    assert.equal(mem.source, "chat");
    assert.equal(mem.category, "schedule");
    assert.equal(mem.active, true);

    // 次轮请求：save_memory 结果以 role:"tool" 回填（含 memory_id）
    const toolMsg = seenBodies[1].messages.at(-1);
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "call_m1");
    assert.match(toolMsg.content, /memory_id/);

    // 删除 → 列表消失；再删 404；非法 id 400
    const del = await fetch(`${base}/api/ai/memory?id=${memId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    memId = null;
    assert.ok(
      !(await getJson("/api/ai/memories")).data.memories.some((m) => m.id === mem.id),
    );
    const del2 = await fetch(`${base}/api/ai/memory?id=${mem.id}`, { method: "DELETE" });
    assert.equal(del2.status, 404);
    const delBad = await fetch(`${base}/api/ai/memory?id=abc`, { method: "DELETE" });
    assert.equal(delBad.status, 400);
  } finally {
    if (memId != null) deleteMemory(memId);
    Object.assign(AI_CONFIG, saved);
    mockAi.close();
  }
});

test("simulate_form 工具 e2e：mock AI 发起负荷推演，结果回填且回答落库", async () => {
  // mock chat/completions：首轮返回 simulate_form tool_calls，次轮返回正文
  const seenBodies = [];
  const mockAi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      const msg =
        seenBodies.length === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: "call_s1",
                  type: "function",
                  function: {
                    name: "simulate_form",
                    arguments: JSON.stringify({
                      plan: [
                        { date: "2026-08-01", tss: 60 },
                        { date: "2026-08-02", tss: 0 },
                        { date: "2026-08-03", tss: 80 },
                      ],
                    }),
                  },
                },
              ],
            }
          : { content: "按计划推演，CTL 会缓慢上升，无风险" };
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  await new Promise((r) => mockAi.listen(0, "127.0.0.1", r));
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${mockAi.address().port}/v1`,
    stream: false,
    agentic: true,
  });
  try {
    const resp = await fetch(base + "/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "chat", message: "接下来三天这么练，状态会怎么变" }),
    });
    assert.equal(resp.status, 202);
    const { chat_id } = await resp.json();
    let detail = null;
    for (let i = 0; i < 50; i++) {
      const r = await fetch(`${base}/api/ai/chat?id=${chat_id}`);
      if (r.status === 200) {
        detail = await r.json();
        break;
      }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.ok(detail, "应轮询到完成的对话");

    // 首轮请求应携带 simulate_form / generate_workout 工具定义
    const toolNames = (seenBodies[0].tools ?? []).map((t) => t.function.name);
    assert.ok(toolNames.includes("simulate_form"));
    assert.ok(toolNames.includes("generate_workout"));

    // 次轮请求：推演结果以 role:"tool" 回填（含 projection / end_form / risk_flags）
    const toolMsg = seenBodies[1].messages.at(-1);
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "call_s1");
    const payload = JSON.parse(toolMsg.content.replace("（结果已截断）", ""));
    assert.equal(payload.projection.length, 3);
    assert.deepEqual(payload.projection[0].slice(1), [1.4, 8.6, -7.1]); // start 0/0：ctl=60/42，atl=60/7，tsb 取未舍入差值
    assert.ok(payload.end_form);
    assert.ok(Array.isArray(payload.risk_flags));

    // 最终回答落库
    const last = detail.messages.at(-1);
    assert.equal(last.role, "assistant");
    assert.equal(last.status, "completed");
    assert.match(last.content, /CTL 会缓慢上升/);
  } finally {
    Object.assign(AI_CONFIG, saved);
    mockAi.close();
  }
});

test("AI 报告生成：提示词注入用户记忆段（mock 侧断言请求体）", async () => {
  const mid = saveMemory({ content: "用户目标是 10 月 granfondo 完赛", category: "goal", source: "chat" });
  const seenBodies = [];
  const mockAi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBodies.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "复盘正文" } }] }));
    });
  });
  await new Promise((r) => mockAi.listen(0, "127.0.0.1", r));
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${mockAi.address().port}/v1`,
    stream: false,
    agentic: true,
  });
  try {
    const resp = await fetch(base + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "review", file_name: "web_test_ride.fit" }),
    });
    assert.equal(resp.status, 202);
    const { report_id } = await resp.json();
    for (let i = 0; i < 50; i++) {
      const r = await getJson(`/api/ai/report?id=${report_id}`);
      if (r.status === 200) break;
      if (r.data?.status === "failed") assert.fail(`报告生成失败: ${r.data.error}`);
      await new Promise((r2) => setTimeout(r2, 100));
    }
    // 报告提示词末尾含记忆段（日期标注 + 记忆内容）
    const promptSent = seenBodies[0].messages[0].content;
    assert.match(promptSent, /用户记忆/);
    assert.match(promptSent, /granfondo 完赛/);
  } finally {
    deleteMemory(mid);
    Object.assign(AI_CONFIG, saved);
    mockAi.close();
  }
});
