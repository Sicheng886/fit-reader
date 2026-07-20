/**
 * server.js
 * Web 界面（P4）：本地 HTTP 服务，零第三方依赖（Node 内置 http/fs）。
 * 提供：
 *   - 静态前端（web/ 目录：训练库仪表盘 + 单次训练详情 + 上传分析 + AI 报告）
 *   - REST API：
 *       GET  /api/overview              仪表盘数据（骑手参数/月汇总/趋势/训练清单/AI 配置状态）
 *       GET  /api/activity?name=x.fit   单次训练完整 summary JSON
 *       GET  /api/records?name=x.fit    逐秒时序（抽稀到 ≤1400 点，供前端画图）
 *       POST /api/upload?filename=x.fit 上传 FIT（原始字节作 body）→ 分析并入库 → 返回 summary
 *       POST /api/ai                    AI 报告：{mode:'review'|'plan'|'taper'|'compare', ...}
 *                                       未配置 FIT_AI_API_KEY 时返回提示词供手动复制
 *
 * 运行：npm run web（默认 http://localhost:3000，PORT 环境变量可改端口）
 * 输出目录用 FIT_OUTPUT_DIR 覆盖（默认 ./output，测试隔离用）。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFile } from "./index.js";
import {
  listActivities,
  getActivitySummary,
  monthlySummary,
  trendMonthly,
  recentFormDaily,
  recentActivities,
  computeForm,
} from "./db.js";
import {
  buildReviewPrompt,
  buildPlanPrompt,
  buildTaperPrompt,
  buildComparePrompt,
  thinToWeekly,
} from "./prompts.js";
import { callAI, isAiConfigured, aiConfigInfo } from "./ai.js";
import { ATHLETE } from "./settings.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, "web");
const OUTPUT_DIR = path.resolve(process.env.FIT_OUTPUT_DIR || "output");
const INPUT_DIR = path.resolve(process.env.FIT_INPUT_DIR || "input");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------------- 小工具 ----------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/** 文件名安全化：只取 basename，防止路径穿越 */
function safeName(name) {
  if (!name || typeof name !== "string") return null;
  const base = path.basename(name);
  return base === name && !base.includes("..") ? base : null;
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 解析 records CSV → 抽稀后的时序数组（前端画图用，null 表示缺口） */
function loadRecords(fileName, maxPoints = 1400) {
  const base = path.basename(fileName, path.extname(fileName));
  const csvPath = path.join(OUTPUT_DIR, `${base}.records.csv`);
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  const rows = lines.slice(1); // 跳过表头
  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const num = (s) => (s === "" ? null : Number(s));
  const out = [];
  for (let i = 0; i < rows.length; i += stride) {
    const c = rows[i].split(",");
    out.push({
      t: c[0],
      power: num(c[1]),
      heart_rate: num(c[2]),
      cadence: num(c[3]),
      altitude: num(c[4]),
      speed: num(c[5]),
      distance_m: num(c[6]),
    });
  }
  return { points: out, total_seconds: rows.length, stride };
}

/** 组装 AI 提示词（复用 P2 模板），返回 { prompt } 或抛出带 message 的错误 */
function buildPromptForMode(body) {
  const mode = body?.mode;
  if (mode === "review") {
    const name = safeName(body.file_name);
    const summary = name && getActivitySummary(name);
    if (!summary) throw new Error(`训练库中找不到: ${body.file_name ?? "(未提供)"}`);
    return buildReviewPrompt(summary);
  }
  if (mode === "plan") {
    const daily = recentFormDaily(56);
    if (!daily.length) throw new Error("训练库为空");
    return buildPlanPrompt({
      months: monthlySummary(3),
      formSeries: thinToWeekly(daily),
      recentActivities: recentActivities(10),
    });
  }
  if (mode === "taper") {
    const raceDate = body.race_date;
    if (!raceDate || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate))
      throw new Error("race_date 需为 YYYY-MM-DD");
    const today = new Date().toISOString().slice(0, 10);
    const form = computeForm(today);
    if (!form) throw new Error("训练库为空");
    const daysLeft = Math.round(
      (new Date(raceDate + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000,
    );
    return buildTaperPrompt({
      raceDate,
      daysLeft,
      form,
      formSeries: thinToWeekly(recentFormDaily(56)),
      recentActivities: recentActivities(10),
    });
  }
  if (mode === "compare") {
    const a = safeName(body.file_name);
    const b = safeName(body.compare_with);
    const sa = a && getActivitySummary(a);
    const sb = b && getActivitySummary(b);
    if (!sa || !sb) throw new Error("对比训练在训练库中找不到");
    return buildComparePrompt(sa, sb);
  }
  throw new Error(`未知 mode: ${mode}`);
}

// ---------------- 请求处理 ----------------

async function handleApi(req, res, url) {
  // GET /api/overview
  if (req.method === "GET" && url.pathname === "/api/overview") {
    sendJson(res, 200, {
      athlete: ATHLETE,
      ai: aiConfigInfo(),
      monthly: monthlySummary(6),
      trend: trendMonthly(),
      form_daily: recentFormDaily(90),
      activities: listActivities(100),
    });
    return;
  }

  // GET /api/activity?name=x.fit
  if (req.method === "GET" && url.pathname === "/api/activity") {
    const name = safeName(url.searchParams.get("name"));
    const summary = name && getActivitySummary(name);
    if (!summary) return sendJson(res, 404, { error: "训练不存在" });
    sendJson(res, 200, { file_name: name, summary });
    return;
  }

  // GET /api/records?name=x.fit
  if (req.method === "GET" && url.pathname === "/api/records") {
    const name = safeName(url.searchParams.get("name"));
    const data = name && loadRecords(name);
    if (!data)
      return sendJson(res, 404, { error: "时序数据不存在（可能分析时输出目录不同）" });
    sendJson(res, 200, data);
    return;
  }

  // POST /api/upload?filename=x.fit（body 为 FIT 原始字节）
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const name = safeName(url.searchParams.get("filename"));
    if (!name || !name.toLowerCase().endsWith(".fit"))
      return sendJson(res, 400, { error: "filename 需为 .fit 文件" });
    const buf = await readBody(req);
    if (!buf.length) return sendJson(res, 400, { error: "空文件" });
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const fitPath = path.join(INPUT_DIR, name);
    fs.writeFileSync(fitPath, buf);
    try {
      const { summary } = await analyzeFile(fitPath, OUTPUT_DIR);
      sendJson(res, 200, { file_name: name, summary });
    } catch (e) {
      fs.rmSync(fitPath, { force: true }); // 分析失败的文件不留档
      sendJson(res, 422, { error: `解析失败: ${e.message}` });
    }
    return;
  }

  // POST /api/ai  {mode, file_name?, compare_with?, race_date?}
  if (req.method === "POST" && url.pathname === "/api/ai") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    let prompt;
    try {
      prompt = buildPromptForMode(body);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!isAiConfigured()) {
      // 未配置密钥：退回 P2 模式，把提示词给前端供手动复制
      return sendJson(res, 200, { configured: false, prompt });
    }
    try {
      const markdown = await callAI(prompt);
      sendJson(res, 200, { configured: true, markdown });
    } catch (e) {
      sendJson(res, 502, { error: `AI 调用失败: ${e.message}`, prompt });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(WEB_DIR, path.normalize(p));
  if (!filePath.startsWith(WEB_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else if (req.method === "GET") serveStatic(req, res, url);
      else sendJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

// 仅当作为入口脚本直接运行时启动监听（被测试 import 时不触发）
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer().listen(PORT, () => {
    console.log(`fit-reader Web 界面: http://localhost:${PORT}`);
    if (!isAiConfigured())
      console.log("提示: 未配置 FIT_AI_API_KEY，AI 报告将退化为复制提示词模式");
  });
}
