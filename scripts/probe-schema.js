// 厂商 schema 一致性探测：实测各厂商对 OpenAI 规范字段的接受度与响应结构偏差。
//
// 用法：bun scripts/probe-schema.js [provider...]
// 环境变量：GATEWAY_BASE、MINIMAX_KEY / GLM_KEY / DEEPSEEK_KEY / BYTEDANCE_KEY、
//           {PROVIDER}_MODEL 覆盖模型
//
// 检查项（OpenAI 规范基准）：
//   content-parts      请求 content 为 part 数组（[{type:"text",...}]）
//   tool-shape         响应 tool_calls[] 字段完整性（id/type/function.name/arguments 可解析）
//   stream-tools       流式 tool_calls 增量按 index 聚合后 arguments 为合法 JSON
//   stream-usage       stream_options.include_usage → 最后出现 usage chunk（规范：空 choices）
//   json-schema        response_format json_schema (strict)
//   max-completion     新参数 max_completion_tokens（MiniMax 已弃用 max_tokens）
//   error-shape        错误响应 JSON 形状（对照 OpenAI {error:{message,type,code,param}}）
//   responses-schema   Responses 对象：object/id/status/output/usage 结构

import zlib from "node:zlib";

const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(/\/+$/, "");
const TIMEOUT_MS = 90000;

const PROVIDERS = [
  { provider: "minimax", envKey: "MINIMAX_KEY", model: "MiniMax-M3.1-Flash" },
  { provider: "glm_cp", envKey: "GLM_KEY", model: "glm-5.3" },
  { provider: "deepseek", envKey: "DEEPSEEK_KEY", model: "deepseek-flash" },
  { provider: "volcengine", envKey: "BYTEDANCE_KEY", model: "doubao-seed-2-1-lite-260915" },
];

async function request(path, { method = "POST", key, body } = {}, attempt = 1) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  let res, text;
  try {
    res = await fetch(`${GATEWAY_BASE}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (error) {
    return { status: 0, text: String(error?.message || error), json: null };
  }
  if ((res.status === 401 || res.status === 429) && attempt === 1) {
    await new Promise((r) => setTimeout(r, 3000));
    return request(path, { method, key, body }, attempt + 1);
  }
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, text, json };
}

const clip = (t, n = 100) => String(t ?? "").replace(/\s+/g, " ").slice(0, n);
function show(name, verdict, note = "") {
  const tag = verdict.padEnd(13);
  console.log(`  [${tag}] ${name}${note ? ` - ${note}` : ""}`);
}

// ── 流式读取工具：返回所有 data 帧的解析结果 ──
async function readSSE(path, key, body) {
  const res = await fetch(`${GATEWAY_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { status: res.status, frames: null, text: await res.text() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
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
      if (data === "[DONE]") { frames.push({ done: true }); break outer; }
      try { frames.push(JSON.parse(data)); } catch (_) { frames.push({ raw: data }); }
    }
  }
  try { await reader.cancel(); } catch (_) {}
  return { status: res.status, frames, text: "" };
}

// 1. content part 数组请求
async function tContentParts(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: { model, max_tokens: 256, messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }] },
  });
  if (res.status !== 200) return show("content-parts", "REJECTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const c = res.json?.choices?.[0]?.message?.content;
  const kind = typeof c === "string" ? "string" : Array.isArray(c) ? "array" : typeof c;
  show("content-parts", c ? "PASS" : "FAIL", `响应 content 类型: ${kind}`);
}

// 2. tool_calls 响应字段完整性
async function tToolShape(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 512,
      messages: [{ role: "user", content: "北京天气如何？必须调用工具。" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "查询天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    },
  });
  if (res.status !== 200) return show("tool-shape", "REJECTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const choice = res.json?.choices?.[0];
  const tcs = choice?.message?.tool_calls;
  if (!Array.isArray(tcs) || tcs.length === 0) return show("tool-shape", "FAIL", `无 tool_calls，finish=${choice?.finish_reason}`);
  const tc = tcs[0];
  const missing = [];
  if (typeof tc?.id !== "string" || !tc.id) missing.push("id");
  if (tc?.type !== "function") missing.push(`type=${tc?.type}`);
  if (typeof tc?.function?.name !== "string") missing.push("function.name");
  let argsOk = false;
  if (typeof tc?.function?.arguments === "string") { try { JSON.parse(tc.function.arguments); argsOk = true; } catch (_) { missing.push("arguments 非 JSON 字符串"); } }
  else missing.push("function.arguments 非 string");
  show("tool-shape", missing.length ? "DEVIATE" : "PASS",
    `${tc?.function?.name}(${clip(tc?.function?.arguments, 40)})${missing.length ? ` 缺失: ${missing.join(",")}` : ""} finish=${choice?.finish_reason}`);
}

// 3. 流式 tool_calls 增量聚合
async function tStreamTools(p, key, model) {
  const r = await readSSE(`/${p.provider}/v1/chat/completions`, key, {
    model, max_tokens: 512, stream: true,
    messages: [{ role: "user", content: "上海天气如何？必须调用工具。" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "查询天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  });
  if (r.frames === null) return show("stream-tools", "REJECTED", `HTTP ${r.status}: ${clip(r.text)}`);
  const byIndex = new Map();
  let finish = null, fields = new Set();
  for (const f of r.frames) {
    const d = f.choices?.[0]?.delta;
    if (!d) continue;
    for (const k of Object.keys(d)) fields.add(k);
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? 0;
      if (!byIndex.has(i)) byIndex.set(i, { name: "", args: "" });
      const e = byIndex.get(i);
      if (tc.function?.name) e.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") e.args += tc.function.arguments;
    }
    if (f.choices?.[0]?.finish_reason) finish = f.choices[0].finish_reason;
  }
  if (byIndex.size === 0) return show("stream-tools", "FAIL", "流中无 tool_calls 增量");
  const e = [...byIndex.values()][0];
  let argsOk = false;
  try { JSON.parse(e.args || "{}"); argsOk = true; } catch (_) {}
  show("stream-tools", argsOk && finish === "tool_calls" ? "PASS" : "DEVIATE",
    `${e.name} 聚合参数可解析=${argsOk} finish=${finish} delta 字段=[${[...fields].join(",")}]`);
}

// 4. stream_options.include_usage
async function tStreamUsage(p, key, model) {
  const r = await readSSE(`/${p.provider}/v1/chat/completions`, key, {
    model, max_tokens: 256, stream: true, stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  });
  if (r.frames === null) return show("stream-usage", "REJECTED", `HTTP ${r.status}: ${clip(r.text)}`);
  const usageFrames = r.frames.filter((f) => f.usage && typeof f.usage === "object");
  if (usageFrames.length === 0) return show("stream-usage", "UNSUPPORTED", "未出现 usage chunk（流中无 usage）");
  const last = usageFrames[usageFrames.length - 1];
  const emptyChoices = Array.isArray(last.choices) ? last.choices.length === 0 : last.choices == null;
  const u = last.usage;
  const fieldsOk = ["prompt_tokens", "completion_tokens", "total_tokens"].every((k) => typeof u[k] === "number");
  show("stream-usage", fieldsOk ? "PASS" : "DEVIATE",
    `usage chunk=${usageFrames.length} 个, 空choices=${emptyChoices}, 字段完整=${fieldsOk}${u.prompt_tokens_details ? `, cached=${u.prompt_tokens_details.cached_tokens ?? "-"}` : ""}`);
}

// 5. response_format json_schema (strict)
async function tJsonSchema(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 512,
      messages: [{ role: "user", content: '返回 {"ok": true}' }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "reply", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      },
    },
  });
  if (res.status !== 200) return show("json-schema", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const c = res.json?.choices?.[0]?.message?.content;
  let ok = false;
  try { const j = JSON.parse(String(c).replace(/^```(?:json)?|```$/g, "").trim()); ok = typeof j?.ok === "boolean"; } catch (_) {}
  show("json-schema", ok ? "PASS" : "DEVIATE", clip(c, 60));
}

// 6. max_completion_tokens（新参数，max_tokens 已被 MiniMax 弃用）
async function tMaxCompletion(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: { model, max_completion_tokens: 256, messages: [{ role: "user", content: "Reply with exactly: ok" }] },
  });
  if (res.status === 200) return show("max-completion", "PASS", "接受 max_completion_tokens");
  show("max-completion", res.status >= 400 && res.status < 500 ? "UNSUPPORTED" : "FAIL", `HTTP ${res.status}: ${clip(res.text)}`);
}

// 7. 错误响应形状
async function tErrorShape(p, key) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: { model: "not-a-real-model-xyz", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  });
  const j = res.json;
  const path = j?.error?.message !== undefined ? "error.message"
    : j?.message !== undefined ? "message(顶层)"
    : j?.base_resp !== undefined ? "base_resp"
    : "其他";
  const hasType = j?.error?.type !== undefined;
  const hasCode = j?.error?.code !== undefined || j?.error?.err_code !== undefined;
  show("error-shape", "NOTE", `HTTP ${res.status}, 字段路径=${path}, error.type=${hasType}, error.code=${hasCode}, 顶层键=[${j ? Object.keys(j).join(",") : "非JSON"}]`);
}

// 8. Responses 对象结构
async function tResponsesSchema(p, key, model) {
  const res = await request(`/${p.provider}/v1/responses`, { key, body: { model, input: "Reply with exactly: ok" } });
  if (res.status !== 200) return show("responses-schema", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const j = res.json;
  const miss = [];
  if (j?.object !== "response") miss.push(`object=${j?.object}`);
  if (typeof j?.id !== "string") miss.push("id");
  if (typeof j?.status !== "string") miss.push("status");
  if (!Array.isArray(j?.output)) miss.push("output");
  if (typeof j?.usage?.input_tokens !== "number" || typeof j?.usage?.output_tokens !== "number") miss.push("usage.input/output_tokens");
  const msg = (j?.output || []).find((o) => o?.type === "message");
  const part = msg?.content?.find((c) => c?.type === "output_text");
  if (msg && typeof part?.text !== "string") miss.push("output_text part");
  const outText = typeof j?.output_text === "string";
  show("responses-schema", miss.length ? "DEVIATE" : "PASS",
    `status=${j?.status} output_text聚合=${outText}${miss.length ? ` 偏差: ${miss.join(",")}` : ""}`);
}

async function main() {
  console.log(`[GATEWAY] ${GATEWAY_BASE}`);
  const filters = process.argv.slice(2).map((a) => a.toLowerCase());
  for (const p of PROVIDERS) {
    if (filters.length && !filters.includes(p.provider)) continue;
    const key = process.env[p.envKey];
    if (!key) { console.log(`\n=== ${p.provider}: SKIP（${p.envKey} 未设置）===`); continue; }
    const model = process.env[`${p.envKey.replace("_KEY", "_MODEL")}`] || p.model;
    console.log(`\n=== ${p.provider} (${model}) ===`);
    await tContentParts(p, key, model);
    await tToolShape(p, key, model);
    await tStreamTools(p, key, model);
    await tStreamUsage(p, key, model);
    await tJsonSchema(p, key, model);
    await tMaxCompletion(p, key, model);
    await tErrorShape(p, key);
    await tResponsesSchema(p, key, model);
  }
  console.log("\n=== DONE ===");
}

main().catch((e) => { console.error(`[FATAL] ${e?.stack || e}`); process.exit(1); });
