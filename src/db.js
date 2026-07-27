/**
 * db.js
 * 训练库（SQLite，node:sqlite 内置模块，零第三方依赖）：
 *   - 每次分析后把 summary 入库（按文件名去重，重复分析覆盖更新）
 *   - 基于历史 TSS 计算 CTL / ATL / TSB（体能/疲劳/状态）
 *   - 月汇总、趋势数据与提示词上下文查询（recentActivities / recentFormDaily）
 *   - settings 表：骑手参数（athlete）、AI 服务配置（ai）与用户背景/训练目标（profile）
 *     持久化，Web 设置页维护；
 *     syncAthleteFromDb() / syncAiConfigFromDb() 把库值原地合并进 settings.js 的
 *     ATHLETE / AI_CONFIG 导出对象；migrateAiEnvToDb() 负责老版本 FIT_AI_*
 *     环境变量的一次性迁入（迁移后 env 被完全忽略）
 *   - activities.note 列：用户在详情页填写的训练备注（体感/路况等），
 *     getActivitySummary() 合并进 summary.activity.note，AI 复盘提示词纳入考量
 *
 * 数据库文件固定为 ./db/fitness.db（可用环境变量 FIT_DB_PATH 覆盖，供测试隔离），
 * 不存在时自动创建。
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ATHLETE, AI_CONFIG, FTP_ESTIMATION } from "./settings.js";

const DB_PATH = process.env.FIT_DB_PATH || path.resolve("db", "fitness.db");

let _db = null;

/** 懒打开数据库：目录/文件/表不存在时自动创建 */
function openDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      sport TEXT,
      duration_sec INTEGER,
      distance_km REAL,
      elevation_gain_m REAL,
      tss REAL,
      np REAL,
      avg_power REAL,
      intensity_factor REAL,
      summary_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);

    CREATE TABLE IF NOT EXISTS ai_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      file_name TEXT,
      race_date TEXT,
      compare_with TEXT,
      prompt TEXT NOT NULL,
      markdown TEXT NOT NULL,
      status TEXT DEFAULT 'completed',
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_reports_mode_created ON ai_reports(mode, created_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureActivityCategoryColumn(_db);
  ensureActivityNoteColumn(_db);
  ensureAiReportStatusColumn(_db);
  return _db;
}

/** 为已存在的数据库迁移增加 activities.category 列（默认 training） */
function ensureActivityCategoryColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(activities)`).all();
  if (!cols.some((c) => c.name === "category")) {
    db.exec(`ALTER TABLE activities ADD COLUMN category TEXT DEFAULT 'training'`);
    db.exec(`UPDATE activities SET category = 'training' WHERE category IS NULL`);
  }
}

/** 为已存在的数据库迁移增加 activities.note 列（用户自由备注：体感/路况等） */
function ensureActivityNoteColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(activities)`).all();
  if (!cols.some((c) => c.name === "note")) {
    db.exec(`ALTER TABLE activities ADD COLUMN note TEXT DEFAULT NULL`);
  }
}

/** 为已存在的数据库迁移增加 ai_reports.status / ai_reports.error 列及对应索引 */
function ensureAiReportStatusColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(ai_reports)`).all();
  if (!cols.some((c) => c.name === "status")) {
    db.exec(`ALTER TABLE ai_reports ADD COLUMN status TEXT DEFAULT 'completed'`);
    db.exec(`UPDATE ai_reports SET status = 'completed' WHERE status IS NULL`);
  }
  if (!cols.some((c) => c.name === "error")) {
    db.exec(`ALTER TABLE ai_reports ADD COLUMN error TEXT DEFAULT NULL`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_reports_status ON ai_reports(status)`);
}

/** 关闭数据库句柄（测试清理临时库文件前调用；生产路径无需调用） */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------- 骑手参数（存 settings 表，Web 设置页维护） ----------------

/**
 * 从训练库读取 athlete 行并原地覆盖 settings.js 的 ATHLETE 导出对象。
 * 库中无 athlete 行时保持 settings.js 出厂默认值。
 * index.js（analyzeFile / main）与 server.js 启动时调用，
 * 利用"导出对象属性可变"让所有读 ATHLETE 的模块看到最新值。
 */
export function syncAthleteFromDb() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'athlete'`).get();
  if (!row) return;
  try {
    Object.assign(ATHLETE, JSON.parse(row.value));
  } catch {
    // 行内容损坏时忽略，保持默认值
  }
}

/** 当前骑手参数状态：生效值（库行覆盖默认值）+ 是否已在库中配置（Web 首开引导用） */
export function getAthleteState() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'athlete'`).get();
  const athlete = { ...ATHLETE };
  if (row) {
    try {
      Object.assign(athlete, JSON.parse(row.value));
    } catch {
      // 行内容损坏时按未配置之外的默认值返回
    }
  }
  return { athlete, configured: !!row };
}

// 骑手参数合法范围（FTP 上下限复用 FTP_ESTIMATION 的采纳写回口径）
const ATHLETE_LIMITS = {
  ftp_watts: [FTP_ESTIMATION.apply_min_w, FTP_ESTIMATION.apply_max_w],
  max_hr: [120, 230],
  weight_kg: [30, 200],
};

/**
 * 更新骑手参数（允许只给部分字段）：校验 → 合并当前值写库 → 原地生效。
 * 非法值抛 Error（中文 message，Web API 直接透传给前端）。
 */
export function setAthlete(partial) {
  const updates = {};
  for (const key of Object.keys(ATHLETE_LIMITS)) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    const [lo, hi] = ATHLETE_LIMITS[key];
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw new Error(`${key} 需在 ${lo}–${hi} 之间`);
    updates[key] = v;
  }
  if (!Object.keys(updates).length)
    throw new Error("至少需要提供一个字段：ftp_watts / max_hr / weight_kg");
  const merged = { ...ATHLETE, ...updates };
  const db = openDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(merged));
  Object.assign(ATHLETE, merged); // 原地生效，当前进程无需重启
  return { ...ATHLETE };
}

// ---------------- AI 服务配置（存 settings 表，Web 设置页维护） ----------------

/**
 * 从训练库读取 ai 行并原地覆盖 settings.js 的 AI_CONFIG 导出对象。
 * 库中无 ai 行时保持 settings.js 出厂默认值（默认 Kimi，api_key 为空）。
 * server.js 启动时调用；setAiConfig() 保存后也会原地生效。
 */
export function syncAiConfigFromDb() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get();
  if (!row) return;
  try {
    Object.assign(AI_CONFIG, JSON.parse(row.value));
  } catch {
    // 行内容损坏时忽略，保持默认值
  }
}

/** 当前 AI 配置状态：生效值（库行覆盖默认值）+ 是否已配置密钥 */
export function getAiConfig() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get();
  const config = { ...AI_CONFIG };
  if (row) {
    try {
      Object.assign(config, JSON.parse(row.value));
    } catch {
      // 行内容损坏时按默认值返回
    }
  }
  return { config, configured: Boolean(config.api_key) };
}

/**
 * 更新 AI 服务配置（允许只给部分字段）：校验 → 合并当前值写库 → 原地生效。
 * 非法值抛 Error（中文 message，Web API 直接透传给前端）。
 * api_key 传空字符串表示清除密钥（退化为复制提示词模式）。
 */
export function setAiConfig(partial) {
  const updates = {};
  if (partial?.api_key != null) {
    if (typeof partial.api_key !== "string")
      throw new Error("api_key 需为字符串");
    updates.api_key = partial.api_key.trim() || null;
  }
  if (partial?.base_url != null) {
    const u = String(partial.base_url).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(u)) throw new Error("base_url 需为 http(s) 地址");
    updates.base_url = u;
  }
  if (partial?.model != null) {
    const m = String(partial.model).trim();
    if (!m) throw new Error("model 不能为空");
    updates.model = m;
  }
  if (partial?.temperature !== undefined) {
    if (partial.temperature === null || partial.temperature === "") {
      updates.temperature = null; // 不传 temperature，用 API 默认
    } else {
      const t = Number(partial.temperature);
      if (!Number.isFinite(t) || t < 0 || t > 2)
        throw new Error("temperature 需在 0–2 之间，或留空表示不传");
      updates.temperature = t;
    }
  }
  for (const key of ["timeout_ms", "stall_ms"]) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    if (!Number.isFinite(v) || v < 1000)
      throw new Error(`${key} 需为 ≥1000 的毫秒数`);
    updates[key] = Math.round(v);
  }
  if (partial?.stream != null) updates.stream = Boolean(partial.stream);
  if (!Object.keys(updates).length)
    throw new Error("至少需要提供一个字段：api_key / base_url / model / temperature / timeout_ms / stream / stall_ms");
  const merged = { ...AI_CONFIG, ...updates };
  const db = openDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(merged));
  Object.assign(AI_CONFIG, merged); // 原地生效，当前进程无需重启
  return { ...AI_CONFIG };
}

/**
 * 一次性迁移：老版本用 FIT_AI_* 环境变量配置 AI，若库中尚无 ai 行而
 * 环境里存在 FIT_AI_API_KEY，则把它迁入训练库（server.js 入口在
 * process.loadEnvFile() 之后调用一次）。迁移后环境变量被完全忽略。
 */
export function migrateAiEnvToDb() {
  const key = process.env.FIT_AI_API_KEY;
  if (!key) return false;
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get();
  if (row) return false; // 库里已有配置，以库为准
  const num = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  };
  const fromEnv = {
    api_key: key,
    base_url: process.env.FIT_AI_BASE_URL || undefined,
    model: process.env.FIT_AI_MODEL || undefined,
    temperature:
      process.env.FIT_AI_TEMPERATURE != null
        ? Number(process.env.FIT_AI_TEMPERATURE)
        : undefined,
    timeout_ms: num("FIT_AI_TIMEOUT_MS"),
    stream:
      process.env.FIT_AI_STREAM != null
        ? process.env.FIT_AI_STREAM === "true" || process.env.FIT_AI_STREAM === "1"
        : undefined,
    stall_ms: num("FIT_AI_STALL_MS"),
  };
  // 清掉 undefined 后复用 setAiConfig 的校验与写库路径
  const clean = Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v !== undefined));
  setAiConfig(clean);
  return true;
}

const VALID_CATEGORIES = new Set(["training", "race", "recovery", "leisure"]);
const CATEGORY_LABEL = {
  training: "训练",
  race: "比赛",
  recovery: "恢复",
  leisure: "休闲",
};

/** 校验训练分类是否合法 */
export function isValidCategory(category) {
  return VALID_CATEGORIES.has(category);
}

/** 返回分类的中文名，未知时返回原值 */
export function categoryLabel(category) {
  return CATEGORY_LABEL[category] ?? category ?? "训练";
}

/**
 * 更新训练分类（训练/比赛/恢复/休闲）。
 * 非法值或训练不存在时抛 Error（Web API 直接透传给前端）。
 */
export function setActivityCategory(fileName, category) {
  if (!isValidCategory(category)) throw new Error("分类需为 training/race/recovery/leisure");
  const db = openDb();
  const info = db
    .prepare(`UPDATE activities SET category = ? WHERE file_name = ?`)
    .run(category, fileName);
  if (info.changes === 0) throw new Error("训练不存在");
  return { ok: true };
}

/** 获取训练分类，未设置时默认训练 */
export function getActivityCategory(fileName) {
  const db = openDb();
  const row = db.prepare(`SELECT category FROM activities WHERE file_name = ?`).get(fileName);
  return row?.category ?? "training";
}

// 备注长度上限（自由文本：体感/路况等），防止误贴大段内容撑爆训练库与提示词
const NOTE_MAX_LEN = 2000;

/**
 * 更新训练备注（用户自由注释，AI 复盘时纳入考量）。
 * 传空字符串/纯空白表示清除备注；训练不存在时抛 Error（Web API 直接透传给前端）。
 */
export function setActivityNote(fileName, note) {
  const text = String(note ?? "").trim();
  if (text.length > NOTE_MAX_LEN) throw new Error(`备注过长（上限 ${NOTE_MAX_LEN} 字）`);
  const db = openDb();
  const info = db
    .prepare(`UPDATE activities SET note = ? WHERE file_name = ?`)
    .run(text || null, fileName);
  if (info.changes === 0) throw new Error("训练不存在");
  return { ok: true, note: text || null };
}

// ---------------- 用户背景与训练目标（存 settings 表 profile 行，Web 设置页维护） ----------------

// 各字段长度上限：身份一句话、目标一段话
const PROFILE_LIMITS = { identity: 100, goal: 500 };

/** 当前用户背景与训练目标：{ identity, goal, configured }；未配置时两字段为空字符串 */
export function getProfile() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'profile'`).get();
  let profile = { identity: "", goal: "" };
  if (row) {
    try {
      const p = JSON.parse(row.value);
      profile = {
        identity: typeof p.identity === "string" ? p.identity : "",
        goal: typeof p.goal === "string" ? p.goal : "",
      };
    } catch {
      // 行内容损坏时按未配置返回
    }
  }
  return { ...profile, configured: !!(profile.identity || profile.goal) };
}

/**
 * 更新用户背景与训练目标（允许只给部分字段）：校验 → 合并写库。
 * 两字段都为空时删除 profile 行（视为未配置）。非法值抛 Error（Web API 直接透传）。
 */
export function setProfile(partial) {
  const current = getProfile();
  const merged = { identity: current.identity, goal: current.goal };
  for (const key of Object.keys(PROFILE_LIMITS)) {
    if (partial?.[key] == null) continue;
    if (typeof partial[key] !== "string") throw new Error(`${key} 需为字符串`);
    const v = partial[key].trim();
    if (v.length > PROFILE_LIMITS[key])
      throw new Error(`${key} 过长（上限 ${PROFILE_LIMITS[key]} 字）`);
    merged[key] = v;
  }
  const db = openDb();
  if (!merged.identity && !merged.goal) {
    db.prepare(`DELETE FROM settings WHERE key = 'profile'`).run();
  } else {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(merged));
  }
  return { ...merged, configured: !!(merged.identity || merged.goal) };
}

/** 保存 AI 分析报告；每个 mode 仅保留最近 30 条 */
export function saveAiReport(mode, context, prompt, markdown) {
  const db = openDb();
  const info = db
    .prepare(
      `INSERT INTO ai_reports (mode, file_name, race_date, compare_with, prompt, markdown, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
    )
    .run(
      mode,
      context?.file_name ?? null,
      context?.race_date ?? null,
      context?.compare_with ?? null,
      prompt ?? "",
      markdown ?? "",
    );
  // 每个 mode 仅保留最近 30 条（用 id DESC，自增主键严格反映插入顺序，不受 created_at 秒级精度影响）
  db.prepare(
    `DELETE FROM ai_reports
     WHERE id NOT IN (
       SELECT id FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT 30
     ) AND mode = ?`,
  ).run(mode, mode);
  return Number(info.lastInsertRowid);
}

/** 创建一个 status = pending 的 AI 报告占位记录，用于后台生成时前端可见进度 */
export function createPendingAiReport(mode, context, prompt) {
  const db = openDb();
  const info = db
    .prepare(
      `INSERT INTO ai_reports (mode, file_name, race_date, compare_with, prompt, markdown, status)
       VALUES (?, ?, ?, ?, ?, '', 'pending')`,
    )
    .run(
      mode,
      context?.file_name ?? null,
      context?.race_date ?? null,
      context?.compare_with ?? null,
      prompt ?? "",
    );
  // 同样受 30 条滚动限制；pending 占位也参与计数
  db.prepare(
    `DELETE FROM ai_reports
     WHERE id NOT IN (
       SELECT id FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT 30
     ) AND mode = ?`,
  ).run(mode, mode);
  return Number(info.lastInsertRowid);
}

/** 更新 AI 报告（后台生成成功/失败时回填） */
export function updateAiReport(id, { markdown, status, error } = {}) {
  const db = openDb();
  db.prepare(
    `UPDATE ai_reports
     SET markdown = COALESCE(?, markdown),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(markdown ?? null, status ?? null, error ?? null, id);
}

/** 列出某 mode 的最近 N 条报告（默认 30） */
export function listAiReports(mode, n = 30) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, mode, file_name, race_date, compare_with, status, error, created_at
       FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(mode, n);
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    file_name: r.file_name,
    race_date: r.race_date,
    compare_with: r.compare_with,
    status: r.status,
    error: r.error,
    created_at: r.created_at,
  }));
}

/** 按 id 取单条完整报告（含 prompt + markdown + status + error），不存在返回 null */
export function getAiReport(id) {
  const db = openDb();
  const row = db.prepare(`SELECT * FROM ai_reports WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    file_name: row.file_name,
    race_date: row.race_date,
    compare_with: row.compare_with,
    prompt: row.prompt,
    markdown: row.markdown,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
  };
}

/** 分析结果入库：同一文件名重复分析时覆盖更新 */
export function upsertActivity(fileName, summary) {
  const db = openDb();
  const a = summary.activity;
  const p = summary.power ?? {}; // 无功率数据的运动（跑步/游泳）没有 power 段
  db.prepare(
    `INSERT INTO activities
       (file_name, date, sport, duration_sec, distance_km, elevation_gain_m,
        tss, np, avg_power, intensity_factor, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_name) DO UPDATE SET
       date = excluded.date,
       sport = excluded.sport,
       duration_sec = excluded.duration_sec,
       distance_km = excluded.distance_km,
       elevation_gain_m = excluded.elevation_gain_m,
       tss = excluded.tss,
       np = excluded.np,
       avg_power = excluded.avg_power,
       intensity_factor = excluded.intensity_factor,
       summary_json = excluded.summary_json`,
  ).run(
    fileName,
    a.date,
    a.sport ?? null,
    a.duration_sec ?? null,
    a.distance_km ?? null,
    a.elevation_gain_m ?? null,
    p.tss ?? null,
    p.normalized_power ?? null,
    p.avg ?? null,
    p.intensity_factor ?? null,
    JSON.stringify(summary),
  );
}

/** 取出 [起始, endDate] 范围内逐日 TSS（按天聚合，缺天补 0）→ [{ date, tss }] */
function dailyTssSeries(endDate) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, SUM(COALESCE(tss, 0)) AS tss
       FROM activities WHERE date <= ? GROUP BY date ORDER BY date`,
    )
    .all(endDate);
  if (!rows.length) return [];
  // 补齐缺天（TSS = 0，休息日同样参与 CTL/ATL 衰减）
  const series = [];
  const byDate = new Map(rows.map((r) => [r.date, r.tss]));
  const cur = new Date(rows[0].date + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    series.push({ date: d, tss: byDate.get(d) ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return series;
}

/**
 * CTL / ATL / TSB（指数加权，口径与 TrainingPeaks 一致）：
 *   CTL_d = CTL_{d-1} + (TSS_d − CTL_{d-1}) / 42   慢性负荷（体能）
 *   ATL_d = ATL_{d-1} + (TSS_d − ATL_{d-1}) / 7    急性负荷（疲劳）
 *   TSB   = CTL − ATL                              状态（正值=新鲜）
 * 初始值 0，计算到 date 当天（含）。
 */
export function computeForm(date) {
  const series = dailyTssSeries(date);
  if (!series.length) return null;
  let ctl = 0,
    atl = 0;
  for (const d of series) {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
  }
  const tsb = ctl - atl;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    ctl: r1(ctl),
    atl: r1(atl),
    tsb: r1(tsb),
    form_note: formNote(tsb),
  };
}

/**
 * 最近 N 天逐日负荷序列：[{ date, tss, ctl, atl, tsb }]。
 * 与 computeForm 同一递推口径，供周期规划/赛前调整提示词取走势数据。
 * 序列末端延伸到当前实际日期（无训练日 TSS=0 照常参与 CTL/ATL 衰减），
 * 这样趋势图与"当前体能指数"反映今天，而不是停在最后一次训练的日期。
 */
export function recentFormDaily(days = 56) {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  // 活动日期为 UTC 口径（records 时间戳的 ISO 前 10 位），今天同样取 UTC
  const today = new Date().toISOString().slice(0, 10);
  const series = dailyTssSeries(row.d < today ? today : row.d);
  let ctl = 0,
    atl = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const daily = series.map((d) => {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    return { date: d.date, tss: r1(d.tss), ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) };
  });
  return daily.slice(-days);
}

/** 训练清单（含文件名/运动类型，供 Web 界面列表展示，按日期倒序） */
export function listActivities(n = 200) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT file_name, date, sport, category, duration_sec, distance_km, elevation_gain_m,
              tss, np, avg_power, intensity_factor
       FROM activities ORDER BY date DESC LIMIT ?`,
    )
    .all(n);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    file_name: r.file_name,
    date: r.date,
    sport: r.sport,
    category: r.category ?? "training",
    duration_sec: r.duration_sec,
    distance_km: r1(r.distance_km),
    elevation_gain_m: r.elevation_gain_m == null ? null : Math.round(r.elevation_gain_m),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    avg_power: r.avg_power == null ? null : Math.round(r.avg_power),
    intensity_factor: r.intensity_factor == null ? null : r1(r.intensity_factor),
  }));
}

/** 按文件名取单条训练的完整 summary JSON（Web 详情页用），不存在返回 null */
export function getActivitySummary(fileName) {
  const db = openDb();
  const row = db
    .prepare(`SELECT summary_json, category, note FROM activities WHERE file_name = ?`)
    .get(fileName);
  if (!row) return null;
  try {
    const summary = JSON.parse(row.summary_json);
    if (summary?.activity && row.category) {
      summary.activity.category = row.category;
    }
    if (summary?.activity && row.note) {
      summary.activity.note = row.note; // 用户备注（体感/路况等），AI 复盘时纳入考量
    }
    return summary;
  } catch {
    return null;
  }
}

/**
 * 最近 n 条训练简明清单（供提示词上下文，按日期倒序）。
 * 除基础负荷字段外，从完整 summary 补充心率漂移/峰功率曲线/平均踏频（缺则省略）；
 * IF 保留 2 位小数——1 位小数会让 AI 用 NP/IF 反推 FTP 时产生 ±5W 级噪音。
 */
export function recentActivities(n = 10) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, duration_sec, distance_km, tss, np, intensity_factor, summary_json
       FROM activities ORDER BY date DESC LIMIT ?`,
    )
    .all(n);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return rows.map((r) => {
    const out = {
      date: r.date,
      duration_min: r.duration_sec == null ? null : Math.round(r.duration_sec / 60),
      distance_km: r1(r.distance_km),
      tss: r.tss == null ? null : Math.round(r.tss),
      np: r.np == null ? null : Math.round(r.np),
      intensity_factor:
        r.intensity_factor == null ? null : r2(r.intensity_factor),
    };
    try {
      const s = JSON.parse(r.summary_json);
      if (s?.heart_rate?.hr_drift_pct != null)
        out.hr_drift_pct = r1(s.heart_rate.hr_drift_pct);
      if (s?.power?.peak_curve) out.peak_power_curve = s.power.peak_curve;
      if (s?.cadence?.avg != null) out.cadence_avg = s.cadence.avg;
    } catch {
      // summary_json 损坏时仅返回基础字段
    }
    return out;
  });
}

/**
 * 最近 N 天内的骑行训练完整 summary（FTP 历史估算用，按日期倒序）。
 * 仅返回 sport='cycling' 的记录；summary_json 损坏的行跳过。
 */
export function cyclingSummariesSince(days = 42) {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  const since = new Date(row.d + "T00:00:00Z");
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT file_name, date, duration_sec, summary_json
       FROM activities
       WHERE sport = 'cycling' AND date >= ?
       ORDER BY date DESC`,
    )
    .all(sinceStr);
  const out = [];
  for (const r of rows) {
    try {
      out.push({
        file_name: r.file_name,
        date: r.date,
        duration_sec: r.duration_sec,
        summary: JSON.parse(r.summary_json),
      });
    } catch {
      // 存档 JSON 损坏时跳过该条
    }
  }
  return out;
}

/** TSB 中文简评（供 athlete_context / AI 参考） */
function formNote(tsb) {
  if (tsb >= 15) return "状态很新鲜，适合比赛或高强度测试";
  if (tsb >= 5) return "状态良好，恢复充分";
  if (tsb >= -10) return "负荷与恢复平衡，可持续训练";
  if (tsb >= -20) return "疲劳积累期，注意睡眠与恢复";
  return "过度疲劳风险，建议安排减量周";
}

/**
 * 最近 n 个月汇总（按自然月）：
 * 月 TSS / 时长 / 距离 / 次数，以及 低(Z1-Z2)/中(Z3-Z4)/高(Z5-Z7) 强度时间占比与类型判读。
 */
export function monthlySummary(n = 6) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, duration_sec, distance_km, tss, summary_json
       FROM activities ORDER BY date DESC`,
    )
    .all();

  const months = new Map();
  for (const r of rows) {
    const m = r.date.slice(0, 7); // YYYY-MM
    if (!months.has(m)) {
      months.set(m, {
        month: m,
        tss: 0,
        duration_sec: 0,
        distance_km: 0,
        count: 0,
        low: 0, // 各区加权秒数
        mid: 0,
        high: 0,
      });
    }
    const agg = months.get(m);
    const dur = r.duration_sec ?? 0;
    agg.tss += r.tss ?? 0;
    agg.duration_sec += dur;
    agg.distance_km += r.distance_km ?? 0;
    agg.count += 1;
    // 强度分布：zone_distribution_pct × 时长 加权累计
    try {
      const z = JSON.parse(r.summary_json).power?.zone_distribution_pct;
      if (z && dur > 0) {
        agg.low += ((z.Z1 ?? 0) + (z.Z2 ?? 0)) * 0.01 * dur;
        agg.mid += ((z.Z3 ?? 0) + (z.Z4 ?? 0)) * 0.01 * dur;
        agg.high += ((z.Z5 ?? 0) + (z.Z6 ?? 0) + (z.Z7 ?? 0)) * 0.01 * dur;
      }
    } catch {
      // 存档 JSON 损坏时跳过强度分布，不影响其他字段
    }
  }

  const result = [...months.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, n)
    .map((w) => {
      const zoneTotal = w.low + w.mid + w.high;
      const pct = (x) =>
        zoneTotal > 0 ? Math.round((x / zoneTotal) * 1000) / 10 : null;
      const lowPct = pct(w.low),
        midPct = pct(w.mid),
        highPct = pct(w.high);
      let intensity_type = null;
      if (lowPct != null) {
        // 极化：大量低强度 + 高强度多于中强度；金字塔：低>中>高；其余归为甜区/阈值取向
        if (lowPct >= 75 && highPct > midPct) intensity_type = "polarized";
        else if (lowPct > midPct && midPct > highPct)
          intensity_type = "pyramidal";
        else intensity_type = "sweet_spot";
      }
      return {
        month: w.month,
        tss: Math.round(w.tss),
        hours: Math.round((w.duration_sec / 3600) * 10) / 10,
        distance_km: Math.round(w.distance_km * 10) / 10,
        sessions: w.count,
        intensity_pct:
          lowPct != null ? { low: lowPct, mid: midPct, high: highPct } : null,
        intensity_type,
      };
    });
  return result;
}

/**
 * 逐月趋势：每月 { month, tss, ctl, atl, tsb }。
 * tss 为当月合计；ctl/atl/tsb 取该月最后一天的值（逐日递推得到，衰减口径不变）。
 */
export function trendMonthly() {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  const series = dailyTssSeries(row.d);
  let ctl = 0,
    atl = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const months = new Map();
  for (const d of series) {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    const m = d.date.slice(0, 7);
    const agg = months.get(m) ?? { month: m, tss: 0 };
    agg.tss += d.tss;
    agg.ctl = r1(ctl); // 遍历按日期升序，月末值自然覆盖
    agg.atl = r1(atl);
    agg.tsb = r1(ctl - atl);
    months.set(m, agg);
  }
  return [...months.values()].map((m) => ({ ...m, tss: r1(m.tss) }));
}
