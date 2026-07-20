/**
 * settings.js
 * 全部可调配置集中在这里：骑手参数、分区定义、各分析算法的阈值。
 * 换骑手 / 调算法口径时只需改这个文件。
 */

// ============ 骑手参数（改成你自己的，算不准的分析就没意义） ============
export const ATHLETE = {
  ftp_watts: 118, // 功能阈值功率
  max_hr: 195, // 最大心率
  weight_kg: 60,
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
