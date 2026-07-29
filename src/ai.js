/**
 * ai.js
 * AI API 客户端（P4）：把 prompts.js 拼好的提示词直接发给 OpenAI 兼容的
 * chat/completions 接口（Kimi / OpenAI / DeepSeek 等均适用），返回 Markdown 报告。
 *
 * 配置唯一事实来源是训练库 settings 表的 ai 行（Web 设置页维护），
 * 由 db.js 的 syncAiConfigFromDb() 原地合并进 settings.js 的 AI_CONFIG 导出对象；
 * 库中无配置时用 AI_CONFIG 出厂默认值（默认 Kimi，api_key 为空 → 退化为
 * "复制提示词"模式）。本模块不再读取任何环境变量。
 *
 * 超时完全由本模块基于 node:http(s) 自行管理（AI_CONFIG.timeout_ms / stall_ms）——
 * 旧实现用全局 fetch 时，undici 内置 300s body/headers 超时会把长报告生成静默掐断，
 * 表现为"AI 后台分析失败: fetch failed"。
 *
 * 本模块无状态（配置经 AI_CONFIG 注入）、无第三方依赖（node:http / node:https）。
 */

import http from "node:http";
import https from "node:https";
import { AI_CONFIG, AGENTIC } from "./settings.js";

/** 是否已配置 API 密钥（未配置时前端展示提示词供手动复制） */
export function isAiConfigured() {
  return Boolean(AI_CONFIG.api_key);
}

/** 当前生效的接口/模型配置（供前端展示，不含密钥） */
export function aiConfigInfo() {
  return {
    base_url: AI_CONFIG.base_url,
    model: AI_CONFIG.model,
    configured: isAiConfigured(),
  };
}

/**
 * 发起一次 chat/completions 请求（node:http/https，超时完全由调用方通过 signal 控制，
 * 不受内置 fetch/undici 的 300 秒 body/headers 默认超时限制）。
 * 非流式 resolve 完整 message 对象（{content, tool_calls?}）；
 * 流式逐 chunk 回调 onStreamChunk 后 resolve 拼接的完整文本。
 */
function requestChatCompletion(baseUrl, apiKey, requestBody, { signal, onStreamChunk }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    const done = (text) => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };

    const url = new URL(`${baseUrl}/chat/completions`);
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal,
      },
      (res) => {
        res.setEncoding("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = "";
          res.on("data", (c) => {
            if (body.length < 2000) body += c;
          });
          res.on("end", () =>
            fail(new Error(`AI API 返回 ${res.statusCode}: ${body.slice(0, 300)}`)),
          );
          return;
        }

        if (!onStreamChunk) {
          // 非流式：一次性收取完整 JSON 响应，resolve 完整 message 对象
          // （含 content 与可选的 tool_calls，供 runAgentLoop 的 function calling 使用）
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            let msg;
            try {
              msg = JSON.parse(body).choices?.[0]?.message;
            } catch (e) {
              return fail(new Error(`AI API 响应解析失败: ${e.message}`));
            }
            if (!msg || (msg.content == null && !msg.tool_calls?.length))
              return fail(new Error("AI API 返回为空"));
            done(msg);
          });
          return;
        }

        // 流式：SSE 逐行解析，delta 回调并拼接
        let buffer = "";
        let fullText = "";
        res.on("data", (chunk) => {
          if (settled) return;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith("data:")) continue;
            const data = s.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data);
              if (obj.error)
                return fail(new Error(obj.error.message || JSON.stringify(obj.error)));
              const delta = obj.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                onStreamChunk(delta);
              }
            } catch (e) {
              return fail(e);
            }
          }
        });
        res.on("end", () => {
          if (settled) return;
          if (!fullText) return fail(new Error("AI API 流返回为空"));
          done(fullText);
        });
      },
    );
    req.on("error", fail);
    req.end(JSON.stringify(requestBody));
  });
}

/**
 * 调用 chat/completions，返回完整文本。
 * 默认非流式：长提示词在部分 API 上会被整体生成后再下发，
 * 此时流式不会吐字，非流式 + 心跳日志更稳。
 *
 * 支持两种调用方式：
 * 1. 传入单条字符串 prompt，作为单条 user 消息发送。
 * 2. 传入 messages 数组，直接作为 chat/completions 的 messages 参数（用于追问多轮对话）。
 *
 * @param {string|Array<{role:string, content:string}>} promptOrMessages 单条提示词或多轮消息数组
 * @param {{ onChunk?: (delta: string) => void, onHeartbeat?: () => void, timeoutMs?: number }} opts
 */
export async function callAI(
  promptOrMessages,
  { onChunk, onHeartbeat, timeoutMs } = {},
) {
  const key = AI_CONFIG.api_key;
  if (!key) throw new Error("未配置 AI 密钥（Web 设置页可配），无法调用 AI API");
  const { base_url, model } = aiConfigInfo();
  const effectiveTimeoutMs = timeoutMs ?? AI_CONFIG.timeout_ms;
  const useStream = AI_CONFIG.stream;

  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: "user", content: promptOrMessages }];
  const request = {
    model,
    messages,
    stream: useStream,
  };
  if (AI_CONFIG.temperature != null)
    request.temperature = Number(AI_CONFIG.temperature);

  const ctrl = new AbortController();
  const totalTimer = setTimeout(
    () => ctrl.abort(new Error("total timeout")),
    effectiveTimeoutMs,
  );
  // 无论流式/非流式，都每 30 秒回调一次心跳，给调用方一个"还在等"的反馈
  const heartbeat = setInterval(() => onHeartbeat?.(), 30000);
  // 流式空闲超时：每收到一个内容 chunk 重置
  const stallMs = AI_CONFIG.stall_ms;
  let stallTimer = null;
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new Error("stall timeout")), stallMs);
  };

  try {
    const result = await requestChatCompletion(base_url, key, request, {
      signal: ctrl.signal,
      onStreamChunk: useStream
        ? (delta) => {
            resetStall();
            onChunk?.(delta);
          }
        : null,
    });
    // 非流式 resolve 的是完整 message 对象，此处只取正文（callAI 不挂 tools）
    if (useStream) return result;
    if (!result.content) throw new Error("AI API 返回为空");
    return result.content;
  } catch (e) {
    const reason = ctrl.signal.reason?.message || e.message || "";
    if (reason === "stall timeout") {
      throw new Error(
        `AI 流已空闲超过 ${stallMs / 1000} 秒未收到数据。` +
          `可能是该模型/账号不真正流式输出，建议在设置页关闭流式。`,
      );
    }
    if (reason === "total timeout" || e.name === "AbortError" || /aborted|timeout/i.test(reason)) {
      throw new Error(
        `AI 请求总时间超过 ${effectiveTimeoutMs / 1000} 秒。` +
          `若模型确实需要更久，可在设置页增大超时时间；` +
          `否则建议检查网络/API 可用性。`,
      );
    }
    throw e;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(stallTimer);
    clearInterval(heartbeat);
  }
}

/**
 * Agentic 多轮调用（function calling）：循环 ≤ AGENTIC.max_rounds 轮，
 * 模型返回 tool_calls 时逐个经 executeTool 执行并把结果以 role:"tool" 消息回填，
 * 直到模型返回普通正文。轮数耗尽后去掉 tools 强制模型直接作答。
 *
 * 设计要点：
 * - 全部轮次走非流式（tool_calls 与 SSE 增量解析组合复杂、用户看不到中间轮）；
 *   AI_CONFIG.stream 只影响 callAI 的降级单轮路径。
 * - 整个循环共享一个总超时预算（AI_CONFIG.timeout_ms，不逐轮重置）+ 30 秒心跳。
 * - 模型/代理不支持 tools（带 tools 的首轮请求 HTTP 400）→ 自动降级为无 tools
 *   单轮调用并经 onDegrade 回调告知调用方；AI_CONFIG.agentic === false 时直接不挂 tools。
 * - executeTool 抛出的异常被兜底为 {error} JSON 回填，循环不中断。
 * - 依赖注入：本函数不 import db.js / tools.js，tools 定义与 executeTool 均由调用方传入。
 *
 * @param {Array<{role:string, content:string}>} messages 初始消息数组
 * @param {Array<object>} tools OpenAI tools JSON schema 数组
 * @param {(name: string, args: object) => Promise<string>|string} executeTool 工具执行器，返回 JSON 字符串
 * @param {{ onHeartbeat?: () => void, onToolCall?: (name, args, result) => void, onDegrade?: (errMsg: string) => void, timeoutMs?: number }} opts
 * @returns {Promise<string>} 模型最终正文
 */
export async function runAgentLoop(
  messages,
  tools,
  executeTool,
  { onHeartbeat, onToolCall, onDegrade, timeoutMs } = {},
) {
  const key = AI_CONFIG.api_key;
  if (!key) throw new Error("未配置 AI 密钥（Web 设置页可配），无法调用 AI API");
  const { base_url, model } = aiConfigInfo();
  const effectiveTimeoutMs = timeoutMs ?? AI_CONFIG.timeout_ms;
  const maxRounds = AGENTIC.max_rounds;
  const useTools = AI_CONFIG.agentic !== false && Array.isArray(tools) && tools.length > 0;

  const ctrl = new AbortController();
  const totalTimer = setTimeout(
    () => ctrl.abort(new Error("total timeout")),
    effectiveTimeoutMs,
  );
  // 每 30 秒回调一次心跳，给调用方一个"还在等"的反馈
  const heartbeat = setInterval(() => onHeartbeat?.(), 30000);

  const buildRequest = (msgs, toolDefs) => {
    const req = { model, messages: msgs, stream: false };
    if (AI_CONFIG.temperature != null)
      req.temperature = Number(AI_CONFIG.temperature);
    if (toolDefs?.length) {
      req.tools = toolDefs;
      req.tool_choice = "auto";
    }
    return req;
  };
  const callOnce = (msgs, toolDefs) =>
    requestChatCompletion(base_url, key, buildRequest(msgs, toolDefs), {
      signal: ctrl.signal,
    });

  try {
    const history = [...messages];
    let toolsActive = useTools;
    for (let round = 0; round < maxRounds; round++) {
      let msg;
      try {
        msg = await callOnce(history, toolsActive ? tools : null);
      } catch (e) {
        // 带 tools 的首轮请求被 400 拒绝 → 模型/代理不支持 tools，降级单轮
        if (toolsActive && round === 0 && /返回 400/.test(e.message)) {
          onDegrade?.(e.message);
          toolsActive = false;
          msg = await callOnce(history, null);
        } else {
          throw e;
        }
      }
      const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      if (!toolCalls.length) {
        if (msg?.content) return msg.content;
        throw new Error("AI API 返回为空");
      }
      // assistant 消息原样回填（含 tool_calls），再逐个执行并回填 tool 结果
      history.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? "";
        let args = {};
        try {
          args = JSON.parse(tc?.function?.arguments || "{}");
        } catch {
          // arguments 不是合法 JSON 时按空参数处理，由工具侧校验报错
        }
        let result;
        try {
          result = await executeTool(name, args);
        } catch (e) {
          result = JSON.stringify({ error: `工具执行失败: ${e.message}` });
        }
        onToolCall?.(name, args, result);
        history.push({
          role: "tool",
          tool_call_id: tc.id,
          content: String(result),
        });
      }
    }
    // 轮数耗尽：去掉 tools 强制模型基于已获得的信息直接作答
    history.push({
      role: "user",
      content: "工具调用次数已用完，请基于已获得的信息直接作答。",
    });
    const finalMsg = await callOnce(history, null);
    if (finalMsg?.content) return finalMsg.content;
    throw new Error("AI API 返回为空");
  } catch (e) {
    const reason = ctrl.signal.reason?.message || e.message || "";
    if (
      reason === "total timeout" ||
      e.name === "AbortError" ||
      /aborted|timeout/i.test(reason)
    ) {
      throw new Error(
        `AI 请求总时间超过 ${effectiveTimeoutMs / 1000} 秒。` +
          `若模型确实需要更久，可在设置页增大超时时间；` +
          `否则建议检查网络/API 可用性。`,
      );
    }
    throw e;
  } finally {
    clearTimeout(totalTimer);
    clearInterval(heartbeat);
  }
}
