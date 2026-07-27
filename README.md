# fit-reader

一个解析码表/运动手表 `.fit` 文件的本地训练分析工具，输出逐秒时序 CSV 与汇总指标 JSON，并提供 Web 仪表盘与 AI 训练报告。

## 能做什么

- **FIT 文件解析**：把 `.fit` 文件重采样为严格 1 秒网格的时序 CSV（功率、心率、踏频、海拔、速度、温度），并生成汇总 JSON（NP、IF、TSS、功率/心率分区、峰功率曲线、心率漂移、间歇/爬坡段、数据质量等）
- **运动指标计算**：标准化功率（NP）、强度因子（IF）、训练负荷（TSS）、CTL/ATL/TSB 负荷趋势、FTP 自动估算（20min 峰功率 × 0.95）、科学 FTP 估算（CP 模型 + Coggan 双法互校 + 心率交叉验证）
- **多运动类型**：骑行（指标最全）、跑步（配速/步频）、游泳（length 消息：趟数/泳池长度/划水/SWOLF）
- **Web 仪表盘**：本地浏览器查看负荷趋势、月度汇总、训练详情时序曲线、分区分布、上传分析
- **AI 训练分析**：一键生成单次复盘、周期规划、赛前减量、两次对比报告；支持历史报告与继续追问（快问快答，100 字以内）；训练备注（体感/路况）与身份/训练目标会纳入 AI 分析考量
- **训练数据库**：SQLite 本地训练库，自动记录每次分析并计算长期负荷趋势

## 快速开始

```bash
npm install

# 分析单个文件
node index.js 你的骑行.fit

# 批量处理目录下所有 .fit
node index.js ./input ./output

# 启动 Web 界面（默认 http://localhost:3000）
npm run web

# 运行回归测试
npm test
```

## Docker 部署（快速开始）

已发布镜像到 GitHub Packages，可直接拉取运行：

```bash
docker pull ghcr.io/sicheng886/fit-reader:latest
docker run -d \
  --name fit-reader \
  -p 3000:3000 \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  -v "$(pwd)/db:/app/db" \
  ghcr.io/sicheng886/fit-reader:latest
```

启动后访问 http://localhost:3000 即可使用。

完整构建说明（含本地构建、版本号标签、持久化挂载、权限配置）见 **[DEPLOY.md](./DEPLOY.md)**。

## 技术栈

- Node.js（ESM，零构建、零转译）
- `fit-file-parser`：解析 `.fit` 文件
- `marked`：AI 报告 Markdown 转 HTML
- Node 内置 `node:sqlite`：本地训练库

## 开发约定

详见 `AGENTS.md`：算法阈值集中在 `src/settings.js`，骑手参数走训练库 settings 表，修改指标算法后需跑 `npm test` 并同步更新文档。
