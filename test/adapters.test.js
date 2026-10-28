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

test("Workers: Responses 使用厂商独立的 Responses 基址", async () => {
  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    const res = await worker.fetch(
      new Request("https://proxy.example/glm/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.3", input: "hi" }),
      }),
      {},
    );

    assert.equal(res.status, 200);
    assert.equal(calls[0].url, "https://open.bigmodel.cn/api/v1/responses");
  });
});

test("Workers: glm_cp Responses 默认使用标准 /api/v1，Chat 仍走编程套餐", async () => {
  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/glm_cp/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.3", input: "hi" }),
      }),
      {},
    );

    assert.equal(calls[0].url, "https://open.bigmodel.cn/api/v1/responses");
  });

  await withUpstream(() => jsonResponse({ choices: [] }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/glm_cp/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.3", messages: [] }),
      }),
      {},
    );

    assert.equal(
      calls[0].url,
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    );
  });
});

test("Workers: GLM_CP_RESPONSES_API_BASE 可覆盖编程套餐 Responses 基址", async () => {
  const env = { GLM_CP_RESPONSES_API_BASE: "https://glm-cp.example/api/v1" };

  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/glm_cp/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.3", input: "hi" }),
      }),
      env,
    );

    assert.equal(calls[0].url, "https://glm-cp.example/api/v1/responses");
  });
});

test("Workers: *_RESPONSES_API_BASE 可覆盖 Responses 基址", async () => {
  const env = { GLM_RESPONSES_API_BASE: "https://glm-gateway.example/api/v1" };

  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/glm/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.3", input: "hi" }),
      }),
      env,
    );

    assert.equal(
      calls[0].url,
      "https://glm-gateway.example/api/v1/responses",
    );
  });
});

test("Workers: 只覆盖 Chat 基址时，Responses 复用同一个自定义网关", async () => {
  const env = { GLM_API_BASE: "https://glm-chat.example/api/paas/v4" };

  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/glm/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "glm-5.3", input: "hi" }),
      }),
      env,
    );

    assert.equal(
      calls[0].url,
      "https://glm-chat.example/api/paas/v4/responses",
    );
  });
});

test("Workers: 把 Chat 基址显式设为默认值时，Responses 仍使用同一个编程套餐基址", async () => {
  const env = {
    VOLCENGINE_API_BASE: "https://ark.cn-beijing.volces.com/api/coding/v3",
  };

  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/volcengine/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "doubao-seed-2-1-pro-260915",
          input: "hi",
        }),
      }),
      env,
    );

    assert.equal(
      calls[0].url,
      "https://ark.cn-beijing.volces.com/api/coding/v3/responses",
    );
  });
});

test("Workers: 自定义 Provider 可单独配置 Responses 基址", async () => {
  const env = {
    CUSTOM_PROVIDER_1_NAME: "mole",
    CUSTOM_PROVIDER_1_API_BASE: "https://api.mole.ai/v1",
    CUSTOM_PROVIDER_1_RESPONSES_API_BASE: "https://api.mole.ai/responses-api",
  };

  await withUpstream(() => jsonResponse({ id: "resp_1" }), async (calls) => {
    await worker.fetch(
      new Request("https://proxy.example/mole/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "m", input: "hi" }),
      }),
      env,
    );

    assert.equal(calls[0].url, "https://api.mole.ai/responses-api/responses");
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

// AI 网关严禁缓存：所有出口响应（含上游响应、OPTIONS、SSE）都必须强制 no-store，
// 且上游自带的可缓存 Cache-Control 必须被覆盖
test("Workers: 响应强制禁缓存，覆盖上游可缓存的 Cache-Control", async () => {
  await withUpstream(
    () =>
      jsonResponse({ ok: true }, 200, {
        "cache-control": "public, max-age=3600",
      }),
    async () => {
      const res = await worker.fetch(
        new Request("https://proxy.example/glm/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer k", "content-type": "application/json" },
          body: JSON.stringify({ model: "m" }),
        }),
        {},
      );
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.equal(res.headers.get("cdn-cache-control"), "no-store");
      assert.equal(
        res.headers.get("cloudflare-cdn-cache-control"),
        "no-store",
      );
    },
  );
});

test("Workers: SSE 流式响应也带禁缓存头", async () => {
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n';
  await withUpstream(
    () =>
      new Response(sse, {
        headers: { "content-type": "text/event-stream" },
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
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.equal(res.headers.get("cdn-cache-control"), "no-store");
    },
  );
});

test("Workers: OPTIONS 预检同样带禁缓存头", async () => {
  const res = await worker.fetch(
    new Request("https://proxy.example/v1/models", { method: "OPTIONS" }),
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("cdn-cache-control"), "no-store");
});
