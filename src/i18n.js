/**
 * i18n.js
 * 服务端双语词典（zh 默认 / en）：供 db.js / ftp.js / planning.js / tools.js /
 * ai.js / server.js 生成用户可见消息与 AI 工具文案；以及数据层本地化——
 * formatAnomaly() 把结构化的异常标注（summary.json 的 anomalies 数组）按语言
 * 渲染为展示文本，formNote() 为 TSB 状态简评（zh 文案与旧版逐字一致）。
 *
 * 约定：t(lang, key, vars) 中 {var} 为插值占位；缺省语言一律回落 zh；
 * zh 文案必须与历史版本逐字一致（回归测试断言依赖）。
 */

export const LANGS = ["zh", "en"];

/** 语言归一化：仅认 zh / en，其余一律回落 zh */
export function normalizeLang(l) {
  return l === "en" ? "en" : "zh";
}

const DICT = {
  zh: {
    // ---- 训练库（db.js）校验消息 ----
    "athlete.range": "{key} 需在 {lo}–{hi} 之间",
    "athlete.none": "至少需要提供一个字段：ftp_watts / max_hr / weight_kg",
    "ai.key_type": "api_key 需为字符串",
    "ai.base_url": "base_url 需为 http(s) 地址",
    "ai.model": "model 不能为空",
    "ai.temperature": "temperature 需在 0–2 之间，或留空表示不传",
    "ai.ms": "{key} 需为 ≥1000 的毫秒数",
    "ai.none": "至少需要提供一个字段：api_key / base_url / model / temperature / timeout_ms / stream / stall_ms / agentic",
    "category.invalid": "分类需为 training/race/recovery/leisure",
    "activity.not_found": "训练不存在",
    "note.too_long": "备注过长（上限 {n} 字）",
    "profile.type": "{key} 需为字符串",
    "profile.too_long": "{key} 过长（上限 {n} 字）",
    "memory.empty": "记忆内容不能为空",
    "memory.too_long": "记忆内容过长（上限 {n} 字）",
    "memory.supersede_not_found": "要取代的记忆不存在: {id}",

    // ---- TSB 状态简评（db.js formNote，zh 与历史逐字一致） ----
    "form.note.0": "状态很新鲜，适合比赛或高强度测试",
    "form.note.1": "状态良好，恢复充分",
    "form.note.2": "负荷与恢复平衡，可持续训练",
    "form.note.3": "疲劳积累期，注意睡眠与恢复",
    "form.note.4": "过度疲劳风险，建议安排减量周",

    // ---- 异常标注（index.js 结构化 anomalies → formatAnomaly 渲染） ----
    "anom.power_gap": "功率缺失 {duration}s，起始 {at}",
    "anom.record_gap": "记录缺失 {duration}s，起始 {at}",
    "anom.timer_pause": "计时暂停 {duration}s，起始 {at}",
    "anom.hr_jump": "心率跳变 {from}→{to}，位于 {at}",
    "anom.other": "{text}",

    // ---- FTP 历史估算（ftp.js data_needs / notes / confidence / references） ----
    "ftp.few_rides": "窗口内有效功率骑行仅 {n} 次（需 ≥{min} 次）：请积累更多佩戴功率计的骑行数据后再估算",
    "ftp.hr_coverage": "仅 {n}/{total} 次骑行有合格心率数据：后续骑行请全程佩戴心率带，以便心率交叉验证",
    "ftp.no_20min": "窗口内没有一次骑行包含连续 20 分钟的数据：请安排一次 ≥30 分钟、且含持续 20 分钟高功率输出的骑行（户外长坡或室内台子均可）",
    "ftp.cp_unavailable": "CP 模型不可用（5min 与 20min 峰功率形态退化）：CP 法被跳过，仅采用 Coggan 法",
    "ftp.cp_precision": "为提高 CP 模型精度：可做一次充分休息后的 3–8 分钟全力骑行（刷新无氧锚点）",
    "ftp.not_maximal": "20min 峰功率所在骑行（{date}）心率峰值仅 {hr}bpm（全力阈值 ≥{thr}bpm）：该 20 分钟大概率不是全力输出，FTP 估值偏保守",
    "ftp.maximal_test": "需要一次充分休息后的 20 分钟全力测试（佩戴心率带、心率峰值应接近阈值区间），作为可靠的 FTP 锚点",
    "ftp.anchor_no_hr": "20min 峰功率所在骑行缺少心率数据，无法判定是否全力输出",
    "ftp.anchor_hr": "下次做 20 分钟高功率骑行时请佩戴心率带，用于判定输出是否接近全力",
    "ftp.power_above_hr": "功率高强度（Z5+）时间占比 {p}% 显著高于心率高强度（Z4+）占比 {h}%：当前 FTP 配置可能被低估（同样心率下能输出更高功率），或心率带数据异常",
    "ftp.hr_above_power": "心率高强度（Z4+）时间占比 {h}% 显著高于功率高强度（Z5+）占比 {p}%：当前 FTP 配置可能被高估，或存在疲劳/高温/脱水导致的心率漂移",
    "ftp.drift": "窗口内骑行心率漂移中位数 {d}%（> {t}%）：存在明显的有氧解耦（疲劳累积/脱水/高温），近期数据用于 FTP 推断时需谨慎",
    "ftp.confidence.high": "两种方法结果一致且心率验证通过，可信度高",
    "ftp.confidence.medium": "存在警告项（非全力锚点/区间偏移/心率漂移/单一方法），估值供参考",
    "ftp.confidence.low": "样本量不足，估值仅供参考，请按下方清单补充数据后重新估算",
    "ftp.ref.0": "Morton 双参数临界功率模型：P(t) = CP + W′/t，由 5min/20min 峰功率解出 CP ≈ FTP",
    "ftp.ref.1": "Coggan & Allen《Training and Racing with a Power Meter》：FTP ≈ 20min 峰功率 × 0.95",
    "ftp.ref.2": "心率交叉验证：全力阈值测试心率峰值应接近 HRmax 高位；功率/心率区间系统性偏移提示 FTP 配置漂移",

    // ---- 计划推演（planning.js） ----
    "plan.tsb_recovery": "当前 TSB {tsb} 低于 {thr}，身体未恢复，自动降级为恢复骑",
    "plan.unknown_type": "未知课表类型: {target}（可选: {opts}）",
    "plan.too_short": "{dur} 分钟装不下 {label} 课表（热身 {w} + 至少 {reps}×{min} 分钟主组 + 冷身 {c}），请增加时长或换低时长课表",
    "sim.tsb_low": "TSB 连续 {days} 天低于 {thr}，深度疲劳风险",
    "sim.ctl_ramp": "CTL 周增幅 {pct}% 超过 {thr}%，过度训练风险",

    // ---- 工具层（tools.js 错误与截断标记） ----
    "tool.date_invalid": "{key} 需为 YYYY-MM-DD",
    "tool.name_invalid": "file_name 非法",
    "tool.summary_not_found": "训练库中找不到: {name}",
    "tool.records_not_found": "找不到时序数据: {name}",
    "tool.plan_array": "plan 需为非空数组 [{date, tss}]",
    "tool.plan_max_days": "plan 最多 {n} 天",
    "tool.plan_date": "plan 中 date 需为 YYYY-MM-DD",
    "tool.plan_tss": "plan 中 tss 需为数值",
    "tool.duration_invalid": "duration_minutes 需为 15–300 的整数",
    "tool.unknown": "未知工具: {name}",
    "tool.failed": "工具执行失败: {msg}",
    "tool.result_truncated": "（结果已截断）",

    // ---- AI 客户端（ai.js） ----
    "ai.no_key": "未配置 AI 密钥（Web 设置页可配），无法调用 AI API",
    "ai.stall": "AI 流已空闲超过 {sec} 秒未收到数据。可能是该模型/账号不真正流式输出，建议在设置页关闭流式。",
    "ai.total_timeout": "AI 请求总时间超过 {sec} 秒。若模型确实需要更久，可在设置页增大超时时间；否则建议检查网络/API 可用性。",
    "ai.rounds_exhausted": "工具调用次数已用完，请基于已获得的信息直接作答。",
    "ai.empty": "AI API 返回为空",

    // ---- Web 服务（server.js 请求错误与提示消息） ----
    "srv.body_json": "请求体需为 JSON",
    "srv.body_too_large": "请求体过大",
    "srv.name_invalid": "name 参数无效",
    "srv.category_invalid": "category 需为 training/race/recovery/leisure",
    "srv.activity_not_found": "训练不存在",
    "srv.records_not_found": "时序数据不存在（可能分析时输出目录不同）",
    "srv.filename_fit": "filename 需为 .fit 文件",
    "srv.file_empty": "空文件",
    "srv.parse_failed": "解析失败: {msg}",
    "srv.report_create_failed": "创建报告记录失败: {msg}",
    "srv.ai_submitted": "AI 分析已提交，将在后台生成并保存，请稍后从历史报告查看。",
    "srv.ai_key_missing": "未配置 AI 密钥（设置页可配），无法使用对话",
    "srv.mode_invalid": "mode 需为 follow_up/chat",
    "srv.message_empty": "message 不能为空",
    "srv.message_too_long": "message 过长（上限 {n} 字）",
    "srv.chat_id_invalid": "chat_id 参数无效",
    "srv.chat_not_found": "对话不存在",
    "srv.chat_submitted": "已提交，AI 正在生成回答。",
    "srv.id_invalid": "id 参数无效",
    "srv.mode_param_invalid": "mode 参数需为 follow_up/chat",
    "srv.memory_not_found": "记忆不存在",
    "srv.ftp_range": "ftp_w 需在 {lo}–{hi}W 之间",
    "srv.report_mode_invalid": "mode 参数需为 review/plan/taper/compare",
    "srv.report_not_found": "报告不存在",
    "srv.report_pending": "报告正在生成中，请稍后再刷新查看。",
    "srv.ai_failed": "AI 分析失败",
    "srv.lang_invalid": "lang 需为 zh 或 en",
    "srv.library_empty": "训练库为空",
    "srv.race_date": "race_date 需为 YYYY-MM-DD",
    "srv.compare_not_found": "对比训练在训练库中找不到",
    "srv.unknown_mode": "未知 mode: {mode}",
    "srv.report_id_invalid": "report_id 参数无效",
    "srv.report_body": "训练分析报告：",
    "srv.training_data": "本次训练数据（供引用具体细节）：",
  },

  en: {
    "athlete.range": "{key} must be between {lo} and {hi}",
    "athlete.none": "Provide at least one field: ftp_watts / max_hr / weight_kg",
    "ai.key_type": "api_key must be a string",
    "ai.base_url": "base_url must be an http(s) URL",
    "ai.model": "model must not be empty",
    "ai.temperature": "temperature must be between 0 and 2, or left empty to omit",
    "ai.ms": "{key} must be a number of milliseconds ≥ 1000",
    "ai.none": "Provide at least one field: api_key / base_url / model / temperature / timeout_ms / stream / stall_ms / agentic",
    "category.invalid": "category must be training/race/recovery/leisure",
    "activity.not_found": "activity not found",
    "note.too_long": "note too long (max {n} chars)",
    "profile.type": "{key} must be a string",
    "profile.too_long": "{key} too long (max {n} chars)",
    "memory.empty": "memory content must not be empty",
    "memory.too_long": "memory content too long (max {n} chars)",
    "memory.supersede_not_found": "memory to supersede not found: {id}",

    "form.note.0": "Very fresh — good for racing or hard testing",
    "form.note.1": "Good form, well recovered",
    "form.note.2": "Load and recovery balanced — sustainable training",
    "form.note.3": "Fatigue is building — mind sleep and recovery",
    "form.note.4": "Overtraining risk — consider a recovery week",

    "anom.power_gap": "Power missing {duration}s, starting {at}",
    "anom.record_gap": "Record missing {duration}s, starting {at}",
    "anom.timer_pause": "Timer paused {duration}s, starting {at}",
    "anom.hr_jump": "Heart rate jump {from}→{to} at {at}",
    "anom.other": "{text}",

    "ftp.few_rides": "Only {n} rides in the window have valid power (need ≥{min}): record more power-meter rides before estimating",
    "ftp.hr_coverage": "Only {n}/{total} rides have valid HR data: wear a HR strap on all rides so HR cross-checking is possible",
    "ftp.no_20min": "No ride in the window has 20 continuous minutes of data: do a ≥30 min ride with a sustained 20 min high-power effort (long outdoor climb or indoor trainer)",
    "ftp.cp_unavailable": "CP model unavailable (5min/20min peak power shape degraded): CP method skipped, using Coggan method only",
    "ftp.cp_precision": "For better CP-model precision: do a fresh 3–8 min all-out effort (refresh the anaerobic anchor)",
    "ftp.not_maximal": "The ride with the 20min peak power ({date}) peaked at only {hr}bpm (all-out threshold ≥{thr}bpm): that 20 min was likely not maximal, so the FTP estimate is conservative",
    "ftp.maximal_test": "Do a well-rested 20-minute all-out test (wear a HR strap; peak HR should approach the threshold zone) as a reliable FTP anchor",
    "ftp.anchor_no_hr": "The ride with the 20min peak power has no HR data, so whether the effort was maximal cannot be judged",
    "ftp.anchor_hr": "Wear a HR strap on your next 20-minute high-power ride so effort can be checked against near-maximal output",
    "ftp.power_above_hr": "Time in high power zones (Z5+) is {p}% vs {h}% in high HR zones (Z4+): FTP is likely underestimated (more power at the same HR), or the HR strap data is abnormal",
    "ftp.hr_above_power": "Time in high HR zones (Z4+) is {h}% vs {p}% in high power zones (Z5+): FTP is likely overestimated, or fatigue/heat/dehydration is causing HR drift",
    "ftp.drift": "Median HR drift across rides in the window is {d}% (> {t}%): clear aerobic decoupling (fatigue/dehydration/heat) — be careful using recent data for FTP inference",
    "ftp.confidence.high": "Both methods agree and HR cross-checks pass — high confidence",
    "ftp.confidence.medium": "Warning items present (non-maximal anchor / zone mismatch / HR drift / single method) — treat as a reference",
    "ftp.confidence.low": "Sample too small — reference only; collect more data per the list below and re-estimate",
    "ftp.ref.0": "Morton two-parameter critical power model: P(t) = CP + W′/t, CP ≈ FTP solved from 5min/20min peak power",
    "ftp.ref.1": "Coggan & Allen, Training and Racing with a Power Meter: FTP ≈ 20min peak power × 0.95",
    "ftp.ref.2": "HR cross-check: all-out test peak HR should approach HRmax; systematic power/HR zone mismatch hints at FTP drift",

    "plan.tsb_recovery": "Current TSB {tsb} is below {thr} — body not recovered, auto-downgraded to a recovery ride",
    "plan.unknown_type": "Unknown workout type: {target} (options: {opts})",
    "plan.too_short": "{dur} minutes cannot fit the {label} workout (warmup {w} + at least {reps}×{min} min main sets + cooldown {c}) — increase the duration or pick a shorter workout",
    "sim.tsb_low": "TSB below {thr} for {days} consecutive days — deep fatigue risk",
    "sim.ctl_ramp": "CTL weekly ramp {pct}% exceeds {thr}% — overtraining risk",

    "tool.date_invalid": "{key} must be YYYY-MM-DD",
    "tool.name_invalid": "invalid file_name",
    "tool.summary_not_found": "not found in training library: {name}",
    "tool.records_not_found": "time-series data not found: {name}",
    "tool.plan_array": "plan must be a non-empty array of [{date, tss}]",
    "tool.plan_max_days": "plan may have at most {n} days",
    "tool.plan_date": "date in plan must be YYYY-MM-DD",
    "tool.plan_tss": "tss in plan must be numeric",
    "tool.duration_invalid": "duration_minutes must be an integer from 15–300",
    "tool.unknown": "unknown tool: {name}",
    "tool.failed": "tool execution failed: {msg}",
    "tool.result_truncated": "（result truncated）",

    "ai.no_key": "No AI key configured (Settings page) — cannot call the AI API",
    "ai.stall": "AI stream idle for over {sec} seconds with no data. The model/account may not truly stream — consider turning streaming off in Settings.",
    "ai.total_timeout": "AI request exceeded {sec} seconds total. If the model genuinely needs longer, raise the timeout in Settings; otherwise check network/API availability.",
    "ai.rounds_exhausted": "Tool call rounds exhausted — answer directly based on the information gathered so far.",
    "ai.empty": "AI API returned empty",

    "srv.body_json": "Request body must be JSON",
    "srv.body_too_large": "Request body too large",
    "srv.name_invalid": "invalid name parameter",
    "srv.category_invalid": "category must be training/race/recovery/leisure",
    "srv.activity_not_found": "activity not found",
    "srv.records_not_found": "time-series data not found (maybe the output dir differed at analysis time)",
    "srv.filename_fit": "filename must be a .fit file",
    "srv.file_empty": "empty file",
    "srv.parse_failed": "parse failed: {msg}",
    "srv.report_create_failed": "failed to create report record: {msg}",
    "srv.ai_submitted": "AI analysis submitted — it will be generated in the background and saved. Check the report history later.",
    "srv.ai_key_missing": "No AI key configured (Settings page) — chat is unavailable",
    "srv.mode_invalid": "mode must be follow_up/chat",
    "srv.message_empty": "message must not be empty",
    "srv.message_too_long": "message too long (max {n} chars)",
    "srv.chat_id_invalid": "invalid chat_id parameter",
    "srv.chat_not_found": "chat not found",
    "srv.chat_submitted": "Submitted — the AI is generating an answer.",
    "srv.id_invalid": "invalid id parameter",
    "srv.mode_param_invalid": "mode must be follow_up/chat",
    "srv.memory_not_found": "memory not found",
    "srv.ftp_range": "ftp_w must be between {lo} and {hi} W",
    "srv.report_mode_invalid": "mode must be review/plan/taper/compare",
    "srv.report_not_found": "report not found",
    "srv.report_pending": "The report is still being generated — refresh later.",
    "srv.ai_failed": "AI analysis failed",
    "srv.lang_invalid": "lang must be zh or en",
    "srv.library_empty": "training library is empty",
    "srv.race_date": "race_date must be YYYY-MM-DD",
    "srv.compare_not_found": "comparison workouts not found in the training library",
    "srv.unknown_mode": "unknown mode: {mode}",
    "srv.report_id_invalid": "invalid report_id parameter",
    "srv.report_body": "Training analysis report:",
    "srv.training_data": "Data for this workout (to cite specifics):",
  },
};

/** 取当前语言的文案并做 {var} 插值；未知 key / 语言缺失时回落 zh / 原 key */
export function t(lang, key, vars) {
  const dict = DICT[normalizeLang(lang)] ?? DICT.zh;
  let s = dict[key] ?? DICT.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(v == null ? "" : String(v));
    }
  }
  return s;
}

/**
 * TSB 状态简评（zh 文案与历史 formNote 逐字一致，供 db.js computeForm 按语言生成）。
 */
export function formNote(tsb, lang) {
  if (tsb >= 15) return t(lang, "form.note.0");
  if (tsb >= 5) return t(lang, "form.note.1");
  if (tsb >= -10) return t(lang, "form.note.2");
  if (tsb >= -20) return t(lang, "form.note.3");
  return t(lang, "form.note.4");
}

/**
 * 结构化异常标注 → 展示文本。
 * 新格式：{ type: "power_gap"|"record_gap"|"timer_pause"|"hr_jump", duration_sec?, from?, to?, at }
 * 旧数据（字符串 anomalies）原样透传，不做翻译。
 */
export function formatAnomaly(a, lang) {
  if (typeof a === "string") return a;
  if (!a || typeof a !== "object") return "";
  switch (a.type) {
    case "power_gap":
      return t(lang, "anom.power_gap", { duration: a.duration_sec, at: a.at });
    case "record_gap":
      return t(lang, "anom.record_gap", { duration: a.duration_sec, at: a.at });
    case "timer_pause":
      return t(lang, "anom.timer_pause", { duration: a.duration_sec, at: a.at });
    case "hr_jump":
      return t(lang, "anom.hr_jump", { from: a.from, to: a.to, at: a.at });
    default:
      return t(lang, "anom.other", { text: a.text ?? String(a) });
  }
}
