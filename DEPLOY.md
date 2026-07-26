# fit-reader Docker 部署指南

把 fit-reader 打包成 Docker 镜像并部署为本地/服务器 Web 服务。

---

## 前置条件

- 已安装 Docker（建议 24.x 或更高）
- 已安装 Docker Compose（v2，即 `docker compose` 命令可用）

> 本项目**不需要 `.env` 文件**：AI 密钥等所有用户配置都在 Web「设置」页填写，保存在训练库（SQLite）中。

---

## 1. 构建镜像

在项目根目录执行：

```bash
docker build -t fit-reader:latest .
```

构建完成后，可用 `docker images | grep fit-reader` 查看镜像。

---

## 2. 启动容器（推荐：docker compose）

项目已提供 `docker-compose.yml`，最简启动方式：

```bash
docker compose up -d
```

启动后访问：

```
http://localhost:3000
```

如需改宿主机端口，调整 `docker-compose.yml` 里的端口映射（容器内部端口固定 3000；也可用环境变量 `PORT` 改容器内端口）。

### 停止与重启

```bash
docker compose down          # 停止并删除容器
docker compose up -d         # 重新启动
docker compose logs -f       # 查看实时日志
docker compose pull          # 如果镜像已推送到仓库，先拉取最新
```

---

## 3. 首次使用：设置骑手参数与 AI 密钥

首次打开 Web 界面会自动引导到「设置」页：

1. **骑手参数**：FTP / 最大心率 / 体重——所有派生指标（NP/IF/TSS/分区）准确性的前提。
2. **AI 服务**：填入 API 密钥即可让「AI 分析」一键出报告；接口地址与模型名已预填 Kimi（`https://api.moonshot.cn/v1` + `kimi-k2.6`），用其它 OpenAI 兼容服务（OpenAI/DeepSeek 等）改这两个字段即可。

保存后写入训练库并跳回首页，之后可随时回设置页调整。

**获取 Moonshot API Key 的步骤：**

1. 打开 [Moonshot 开放平台](https://platform.moonshot.cn/)，登录/注册账号。
2. 进入「API Key 管理」页面，点击「创建 API Key」，起个名字，例如 `fit-reader`。
3. 复制以 `sk-` 开头的字符串，粘贴到设置页的「API 密钥」输入框。

> ⚠️ 安全提示：API Key 等同于账号密码。它只保存在本地训练库（`./db/fitness.db`，已被 `.gitignore` 排除）中，用于向你配置的接口地址发请求，不会上传到任何其它地方。

> 不填密钥也能正常使用：Web 界面除 AI 报告外全部可用，「AI 分析」会生成完整提示词供你复制到任意 AI 工具。

> 老版本升级：如果你之前在 `.env` 里配置过 `FIT_AI_API_KEY`，首次启动新版本时会自动把 `FIT_AI_*` 环境变量一次性迁入训练库（日志会打印迁移提示），之后 `.env` 可删除。

---

## 4. 纯 docker run 方式（不安装 docker compose 时使用）

```bash
docker run -d \
  --name fit-reader \
  -p 3000:3000 \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  -v "$(pwd)/db:/app/db" \
  fit-reader:latest
```

Windows PowerShell 中挂载路径写法：

```powershell
docker run -d `
  --name fit-reader `
  -p 3000:3000 `
  -v "${PWD}/input:/input" `
  -v "${PWD}/output:/output" `
  -v "${PWD}/db:/app/db" `
  fit-reader:latest
```

---

## 5. 批量分析（命令行模式）

默认镜像入口是 Web 服务。如果只想在容器里跑批量分析，可以覆盖默认命令：

```bash
docker run --rm \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  fit-reader:latest \
  node index.js /input /output
```

分析完成后，宿主机 `./output` 目录下会出现 `*.records.csv` 和 `*.summary.json`。

---

## 6. 目录挂载说明

| 容器路径 | 建议挂载 | 说明 |
| --- | --- | --- |
| `/input` | **必须** | 存放待分析的 `.fit` 文件 |
| `/output` | **必须** | 分析后生成的 CSV、JSON、趋势图 |
| `/app/db` | **强烈建议** | SQLite 训练库（含骑手参数与 AI 密钥设置），挂载后容器重建不会丢失 |
| `/app/src/settings.js` | 可选 | 自定义算法阈值 / 出厂默认值 |

### 自定义骑手参数与算法阈值

骑手参数（FTP / 最大心率 / 体重）与 AI 服务配置**不需要挂载任何文件**：直接在 Web 界面「设置」页修改，保存在训练库（`/app/db`，已挂载持久化）中，保存后即时生效。首次打开 Web 界面且未配置过时，会自动引导到设置页。

如需调整算法阈值（分区、间歇/爬坡识别等）或骑手参数的出厂默认值，才把本机 `src/settings.js` 挂载进容器：

```bash
# 编辑 src/settings.js 里的分区 / 阈值 / ATHLETE、AI_CONFIG 出厂默认值
docker run -d \
  --name fit-reader \
  -p 3000:3000 \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  -v "$(pwd)/db:/app/db" \
  -v "$(pwd)/src/settings.js:/app/src/settings.js" \
  fit-reader:latest
```

或者在 `docker-compose.yml` 中保留 `- ./src/settings.js:/app/src/settings.js` 挂载。

> 注意：库中已有 athlete / ai 配置时，`settings.js` 里的 `ATHLETE` / `AI_CONFIG` 不再生效（它们只是出厂默认值）；改阈值需要重建容器或重启。

---

## 7. 更新与重建

更新代码后重新构建镜像：

```bash
docker compose down
docker compose up -d --build
```

或单独构建：

```bash
docker build -t fit-reader:latest .
docker compose up -d
```

---

## 8. 常见问题

### 8.1 容器启动后无法访问 `localhost:3000`

1. 检查容器是否运行：`docker ps -a`
2. 查看日志：`docker logs fit-reader`
3. 检查端口是否被占用：
   - 在 `docker-compose.yml` 或 `docker run` 中换一个宿主机端口，例如 `-p 8080:3000`

### 8.2 输出文件权限是 root

容器默认以 root 运行。如需让输出文件归当前用户所有，可在 `docker run` 或 `docker compose` 中加 `-u $(id -u):$(id -g)`：

```bash
docker run -d \
  --name fit-reader \
  -u "$(id -u):$(id -g)" \
  -p 3000:3000 \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  -v "$(pwd)/db:/app/db" \
  fit-reader:latest
```

使用 `docker compose` 时，在 `docker-compose.yml` 里加：

```yaml
user: "1000:1000"  # 改成你的宿主机 uid:gid
```

### 8.3 AI 报告一直超时

- 在设置页「AI 服务 → 高级选项」中增大总超时（例如 1200000，即 20 分钟）。
- 检查 AI 账户是否有足够余额。
- 查看模型是否可用：`curl -H "Authorization: Bearer sk-你的密钥" https://api.moonshot.cn/v1/models`

### 8.4 我不想用 AI，只想看 Web 界面和指标

设置页留空 API 密钥即可。Web 界面除了 AI 报告按钮外全部可用，AI 报告会生成提示词供你复制到其它 AI 工具。

---

## 9. 检查清单

部署前确认：

- [ ] 已创建/确认 `input/` 目录（用于放 `.fit` 文件）
- [ ] 已创建/确认 `output/` 目录（用于接收结果）
- [ ] 已运行 `docker build -t fit-reader:latest .` 且成功
- [ ] 已运行 `docker compose up -d`
- [ ] 浏览器能打开 `http://localhost:3000`，并在设置页保存骑手参数（与 AI 密钥）
- [ ] 上传一个 `.fit` 文件后，`output/` 出现对应的 CSV 与 JSON
