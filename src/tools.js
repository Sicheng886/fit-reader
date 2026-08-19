/**
 * tools.js
 * AI agentic 工具集（function calling）：工具 JSON schema 定义 + 参数校验 + 执行分发。
 * 三类工具：只读查询（调用 db.js 既有查询函数与 records.js，不重复实现查询逻辑）、
 * 纯计算（simulate_form / generate_workout → src/planning.js 纯函数，其中 simulate_form
 * 在未显式给起始 CTL/ATL 时读一次训练库当前值）、写（save_memory 只写 ai_memories 表，
 * 带 source 场景标记，不触碰 activities/settings）。
 *
 * 双语：toolDefs(lang) 返回按语言本地化的工具 schema（描述随提示词语言切换）；
 * 执行层的错误消息经 src/i18n.js 按 ctx.lang（缺省 zh）生成。
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
  computeForm,
  saveMemory,
} from "./db.js";
import { compactSummaryForPrompt } from "./prompts.js";
import { loadRecords, safeName } from "./records.js";
import { estimateFtpFromHistory } from "./ftp.js";
import { simulateForm, generateWorkout } from "./planning.js";
import { t } from "./i18n.js";
import { AGENTIC, ATHLETE, FTP_ESTIMATION, FORM_SIMULATION, WORKOUT_TEMPLATES } from "./settings.js";

// 输出目录解析规则与 server.js 一致（FIT_OUTPUT_DIR 覆盖，默认 ./output，测试隔离用）
const OUTPUT_DIR = path.resolve(process.env.FIT_OUTPUT_DIR || "output");

// ---------------- 工具 schema 定义（OpenAI tools 格式，按语言本地化） ----------------

const TOOL_TEXT = {
  zh: {
    list_activities: "查询训练简明清单（目录页）：日期/类型/分类/时长/距离/TSS/NP/IF。先用它找到目标训练的 file_name，再用 get_activity_summary 或 get_activity_records 深挖单次。",
    "list_activities.start_date": "起始日期 YYYY-MM-DD（含）",
    "list_activities.end_date": "结束日期 YYYY-MM-DD（含）",
    "list_activities.sport": "运动类型过滤，如 cycling / running / swimming",
    "list_activities.category": "训练分类过滤，如 训练 / 比赛 / 恢复 / 休闲",
    "list_activities.limit": "返回条数上限，最大 {n}",
    get_activity_summary: "取单次训练的完整汇总指标 JSON（NP/IF/TSS/分区分布/峰功率曲线/心率漂移/间歇/爬坡/备注等），入参为 list_activities 返回的 file_name。",
    "get_activity_summary.file_name": "训练文件名（list_activities 返回的 file_name）",
    get_activity_records: "取单次训练的逐秒时序（功率/心率/踏频/海拔/速度，抽稀后返回）。可用 start_sec/end_sec 只取时间窗片段（如最后 600 秒），不必取全程。",
    "get_activity_records.file_name": "训练文件名",
    "get_activity_records.start_sec": "时间窗起点（相对训练开始的秒数，含）",
    "get_activity_records.end_sec": "时间窗终点（相对训练开始的秒数，含）",
    get_form_series: "取最近 N 天逐日训练状态序列（CTL/ATL/TSB/TSS），用于判断疲劳与状态走势。",
    "get_form_series.days": "回看天数，最大 {n}",
    get_monthly_summary: "取逐月训练汇总（TSS/时长/距离/强度分布类型），用于长期负荷趋势。",
    "get_monthly_summary.months": "回看月数，最大 {n}",
    get_athlete_profile: "取骑手参数（FTP/最大心率/体重）与用户身份、训练目标。",
    estimate_ftp: "基于最近窗口期骑行的功率峰曲线与心率交叉验证估算 FTP（含置信度与数据需求），用户问 FTP 是否该调整时使用。",
    simulate_form: "未来负荷推演：给出未来逐日计划 TSS，按当前 CTL/ATL 推演 CTL/ATL/TSB 走势并标注风险（深度疲劳/CTL 周增幅过高）。用户问「如果我每周加练 X 会怎样」「赛前怎么减量」时使用。",
    "simulate_form.plan": "未来逐日计划（无训练日 tss=0），最多 {n} 天",
    "simulate_form.date": "日期 YYYY-MM-DD",
    "simulate_form.tss": "当日计划 TSS（0–1000）",
    "simulate_form.start_ctl": "起始 CTL；缺省取训练库当前值",
    "simulate_form.start_atl": "起始 ATL；缺省取训练库当前值",
    generate_workout: "按目标与可用时长生成单次课表：热身/主组（组数/时长/功率瓦特区间/组间休息）/冷身 + TSS 估算。用户问「今天有 X 小时，练什么」时使用。",
    "generate_workout.target": "课表类型：recovery 恢复 / endurance 有氧耐力 / sweet_spot 甜区 / threshold 阈值 / vo2max",
    "generate_workout.duration_minutes": "可用总时长（分钟，15–300）",
    "generate_workout.tsb": "当前 TSB（可选）；过低时自动降级为恢复课",
    save_memory: "保存一条关于用户的长期记忆。只要用户透露训练数据之外的个人事实或倾向（目标与赛事计划/伤病与身体不适/日程时间约束/训练偏好/器材/对建议的反馈与纠正/自述主观状态）就主动记录，不必等用户明确要求，宁多勿漏；训练数据本身已有的事实不要记。",
    "save_memory.content": "记忆内容：带主语的完整陈述，≤500 字",
    "save_memory.category": "分类：general 通用 / injury 伤病 / schedule 日程 / goal 目标 / preference 偏好",
    "save_memory.supersedes_id": "取代某条旧记忆的 id（注入的记忆清单中有 #id 标注），同主题更新时使用",
  },
  en: {
    list_activities: "Query the brief activity list (catalog page): date/type/category/duration/distance/TSS/NP/IF. Use it first to find the target activity's file_name, then dig into a single one with get_activity_summary or get_activity_records.",
    "list_activities.start_date": "Start date YYYY-MM-DD (inclusive)",
    "list_activities.end_date": "End date YYYY-MM-DD (inclusive)",
    "list_activities.sport": "Sport filter, e.g. cycling / running / swimming",
    "list_activities.category": "Category filter, e.g. training / race / recovery / leisure",
    "list_activities.limit": "Max number of results, up to {n}",
    get_activity_summary: "Get the full summary-metrics JSON of one activity (NP/IF/TSS/zone distribution/peak power curve/HR drift/intervals/climbs/notes etc.); input is the file_name returned by list_activities.",
    "get_activity_summary.file_name": "Activity file name (file_name from list_activities)",
    get_activity_records: "Get the per-second time series of one activity (power/HR/cadence/altitude/speed, thinned). Use start_sec/end_sec to fetch only a time window (e.g. the last 600 seconds) instead of the whole ride.",
    "get_activity_records.file_name": "Activity file name",
    "get_activity_records.start_sec": "Window start (seconds from ride start, inclusive)",
    "get_activity_records.end_sec": "Window end (seconds from ride start, inclusive)",
    get_form_series: "Get the daily form series for the last N days (CTL/ATL/TSB/TSS) to judge fatigue and form trends.",
    "get_form_series.days": "Days to look back, up to {n}",
    get_monthly_summary: "Get the monthly training summary (TSS/hours/distance/intensity distribution type) for long-term load trends.",
    "get_monthly_summary.months": "Months to look back, up to {n}",
    get_athlete_profile: "Get athlete parameters (FTP/max HR/weight) plus user identity and training goals.",
    estimate_ftp: "Estimate FTP from rides in the recent window using peak power curves and HR cross-validation (with confidence and data needs). Use when the user asks whether FTP should be adjusted.",
    simulate_form: "Future load simulation: given a daily plan TSS, project the CTL/ATL/TSB trend and flag risks (deep fatigue / CTL weekly ramp too high). Use when the user asks \"what if I add X per week\" or \"how should I taper\".",
    "simulate_form.plan": "Future daily plan (rest days tss=0), up to {n} days",
    "simulate_form.date": "Date YYYY-MM-DD",
    "simulate_form.tss": "Planned TSS for the day (0–1000)",
    "simulate_form.start_ctl": "Starting CTL; defaults to the current library value",
    "simulate_form.start_atl": "Starting ATL; defaults to the current library value",
    generate_workout: "Build a single workout by target and available time: warmup/main sets (reps/duration/watt range/rest)/cooldown + TSS estimate. Use when the user asks \"I have X hours today, what should I do\".",
    "generate_workout.target": "Workout type: recovery / endurance / sweet_spot / threshold / vo2max",
    "generate_workout.duration_minutes": "Total available time (minutes, 15–300)",
    "generate_workout.tsb": "Current TSB (optional); auto-downgrades to recovery when too low",
    save_memory: "Save a long-term memory about the user. Proactively record whenever the user reveals personal facts or preferences beyond training data (goals and race plans / injuries and physical issues / schedule-time constraints / training preferences / equipment / feedback on and corrections to your advice / self-reported subjective state) — better too many than too few, don't wait to be asked; facts already present in the training data need not be recorded.",
    "save_memory.content": "Memory content: a complete statement with a subject, ≤500 chars",
    "save_memory.category": "Category: general / injury / schedule / goal / preference",
    "save_memory.supersedes_id": "id of an old memory to supersede (ids are #annotated in the injected memory list); use when updating the same topic",
  },
};

const LANG_T = (lang, key, vars) => {
  const tpl = TOOL_TEXT[lang]?.[key] ?? TOOL_TEXT.zh[key] ?? key;
  if (!vars) return tpl;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(v == null ? "" : String(v)),
    tpl,
  );
};

/** 工具 JSON schema（描述按语言本地化；OpenAI tools 格式） */
export function toolDefs(lang = "zh") {
  const L = (key, vars) => LANG_T(lang, key, vars);
  return [
    {
      type: "function",
      function: {
        name: "list_activities",
        description: L("list_activities"),
        parameters: {
          type: "object",
          properties: {
            start_date: { type: "string", description: L("list_activities.start_date") },
            end_date: { type: "string", description: L("list_activities.end_date") },
            sport: { type: "string", description: L("list_activities.sport") },
            category: { type: "string", description: L("list_activities.category") },
            limit: { type: "integer", description: L("list_activities.limit", { n: AGENTIC.list_limit }) },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_activity_summary",
        description: L("get_activity_summary"),
        parameters: {
          type: "object",
          properties: {
            file_name: { type: "string", description: L("get_activity_summary.file_name") },
          },
          required: ["file_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_activity_records",
        description: L("get_activity_records"),
        parameters: {
          type: "object",
          properties: {
            file_name: { type: "string", description: L("get_activity_records.file_name") },
            start_sec: { type: "integer", description: L("get_activity_records.start_sec") },
            end_sec: { type: "integer", description: L("get_activity_records.end_sec") },
          },
          required: ["file_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_form_series",
        description: L("get_form_series"),
        parameters: {
          type: "object",
          properties: {
            days: { type: "integer", description: L("get_form_series.days", { n: AGENTIC.form_max_days }) },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_monthly_summary",
        description: L("get_monthly_summary"),
        parameters: {
          type: "object",
          properties: {
            months: { type: "integer", description: L("get_monthly_summary.months", { n: AGENTIC.monthly_max }) },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_athlete_profile",
        description: L("get_athlete_profile"),
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "estimate_ftp",
        description: L("estimate_ftp"),
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "simulate_form",
        description: L("simulate_form"),
        parameters: {
          type: "object",
          properties: {
            plan: {
              type: "array",
              description: L("simulate_form.plan", { n: AGENTIC.simulate_max_days }),
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: L("simulate_form.date") },
                  tss: { type: "number", description: L("simulate_form.tss") },
                },
                required: ["date", "tss"],
              },
            },
            start_ctl: { type: "number", description: L("simulate_form.start_ctl") },
            start_atl: { type: "number", description: L("simulate_form.start_atl") },
          },
          required: ["plan"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_workout",
        description: L("generate_workout"),
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["recovery", "endurance", "sweet_spot", "threshold", "vo2max"],
              description: L("generate_workout.target"),
            },
            duration_minutes: { type: "integer", description: L("generate_workout.duration_minutes") },
            tsb: { type: "number", description: L("generate_workout.tsb") },
          },
          required: ["target", "duration_minutes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_memory",
        description: L("save_memory"),
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: L("save_memory.content"),
            },
            category: {
              type: "string",
              enum: ["general", "injury", "schedule", "goal", "preference"],
              description: L("save_memory.category"),
            },
            supersedes_id: {
              type: "integer",
              description: L("save_memory.supersedes_id"),
            },
          },
          required: ["content"],
        },
      },
    },
  ];
}

// ---------------- 参数校验小工具 ----------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 结果序列化 + 截断（超 AGENTIC.tool_result_max_chars 附截断标记，按语言） */
function toResult(obj, lang = "zh") {
  let s = JSON.stringify(obj);
  if (s.length > AGENTIC.tool_result_max_chars) {
    s = s.slice(0, AGENTIC.tool_result_max_chars) + t(lang, "tool.result_truncated");
  }
  return s;
}

const errResult = (message) => JSON.stringify({ error: message });

// ---------------- 各工具实现 ----------------

function toolListActivities(args, ctx) {
  const lang = ctx?.lang || "zh";
  const limit = clampInt(args?.limit, 1, AGENTIC.list_limit, 20);
  let list = listActivities(200);
  if (args?.start_date != null) {
    if (!DATE_RE.test(args.start_date))
      return errResult(t(lang, "tool.date_invalid", { key: "start_date" }));
    list = list.filter((a) => a.date >= args.start_date);
  }
  if (args?.end_date != null) {
    if (!DATE_RE.test(args.end_date))
      return errResult(t(lang, "tool.date_invalid", { key: "end_date" }));
    list = list.filter((a) => a.date <= args.end_date);
  }
  if (args?.sport != null) list = list.filter((a) => a.sport === args.sport);
  if (args?.category != null) list = list.filter((a) => a.category === args.category);
  return toResult({ count: Math.min(list.length, limit), activities: list.slice(0, limit) }, lang);
}

function toolGetActivitySummary(args, ctx) {
  const lang = ctx?.lang || "zh";
  const name = safeName(args?.file_name);
  if (!name) return errResult(t(lang, "tool.name_invalid"));
  const summary = getActivitySummary(name);
  if (!summary) return errResult(t(lang, "tool.summary_not_found", { name }));
  return toResult(compactSummaryForPrompt(summary, lang), lang);
}

function toolGetActivityRecords(args, ctx) {
  const lang = ctx?.lang || "zh";
  const name = safeName(args?.file_name);
  if (!name) return errResult(t(lang, "tool.name_invalid"));
  const data = loadRecords(name, {
    outputDir: OUTPUT_DIR,
    maxPoints: AGENTIC.records_max_points,
    startSec: args?.start_sec != null ? Number(args.start_sec) : undefined,
    endSec: args?.end_sec != null ? Number(args.end_sec) : undefined,
  });
  if (!data) return errResult(t(lang, "tool.records_not_found", { name }));
  return toResult(data, lang);
}

function toolGetFormSeries(args, ctx) {
  const days = clampInt(args?.days, 1, AGENTIC.form_max_days, 56);
  return toResult({ days, series: recentFormDaily(days) }, ctx?.lang || "zh");
}

function toolGetMonthlySummary(args, ctx) {
  const months = clampInt(args?.months, 1, AGENTIC.monthly_max, 6);
  return toResult({ months, summary: monthlySummary(months) }, ctx?.lang || "zh");
}

function toolGetAthleteProfile(ctx) {
  const { athlete, configured } = getAthleteState();
  const profile = getProfile();
  return toResult(
    {
      athlete,
      athlete_configured: configured,
      identity: profile.identity || null,
      goal: profile.goal || null,
    },
    ctx?.lang || "zh",
  );
}

function toolEstimateFtp(ctx) {
  const lang = ctx?.lang || "zh";
  const acts = cyclingSummariesSince(FTP_ESTIMATION.window_days);
  return toResult(estimateFtpFromHistory(acts, ATHLETE, FTP_ESTIMATION, lang), lang);
}

/** simulate_form：未来负荷推演（纯计算；起始 CTL/ATL 缺省时读一次训练库当前值） */
function toolSimulateForm(args, ctx) {
  const lang = ctx?.lang || "zh";
  const plan = args?.plan;
  if (!Array.isArray(plan) || !plan.length)
    return errResult(t(lang, "tool.plan_array"));
  if (plan.length > AGENTIC.simulate_max_days)
    return errResult(t(lang, "tool.plan_max_days", { n: AGENTIC.simulate_max_days }));
  const clean = [];
  for (const d of plan) {
    if (!d || !DATE_RE.test(d.date ?? ""))
      return errResult(t(lang, "tool.plan_date"));
    const tss = Number(d.tss);
    if (!Number.isFinite(tss)) return errResult(t(lang, "tool.plan_tss"));
    clean.push({ date: d.date, tss: Math.min(1000, Math.max(0, tss)) });
  }
  clean.sort((a, b) => (a.date < b.date ? -1 : 1));
  let startCtl = Number(args?.start_ctl);
  let startAtl = Number(args?.start_atl);
  if (!Number.isFinite(startCtl) || !Number.isFinite(startAtl)) {
    const today = new Date().toISOString().slice(0, 10);
    const cur = computeForm(today); // 训练库为空时返回 null，按 0 起步
    startCtl = cur?.ctl ?? 0;
    startAtl = cur?.atl ?? 0;
  }
  const { projection, risk_flags, end_form } = simulateForm({
    startCtl,
    startAtl,
    plan: clean,
    cfg: FORM_SIMULATION,
    lang,
  });
  return toResult({ start: { ctl: startCtl, atl: startAtl }, projection, risk_flags, end_form }, lang);
}

/** generate_workout：单次课表生成（纯计算，FTP 取 ATHLETE 当前生效值） */
function toolGenerateWorkout(args, ctx) {
  const lang = ctx?.lang || "zh";
  const duration = clampInt(args?.duration_minutes, 15, 300, NaN);
  if (!Number.isFinite(duration))
    return errResult(t(lang, "tool.duration_invalid"));
  const result = generateWorkout({
    target: args?.target,
    durationMinutes: duration,
    ftpWatts: ATHLETE.ftp_watts,
    tsb: args?.tsb != null ? Number(args.tsb) : null,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
    lang,
  });
  if (result.error) return errResult(result.error);
  return toResult({ ftp_watts: ATHLETE.ftp_watts, ...result }, lang);
}

/** save_memory：写 ai_memories（唯一写工具）；ctx.source 为场景标记，ctx.lang 为消息语言 */
function toolSaveMemory(args, ctx) {
  const id = saveMemory(
    {
      content: args?.content,
      category: args?.category,
      source: ctx?.source ?? null,
      supersedes_id: args?.supersedes_id,
    },
    ctx?.lang || "zh",
  );
  return toResult(
    {
      ok: true,
      memory_id: id,
      date: new Date().toISOString().slice(0, 10),
    },
    ctx?.lang || "zh",
  );
}

const TOOL_IMPL = {
  list_activities: toolListActivities,
  get_activity_summary: toolGetActivitySummary,
  get_activity_records: toolGetActivityRecords,
  get_form_series: toolGetFormSeries,
  get_monthly_summary: toolGetMonthlySummary,
  get_athlete_profile: toolGetAthleteProfile,
  estimate_ftp: toolEstimateFtp,
  simulate_form: toolSimulateForm,
  generate_workout: toolGenerateWorkout,
  save_memory: toolSaveMemory,
};

/**
 * 工具执行分发：未知工具名 / 执行异常均返回 {error} JSON，不抛出。
 * 返回值为 JSON 字符串（直接作为 role:"tool" 消息的 content）。
 * ctx 为可选上下文（{ source: 场景标记, lang: 消息语言 }），save_memory 用 source，
 * 各工具错误消息用 lang；缺省 zh。
 */
export async function executeTool(name, args, ctx) {
  const lang = ctx?.lang || "zh";
  const impl = TOOL_IMPL[name];
  if (!impl) return errResult(t(lang, "tool.unknown", { name }));
  try {
    return impl(args ?? {}, ctx);
  } catch (e) {
    return errResult(t(lang, "tool.failed", { msg: e.message }));
  }
}
