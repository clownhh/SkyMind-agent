const { setTimeout: delay } = require("node:timers/promises");

const toText = value => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(part => part == null ? "" : typeof part === "string" ? part : part.text ?? JSON.stringify(part)).join("");
  }
  return String(value);
};

// The timeout covers both response headers and the complete response body.
const createChatClient = ({ baseUrl, apiKey, model, toolDefinition,
  timeoutMs = 300_000, retryDelayMs = 1000 }) => {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (messages, { useTools = true, signal = null } = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal?.aborted) throw new Error("任务已中断");
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(onAbort, timeoutMs);
      try {
        const body = { model, messages };
        if (useTools) {
          body.tool_choice = "auto";
          body.tools = [toolDefinition];
        }
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const error = new Error(`API 请求失败 (HTTP ${response.status}): ${text.slice(0, 500)}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        const data = JSON.parse(text);
        const message = data.choices?.[0]?.message;
        if (!message || (message.tool_calls != null && !Array.isArray(message.tool_calls))) {
          throw new Error(`API 响应异常，缺少有效 message: ${text.slice(0, 500)}`);
        }
        return { role: "assistant", content: toText(message.content), tool_calls: message.tool_calls ?? [] };
      } catch (error) {
        if (signal?.aborted) throw new Error("任务已中断");
        lastError = controller.signal.aborted
          ? new Error(`请求超时（${timeoutMs / 1000} 秒）`)
          : error;
        if (error.retryable === false) throw lastError;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      if (attempt < 3) {
        try {
          await delay(retryDelayMs * attempt, undefined, { signal: signal ?? undefined });
        } catch (error) {
          if (signal?.aborted) throw new Error("任务已中断");
          throw error;
        }
      }
    }
    throw lastError;
  };
};

module.exports = { createChatClient };
