FROM node:22-slim

WORKDIR /app

# 非密钥环境变量默认值：AI 服务用 Kimi，Web 服务用 3000 端口
ENV NODE_ENV=production \
    FIT_AI_BASE_URL=https://api.moonshot.cn/v1 \
    FIT_AI_MODEL=kimi-k2.6 \
    FIT_AI_TIMEOUT_MS=600000 \
    FIT_INPUT_DIR=/input \
    FIT_OUTPUT_DIR=/output \
    FIT_DB_PATH=/app/db/fitness.db \
    PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "run", "web"]
