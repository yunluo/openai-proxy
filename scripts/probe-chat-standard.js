// Chat Completions 标准符合性探测（第二轮）：覆盖首轮未测的规范参数。
//
// 用法：bun scripts/probe-chat-standard.js [provider...]
// 环境变量：GATEWAY_BASE、MINIMAX_KEY / GLM_KEY / DEEPSEEK_KEY / BYTEDANCE_KEY、
//           {PROVIDER}_MODEL 覆盖模型
//
// 注意：思考模型会先消耗 token 再输出内容，所以这里的 max_tokens 给到 2048；
// MiniMax M3.1-Flash 的 reasoning_effort 默认 max，显式降为 low 控制消耗。
//
// 检查项（OpenAI openapi.yaml 基准）：
//   roles              system + developer + user 角色枚举
//   tool-required      tool_choice: "required"
//   tool-named         tool_choice: {type:"function",function:{name}}
//   tool-roundtrip     assistant.tool_calls + tool 角色 + tool_call_id 回传 → 最终回答
//   n-choices          n: 2 → 2 个 choice，index 0/1
//   stop-seq           stop 序列生效
//   misc-params        seed / frequency_penalty / presence_penalty / user 接受度
//   logprobs           logprobs + top_logprobs 响应结构
//   object-fields      响应 object/created/model 字段（+ service_tier/system_fingerprint 注记）
//   chunk-object       流式每个 chunk 的 object === "chat.completion.chunk"，首 delta 带 role

const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(/\/+$/, "");
const TIMEOUT_MS = 90000;

const PROVIDERS = [
  { provider: "minimax", envKey: "MINIMAX_KEY", model: "MiniMax-M3.1-Flash" },
  { provider: "glm_cp", envKey: "GLM_KEY", model: "glm-5.3" },
  { provider: "deepseek", envKey: "DEEPSEEK_KEY", model: "deepseek-flash" },
  { provider: "volcengine", envKey: "BYTEDANCE_KEY", model: "doubao-seed-2-1-lite-260915" },
];

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "查询指定城市实时天气",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}];

// MiniMax M3.1-Flash 思考默认 max 档，显式降低避免 token 预算被思考耗尽
const lean = (p) => (p.provider === "minimax" ? { reasoning_effort: "low" } : {});

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

const clip = (t, n = 90) => String(t ?? "").replace(/\s+/g, " ").slice(0, n);
function show(name, verdict, note = "") {
  console.log(`  [${verdict.padEnd(12)}] ${name}${note ? ` - ${note}` : ""}`);
}
// 注意：传入的是 request() 的结果包装对象（内含 .json），不是解析后的 body
const chat = (res) => res.json?.choices?.[0]?.message?.content;

async function tRoles(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 2048, ...lean(p),
      messages: [
        { role: "system", content: "You are a calculator." },
        { role: "developer", content: "Always reply with digits only." },
        { role: "user", content: "What is 2+3?" },
      ],
    },
  });
  if (res.status !== 200) return show("roles", "REJECTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const c = chat(res) || "";
  show("roles", /\b5\b|五|five/i.test(c) ? "PASS" : "DEVIATE", `回答: ${clip(c, 40)} body=${clip(res.text, 150)}`);
}

async function tToolRequired(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 2048, ...lean(p), tools: TOOLS, tool_choice: "required",
      messages: [{ role: "user", content: "Hi" }],
    },
  });
  if (res.status !== 200) return show("tool-required", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const tc = res.json?.choices?.[0]?.message?.tool_calls;
  show("tool-required", Array.isArray(tc) && tc.length > 0 ? "PASS" : "DEVIATE",
    tc ? `${tc[0]?.function?.name}` : `无 tool_calls, content=${clip(chat(res), 30)} body=${clip(res.text, 130)}`);
}

async function tToolNamed(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 2048, ...lean(p), tools: TOOLS,
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [{ role: "user", content: "Hi" }],
    },
  });
  if (res.status !== 200) return show("tool-named", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const tc = res.json?.choices?.[0]?.message?.tool_calls;
  const named = Array.isArray(tc) && tc[0]?.function?.name === "get_weather";
  show("tool-named", named ? "PASS" : "DEVIATE", tc ? `${tc[0]?.function?.name}` : `无 tool_calls, content=${clip(chat(res), 30)}`);
}

async function tToolRoundtrip(p, key, model) {
  const first = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 2048, ...lean(p), tools: TOOLS,
      messages: [{ role: "user", content: "杭州天气如何？查一下。" }],
    },
  });
  if (first.status !== 200) return show("tool-roundtrip", "REJECTED", `首轮 HTTP ${first.status}`);
  const tc = first.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) return show("tool-roundtrip", "FAIL", "首轮无 tool_calls");
  const second = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 2048, ...lean(p), tools: TOOLS,
      messages: [
        { role: "user", content: "杭州天气如何？查一下。" },
        { role: "assistant", content: first.json.choices[0].message.content ?? "", tool_calls: first.json.choices[0].message.tool_calls },
        { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ city: "杭州", temp: "26C", weather: "sunny" }) },
      ],
    },
  });
  if (second.status !== 200) return show("tool-roundtrip", "REJECTED", `回传 HTTP ${second.status}: ${clip(second.text)}`);
  const c = chat(second) || "";
  show("tool-roundtrip", /26|晴|sunny|杭州/i.test(c) ? "PASS" : "DEVIATE", `最终回答: ${clip(c, 50)} body=${clip(second.text, 130)}`);
}

async function tNChoices(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: { model, max_tokens: 2048, ...lean(p), n: 2, messages: [{ role: "user", content: "Reply with exactly: ok" }] },
  });
  if (res.status !== 200) return show("n-choices", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const cs = res.json?.choices;
  const idx = Array.isArray(cs) ? cs.map((c) => c?.index).sort().join(",") : "";
  show("n-choices", Array.isArray(cs) && cs.length === 2 ? "PASS" : "DEVIATE", `choices=${Array.isArray(cs) ? cs.length : "?"} index=[${idx}]`);
}

async function tStopSeq(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 1024, ...lean(p), stop: ["STOPWORD"],
      messages: [{ role: "user", content: "Repeat after me exactly: A B C STOPWORD D E F" }],
    },
  });
  if (res.status !== 200) return show("stop-seq", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const c = chat(res) || "";
  const truncated = !c.includes("STOPWORD") && !c.includes("D E F");
  show("stop-seq", truncated ? "PASS" : "DEVIATE", `回答: ${clip(c, 40)} finish=${res.json?.choices?.[0]?.finish_reason} body=${clip(res.text, 130)}`);
}

async function tMiscParams(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 64, seed: 42, temperature: 0.5, top_p: 0.9,
      frequency_penalty: 0.1, presence_penalty: 0.1, user: "schema-probe",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
    },
  });
  if (res.status !== 200) return show("misc-params", "REJECTED", `HTTP ${res.status}: ${clip(res.text)}`);
  show("misc-params", "PASS", "seed/penalties/temperature/user 全部接受");
}

async function tLogprobs(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: {
      model, max_tokens: 32, logprobs: true, top_logprobs: 2,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
    },
  });
  if (res.status !== 200) return show("logprobs", "UNSUPPORTED", `HTTP ${res.status}: ${clip(res.text)}`);
  const lp = res.json?.choices?.[0]?.logprobs;
  const ok = lp && Array.isArray(lp.content) && lp.content.length > 0 &&
    typeof lp.content[0]?.logprob === "number" && Array.isArray(lp.content[0]?.top_logprobs);
  show("logprobs", ok ? "PASS" : "DEVIATE", lp ? `tokens=${lp.content?.length}` : "logprobs 为空");
}

async function tObjectFields(p, key, model) {
  const res = await request(`/${p.provider}/v1/chat/completions`, {
    key,
    body: { model, max_tokens: 64, messages: [{ role: "user", content: "Reply with exactly: ok" }] },
  });
  if (res.status !== 200) return show("object-fields", "FAIL", `HTTP ${res.status}`);
  const j = res.json;
  const miss = [];
  if (j?.object !== "chat.completion") miss.push(`object=${j?.object}`);
  if (typeof j?.created !== "number") miss.push("created");
  if (typeof j?.model !== "string") miss.push("model");
  if (typeof j?.id !== "string") miss.push("id");
  if (j?.choices?.[0]?.message?.role !== "assistant") miss.push("message.role");
  const extras = [];
  if (j?.system_fingerprint) extras.push("system_fingerprint");
  if (j?.service_tier) extras.push(`service_tier=${j.service_tier}`);
  show("object-fields", miss.length ? "DEVIATE" : "PASS",
    `${miss.length ? `缺失: ${miss.join(",")}` : "结构完整"}${extras.length ? `; 附加: ${extras.join(",")}` : ""}`);
}

async function tChunkObject(p, key, model) {
  const r = await readSSE(`/${p.provider}/v1/chat/completions`, key, {
    model, max_tokens: 64, stream: true,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  });
  if (r.frames === null) return show("chunk-object", "REJECTED", `HTTP ${r.status}: ${clip(r.text)}`);
  const chunks = r.frames.filter((f) => f.choices);
  const badObject = chunks.filter((f) => f.object !== "chat.completion.chunk").length;
  const firstDelta = chunks.find((f) => Object.keys(f.choices?.[0]?.delta || {}).length > 0);
  const firstHasRole = firstDelta?.choices?.[0]?.delta?.role !== undefined;
  show("chunk-object", badObject === 0 ? "PASS" : "DEVIATE",
    `chunk=${chunks.length}, object 异常=${badObject}, 首 delta 带 role=${firstHasRole}`);
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
    await tRoles(p, key, model);
    await tToolRequired(p, key, model);
    await tToolNamed(p, key, model);
    await tToolRoundtrip(p, key, model);
    await tNChoices(p, key, model);
    await tStopSeq(p, key, model);
    await tMiscParams(p, key, model);
    await tLogprobs(p, key, model);
    await tObjectFields(p, key, model);
    await tChunkObject(p, key, model);
  }
  console.log("\n=== DONE ===");
}

main().catch((e) => { console.error(`[FATAL] ${e?.stack || e}`); process.exit(1); });

