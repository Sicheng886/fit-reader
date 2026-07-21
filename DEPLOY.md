# fit-reader Docker 部署指南

把 fit-reader 打包成 Docker 镜像并部署为本地/服务器 Web 服务。

---

## 前置条件

- 已安装 Docker（建议 24.x 或更高）
- 已安装 Docker Compose（v2，即 `docker compose` 命令可用）
- 项目根目录已包含 `.env` 文件（见下文配置）

---

## 1. 配置环境变量

项目根目录有 `.env.example` 模板，先复制为正式 `.env`：

```bash
cp .env.example .env
```

然后编辑 `.env`，**至少设置 `FIT_AI_API_KEY`**，其余变量已带默认值。

### 1.1 必须设置：FIT_AI_API_KEY

`FIT_AI_API_KEY` 是调用 Moonshot AI（Kimi）生成报告的密钥。未设置时，Web 界面仍可使用，但「AI 分析」会退化为「复制提示词」模式，需要你手动把提示词贴到 AI 对话框。

**获取 Moonshot API Key 的步骤：**

1. 打开 [Moonshot 开放平台](https://platform.moonshot.cn/)，登录/注册账号。
2. 进入「API Key 管理」页面（通常在左侧菜单或顶部导航）。
3. 点击「创建 API Key」，给 Key 起个名字，例如 `fit-reader`。
4. 创建成功后，复制以 `sk-` 开头的字符串。
5. 打开项目根目录的 `.env` 文件，把复制的字符串填到 `FIT_AI_API_KEY=` 后面：

```ini
FIT_AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> ⚠️ 安全提示：API Key 等同于账号密码，不要把它提交到 git，不要分享到公开仓库。项目 `.gitignore` 已排除 `.env`。

### 1.2 其它环境变量（可选）

```ini
# AI 接口地址，默认 Kimi
FIT_AI_BASE_URL=https://api.moonshot.cn/v1

# 模型名，默认 kimi-k2.6
FIT_AI_MODEL=kimi-k2.6

# AI 请求超时，默认 10 分钟（复盘提示词较长，建议保持 600000）
FIT_AI_TIMEOUT_MS=600000

# Web 服务端口，默认 3000
PORT=3000
```

除 `FIT_AI_API_KEY` 外，其余变量在 `Dockerfile` 中已设置默认值，`.env` 里的值会覆盖默认值。

---

## 2. 构建镜像

在项目根目录执行：

```bash
docker build -t fit-reader:latest .
```

构建完成后，可用 `docker images | grep fit-reader` 查看镜像。

---

## 3. 启动容器（推荐：docker compose）

项目已提供 `docker-compose.yml`，最简启动方式：

```bash
# 确保 .env 已配置好
docker compose up -d
```

启动后访问：

```
http://localhost:3000
```

如果 `.env` 里修改了 `PORT`，请把 `docker-compose.yml` 里的端口映射或启动命令里的 `localhost:3000` 对应调整。

### 停止与重启

```bash
docker compose down          # 停止并删除容器
docker compose up -d         # 重新启动
docker compose logs -f       # 查看实时日志
docker compose pull          # 如果镜像已推送到仓库，先拉取最新
```

---

## 4. 纯 docker run 方式（不安装 docker compose 时使用）

```bash
docker run -d \
  --name fit-reader \
  -p 3000:3000 \
  --env-file .env \
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
  --env-file .env `
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
  --env-file .env \
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
| `/app/db` | **强烈建议** | SQLite 训练库，挂载后容器重建不会丢失历史数据 |
| `/app/settings.js` | 可选 | 自定义骑手参数（FTP、最大心率、分区阈值等） |

### 自定义骑手参数

把项目根目录的 `settings.js` 复制到宿主机，修改后挂载进容器：

```bash
cp settings.js my-settings.js
# 编辑 my-settings.js 里的 ATHLETE 等参数
docker run -d \
  --name fit-reader \
  -p 3000:3000 \
  --env-file .env \
  -v "$(pwd)/input:/input" \
  -v "$(pwd)/output:/output" \
  -v "$(pwd)/db:/app/db" \
  -v "$(pwd)/my-settings.js:/app/settings.js" \
  fit-reader:latest
```

或者在 `docker-compose.yml` 中取消 `- ./settings.js:/app/settings.js` 的注释。

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
   - 同时确保 `.env` 里的 `PORT=3000` 不变（容器内部端口仍是 3000）

### 8.2 输出文件权限是 root

容器默认以 root 运行。如需让输出文件归当前用户所有，可在 `docker run` 或 `docker compose` 中加 `-u $(id -u):$(id -g)`：

```bash
docker run -d \
  --name fit-reader \
  -u "$(id -u):$(id -g)" \
  -p 3000:3000 \
  --env-file .env \
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

- 增大 `FIT_AI_TIMEOUT_MS`（例如 1200000，即 20 分钟）。
- 检查 Moonshot 账户是否有足够余额。
- 查看模型是否可用：`curl -H "Authorization: Bearer $FIT_AI_API_KEY" https://api.moonshot.cn/v1/models`

### 8.4 我不想用 AI，只想看 Web 界面和指标

不设置 `FIT_AI_API_KEY` 即可。Web 界面除了 AI 报告按钮外全部可用，AI 报告会生成提示词供你复制到其它 AI 工具。

---

## 9. 检查清单

部署前确认：

- [ ] 已复制 `.env.example` 为 `.env` 并填入 `FIT_AI_API_KEY`
- [ ] 已创建/确认 `input/` 目录（用于放 `.fit` 文件）
- [ ] 已创建/确认 `output/` 目录（用于接收结果）
- [ ] 已运行 `docker build -t fit-reader:latest .` 且成功
- [ ] 已运行 `docker compose up -d`
- [ ] 浏览器能打开 `http://localhost:3000`
- [ ] 上传一个 `.fit` 文件后，`output/` 出现对应的 CSV 与 JSON
