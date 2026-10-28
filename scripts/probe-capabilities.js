// 网关能力探测：逐项验证各厂商路由的上游真实能力，输出能力矩阵。
//
// 用法（Node >= 18 或 Bun，无第三方依赖）：
//   bun scripts/probe-capabilities.js            # 全部 provider
//   bun scripts/probe-capabilities.js minimax    # 只测指定 provider
//
// 环境变量：GATEWAY_BASE、MINIMAX_KEY / GLM_KEY / DEEPSEEK_KEY / BYTEDANCE_KEY、
//           {PROVIDER}_MODEL 覆盖默认模型
//
// 判定说明：
//   PASS        能力正常
//   FAIL        请求成功但结果不符合预期
//   UNSUPPORTED 上游明确拒绝（400/404 等），视为该模型不支持
//   ERROR       网络/超时等其他错误

import zlib from "node:zlib";

const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(
  /\/+$/,
  "",
);
const TIMEOUT_MS = 90000;
const MAX_TOKENS = 512;

const PROVIDERS = [
  { provider: "minimax", envKey: "MINIMAX_KEY", model: "MiniMax-M3.1-Flash" },
  // GLM key 是编程套餐 key，走 glm_cp；glm-5.3 是套餐内验证可用的最低价模型
  { provider: "glm_cp", envKey: "GLM_KEY", model: "glm-5.3" },
  { provider: "deepseek", envKey: "DEEPSEEK_KEY", model: "deepseek-flash" },
  { provider: "volcengine", envKey: "BYTEDANCE_KEY", model: "doubao-seed-2-1-lite-260915" },
  // 无 key 路由：只用免费模型探测
  { provider: "opencode_zen", envKey: null, model: null },
];

// 运行时生成 64x64 纯红 PNG（部分上游拒绝过小的图片，1x1 会误判为不支持视觉）
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}
function solidPngBase64(size = 64) {
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const off = y * stride + 1 + x * 3;
      raw[off] = 0xff; raw[off + 1] = 0x00; raw[off + 2] = 0x00;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}
const TINY_PNG = solidPngBase64(64);

const results = [];
function record(provider, capability, verdict, note = "") {
  results.push({ provider, capability, verdict, note });
  const tag = verdict.padEnd(11);
  console.log(`  [${tag}] ${capability}${note ? ` - ${note}` : ""}`);
}

async function request(path, { method = "POST", key, body, ua } = {}, attempt = 1) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (ua) headers["User-Agent"] = ua;
  let res, text;
  try {
    res = await fetch(`${GATEWAY_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (error) {
    return { status: 0, text: String(error?.message || error), json: null };
  }
  // 智谱对 CF 出口 IP 有间歇性风控（401）、限流（429）：重试一次
  if ((res.status === 401 || res.status === 429) && attempt === 1 && path.includes("/chat")) {
    await new Promise((r) => setTimeout(r, 3000));
    return request(path, { method, key, body, ua }, attempt + 1);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: res.status, text, json };
}

function chatContent(json) {
  return json?.choices?.[0]?.message?.content;
}
function isUnsupported(res) {
  return res.status >= 400 && res.status < 500;
}
function clip(text, n = 90) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, n);
}

async function probeModels(p, key) {
  const res = await request(`/${p.provider}/v1/models`, { method: "GET", key });
  if (res.status === 200 && Array.isArray(res.json?.data)) {
    const ids = res.json.data.map((m) => m?.id).filter(Boolean);
    record(p.provider, "models-list", "PASS", `${ids.length} 个模型`);
    return ids;
  }
  record(
    p.provider,
    "models-list",
    isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
    `HTTP ${res.status}: ${clip(res.text)}`,
  );
  return null;
}

async function probeChatBasic(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: MAX_TOKENS,
    },
  });
  if (res.status !== 200) {
    record(p.provider, "chat-basic", isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${res.status}: ${clip(res.text)}`);
    return null;
  }
  const msg = res.json?.choices?.[0]?.message;
  const content = typeof msg?.content === "string" ? msg.content : "";
  if (!res.json?.choices?.[0] || typeof msg?.content !== "string") {
    record(p.provider, "chat-basic", "FAIL", `结构异常: ${clip(res.text)}`);
    return null;
  }
  const reasoning = typeof msg?.reasoning_content === "string" && msg.reasoning_content;
  record(
    p.provider,
    "chat-basic",
    "PASS",
    `finish=${res.json.choices[0].finish_reason}` +
      (reasoning ? " [有 reasoning_content]" : "") +
      ` usage=${res.json.usage?.total_tokens ?? "?"}tok`,
  );
  return msg;
}

async function probeMultiTurn(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model,
      messages: [
        { role: "user", content: "我叫赵六。" },
        { role: "assistant", content: "你好，赵六！" },
        { role: "user", content: "我叫什么？只回答名字。" },
      ],
      max_tokens: MAX_TOKENS,
    },
  });
  if (res.status !== 200) {
    record(p.provider, "multi-turn", isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${res.status}: ${clip(res.text)}`);
    return;
  }
  const content = chatContent(res.json) || "";
  if (content.includes("赵六")) {
    record(p.provider, "multi-turn", "PASS", "上下文记忆正确");
  } else {
    record(p.provider, "multi-turn", "FAIL", `回答: ${clip(content)}`);
  }
}

async function probeStream(p, key, model) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  headers["User-Agent"] = "opencode/2.0.0";
  let response;
  try {
    response = await fetch(`${GATEWAY_BASE}/${p.provider}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    record(p.provider, "chat-stream", "ERROR", String(error?.message || error).slice(0, 90));
    return;
  }
  if (!response.ok) {
    const text = await response.text();
    record(p.provider, "chat-stream", isUnsupported(response.status) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${response.status}: ${clip(text)}`);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", events = 0, sawFinish = false, sawDone = false, errMsg = "";
  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") { sawDone = true; break outer; }
      events++;
      try {
        const chunk = JSON.parse(data);
        if (chunk.error) errMsg = clip(JSON.stringify(chunk.error), 120);
        if (chunk.choices?.[0]?.finish_reason) sawFinish = true;
      } catch (_) { if (!errMsg) errMsg = "非 JSON data 行"; }
    }
  }
  try { await reader.cancel(); } catch (_) {}
  if (errMsg) return record(p.provider, "chat-stream", "FAIL", `流内错误: ${errMsg}`);
  if (events === 0) return record(p.provider, "chat-stream", "FAIL", "零事件");
  record(p.provider, "chat-stream", sawFinish && sawDone ? "PASS" : "FAIL",
    `${events} 事件, finish=${sawFinish}, done=${sawDone}`);
}

async function probeTools(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model,
      messages: [{ role: "user", content: "北京现在天气怎么样？必须调用工具查询。" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "查询指定城市的实时天气",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      }],
      max_tokens: MAX_TOKENS,
    },
  });
  if (res.status !== 200) {
    record(p.provider, "tool-calls", isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${res.status}: ${clip(res.text)}`);
    return;
  }
  const choice = res.json?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const fn = toolCalls[0]?.function;
    record(p.provider, "tool-calls", "PASS",
      `${fn?.name}(${clip(fn?.arguments, 60)})`);
  } else if (choice?.finish_reason === "tool_calls") {
    record(p.provider, "tool-calls", "PASS", "finish_reason=tool_calls");
  } else {
    record(p.provider, "tool-calls", "FAIL",
      `未产生 tool_calls: ${clip(chatContent(res.json) || res.text)}`);
  }
}

async function probeJsonMode(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model,
      messages: [{
        role: "user",
        content: '返回 JSON 对象：{"ok": true, "lang": "中文测试"}。只返回 JSON。',
      }],
      response_format: { type: "json_object" },
      max_tokens: MAX_TOKENS,
    },
  });
  if (res.status !== 200) {
    record(p.provider, "json-mode", isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${res.status}: ${clip(res.text)}`);
    return;
  }
  const content = chatContent(res.json) || "";
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?|```$/g, "").trim());
    record(p.provider, "json-mode", parsed && typeof parsed === "object" ? "PASS" : "FAIL",
      clip(content, 60));
  } catch (_) {
    record(p.provider, "json-mode", "FAIL", `不是合法 JSON: ${clip(content)}`);
  }
}

async function probeVision(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这张图片是什么颜色？只回答颜色词。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
        ],
      }],
      max_tokens: MAX_TOKENS,
    },
  });
  if (res.status !== 200) {
    record(p.provider, "vision", isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${res.status}: ${clip(res.text)}`);
    return;
  }
  const content = chatContent(res.json) || "";
  record(p.provider, "vision", content ? "PASS" : "FAIL", clip(content, 60));
}

async function probeResponses(p, key, model) {
  const res = await request(`/${p.provider}/v1/responses`, {
    key,
    body: { model, input: "Reply with exactly: ok" },
  });
  if (res.status !== 200) {
    record(p.provider, "responses-api", isUnsupported(res) ? "UNSUPPORTED" : "FAIL",
      `HTTP ${res.status}: ${clip(res.text)}`);
    return;
  }
  if (res.json?.object !== "response") {
    record(p.provider, "responses-api", "FAIL", `object=${res.json?.object}`);
    return;
  }
  const text = typeof res.json.output_text === "string" ? res.json.output_text : "";
  record(p.provider, "responses-api", "PASS", `status=${res.json.status} "${clip(text, 40)}"`);
}

// opencode_zen 无 key：从上游模型列表里逐个尝试免费模型。
// 免费层常见限制：RegionError（出口区域被封）、FreeUsageLimitError（共享 IP 配额耗尽）
async function probeOpenCodeZen(p) {
  const ids = await probeModels(p, null);
  const freeModels = (ids || []).filter(
    (id) => typeof id === "string" && id.endsWith("-free"),
  );
  if (freeModels.length === 0) {
    record(p.provider, "chat-basic", "SKIP", "未找到 -free 免费模型");
    return;
  }

  const notes = [];
  for (const model of freeModels.slice(0, 8)) {
    const res = await request(`/${p.provider}/v1/chat/completions`, {
      key: null,
      ua: "opencode/2.0.0",
      body: {
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 256,
      },
    });
    if (res.status === 200 && res.json?.choices?.[0]) {
      record(p.provider, "chat-basic", "PASS", `免费模型 ${model} 可用`);
      await probeStream(p, null, model);
      return;
    }
    const errType = res.json?.error?.type || res.json?.error?.code || "";
    notes.push(`${model}: ${res.status}${errType ? ` ${errType}` : ""}`);
  }
  record(
    p.provider,
    "chat-basic",
    "UNSUPPORTED",
    `免费层全部受限（${notes.length} 个模型）：${clip(notes.join("; "), 110)}`,
  );
}

async function main() {
  console.log(`[GATEWAY] ${GATEWAY_BASE}`);
  const filters = process.argv.slice(2).map((a) => a.toLowerCase());
  for (const p of PROVIDERS) {
    if (filters.length > 0 && !filters.includes(p.provider)) continue;

    const key = p.envKey ? process.env[p.envKey] : null;
    if (p.envKey && !key) {
      console.log(`\n=== ${p.provider}: SKIP（${p.envKey} 未设置）===`);
      continue;
    }
    const model = p.envKey
      ? process.env[`${p.envKey.replace("_KEY", "_MODEL")}`] || p.model
      : null;
    console.log(`\n=== ${p.provider}${model ? ` (${model})` : " (匿名)"} ===`);

    if (!p.envKey) {
      await probeOpenCodeZen(p);
      continue;
    }

    await probeModels(p, key);
    await probeChatBasic(p, key, model);
    await probeMultiTurn(p, key, model);
    await probeStream(p, key, model);
    await probeTools(p, key, model);
    await probeJsonMode(p, key, model);
    await probeVision(p, key, model);
    await probeResponses(p, key, model);
  }

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(
    `\n=== SUMMARY: ` +
      Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") +
      ` ===`,
  );
}

main().catch((error) => {
  console.error(`[FATAL] ${error?.stack || error}`);
  process.exit(1);
});
