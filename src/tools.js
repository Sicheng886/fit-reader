/**
 * tools.js
 * AI agentic 工具集（function calling）：工具 JSON schema 定义 + 参数校验 + 执行分发。
 * 全部工具为只读查询，内部调用 db.js 既有查询函数与 records.js，不重复实现查询逻辑；
 * save_memory 等写工具在阶段三注册（分发器已预留扩展位）。
 *
 * 约定：
 * - 所有工具返回 JSON 字符串；业务错误（file_name 不存在、参数非法）返回
 *   {error: "..."} JSON，不抛异常中断 agent 循环。
 * - 每个结果超过 AGENTIC.tool_result_max_chars 时截断并附"（结果已截断）"标记。
 * - file_name 参数一律经 safeName basename 校验，防路径穿越。
 */

import path from "node:path";
import {
  listActivities,
  getActivitySummary,
  recentFormDaily,
  monthlySummary,
  getAthleteState,
  getProfile,
  cyclingSummariesSince,
} from "./db.js";
import { compactSummaryForPrompt } from "./prompts.js";
import { loadRecords, safeName } from "./records.js";
import { estimateFtpFromHistory } from "./ftp.js";
import { AGENTIC, ATHLETE, FTP_ESTIMATION } from "./settings.js";

// 输出目录解析规则与 server.js 一致（FIT_OUTPUT_DIR 覆盖，默认 ./output，测试隔离用）
const OUTPUT_DIR = path.resolve(process.env.FIT_OUTPUT_DIR || "output");

// ---------------- 工具 schema 定义（OpenAI tools 格式） ----------------

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_activities",
      description:
        "查询训练简明清单（目录页）：日期/类型/分类/时长/距离/TSS/NP/IF。先用它找到目标训练的 file_name，再用 get_activity_summary 或 get_activity_records 深挖单次。",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "起始日期 YYYY-MM-DD（含）" },
          end_date: { type: "string", description: "结束日期 YYYY-MM-DD（含）" },
          sport: { type: "string", description: "运动类型过滤，如 cycling / running / swimming" },
          category: { type: "string", description: "训练分类过滤，如 训练 / 比赛 / 恢复 / 休闲" },
          limit: { type: "integer", description: `返回条数上限，最大 ${AGENTIC.list_limit}` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_activity_summary",
      description:
        "取单次训练的完整汇总指标 JSON（NP/IF/TSS/分区分布/峰功率曲线/心率漂移/间歇/爬坡/备注等），入参为 list_activities 返回的 file_name。",
      parameters: {
        type: "object",
        properties: {
          file_name: { type: "string", description: "训练文件名（list_activities 返回的 file_name）" },
        },
        required: ["file_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_activity_records",
      description:
        "取单次训练的逐秒时序（功率/心率/踏频/海拔/速度，抽稀后返回）。可用 start_sec/end_sec 只取时间窗片段（如最后 600 秒），不必取全程。",
      parameters: {
        type: "object",
        properties: {
          file_name: { type: "string", description: "训练文件名" },
          start_sec: { type: "integer", description: "时间窗起点（相对训练开始的秒数，含）" },
          end_sec: { type: "integer", description: "时间窗终点（相对训练开始的秒数，含）" },
        },
        required: ["file_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_form_series",
      description: "取最近 N 天逐日训练状态序列（CTL/ATL/TSB/TSS），用于判断疲劳与状态走势。",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: `回看天数，最大 ${AGENTIC.form_max_days}` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_monthly_summary",
      description: "取逐月训练汇总（TSS/时长/距离/强度分布类型），用于长期负荷趋势。",
      parameters: {
        type: "object",
        properties: {
          months: { type: "integer", description: `回看月数，最大 ${AGENTIC.monthly_max}` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_athlete_profile",
      description: "取骑手参数（FTP/最大心率/体重）与用户身份、训练目标。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "estimate_ftp",
      description:
        "基于最近窗口期骑行的功率峰曲线与心率交叉验证估算 FTP（含置信度与数据需求），用户问 FTP 是否该调整时使用。",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------------- 参数校验小工具 ----------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 结果序列化 + 截断（超 AGENTIC.tool_result_max_chars 附截断标记） */
function toResult(obj) {
  let s = JSON.stringify(obj);
  if (s.length > AGENTIC.tool_result_max_chars) {
    s = s.slice(0, AGENTIC.tool_result_max_chars) + "（结果已截断）";
  }
  return s;
}

const errResult = (message) => JSON.stringify({ error: message });

// ---------------- 各工具实现 ----------------

function toolListActivities(args) {
  const limit = clampInt(args?.limit, 1, AGENTIC.list_limit, 20);
  let list = listActivities(200);
  if (args?.start_date != null) {
    if (!DATE_RE.test(args.start_date)) return errResult("start_date 需为 YYYY-MM-DD");
    list = list.filter((a) => a.date >= args.start_date);
  }
  if (args?.end_date != null) {
    if (!DATE_RE.test(args.end_date)) return errResult("end_date 需为 YYYY-MM-DD");
    list = list.filter((a) => a.date <= args.end_date);
  }
  if (args?.sport != null) list = list.filter((a) => a.sport === args.sport);
  if (args?.category != null) list = list.filter((a) => a.category === args.category);
  return toResult({ count: Math.min(list.length, limit), activities: list.slice(0, limit) });
}

function toolGetActivitySummary(args) {
  const name = safeName(args?.file_name);
  if (!name) return errResult("file_name 非法");
  const summary = getActivitySummary(name);
  if (!summary) return errResult(`训练库中找不到: ${name}`);
  return toResult(compactSummaryForPrompt(summary));
}

function toolGetActivityRecords(args) {
  const name = safeName(args?.file_name);
  if (!name) return errResult("file_name 非法");
  const data = loadRecords(name, {
    outputDir: OUTPUT_DIR,
    maxPoints: AGENTIC.records_max_points,
    startSec: args?.start_sec != null ? Number(args.start_sec) : undefined,
    endSec: args?.end_sec != null ? Number(args.end_sec) : undefined,
  });
  if (!data) return errResult(`找不到时序数据: ${name}`);
  return toResult(data);
}

function toolGetFormSeries(args) {
  const days = clampInt(args?.days, 1, AGENTIC.form_max_days, 56);
  return toResult({ days, series: recentFormDaily(days) });
}

function toolGetMonthlySummary(args) {
  const months = clampInt(args?.months, 1, AGENTIC.monthly_max, 6);
  return toResult({ months, summary: monthlySummary(months) });
}

function toolGetAthleteProfile() {
  const { athlete, configured } = getAthleteState();
  const profile = getProfile();
  return toResult({
    athlete,
    athlete_configured: configured,
    identity: profile.identity || null,
    goal: profile.goal || null,
  });
}

function toolEstimateFtp() {
  const acts = cyclingSummariesSince(FTP_ESTIMATION.window_days);
  return toResult(estimateFtpFromHistory(acts, ATHLETE, FTP_ESTIMATION));
}

const TOOL_IMPL = {
  list_activities: toolListActivities,
  get_activity_summary: toolGetActivitySummary,
  get_activity_records: toolGetActivityRecords,
  get_form_series: toolGetFormSeries,
  get_monthly_summary: toolGetMonthlySummary,
  get_athlete_profile: toolGetAthleteProfile,
  estimate_ftp: toolEstimateFtp,
};

/**
 * 工具执行分发：未知工具名 / 执行异常均返回 {error} JSON，不抛出。
 * 返回值为 JSON 字符串（直接作为 role:"tool" 消息的 content）。
 */
export async function executeTool(name, args) {
  const impl = TOOL_IMPL[name];
  if (!impl) return errResult(`未知工具: ${name}`);
  try {
    return impl(args ?? {});
  } catch (e) {
    return errResult(`工具执行失败: ${e.message}`);
  }
}
