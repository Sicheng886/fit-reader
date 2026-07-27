/**
 * prompts.js
 * AI 分析提示词模板库（P2）：把「角色 + 指标口径 + 训练数据 + 固化问题」
 * 拼成完整 Markdown，打印到终端供一键复制给任意 AI（API 对接属 P4）。
 *
 * 指标口径说明由 settings.js 动态生成，改骑手参数/分区后提示词自动同步。
 * 本模块全是纯函数，无状态、无 IO。
 */

import { ATHLETE, POWER_ZONES, HR_ZONES } from "./settings.js";

// ---------------- 公共片段 ----------------

/** 指标口径与骑手参数说明（数值取自 settings.js，不硬编码） */
export function buildMetricGlossary() {
  const pct = (x) => (x === Infinity ? "∞" : `${Math.round(x * 100)}%`);
  const powerZones = POWER_ZONES.map(
    (z) => `  - ${z.name}: ${pct(z.min)}–${pct(z.max)} FTP`,
  ).join("\n");
  const hrZones = HR_ZONES.map(
    (z) => `  - ${z.name}: ${pct(z.min)}–${pct(z.max)} 最大心率`,
  ).join("\n");

  return `## 指标口径与骑手参数

骑手参数：FTP ${ATHLETE.ftp_watts}W，最大心率 ${ATHLETE.max_hr}bpm，体重 ${ATHLETE.weight_kg}kg。

指标定义（口径与 Coggan / TrainingPeaks 一致）：
- NP（标准化功率）：30 秒滚动平均的四次方均根，反映"生理代价等效功率"
- IF（强度因子）= NP / FTP；TSS = 时长秒 × NP × IF / (FTP × 3600) × 100
- VI（变异指数）= NP / 平均功率，越接近 1 输出越平稳
- 心率漂移（有氧解耦）：前后半程 效率因子(功率/心率，跑步无功率计时为 速度/心率) 的相对变化，<5% 为有氧基础扎实的标志
- CTL（体能）= TSS 的 42 天指数加权；ATL（疲劳）= 7 天指数加权；TSB（状态）= CTL − ATL，正值=新鲜
- 强度分布类型：polarized=极化（大量低强度+高强度多于中强度）、pyramidal=金字塔（低>中>高）、sweet_spot=甜区取向

功率分区（Coggan 7 区，%FTP）：
${powerZones}

心率分区（%最大心率）：
${hrZones}`;
}

const ROLE = `## 角色

你是一位严谨、务实的自行车教练，熟悉 Coggan 功率训练体系与 TrainingPeaks 负荷模型。请基于数据给出具体、可执行的建议，避免泛泛而谈；数据缺失或可信度不足时明确指出，不要编造。`;

function jsonBlock(obj) {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

/** 统一拼装：角色 + 口径 + 用户背景（可选）+ 各数据段 + 问题清单 */
function assemble(dataSections, questions, profile) {
  return [
    ROLE,
    buildMetricGlossary(),
    ...[buildProfileSection(profile), ...dataSections].filter(Boolean),
    `## 请回答\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
  ].join("\n\n");
}

/**
 * 用户背景与训练目标段（设置页维护，存训练库 settings 表 profile 行）。
 * 未配置或两字段皆空时返回 null（不产生该段）。
 */
export function buildProfileSection(profile) {
  if (!profile) return null;
  const identity = String(profile.identity ?? "").trim();
  const goal = String(profile.goal ?? "").trim();
  if (!identity && !goal) return null;
  const lines = [];
  if (identity) lines.push(`身份：${identity}`);
  if (goal) lines.push(`训练目标：${goal}`);
  return (
    `## 用户背景与训练目标\n\n${lines.join("\n")}\n\n` +
    `请结合上述身份与目标评估训练安排的可行性与侧重点（如时间预算、目标赛事/能力提升方向）。`
  );
}

// ---------------- 提交前数据压缩 ----------------
// summary.json 本身是聚合指标，体积基本与时长无关；但 anomalies（每段缺失一行）
// 与 segments（自动圈）两个列表会随时长线性增长。发送给 AI 前先把它们压缩成
// 聚合统计/首尾取样，保证提示词长度与训练时长无关（纯函数，不改原对象）。

/** 原始 anomalies 条数超过该值时聚合为 anomalies_summary */
const ANOMALY_RAW_MAX = 5;
/** segments 超过该值时保留前 KEEP_HEAD + 后 KEEP_TAIL，中间用占位标记省略 */
const SEGMENTS_MAX = 20;
const SEGMENTS_KEEP_HEAD = 10;
const SEGMENTS_KEEP_TAIL = 5;
/** climbs 超过该值时只保留爬升最大的若干段 */
const CLIMBS_MAX = 10;

/** 把 "功率缺失 78s，起始 ISO" / "心率跳变 130→160，位于 ISO" 这类逐条标注按类型聚合 */
function aggregateAnomalies(anomalies) {
  const groups = new Map();
  for (const a of anomalies) {
    const text = String(a);
    const label = text.split(" ")[0] || "其他";
    const dur = /(\d+)s[，,]/.exec(text)?.[1];
    const at = /(?:起始|位于)\s+(.+)$/.exec(text)?.[1];
    let g = groups.get(label);
    if (!g) {
      g = { type: label, count: 0, first_at: at };
      groups.set(label, g);
    }
    g.count++;
    if (dur != null) {
      const d = Number(dur);
      g.total_sec = (g.total_sec ?? 0) + d;
      g.max_sec = Math.max(g.max_sec ?? 0, d);
    }
  }
  return [...groups.values()];
}

/**
 * 压缩 summary 中随时长增长的列表，返回新对象（原对象不变）：
 * - anomalies 超过 ANOMALY_RAW_MAX 条 → 替换为 anomalies_summary 聚合统计；
 * - segments 超过 SEGMENTS_MAX 段 → 保留首尾，中间省略（首尾对比仍可看出衰减）；
 * - climbs 超过 CLIMBS_MAX 段 → 只保留爬升最大的段。
 */
export function compactSummaryForPrompt(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const out = { ...summary };
  if (Array.isArray(out.anomalies) && out.anomalies.length > ANOMALY_RAW_MAX) {
    out.anomalies_summary = aggregateAnomalies(out.anomalies);
    delete out.anomalies;
  }
  if (Array.isArray(out.segments) && out.segments.length > SEGMENTS_MAX) {
    const omitted = out.segments.length - SEGMENTS_KEEP_HEAD - SEGMENTS_KEEP_TAIL;
    out.segments = [
      ...out.segments.slice(0, SEGMENTS_KEEP_HEAD),
      { name: `...（中间省略 ${omitted} 段）` },
      ...out.segments.slice(-SEGMENTS_KEEP_TAIL),
    ];
  }
  if (Array.isArray(out.climbs) && out.climbs.length > CLIMBS_MAX) {
    out.climbs = [...out.climbs]
      .sort((a, b) => (b.elevation_gain_m ?? 0) - (a.elevation_gain_m ?? 0))
      .slice(0, CLIMBS_MAX);
  }
  return out;
}

// ---------------- 场景模板 ----------------

const CATEGORY_NAMES = {
  training: "训练",
  race: "比赛",
  recovery: "恢复",
  leisure: "休闲",
};

/**
 * 单次复盘：传入某次训练的 summary.json 对象。
 * 若 summary.activity.note 存在（用户在详情页填写的体感/路况备注），提示 AI 纳入考量；
 * profile 为用户背景与训练目标（可选，来自训练库 settings 表）。
 */
export function buildReviewPrompt(summary, profile) {
  const cat = summary?.activity?.category ?? "training";
  const catName = CATEGORY_NAMES[cat] ?? "训练";
  const note = String(summary?.activity?.note ?? "").trim();
  return assemble(
    [
      `## 训练数据（单次骑行汇总）\n\n用户已将本次记录分类为：**${catName}**。请基于该分类进行解读；` +
        `如果是比赛，请按比赛而非日常训练来评估强度与恢复建议。` +
        (note
          ? `用户还为本次训练填写了备注（见 activity.note 字段，内容为体感/路况等主观信息），请结合备注与客观数据互相印证（例如体感差是否对应心率漂移偏大、路况是否解释了功率波动）。`
          : "") +
        `\n\n${jsonBlock(compactSummaryForPrompt(summary))}`,
    ],
    [
      "参考用户标记的分类，判断本次记录的训练/比赛属性，并说明依据。",
      ...(note
        ? ["结合用户备注（activity.note）解读本次训练：主观感受与客观数据是否一致？有何线索？"]
        : []),
      "评估功率与心率的强度分布是否合理：对该训练类型而言，各区时间占比是否符合预期？",
      "评估心率漂移（有氧解耦）：数值说明什么？对有氧基础训练有何指示？",
      "如有间歇组（interval_set）或爬坡段（climbs）：完成质量如何（功率达成度、衰减情况）？",
      "结合 athlete_context 中的 CTL/ATL/TSB，评价这次训练在当前训练周期中的位置与必要性。",
      "如 anomalies / data_quality 有异常标注，说明可能原因及数据可信度影响。",
      "给出 2-3 条下次同类训练的改进建议。",
    ],
    profile,
  );
}

/**
 * 周期规划：基于月汇总 + 逐周 CTL/ATL/TSB 走势 + 近期训练清单。
 * @param {{ months: object[], formSeries: object[], recentActivities: object[] }} data
 * @param {object} [profile] 用户背景与训练目标（可选）
 */
export function buildPlanPrompt({ months, formSeries, recentActivities }, profile) {
  return assemble(
    [
      `## 逐月训练汇总\n\n${jsonBlock(months)}`,
      `## 近期 CTL/ATL/TSB 走势（逐周取样，每天 0 点值）\n\n${jsonBlock(formSeries)}`,
      `## 近期训练清单\n\n${jsonBlock(recentActivities)}`,
    ],
    [
      "评价最近的 CTL 走势：体能是在增长、停滞还是下滑？增速是否安全（一般认为每周 CTL 增幅不宜超过 5-7 点）？",
      "当前 TSB 与疲劳状态如何？近期是否需要安排减量恢复？",
      "从月汇总的强度分布类型（polarized / pyramidal / sweet_spot）看，目前的强度结构是否合理？",
      "下一周应安排什么强度结构？请给出逐日训练建议（类型、时长、目标功率区间或 %FTP）。",
      "中期（4-8 周）应侧重什么能力短板？依据峰功率曲线或间歇数据说明。",
    ],
    profile,
  );
}

/**
 * 赛前调整（减量 taper）。
 * @param {{ raceDate: string, daysLeft: number, form: object, formSeries: object[], recentActivities: object[] }} data
 * @param {object} [profile] 用户背景与训练目标（可选）
 */
export function buildTaperPrompt(
  { raceDate, daysLeft, form, formSeries, recentActivities },
  profile,
) {
  return assemble(
    [
      `## 比赛信息\n\n比赛日期：${raceDate}（距今 ${daysLeft} 天）`,
      `## 当前状态（今日 CTL/ATL/TSB）\n\n${jsonBlock(form)}`,
      `## 近期 CTL/ATL/TSB 走势（逐周取样）\n\n${jsonBlock(formSeries)}`,
      `## 近期训练清单\n\n${jsonBlock(recentActivities)}`,
    ],
    [
      `以比赛日 TSB 达到 +5 ~ +15（新鲜但不掉体能）为目标，当前 TSB 与目标差距多大？`,
      "给出从今天到比赛日的逐日减量计划：每天训练类型、时长、强度（%FTP），说明减量幅度与依据。",
      "减量期间应保留多少高强度（强度保留 vs 纯休息）以避免体能流失？",
      "赛前最后 48 小时的具体安排建议（含预热/ opener 训练）。",
      "指出当前数据中的风险点（如疲劳过深、CTL 太低、近期训练结构问题）。",
    ],
    profile,
  );
}

/**
 * 两次训练对比：传入两个 summary.json 对象。
 * profile 为用户背景与训练目标（可选，来自训练库 settings 表）。
 */
export function buildComparePrompt(summaryA, summaryB, profile) {
  return assemble(
    [
      `## 训练 A（${summaryA.activity?.date ?? "未知日期"}）\n\n${jsonBlock(compactSummaryForPrompt(summaryA))}`,
      `## 训练 B（${summaryB.activity?.date ?? "未知日期"}）\n\n${jsonBlock(compactSummaryForPrompt(summaryB))}`,
    ],
    [
      "先判断两次训练是否属于同类训练（可比性如何），若类型不同请指出对比的局限。",
      "时长归一化比较核心指标：IF、VI、心率漂移、功体比，哪次完成质量更高？",
      "比较峰功率曲线（5s/1min/5min/20min）与分区时间分布，能力结构上有何变化？",
      "比较踏频-功率习惯（cadence_power）与间歇/爬坡数据（如有）。",
      "综合判断：从 A 到 B 是进步、退步还是持平？给出证据。",
      "基于对比结果，给出下一阶段的训练重点建议。",
    ],
    profile,
  );
}

// ---------------- 数据整形（供 index.js 调用） ----------------

/** 逐日 form 序列抽稀为逐周点（每 7 天取一个，含最后一天），控制 prompt 长度 */
export function thinToWeekly(dailySeries) {
  const out = [];
  for (let i = 0; i < dailySeries.length; i += 7) out.push(dailySeries[i]);
  const last = dailySeries[dailySeries.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}
