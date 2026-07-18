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

// ============ 踏频-功率联合分析阈值 ============
export const CADENCE_ANALYSIS = {
  power_floor_pct: 0.75, // 只统计功率 ≥ 该比例 × FTP 的"发力时段"（Z3 起步）
  low_cadence_rpm: 80, // 低于该踏频视为低踏频高扭矩
  high_cadence_rpm: 90, // 高于该踏频视为高踏频
};
