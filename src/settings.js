/**
 * settings.js
 * 全部可调配置集中在这里：骑手参数出厂默认值、分区定义、各分析算法的阈值。
 *
 * 骑手参数（ATHLETE）与 AI 服务配置（AI_CONFIG）只是"出厂默认值"：训练库 settings 表
 * 存有 athlete / ai 两行配置，由 Web 设置页（/api/athlete、/api/ai-config）维护并作为
 * 唯一事实来源；库中无配置时才用这里的值。
 * 分区定义与算法阈值仍只在本文件调整。
 */

// ============ 骑手参数出厂默认值（Web 设置页保存后以训练库为准） ============
export const ATHLETE = {
  ftp_watts: 106, // 功能阈值功率
  max_hr: 195, // 最大心率
  weight_kg: 60,
};

// ============ AI 服务出厂默认值（Web 设置页保存后以训练库为准，默认 Kimi） ============
export const AI_CONFIG = {
  api_key: null, // API 密钥；为空时 AI 报告退化为"复制提示词"模式
  base_url: "https://api.moonshot.cn/v1", // OpenAI 兼容接口地址
  model: "kimi-k2.6", // 模型名
  temperature: null, // 采样温度；null 表示不传（部分模型只允许特定取值）
  timeout_ms: 600000, // 总等待超时（复盘报告生成慢，默认 10 分钟）
  stream: false, // 是否流式输出；部分账号/模型不真正流式吐字，非流式更稳
  stall_ms: 60000, // 流式空闲超时，每收到一个 chunk 重置
  agentic: true, // 是否启用 agentic 工具调用（function calling）；模型不支持 tools 时自动降级单轮
};

// ============ Agentic 工具调用参数（ai.js runAgentLoop / tools.js 使用） ============
export const AGENTIC = {
  max_rounds: 6, // 最大工具调用轮数，超出后强制模型直接作答
  tool_result_max_chars: 4000, // 单个工具结果截断上限（超出附"（结果已截断）"标记）
  records_max_points: 600, // get_activity_records 时序抽稀点数上限
  list_limit: 50, // list_activities 返回条数上限
  form_max_days: 120, // get_form_series 天数上限
  monthly_max: 24, // get_monthly_summary 月数上限
  simulate_max_days: 60, // simulate_form 推演天数上限（紧凑数组输出不超截断线）
};

// ============ 未来负荷推演风险阈值（src/planning.js simulateForm 使用） ============
export const FORM_SIMULATION = {
  tsb_low: -30, // TSB 低于该值视为深度疲劳
  tsb_low_days: 7, // TSB 持续低于阈值达到该天数触发警示
  ctl_ramp_pct: 10, // CTL 周增幅上限（%），超出触发过度训练风险警示
  tsb_recovery: -20, // generateWorkout 中 TSB 低于该值自动降级为恢复课
};

// ============ 单次课表模板（src/planning.js generateWorkout 使用） ============
// 功率按 FTP 百分比；时长单位分钟；TSS 估算按各段 时长秒 × IF² / 36 逐段求和
export const WORKOUT_TEMPLATES = {
  recovery: {
    label: "恢复骑",
    steady: { pct: [0.4, 0.55], if: 0.5 }, // 全程稳态，无间歇组
  },
  endurance: {
    label: "有氧耐力",
    steady: { pct: [0.56, 0.75], if: 0.68 },
  },
  sweet_spot: {
    label: "甜区",
    warmup_min: 15,
    set: { pct: [0.88, 0.94], if: 0.91, min_min: 10, max_min: 20 },
    reps: [2, 3],
    rest_min: 5,
    cooldown_min: 10,
  },
  threshold: {
    label: "阈值",
    warmup_min: 15,
    set: { pct: [0.95, 1.05], if: 1.0, min_min: 10, max_min: 15 },
    reps: [2, 3],
    rest_min: 5,
    cooldown_min: 10,
  },
  vo2max: {
    label: "VO2max",
    warmup_min: 15,
    set: { pct: [1.06, 1.2], if: 1.13, min_min: 3, max_min: 5 },
    reps: [4, 6],
    rest_min: null, // null = 组间休息与单组等时
    cooldown_min: 10,
  },
};

// ============ 功率分区（Coggan 7 区，按 FTP 百分比） ============
export const POWER_ZONES = [
  { name: "Z1", min: 0.0, max: 0.55 },
  { name: "Z2", min: 0.55, max: 0.75 },
  { name: "Z3", min: 0.75, max: 0.9 },
  { name: "Z4", min: 0.9, max: 1.05 },
  { name: "Z5", min: 1.05, max: 1.2 },
  { name: "Z6", min: 1.2, max: 1.5 },
  { name: "Z7", min: 1.5, max: Infinity },
];

// ============ 心率分区（按最大心率百分比） ============
export const HR_ZONES = [
  { name: "Z1", min: 0.0, max: 0.68 },
  { name: "Z2", min: 0.68, max: 0.75 },
  { name: "Z3", min: 0.75, max: 0.85 },
  { name: "Z4", min: 0.85, max: 0.92 },
  { name: "Z5", min: 0.92, max: Infinity },
];

// ============ 间歇识别阈值 ============
export const INTERVAL_DETECTION = {
  threshold_pct: 1.05, // 工作段功率下限（按 FTP 百分比，Z5 起步）
  min_duration_sec: 30, // 短于该时长的工作段不计为间歇
  merge_gap_sec: 10, // 低于阈值不超过该时长视为瞬时掉功率，合并相邻段
};

// ============ 爬坡段提取阈值 ============
export const CLIMB_DETECTION = {
  min_grade_pct: 3, // 平均坡度下限（%）
  min_gain_m: 15, // 段内累计爬升下限（米）
  min_distance_m: 300, // 段长下限（米）
  smooth_sec: 30, // 坡度计算窗口（秒），用于压海拔噪声
};

// ============ 数据质量阈值 ============
export const DATA_QUALITY = {
  record_gap_sec: 10, // 逐秒网格中连续缺失超过该时长，在 anomalies 中标注（损坏文件被跳过的记录会表现为这种缺口）
};

// ============ FTP 历史估算阈值（ftp.js：窗口内功率峰曲线 + 心率交叉验证） ============
export const FTP_ESTIMATION = {
  window_days: 42, // 回看窗口（天）：取最近 6 周内的骑行做联合估算
  min_rides: 3, // 窗口内带功率数据的骑行次数下限，不足则判定数据不充分
  min_coverage_pct: 80, // 单次骑行的功率/心率覆盖率下限（%），低于则不采信该次数据
  max_effort_hr_pct: 0.9, // 全力判定：20min 峰功率所在骑行的心率峰值需 ≥ 该比例 × max_hr
  zone_mismatch_pct: 15, // 功率 Z4+ 与心率 Z4+ 时长占比差（百分点）超过该值判定系统性偏移
  drift_warn_pct: 5, // 心率漂移（有氧解耦）中位数超过该值提示数据漂移（疲劳/脱水/高温）
  consistency_pct: 3, // CP 模型与 Coggan 20min×0.95 两法结果相差在该比例内判定"一致"
  cp_short_sec: 300, // CP 模型短锚点：5 分钟峰功率
  cp_long_sec: 1200, // CP 模型长锚点：20 分钟峰功率
  coggan_factor: 0.95, // Coggan 口径：20 分钟峰功率 × 该系数 ≈ FTP
  apply_min_w: 50, // 「采纳写回」时可接受的 FTP 下限（W）
  apply_max_w: 500, // 「采纳写回」时可接受的 FTP 上限（W）
};

// ============ 踏频-功率联合分析阈值 ============
export const CADENCE_ANALYSIS = {
  power_floor_pct: 0.75, // 只统计功率 ≥ 该比例 × FTP 的"发力时段"（Z3 起步）
  low_cadence_rpm: 80, // 低于该踏频视为低踏频高扭矩
  high_cadence_rpm: 90, // 高于该踏频视为高踏频
};
