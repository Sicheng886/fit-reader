/**
 * ai.test.mjs
 * src/ai.js 的 HTTP 请求层回归测试（node:test + 本地 mock chat/completions 服务）。
 *
 * 背景：旧实现用全局 fetch（undici），其内置 300 秒 body/headers 超时会静默掐断
 * 长报告生成（服务端日志表现为 "AI 后台分析失败: fetch failed"）。改用
 * node:http(s) 后超时完全由 FIT_AI_TIMEOUT_MS / timeoutMs 控制，这里用慢响应、
 * 总超时、流式、错误状态四个场景守住该行为。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callAI, isAiConfigured } from "../src/ai.js";

/** 启动一个 mock chat/completions 服务，handler 接收解析后的请求体 */
function startMockServer(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(JSON.parse(body), res));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 设置 AI 环境变量指向 mock 服务，返回清理函数 */
function useMockEnv(port, extra = {}) {
  const saved = {
    FIT_AI_API_KEY: process.env.FIT_AI_API_KEY,
    FIT_AI_BASE_URL: process.env.FIT_AI_BASE_URL,
    FIT_AI_STREAM: process.env.FIT_AI_STREAM,
  };
  process.env.FIT_AI_API_KEY = "test-key";
  process.env.FIT_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  delete process.env.FIT_AI_STREAM;
  Object.assign(process.env, extra);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("callAI: 非流式慢响应正常返回（无内置 300s 级隐藏超时）", async () => {
  const { server, port } = await startMockServer(async (_req, res) => {
    await sleep(1200); // 模拟模型长生成；旧 undici 实现最终会在 300s 被掐断
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "复盘报告正文" } }] }));
  });
  const restore = useMockEnv(port);
  try {
    const text = await callAI("提示词", { timeoutMs: 10000 });
    assert.equal(text, "复盘报告正文");
  } finally {
    restore();
    server.close();
  }
});

test("callAI: 超过 timeoutMs 总时限报超时错误", async () => {
  const { server, port } = await startMockServer((_req, res) => {
    res.on("close", () => res.destroy()); // 永不响应，等客户端超时断开
  });
  const restore = useMockEnv(port);
  try {
    await assert.rejects(callAI("提示词", { timeoutMs: 300 }), /总时间超过/);
  } finally {
    restore();
    server.close();
  }
});

test("callAI: 流式 SSE 逐 chunk 拼接", async () => {
  const { server, port } = await startMockServer(async (reqBody, res) => {
    assert.equal(reqBody.stream, true);
    res.setHeader("Content-Type", "text/event-stream");
    const chunks = ["你好", "，世界"];
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      await sleep(50);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const restore = useMockEnv(port, { FIT_AI_STREAM: "true" });
  try {
    const deltas = [];
    const text = await callAI("提示词", { timeoutMs: 5000, onChunk: (d) => deltas.push(d) });
    assert.equal(text, "你好，世界");
    assert.deepEqual(deltas, ["你好", "，世界"]);
  } finally {
    restore();
    server.close();
  }
});

test("callAI: HTTP 错误状态透出状态码", async () => {
  const { server, port } = await startMockServer((_req, res) => {
    res.statusCode = 429;
    res.end("rate limited");
  });
  const restore = useMockEnv(port);
  try {
    await assert.rejects(callAI("提示词", { timeoutMs: 5000 }), /429/);
  } finally {
    restore();
    server.close();
  }
});

test("isAiConfigured: 未配置密钥时为 false", () => {
  const saved = process.env.FIT_AI_API_KEY;
  delete process.env.FIT_AI_API_KEY;
  try {
    assert.equal(isAiConfigured(), false);
  } finally {
    if (saved !== undefined) process.env.FIT_AI_API_KEY = saved;
  }
});
