import { test } from "node:test";
import assert from "node:assert/strict";

import { handleProxyRequest } from "../src/core.js";

const PROXY_ORIGIN = "https://proxy.example";

// 标准 provider 配置（覆盖测试用到的厂商）
function makeOptions(overrides = {}) {
  return {
    providers: {
      minimax: {
        apiBase: "https://api.minimaxi.com/v1",
        responsesApiBase: "https://api.minimax.cn/v1",
      },
      deepseek: {
        apiBase: "https://api.deepseek.com/v1",
        responsesApiBase: "https://api.deepseek.com",
      },
      glm: {
        apiBase: "https://open.bigmodel.cn/api/paas/v4",
        responsesApiBase: "https://open.bigmodel.cn/api/v1",
      },
      gpt: { apiBase: "https://api.openai.com/v1" },
      volcengine: {
        apiBase: "https://ark.cn-beijing.volces.com/api/coding/v3",
        responsesApiBase: "https://ark.cn-beijing.volces.com/api/coding/v3",
      },
      opencode: { apiBase: "https://opencode.ai/zen/go/v1" },
      opencode_zen: { apiBase: "https://opencode.ai/zen/v1" },
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

function sseUpstream(text) {
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
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
      proxyRequest("/minimax/v1/chat/completions", { key: null, body: { model: "m" } }),
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
    ["/minimax/v1/chat/completions", "https://api.minimaxi.com/v1/chat/completions"],
  ];

  for (const [path, expected] of matrix) {
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
    const req = new Request(`${PROXY_ORIGIN}/minimax/v1/audio/transcriptions`, {
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
    const req = new Request(`${PROXY_ORIGIN}/minimax/v1/chat/completions`, {
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
      proxyRequest("/opencode/v1/chat/completions", {
        headers: {
          "x-opencode-session": session,
          "x-session-id": "sess-2",
          "x-opencode-client": "cli",
          "x-opencode-project": "global",
          "user-agent": "opencode/1.0.0",
          "HTTP-Referer": "https://app",
        },
        body: { model: "m", messages: [] },
      }),
      makeOptions(),
    );
    assert.equal(calls[0].headers["x-opencode-session"], session);
    assert.equal(calls[0].headers["x-opencode-client"], "cli");
    assert.equal(calls[0].headers["x-opencode-project"], "global");
    assert.equal(calls[0].headers["x-session-id"], "sess-2");
    assert.equal(calls[0].headers["user-agent"], "opencode/1.0.0");
    assert.equal(calls[0].headers["http-referer"], "https://app");
    // 不应该透传敏感头
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(calls[0].headers.host, undefined);
  });
});

test("SSE 原样透传", async () => {
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

test("SSE 修复：finish_reason 为空字符串时仍补合成终止块", async () => {
  const sse =
    'data: {"id":"chatcmpl-e","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":""}]}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    // 上游的空字符串原样保留，但代理必须再补一个真正的终止块
    assert.match(out, /"finish_reason":""/);
    assert.equal((out.match(/"finish_reason":"stop"/g) || []).length, 1);
    assert.ok(
      out.indexOf('"finish_reason":"stop"') > out.indexOf('"content":"hi"'),
    );
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("SSE 修复：finish_reason 只有空白且无 [DONE] 时也补终止块", async () => {
  const sse =
    'data: {"id":"chatcmpl-blank","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"   "}]}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode_zen/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"finish_reason":"stop"/);
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
    // 原始 error 事件已能让客户端识别失败；仍要补 [DONE] 把流正常收尾
    assert.ok(out.endsWith("data: [DONE]\n\n"));
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
    // 客户端读不懂非 JSON 行，代理补一个 OpenAI 格式的 error 事件 + [DONE]
    assert.match(out, /"error":\{"type":"upstream_stream_error"/);
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("SSE 修复：上游只发 [DONE] 时补 error 事件，不静默结束", async () => {
  await withUpstream(sseUpstream("data: [DONE]\n\n"), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /"error":\{"type":"upstream_stream_error"/);
    assert.match(out, /ended without any content/);
    assert.ok(!out.includes('"finish_reason"'));
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("SSE 修复：上游返回空流时补 error 事件与 [DONE]", async () => {
  await withUpstream(sseUpstream(""), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/opencode/v1/chat/completions", {
        body: { model: "m", stream: true, messages: [] },
      }),
      makeOptions(),
    );

    const out = await res.text();
    assert.match(out, /ended without any content/);
    assert.ok(!out.includes('"finish_reason"'));
    assert.ok(out.endsWith("data: [DONE]\n\n"));
  });
});

test("SSE 修复：请求 stream 但上游返回 JSON 完成体时补成 SSE", async () => {
  await withUpstream(
    jsonResponse({
      id: "cmpl-json",
      object: "chat.completion",
      created: 123,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.equal(res.headers.get("content-length"), null);
      const out = await res.text();
      assert.match(out, /"delta":\{"role":"assistant","content":"hi"\}/);
      assert.match(out, /"finish_reason":"stop"/);
      assert.ok(out.endsWith("data: [DONE]\n\n"));
    },
  );
});

test("SSE 修复：请求 stream 但上游返回 200 JSON 错误时转成 SSE error", async () => {
  await withUpstream(
    jsonResponse({ error: { message: "quota exceeded" } }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      const out = await res.text();
      assert.match(
        out,
        /"error":\{"type":"upstream_error","message":"quota exceeded"/,
      );
      assert.ok(!out.includes('"finish_reason"'));
      assert.ok(out.endsWith("data: [DONE]\n\n"));
    },
  );
});

test("SSE 修复：请求 stream 但上游返回 HTML/纯文本时转成 SSE error", async () => {
  await withUpstream(
    new Response("<html>blocked by edge</html>", {
      headers: { "content-type": "text/html" },
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      const out = await res.text();
      assert.match(out, /non-SSE response \(text\/html\)/);
      assert.match(out, /blocked by edge/);
      assert.ok(!out.includes('"finish_reason"'));
      assert.ok(out.endsWith("data: [DONE]\n\n"));
    },
  );
});

test("SSE 修复：请求 stream 但上游返回空 body 时也补 SSE error", async () => {
  await withUpstream(
    new Response("", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", stream: true, messages: [] },
        }),
        makeOptions(),
      );

      const out = await res.text();
      assert.match(out, /empty body/);
      assert.ok(!out.includes('"finish_reason"'));
      assert.ok(out.endsWith("data: [DONE]\n\n"));
    },
  );
});

test("JSON 响应：未请求 stream 时保持原样，不转 SSE", async () => {
  await withUpstream(
    jsonResponse({
      choices: [
        { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
      ],
    }),
    async () => {
      const res = await handleProxyRequest(
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "m", messages: [] },
        }),
        makeOptions(),
      );

      assert.match(res.headers.get("content-type"), /application\/json/);
      const data = await res.json();
      assert.equal(data.choices[0].message.content, "hi");
    },
  );
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

// ──────────────────────────────────────────────
// Responses API 原生支持（与 Chat Completions 并存，不做协议转换）
// ──────────────────────────────────────────────

test("Responses：非流式 POST 原样透传路径、请求体、响应与响应头", async () => {
  const responseBody = {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };

  await withUpstream(
    jsonResponse(responseBody, 200, { "x-request-id": "req_resp" }),
    async (calls) => {
      const res = await handleProxyRequest(
        proxyRequest("/gpt/v1/responses?trace=1", {
          body: { model: "gpt-5.1", input: "hi", store: false },
        }),
        makeOptions(),
      );

      assert.equal(calls[0].url, "https://api.openai.com/v1/responses?trace=1");
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].headers.authorization, "Bearer test-key");
      assert.deepEqual(calls[0].json, {
        model: "gpt-5.1",
        input: "hi",
        store: false,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-request-id"), "req_resp");
      assert.deepEqual(await res.json(), responseBody);
    },
  );
});

test("Responses：裸 /v1/responses 默认走 OpenAI（gpt）", async () => {
  await withUpstream(
    () => jsonResponse({ id: "resp_1", object: "response" }),
    async (calls) => {
      const res = await handleProxyRequest(
        proxyRequest("/v1/responses", {
          body: { model: "gpt-5.1", input: "hi" },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
      assert.equal(calls[0].headers.authorization, "Bearer test-key");
      assert.deepEqual(calls[0].json, { model: "gpt-5.1", input: "hi" });
    },
  );
});

test("Responses：裸 GET /v1/responses/{id} 默认走 OpenAI（gpt）", async () => {
  await withUpstream(
    () => jsonResponse({ id: "resp_1", object: "response" }),
    async (calls) => {
      const res = await handleProxyRequest(
        new Request(`${PROXY_ORIGIN}/v1/responses/resp_1`, {
          method: "GET",
          headers: { authorization: "Bearer test-key" },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      assert.equal(calls[0].url, "https://api.openai.com/v1/responses/resp_1");
    },
  );
});

test("Chat Completions：裸 /v1/chat/completions 默认走 OpenAI（gpt）", async () => {
  await withUpstream(
    () => jsonResponse({ choices: [] }),
    async (calls) => {
      const res = await handleProxyRequest(
        proxyRequest("/v1/chat/completions", {
          body: { model: "gpt-5.1", messages: [] },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
      assert.equal(calls[0].headers.authorization, "Bearer test-key");
    },
  );
});

test("Responses：MiniMax / GLM / DeepSeek / 火山使用各自的 Responses 基址", async () => {
  const matrix = [
    ["/minimax/v1/responses", "https://api.minimax.cn/v1/responses"],
    ["/glm/v1/responses", "https://open.bigmodel.cn/api/v1/responses"],
    ["/deepseek/v1/responses", "https://api.deepseek.com/responses"],
    [
      "/volcengine/v1/responses",
      "https://ark.cn-beijing.volces.com/api/coding/v3/responses",
    ],
  ];

  for (const [path, expected] of matrix) {
    await withUpstream(
      jsonResponse({ id: "resp_1", object: "response" }),
      async (calls) => {
        const res = await handleProxyRequest(
          proxyRequest(path, { body: { model: "m", input: "hi" } }),
          makeOptions(),
        );
        assert.equal(res.status, 200, path);
        assert.equal(calls[0].url, expected, path);
      },
    );
  }
});

test("GLM：Responses 子路径（GET /responses/{id}/input_items）使用 Responses 基址", async () => {
  await withUpstream(
    () => jsonResponse({ data: [] }),
    async (calls) => {
      const res = await handleProxyRequest(
        new Request(`${PROXY_ORIGIN}/glm/v1/responses/resp_1/input_items`, {
          method: "GET",
          headers: { authorization: "Bearer test-key" },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 200);
      assert.equal(
        calls[0].url,
        "https://open.bigmodel.cn/api/v1/responses/resp_1/input_items",
      );
    },
  );
});

test("Responses：DELETE 返回 204 时无 body 透传", async () => {
  await withUpstream(
    () =>
      new Response(null, {
        status: 204,
        headers: { "x-request-id": "req_del" },
      }),
    async (calls) => {
      const res = await handleProxyRequest(
        new Request(`${PROXY_ORIGIN}/glm/v1/responses/resp_1`, {
          method: "DELETE",
          headers: { authorization: "Bearer test-key" },
        }),
        makeOptions(),
      );

      assert.equal(res.status, 204);
      assert.equal(await res.text(), "");
      assert.equal(res.headers.get("x-request-id"), "req_del");
      assert.equal(
        calls[0].url,
        "https://open.bigmodel.cn/api/v1/responses/resp_1",
      );
      assert.equal(calls[0].method, "DELETE");
    },
  );
});

test("Chat：MiniMax / GLM / DeepSeek / 火山仍使用各自的 Chat 基址", async () => {
  const matrix = [
    [
      "/minimax/v1/chat/completions",
      "https://api.minimaxi.com/v1/chat/completions",
    ],
    [
      "/glm/v1/chat/completions",
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    ],
    [
      "/deepseek/v1/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
    ],
    [
      "/volcengine/v1/chat/completions",
      "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
    ],
  ];

  for (const [path, expected] of matrix) {
    await withUpstream(
      jsonResponse({ choices: [] }),
      async (calls) => {
        const res = await handleProxyRequest(
          proxyRequest(path, { body: { model: "m", messages: [] } }),
          makeOptions(),
        );
        assert.equal(res.status, 200, path);
        assert.equal(calls[0].url, expected, path);
      },
    );
  }
});

test("裸入口：Responses 用 gpt 的 Responses 基址，Chat 用 gpt 的 Chat 基址", async () => {
  const gpt = {
    apiBase: "https://chat.example/v1",
    responsesApiBase: "https://responses.example/v1",
  };

  await withUpstream(
    () => jsonResponse({ id: "resp_1", object: "response" }),
    async (calls) => {
      await handleProxyRequest(
        proxyRequest("/v1/responses", {
          body: { model: "m", input: "hi" },
        }),
        makeOptions({ gpt }),
      );
      assert.equal(calls[0].url, "https://responses.example/v1/responses");

      await handleProxyRequest(
        proxyRequest("/v1/chat/completions", {
          body: { model: "m", messages: [] },
        }),
        makeOptions({ gpt }),
      );
      assert.equal(calls[1].url, "https://chat.example/v1/chat/completions");
    },
  );
});

test("缺少 provider 前缀：其它 /v1/* 直接返回 400，且不请求上游", async () => {
  await withUpstream(jsonResponse({}), async (calls) => {
    // /v1/models 是代理本地端点；/v1/responses 与 /v1/chat/completions 默认走 OpenAI。
    // 其它需要转发上游的裸路径必须报错。
    for (const path of ["/v1/embeddings", "/v1"]) {
      const res = await handleProxyRequest(
        proxyRequest(path, {
          body: { model: "m", messages: [], input: "hi" },
        }),
        makeOptions(),
      );
      assert.equal(res.status, 400, path);
      const data = await res.json();
      assert.equal(data.error.type, "invalid_request_error", path);
      assert.match(data.error.message, /Provider prefix is required/, path);
      assert.match(data.error.message, /\/minimax/, path);
    }
    assert.equal(calls.length, 0);
  });
});

test("Responses：GET /responses/{id} 与 DELETE 原样透传", async () => {
  await withUpstream(
    () => jsonResponse({ id: "resp_1", object: "response" }),
    async (calls) => {
      const get = await handleProxyRequest(
        new Request(`${PROXY_ORIGIN}/gpt/v1/responses/resp_1`, {
          method: "GET",
          headers: { authorization: "Bearer test-key" },
        }),
        makeOptions(),
      );
      assert.equal(calls[0].url, "https://api.openai.com/v1/responses/resp_1");
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].text, null);
      assert.equal((await get.json()).object, "response");

      const del = await handleProxyRequest(
        new Request(`${PROXY_ORIGIN}/gpt/v1/responses/resp_1`, {
          method: "DELETE",
          headers: { authorization: "Bearer test-key" },
        }),
        makeOptions(),
      );
      assert.equal(calls[1].url, "https://api.openai.com/v1/responses/resp_1");
      assert.equal(calls[1].method, "DELETE");
      assert.equal(del.status, 200);
    },
  );
});

test("Responses：openai-beta / organization / project / idempotency-key 透传", async () => {
  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await handleProxyRequest(
      proxyRequest("/gpt/v1/responses", {
        headers: {
          "openai-beta": "responses=2025-03-11",
          "openai-organization": "org_1",
          "openai-project": "proj_1",
          "idempotency-key": "idem_1",
        },
        body: { model: "gpt-5.1", input: "hi" },
      }),
      makeOptions(),
    );

    assert.equal(calls[0].headers["openai-beta"], "responses=2025-03-11");
    assert.equal(calls[0].headers["openai-organization"], "org_1");
    assert.equal(calls[0].headers["openai-project"], "proj_1");
    assert.equal(calls[0].headers["idempotency-key"], "idem_1");
  });
});

test("Responses：SSE 事件原样透传，不注入 Chat 的 finish_reason / [DONE]", async () => {
  const sse =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n';

  await withUpstream(sseUpstream(sse), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/gpt/v1/responses", {
        body: { model: "gpt-5.1", input: "hi", stream: true },
      }),
      makeOptions(),
    );

    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.equal(text, sse);
    assert.ok(!text.includes("finish_reason"));
    assert.ok(!text.includes("data: [DONE]"));
  });
});

test("Responses：流式请求上游返回 JSON 时原样返回，不合成 Chat SSE", async () => {
  const responseBody = {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [],
  };

  await withUpstream(() => jsonResponse(responseBody), async () => {
    const res = await handleProxyRequest(
      proxyRequest("/gpt/v1/responses", {
        body: { model: "gpt-5.1", input: "hi", stream: true },
      }),
      makeOptions(),
    );

    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), responseBody);
  });
});

test("Chat Completions：同一 provider 基址仍然原样支持", async () => {
  await withUpstream(() => jsonResponse({ choices: [] }), async (calls) => {
    const res = await handleProxyRequest(
      proxyRequest("/gpt/v1/chat/completions", {
        body: { model: "gpt-5.1", messages: [] },
      }),
      makeOptions(),
    );

    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(res.status, 200);
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
      proxyRequest("/opencode/v1/chat/completions", {
        body: {
          model: "glm-5",
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
        proxyRequest("/opencode/v1/chat/completions", {
          body: { model: "glm-5", ...body },
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
    const send = (headers, path = "/opencode/v1/chat/completions") =>
      handleProxyRequest(
        proxyRequest(path, {
          headers,
          body: {
            model: "glm-5",
            messages: [{ role: "user", content: "你好" }],
          },
        }),
        makeOptions(),
      );

    // opencode 作为自定义 provider 接入时只发 x-session-id（值本身合法）→ 沿用
    await send({ "x-session-id": clientSession });
    assert.equal(calls[0].headers["x-session-id"], clientSession);
    assert.equal(calls[0].headers["x-opencode-session"], clientSession);

    // 非 OpenCode 格式的会话值（其它客户端的 uuid）不能满足免费模型校验 → 派生
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
