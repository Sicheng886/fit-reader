/**
 * ai.js
 * AI API 客户端（P4）：把 prompts.js 拼好的提示词直接发给 OpenAI 兼容的
 * chat/completions 接口（Kimi / OpenAI / DeepSeek 等均适用），返回 Markdown 报告。
 *
 * 通过环境变量配置（无密钥时代码路径不会被触发，Web 界面会退化为"复制提示词"模式）：
 *   FIT_AI_API_KEY     API 密钥（必填，未设置则 isAiConfigured() = false）
 *   FIT_AI_BASE_URL    接口地址，默认 https://api.moonshot.cn/v1（Kimi）
 *   FIT_AI_MODEL       模型名，默认 moonshot-v1-32k（复盘提示词较长，8k 上下文可能不够）
 *   FIT_AI_TEMPERATURE 采样温度（可选；缺省不传用 API 默认，部分模型只允许特定取值）
 *   FIT_AI_TIMEOUT_MS  请求超时（毫秒），默认 300000（5 分钟）；复盘提示词较长，建议留足时间
 * 配置可写在项目根目录 .env 文件里（server.js 启动时通过 Node 内置
 * process.loadEnvFile() 自动注入，无需 dotenv 依赖）。
 *
 * 本模块只做一次 POST，无状态、无第三方依赖（Node ≥18 内置 fetch）。
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

/**
 * 调用 chat/completions，返回助手回复文本。
 * @param {string} prompt 完整提示词（prompts.js 产物）
 * @param {{ timeoutMs?: number }} opts
 */
export async function callAI(prompt, { timeoutMs } = {}) {
  const key = process.env.FIT_AI_API_KEY;
  if (!key) throw new Error("未配置 FIT_AI_API_KEY 环境变量，无法调用 AI API");
  const { base_url, model } = aiConfigInfo();
  const envTimeout = process.env.FIT_AI_TIMEOUT_MS;
  let effectiveTimeoutMs = timeoutMs ?? (envTimeout ? Number(envTimeout) : 300000);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) effectiveTimeoutMs = 300000;

  // temperature 缺省不传（用 API 默认）：部分模型（如 kimi-k2.x）只允许特定取值，
  // 需要调参时通过 FIT_AI_TEMPERATURE 显式指定
  const request = { model, messages: [{ role: "user", content: prompt }] };
  if (process.env.FIT_AI_TEMPERATURE != null)
    request.temperature = Number(process.env.FIT_AI_TEMPERATURE);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), effectiveTimeoutMs);
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
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("AI API 返回为空");
    return text;
  } catch (e) {
    // 把 AbortError 变成更明确的超时提示
    if (ctrl.signal.aborted || e.name === "AbortError" || /aborted|timeout/i.test(e.message)) {
      throw new Error(
        `AI 请求超时（${effectiveTimeoutMs / 1000} 秒未收到响应）。` +
          `复盘提示词很长，建议把 FIT_AI_TIMEOUT_MS 调大（如 600000，.env 里写 FIT_AI_TIMEOUT_MS=600000），` +
          `或检查网络/API 可用性。`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
