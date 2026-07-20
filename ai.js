/**
 * ai.js
 * AI API 客户端（P4）：把 prompts.js 拼好的提示词直接发给 OpenAI 兼容的
 * chat/completions 接口（Kimi / OpenAI / DeepSeek 等均适用），返回 Markdown 报告。
 *
 * 通过环境变量配置（无密钥时代码路径不会被触发，Web 界面会退化为"复制提示词"模式）：
 *   FIT_AI_API_KEY  API 密钥（必填，未设置则 isAiConfigured() = false）
 *   FIT_AI_BASE_URL 接口地址，默认 https://api.moonshot.cn/v1（Kimi）
 *   FIT_AI_MODEL    模型名，默认 moonshot-v1-32k（复盘提示词较长，8k 上下文可能不够）
 *
 * 本模块只做一次 POST，无状态、无第三方依赖（Node ≥18 内置 fetch）。
 */

const BASE_URL = process.env.FIT_AI_BASE_URL || "https://api.moonshot.cn/v1";
const MODEL = process.env.FIT_AI_MODEL || "moonshot-v1-32k";

/** 是否已配置 API 密钥（未配置时前端展示提示词供手动复制） */
export function isAiConfigured() {
  return Boolean(process.env.FIT_AI_API_KEY);
}

/** 当前生效的接口/模型配置（供前端展示，不含密钥） */
export function aiConfigInfo() {
  return { base_url: BASE_URL, model: MODEL, configured: isAiConfigured() };
}

/**
 * 调用 chat/completions，返回助手回复文本。
 * @param {string} prompt 完整提示词（prompts.js 产物）
 * @param {{ timeoutMs?: number }} opts
 */
export async function callAI(prompt, { timeoutMs = 120000 } = {}) {
  const key = process.env.FIT_AI_API_KEY;
  if (!key) throw new Error("未配置 FIT_AI_API_KEY 环境变量，无法调用 AI API");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
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
  } finally {
    clearTimeout(timer);
  }
}
