/**
 * ai.js
 * AI API 客户端（P4）：把 prompts.js 拼好的提示词直接发给 OpenAI 兼容的
 * chat/completions 接口（Kimi / OpenAI / DeepSeek 等均适用），返回 Markdown 报告。
 *
 * 通过环境变量配置（无密钥时代码路径不会被触发，Web 界面会退化为"复制提示词"模式）：
 *   FIT_AI_API_KEY     API 密钥（必填，未设置则 isAiConfigured() = false）
 *   FIT_AI_BASE_URL    接口地址，默认 https://api.moonshot.cn/v1（Kimi）
 *   FIT_AI_MODEL       模型名，默认 moonshot-v1-32k
 *   FIT_AI_TEMPERATURE 采样温度（可选；缺省不传用 API 默认）
 *   FIT_AI_TIMEOUT_MS  总等待超时（毫秒），默认 300000（5 分钟）
 *   FIT_AI_STREAM      是否启用流式输出，默认 false
 *                      部分模型/账号会先把完整响应生成完毕再一次性下发，
 *                      看起来流式不吐字，这种情况建议用非流式（默认）+ 心跳日志
 *   FIT_AI_STALL_MS    流式时空闲超时（毫秒），默认 60000；每收到一个 chunk 重置
 *
 * 配置可写在项目根目录 .env 文件里（server.js 启动时通过 Node 内置
 * process.loadEnvFile() 自动注入，无需 dotenv 依赖）。
 *
 * 本模块无状态、无第三方依赖（Node ≥18 内置 fetch）。
 * 配置项在调用时惰性读取（.env 注入发生在 server.js 入口，晚于模块加载）。
 */

/** 是否已配置 API 密钥（未配置时前端展示提示词供手动复制） */
export function isAiConfigured() {
  return Boolean(process.env.FIT_AI_API_KEY);
}

/** 当前生效的接口/模型配置（供前端展示，不含密钥） */
export function aiConfigInfo() {
  return {
    base_url: process.env.FIT_AI_BASE_URL || "https://api.moonshot.cn/v1",
    model: process.env.FIT_AI_MODEL || "moonshot-v1-32k",
    configured: isAiConfigured(),
  };
}

function parseTimeout(name, defaultMs) {
  const raw = process.env[name];
  if (!raw) return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/** 解析 SSE 流，逐个 chunk 回调并拼接完整文本 */
async function readStream(resp, onChunk) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        if (obj.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onChunk?.(delta);
        }
      } catch (e) {
        if (/^\s*\[DONE\]\s*$/.test(data)) continue;
        throw e;
      }
    }
  }
  return fullText;
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
  const key = process.env.FIT_AI_API_KEY;
  if (!key) throw new Error("未配置 FIT_AI_API_KEY 环境变量，无法调用 AI API");
  const { base_url, model } = aiConfigInfo();
  const effectiveTimeoutMs = timeoutMs ?? parseTimeout("FIT_AI_TIMEOUT_MS", 300000);
  const useStream = process.env.FIT_AI_STREAM === "true" || process.env.FIT_AI_STREAM === "1";

  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: "user", content: promptOrMessages }];
  const request = {
    model,
    messages,
    stream: useStream,
  };
  if (process.env.FIT_AI_TEMPERATURE != null)
    request.temperature = Number(process.env.FIT_AI_TEMPERATURE);

  const ctrl = new AbortController();
  const totalTimer = setTimeout(
    () => ctrl.abort(new Error("total timeout")),
    effectiveTimeoutMs,
  );
  // 无论流式/非流式，都每 30 秒回调一次心跳，给调用方一个"还在等"的反馈
  const heartbeat = setInterval(() => onHeartbeat?.(), 30000);

  try {
    const resp = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(request),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`AI API 返回 ${resp.status}: ${body.slice(0, 300)}`);
    }

    if (useStream) {
      const stallMs = parseTimeout("FIT_AI_STALL_MS", 60000);
      let stallTimer = setTimeout(
        () => ctrl.abort(new Error("stall timeout")),
        stallMs,
      );
      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () => ctrl.abort(new Error("stall timeout")),
          stallMs,
        );
      };
      try {
        const fullText = await readStream(resp, (delta) => {
          resetStall();
          onChunk?.(delta);
        });
        if (!fullText) throw new Error("AI API 流返回为空");
        return fullText;
      } finally {
        clearTimeout(stallTimer);
      }
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("AI API 返回为空");
    return text;
  } catch (e) {
    const reason = ctrl.signal.reason?.message || e.message || "";
    if (reason === "stall timeout") {
      throw new Error(
        `AI 流已空闲超过 ${parseTimeout("FIT_AI_STALL_MS", 60000) / 1000} 秒未收到数据。` +
          `可能是该模型/账号不真正流式输出，建议关闭流式：在 .env 里不写 FIT_AI_STREAM，或设为 false。`,
      );
    }
    if (reason === "total timeout" || e.name === "AbortError" || /aborted|timeout/i.test(reason)) {
      throw new Error(
        `AI 请求总时间超过 ${effectiveTimeoutMs / 1000} 秒。` +
          `若模型确实需要更久，可增大 FIT_AI_TIMEOUT_MS；` +
          `否则建议检查网络/API 可用性。`,
      );
    }
    throw e;
  } finally {
    clearTimeout(totalTimer);
    clearInterval(heartbeat);
  }
}
