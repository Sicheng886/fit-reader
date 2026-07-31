/**
 * ai.test.mjs
 * src/ai.js 的 HTTP 请求层回归测试（node:test + 本地 mock chat/completions 服务）。
 *
 * 背景：旧实现用全局 fetch（undici），其内置 300 秒 body/headers 超时会静默掐断
 * 长报告生成（服务端日志表现为 "AI 后台分析失败: fetch failed"）。改用
 * node:http(s) 后超时完全由 AI_CONFIG.timeout_ms / timeoutMs 控制，这里用慢响应、
 * 总超时、流式、错误状态四个场景守住该行为。
 *
 * AI 配置存训练库（settings 表 ai 行），运行时读 settings.js 的 AI_CONFIG 导出
 * 对象；测试直接原地修改 AI_CONFIG 指向 mock 服务，用例间恢复。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callAI, runAgentLoop, isAiConfigured } from "../src/ai.js";
import { AI_CONFIG, AGENTIC } from "../src/settings.js";

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

/** 把 AI_CONFIG 指向 mock 服务，返回清理函数（恢复修改前的值） */
function useMockConfig(port, extra = {}) {
  const saved = { ...AI_CONFIG };
  Object.assign(AI_CONFIG, {
    api_key: "test-key",
    base_url: `http://127.0.0.1:${port}/v1`,
    stream: false,
  }, extra);
  return () => Object.assign(AI_CONFIG, saved);
}

test("callAI: 非流式慢响应正常返回（无内置 300s 级隐藏超时）", async () => {
  const { server, port } = await startMockServer(async (_req, res) => {
    await sleep(1200); // 模拟模型长生成；旧 undici 实现最终会在 300s 被掐断
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "复盘报告正文" } }] }));
  });
  const restore = useMockConfig(port);
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
  const restore = useMockConfig(port);
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
  const restore = useMockConfig(port, { stream: true });
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
  const restore = useMockConfig(port);
  try {
    await assert.rejects(callAI("提示词", { timeoutMs: 5000 }), /429/);
  } finally {
    restore();
    server.close();
  }
});

test("isAiConfigured: 未配置密钥时为 false", () => {
  const saved = AI_CONFIG.api_key;
  AI_CONFIG.api_key = null;
  try {
    assert.equal(isAiConfigured(), false);
  } finally {
    AI_CONFIG.api_key = saved;
  }
});

// ---------------- runAgentLoop（agentic function calling） ----------------

const FAKE_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_form_series",
      description: "取逐日状态",
      parameters: { type: "object", properties: {} },
    },
  },
];

const toolCallMsg = (name, args, id = "call_1") => ({
  content: null,
  tool_calls: [
    { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});

const contentMsg = (text) => ({ content: text });

test("runAgentLoop: 首轮 tool_calls → 执行回填 → 次轮返回正文", async () => {
  const seenBodies = [];
  const { server, port } = await startMockServer((reqBody, res) => {
    seenBodies.push(reqBody);
    res.setHeader("Content-Type", "application/json");
    const msg =
      seenBodies.length === 1
        ? toolCallMsg("get_form_series", { days: 14 })
        : contentMsg("最终回答");
    res.end(JSON.stringify({ choices: [{ message: msg }] }));
  });
  const restore = useMockConfig(port);
  try {
    const executed = [];
    const logged = [];
    const text = await runAgentLoop(
      [{ role: "user", content: "这周状态如何？" }],
      FAKE_TOOLS,
      async (name, args) => {
        executed.push([name, args]);
        return JSON.stringify({ series: [1, 2, 3] });
      },
      { timeoutMs: 5000, onToolCall: (n, a, r) => logged.push([n, a, r]) },
    );
    assert.equal(text, "最终回答");
    // 首轮请求带 tools 定义与 tool_choice
    assert.deepEqual(seenBodies[0].tools, FAKE_TOOLS);
    assert.equal(seenBodies[0].tool_choice, "auto");
    assert.equal(seenBodies[0].stream, false); // agentic 循环内全部非流式
    // executeTool 收到解析后的参数，onToolCall 拿到结果
    assert.deepEqual(executed, [["get_form_series", { days: 14 }]]);
    assert.equal(logged.length, 1);
    // 次轮请求：assistant（含 tool_calls）+ role:"tool" 结果回填
    const msgs = seenBodies[1].messages;
    assert.equal(msgs.at(-2).role, "assistant");
    assert.equal(msgs.at(-2).tool_calls[0].function.name, "get_form_series");
    assert.equal(msgs.at(-1).role, "tool");
    assert.equal(msgs.at(-1).tool_call_id, "call_1");
    assert.equal(msgs.at(-1).content, JSON.stringify({ series: [1, 2, 3] }));
  } finally {
    restore();
    server.close();
  }
});

test("runAgentLoop: 中间轮写了长报告、末轮只剩收尾片段时返回最长正文", async () => {
  // 复现线上问题：模型把完整报告写在带 tool_calls 的中间轮，
  // 最后一轮只回"分析已完成，如需……"式片段——应以最长正文为准
  const longReport = "# 训练复盘报告\n\n" + "详细分析内容。".repeat(50);
  const wrapUp = "以上分析已完成。如需进一步帮助请告诉我。";
  let callCount = 0;
  const { server, port } = await startMockServer((_reqBody, res) => {
    callCount++;
    res.setHeader("Content-Type", "application/json");
    let msg;
    if (callCount === 1) msg = toolCallMsg("get_form_series", { days: 14 });
    else if (callCount === 2)
      msg = {
        content: longReport, // 长报告与 tool_calls 同轮出现
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "get_form_series", arguments: "{}" },
          },
        ],
      };
    else msg = contentMsg(wrapUp);
    res.end(JSON.stringify({ choices: [{ message: msg }] }));
  });
  const restore = useMockConfig(port);
  try {
    const text = await runAgentLoop(
      [{ role: "user", content: "复盘" }],
      FAKE_TOOLS,
      async () => "{}",
      { timeoutMs: 5000 },
    );
    assert.equal(text, longReport);
    assert.equal(callCount, 3);
  } finally {
    restore();
    server.close();
  }
});

test("runAgentLoop: 轮数耗尽后去掉 tools 强制直接作答", async () => {
  const seenBodies = [];
  const { server, port } = await startMockServer((reqBody, res) => {
    seenBodies.push(reqBody);
    res.setHeader("Content-Type", "application/json");
    const hasTools = Array.isArray(reqBody.tools);
    const msg = hasTools
      ? toolCallMsg("get_form_series", {}, `call_${seenBodies.length}`)
      : contentMsg("被迫作答");
    res.end(JSON.stringify({ choices: [{ message: msg }] }));
  });
  const restore = useMockConfig(port);
  try {
    let execCount = 0;
    const text = await runAgentLoop(
      [{ role: "user", content: "问" }],
      FAKE_TOOLS,
      async () => {
        execCount++;
        return "{}";
      },
      { timeoutMs: 10000 },
    );
    assert.equal(text, "被迫作答");
    assert.equal(execCount, AGENTIC.max_rounds); // 每轮一次工具调用
    // 共 max_rounds 轮带 tools + 最后一轮不带 tools
    assert.equal(seenBodies.length, AGENTIC.max_rounds + 1);
    const last = seenBodies.at(-1);
    assert.equal(last.tools, undefined);
    assert.match(last.messages.at(-1).content, /直接作答/);
  } finally {
    restore();
    server.close();
  }
});

test("runAgentLoop: 模型不支持 tools（首轮 400）自动降级单轮", async () => {
  const seenBodies = [];
  const { server, port } = await startMockServer((reqBody, res) => {
    seenBodies.push(reqBody);
    if (Array.isArray(reqBody.tools)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "tools not supported" } }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: contentMsg("降级回答") }] }));
  });
  const restore = useMockConfig(port);
  try {
    let degraded = null;
    const text = await runAgentLoop(
      [{ role: "user", content: "问" }],
      FAKE_TOOLS,
      async () => "{}",
      { timeoutMs: 5000, onDegrade: (msg) => (degraded = msg) },
    );
    assert.equal(text, "降级回答");
    assert.match(degraded, /400/);
    assert.equal(seenBodies.length, 2); // 带 tools 失败一次 + 无 tools 重发一次
  } finally {
    restore();
    server.close();
  }
});

test("runAgentLoop: AI_CONFIG.agentic=false 时不挂 tools 直接单轮", async () => {
  const seenBodies = [];
  const { server, port } = await startMockServer((reqBody, res) => {
    seenBodies.push(reqBody);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: contentMsg("单轮回答") }] }));
  });
  const restore = useMockConfig(port, { agentic: false });
  try {
    const text = await runAgentLoop(
      [{ role: "user", content: "问" }],
      FAKE_TOOLS,
      async () => "{}",
      { timeoutMs: 5000 },
    );
    assert.equal(text, "单轮回答");
    assert.equal(seenBodies.length, 1);
    assert.equal(seenBodies[0].tools, undefined);
  } finally {
    restore();
    server.close();
  }
});

test("runAgentLoop: executeTool 抛异常转为 {error} 回填，循环不中断", async () => {
  const seenBodies = [];
  const { server, port } = await startMockServer((reqBody, res) => {
    seenBodies.push(reqBody);
    res.setHeader("Content-Type", "application/json");
    const msg =
      seenBodies.length === 1
        ? toolCallMsg("get_form_series", {})
        : contentMsg("带错作答");
    res.end(JSON.stringify({ choices: [{ message: msg }] }));
  });
  const restore = useMockConfig(port);
  try {
    const text = await runAgentLoop(
      [{ role: "user", content: "问" }],
      FAKE_TOOLS,
      async () => {
        throw new Error("db 炸了");
      },
      { timeoutMs: 5000 },
    );
    assert.equal(text, "带错作答");
    const toolMsg = seenBodies[1].messages.at(-1);
    assert.equal(toolMsg.role, "tool");
    assert.match(toolMsg.content, /"error"/);
    assert.match(toolMsg.content, /db 炸了/);
  } finally {
    restore();
    server.close();
  }
});
