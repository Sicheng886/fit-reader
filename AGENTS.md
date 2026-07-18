# AGENTS.md — fit-reader 项目说明（供 AI 编码代理阅读）

## 项目概览

**fit-reader** 是一个无构建步骤的 Node.js 命令行项目（主脚本 `index.js` + 配置 `settings.js`），用于解析码表/运动手表导出的 `.fit` 文件（当前以骑行数据为主），输出两类结果：

1. `xxx.records.csv` — 重采样到严格 1 秒网格的逐秒时序明细（timestamp, power, heart_rate, cadence, altitude, speed, distance_m），供存档与程序化计算；
2. `xxx.summary.json` — 汇总训练指标（NP、IF、TSS、功率/心率分区分布、峰功率曲线、心率漂移、圈/赛段、数据质量与异常标注），设计上用于直接喂给 AI 做训练解读。

这不是一个库，也没有构建步骤——直接运行脚本即可。

## 技术栈与运行方式

- **运行时**：Node.js（已在 v22.20.0 上验证），**ESM（ECMAScript Modules）**（`package.json` 中 `"type": "module"`，源码使用 `import`/`export` 语法），零构建、零转译。
- **唯一依赖**：`fit-file-parser`（^3.0.2）。⚠️ 注意**不是** `fit-parser`（同名不相干的包）。
- **关键配置**：`package.json`（`main: index.js`，唯一脚本 `npm test` 是占位符，会直接报错退出）。

### 命令

```bash
npm install          # 安装依赖

# 分析单个文件（输出默认写到输入文件所在目录）
node index.js <输入.fit> [输出目录]

# 批量处理：扫描目录顶层所有 .fit（输出默认写到 cwd 的 output/）
node index.js <目录> [输出目录]

# 训练库查询（基于 ./db/fitness.db）
node index.js --monthly [月数=6]              # 逐月训练汇总
node index.js --trend [月数=12] [输出.html]   # 生成 CTL/ATL/TSB 逐月趋势图

# 项目内真实示例
node index.js input/MAGENE_C506SE_2026-07-17_202219_1273797.fit output/
```

单文件模式成功后会打印两个输出文件路径及 summary JSON 全文；批量模式逐文件打印一行进度（失败不中断）并在结尾打印成功/失败计数；解析失败时输出 `解析失败: <message>` 并以退出码 1 结束。

### 必须修改的骑手参数

`settings.js` 中的 `ATHLETE` 常量（`ftp_watts` / `max_hr` / `weight_kg`）是所有派生指标准确性的前提，换骑手必须改这里。当前值为 `ftp: 119W, max_hr: 195, weight: 60kg`。功率/心率分区及间歇识别、爬坡提取、踏频分析的算法阈值（`POWER_ZONES` / `HR_ZONES` / `INTERVAL_DETECTION` / `CLIMB_DETECTION` / `CADENCE_ANALYSIS`）也都集中在 `settings.js`。

## 代码结构

- `settings.js`：全部可调配置（骑手参数、分区、算法阈值），纯数据、无逻辑。
- `db.js`：训练库模块。基于 Node 内置 `node:sqlite`（≥22.5，零第三方依赖），数据库固定为 `./db/fitness.db`（懒打开，目录/表不存在时自动创建）；提供 `upsertActivity`（按文件名去重）、`computeForm`（CTL/ATL/TSB 指数加权）、`monthlySummary`（逐月汇总与强度分类）、`trendMonthly`（逐月趋势数据）。
- `index.js`（约 800 行）：主脚本，内部组织为：

| 区块 | 内容 |
|---|---|
| 工具函数 | `zoneOf` / `zoneDistribution`（区间分布）、`normalizedPower`（30s 滚动平均的四次方均根，缺口窗口不参与）、`peakAvg`（指定时长最大平均功率，要求窗口连续）、`hrDriftPct`（前后半程效率因子相对变化）、`findPowerGaps`（功率缺失 > 60s 检测）、`elevationGain`（带 1m 阈值去抖的累计爬升）、`avgField` / `maxField`（片段统计） |
| P0 分析函数 | `estimateFtp`（20min 峰功率 × 0.95 估算 FTP 并给更新建议）、`detectIntervals`（≥105% FTP 过阈段识别 + 间歇组统计）、`detectClimbs`（30s 窗口坡度 ≥3% 的爬坡段提取）、`cadencePowerAnalysis`（发力时段踏频习惯与踏频-功率相关性） |
| 单文件流程 `analyzeFile()` | ① 解析 FIT（`force: true`, `km/h`, `km`, `mode: "list"`）→ ② 按秒重采样记录（缺口置 `null`）→ ③ 写 CSV → ④ 计算指标（含 P0 分析）→ ⑤ 训练库入库 + `athlete_context` 注入当日 CTL/ATL/TSB（失败仅警告不中断）→ ⑥ 写 summary JSON，返回结果 |
| 查询命令 | `printMonthly()`（逐月汇总表）、`writeTrendHtml()`（自包含 HTML 趋势图：月 TSS 柱 + CTL/ATL/TSB 月末折线，原生 SVG 无外部库） |
| 入口 `main()` | `--monthly` / `--trend` → 训练库查询；输入是目录 → 批量模式（逐文件调用 `analyzeFile`，失败不中断）；输入是文件 → 单文件模式并打印 JSON 全文 |

目录约定：`input/` 放待分析的 `.fit` 文件，`output/` 放分析结果。这两个目录只是约定，脚本本身不依赖它们。

## 版本控制约定（重要）

- 项目使用 **git** 进行版本控制。**每次完成修改后（无论是代码、配置还是文档变更）都必须执行 `git commit`**，并附上清晰描述本次变更内容的中文 commit message。
- commit message 约定：使用中文，简要说明“做了什么 + 为什么”，例如 `重构: index.js 迁移到 ESM 模块`。
- `node_modules/`、`output/`、`db/` 等生成物不入库（见 `.gitignore`）。

## 开发约定与编码风格

- 使用 ESM 语法（`import`/`export`），禁止使用 CommonJS 的 `require`/`module.exports`。
- 注释与文档一律使用**中文**（本项目的主要自然语言），函数级注释说明算法口径（如"30s 滚动平均的四次方均根"）。
- 主逻辑集中在 `index.js`：新功能优先加入"工具函数"区，保持纯函数、无状态；所有可调配置（骑手参数、分区、算法阈值）一律放进 `settings.js`，不要在 `index.js` 里硬编码常量。
- 数值处理惯例：缺数据统一用 `null` 表示（CSV 中留空，JSON 中字段可省略）；`undefined` 字段在输出前会被清理； rounding 口径写在代码里（如功率取整、海拔保留 1 位、速度保留 2 位）。
- 算法须遵循运动科学标准口径（NP/IF/TSS 公式见 README"已完成的指标算法"一节），改算法时同步更新 README。
- 核心指标依赖 `settings.js` 中的 `ATHLETE` 配置，修改常量时确认 README 中的示例配置是否需同步。

## 测试策略

**当前没有任何自动化测试**（`npm test` 是占位符，会报错退出）。验证方式为端到端手动测试：

1. 用 `input/` 下的真实 FIT 文件跑一遍脚本，确认生成 CSV + JSON 且指标合理；
2. README 声称曾用"合成 FIT 文件（30 分钟模拟骑行，含 60 秒功率缺失）"做过回归验证，对应的测试工具 `make_test_fit.py` 在 README 中被提及，但**该文件当前不存在于仓库中**。

修改指标算法后，至少用 `input/` 中的样例文件重新跑一次端到端验证；涉及训练库的改动还需验证 `--monthly` / `--trend` 与删库自动重建（`rm -rf db` 后重跑分析）。README 路线图的 P3 中列有"单元测试（用合成 FIT 文件）"的待办。

## 已知注意事项

- **README 与实际代码的偏差已修复**：入口文件为 `index.js`，配置在 `settings.js`；`make_test_fit.py` 仍不存在（README 文件清单中已标注为规划中）。
- README 中包含一份很长的功能路线图（P0–P4），**P0 已全部完成**（批量处理、FTP 自动估算、间歇识别、爬坡段提取、踏频-功率联合分析），**P1 已全部完成**（SQLite 训练库、CTL/ATL/TSB 写入 `athlete_context`、月汇总 `--monthly`、趋势图 `--trend`；因训练频率低，路线图的“周汇总”落地为月汇总）。实现新功能前先看是否已在路线图中、应归入哪个优先级，完成后勾选对应条目。
- 没有 CI、没有部署流程——这是一个纯本地脚本项目（git 仅用于本地版本控制）。
- 项目源码统一使用 ESM（`.js` + `"type": "module"`），`fit-file-parser` 为 CommonJS 包，通过默认导入（`import FitParser from "fit-file-parser"`）由 Node 的 CJS-ESM 互操作处理。
- FIT 解析已开启 `force: true` 容忍损坏文件，但被跳过的记录数目前不记录（README P3 待办）。
- 当前只针对**骑行**数据做了指标设计，跑步/游泳适配在路线图 P3。

## 安全考虑

- 仅读取本地文件，无网络访问、无外部 API 调用；FIT 文件视为不可信输入，解析器以 `force: true` 容错运行。
- 无密钥、无环境变量配置。
