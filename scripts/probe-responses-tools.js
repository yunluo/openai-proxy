// Responses API 工具调用往返探测：对线上网关的 /{provider}/v1/responses 跑
// 三步往返，逐步检查工具调用各环节的形状是否合规：
//   1. 非流式 + tools + tool_choice=required → 检查 output[] 里 function_call 的
//      arguments 是否可二次 JSON.parse、status/call_id 是否齐全
//   2. 流式 + 同样请求 → 检查事件序列（output_item.added 是否声明 function_call、
//      function_call_arguments.delta/done、response.completed）
//   3. 带历史回放（function_call + function_call_output）→ 检查上游是否接受工具结果
//
// 用法：bun scripts/probe-responses-tools.js [glm_cp|deepseek|minimax|...] [N 轮]
// 环境变量：{PROVIDER}_KEY（如 GLM_KEY）、{PROVIDER}_MODEL（可选，默认 glm-5.3-flash）

const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(
  /\/+$/,
  "",
);
const TIMEOUT_MS = 120000;

const PROVIDERS = {
  glm_cp: { envKey: "GLM_KEY", model: "glm-5.3-flash" },
  glm: { envKey: "GLM_KEY", model: "glm-5.3-flash" },
  deepseek: { envKey: "DEEPSEEK_KEY", model: "deepseek-chat" },
  minimax: { envKey: "MINIMAX_KEY", model: "MiniMax-M3.1-Flash" },
};

const TOOLS = [
  {
    type: "function",
    name: "get_weather",
    description: "查询指定城市的当前天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

async function postResponses(provider, key, model, body, stream) {
  const response = await fetch(`${GATEWAY_BASE}/${provider}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(stream ? { ...body, stream: true } : body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!stream) {
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: response.status, json, text };
  }
  return { status: response.status, stream: response.body };
}

function checkArgumentsText(label, args) {
  if (typeof args !== "string") return `${label}: arguments 不是字符串而是 ${typeof args}`;
  try {
    JSON.parse(args);
    return null;
  } catch (e) {
    return `${label}: arguments 二次解析失败(${e.message}): ${JSON.stringify(args).slice(0, 120)}`;
  }
}

async function probeNonStream(provider, key, model) {
  const { status, json, text } = await postResponses(provider, key, model, {
    model,
    input: "北京今天天气怎么样？必须调用工具查询。",
    tools: TOOLS,
    tool_choice: { type: "function", name: "get_weather" },
  });
  const issues = [];
  if (status !== 200) {
    return [`非流式: HTTP ${status} ${text.slice(0, 300)}`];
  }
  const output = Array.isArray(json?.output) ? json.output : [];
  const fc = output.find((o) => o && o.type === "function_call");
  if (!fc) {
    issues.push(`非流式: output[] 无 function_call，实际类型: ${output.map((o) => o?.type).join(",") || "(空)"}`);
  } else {
    const argIssue = checkArgumentsText("非流式", fc.arguments);
    if (argIssue) issues.push(argIssue);
    if (!fc.call_id) issues.push("非流式: function_call 缺 call_id");
  }
  if (issues.length === 0) {
    console.log(
      `[PASS] 非流式: call_id=${fc.call_id} name=${fc.name} args=${fc.arguments} status=${fc.status ?? "(无)"}`,
    );
    return { ok: true, call: fc };
  }
  for (const i of issues) console.log(`[FAIL] ${i}`);
  return { ok: false };
}

async function probeStream(provider, key, model) {
  const { status, stream } = await postResponses(
    provider,
    key,
    model,
    {
      model,
      input: "北京今天天气怎么样？必须调用工具查询。",
      tools: TOOLS,
      tool_choice: { type: "function", name: "get_weather" },
    },
    true,
  );
  if (status !== 200 || !stream) return console.log(`[FAIL] 流式: HTTP ${status}`);
  const events = [];
  let argsFragments = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const ev = JSON.parse(data);
        events.push(ev.type || "(无type)");
        if (ev.type === "response.function_call_arguments.delta") argsFragments += ev.delta || "";
        if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          events.push(`ITEM_ARGS_OK=${(() => { try { JSON.parse(ev.item.arguments); return true; } catch { return false; } })()}`);
        }
        if (ev.type === "response.completed") {
          const fc = (ev.response?.output || []).find((o) => o?.type === "function_call");
          if (fc) events.push(`COMPLETED_ARGS_OK=${(() => { try { JSON.parse(fc.arguments); return true; } catch { return false; } })()}`);
        }
        if (ev.type === "error" || ev.type === "response.failed") {
          events.push(`ERROR=${JSON.stringify(ev).slice(0, 200)}`);
        }
      } catch (_) {
        events.push(`NON_JSON=${data.slice(0, 80)}`);
      }
    }
  }
  const issues = [];
  if (!events.includes("response.output_item.added")) issues.push("流式: 缺 output_item.added");
  if (!events.some((e) => e.startsWith("response.function_call_arguments"))) {
    issues.push("流式: 缺 function_call_arguments 事件");
  }
  if (!events.includes("response.completed")) issues.push("流式: 缺 response.completed");
  const argsIssue = checkArgumentsText("流式(delta拼接)", argsFragments);
  if (argsIssue) issues.push(argsIssue);
  if (issues.length === 0) {
    console.log(`[PASS] 流式: ${events.length} 事件，delta 拼接可解析，事件序列: ${[...new Set(events)].slice(0, 12).join(" → ")}`);
  } else {
    for (const i of issues) console.log(`[FAIL] ${i}`);
    console.log(`       事件序列: ${[...new Set(events)].join(" → ")}`);
  }
}

async function probeReplay(provider, key, model, fc) {
  const input = [
    { role: "user", content: "北京今天天气怎么样？必须调用工具查询。" },
    {
      type: "function_call",
      id: fc?.id || "fc_probe",
      call_id: fc?.call_id || "call_probe",
      name: "get_weather",
      arguments: fc?.arguments || '{"city":"北京"}',
    },
    { type: "function_call_output", call_id: fc?.call_id || "call_probe", output: '{"temp_c":3,"weather":"晴"}' },
  ];
  const { status, json, text } = await postResponses(provider, key, model, {
    model,
    input,
    tools: TOOLS,
  });
  if (status !== 200) {
    return console.log(`[FAIL] 历史回放: HTTP ${status} ${text.slice(0, 300)}`);
  }
  // 逐层展开 output[]，定位「文本为空」到底发生在哪一层：
  // 顶层 output_text 聚合字段没填？还是 message.content 本身就没内容？
  const items = Array.isArray(json?.output) ? json.output : [];
  if (items.length === 0) {
    return console.log(`[FAIL] 历史回放: output[] 为空，body=${text.slice(0, 200)}`);
  }
  let messageText = "";
  for (const item of items) {
    if (item?.type === "message") {
      const content = item.content;
      if (Array.isArray(content)) {
        const parts = content.map(
          (p) => `${p?.type}:${typeof p?.text === "string" ? p.text.length : "?"}字`,
        );
        console.log(`[INFO] 回放 message: status=${item.status ?? "?"} content=[${parts.join(", ")}]`);
        messageText = content
          .filter((p) => p?.type === "output_text" && typeof p?.text === "string")
          .map((p) => p.text)
          .join("");
      } else {
        console.log(
          `[INFO] 回放 message: status=${item.status ?? "?"} content 是 ${typeof content}` +
            (typeof content === "string" ? `(${content.length}字)` : ""),
        );
        if (typeof content === "string") messageText = content;
      }
    } else if (item?.type === "reasoning") {
      const len = JSON.stringify(item.summary ?? item.content ?? "").length;
      console.log(`[INFO] 回放 reasoning: summary/content 序列化长度=${len}`);
    } else {
      console.log(`[INFO] 回放 ${item?.type}: ${JSON.stringify(item).slice(0, 120)}`);
    }
  }
  const topText = typeof json?.output_text === "string" ? json.output_text : null;
  console.log(
    `[INFO] 顶层 output_text: ${topText === null ? "(字段缺失)" : `"${topText.slice(0, 60)}"`}`,
  );
  if (messageText) {
    console.log(`[PASS] 历史回放: message.content 文本="${messageText.slice(0, 60)}"`);
  } else {
    console.log(`[FAIL] 历史回放: message.content 无文本（模型回了空消息）`);
  }
}

// 流式回放：客户端实际都是流式跑 agent 循环，检查流式下工具结果回放是否正常
async function probeReplayStream(provider, key, model, fc) {
  const input = [
    { role: "user", content: "北京今天天气怎么样？必须调用工具查询。" },
    {
      type: "function_call",
      id: fc?.id || "fc_probe",
      call_id: fc?.call_id || "call_probe",
      name: "get_weather",
      arguments: fc?.arguments || '{"city":"北京"}',
    },
    { type: "function_call_output", call_id: fc?.call_id || "call_probe", output: '{"temp_c":3,"weather":"晴"}' },
  ];
  const { status, stream } = await postResponses(
    provider,
    key,
    model,
    { model, input, tools: TOOLS },
    true,
  );
  if (status !== 200 || !stream) return console.log(`[FAIL] 流式回放: HTTP ${status}`);
  const types = [];
  let textDeltas = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const ev = JSON.parse(data);
        if (ev.type && !types.includes(ev.type)) types.push(ev.type);
        if (ev.type === "response.output_text.delta") textDeltas += ev.delta || "";
        if (ev.type === "error" || ev.type === "response.failed") {
          types.push(`ERROR=${JSON.stringify(ev).slice(0, 160)}`);
        }
      } catch (_) {
        types.push(`NON_JSON=${data.slice(0, 80)}`);
      }
    }
  }
  const completed = types.includes("response.completed");
  if (textDeltas && completed) {
    console.log(`[PASS] 流式回放: ${types.length} 类事件，output_text="${textDeltas.slice(0, 60)}"`);
  } else {
    console.log(
      `[FAIL] 流式回放: completed=${completed} output_text总长=${textDeltas.length} 事件: ${types.join(" → ")}`,
    );
  }
}

async function main() {
  const provider = process.argv[2] || "glm_cp";
  const rounds = Math.max(1, Math.min(5, parseInt(process.argv[3], 10) || 1));
  const conf = PROVIDERS[provider];
  if (!conf) {
    console.error(`[FATAL] 未知 provider: ${provider}（可用: ${Object.keys(PROVIDERS).join(", ")}）`);
    process.exit(1);
  }
  const key = process.env[conf.envKey];
  if (!key) {
    console.error(`[FATAL] ${conf.envKey} 未设置`);
    process.exit(1);
  }
  const model = process.env[`${conf.envKey.replace("_KEY", "_MODEL")}`] || conf.model;
  console.log(`[TARGET] ${GATEWAY_BASE}/${provider}/v1/responses  model=${model}  rounds=${rounds}\n`);
  for (let i = 1; i <= rounds; i++) {
    console.log(`── 第 ${i}/${rounds} 轮 ──`);
    const r = await probeNonStream(provider, key, model);
    await probeStream(provider, key, model);
    await probeReplay(provider, key, model, r?.ok ? r.call : null);
    await probeReplayStream(provider, key, model, r?.ok ? r.call : null);
    console.log("");
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error?.stack || error}`);
  process.exit(1);
});
