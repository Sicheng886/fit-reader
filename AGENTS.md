# AGENTS.md — fit-reader 项目说明（供 AI 编码代理阅读）

## 项目概览

**fit-reader** 是一个无构建步骤的 Node.js 命令行项目（主脚本 `index.js` + 配置 `settings.js`），用于解析码表/运动手表导出的 `.fit` 文件（当前以骑行数据为主），输出两类结果：

1. `xxx.records.csv` — 重采样到严格 1 秒网格的逐秒时序明细（timestamp, power, heart_rate, cadence, altitude, speed, distance_m, temperature），供存档与程序化计算；
2. `xxx.summary.json` — 汇总训练指标（NP、IF、TSS、功率/心率分区分布、峰功率曲线、心率漂移、圈/赛段、数据质量与异常标注），设计上用于直接喂给 AI 做训练解读。

这不是一个库，也没有构建步骤——直接运行脚本即可。

## 技术栈与运行方式

- **运行时**：Node.js（已在 v22.20.0 上验证），**ESM（ECMAScript Modules）**（`package.json` 中 `"type": "module"`，源码使用 `import`/`export` 语法），零构建、零转译。
- **唯一依赖**：`fit-file-parser`（解析 `.fit`）和 `marked`（AI 报告 Markdown 转 HTML），均通过 `npm install` 安装。
- **关键配置**：`package.json`（`main: index.js`，脚本 `npm test` 运行 node:test 回归测试，`npm run analysis` 批量分析+趋势图）。

### 命令

```bash
npm install          # 安装依赖

# 分析单个文件（输出默认写到输入文件所在目录）
node index.js <输入.fit> [输出目录]

# 批量处理：扫描目录顶层所有 .fit（输出默认写到 cwd 的 output/）
node index.js <目录> [输出目录]
# 快捷脚本：批量分析 input/ → output/ 并自动重新生成趋势图
npm run analysis

# 运行回归测试（指标算法单测 + 合成 FIT 端到端 + Web 服务端到端，训练库用 FIT_DB_PATH 隔离）
npm test

# Web 界面（P4）：本地服务 + 浏览器仪表盘
npm run web            # 默认 http://localhost:3000，PORT 环境变量可改端口

# 训练库查询（基于 ./db/fitness.db）
node index.js --monthly [月数=6]              # 逐月训练汇总
node index.js --trend [月数=12] [输出.html]   # 生成 CTL/ATL/TSB 逐月趋势图

# AI 提示词生成（P2）：拼好 角色+指标口径+数据+问题，打印到 stdout；给输出路径则同时写 .md
node index.js --review <summary.json> [输出.md]        # 单次复盘
node index.js --plan [周数=8] [输出.md]                # 周期规划
node index.js --taper <比赛日期YYYY-MM-DD> [输出.md]   # 赛前减量
node index.js --compare <A.json> <B.json> [输出.md]    # 两次训练对比

# 项目内真实示例
node index.js input/MAGENE_C506SE_2026-07-17_202219_1273797.fit output/
```

单文件模式成功后会打印两个输出文件路径及 summary JSON 全文；批量模式逐文件打印一行进度（失败不中断）并在结尾打印成功/失败计数；解析失败时输出 `解析失败: <message>` 并以退出码 1 结束。

### 骑手参数与算法阈值

骑手参数（`ftp_watts` / `max_hr` / `weight_kg`）**以训练库为准**：存于 SQLite `settings` 表（key=`athlete`），由 Web 设置页（`POST /api/athlete`）维护；`settings.js` 里的 `ATHLETE` 只是出厂默认值（库中无配置时兜底）。`db.js` 的 `syncAthleteFromDb()` 把库值原地合并进 `ATHLETE` 导出对象（`analyzeFile()` 开头、`main()` 入口、`server.js` 启动时各调一次），`setAthlete()` 校验后写库并原地生效。功率/心率分区及间歇识别、爬坡提取、踏频分析、数据质量的算法阈值（`POWER_ZONES` / `HR_ZONES` / `INTERVAL_DETECTION` / `CLIMB_DETECTION` / `CADENCE_ANALYSIS` / `DATA_QUALITY`）仍集中在 `settings.js`。

## 代码结构

- `settings.js`：算法配置（功率/心率分区、各分析阈值）+ 骑手参数出厂默认值（`ATHLETE`，训练库 settings 表无 athlete 行时兜底；Web 设置页保存后以库为准）。纯数据、无逻辑。
- `db.js`：训练库模块。基于 Node 内置 `node:sqlite`（≥22.5，零第三方依赖），数据库默认 `./db/fitness.db`（可用环境变量 `FIT_DB_PATH` 覆盖，供测试隔离；懒打开，目录/表不存在时自动创建）；提供 `upsertActivity`（按文件名去重）、`computeForm`（CTL/ATL/TSB 指数加权）、`monthlySummary`（逐月汇总与强度分类）、`trendMonthly`（逐月趋势数据）、`recentFormDaily`（最近 N 天逐日 form 序列）、`recentActivities`（近期训练简明清单，供提示词上下文）、`cyclingSummariesSince`（最近 N 天骑行完整 summary，FTP 历史估算用）、`listActivities` / `getActivitySummary`（Web 界面列表与详情查询）、`syncAthleteFromDb` / `getAthleteState` / `setAthlete`（settings 表骑手参数：同步进 `ATHLETE`、查询状态、校验写库并原地生效）、`closeDb`（测试收尾释放句柄）。
- `ftp.js`：FTP 历史估算（纯函数、无 IO）。`estimateFtpFromHistory(activities, athlete, cfg)` 基于窗口期内骑行的 5min/20min 峰功率做双方法互校——Morton 双参数 CP 模型（P(t)=CP+W′/t）+ Coggan 20min×0.95；心率交叉验证（锚点全力判定、功率/心率区间系统性偏移、心率漂移中位数）；数据不足时输出 `data_needs` 收集清单；返回估值/区间/置信度（high/medium/low）。阈值集中在 settings.js `FTP_ESTIMATION`。
- `prompts.js`：AI 提示词模板库（P2）。`buildMetricGlossary()` 由 settings.js 动态生成指标口径说明；`buildReviewPrompt` / `buildPlanPrompt` / `buildTaperPrompt` / `buildComparePrompt` 四个场景模板拼装完整 Markdown（角色+口径+数据+固化问题清单）；`thinToWeekly()` 把逐日 form 序列抽稀为逐周点。纯函数、无 IO。
- `ai.js`：AI API 客户端（P4）。OpenAI 兼容 chat/completions（Node 内置 fetch；Markdown 转 HTML 由 server.js 用 `marked` 处理，ai.js 本身不依赖 marked）；环境变量 `FIT_AI_API_KEY`（必填）/ `FIT_AI_BASE_URL`（默认 Kimi `https://api.moonshot.cn/v1`）/ `FIT_AI_MODEL`（默认 `moonshot-v1-32k`）/ `FIT_AI_TEMPERATURE`（可选，缺省不传）/ `FIT_AI_TIMEOUT_MS`（默认 5 分钟）/ `FIT_AI_STREAM`（是否启用流式，默认 false）/ `FIT_AI_STALL_MS`（流式空闲超时，默认 60s）；配置项调用时惰性读取，`.env` 由 server.js 入口通过 Node 内置 `process.loadEnvFile()` 注入（仅入口分支加载，测试 import 时不触发）；`isAiConfigured()` 供调用方判断退化为复制提示词模式。默认非流式 + 30 秒心跳日志。
- `server.js`：Web 服务（P4，`npm run web`）。Node 内置 http，零依赖；静态托管 `web/` 前端 + REST API（`/api/overview` 仪表盘聚合（含 `athlete_configured` 首开引导标记）、`GET/POST /api/athlete` 骑手参数查询与更新（写训练库 settings 表并原地生效）、`/api/activity`、`/api/records` 时序抽稀 ≤1400 点、`POST /api/upload` 原始字节上传 FIT 即分析入库、`GET /api/ftp-estimate` FTP 历史估算、`POST /api/ftp-apply` 把估算 FTP 写入训练库骑手参数并原地更新 `ATHLETE` 使当前进程即时生效、`POST /api/ai` 四场景 AI 报告/提示词、返回 `marked` 渲染后的 HTML、保存到 `ai_reports` 表并保留每 mode 最近 10 条、`GET /api/ai/reports`、`GET /api/ai/report`）；文件名参数一律 basename 防路径穿越；输出/输入目录可用 `FIT_OUTPUT_DIR` / `FIT_INPUT_DIR` 覆盖（测试隔离）。
- `web/`：纯 HTML/CSS/JS SPA（P4），零依赖零构建：hash 路由（概览/训练/详情/上传/AI 分析/设置）、手写 SVG 图表（多系列时序图各系列独立纵轴、CTL/ATL/TSB 趋势、分区分布、峰功率曲线）；设置页维护骑手参数（存训练库，未配置时首开自动引导）；AI 报告使用服务端 `marked` 渲染后的 HTML，并支持历史报告列表（每 mode 最近 10 条）；暗色平面科技运动风（荧光黄 volt 主色 + 斜切元素 + 等宽斜体大数字）。
- `index.js`（约 800 行）：主脚本，内部组织为：

| 区块 | 内容 |
|---|---|
| 工具函数 | `zoneOf` / `zoneDistribution`（区间分布）、`normalizedPower`（30s 滚动平均的四次方均根，缺口窗口不参与）、`peakAvg`（指定时长最大平均功率，要求窗口连续）、`hrDriftPct`（前后半程效率因子相对变化，功率或速度口径）、`findPowerGaps`（功率缺失 > 60s 检测）、`findMissingSpans`（整段记录缺失检测）、`collectDeveloperFields`（非标准字段数值统计）、`elevationGain`（带 1m 阈值去抖的累计爬升）、`avgField` / `maxField`（片段统计）。纯函数均 `export`，供单元测试直接引用；`main()` 仅当作为入口脚本运行时执行 |
| P0 分析函数 | `estimateFtp`（20min 峰功率 × 0.95 估算 FTP 并给更新建议）、`detectIntervals`（≥105% FTP 过阈段识别 + 间歇组统计）、`detectClimbs`（30s 窗口坡度 ≥3% 的爬坡段提取）、`cadencePowerAnalysis`（发力时段踏频习惯与踏频-功率相关性） |
| 单文件流程 `analyzeFile()` | ① 解析 FIT（`force: true`, `km/h`, `km`, `mode: "list"`；注意解析器会把海拔/爬升缩放成 km，代码统一换回米）→ ② 按秒重采样记录（缺口置 `null`，统计无时间戳丢弃数/缺失秒数）→ ③ 写 CSV → ④ 计算指标（含 P0 分析；跑步附加配速段、游泳解析 length 消息、无功率数据时省略 power 段并切换心率漂移为速度口径）→ ⑤ 训练库入库 + `athlete_context` 注入当日 CTL/ATL/TSB（失败仅警告不中断）→ ⑥ 写 summary JSON，返回结果 |
| 查询命令 | `printMonthly()`（逐月汇总表）、`writeTrendHtml()`（自包含 HTML 趋势图：月 TSS 柱 + CTL/ATL/TSB 月末折线 + 指标解读脚注，原生 SVG 无外部库） |
| 提示词命令（P2） | `emitPrompt()`（打印 stdout + 可选写 .md）、`loadSummaryJson()`、`emitPlanPrompt()` / `emitTaperPrompt()`（从训练库取数并调 prompts.js 组装） |
| 入口 `main()` | `--monthly` / `--trend` → 训练库查询；`--review` / `--plan` / `--taper` / `--compare` → 提示词生成；输入是目录 → 批量模式（逐文件调用 `analyzeFile`，失败不中断）；输入是文件 → 单文件模式并打印 JSON 全文 |

目录约定：`input/` 放待分析的 `.fit` 文件，`output/` 放分析结果。这两个目录只是约定，脚本本身不依赖它们。

## 版本控制约定（重要）

- 项目使用 **git** 进行版本控制。**每次完成修改后（无论是代码、配置还是文档变更）都必须执行 `git commit`**，并附上清晰描述本次变更内容的中文 commit message。
- commit message 约定：使用中文，简要说明“做了什么 + 为什么”，例如 `重构: index.js 迁移到 ESM 模块`。
- `node_modules/`、`output/`、`db/` 等生成物不入库（见 `.gitignore`）。

## 开发约定与编码风格

- 使用 ESM 语法（`import`/`export`），禁止使用 CommonJS 的 `require`/`module.exports`。
- 注释与文档一律使用**中文**（本项目的主要自然语言），函数级注释说明算法口径（如"30s 滚动平均的四次方均根"）。
- 主逻辑集中在 `index.js`：新功能优先加入"工具函数"区，保持纯函数、无状态；分区定义与算法阈值一律放进 `settings.js`，不要在 `index.js` 里硬编码常量；骑手参数属于"会变的数据"，走训练库 settings 表（db.js `setAthlete`），不要新增文件型配置。
- 数值处理惯例：缺数据统一用 `null` 表示（CSV 中留空，JSON 中字段可省略）；`undefined` 字段在输出前会被清理； rounding 口径写在代码里（如功率取整、海拔保留 1 位、速度保留 2 位）。
- 算法须遵循运动科学标准口径（NP/IF/TSS 公式见 README"已完成的指标算法"一节），改算法时同步更新 README。
- 核心指标依赖骑手参数（FTP / 最大心率 / 体重），生效值 = 训练库 settings 表 athlete 行（Web 设置页维护），库中无配置时回落 `settings.js` 的 `ATHLETE` 出厂默认值；改默认值时确认 README 中的示例配置是否需同步。

## 测试策略

**自动化测试已落地**（P3）：`npm test` = `node --test "test/*.test.mjs"`，零新增依赖（Node 内置 node:test）。

- `test/make_test_fit.mjs`：手写 FIT 二进制生成器（文件头/定义消息/数据消息/CRC-16），可生成骑行（含功率缺失/记录缺失/无时间戳坏记录/开发者字段）、跑步、游泳（length 消息）合成文件；也可直接 `node test/make_test_fit.mjs [目录]` 生成样例。
- `test/unit.test.mjs`：指标算法纯函数单测（NP/peakAvg/分区/爬升去抖/间歇识别/心率漂移/FTP 估算/缺失检测/开发者字段 + ftp.js 历史估算：CP 模型/数据充分性/心率交叉验证各分支）。
- `test/e2e.test.mjs`：端到端回归——合成 FIT → `analyzeFile` → 校验 CSV 行数与 summary 指标；训练库通过 `FIT_DB_PATH` 指向临时目录与真实库隔离（**必须在 import index.js 之前设置该环境变量**，db.js 在模块加载时定路径）。
- `test/web.test.mjs`：Web 服务端到端——合成 FIT → `POST /api/upload` → 校验概览/详情/时序/AI 提示词接口与路径穿越防护；同时直接调用 `saveAiReport` / `listAiReports` / `getAiReport` 验证 AI 缓存表 10 条滚动限制；FTP 接口用 `upsertActivity` 注入合成骑行校验 `/api/ftp-estimate`，并校验 `/api/ftp-apply` 与 `GET/POST /api/athlete`（写训练库 settings 表、部分更新、非法值 400）；同样用 `FIT_DB_PATH` / `FIT_OUTPUT_DIR` / `FIT_INPUT_DIR` 指向临时目录隔离（须在 import server.js 前设置），收尾先 `closeDb()` 释放 SQLite 句柄再删临时目录（Windows 文件锁）。

修改指标算法后：① 跑 `npm test`；② 用 `input/` 下的真实 FIT 文件重跑批量分析做端到端验证；涉及训练库的改动还需验证 `--monthly` / `--trend` 与删库自动重建（`rm -rf db` 后重跑分析）。

## 已知注意事项

- **README 与实际代码的偏差已修复**：入口文件为 `index.js`，配置在 `settings.js`；README 早期规划的 `make_test_fit.py` 已以 `test/make_test_fit.mjs`（JS 手写 FIT 二进制生成器）落地。
- README 中包含一份很长的功能路线图（P0–P4），**P0 已全部完成**（批量处理、FTP 自动估算、间歇识别、爬坡段提取、踏频-功率联合分析），**P1 已全部完成**（SQLite 训练库、CTL/ATL/TSB 写入 `athlete_context`、月汇总 `--monthly`、趋势图 `--trend`；因训练频率低，路线图的“周汇总”落地为月汇总），**P2 已全部完成**（提示词模板库 `prompts.js` + 四个提示词命令 `--review`/`--plan`/`--taper`/`--compare`，只生成文本供复制，调 API 属 P4），**P3 已全部完成**（跑步/游泳适配、开发者字段统计、损坏文件缺失计数、`test/` 下合成 FIT 生成器 + node:test 回归测试），**P4 已落地 AI API 对接与 Web 界面**（`ai.js` OpenAI 兼容客户端 + `server.js`/`web/` 本地 Web 应用；TrainingPeaks/intervals.icu 对接未做）。实现新功能前先看是否已在路线图中、应归入哪个优先级，完成后勾选对应条目。
- **海拔单位隐藏 bug 已修复**（P3 过程中发现）：解析器按 `lengthUnit: "km"` 会把海拔/爬升缩放成 km，此前海拔输出与爬坡检测被压低 1000 倍（MAGENE 海拔恒 0 故从未暴露），现已统一换回米。
- 没有 CI、没有部署流程——这是一个纯本地脚本项目（git 仅用于本地版本控制）。
- 项目源码统一使用 ESM（`.js` + `"type": "module"`），`fit-file-parser` 为 CommonJS 包，通过默认导入（`import FitParser from "fit-file-parser"`）由 Node 的 CJS-ESM 互操作处理。
- FIT 解析已开启 `force: true` 容忍损坏文件；被跳过的记录通过 `data_quality`（无时间戳丢弃数、时间跨度内缺失秒数）与 `anomalies`（≥10s 整段缺失标注，阈值见 settings.js `DATA_QUALITY.record_gap_sec`）体现。
- 已支持骑行/跑步/游泳三类：骑行指标最全；跑步为配速/步频/心率体系（无功率段）；游泳为 length 消息统计（趟数/泳池长度/划水/SWOLF）+ 心率。更细的运动类型适配（如公开水域游泳、铁人三项拼接）未做。

## 安全考虑

- 仅读取本地文件，无网络访问、无外部 API 调用；FIT 文件视为不可信输入，解析器以 `force: true` 容错运行。
- 无密钥、无环境变量配置。
