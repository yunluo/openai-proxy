import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/index.js";

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withUpstream(responder, fn) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method });
    return typeof responder === "function" ? responder(url, init) : responder;
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ──────────────────────────────────────────────
// Cloudflare Workers 适配器
// ──────────────────────────────────────────────

test("Workers: 请求被代理并附加 CORS 头", async () => {
  await withUpstream(() => jsonResponse({ ok: true }), async (calls) => {
    const req = new Request("https://proxy.example/glm/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    const res = await worker.fetch(req, {});
    assert.equal(calls[0].url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("Workers: 自定义 Provider 生效，非法名字被忽略", async () => {
  const env = {
    CUSTOM_PROVIDER_1_NAME: "Mole",
    CUSTOM_PROVIDER_1_API_BASE: "https://api.mole.ai",
    CUSTOM_PROVIDER_2_NAME: "__proto__",
    CUSTOM_PROVIDER_2_API_BASE: "https://evil.example",
  };

  await withUpstream(() => jsonResponse({ ok: true }), async (calls) => {
    const res = await worker.fetch(
      new Request("https://proxy.example/mole/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(calls[0].url, "https://api.mole.ai/chat/completions");

    const evil = await worker.fetch(
      new Request("https://proxy.example/__proto__/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      }),
      env,
    );
    assert.equal(evil.status, 404);
  });
});

test("Workers: OPTIONS 预检返回 CORS 且不请求上游", async () => {
  await withUpstream(() => jsonResponse({ ok: true }), async (calls) => {
    const res = await worker.fetch(
      new Request("https://proxy.example/v1/chat/completions", { method: "OPTIONS" }),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
    assert.ok(
      res.headers.get("access-control-allow-headers").includes("x-opencode-session"),
    );
  });
});

test("Workers: SSE 响应原样透传，且保留上游响应头", async () => {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";

  await withUpstream(
    () =>
      new Response(sse, {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req_9",
        },
      }),
    async () => {
      const res = await worker.fetch(
        new Request("https://proxy.example/deepseek/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer k", "content-type": "application/json" },
          body: JSON.stringify({ model: "m", stream: true }),
        }),
        {},
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.equal(res.headers.get("x-request-id"), "req_9");
      assert.equal(await res.text(), sse);
    },
  );
});
