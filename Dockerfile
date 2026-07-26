ARG NODE_IMAGE=docker.io/library/node:22-slim
FROM ${NODE_IMAGE}

WORKDIR /app

# 非密钥环境变量默认值：输入/输出/训练库路径与 Web 服务端口
# （AI 密钥等用户配置在 Web 设置页维护，存训练库，不走环境变量）
ENV NODE_ENV=production \
    FIT_INPUT_DIR=/input \
    FIT_OUTPUT_DIR=/output \
    FIT_DB_PATH=/app/db/fitness.db \
    PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "run", "web"]
