# FIT 训练数据分析项目

把码表/运动手表导出的 `.fit` 文件，转换为**逐秒时序 CSV**（存档与程序化计算）+ **汇总指标 JSON**（直接交给 AI 做训练解读与科学训练建议）。

## 快速开始

```bash
npm install

# 分析单个文件
node index.js 你的骑行.fit

# 指定输出目录
node index.js 你的骑行.fit ./output

# 批量处理：扫描目录顶层所有 .fit，单文件失败不中断
node index.js ./input ./output
# 或使用快捷脚本（批量分析 input/ → output/，并自动重新生成趋势图）
npm run analysis

# 逐月训练汇总（基于本地训练库）
node index.js --monthly [月数=6]

# 生成 CTL/ATL/TSB 逐月趋势图（自包含 HTML）
node index.js --trend [月数=12] [输出.html]

# 生成 AI 提示词（拼好 上下文+数据+问题，打印到终端供复制；给输出路径则同时写 .md）
node index.js --review <xxx.summary.json> [输出.md]   # 单次复盘
node index.js --plan [周数=8] [输出.md]               # 周期规划（自动带月汇总+CTL走势）
node index.js --taper <比赛日期> [输出.md]            # 赛前减量
node index.js --compare <A.summary.json> <B.summary.json> [输出.md]  # 两次训练对比

# 运行回归测试（指标算法单测 + 合成 FIT 端到端 + Web 服务端到端）
npm test

# 启动 Web 界面（默认 http://localhost:3000，PORT 环境变量可改端口）
npm run web
```

### Web 界面（P4）

`npm run web` 启动本地服务后浏览器打开 http://localhost:3000 ：

- **概览**：CTL/ATL/TSB 大数字仪表 + 最近 90 天负荷趋势图 + 月度汇总 + 最近训练
- **训练**：训练库全部记录列表；点进详情有时序曲线（功率/心率/踏频/海拔/速度，可开关系列）、分区分布、峰功率曲线、赛段/间歇/爬坡、数据质量
- **上传**：拖拽 .fit 文件即分析入库（文件存 `input/`，结果写 `output/`）
- **AI 分析**：单次复盘 / 周期规划 / 赛前减量 / 两次对比四种场景一键生成报告

AI 直接出报告需配置环境变量（OpenAI 兼容接口，Kimi/OpenAI/DeepSeek 均可）。最简单的方式是在项目根目录建一个 `.env` 文件（已在 `.gitignore` 中，`npm run web` 启动时通过 Node 内置 `process.loadEnvFile()` 自动注入，无需 dotenv）：

```ini
FIT_AI_API_KEY=sk-...                          # 必填
FIT_AI_BASE_URL=https://api.moonshot.cn/v1     # 可选，默认 Kimi
FIT_AI_MODEL=moonshot-v1-32k                   # 可选，复盘提示词较长建议 32k 上下文
FIT_AI_TEMPERATURE=0.3                         # 可选，缺省不传（部分模型只允许特定取值，如 kimi-k2.x 只允许 1）
FIT_AI_TIMEOUT_MS=600000                       # 可选，默认 5 分钟（300000ms）；复盘提示词很长，建议 10 分钟起步
```

也可以用传统方式 export（Windows PowerShell: `$env:FIT_AI_API_KEY="sk-..."`）。模型名以你的账号可用列表为准（可用 `GET $FIT_AI_BASE_URL/models` 带密钥查询）。

未配置密钥时自动退化为 P2 模式：生成完整提示词 + 一键复制按钮，粘贴到任意 AI 即可。


> 注意：依赖包是 `fit-file-parser`，**不是** `fit-parser`（同名不相干的包）。

## 配置

打开 `settings.js`，修改骑手参数（指标准确性的前提）。功率/心率分区、间歇识别/爬坡提取/踏频分析的算法阈值也都在这个文件里集中调整：

```js
export const ATHLETE = {
  ftp_watts: 119, // 功能阈值功率（建议每 4-8 周实测更新）
  max_hr: 195, // 最大心率
  weight_kg: 60,
};
```

## 训练数据库

每次分析后，summary 会自动写入本地 SQLite 训练库 `./db/fitness.db`（首次运行时自动创建目录、文件与表，无需手动初始化；该目录已在 `.gitignore` 中）。按文件名去重，重复分析同一文件会覆盖更新而不是新增记录。基于库中历史，summary 的 `athlete_context` 会自动附带当日的 `ctl` / `atl` / `tsb` 及中文状态简评，供 AI 判断"这次训练在周期中的位置"。数据库使用 Node 内置 `node:sqlite`（≥22.5），无第三方依赖。数据库路径可用环境变量 `FIT_DB_PATH` 覆盖（测试隔离用）。

## 输出说明

### `xxx.records.csv` — 逐秒时序明细

| 列         | 说明                             |
| ---------- | -------------------------------- |
| timestamp  | ISO 8601 UTC 时间，严格 1 秒网格 |
| power      | 功率（W），设备掉秒留空          |
| heart_rate | 心率（bpm）                      |
| cadence    | 踏频（rpm）                      |
| altitude   | 海拔（m）                        |
| speed      | 速度（km/h）                     |
| distance_m | 累计距离（m）                    |

### `xxx.summary.json` — 汇总指标（喂 AI 用）

- `activity`：日期、运动类型（cycling/running/swimming）、时长、距离、爬升
- `athlete_context`：骑手参数 + 当日 CTL/ATL/TSB 及状态简评
- `power`：平均/标准化功率（NP）、最大功率、变异指数（VI）、强度因子（IF）、TSS、功体比、峰功率曲线（5s/1min/5min/20min）、FTP 自动估算（20min 峰功率 × 0.95 及更新建议）、Coggan 7 区时间分布
- `heart_rate`：平均/最大心率、5 区时间分布、心率漂移（有氧解耦 %）
- `cadence`：平均踏频（跑步为步频 spm）
- `pace`（仅跑步）：平均配速、最快 1 分钟配速（min/km）；lap 级赛段附带平均配速
- `swim`（仅游泳）：趟数、泳池长度、平均每趟用时、总划水数、平均 SWOLF（秒+划水次数）
- `developer_fields`：开发者字段统计（第三方码表自定义数值字段的 样本数/均值/最值），无则省略
- `cadence_power`：踏频-功率联合分析（发力时段的平均踏频、低/高踏频占比、踏频-功率相关系数、发力习惯判读）
- `climbs`：自动提取的爬坡段（长度/爬升/平均坡度/平均功率），无爬坡时省略
- `interval_set`：间歇组统计（组数、平均时长/功率/%FTP），仅当识别到 ≥2 个重复工作段时出现
- `segments`：圈/赛段统计（来自 FIT 中的 lap 消息）+ 自动识别的间歇工作段
- `anomalies`：功率缺失片段、整段记录缺失、心率跳变等设备异常标注
- `data_quality`：功率/心率数据覆盖率、解析记录数、无时间戳丢弃记录数、时间跨度内缺失秒数（损坏文件被跳过的记录会体现为缺失秒数）

## 已完成的指标算法

- NP：30 秒滚动平均 → 四次方均值 → 开四次方根（标准算法，缺口窗口不参与）
- IF = NP / FTP
- TSS = (时长秒 × NP × IF) / (FTP × 3600) × 100
- 心率漂移：前后半程 效率因子（功率/心率）的相对变化
- 功率/心率区间分布、峰功率曲线（要求窗口数据连续）
- 功率缺失 > 60s 检测、整段记录缺失 ≥ 10s 检测、心率跳变（相邻秒差 > 25）检测
- 心率漂移口径：骑行用 功率/心率；跑步等无功率数据时自动切换为 速度/心率
- 跑步适配：配速（min/km）指标、步频；游泳适配：解析 length 消息（趟数/泳池长度/划水/SWOLF），record 缺距离时用 session 距离兜底
- 开发者字段：record 中非标准字段按 field_description 命名解析，输出数值统计
- FTP 自动估算：20 分钟峰功率 × 0.95（无连续 20 分钟窗口时省略）
- 间歇识别：功率 ≥ 105% FTP 的过阈段，短瞬时掉功率合并、< 30s 丢弃
- 爬坡段提取：30s 窗口局部坡度 ≥ 3%，且段内爬升 ≥ 15m、长度 ≥ 300m
- 踏频-功率联合分析：仅统计功率 ≥ 75% FTP 的发力时段，低踏频 < 80rpm / 高踏频 > 90rpm
- CTL = TSS 的 42 天指数加权（慢性负荷/体能）；ATL = TSS 的 7 天指数加权（急性负荷/疲劳）；TSB = CTL − ATL（状态）；缺天按 TSS=0 参与衰减
- 月度强度分布：低(Z1–Z2)/中(Z3–Z4)/高(Z5–Z7) 时间占比按时长加权；分类规则：低≥75% 且 高>中 → polarized，低>中>高 → pyramidal，其余 → sweet_spot

## 后续路线图

### P0 — 让单次分析更完整

- [x] **批量处理**：扫描整个 FIT 文件夹，一次输出所有 CSV + JSON
- [x] **FTP 自动估算**：用 20 分钟峰功率 × 0.95 反推 FTP，提示是否需要更新 ATHLETE 配置
- [x] **间歇识别**：自动识别重复的高功率区间（如 5×5min @ 110% FTP），输出到 `segments`
- [x] **爬坡段提取**：基于海拔变化自动切分爬坡段（爬升 > 阈值、坡度 > 3%）
- [x] **踏频-功率联合分析**：低踏频高扭矩 vs 高踏频的发力习惯判断

### P1 — 长期负荷跟踪（科学训练的核心）

- [x] **训练库**：每次分析后把 `summary.json` 写入本地 SQLite 数据库（`./db/fitness.db`，按文件名去重）
- [x] **CTL / ATL / TSB**：
  - CTL（慢性负荷，体能）= TSS 的 42 天指数加权
  - ATL（急性负荷，疲劳）= TSS 的 7 天指数加权
  - TSB（状态）= CTL − ATL
- [x] **把近期 CTL/ATL/TSB 写入 `athlete_context`**，AI 才能判断"这次训练在你的周期里处于什么位置"
- [x] **月汇总**：月 TSS、月时长、强度分布（极化/金字塔/甜区占比）（`--monthly`，训练频率低故按月而非按周）
- [x] **Fitness 趋势图**：CTL/ATL/TSB 逐月曲线 + 月 TSS 柱，自包含 HTML（`--trend`）

### P2 — AI 分析工作流

- [x] **提示词模板库**（`prompts.js`）：固化几种提问方式
  - 单次复盘（`--review`）：分析强度分布，判断训练类型，评估心率漂移
  - 周期规划（`--plan`）：基于最近 8 周 CTL 趋势，下周应安排什么强度
  - 赛前调整（`--taper`）：距离比赛 N 天，TSB 应调整到多少，怎么减量
- [x] **自动生成 AI 输入**：脚本直接拼好 `上下文 + 数据 + 问题`，打印到终端一键复制（调 API 见 P4）
- [x] **多次训练对比**（`--compare`）：给定两个 summary，让 AI 分析进步/退步

### P3 — 数据质量与兼容性

- [x] **游泳/跑步适配**：跑步加入配速（min/km）/步频指标与 lap 级配速，心率漂移自动切换速度口径；游泳解析 length 消息（趟数/泳池长度/划水/SWOLF）
- [x] **开发者字段**：解析自定义字段（部分第三方码表的功率计数据在这里），输出到 `developer_fields` 数值统计
- [x] **损坏文件兜底**：`force: true` 已开启，`data_quality` 记录解析记录数/无时间戳丢弃数/缺失秒数，≥10s 的整段缺失在 `anomalies` 标注
- [x] **单元测试**：`test/` 下手写 FIT 二进制生成器（`make_test_fit.mjs`，README 早期规划中 `make_test_fit.py` 的落地版）+ `node --test` 回归测试（`npm test`）

> 顺手修复的隐藏 bug：解析器按 `lengthUnit: "km"` 会把海拔/爬升缩放成 km，此前海拔输出与爬坡检测被压低 1000 倍（MAGENE 海拔恒 0 故从未暴露），现已统一换回米。

### P4 — 可选扩展

- [x] **对接 AI API**：`ai.js` 直接调 OpenAI 兼容接口（`FIT_AI_API_KEY`/`FIT_AI_BASE_URL`/`FIT_AI_MODEL`，默认 Kimi），输出 Markdown 复盘报告；未配置密钥时退化为复制提示词模式
- [x] **Web 界面**：`npm run web`（`server.js` 零依赖 HTTP 服务 + `web/` 纯前端 SPA）——训练库仪表盘、训练详情图表、上传 FIT 分析、AI 分析结果展示
- [ ] **对接 TrainingPeaks / intervals.icu**：对比其官方指标，校验自己的算法

## 验证状态

`npm test` 全部通过：指标算法单元测试 + 合成 FIT 端到端回归（30 分钟模拟骑行含 60 秒功率缺失、损坏文件缺失计数、跑步配速、游泳 length、开发者字段）+ Web 服务端到端（上传/概览/详情/时序/AI 提示词/路径安全），并定期用 `input/` 下真实码表文件做端到端验证。

## 文件清单

| 文件                   | 说明                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `index.js`             | 主脚本：解析 + 指标计算 + 输出（单文件/批量/`--monthly`/`--trend`） |
| `settings.js`          | 全部可调配置：骑手参数、分区定义、各分析算法阈值            |
| `db.js`                | 训练库：SQLite 入库/去重、CTL/ATL/TSB 计算、月汇总与趋势数据 |
| `prompts.js`           | AI 提示词模板库：复盘/规划/赛前/对比四种场景的提示词组装    |
| `ai.js`                | AI API 客户端（P4）：OpenAI 兼容 chat/completions，默认 Kimi |
| `server.js`            | Web 服务（P4）：零依赖 HTTP 服务 + REST API（`npm run web`） |
| `web/`                 | Web 前端（P4）：纯 HTML/CSS/JS SPA，手写 SVG 图表，暗色运动风 |
| `test/make_test_fit.mjs` | 测试工具：手写 FIT 二进制生成器（骑行/跑步/游泳/损坏场景） |
| `test/unit.test.mjs`   | 指标算法纯函数单元测试（node:test）                          |
| `test/e2e.test.mjs`    | 端到端回归：合成 FIT → analyzeFile → 校验 CSV + summary      |
| `test/web.test.mjs`    | Web 服务端到端：上传/概览/详情/时序/AI 提示词/路径安全       |
