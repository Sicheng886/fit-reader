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
# 或使用快捷脚本（等同于 node index.js input/ output/）
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
```

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

每次分析后，summary 会自动写入本地 SQLite 训练库 `./db/fitness.db`（首次运行时自动创建目录、文件与表，无需手动初始化；该目录已在 `.gitignore` 中）。按文件名去重，重复分析同一文件会覆盖更新而不是新增记录。基于库中历史，summary 的 `athlete_context` 会自动附带当日的 `ctl` / `atl` / `tsb` 及中文状态简评，供 AI 判断"这次训练在周期中的位置"。数据库使用 Node 内置 `node:sqlite`（≥22.5），无第三方依赖。

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

- `activity`：日期、运动类型、时长、距离、爬升
- `athlete_context`：骑手参数（后续应加入 CTL/ATL/TSB）
- `power`：平均/标准化功率（NP）、最大功率、变异指数（VI）、强度因子（IF）、TSS、功体比、峰功率曲线（5s/1min/5min/20min）、FTP 自动估算（20min 峰功率 × 0.95 及更新建议）、Coggan 7 区时间分布
- `heart_rate`：平均/最大心率、5 区时间分布、心率漂移（有氧解耦 %）
- `cadence`：平均踏频
- `cadence_power`：踏频-功率联合分析（发力时段的平均踏频、低/高踏频占比、踏频-功率相关系数、发力习惯判读）
- `climbs`：自动提取的爬坡段（长度/爬升/平均坡度/平均功率），无爬坡时省略
- `interval_set`：间歇组统计（组数、平均时长/功率/%FTP），仅当识别到 ≥2 个重复工作段时出现
- `segments`：圈/赛段统计（来自 FIT 中的 lap 消息）+ 自动识别的间歇工作段
- `anomalies`：功率缺失片段、心率跳变等设备异常标注
- `data_quality`：功率/心率数据覆盖率

## 已完成的指标算法

- NP：30 秒滚动平均 → 四次方均值 → 开四次方根（标准算法，缺口窗口不参与）
- IF = NP / FTP
- TSS = (时长秒 × NP × IF) / (FTP × 3600) × 100
- 心率漂移：前后半程 效率因子（功率/心率）的相对变化
- 功率/心率区间分布、峰功率曲线（要求窗口数据连续）
- 功率缺失 > 60s 检测、心率跳变（相邻秒差 > 25）检测
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

- [ ] **游泳/跑步适配**：当前以骑行为主，跑步需加入配速/步频指标，游泳需处理长度（length）消息
- [ ] **开发者字段**：解析自定义字段（部分第三方码表的功率计数据在这里）
- [ ] **损坏文件兜底**：`force: true` 已开启，但需记录被跳过的记录数
- [ ] **单元测试**：用合成 FIT 文件（参考 `make_test_fit.py` 的思路）做回归测试

### P4 — 可选扩展

- [ ] **对接 AI API**：直接调 OpenAI/Claude/Kimi API，输出 Markdown 复盘报告
- [ ] **Web 界面**：上传 FIT → 展示图表 + AI 分析结果
- [ ] **对接 TrainingPeaks / intervals.icu**：对比其官方指标，校验自己的算法

## 验证状态

脚本已通过端到端测试：合成 FIT 文件（30 分钟模拟骑行，含 60 秒功率缺失）→ CSV + JSON 输出正确，功率缺失被正确标注为异常。

## 文件清单

| 文件                   | 说明                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `index.js`             | 主脚本：解析 + 指标计算 + 输出（单文件/批量/`--monthly`/`--trend`） |
| `settings.js`          | 全部可调配置：骑手参数、分区定义、各分析算法阈值            |
| `db.js`                | 训练库：SQLite 入库/去重、CTL/ATL/TSB 计算、月汇总与趋势数据 |
| `prompts.js`           | AI 提示词模板库：复盘/规划/赛前/对比四种场景的提示词组装    |
| ~~`make_test_fit.py`~~ | （规划中，尚不存在）测试工具：生成合成 FIT 文件用于回归验证 |
