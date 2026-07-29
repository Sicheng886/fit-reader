# AGENTS.md — fit-reader 项目说明（供 AI 编码代理阅读）

## 项目概览

**fit-reader** 是一个无构建步骤的 Node.js 命令行项目（主脚本 `index.js` + 配置 `src/settings.js`），用于解析码表/运动手表导出的 `.fit` 文件（当前以骑行数据为主），输出两类结果：

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

骑手参数（`ftp_watts` / `max_hr` / `weight_kg`）**以训练库为准**：存于 SQLite `settings` 表（key=`athlete`），由 Web 设置页（`POST /api/athlete`）维护；`src/settings.js` 里的 `ATHLETE` 只是出厂默认值（库中无配置时兜底）。`src/db.js` 的 `syncAthleteFromDb()` 把库值原地合并进 `ATHLETE` 导出对象（`analyzeFile()` 开头、`main()` 入口、`server.js` 启动时各调一次），`setAthlete()` 校验后写库并原地生效。功率/心率分区及间歇识别、爬坡提取、踏频分析、数据质量的算法阈值（`POWER_ZONES` / `HR_ZONES` / `INTERVAL_DETECTION` / `CLIMB_DETECTION` / `CADENCE_ANALYSIS` / `DATA_QUALITY`）仍集中在 `src/settings.js`。

## 代码结构

- `src/settings.js`：算法配置（功率/心率分区、各分析阈值）+ 骑手参数出厂默认值（`ATHLETE`，训练库 settings 表无 athlete 行时兜底；Web 设置页保存后以库为准）。纯数据、无逻辑。
- `src/db.js`：训练库模块。基于 Node 内置 `node:sqlite`（≥22.5，零第三方依赖），数据库默认 `./db/fitness.db`（可用环境变量 `FIT_DB_PATH` 覆盖，供测试隔离；懒打开，目录/表不存在时自动创建）；提供 `upsertActivity`（按文件名去重）、`computeForm`（CTL/ATL/TSB 指数加权）、`monthlySummary`（逐月汇总与强度分类）、`trendMonthly`（逐月趋势数据）、`recentFormDaily`（最近 N 天逐日 form 序列，末端延伸到当前实际日期——无训练日 TSS=0 照常衰减，首页大数字与趋势图反映"今天"而非最后一次训练日）、`recentActivities`（近期训练简明清单，供提示词上下文：基础负荷字段 + 从完整 summary 补充心率漂移/峰功率曲线/平均踏频，IF 保留 2 位小数避免反推 FTP 噪音）、`cyclingSummariesSince`（最近 N 天骑行完整 summary，FTP 历史估算用）、`listActivities` / `getActivitySummary`（Web 界面列表与详情查询，详情会把 category 与 note 合并进 summary.activity）、`setActivityCategory` / `setActivityNote`（训练分类与备注：体感/路况等自由注释，上限 2000 字，AI 复盘纳入考量）、`getProfile` / `setProfile`（settings 表 profile 行：用户身份与训练目标，各场景 AI 提示词纳入考量，两字段皆空时删行视为未配置）、`syncAthleteFromDb` / `getAthleteState` / `setAthlete`（settings 表骑手参数：同步进 `ATHLETE`、查询状态、校验写库并原地生效）、AI 对话持久化（`ai_chats` / `ai_chat_messages` 两表：`createAiChat`（每 mode 50 个滚动清理并级联删消息）、`addAiChatMessage` / `updateAiChatMessage`（pending/completed/failed 状态机）、`touchAiChat`、`listAiChats`（含消息数/pending 聚合）、`getAiChat`（元信息 + 消息联查）、`findFollowUpChat`（按 report_id 找回追问对话）、`deleteAiChat`（级联删除））、AI 记忆（`ai_memories` 表：`saveMemory`（≤500 字校验、category 白名单、supersedes_id 取代链、滚动清理 100 条——先删最旧已取代再删最旧有效）、`listMemories`（注入用最近 30 条有效记忆）、`listAllMemories`（管理界面用，含已取代）、`deleteMemory`）、`closeDb`（测试收尾释放句柄）。
- `src/ftp.js`：FTP 历史估算（纯函数、无 IO）。`estimateFtpFromHistory(activities, athlete, cfg)` 基于窗口期内骑行的 5min/20min 峰功率做双方法互校——Morton 双参数 CP 模型（P(t)=CP+W′/t）+ Coggan 20min×0.95；心率交叉验证（锚点全力判定、功率/心率区间系统性偏移、心率漂移中位数）；数据不足时输出 `data_needs` 收集清单；返回估值/区间/置信度（high/medium/low）。阈值集中在 src/settings.js `FTP_ESTIMATION`。
- `src/prompts.js`：AI 提示词模板库（P2）。`buildMetricGlossary()` 由 src/settings.js 动态生成指标口径说明；`buildProfileSection()` 生成"用户背景与训练目标"段（身份/目标，未配置则不产生该段），四个场景模板 `buildReviewPrompt` / `buildPlanPrompt` / `buildTaperPrompt` / `buildComparePrompt` 均接受可选 profile 参数统一纳入（review 还会在 activity.note 存在时提示 AI 结合备注印证数据）；`compactSummaryForPrompt()` 在提交前把随时长线性增长的列表压缩（anomalies 聚合为按类型统计、segments 保留首尾省略中段、climbs 只留爬升最大段），保证提示词长度与训练时长无关；`thinToWeekly()` 把逐日 form 序列抽稀为逐周点；`buildAgenticSection()` 生成数据查询工具使用指引（仅 Web 端 AI 调用注入，CLI 提示词命令不注入）；`buildChatInstruction(mode)` 生成对话指令（follow_up：≤200 字快答、工具查询不计入字数；chat：务实简洁、结合数据、不限字数）；`buildMemorySection(memories)` 生成「用户记忆」段（逐条带日期与 id、冲突以最新为准规则、save_memory 调用指引；无有效记忆返回空串；仅 Web 端 agentic 调用注入，CLI 提示词命令不注入）。纯函数、无 IO。
- `src/ai.js`：AI API 客户端（P4）。OpenAI 兼容 chat/completions（基于 node:http/node:https 自行管理超时——旧实现用全局 fetch，undici 内置 300s body/headers 超时会把长报告生成静默掐断，表现为"AI 后台分析失败: fetch failed"；Markdown 转 HTML 由 server.js 用 `marked` 处理，ai.js 本身不依赖 marked）；**配置唯一事实来源是训练库 settings 表 ai 行**（Web 设置页维护），由 db.js `syncAiConfigFromDb()` 原地合并进 settings.js 的 `AI_CONFIG` 导出对象（api_key / base_url / model / temperature / timeout_ms / stream / stall_ms，出厂默认 Kimi `https://api.moonshot.cn/v1` + `kimi-k2.6`），**不再读取任何 FIT_AI_* 环境变量**——db.js `migrateAiEnvToDb()` 仅在 server.js 入口做一次性的老版本 env 迁入；`isAiConfigured()` 供调用方判断退化为复制提示词模式。默认非流式 + 30 秒心跳日志。`runAgentLoop(messages, tools, executeTool, opts)` 为 agentic 工具调用循环（≤6 轮、共享总超时、轮内全非流式；模型不支持 tools 返回 400 时自动降级单轮；依赖注入不 import db/tools，工具调用经 onToolCall 回调交给调用方记日志）。
- `src/tools.js`：AI agentic 工具集（function calling）：7 个只读查询工具（list_activities / get_activity_summary / get_activity_records / get_form_series / get_monthly_summary / get_athlete_profile / estimate_ftp）+ 1 个写工具 `save_memory`（仅写 ai_memories 表，source 场景标记经 executeTool 第三参 ctx 传入）的 JSON schema + 参数白名单校验 + `executeTool` 分发（错误一律返回 `{error}` JSON 不抛异常，结果超 `AGENTIC.tool_result_max_chars` 截断）；内部调用 db.js 既有查询与 src/records.js，不重复实现查询逻辑。
- `src/records.js`：records CSV 读取与抽稀（`loadRecords`，支持时间窗 start_sec/end_sec 与点数上限，server.js 与 tools.js 共用）+ `safeName`（basename 防路径穿越）。
- `src/settings.js` 另含 `AGENTIC` 配置块（max_rounds / tool_result_max_chars / records_max_points / list_limit / form_max_days / monthly_max）与 `AI_CONFIG.agentic` 开关（默认开）。
- `server.js`：Web 服务（P4，`npm run web`）。Node 内置 http，零依赖；静态托管 `web/` 前端 + REST API（`/api/overview` 仪表盘聚合（含 `athlete_configured` 首开引导标记）、`GET/POST /api/athlete` 骑手参数查询与更新（写训练库 settings 表并原地生效）、`GET/POST /api/ai-config` AI 服务配置查询与更新（同样写 settings 表并原地生效）、`GET/POST /api/profile` 用户身份与训练目标查询与更新（写 settings 表 profile 行，各场景 AI 提示词纳入考量）、`POST /api/activity/category` 训练分类标记、`POST /api/activity/note` 训练备注保存（空串清除）、`/api/activity`（完整 summary + `zone_ranges` 分区具体范围：POWER_ZONES/HR_ZONES × athlete_context 骑手参数换算的 W/bpm 区间文本，前端分区条右侧显示）、`/api/records` 时序抽稀 ≤1400 点、`POST /api/upload` 原始字节上传 FIT 即分析入库、`GET /api/ftp-estimate` FTP 历史估算、`POST /api/ftp-apply` 把估算 FTP 写入训练库骑手参数并原地更新 `ATHLETE` 使当前进程即时生效、`POST /api/ai` 四场景 AI 报告/提示词、返回 `marked` 渲染后的 HTML、保存到 `ai_reports` 表并保留每 mode 最近 30 条、`POST /api/ai/chat` AI 对话统一入口（follow_up 报告追问 / chat 直接对话；落库 user 消息 + pending 占位 → 202 → 后台 agentic 生成回填，系统段每轮重拼：指令 + 关联报告正文与压缩训练数据 + 工具指引）、`GET /api/ai/chat`（对话详情，有 pending 时 202 快照供轮询）、`GET /api/ai/chats`（对话列表，可选 report_id 找回该报告的追问对话）、`DELETE /api/ai/chat`（整串删除，每 mode 滚动保留 50 个）、`GET /api/ai/reports`、`GET /api/ai/report`、`GET /api/ai/memories`（全部记忆含已取代）、`DELETE /api/ai/memory`）；报告与对话的 agentic 调用注入记忆段（最近 30 条有效记忆），save_memory 的 source 场景标记由调用方透传；文件名参数一律 basename 防路径穿越；输出/输入目录可用 `FIT_OUTPUT_DIR` / `FIT_INPUT_DIR` 覆盖（测试隔离）。
- `web/`：纯 HTML/CSS/JS SPA（P4），零依赖零构建：hash 路由（概览/训练/详情/上传/AI 报告/对话/记忆/设置）、导航栏右侧三点菜单展开「记忆」与「设置」；手写 SVG 图表（多系列时序图各系列独立纵轴、≤180s 短缺口线性插值桥接显示（码表自动暂停产生的停顿不断线，仅显示层不改数据）、CTL/ATL/TSB 趋势、分区分布、峰功率曲线）；详情页含训练分类标记与训练备注（体感/路况自由注释，保存按钮写库，AI 复盘纳入考量）；「AI 报告」页生成/查看报告并支持追问（持久化 follow_up 对话：提交后异步生成、前端轮询、可关闭页面事后回看，回答 ≤200 字且结合本次训练具体数据，报告下可「清除追问」）；「对话」页（#/chat）支持无报告上下文的直接对话（AI 经 agentic 工具自行取数）、对话新建/删除与 pending 轮询；「记忆」页（#/memory）独立列出全部 AI 记忆含已取代标记，只做删除不做编辑；设置页维护骑手参数、身份与训练目标（身份一句话/目标一段话，AI 报告纳入考量）与 AI 服务配置（存训练库，保存后跳回首页，未配置时首开自动引导）；暗色平面科技运动风（荧光黄 volt 主色 + 斜切元素 + 等宽斜体大数字）。
- `index.js`（约 800 行）：主脚本，内部组织为：

| 区块 | 内容 |
|---|---|
| 工具函数 | `zoneOf` / `zoneDistribution`（区间分布）、`normalizedPower`（30s 滚动平均的四次方均根，缺口窗口不参与）、`peakAvg`（指定时长最大平均功率，要求窗口连续）、`hrDriftPct`（前后半程效率因子相对变化，功率或速度口径）、`findPowerGaps`（功率缺失 > 60s 检测）、`findMissingSpans`（整段记录缺失检测）、`collectDeveloperFields`（非标准字段数值统计）、`elevationGain`（带 1m 阈值去抖的累计爬升）、`avgField` / `maxField`（片段统计）。纯函数均 `export`，供单元测试直接引用；`main()` 仅当作为入口脚本运行时执行 |
| P0 分析函数 | `estimateFtp`（20min 峰功率 × 0.95 估算 FTP 并给更新建议）、`detectIntervals`（≥105% FTP 过阈段识别 + 间歇组统计）、`detectClimbs`（30s 窗口坡度 ≥3% 的爬坡段提取）、`cadencePowerAnalysis`（发力时段踏频习惯与踏频-功率相关性） |
| 单文件流程 `analyzeFile()` | ① 解析 FIT（`force: true`, `km/h`, `km`, `mode: "list"`；注意解析器会把海拔/爬升缩放成 km，代码统一换回米）→ ② 按秒重采样记录（缺口置 `null`，统计无时间戳丢弃数/缺失秒数）→ ③ 写 CSV → ④ 计算指标（含 P0 分析；跑步附加配速段、游泳解析 length 消息、无功率数据时省略 power 段并切换心率漂移为速度口径）→ ⑤ 训练库入库 + `athlete_context` 注入当日 CTL/ATL/TSB（失败仅警告不中断）→ ⑥ 写 summary JSON，返回结果 |
| 查询命令 | `printMonthly()`（逐月汇总表）、`writeTrendHtml()`（自包含 HTML 趋势图：月 TSS 柱 + CTL/ATL/TSB 月末折线 + 指标解读脚注，原生 SVG 无外部库） |
| 提示词命令（P2） | `emitPrompt()`（打印 stdout + 可选写 .md）、`loadSummaryJson()`、`emitPlanPrompt()` / `emitTaperPrompt()`（从训练库取数并调 src/prompts.js 组装） |
| 入口 `main()` | `--monthly` / `--trend` → 训练库查询；`--review` / `--plan` / `--taper` / `--compare` → 提示词生成；输入是目录 → 批量模式（逐文件调用 `analyzeFile`，失败不中断）；输入是文件 → 单文件模式并打印 JSON 全文 |

目录约定：`input/` 放待分析的 `.fit` 文件，`output/` 放分析结果。这两个目录只是约定，脚本本身不依赖它们。

## 版本控制约定（重要）

- 项目使用 **git** 进行版本控制。**每次完成修改后（无论是代码、配置还是文档变更）都必须先提升 `package.json` 中的 `version` 字段，再执行 `git commit`**，并附上清晰描述本次变更内容的中文 commit message。
- 当前版本：`1.4.3`。版本号遵循语义化版本（SemVer）：`MAJOR.MINOR.PATCH`，bug 修复/小调整升 PATCH，新增功能升 MINOR，破坏性改动升 MAJOR。
- 推荐工作流：
  1. 完成修改并跑通 `npm test`。
  2. 运行 `npm version patch|minor|major --no-git-tag-version`（仅修改 `package.json` 与 `package-lock.json`，不自动提交、不打 tag）。
  3. `git add package.json package-lock.json <其他变更文件> && git commit -m "中文提交说明"`。
  4. 如需发版，再手动打标签：`git tag v$(node -p "require('./package.json').version")`，然后推送 `git push && git push --tags`。
- commit message 约定：使用中文，简要说明“做了什么 + 为什么”，例如 `重构: index.js 迁移到 ESM 模块`。
- `node_modules/`、`output/`、`db/` 等生成物不入库（见 `.gitignore`）。

## 开发约定与编码风格

- 使用 ESM 语法（`import`/`export`），禁止使用 CommonJS 的 `require`/`module.exports`。
- 注释与文档一律使用**中文**（本项目的主要自然语言），函数级注释说明算法口径（如"30s 滚动平均的四次方均根"）。
- 主逻辑集中在 `index.js`：新功能优先加入"工具函数"区，保持纯函数、无状态；分区定义与算法阈值一律放进 `src/settings.js`，不要在 `index.js` 里硬编码常量；骑手参数属于"会变的数据"，走训练库 settings 表（src/db.js `setAthlete`），不要新增文件型配置。
- 数值处理惯例：缺数据统一用 `null` 表示（CSV 中留空，JSON 中字段可省略）；`undefined` 字段在输出前会被清理； rounding 口径写在代码里（如功率取整、海拔保留 1 位、速度保留 2 位）。
- 算法须遵循运动科学标准口径（公式见下文「输出格式与指标算法口径」一节），改算法时同步更新该节。
- 核心指标依赖骑手参数（FTP / 最大心率 / 体重），生效值 = 训练库 settings 表 athlete 行（Web 设置页维护），库中无配置时回落 `src/settings.js` 的 `ATHLETE` 出厂默认值。

## 输出格式与指标算法口径

summary.json 字段（喂 AI 的汇总结构，records.csv 列见上文「项目概览」）：

- `activity`：日期、运动类型（cycling/running/swimming）、时长、距离、爬升、平均速度、卡路里
- `athlete_context`：骑手参数 + 当日 CTL/ATL/TSB 与中文状态简评
- `power`：平均/NP/最大功率、VI、IF、TSS、功体比、峰功率曲线（5s/1min/5min/20min）、FTP 自动估算、Coggan 7 区时间分布
- `heart_rate`：平均/最大心率、5 区时间分布、心率漂移（有氧解耦 %）
- `cadence`：平均踏频（剔除 0 rpm 滑行秒，只统计踩踏时段，与码表 session / Strava 口径一致；跑步为步频 spm）
- `temperature`（avg/min/max）/ `pace`（仅跑步：配速 min/km）/ `swim`（仅游泳：趟数/泳池长度/划水/SWOLF）/ `developer_fields`（非标准字段数值统计）
- `cadence_power`（踏频-功率联合分析）、`climbs`（爬坡段）、`interval_set`（间歇组）、`segments`（圈/赛段 + 间歇工作段）、`anomalies`（设备异常标注）、`data_quality`（覆盖率/丢弃数/缺失秒数）

指标算法口径：

- NP：30s 滚动平均 → 四次方均值 → 开四次方根（缺口窗口不参与）；IF = NP / FTP；TSS = 时长秒 × NP × IF / (FTP × 3600) × 100
- 心率漂移（有氧解耦）：前后半程效率因子的相对变化；骑行用功率/心率，无功率数据时自动切换速度/心率
- CTL = TSS 的 42 天指数加权（体能）；ATL = 7 天（疲劳）；TSB = CTL − ATL（状态）；缺天按 TSS=0 参与衰减
- 峰功率曲线要求窗口数据连续；异常检测：功率缺失 >60s、整段记录缺失 ≥10s、心率跳变（相邻秒差 >25）
- FTP 自动估算：20min 峰功率 × 0.95（无连续 20min 窗口时省略）
- 间歇识别：≥105% FTP 过阈段，≤10s 瞬时掉功率合并、<30s 丢弃；爬坡段：30s 窗口坡度 ≥3% 且爬升 ≥15m、长度 ≥300m；踏频-功率联合分析：仅统计 ≥75% FTP 发力时段，低踏频 <80rpm / 高踏频 >90rpm
- 月度强度分布：低(Z1–Z2)/中(Z3–Z4)/高(Z5–Z7) 按时长加权；低≥75% 且高>中 → polarized，低>中>高 → pyramidal，其余 → sweet_spot

## 测试策略

**自动化测试已落地**（P3）：`npm test` = `node --test "test/*.test.mjs"`，零新增依赖（Node 内置 node:test）。

- `test/make_test_fit.mjs`：手写 FIT 二进制生成器（文件头/定义消息/数据消息/CRC-16），可生成骑行（含功率缺失/记录缺失/无时间戳坏记录/开发者字段）、跑步、游泳（length 消息）合成文件；也可直接 `node test/make_test_fit.mjs [目录]` 生成样例。
- `test/unit.test.mjs`：指标算法纯函数单测（NP/peakAvg/分区/爬升去抖/间歇识别/心率漂移/FTP 估算/缺失检测/开发者字段 + src/ftp.js 历史估算：CP 模型/数据充分性/心率交叉验证各分支 + src/prompts.js 提示词数据压缩）。
- `test/ai.test.mjs`：src/ai.js HTTP 层回归——本地 mock chat/completions 服务，验证慢响应不被隐藏超时掐断、总超时报错、SSE 流式拼接、HTTP 错误状态透出。
- `test/e2e.test.mjs`：端到端回归——合成 FIT → `analyzeFile` → 校验 CSV 行数与 summary 指标；训练库通过 `FIT_DB_PATH` 指向临时目录与真实库隔离（**必须在 import index.js 之前设置该环境变量**，src/db.js 在模块加载时定路径）。
- `test/web.test.mjs`：Web 服务端到端——合成 FIT → `POST /api/upload` → 校验概览/详情/时序/AI 提示词接口与路径穿越防护；同时直接调用 `saveAiReport` / `listAiReports` / `getAiReport` 验证 AI 缓存表 30 条滚动限制；FTP 接口用 `upsertActivity` 注入合成骑行校验 `/api/ftp-estimate`，并校验 `/api/ftp-apply` 与 `GET/POST /api/athlete`（写训练库 settings 表、部分更新、非法值 400）；训练备注（`/api/activity/note` 保存/合并进 summary/进入复盘提示词/清除与长度校验）与用户背景目标（`/api/profile` 部分更新、清空、进入复盘与规划提示词）亦有端到端覆盖；AI 对话（`POST/GET/DELETE /api/ai/chat(s)`：202 异步状态机轮询、系统段与历史消息口径、report_id 找回追问对话、级联删除、每 mode 50 个滚动清理、旧 follow-up 接口 404）与 AI 记忆（saveMemory 校验/取代链/100 条滚动清理、mock AI 触发 save_memory 入库带 source、memories 接口与删除 404、报告提示词含记忆段）以 mock AI 服务端到端覆盖；同样用 `FIT_DB_PATH` / `FIT_OUTPUT_DIR` / `FIT_INPUT_DIR` 指向临时目录隔离（须在 import server.js 前设置），收尾先 `closeDb()` 释放 SQLite 句柄再删临时目录（Windows 文件锁）。

修改指标算法后：① 跑 `npm test`；② 用 `input/` 下的真实 FIT 文件重跑批量分析做端到端验证；涉及训练库的改动还需验证 `--monthly` / `--trend` 与删库自动重建（`rm -rf db` 后重跑分析）。

## 已知注意事项

- **旧版《FIT训练分析项目README.md》已删除**（P0–P4 路线图全部落地后，仍有价值的输出格式与算法口径并入本文档「输出格式与指标算法口径」一节；面向用户的使用说明以根目录 `README.md` 为准，Docker 部署见 `DEPLOY.md`）。路线图完成情况：P0（批量处理、FTP 自动估算、间歇识别、爬坡段提取、踏频-功率联合分析）、P1（SQLite 训练库、CTL/ATL/TSB 写入 `athlete_context`、月汇总 `--monthly`、趋势图 `--trend`；因训练频率低，路线图的“周汇总”落地为月汇总）、P2（提示词模板库 `src/prompts.js` + 四个提示词命令 `--review`/`--plan`/`--taper`/`--compare`）、P3（跑步/游泳适配、开发者字段统计、损坏文件缺失计数、合成 FIT 生成器 + node:test 回归测试）、P4（AI API 对接 + Web 界面）均已完成；TrainingPeaks/intervals.icu 对接未做。当前演进方向见 `agentic-plan.md`（AI 顾问 agentic 查询 / 对话持久化 / 记忆，分四阶段实施）。
- **海拔单位隐藏 bug 已修复**（P3 过程中发现）：解析器按 `lengthUnit: "km"` 会把海拔/爬升缩放成 km，此前海拔输出与爬坡检测被压低 1000 倍（MAGENE 海拔恒 0 故从未暴露），现已统一换回米。
- 没有 CI、没有部署流程——这是一个纯本地脚本项目（git 仅用于本地版本控制）。
- 项目源码统一使用 ESM（`.js` + `"type": "module"`），`fit-file-parser` 为 CommonJS 包，通过默认导入（`import FitParser from "fit-file-parser"`）由 Node 的 CJS-ESM 互操作处理。
- FIT 解析已开启 `force: true` 容忍损坏文件；被跳过的记录通过 `data_quality`（无时间戳丢弃数、时间跨度内缺失秒数）与 `anomalies`（≥10s 整段缺失标注，阈值见 src/settings.js `DATA_QUALITY.record_gap_sec`）体现。
- 已支持骑行/跑步/游泳三类：骑行指标最全；跑步为配速/步频/心率体系（无功率段）；游泳为 length 消息统计（趟数/泳池长度/划水/SWOLF）+ 心率。更细的运动类型适配（如公开水域游泳、铁人三项拼接）未做。

## 安全考虑

- 仅读取本地文件；唯一的网络访问是 AI 报告调用用户自配的 OpenAI 兼容接口；FIT 文件视为不可信输入，解析器以 `force: true` 容错运行。
- AI 密钥存本地训练库 settings 表（`db/` 已被 `.gitignore` 排除），仅随 AI 请求发往用户配置的接口地址；无其它密钥或环境变量配置（`FIT_DB_PATH` / `FIT_INPUT_DIR` / `FIT_OUTPUT_DIR` / `PORT` 仅为部署/测试隔离参数）。
