/**
 * server.js
 * Web 界面（P4）：本地 HTTP 服务，零第三方依赖（Node 内置 http/fs）。
 * 提供：
 *   - 静态前端（web/ 目录：训练库仪表盘 + 单次训练详情 + 上传分析 + AI 报告）
 *   - REST API：
 *       GET  /api/overview              仪表盘数据（骑手参数/月汇总/趋势/训练清单/AI 配置状态）
 *       GET  /api/athlete               当前骑手参数（库值覆盖 settings.js 默认值 + configured 标记）
 *       POST /api/athlete               {ftp_watts?, max_hr?, weight_kg?} 更新骑手参数（写训练库并即时生效）
 *       GET  /api/ai-config             当前 AI 服务配置（库值覆盖默认值）
 *       POST /api/ai-config             {api_key?, base_url?, model?, ...} 更新 AI 配置（写训练库并即时生效）
 *       GET  /api/activity?name=x.fit   单次训练完整 summary JSON
 *       POST /api/activity/category     {name, category} 标记训练分类（训练/比赛/恢复/休闲）
 *       POST /api/activity/note         {name, note} 保存训练备注（体感/路况等，AI 复盘纳入考量）
 *       GET  /api/profile               用户背景与训练目标（identity / goal / configured）
 *       POST /api/profile               {identity?, goal?} 更新用户背景与训练目标（写训练库，AI 报告纳入考量）
 *       GET  /api/records?name=x.fit    逐秒时序（抽稀到 ≤1400 点，供前端画图）
 *       POST /api/upload?filename=x.fit 上传 FIT（原始字节作 body）→ 分析并入库 → 返回 summary
 *       GET  /api/ftp-estimate          基于最近窗口期骑行（功率峰曲线+心率交叉验证）科学估算 FTP
 *       POST /api/ftp-apply             {ftp_w} 把估算 FTP 写入训练库骑手参数并立即生效
 *       POST /api/ai                    AI 报告：{mode:'review'|'plan'|'taper'|'compare', ...}
 *                                       未配置 AI 密钥时返回提示词供手动复制
 *       POST /api/ai/chat               AI 对话：{chat_id?, mode:'follow_up'|'chat', message, report_id?, file_name?}
 *                                       落库 user 消息 + pending 占位 → 202，后台生成回填
 *       GET  /api/ai/chat?id=           对话详情（含消息；有 pending 时返回 202 快照供轮询）
 *       GET  /api/ai/chats?mode=        对话列表（可选 report_id 找回该报告的追问对话）
 *       DELETE /api/ai/chat?id=         删除整个对话及其全部消息
 *       GET  /api/ai/memories           全部 AI 记忆（含已被取代的，设置页管理用）
 *       DELETE /api/ai/memory?id=       删除指定记忆
 *
 * 运行：npm run web（默认 http://localhost:3000，PORT 环境变量可改端口）
 * 输出目录用 FIT_OUTPUT_DIR 覆盖（默认 ./output，测试隔离用）。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { analyzeFile } from "./index.js";
import {
  listActivities,
  getActivitySummary,
  saveAiReport,
  createPendingAiReport,
  updateAiReport,
  listAiReports,
  getAiReport,
  monthlySummary,
  trendMonthly,
  recentFormDaily,
  recentActivities,
  computeForm,
  cyclingSummariesSince,
  syncAthleteFromDb,
  getAthleteState,
  setAthlete,
  syncAiConfigFromDb,
  migrateAiEnvToDb,
  getAiConfig,
  setAiConfig,
  setActivityCategory,
  isValidCategory,
  setActivityNote,
  getProfile,
  setProfile,
  createAiChat,
  addAiChatMessage,
  updateAiChatMessage,
  touchAiChat,
  listAiChats,
  getAiChat,
  findFollowUpChat,
  deleteAiChat,
  listMemories,
  listAllMemories,
  deleteMemory,
} from "./src/db.js";
import {
  buildReviewPrompt,
  buildPlanPrompt,
  buildTaperPrompt,
  buildComparePrompt,
  buildAgenticSection,
  buildChatInstruction,
  buildMemorySection,
  buildMetricGlossary,
  buildProfileSection,
  compactSummaryForPrompt,
  thinToWeekly,
  ROLE,
} from "./src/prompts.js";
import { callAI, runAgentLoop, isAiConfigured, aiConfigInfo } from "./src/ai.js";
import { buildSkillsSection } from "./src/skills.js";
import { TOOL_DEFS, executeTool } from "./src/tools.js";
import { loadRecords, safeName } from "./src/records.js";
import { AI_CONFIG, ATHLETE, FTP_ESTIMATION, POWER_ZONES, HR_ZONES } from "./src/settings.js";
import { estimateFtpFromHistory } from "./src/ftp.js";

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
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------------- 小工具 ----------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/** 分区定义 × 基准值（FTP/最大心率）→ 各区具体范围文本，如 { Z2: "72-98", Z7: "195+" } */
function zoneRanges(zones, base) {
  const out = {};
  for (const z of zones) {
    const lo = Math.round(z.min * base);
    out[z.name] = z.max === Infinity ? `${lo}+` : `${lo}-${Math.round(z.max * base)}`;
  }
  return out;
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

/**
 * AI 调用统一入口：agentic 开启（AI_CONFIG.agentic，默认开）时走 runAgentLoop
 * 并挂训练库查询工具（function calling），工具调用与降级记服务日志；
 * 关闭时维持原单轮 callAI（含流式设置）。
 * source 为场景标记（review/plan/taper/compare/follow_up/chat），透传给
 * save_memory 工具写入 ai_memories.source。
 */
function callAiMaybeAgentic(messages, { onChunk, onHeartbeat, source } = {}) {
  if (AI_CONFIG.agentic !== false) {
    return runAgentLoop(messages, TOOL_DEFS, (name, args) => executeTool(name, args, { source }), {
      onHeartbeat,
      onToolCall: (name, args, result) => {
        const chars = typeof result === "string" ? result.length : 0;
        console.log(`[AI tool] ${name}(${JSON.stringify(args)}) → ${chars} 字符`);
      },
      onDegrade: (errMsg) =>
        console.warn(`[AI] 模型不支持 tools，已降级为单轮调用（${errMsg}）`),
    });
  }
  return callAI(messages, { onChunk, onHeartbeat });
}

/** 组装 AI 提示词（复用 P2 模板），返回 { prompt } 或抛出带 message 的错误 */
function buildPromptForMode(body) {
  const mode = body?.mode;
  const profile = getProfile(); // 用户背景与训练目标，四个场景统一纳入考量
  const skills = buildSkillsSection(); // 专业知识库（skills/ 目录），四个场景统一注入
  if (mode === "review") {
    const name = safeName(body.file_name);
    const summary = name && getActivitySummary(name);
    if (!summary) throw new Error(`训练库中找不到: ${body.file_name ?? "(未提供)"}`);
    return buildReviewPrompt(summary, profile, skills);
  }
  if (mode === "plan") {
    const daily = recentFormDaily(56);
    if (!daily.length) throw new Error("训练库为空");
    return buildPlanPrompt(
      {
        months: monthlySummary(3),
        formSeries: thinToWeekly(daily),
        recentActivities: recentActivities(10),
      },
      profile,
      skills,
    );
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
    return buildTaperPrompt(
      {
        raceDate,
        daysLeft,
        form,
        formSeries: thinToWeekly(recentFormDaily(56)),
        recentActivities: recentActivities(10),
      },
      profile,
      skills,
    );
  }
  if (mode === "compare") {
    const a = safeName(body.file_name);
    const b = safeName(body.compare_with);
    const sa = a && getActivitySummary(a);
    const sb = b && getActivitySummary(b);
    if (!sa || !sb) throw new Error("对比训练在训练库中找不到");
    return buildComparePrompt(sa, sb, profile, skills);
  }
  throw new Error(`未知 mode: ${mode}`);
}

/**
 * 拼装对话系统段（每轮后台生成时按当前状态重新生成，历史消息只带正文）：
 * - follow_up：快答指令 + 关联报告正文 + 关联训练压缩数据 + 工具指引 + 用户记忆段；
 * - chat：教练角色 + 指标口径 + 专业知识库 + 用户背景 + 对话指令 + 工具指引 + 用户记忆段。
 * 记忆段只在 agentic 模式注入——其中的 save_memory 指引依赖工具调用能力。
 * 专业知识库段（src/skills.js）只注入 chat 与四场景报告；follow_up 快答场景不注入。
 */
function buildChatSystemSection(chat) {
  const agentic = AI_CONFIG.agentic !== false;
  if (chat.mode === "follow_up") {
    let s = buildChatInstruction("follow_up");
    // 报告正文：追问以报告内容为锚（报告可能已被滚动清理，缺则仅靠训练数据）
    if (chat.report_id != null) {
      const rep = getAiReport(chat.report_id);
      if (rep?.markdown) s += `\n\n训练分析报告：\n${rep.markdown}`;
    }
    // 追问只带报告会让 AI 无法回答报告未覆盖的细节，按 file_name 附压缩后的训练数据
    const summary = chat.file_name ? getActivitySummary(chat.file_name) : null;
    if (summary) {
      s +=
        "\n\n本次训练数据（供引用具体细节）：\n```json\n" +
        JSON.stringify(compactSummaryForPrompt(summary)) +
        "\n```";
    }
    if (agentic) {
      s += "\n\n" + buildAgenticSection();
      const mem = buildMemorySection(listMemories());
      if (mem) s += "\n\n" + mem;
    }
    return s;
  }
  // chat：无报告上下文的直接对话，取数全靠 agentic 工具调用
  const parts = [
    ROLE,
    buildMetricGlossary(),
    buildSkillsSection(),
    buildProfileSection(getProfile()),
    buildChatInstruction("chat"),
  ].filter(Boolean);
  if (agentic) {
    parts.push(buildAgenticSection());
    const mem = buildMemorySection(listMemories());
    if (mem) parts.push(mem);
  }
  return parts.join("\n\n");
}

// ---------------- 请求处理 ----------------

async function handleApi(req, res, url) {
  // GET /api/overview
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const { athlete, configured } = getAthleteState();
    sendJson(res, 200, {
      athlete,
      athlete_configured: configured,
      ai: aiConfigInfo(),
      monthly: monthlySummary(6),
      trend: trendMonthly(),
      form_daily: recentFormDaily(90),
      activities: listActivities(100),
    });
    return;
  }

  // GET /api/athlete  当前骑手参数（库值覆盖 settings.js 默认值）
  if (req.method === "GET" && url.pathname === "/api/athlete") {
    sendJson(res, 200, getAthleteState());
    return;
  }

  // POST /api/athlete  {ftp_watts?, max_hr?, weight_kg?}  更新骑手参数（写训练库并即时生效）
  if (req.method === "POST" && url.pathname === "/api/athlete") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    try {
      const athlete = setAthlete(body ?? {});
      sendJson(res, 200, { applied: true, athlete });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/ai-config  当前 AI 服务配置（库值覆盖默认值；本地单用户应用，密钥原样返回供编辑）
  if (req.method === "GET" && url.pathname === "/api/ai-config") {
    sendJson(res, 200, getAiConfig());
    return;
  }

  // POST /api/ai-config  {api_key?, base_url?, model?, ...}  更新 AI 配置（写训练库并即时生效）
  if (req.method === "POST" && url.pathname === "/api/ai-config") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    try {
      const config = setAiConfig(body ?? {});
      sendJson(res, 200, { applied: true, config });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // POST /api/activity/category {name, category}
  if (req.method === "POST" && url.pathname === "/api/activity/category") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    const name = safeName(body?.name);
    if (!name) return sendJson(res, 400, { error: "name 参数无效" });
    if (!isValidCategory(body?.category))
      return sendJson(res, 400, { error: "category 需为 training/race/recovery/leisure" });
    try {
      setActivityCategory(name, body.category);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 404, { error: e.message });
    }
    return;
  }

  // POST /api/activity/note {name, note}  保存训练备注（空串清除），AI 复盘时纳入考量
  if (req.method === "POST" && url.pathname === "/api/activity/note") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    const name = safeName(body?.name);
    if (!name) return sendJson(res, 400, { error: "name 参数无效" });
    try {
      const r = setActivityNote(name, body?.note ?? "");
      sendJson(res, 200, r);
    } catch (e) {
      const status = e.message === "训练不存在" ? 404 : 400;
      sendJson(res, status, { error: e.message });
    }
    return;
  }

  // GET /api/profile  当前用户背景与训练目标（identity / goal / configured）
  if (req.method === "GET" && url.pathname === "/api/profile") {
    sendJson(res, 200, getProfile());
    return;
  }

  // POST /api/profile  {identity?, goal?}  更新用户背景与训练目标（写训练库 settings 表）
  if (req.method === "POST" && url.pathname === "/api/profile") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    try {
      sendJson(res, 200, { applied: true, profile: setProfile(body ?? {}) });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/activity?name=x.fit
  if (req.method === "GET" && url.pathname === "/api/activity") {
    const name = safeName(url.searchParams.get("name"));
    const summary = name && getActivitySummary(name);
    if (!summary) return sendJson(res, 404, { error: "训练不存在" });
    // 分区具体范围（W / bpm）：按分析当时的骑手参数（athlete_context）换算，
    // 与分区分布条的计算口径一致；库中无 athlete_context 时回落当前生效参数
    const ac = summary.athlete_context ?? {};
    const zone_ranges = {
      power: zoneRanges(POWER_ZONES, ac.ftp_watts ?? ATHLETE.ftp_watts),
      hr: zoneRanges(HR_ZONES, ac.max_hr ?? ATHLETE.max_hr),
    };
    sendJson(res, 200, { file_name: name, summary, zone_ranges });
    return;
  }

  // GET /api/records?name=x.fit
  if (req.method === "GET" && url.pathname === "/api/records") {
    const name = safeName(url.searchParams.get("name"));
    const data = name && loadRecords(name, { outputDir: OUTPUT_DIR });
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
    // 已配置：先写入 pending 占位记录，再返回 202 给前端；
    // 后台完成 AI 调用后更新为 completed，失败则更新为 failed 并记录原因。
    let reportId;
    try {
      reportId = createPendingAiReport(body.mode, body, prompt);
    } catch (e) {
      return sendJson(res, 500, { error: `创建报告记录失败: ${e.message}` });
    }
    sendJson(res, 202, {
      accepted: true,
      report_id: reportId,
      message: "AI 分析已提交，将在后台生成并保存，请稍后从历史报告查看。",
    });
    (async () => {
      try {
        let chunkCount = 0, charCount = 0, heartbeats = 0;
        // agentic 模式：提示词末尾追加工具使用指引与用户记忆段（未配置密钥走
        // 复制提示词时不含这两段——复制出去的提示词无法回调本机工具）
        let finalPrompt = prompt;
        if (AI_CONFIG.agentic !== false) {
          finalPrompt += "\n\n" + buildAgenticSection();
          const mem = buildMemorySection(listMemories());
          if (mem) finalPrompt += "\n\n" + mem;
        }
        const markdown = await callAiMaybeAgentic(
          [{ role: "user", content: finalPrompt }],
          {
            source: body.mode, // 场景标记：save_memory 写入 ai_memories.source
            onChunk: (delta) => {
              chunkCount++;
              charCount += delta.length;
              if (chunkCount === 1) console.log("[AI] 开始接收流式 chunk...");
              if (chunkCount % 5 === 0) {
                console.log(`[AI] 已接收 ${chunkCount} 个 chunk，累计 ${charCount} 字符`);
              }
            },
            onHeartbeat: () => {
              heartbeats++;
              console.log(`[AI] 仍在生成中...（${heartbeats * 30}s）`);
            },
          },
        );
        updateAiReport(reportId, { markdown, status: "completed", error: null });
        console.log(
          `[AI] 完成：report_id=${reportId}，${chunkCount} 个 chunk，${charCount} 字符，心跳 ${heartbeats} 次`,
        );
      } catch (e) {
        updateAiReport(reportId, { status: "failed", error: e.message });
        console.error(`[AI] 后台分析失败: ${e.message}`);
      }
    })();
    return;
  }

  // POST /api/ai/chat  {chat_id?, mode:'follow_up'|'chat', message, report_id?, file_name?}
  // 落库 user 消息 + pending 占位 → 202；后台 agentic 生成后回填 completed/failed
  if (req.method === "POST" && url.pathname === "/api/ai/chat") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    if (!isAiConfigured())
      return sendJson(res, 400, { error: "未配置 AI 密钥（设置页可配），无法使用对话" });
    const mode = body?.mode;
    if (!/^(follow_up|chat)$/.test(mode ?? ""))
      return sendJson(res, 400, { error: "mode 需为 follow_up/chat" });
    const message = String(body?.message ?? "").trim();
    if (!message) return sendJson(res, 400, { error: "message 不能为空" });
    if (message.length > 2000)
      return sendJson(res, 400, { error: "message 过长（上限 2000 字）" });

    let chatId = body?.chat_id;
    if (chatId != null) {
      // 继续既有对话：校验存在（404），沿用其 mode/report_id/file_name
      chatId = Number(chatId);
      if (!Number.isInteger(chatId) || chatId <= 0)
        return sendJson(res, 400, { error: "chat_id 参数无效" });
      if (!getAiChat(chatId)) return sendJson(res, 404, { error: "对话不存在" });
    } else {
      // 新建对话：title 取首条消息前 50 字
      const fileName = body?.file_name ? safeName(body.file_name) : null;
      const reportId = Number(body?.report_id);
      chatId = createAiChat(mode, {
        report_id: Number.isInteger(reportId) && reportId > 0 ? reportId : null,
        file_name: fileName,
        title: message.slice(0, 50),
      });
    }
    addAiChatMessage(chatId, "user", message);
    const pendingId = addAiChatMessage(chatId, "assistant", "", "pending");
    touchAiChat(chatId);
    sendJson(res, 202, {
      accepted: true,
      chat_id: chatId,
      message_id: pendingId,
      message: "已提交，AI 正在生成回答。",
    });
    (async () => {
      try {
        // 系统段每轮按当前状态重新拼装（备注/profile 修改后下一轮自动生效）；
        // 历史只带 user/assistant 正文，排除 pending 占位与失败消息
        const chat = getAiChat(chatId);
        const history = chat.messages
          .filter((m) => m.status === "completed" && m.content)
          .map((m) => ({ role: m.role, content: m.content }));
        const messages = [
          { role: "user", content: buildChatSystemSection(chat) },
          ...history,
        ];
        let heartbeats = 0;
        const markdown = await callAiMaybeAgentic(messages, {
          source: chat.mode, // 场景标记：save_memory 写入 ai_memories.source
          onHeartbeat: () => {
            heartbeats++;
            console.log(`[AI chat] 仍在生成中...（${heartbeats * 30}s）`);
          },
        });
        updateAiChatMessage(pendingId, { content: markdown, status: "completed", error: null });
        touchAiChat(chatId);
        console.log(`[AI chat] 完成：chat_id=${chatId}，message_id=${pendingId}，${markdown.length} 字符`);
      } catch (e) {
        updateAiChatMessage(pendingId, { status: "failed", error: e.message });
        touchAiChat(chatId);
        console.error(`[AI chat] 后台生成失败: ${e.message}`);
      }
    })();
    return;
  }

  // GET /api/ai/chat?id=  对话元信息 + 全部消息；有 pending 消息时 202（前端继续轮询）
  if (req.method === "GET" && url.pathname === "/api/ai/chat") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: "id 参数无效" });
    const chat = getAiChat(id);
    if (!chat) return sendJson(res, 404, { error: "对话不存在" });
    // assistant 完成的回答附 marked 渲染后的 html（口径同报告）
    const messages = chat.messages.map((m) =>
      m.role === "assistant" && m.status === "completed" && m.content
        ? { ...m, html: marked.parse(m.content, { gfm: true, headerIds: false, mangle: false }) }
        : m,
    );
    const hasPending = messages.some((m) => m.status === "pending");
    sendJson(res, hasPending ? 202 : 200, { ...chat, messages });
    return;
  }

  // GET /api/ai/chats?mode=follow_up|chat[&report_id=]  对话列表（report_id 用于找回该报告的追问对话）
  if (req.method === "GET" && url.pathname === "/api/ai/chats") {
    const mode = url.searchParams.get("mode");
    if (!/^(follow_up|chat)$/.test(mode ?? ""))
      return sendJson(res, 400, { error: "mode 参数需为 follow_up/chat" });
    const reportId = Number(url.searchParams.get("report_id"));
    if (url.searchParams.has("report_id")) {
      if (!Number.isInteger(reportId) || reportId <= 0)
        return sendJson(res, 400, { error: "report_id 参数无效" });
      return sendJson(res, 200, { mode, chat_id: findFollowUpChat(reportId) });
    }
    sendJson(res, 200, { mode, chats: listAiChats(mode) });
    return;
  }

  // DELETE /api/ai/chat?id=  删除整个对话及其全部消息
  if (req.method === "DELETE" && url.pathname === "/api/ai/chat") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: "id 参数无效" });
    if (deleteAiChat(id) === 0) return sendJson(res, 404, { error: "对话不存在" });
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/ai/memories  全部 AI 记忆（含已被取代的，设置页管理用）
  if (req.method === "GET" && url.pathname === "/api/ai/memories") {
    sendJson(res, 200, { memories: listAllMemories() });
    return;
  }

  // DELETE /api/ai/memory?id=  删除指定记忆（用户可纠正 AI 记错的内容）
  if (req.method === "DELETE" && url.pathname === "/api/ai/memory") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: "id 参数无效" });
    if (deleteMemory(id) === 0) return sendJson(res, 404, { error: "记忆不存在" });
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/ftp-estimate  基于最近窗口期骑行（功率峰曲线+心率）科学估算 FTP
  if (req.method === "GET" && url.pathname === "/api/ftp-estimate") {
    const acts = cyclingSummariesSince(FTP_ESTIMATION.window_days);
    sendJson(res, 200, estimateFtpFromHistory(acts, ATHLETE, FTP_ESTIMATION));
    return;
  }

  // POST /api/ftp-apply  {ftp_w}  把估算出的 FTP 写入训练库骑手参数并立即生效
  if (req.method === "POST" && url.pathname === "/api/ftp-apply") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体需为 JSON" });
    }
    const ftpW = Number(body?.ftp_w);
    if (
      !Number.isFinite(ftpW) ||
      ftpW < FTP_ESTIMATION.apply_min_w ||
      ftpW > FTP_ESTIMATION.apply_max_w
    ) {
      return sendJson(res, 400, {
        error: `ftp_w 需在 ${FTP_ESTIMATION.apply_min_w}–${FTP_ESTIMATION.apply_max_w}W 之间`,
      });
    }
    const ftpInt = Math.round(ftpW);
    // 写入训练库 settings 表并原地更新 ATHLETE，当前进程立即生效（无需重启）
    setAthlete({ ftp_watts: ftpInt });
    sendJson(res, 200, { applied: true, ftp_w: ftpInt });
    return;
  }

  // GET /api/ai/reports?mode=review
  if (req.method === "GET" && url.pathname === "/api/ai/reports") {
    const mode = url.searchParams.get("mode");
    if (!mode || !/^(review|plan|taper|compare)$/.test(mode))
      return sendJson(res, 400, { error: "mode 参数需为 review/plan/taper/compare" });
    sendJson(res, 200, { mode, reports: listAiReports(mode, 30) });
    return;
  }

  // GET /api/ai/report?id=1
  if (req.method === "GET" && url.pathname === "/api/ai/report") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: "id 参数无效" });
    const row = getAiReport(id);
    if (!row) return sendJson(res, 404, { error: "报告不存在" });
    if (row.status === "pending") {
      return sendJson(res, 202, {
        ...row,
        html: null,
        message: "报告正在生成中，请稍后再刷新查看。",
      });
    }
    if (row.status === "failed") {
      return sendJson(res, 502, {
        ...row,
        html: null,
        error: row.error || "AI 分析失败",
      });
    }
    const html = marked.parse(row.markdown, {
      gfm: true,
      headerIds: false,
      mangle: false,
    });
    sendJson(res, 200, { ...row, html });
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
  // 一次性迁移：老版本用 .env / 环境变量配置 AI（FIT_AI_*）。这里仍尝试加载
  // .env（存在才注入，Node ≥21.7 内置，无需 dotenv），仅作为迁移数据源——
  // 库中已有 ai 配置时 migrateAiEnvToDb 直接跳过，迁移完成后 env 被完全忽略。
  // 放在入口分支里而非模块顶层：测试 import createServer 时不加载真实 .env。
  try {
    process.loadEnvFile?.();
  } catch {
    // .env 不存在时静默跳过
  }
  if (migrateAiEnvToDb()) console.log("已将 FIT_AI_* 环境变量迁移到训练库（之后以设置页为准）");
  // 骑手参数 / AI 配置以训练库为准：启动时把库值合并进 ATHLETE / AI_CONFIG
  // （之后 /api/athlete、/api/ftp-apply、/api/ai-config 原地更新）
  syncAthleteFromDb();
  syncAiConfigFromDb();
  createServer().listen(PORT, () => {
    console.log(`fit-reader Web 界面: http://localhost:${PORT}`);
    if (!isAiConfigured())
      console.log("提示: 未配置 AI 密钥（设置页可配），AI 报告将退化为复制提示词模式");
  });
}
