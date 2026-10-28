// 网关冒烟测试：对线上部署的网关做端到端验证。
//
// 用法（Node >= 18 或 Bun 均可，无第三方依赖）：
//   node scripts/smoke-gateway.js
//   bun scripts/smoke-gateway.js
//   bun scripts/smoke-gateway.js minimax glm   # 只测指定的 provider
//
// 环境变量：
//   GATEWAY_BASE    网关地址，默认 https://max.gitcafe.ink
//   MINIMAX_KEY / GLM_KEY / DEEPSEEK_KEY / BYTEDANCE_KEY   各厂商 API Key
//   MINIMAX_MODEL / GLM_MODEL / DEEPSEEK_MODEL / BYTEDANCE_MODEL  模型覆盖
//   SKIP_RESPONSES=1   跳过 Responses API 测试
//
// 注意：本机会话若设置了 HTTP(S)_PROXY，请把网关域名加入 NO_PROXY，
// 否则请求会被本地代理拦截（详见 README 故障排查）。

const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(
  /\/+$/,
  "",
);
const TIMEOUT_MS = 120000;
const SKIP_RESPONSES = process.env.SKIP_RESPONSES === "1";

// provider 配置：envKey 是存放 API Key 的环境变量名，
// model 是默认测试模型（可被 {PROVIDER}_MODEL 环境变量覆盖）
const PROVIDERS = [
  // 各家默认选套餐内最低价档（Flash/Lite），均经网关实测 200；
  // 可用 {PROVIDER}_MODEL 环境变量覆盖
  { provider: "minimax", envKey: "MINIMAX_KEY", model: "MiniMax-M3.1-Flash" },
  // GLM_KEY 默认是编程套餐 key：额度在 glm_cp（coding/paas/v4）通道上，
  // 标准 glm（paas/v4）通道按量计费，无余额会返回 429 code=1113。
  // 注意：智谱对 Cloudflare 出口 IP 有间歇性风控，可能返回
  // 401「令牌已过期或验证不正确」——key 本身有效（直连上游 200），稍后重试即可
  { provider: "glm_cp", envKey: "GLM_KEY", model: "glm-5.3" },
  { provider: "deepseek", envKey: "DEEPSEEK_KEY", model: "deepseek-flash" },
  { provider: "volcengine", envKey: "BYTEDANCE_KEY", model: "doubao-seed-2-1-lite-260915" },
];

const results = [];
const record = (group, name, status, detail = "", ms = 0) => {
  results.push({ group, name, status, detail, ms });
  const tag = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  const extra = detail ? ` - ${detail}` : "";
  console.log(`[${tag}] ${group}/${name}${extra} (${(ms / 1000).toFixed(1)}s)`);
};

async function request(path, { method = "POST", key, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const response = await fetch(`${GATEWAY_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // 保留原始文本用于诊断
  }
  return { status: response.status, text, json };
}

// 非流式 Chat：断言 200、choices 结构与 finish_reason；
// DeepSeek 额外断言代理补齐的 reasoning_content 字段存在
async function testChatNonStream(provider, key, model) {
  const started = Date.now();
  const res = await request(`/${provider}/v1/chat/completions`, {
    key,
    body: {
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 512,
    },
  });
  if (res.status !== 200) {
    return record(
      provider,
      "chat-non-stream",
      "fail",
      `HTTP ${res.status}: ${res.text.slice(0, 200)}`,
      Date.now() - started,
    );
  }
  const choice = res.json?.choices?.[0];
  const finish = choice?.finish_reason;
  if (!choice || typeof finish !== "string" || !finish) {
    return record(
      provider,
      "chat-non-stream",
      "fail",
      `missing choices/finish_reason: ${res.text.slice(0, 200)}`,
      Date.now() - started,
    );
  }
  if (provider === "deepseek" && !("reasoning_content" in choice.message)) {
    return record(
      provider,
      "chat-non-stream",
      "fail",
      "proxy did not add reasoning_content to deepseek response",
      Date.now() - started,
    );
  }
  const content = typeof choice.message?.content === "string" ? choice.message.content : "";
  return record(
    provider,
    "chat-non-stream",
    "pass",
    `finish_reason=${finish} content="${content.slice(0, 40)}"`,
    Date.now() - started,
  );
}

// 流式 Chat：断言收到事件、流以 [DONE] 终止（网关保证补终止事件）
async function testChatStream(provider, key, model) {
  const started = Date.now();
  const response = await fetch(`${GATEWAY_BASE}/${provider}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 512,
      stream: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    return record(
      provider,
      "chat-stream",
      "fail",
      `HTTP ${response.status}: ${text.slice(0, 200)}`,
      Date.now() - started,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let events = 0;
  let sawFinishReason = false;
  let sawDone = false;
  let streamError = "";

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        sawDone = true;
        break outer;
      }
      events++;
      try {
        const chunk = JSON.parse(data);
        if (chunk.error) {
          streamError = chunk.error.message || JSON.stringify(chunk.error).slice(0, 200);
        }
        const choice = chunk.choices?.[0];
        if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
          sawFinishReason = true;
        }
      } catch (_) {
        // 非 JSON data 行（网关会视为上游错误并补 error 事件）
        if (!streamError) streamError = `non-JSON data line: ${data.slice(0, 120)}`;
      }
    }
  }
  try {
    await reader.cancel();
  } catch (_) {
    // 流已结束
  }

  if (streamError) {
    return record(
      provider,
      "chat-stream",
      "fail",
      `stream error event: ${streamError}`,
      Date.now() - started,
    );
  }
  if (events === 0) {
    return record(provider, "chat-stream", "fail", "no SSE events received", Date.now() - started);
  }
  if (!sawFinishReason || !sawDone) {
    return record(
      provider,
      "chat-stream",
      "fail",
      `stream terminated without ${!sawFinishReason ? "finish_reason" : "[DONE]"}`,
      Date.now() - started,
    );
  }
  return record(
    provider,
    "chat-stream",
    "pass",
    `${events} events, finish_reason + [DONE] present`,
    Date.now() - started,
  );
}

// Responses API：断言 200 且 object === "response"
async function testResponses(provider, key, model) {
  const started = Date.now();
  const res = await request(`/${provider}/v1/responses`, {
    key,
    body: { model, input: "Reply with exactly: ok" },
  });
  if (res.status !== 200) {
    return record(
      provider,
      "responses",
      "fail",
      `HTTP ${res.status}: ${res.text.slice(0, 200)}`,
      Date.now() - started,
    );
  }
  if (res.json?.object !== "response" || !Array.isArray(res.json?.output)) {
    return record(
      provider,
      "responses",
      "fail",
      `unexpected shape: ${res.text.slice(0, 200)}`,
      Date.now() - started,
    );
  }
  const text = typeof res.json.output_text === "string" ? res.json.output_text : "";
  return record(
    provider,
    "responses",
    "pass",
    `status=${res.json.status} output_text="${text.slice(0, 40)}"`,
    Date.now() - started,
  );
}

// ─── 网关基础设施测试（不需要 key）───
async function testInfra() {
  let started = Date.now();
  const models = await request("/v1/models", { method: "GET", key: "smoke-probe" });
  const providerCount = Array.isArray(models.json?.data) ? models.json.data.length : 0;
  record(
    "infra",
    "models-list",
    models.status === 200 && providerCount > 0 ? "pass" : "fail",
    `HTTP ${models.status}, ${providerCount} providers`,
    Date.now() - started,
  );

  started = Date.now();
  const unknown = await request("/definitely-not-a-provider/v1/chat/completions", {
    key: "smoke-probe",
    body: {},
  });
  record(
    "infra",
    "unknown-provider-404",
    unknown.status === 404 ? "pass" : "fail",
    `HTTP ${unknown.status}`,
    Date.now() - started,
  );

  started = Date.now();
  const missing = await request("/v1/embeddings", { key: "smoke-probe", body: {} });
  record(
    "infra",
    "missing-prefix-400",
    missing.status === 400 ? "pass" : "fail",
    `HTTP ${missing.status}`,
    Date.now() - started,
  );
}

async function main() {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY;
  if (proxy) {
    console.log(`[WARN] local proxy detected (${proxy}).`);
    console.log(`       If tests fail with 401/connection errors, add the gateway host to NO_PROXY.`);
  }

  const filters = process.argv.slice(2).map((arg) => arg.toLowerCase());
  console.log(`[GATEWAY] ${GATEWAY_BASE}`);
  console.log(`[SKIP_RESPONSES] ${SKIP_RESPONSES}`);
  console.log("");

  await testInfra();
  console.log("");

  for (const { provider, envKey, model } of PROVIDERS) {
    if (filters.length > 0 && !filters.includes(provider)) continue;

    const key = process.env[envKey];
    if (!key) {
      record(provider, "all", "skip", `${envKey} not set`);
      continue;
    }
    const testModel = process.env[`${envKey.replace("_KEY", "_MODEL")}`] || model;
    console.log(`--- ${provider} (model: ${testModel}) ---`);

    await testChatNonStream(provider, key, testModel);
    await testChatStream(provider, key, testModel);
    if (!SKIP_RESPONSES) await testResponses(provider, key, testModel);
    console.log("");
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`=== SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`[FATAL] ${error?.stack || error}`);
  process.exit(1);
});
