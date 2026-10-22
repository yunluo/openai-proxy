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
      opencode: { apiBase: "https://opencode.ai/zen/go/v1" },
      opencode_zen: { apiBase: "https://opencode.ai/zen/v1" },
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

// OpenCode Zen 免费模型：上游免费层只认 OpenCode 客户端身份头，不需要也不接受
// 任意 Authorization；代理应允许匿名请求，并且不要给免费模型加 Bearer。
const ZEN_FREE_SSE =
  'data: {"id":"zen-1","model":"deepseek-v4.1-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n' +
  "data: [DONE]\n\n";

test("opencode_zen 免费模型：无 API Key 也可请求，且不向上游发送 Authorization", async () => {
  await withUpstream(sseUpstream(ZEN_FREE_SSE), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        key: null,
        body: {
          model: "deepseek-v4.1-flash-free",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
      makeOptions(),
    );

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, undefined);
    // 顺带验证免费模型的流仍会经过 SSE 终止块修复
    const out = await res.text();
    assert.match(out, /"finish_reason":"stop"/);
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("opencode_zen 免费模型：客户端带占位 key 也不透传 Authorization", async () => {
  await withUpstream(sseUpstream(ZEN_FREE_SSE), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        key: "free",
        body: {
          model: "deepseek-v4.1-flash-free",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
      makeOptions(),
    );

    assert.equal(res.status, 200);
    assert.equal(calls[0].headers.authorization, undefined);
  });
});

test("opencode_zen 付费模型：仍透传客户端 Authorization", async () => {
  await withUpstream(sseUpstream(ZEN_FREE_SSE), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        key: "zen-real-key",
        body: {
          model: "claude-sonnet-4-5",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
      makeOptions(),
    );

    assert.equal(res.status, 200);
    assert.equal(calls[0].headers.authorization, "Bearer zen-real-key");
  });
});

test("opencode_zen 付费模型：无 key 时转发上游 401，不伪造成功", async () => {
  const upstream = jsonResponse(
    { error: { message: "missing credential" } },
    401,
  );
  await withUpstream(upstream, async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        key: null,
        body: {
          model: "claude-sonnet-4-5",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      }),
      makeOptions(),
    );

    assert.equal(res.status, 401);
    assert.equal(calls[0].headers.authorization, undefined);
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
  const session = "ses_ea8e062a1ffef1R1BHXWtidHvn";
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        headers: {
          "x-opencode-session": session,
          "x-session-id": "sess-2",
          "x-opencode-client": "cli",
          "x-opencode-project": "global",
          "user-agent": "claude-cli/2.0.0",
          "HTTP-Referer": "https://app",
        },
        body: { model: "m", max_tokens: 1, messages: [] },
      }),
      makeOptions(),
    );
    assert.equal(calls[0].headers["x-opencode-session"], session);
    assert.equal(calls[0].headers["x-opencode-client"], "cli");
    assert.equal(calls[0].headers["x-opencode-project"], "global");
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

test("opencode_anthropic：上游漏掉 finish_reason 时按 tool_calls 推断 tool_use", async () => {
  await withUpstream(
    jsonResponse({
      id: "chatcmpl-10",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
        },
      ],
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode_anthropic/v1/messages", {
          body: { model: "m", max_tokens: 8, messages: [] },
        }),
        makeOptions(),
      );
      const data = await res.json();
      assert.equal(data.stop_reason, "tool_use");
      assert.equal(data.content[0].type, "tool_use");
    },
  );
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

test("流式转换：工具调用但上游漏掉 finish_reason 时仍以 tool_use 结束", async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]}}]}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: { model: "m", max_tokens: 16, stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"type":"tool_use","id":"call_1","name":"f"/);
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
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";

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
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
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

test("SSE 修复：上游缺 finish_reason 时在 [DONE] 前补合成终止块", async () => {
  const sse =
    'data: {"id":"chatcmpl-x","model":"muse-spark-1.2","choices":[{"index":0,"delta":{"content":"完整回答"}}]}\n\n' +
    'data: {"id":"chatcmpl-x","model":"muse-spark-1.2","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "muse-spark-1.2", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    // 原始内容保持原样
    assert.match(out, /"delta":\{"content":"完整回答"\}/);
    assert.match(out, /"usage":\{"prompt_tokens":9,"completion_tokens":4\}/);
    // [DONE] 之前出现了合法的终止块
    assert.match(
      out,
      /data: \{"id":"chatcmpl-x","object":"chat\.completion\.chunk","created":\d+,"model":"muse-spark-1\.2","choices":\[\{"index":0,"delta":\{\},"finish_reason":"stop"\}\]\}\n\ndata: \[DONE\]/,
    );
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("SSE 修复：上游连 [DONE] 都没有时补终止块和 [DONE]", async () => {
  const sse =
    'data: {"id":"chatcmpl-y","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"finish_reason":"stop"/);
    assert.ok(out.endsWith('data: [DONE]\n\n'));
  });
});

test("SSE 修复：已有 finish_reason 时只补缺失的 [DONE]，不重复终止块", async () => {
  const sse =
    'data: {"id":"chatcmpl-k","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
    'data: {"id":"chatcmpl-k","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.equal((out.match(/"finish_reason":"stop"/g) || []).length, 1);
    assert.ok(out.endsWith('data: [DONE]\n\n'));
  });
});

test("SSE 修复：已输出 tool_calls 时合成 finish_reason=tool_calls", async () => {
  const sse =
    'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{}"}}]}}]}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"finish_reason":"tool_calls"/);
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("SSE 修复：跨 chunk 拆行也能识别并补齐终止块", async () => {
  const encoder = new TextEncoder();
  const pieces = [
    'data: {"id":"chatcmpl-z","choices":[{"index":0,"delta":{"content":"你',
    '好"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });

  await withUpstream(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      const out = await res.text();
      assert.match(out, /"delta":\{"content":"你好"\}/);
      assert.match(out, /"finish_reason":"stop"/);
      assert.ok(out.endsWith('data: [DONE]\n\n'));
    },
  );
});

test("SSE 修复：上游在流内报错时不补成功终止块", async () => {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n' +
    'data: {"error":{"type":"api_error","message":"upstream failed"}}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /upstream failed/);
    assert.ok(!out.includes('"finish_reason"'));
    assert.ok(!out.includes("data: [DONE]"));
  });
});

test("SSE 修复：非 JSON 的 data 行视为上游报错，不伪造正常结束", async () => {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n' +
    "data: upstream overloaded\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /upstream overloaded/);
    assert.ok(!out.includes('"finish_reason"'));
    assert.ok(!out.includes("data: [DONE]"));
  });
});

test("SSE 修复：兼容 CRLF 行结束符，且各事件顺序不变", async () => {
  const sse =
    'data: {"id":"chatcmpl-crlf","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\r\n\r\n' +
    "data: [DONE]\r\n\r\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"content":"hi"\}\}\]\}\r\n/);
    assert.match(out, /"finish_reason":"stop"/);
    assert.ok(
      out.indexOf('"finish_reason":"stop"') < out.indexOf("data: [DONE]"),
    );
    assert.ok(out.endsWith("data: [DONE]\r\n\r\n"));
  });
});

test("SSE 修复：边收边转发，不等待整条流结束", async () => {
  const encoder = new TextEncoder();
  let releaseTail;
  const tailGate = new Promise((resolve) => {
    releaseTail = resolve;
  });
  const upstreamBody = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n',
        ),
      );
      await tailGate;
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
        ),
      );
      controller.close();
    },
  });

  await withUpstream(
    new Response(upstreamBody, {
      headers: { "content-type": "text/event-stream" },
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let timer;
      try {
        const first = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("SSE 被整体缓冲，未实时转发")),
              2000,
            );
          }),
        ]);
        assert.equal(first.done, false);
        assert.match(decoder.decode(first.value), /"content":"first"/);
      } finally {
        clearTimeout(timer);
        releaseTail();
      }

      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
      }
      rest += decoder.decode();
      assert.match(rest, /"finish_reason":"stop"/);
      assert.ok(rest.endsWith("data: [DONE]\n\n"));
    },
  );
});

test("SSE 修复：上游流中途报错时不伪造正常结束", async () => {
  const encoder = new TextEncoder();
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        ),
      );
      controller.error(new Error("upstream reset"));
    },
  });

  await withUpstream(
    new Response(upstreamBody, {
      headers: { "content-type": "text/event-stream" },
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let out = "";
      let failure = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /upstream reset/);
      assert.ok(!out.includes('"finish_reason"'));
    },
  );
});

test("SSE 修复：仅作用于 Chat Completions，Responses 等其他 SSE 原样透传", async () => {
  const sse =
    'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/responses", {
        body: { model: "m", stream: true, input: [] },
      }),
      makeOptions(),
    );

    assert.equal(await res.text(), sse);
  });
});

test("Anthropic 原生 SSE 不补 OpenAI 的 finish_reason / [DONE]", async () => {
  const sse =
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/deepseek_anthropic/v1/messages", {
        body: { model: "m", max_tokens: 8, stream: true, messages: [] },
      }),
      makeOptions(),
    );

    assert.equal(await res.text(), sse);
  });
});

const OK_OPENAI = {
  id: "1",
  choices: [{ message: { role: "assistant", content: "ok" } }],
};

// OpenCode 原生会话 id：ses_ + 12 位十六进制 + 14 位 base62
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

test("OpenCode Go：客户端没带会话头时自动派生格式合法的 x-opencode-session", async () => {
  await withUpstream(() => jsonResponse(OK_OPENAI), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_anthropic/v1/messages", {
        body: {
          model: "glm-5",
          max_tokens: 8,
          messages: [{ role: "user", content: "你好" }],
        },
      }),
      makeOptions(),
    );

    assert.equal(res.status, 200);
    assert.match(calls[0].headers["x-opencode-session"], OPENCODE_SESSION_RE);
  });
});

test("OpenCode Zen（非 Go 路径）也会补 x-opencode-session", async () => {
  await withUpstream(() => jsonResponse(OK_OPENAI), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        body: { model: "big-pickle", messages: [{ role: "user", content: "你好" }] },
      }),
      makeOptions(),
    );

    assert.equal(calls[0].url, "https://opencode.ai/zen/v1/chat/completions");
    assert.match(calls[0].headers["x-opencode-session"], OPENCODE_SESSION_RE);
  });
});

test("OpenCode Go：同一对话的后续轮次派生同一个会话 id，新对话则不同", async () => {
  await withUpstream(() => jsonResponse(OK_OPENAI), async (calls) => {
    const first = (body) =>
      handleProxyRequest(
        proxyRequest("/opencode_anthropic/v1/messages", {
          body: { model: "glm-5", max_tokens: 8, ...body },
        }),
        makeOptions(),
      );

    await first({ messages: [{ role: "user", content: "你好" }] });
    // 第二轮：完整重发历史，首条 user 消息不变
    await first({
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "再来一句" },
      ],
    });
    // 另一个对话：首条 user 消息不同
    await first({ messages: [{ role: "user", content: "另一个问题" }] });

    const id0 = calls[0].headers["x-opencode-session"];
    assert.equal(calls[1].headers["x-opencode-session"], id0);
    assert.notEqual(calls[2].headers["x-opencode-session"], id0);
  });
});

test("OpenCode 网关会话头：合法值沿用，非法/空白值改为派生，非网关注入", async () => {
  const clientSession = "ses_ea8e062a1ffef1R1BHXWtidHvn";
  await withUpstream(() => jsonResponse(OK_OPENAI), async (calls) => {
    const send = (headers, path = "/opencode_anthropic/v1/messages") =>
      handleProxyRequest(
        proxyRequest(path, {
          headers,
          body: {
            model: "glm-5",
            max_tokens: 8,
            messages: [{ role: "user", content: "你好" }],
          },
        }),
        makeOptions(),
      );

    // opencode 作为自定义 provider 接入时只发 x-session-id（值本身合法）→ 沿用
    await send({ "x-session-id": clientSession });
    assert.equal(calls[0].headers["x-session-id"], clientSession);
    assert.equal(calls[0].headers["x-opencode-session"], clientSession);

    // 非 OpenCode 格式的会话值（如 Claude Code 的 uuid）不能满足免费模型校验 → 派生
    await send({ "x-session-id": "01a0af13-c6df-73c6-8803-9e6d9c720da7" });
    assert.match(calls[1].headers["x-opencode-session"], OPENCODE_SESSION_RE);

    // 空白值 → 视为未提供，仍会补一个
    await send({ "x-session-id": "   " });
    assert.match(calls[2].headers["x-opencode-session"], OPENCODE_SESSION_RE);

    // 非 OpenCode 网关上游：不注入会话头
    await send(
      {},
      "/deepseek/v1/chat/completions",
    );
    assert.equal(calls[3].headers["x-opencode-session"], undefined);
  });
});

test("访问口令：设置 PROXY_ACCESS_TOKEN 后，缺 token 或 token 不对都返回 401", async () => {
  await withUpstream(jsonResponse({ ok: true }), async (calls) => {
    const options = { ...makeOptions(), accessToken: "secret" };

    const denied = await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", {
        body: { model: "m", messages: [] },
      }),
      options,
    );
    assert.equal(denied.status, 401);
    assert.match((await denied.json()).error.message, /x-proxy-token/);
    assert.equal(calls.length, 0);

    const wrong = await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", {
        headers: { "x-proxy-token": "nope" },
        body: { model: "m", messages: [] },
      }),
      options,
    );
    assert.equal(wrong.status, 401);
    assert.equal(calls.length, 0);

    const ok = await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", {
        headers: { "x-proxy-token": "secret" },
        body: { model: "m", messages: [] },
      }),
      options,
    );
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
    // 口令不会被转发给上游
    assert.equal(calls[0].headers["x-proxy-token"], undefined);
  });
});

test("访问口令：未设置时不拦截", async () => {
  await withUpstream(jsonResponse({ ok: true }), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", {
        body: { model: "m", messages: [] },
      }),
      makeOptions(),
    );
    assert.equal(res.status, 200);
  });
});

test("上游连不上：返回 502，且不回显内部错误细节", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {}; // 屏蔽本用例预期内的日志
  globalThis.fetch = async () => {
    throw new TypeError("ECONNREFUSED: connect to 10.0.0.1:443 failed");
  };
  try {
    const res = await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", {
        body: { model: "m", messages: [] },
      }),
      makeOptions(),
    );
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error.type, "upstream_unreachable");
    assert.equal(body.error.message, "Unable to reach upstream minimax.");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("上游迟迟不回响应头：超时后返回 504", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {}; // 屏蔽本用例预期内的日志
  globalThis.fetch = (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      // 永不返回响应头，只在被 abort 时结束
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  try {
    const res = await handleProxyRequest(
      proxyRequest("/minimax/v1/chat/completions", {
        body: { model: "m", messages: [] },
      }),
      { ...makeOptions(), upstreamTimeoutMs: 20 },
    );
    const body = await res.json();
    assert.equal(res.status, 504);
    assert.equal(body.error.type, "upstream_timeout");
    assert.match(body.error.message, /did not respond within/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("流式空闲超时：上游中途不再发数据时，流以错误结束而不是永久挂住", async () => {
  const encoder = new TextEncoder();
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'));
      // 之后再也不发数据，也不关闭
    },
  });

  await withUpstream(
    new Response(stalled, { headers: { "content-type": "text/event-stream" } }),
    async () => {
      const started = Date.now();
      const res = await handleProxyRequest(
        proxyRequest("/deepseek/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        { ...makeOptions(), streamIdleTimeoutMs: 30 },
      );

      await assert.rejects(res.text(), /idle timeout/);
      // 应该在空闲超时后很快结束，而不是一直等
      assert.ok(Date.now() - started < 3000);
    },
  );
});

test("正常流式响应不会被空闲超时打断", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const piece of ["A", "B", "C"]) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${piece}"}}]}\n\n`));
        await new Promise((r) => setTimeout(r, 10));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  await withUpstream(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/deepseek/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        { ...makeOptions(), streamIdleTimeoutMs: 60 },
      );

      const text = await res.text();
      assert.match(text, /"content":"A"/);
      assert.match(text, /"content":"C"/);
      assert.match(text, /data: \[DONE\]/);
    },
  );
});

test("Anthropic 转换流：空闲超时会转成 event: error 事件", async () => {
  const encoder = new TextEncoder();
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"id":"1","model":"m","choices":[{"delta":{"content":"A"}}]}\n\n'),
      );
      // 之后不再发数据
    },
  });

  await withUpstream(
    new Response(stalled, { headers: { "content-type": "text/event-stream" } }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode_anthropic/v1/messages", {
          body: { model: "m", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] },
        }),
        { ...makeOptions(), streamIdleTimeoutMs: 30 },
      );

      // 流会以错误结束，但必须在结束前把 Anthropic 的 error 事件发给客户端
      let out = "";
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
      } catch (_) {
        // 预期内的流错误
      }
      assert.match(out, /event: error/);
      assert.match(out, /"type":"error"/);
    },
  );
});
