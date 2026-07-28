# agentic-plan.md — AI 顾问 Agentic 查询、对话持久化与记忆能力设计文档

本文档描述为 fit-reader 的 AI 顾问增加三项能力的完整实施方案：

1. **Agentic 查询**：AI 在生成报告（复盘/规划/赛前/对比）、报告追问与直接对话时，可通过 function calling 主动调用本应用的训练库接口，按需查询其它训练数据（历史训练、负荷走势、单次详情、时序片段等），而不是只依赖提示词里预装的数据；
2. **对话持久化与直接对话**：快问快答（报告追问）从"同步、不缓存"改为**入库 + 异步生成**（提交后可关闭页面，事后回来查看），并支持删除；Web 新增**直接对话区域**——没有报告上下文也能自由问答，AI 通过 agentic 查询自行取数；
3. **AI 记忆**：AI 在与用户的交互中了解到用户相关信息（伤病、时间预算、主观体感、目标变化等）后可主动保存，**带时间戳**——训练状态与目标动态变化，新事实要能覆盖旧事实；后续所有 AI 调用自动注入有效记忆。

本文档只包含准备事项与实施步骤，不含实现代码。实施分四个阶段，每阶段可独立交付、独立降级。

---

## 1. 背景与现状（设计依据）

### 1.1 现有 AI 调用链路

- `src/ai.js`：`callAI(promptOrMessages)` 单轮调用 OpenAI 兼容 chat/completions，基于 node:http(s) 自管超时（`AI_CONFIG.timeout_ms` / `stall_ms`），支持流式/非流式 + 30s 心跳日志；**目前不支持 tools / function calling**，非流式路径只取 `choices[0].message.content`。
- `server.js`：
  - `POST /api/ai`：202 + 后台异步生成（`createPendingAiReport` → `callAI` → `updateAiReport`），天然适合多轮 agent 循环——前端轮询历史报告，不感知耗时；
  - `POST /api/ai/follow-up`：**同步等待响应、不缓存**（快问快答，前置 ≤200 字指令，按 file_name 附压缩训练数据）——关闭页面即丢失，也无法事后回看；
  - `loadRecords()`：已有 records CSV 抽稀（≤1400 点）逻辑，可供时序查询工具复用思路。
- `src/db.js`：`openDb()` 内 `CREATE TABLE IF NOT EXISTS` + `ensureXxxColumn()` 迁移模式；查询函数齐备：`listActivities` / `getActivitySummary` / `recentActivities` / `recentFormDaily` / `monthlySummary` / `trendMonthly` / `computeForm` / `cyclingSummariesSince` / `getAthleteState` / `getProfile`。AI 报告缓存已有 `ai_reports` 表 + pending/completed/failed 状态机可参照。
- `src/prompts.js`：`assemble()` 统一拼装（角色 + 指标口径 + 用户背景 + 数据段 + 问题）；`compactSummaryForPrompt()` 已有随时长增长列表的压缩能力，可直接复用于工具返回与对话上下文。
- 配置唯一事实来源是训练库 settings 表 ai 行（`syncAiConfigFromDb()` 原地合并进 `AI_CONFIG`）；`setAiConfig()` 已支持部分字段更新，新增开关字段成本低。
- 默认模型 `kimi-k2.6` 支持 function calling。

### 1.2 为什么需要这三项能力

- 当前提示词是"预装数据"模式：生成什么报告就拼什么数据。AI 想深挖（"我上个月那场比赛的心率漂移是多少？""最近 CTL 哪天开始掉的？"）只能依赖提示词里恰好带上的内容。Agentic 查询让 AI 按需取数：提示词只需预装最少上下文，AI 自己决定查什么，报告更深、问答更准。
- 追问目前同步且不缓存：AI 思考期间用户只能干等，关掉页面答案就丢了，也没有地方回看历史问答。改为入库 + 异步（复用报告的 pending 状态机模式）后，提交即可离开，事后回来看；同时支持删除不需要的对话。
- 没有报告时（比如想随口问"这周状态适合上强度吗"）目前没有任何对话入口。直接对话区域 + agentic 查询，让 AI 顾问成为随时可用的问答助手，取数全靠工具调用。
- 用户相关信息（"下周出差只能骑台子""膝盖旧伤""目标改到 10 月 gran fondo"）目前只能靠用户手动改设置页的 profile；AI 在对话中听到这类信息应当能自己记下来，且**带时间戳**——训练状态与目标会变，"3 月说 FTP 目标 150W"和"7 月说改到 170W"必须能区分新旧。

---

## 2. 准备事项（实施前置检查与决策）

动手前需确认/决策以下事项：

1. **模型能力确认**：所用模型必须支持 function calling（tools 参数 + `tool_calls` 响应）。kimi-k2.6 确认支持。用户在设置页换成不支持 tools 的模型时，按第 8 节降级路径处理（自动退回单轮模式），无需用户干预。
2. **工具清单与返回上限**：见第 4 节表格。每个工具的返回都要设硬上限（条数/点数/字符数），防止一次工具调用把上下文撑爆。
3. **Agent 循环参数**（初版建议值，集中在 `src/settings.js` 新增 `AGENTIC` 配置块，不在代码里硬编码）：
   - 最大工具调用轮数：6（超出后强制要求模型直接作答）；
   - 循环总超时：复用 `AI_CONFIG.timeout_ms`（整个循环共享一个总预算，不逐轮重置）；
   - 单个工具结果截断：≤4000 字符（超出截断并附 `（结果已截断）` 标记）。
4. **对话存储 schema 与保留策略**：见第 5 节。需决策保留上限（建议每 mode 滚动保留 50 个对话）与删除粒度（**按整个对话删除**，含其全部消息；不做单条消息删除——KISS）。
5. **记忆表 schema 与保留策略**：见第 6 节。需决策保留上限（建议 100 条滚动）与注入条数（建议最近 30 条有效记忆）。
6. **前端展示方案**：
   - 报告/对话是否展示工具调用轨迹（建议：初版只在服务端日志记录 `[AI tool] xxx(...)`，前端暂不做；后续可在详情加"AI 查询了哪些数据"折叠区）；
   - 直接对话区域的入口与布局（建议：新增 hash 路由 `#/chat`「对话」页，左侧对话列表 + 右侧消息流，复用现有暗色风格）；
   - 记忆管理入口放哪里（建议：设置页新增"AI 记忆"区块，列出记忆 + 删除按钮，用户可纠正 AI 记错的内容）。
7. **测试方案**：`test/ai.test.mjs` 的本地 mock chat/completions 服务需扩展为可返回 `tool_calls` 的多轮脚本化响应；对话/记忆表 CRUD 走 node:test 直测 db.js（`FIT_DB_PATH` 隔离）；web 端到端覆盖对话异步状态机与删除接口。

---

## 3. 总体架构

```
报告 / 追问 / 直接对话请求
  → prompts.js 拼装（角色 + 口径 + profile + 预装数据 + 工具使用指引 + 记忆段）
  → ai.js runAgentLoop(messages, tools)：
      循环（≤6 轮，共享总超时）：
        调用 chat/completions（messages + tools 定义）
        ├─ 返回 tool_calls → tools.js 逐个执行（只读查 db.js / 写 ai_memories）
        │    → 结果作为 role:"tool" 消息回填 → 继续循环
        └─ 返回普通 content → 循环结束，得到最终文本
  → 最终文本 → marked 渲染 → 存 ai_reports（报告）/ 存 ai_chat_messages（追问与直接对话）

异步模式（全部 AI 生成路径统一）：
  请求先落库 pending 占位 → 202 立即返回 → 后台 runAgentLoop → 回填 completed/failed
  前端轮询（报告：GET /api/ai/report；对话：GET /api/ai/chat）→ 可关闭页面事后回看

降级：
  - 未配置密钥 → 现有"复制提示词"模式（报告不变）；对话/追问入口提示需配置密钥；
  - 模型不支持 tools（API 400 / 行为异常）→ 自动退回单轮调用并日志警告；
  - AI_CONFIG 新增 agentic 开关（默认开），设置页高级选项可关。
```

关键实现决策：

- **循环内全部走非流式**：tool_calls 与 SSE 增量解析组合复杂、收益低（用户看不到中间轮）。KISS：agentic 模式下各轮均非流式 + 心跳日志；`AI_CONFIG.stream` 只影响非 agentic 的降级单轮路径。
- **工具执行器独立成 `src/tools.js`**：工具 JSON schema 定义 + 参数校验 + 执行分发，内部调用 db.js 既有查询函数，不重复实现查询逻辑。该模块被 server.js 使用（CLI 提示词模式不挂工具——复制出去的提示词无法回调本机）。
- **ai.js 保持无状态**：`runAgentLoop` 通过参数接收工具定义与执行回调，不 import tools.js/db.js（依赖注入，保持 ai.js 可单测）。
- **对话上下文在每轮请求时重新拼装**：系统段（指令 + 记忆 + 关联训练的压缩数据）由服务端按当前状态生成，历史消息只存 user/assistant 正文——记忆更新、训练备注修改后，下一轮对话自动用上最新上下文，不被旧快照绑架。

---

## 4. 工具集设计

原则：**除 `save_memory` 外全部只读**；`save_memory` 只写 `ai_memories` 表，不触碰 activities/settings；所有参数做白名单校验，`file_name` 一律 basename 校验（沿用 server.js `safeName` 思路）。

| 工具名 | 参数 | 返回内容 | 上限 |
|---|---|---|---|
| `list_activities` | `start_date?`, `end_date?`, `sport?`, `category?`, `limit?` | 训练简明清单（日期/类型/分类/时长/距离/TSS/NP/IF/备注摘要） | limit ≤ 50 |
| `get_activity_summary` | `file_name` | `compactSummaryForPrompt` 压缩后的完整 summary JSON（含分类与备注） | 截断 4000 字符 |
| `get_activity_records` | `file_name`, `start_sec?`, `end_sec?` | 逐秒时序抽稀（复用 loadRecords 思路，支持时间窗截取） | ≤600 点 |
| `get_form_series` | `days?` | 逐日 CTL/ATL/TSB/TSS（`recentFormDaily`） | days ≤ 120 |
| `get_monthly_summary` | `months?` | 月汇总（TSS/时长/强度分布类型） | months ≤ 24 |
| `get_athlete_profile` | — | 骑手参数（FTP/最大心率/体重）+ 身份与训练目标 | — |
| `estimate_ftp` | — | FTP 历史估算结果（复用 `estimateFtpFromHistory`，含置信度与数据需求） | — |
| `save_memory` | `content`, `category?`, `supersedes_id?` | 写入确认（含记忆 id 与日期） | content ≤ 500 字 |

说明：

- `list_activities` 是 AI 的"目录页"——先查清单拿到 file_name，再用 `get_activity_summary` / `get_activity_records` 深挖单次。提示词指引中要明确这个两步用法。直接对话场景没有预装数据，这是 AI 的主要取数路径。
- `get_activity_records` 需要把 server.js 的 `loadRecords` 抽成可被 tools.js 复用的形式（移入 src/ 或 tools.js 内实现，server.js 改为引用），支持 `start_sec`/`end_sec` 时间窗（AI 问"最后 10 分钟功率"时不必取全程）。
- 工具返回统一 JSON 字符串；错误（如 file_name 不存在）也返回 JSON `{error: "..."}` 让 AI 自行处理，不抛异常中断循环。

---

## 5. 对话持久化与直接对话设计

### 5.1 表结构（沿用 `openDb()` 建表模式，参照 ai_reports 的状态机）

```sql
CREATE TABLE IF NOT EXISTS ai_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,               -- 'follow_up'（报告追问）/ 'chat'（直接对话）
  report_id INTEGER,                -- 追问关联的报告 id（直接对话为 NULL）
  file_name TEXT,                   -- 关联训练（用于附压缩数据；可空）
  title TEXT,                       -- 由首条用户消息截断生成（≤50 字）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_chats_mode ON ai_chats(mode, id DESC);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,               -- user / assistant
  content TEXT NOT NULL,
  status TEXT DEFAULT 'completed',  -- assistant 消息：pending / completed / failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, id);
```

### 5.2 异步问答流程（追问与直接对话统一）

1. `POST /api/ai/chat` `{chat_id?, mode, message, report_id?, file_name?}`：
   - 无 `chat_id` → 创建对话（title 取 message 前 50 字）；
   - 写入 user 消息 + assistant **pending 占位消息** → 202 返回 `{chat_id, message_id}`；
   - 后台：拼装上下文（指令 + 记忆 + 关联训练压缩数据 + 历史消息）→ `runAgentLoop` → 回填 completed（或 failed + error）。
2. `GET /api/ai/chat?id=`：返回对话元信息 + 全部消息；存在 pending 消息时 HTTP 202，前端继续轮询（复用报告 pending 的前端模式）；用户可关闭页面，事后从对话列表回来查看。
3. `GET /api/ai/chats?mode=`：对话列表（按 updated_at 倒序，含标题/时间/状态）。
4. `DELETE /api/ai/chat?id=`：删除整个对话及其全部消息。
5. 容量：每 mode 滚动保留最近 50 个对话（沿用 ai_reports 的 id DESC LIMIT 清理模式）。

### 5.3 与现有追问的关系

- 现有 `POST /api/ai/follow-up`（同步、不缓存、前端自持 messages 数组）**被上述接口取代**——本地单用户应用无兼容负担，旧接口删除，前端报告详情页追问改为创建/继续 `follow_up` 对话（关联 report_id 与 file_name）。
- 追问保留现有 ≤200 字快答指令（"工具查询不计入回答字数"）；直接对话不限字数，但提示词要求务实简洁、结合数据。
- 历史消息作为上下文随每轮发送，但**不含**已执行的工具调用细节（tool 消息不落库，只留最终回答）——控制上下文长度；服务端日志保留工具调用轨迹。

### 5.4 直接对话区域（web 新增页）

- 新增 hash 路由 `#/chat`「对话」：对话列表（可新建、可删除）+ 消息流（用户提问 → pending 态 → AI 回答，marked HTML 渲染）；
- 无报告上下文：系统段 = 通用教练角色 + 指标口径 + profile + 记忆 + 工具指引，取数全靠 agentic 工具调用；
- 导航栏加入口；未配置密钥时该页提示去设置页配置（与报告页一致）。

---

## 6. AI 记忆设计

### 6.1 表结构（沿用 `openDb()` 建表模式）

```sql
CREATE TABLE IF NOT EXISTS ai_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,            -- 记忆内容（≤500 字，AI 用中文概括）
  category TEXT DEFAULT 'general',  -- general / injury / schedule / goal / preference
  source TEXT,                      -- 产生场景：review / plan / taper / compare / follow_up / chat
  created_at TEXT DEFAULT (datetime('now')),
  superseded_by INTEGER             -- 被哪条新记忆取代（NULL = 当前有效）
);
```

### 6.2 时间语义（核心）

- 记忆的价值在"带时间的事实"。注入提示词时按 `created_at` 排列并**逐条标注日期**，例如：`[2026-05-12] 用户右膝有旧伤，长时间高扭矩会不适`。
- 提示词规则写死：**同一主题的记忆相互矛盾时，以日期最新者为准**；旧记忆仍有参考价值（可知变化轨迹），不得忽略其存在。
- `save_memory` 的 `supersedes_id` 允许 AI 显式取代某条旧记忆（它在注入的记忆清单里能看到 id）；被取代的记忆不再注入但保留在库中（可追溯）。
- AI 也可不指定 supersedes_id 直接存新记忆——日期规则已能处理大多数冲突。

### 6.3 容量控制

- 库中最多保留 100 条：超出时滚动删除最旧的**已被取代**记忆，不足再删最旧有效记忆；
- 注入提示词取最近 30 条有效记忆（未 superseded），防提示词膨胀。

### 6.4 用户可控

AI 可能记错或过时，用户必须有最终控制权：

- `GET /api/ai/memories`：列出全部记忆（含已被取代的，标记状态）；
- `DELETE /api/ai/memory?id=`：删除指定记忆；
- 设置页新增"AI 记忆"区块：列表 + 每条删除按钮（只做删除，不做编辑——错了就删，AI 会重记）。

### 6.5 db.js 新增函数

`saveMemory({content, category, source, supersedes_id})`（含 500 字校验、滚动清理）、`listMemories(n)`（注入用，默认有效记忆）、`listAllMemories()`（管理界面用）、`deleteMemory(id)`。沿用现有中文错误 message + 测试隔离（`FIT_DB_PATH`）惯例。

---

## 7. 提示词改造（src/prompts.js）

新增两个公共片段，报告四场景、追问与直接对话统一注入：

- `buildAgenticSection()`：工具使用指引——有哪些工具、各自用途、"先 list_activities 找文件再按名深挖"的两步模式、只在预装数据不足以回答时才调用工具、每轮最多发起必要数量的调用；
- `buildMemorySection(memories)`：带日期的记忆清单 + 冲突处理规则（最新为准）+ 何时调用 `save_memory` 的指引（用户透露了影响训练安排的个人事实：伤病/日程约束/目标变化/明确偏好；数据本身已有的事实不要重复记；每条 ≤500 字、用中文、写成带主语的完整陈述）。

追问系统段 = 现有 ≤200 字快答指令 + 关联训练压缩数据 + 工具指引 + 记忆段；直接对话系统段 = 通用教练角色 + 口径 + profile + 工具指引 + 记忆段（回答风格务实简洁，不限字数）。

注意：CLI 提示词命令（`--review` 等，打印文本供手动复制）**不注入**工具指引与记忆段——复制出去的提示词无法回调本机接口，挂工具只会得到幻觉调用。

---

## 8. 风险与降级

| 风险 | 对策 |
|---|---|
| 模型不支持 tools | API 返回 400 或首轮行为异常 → 自动退回现有单轮调用（去掉 tools 重发一次），日志警告；`AI_CONFIG.agentic` 开关（默认开）可在设置页高级选项关闭整个 agentic 行为 |
| 循环失控 / token 爆炸 | 轮数上限 6 + 工具结果 4000 字符截断 + 循环共享总超时（`timeout_ms`） |
| 工具执行报错 | 错误以 `{error}` JSON 回填给模型继续对话，不中断循环；db 层异常只影响单次工具调用 |
| 对话历史无限增长 | 每 mode 滚动保留 50 个对话；上下文只带当前对话的 user/assistant 正文（不含工具细节）；超长对话由模型上下文窗口自然约束，前端提供"新建对话"引导 |
| 异步生成中途进程重启 | pending 消息/报告残留：启动时不自动重试（KISS），界面显示 failed/pending 可删除重问 |
| 记忆污染 | 用户可在设置页删除；prompt 指引限制记忆范围（只记用户个人事实，不记训练数据本身） |
| 密钥安全 | 工具全部本地执行，无新增外发通道；`save_memory` 不触碰 api_key 所在 settings 行 |

---

## 9. 分阶段实施步骤

### 阶段一：Agentic 工具调用

1. `src/settings.js`：新增 `AGENTIC` 配置块（max_rounds=6、tool_result_max_chars=4000、records_max_points=600 等）；`AI_CONFIG` 增加 `agentic: true` 默认值；`setAiConfig()` 支持该字段更新。
2. `src/ai.js`：非流式路径解析完整 message（含 `tool_calls`）；新增 `runAgentLoop({messages, tools, executeTool, onHeartbeat})`——循环调用、回填 tool 结果、轮数/超时兜底、模型不支持 tools 时降级单轮。保持依赖注入（不 import db/tools）。
3. `src/tools.js`（新建）：8 个工具的 JSON schema + 参数校验 + 执行器（调用 db.js 既有函数）；`loadRecords` 从 server.js 抽至可复用位置并支持时间窗。
4. `src/prompts.js`：`buildAgenticSection()`，四场景报告与追问接入（CLI 命令不接入）。
5. `server.js`：`/api/ai` 与 `/api/ai/follow-up` 改走 `runAgentLoop`（追问此阶段仍同步、不缓存）；服务日志记录每次工具调用（`[AI tool] list_activities({"sport":"cycling"}) → 12 条`）。
6. 测试：`test/ai.test.mjs` mock 服务扩展为脚本化多轮（首轮返回 tool_calls、次轮返回正文），验证循环、轮数上限、降级路径；`npm test` 全绿。
7. 验证 + `npm version minor` + commit（新功能升 MINOR）。

### 阶段二：对话持久化与直接对话区域

1. `src/db.js`：`ai_chats` / `ai_chat_messages` 表 + CRUD（创建对话、追加 user 消息、创建 pending assistant 占位、回填 completed/failed、列表、取详情、删除对话及消息、每 mode 50 个滚动清理）。
2. `server.js`：新增 `POST /api/ai/chat`、`GET /api/ai/chat`、`GET /api/ai/chats`、`DELETE /api/ai/chat`；后台生成走阶段一的 `runAgentLoop`；删除旧 `/api/ai/follow-up`。
3. `web/`：
   - 新增 `#/chat`「对话」页（对话列表 + 消息流 + pending 轮询 + 删除），导航加入口；
   - 报告详情页追问改为创建/继续 `follow_up` 对话（异步，提交后可离开，回来从对话列表或报告页继续）。
4. 测试：db 对话 CRUD 单测；web 端到端（创建对话 → mock AI 完成 → 轮询取到回答；删除对话；50 个滚动限制）；`npm test` 全绿。
5. 验证 + `npm version minor` + commit。

### 阶段三：AI 记忆

1. `src/db.js`：`ai_memories` 表 + `saveMemory` / `listMemories` / `listAllMemories` / `deleteMemory`（含滚动清理与 500 字校验）。
2. `src/tools.js`：注册 `save_memory` 工具（写 `ai_memories`，带 source 场景标记）。
3. `src/prompts.js`：`buildMemorySection()`，报告、追问与直接对话注入记忆清单。
4. `server.js`：`GET /api/ai/memories`、`DELETE /api/ai/memory` 接口。
5. `web/`：设置页"AI 记忆"区块（列表 + 删除），沿用现有暗色风格与 fetch 封装。
6. 测试：db 记忆 CRUD 单测；web 端到端（memories 接口 + save_memory 工具经 mock AI 触发）；`npm test` 全绿。
7. 验证 + `npm version minor` + commit。

### 阶段四：收尾

1. 用 `input/` 真实 FIT 文件 + 真实 AI 配置做端到端人工验证（生成复盘报告观察工具调用日志；直接对话观察取数与记忆保存）。
2. 更新 README（AI 分析一节）、AGENTS.md（代码结构、测试策略、安全考虑）。
3. `npm test` 最终全绿；`npm version patch`（如前几阶段已升 minor 则此处视情况）+ commit。

---

## 10. 验收标准

- 配置 Kimi（或任一支持 tools 的 OpenAI 兼容接口）后，生成复盘报告时服务端日志可见 AI 自主发起的工具调用（如查询历史训练对比）；
- 报告追问"和我上个月那次同类骑行比怎么样"，AI 能通过 `list_activities` + `get_activity_summary` 自行取数回答；问答入库，提交后关闭页面，事后可在对话列表回看；≤200 字限制仅约束最终回答；
- 对话可整条删除（含全部消息）；每 mode 超过 50 个对话自动滚动清理；
- `#/chat` 直接对话页在无任何报告上下文时可自由问答，AI 通过工具调用取数（如"这周状态适合上强度吗"触发 `get_form_series`）；
- 对话中用户提到"下周出差只能骑台子"，当轮或后续交互中 AI 调用 `save_memory`；设置页可见该条带日期的记忆；下一轮 AI 调用提示词中包含该记忆；
- 换成不支持 tools 的模型，报告/追问/对话自动退回单轮模式，无报错中断；
- `npm test` 全部通过。
