import { test } from "node:test";
import assert from "node:assert/strict";

import { handleProxyRequest } from "../src/core.js";
import { PROVIDERS } from "../src/config.js";

const PROXY_ORIGIN = "https://proxy.example";

// 标准 provider 配置（覆盖测试用到的厂商）
function makeOptions(overrides = {}) {
  return {
    providers: {
      minimax: { apiBase: "https://api.minimaxi.com/v1" },
      deepseek: { apiBase: "https://api.deepseek.com/v1" },
      glm: { apiBase: "https://open.bigmodel.cn/api/paas/v4" },
      deepseek_anthropic: { apiBase: PROVIDERS.deepseek_anthropic.default },
      opencode_anthropic: { apiBase: "https://opencode.ai/zen/go/v1" },
      ...overrides,
    },
    apiBaseWww: "https://www.minimaxi.com",
  };
}

function toBytes(body) {
  if (body == null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new TextEncoder().encode(String(body));
}

// 替换全局 fetch，记录每次上游请求，并按 responder 返回响应
async function withUpstream(responder, fn) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const bytes = toBytes(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const record = {
      url: String(url),
      method: init.method,
      headers,
      bytes,
      text: bytes ? new TextDecoder().decode(bytes) : null,
    };
    try {
      record.json = record.text ? JSON.parse(record.text) : null;
    } catch {
      record.json = null;
    }
    calls.push(record);
    return typeof responder === "function" ? responder(record, calls) : responder;
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// 发起一次代理请求
function proxyRequest(path, { key = "test-key", method = "POST", body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (key) init.headers.authorization = `Bearer ${key}`;
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!init.headers["content-type"]) {
      init.headers["content-type"] = "application/json";
    }
  }
  return new Request(`${PROXY_ORIGIN}${path}`, init);
}

// ──────────────────────────────────────────────
// 鉴权与路由
// ──────────────────────────────────────────────

test("缺少 API Key 时返回 401，且不请求上游", async () => {
  await withUpstream(jsonResponse({}), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/v1/chat/completions", { key: null, body: { model: "m" } }),
      makeOptions(),
    );
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await res.json()).error.type, "invalid_request_error");
  });
});

test("x-api-key 也能作为认证来源，并且空值不算有效 key", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    const req = new Request(`${PROXY_ORIGIN}/v1/models`, {
      method: "GET",
      headers: { "x-api-key": "  key-from-x-api-key  " },
    });
    const res = await handleProxyRequest(req, makeOptions());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);

    const emptyAuth = new Request(`${PROXY_ORIGIN}/v1/models`, {
      method: "GET",
      headers: { authorization: "Bearer " },
    });
    assert.equal((await handleProxyRequest(emptyAuth, makeOptions())).status, 401);
  });
});

test("路由：/{provider}/v1/* 剥离前缀并拼接 provider 基址", async () => {
  const matrix = [
    ["/deepseek/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"],
    ["/glm/v1/chat/completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
    ["/v1/chat/completions", "https://api.minimaxi.com/v1/chat/completions"],
    [
      "/deepseek_anthropic/v1/messages",
      "https://api.deepseek.com/anthropic/v1/messages",
    ],
    ["/minimax_anthropic/v1/messages", null], // 未配置的 provider 单独跳过
  ];

  for (const [path, expected] of matrix) {
    if (!expected) continue;
    await withUpstream(jsonResponse({ ok: true }), async (calls) => {
      const res = await handleProxyRequest(
        proxyRequest(path, { body: { model: "m", messages: [] } }),
        makeOptions(),
      );
      assert.equal(res.status, 200, path);
      assert.equal(calls[0].url, expected);
    });
  }
});

test("基址尾部斜杠被规范化，不会出现 //", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", { body: { model: "m" } }),
      makeOptions({ minimax: { apiBase: "https://api.minimaxi.com/v1/" } }),
    );
    assert.equal(calls[0].url, "https://api.minimaxi.com/v1/chat/completions");
  });
});

test("查询串被保留", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/deepseek/v1/models?limit=5", { method: "GET", key: "k" }),
      makeOptions(),
    );
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/models?limit=5");
  });
});

test("/token_plan 与 /coding_plan 保留路径前缀转发到官网", async () => {
  await withUpstream(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      await handleProxyRequest(
        proxyRequest("/token_plan/billing/query", { method: "GET" }),
        makeOptions(),
      );
      await handleProxyRequest(
        proxyRequest("/coding_plan/billing/query", { method: "GET" }),
        makeOptions(),
      );
      assert.equal(calls[0].url, "https://www.minimaxi.com/token_plan/billing/query");
      assert.equal(calls[1].url, "https://www.minimaxi.com/coding_plan/billing/query");
    },
  );
});

test("未知 provider 与原型链名字都返回 404", async () => {
  for (const path of ["/nope/v1/chat/completions", "/__proto__/v1/chat/completions"]) {
    await withUpstream(jsonResponse({ ok: true }), async (calls) => {
      const res = await handleProxyRequest(
        proxyRequest(path, { body: { model: "m" } }),
        makeOptions(),
      );
      assert.equal(res.status, 404, path);
      assert.equal(calls.length, 0);
    });
  }
});

test("/v1/models 返回 provider 列表，带 provider 前缀时不拦截", async () => {
  await withUpstream(jsonResponse({ data: [] }), async (calls) => {
    const local = await handleProxyRequest(
      proxyRequest("/v1/models", { method: "GET" }),
      makeOptions(),
    );
    assert.equal(local.status, 200);
    const list = await local.json();
    assert.equal(list.object, "list");
    assert.ok(list.data.some((m) => m.id === "deepseek"));
    assert.equal(calls.length, 0);

    await handleProxyRequest(
      proxyRequest("/deepseek/v1/models", { method: "GET" }),
      makeOptions(),
    );
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/models");
  });
});

// ──────────────────────────────────────────────
// 请求体处理
// ──────────────────────────────────────────────

test("非 JSON（multipart）请求体按字节原样透传", async () => {
  const boundary = "----proxytest";
  const payload =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="a.bin"\r\n' +
    "Content-Type: application/octet-stream\r\n\r\n" +
    "binary\u0000\u0001data\r\n" +
    `--${boundary}--\r\n`;

  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    const req = new Request(`${PROXY_ORIGIN}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: "Bearer k",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: payload,
    });
    const res = await handleProxyRequest(req, makeOptions());

    assert.equal(res.status, 200);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].text, payload);
    assert.equal(
      calls[0].headers["content-type"],
      `multipart/form-data; boundary=${boundary}`,
    );
  });
});

test("非法 JSON 返回 400，且不请求上游", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    const req = new Request(`${PROXY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: '{"model": "m",',
    });
    const res = await handleProxyRequest(req, makeOptions());
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await res.json()).error.type, "invalid_request_error");
  });
});

// ──────────────────────────────────────────────
// 响应处理
// ──────────────────────────────────────────────

test("JSON 响应保留上游状态码与响应头", async () => {
  await withUpstream(
    jsonResponse({ error: { message: "slow down" } }, 429, {
      "retry-after": "7",
      "x-request-id": "req_1",
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/deepseek/v1/chat/completions", { body: { model: "m" } }),
        makeOptions(),
      );
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "7");
      assert.equal(res.headers.get("x-request-id"), "req_1");
      assert.equal((await res.json()).error.message, "slow down");
    },
  );
});

test("x-opencode-session 等白名单头会透传给上游", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        headers: {
          "x-opencode-session": "sess-1",
          "x-session-id": "sess-2",
          "user-agent": "claude-cli/2.0.0",
          "HTTP-Referer": "https://app",
        },
        body: { model: "m", max_tokens: 1, messages: [] },
      }),
      makeOptions(),
    );
    assert.equal(calls[0].headers["x-opencode-session"], "sess-1");
    assert.equal(calls[0].headers["x-session-id"], "sess-2");
    assert.equal(calls[0].headers["user-agent"], "claude-cli/2.0.0");
    assert.equal(calls[0].headers["http-referer"], "https://app");
    // 不应该透传敏感头
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(calls[0].headers.host, undefined);
  });
});

// ──────────────────────────────────────────────
// Anthropic ↔ OpenAI 格式互转
// ──────────────────────────────────────────────

test("opencode_anthropic：上游错误原样透出，不再伪装成 200", async () => {
  await withUpstream(
    jsonResponse({ error: { message: "bad key", type: "invalid_api_key" } }, 401),
    async (calls) => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode_anthropic/v1/messages", {
          body: { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
        }),
        makeOptions(),
      );
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.type, "error");
      assert.equal(data.error.type, "authentication_error");
      assert.equal(data.error.message, "bad key");
      assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/chat/completions");
    },
  );
});

test("opencode_anthropic：429 映射为 rate_limit_error", async () => {
  await withUpstream(jsonResponse({ error: { message: "too many" } }, 429), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: { model: "m", max_tokens: 8, messages: [] },
      }),
      makeOptions(),
    );
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.type, "rate_limit_error");
  });
});

test("opencode_anthropic：成功响应转成 Anthropic 消息体", async () => {
  await withUpstream(
    jsonResponse({
      id: "chatcmpl-9",
      model: "glm-5",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "working",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode_anthropic/v1/messages", {
          body: { model: "m", max_tokens: 8, messages: [] },
        }),
        makeOptions(),
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.type, "message");
      assert.equal(data.stop_reason, "tool_use");
      assert.deepEqual(data.content[0], { type: "text", text: "working" });
      assert.deepEqual(data.content[1], {
        type: "tool_use",
        id: "call_1",
        name: "read_file",
        input: { path: "a.txt" },
      });
      assert.deepEqual(data.usage, { input_tokens: 3, output_tokens: 4 });
    },
  );
});

test("Anthropic → OpenAI：tool_result 必须排在文本 user 消息之前", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: {
          model: "m",
          max_tokens: 16,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } },
              ],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "also note this" },
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: [{ type: "text", text: "result-body" }],
                },
              ],
            },
          ],
        },
      }),
      makeOptions(),
    );

    const sent = calls[0].json;
    assert.equal(sent.messages[0].role, "assistant");
    assert.equal(sent.messages[0].tool_calls[0].function.name, "f");
    assert.deepEqual(sent.messages[1], {
      role: "tool",
      tool_call_id: "toolu_1",
      content: "result-body",
    });
    assert.deepEqual(sent.messages[2], { role: "user", content: "also note this" });
  });
});

test("Anthropic → OpenAI：tool_choice none、图片 url、system 与 stop 映射", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: {
          model: "m",
          max_tokens: 16,
          system: "be brief",
          stop_sequences: ["STOP"],
          tool_choice: { type: "none" },
          tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                { type: "image", source: { type: "url", url: "https://img/x.png" } },
              ],
            },
          ],
        },
      }),
      makeOptions(),
    );

    const sent = calls[0].json;
    assert.deepEqual(sent.messages[0], { role: "system", content: "be brief" });
    assert.deepEqual(sent.messages[1].content[0], { type: "text", text: "look" });
    assert.deepEqual(sent.messages[1].content[1], {
      type: "image_url",
      image_url: { url: "https://img/x.png" },
    });
    assert.equal(sent.tool_choice, "none");
    assert.deepEqual(sent.stop, ["STOP"]);
    assert.deepEqual(sent.tools[0].function.parameters, { type: "object" });
  });
});

test("opencode_anthropic：带尾斜杠的 /messages/ 也能转换路径", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages/", {
        body: { model: "m", max_tokens: 8, messages: [] },
      }),
      makeOptions(),
    );
    assert.equal(res.status, 200);
    assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/chat/completions");
  });
});

// ──────────────────────────────────────────────
// 流式转换
// ──────────────────────────────────────────────

function sseUpstream(text) {
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("流式转换：事件序列正确，并在 message_delta 补报 input_tokens", async () => {
  const sse =
    'data: {"id":"chatcmpl-1","model":"glm-5","choices":[{"delta":{"role":"assistant","content":"He"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: {
          model: "m",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
      makeOptions(),
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const out = await res.text();
    assert.match(out, /event: message_start/);
    assert.match(out, /"type":"text_delta","text":"He"/);
    assert.match(out, /"type":"text_delta","text":"llo"/);
    assert.match(out, /event: content_block_stop/);
    assert.match(out, /"stop_reason":"end_turn"/);
    assert.match(out, /"usage":\{"output_tokens":3,"input_tokens":11\}/);
    assert.match(out, /event: message_stop/);
    assert.ok(!out.includes("event: error"));
  });
});

test("流式转换：工具调用生成带 input:{} 的 tool_use 块", async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: { model: "m", max_tokens: 16, stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"type":"tool_use","id":"call_1","name":"f","input":\{\}/);
    assert.match(out, /"partial_json":"\{\\"a\\":"/);
    assert.match(out, /"stop_reason":"tool_use"/);
  });
});

test("流式转换：上游中途出错时发出 error 事件而不是正常结束", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
      );
      controller.error(new Error("upstream reset"));
    },
  });

  await withUpstream(new Response(body, { headers: { "content-type": "text/event-stream" } }), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: { model: "m", max_tokens: 16, stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /event: error/);
    assert.match(out, /"type":"api_error"/);
    assert.match(out, /upstream reset/);
    assert.ok(!out.includes("event: message_stop"));
  });
});

test("流式转换：由 query 参数触发 SSE 时也能识别（不再整体缓冲）", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' + "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages?stream=true", {
        // 请求体里没有 stream 字段：只有上游 Content-Type 能表明这是 SSE
        body: { model: "m", max_tokens: 16, messages: [] },
      }),
      makeOptions(),
    );

    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const out = await res.text();
    assert.match(out, /event: message_stop/);
  });
});

test("非 Anthropic provider 的 SSE 原样透传", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' + "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/deepseek/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    assert.equal(calls[0].json.stream, true);
    assert.equal(await res.text(), sse);
  });
});

test("SSE 透传：剔除上游的 content-length / content-encoding / connection", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' + "data: [DONE]\n\n";
  const upstream = new Response(sse, {
    headers: {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": "999",
      connection: "keep-alive",
      "x-request-id": "req-1",
    },
  });

  await withUpstream(upstream, async () => {
    const res = await handleProxyRequest(
      proxyRequest("/deepseek/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(res.headers.get("connection"), null);
    // 其余上游头仍保留
    assert.equal(res.headers.get("x-request-id"), "req-1");
    assert.equal(await res.text(), sse);
  });
});
