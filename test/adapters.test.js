import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import vercelHandler from "../vercel/index.js";
import worker from "../workers/index.js";

// ──────────────────────────────────────────────
// 模拟 Node.js 的 IncomingMessage / ServerResponse
// ──────────────────────────────────────────────

function mockReq({ method = "POST", url = "/v1/chat/completions", headers = {}, body } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = headers;
  queueMicrotask(() => {
    if (body !== undefined) req.push(Buffer.from(body));
    req.push(null);
  });
  return req;
}

function mockRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headersSent: false,
    ended: false,
    _headers: {},
    setHeader(key, value) {
      this._headers[key.toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      this.headersSent = true;
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      this.headersSent = true;
      this.ended = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

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
// Vercel 适配器
// ──────────────────────────────────────────────

test("Vercel: JSON 代理请求写回状态码、CORS 与响应体", async () => {
  await withUpstream(() => jsonResponse({ ok: true }), async (calls) => {
    const req = mockReq({
      url: "/deepseek/v1/chat/completions",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const res = mockRes();
    await vercelHandler(req, res);

    assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(res.statusCode, 200);
    assert.equal(res._headers["access-control-allow-origin"], "*");
    assert.deepEqual(JSON.parse(res.text()), { ok: true });
  });
});

test("Vercel: OPTIONS 预检直接返回，不请求上游", async () => {
  await withUpstream(() => jsonResponse({ ok: true }), async (calls) => {
    const res = mockRes();
    await vercelHandler(mockReq({ method: "OPTIONS" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 0);
    assert.ok(res._headers["access-control-allow-headers"].includes("x-opencode-session"));
  });
});

test("Vercel: SSE 响应逐块写回，且保留上游响应头", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' + "data: [DONE]\n\n";
  await withUpstream(
    () =>
      new Response(sse, {
        headers: { "content-type": "text/event-stream", "x-request-id": "req_9" },
      }),
    async () => {
      const res = mockRes();
      await vercelHandler(
        mockReq({
          url: "/deepseek/v1/chat/completions",
          headers: { authorization: "Bearer k", "content-type": "application/json" },
          body: JSON.stringify({ model: "m", stream: true }),
        }),
        res,
      );
      assert.equal(res.text(), sse);
      assert.equal(res._headers["x-request-id"], "req_9");
      assert.equal(res.ended, true);
    },
  );
});

test("Vercel: 上游错误状态码与 Retry-After 原样返回", async () => {
  await withUpstream(
    () => jsonResponse({ error: { message: "slow" } }, 429, { "retry-after": "9" }),
    async () => {
      const res = mockRes();
      await vercelHandler(
        mockReq({
          url: "/v1/chat/completions",
          headers: { authorization: "Bearer k", "content-type": "application/json" },
          body: JSON.stringify({ model: "m" }),
        }),
        res,
      );
      assert.equal(res.statusCode, 429);
      assert.equal(res._headers["retry-after"], "9");
    },
  );
});

test("Vercel: fetch 抛错时返回 500 JSON", async () => {
  const originalError = console.error;
  console.error = () => {}; // 该用例故意触发 500，屏蔽预期内的日志
  try {
    await withUpstream(
      () => {
        throw new Error("socket hang up");
      },
      async () => {
        const res = mockRes();
        await vercelHandler(
          mockReq({
            url: "/v1/chat/completions",
            headers: { authorization: "Bearer k", "content-type": "application/json" },
            body: JSON.stringify({ model: "m" }),
          }),
          res,
        );
        assert.equal(res.statusCode, 500);
        assert.equal(JSON.parse(res.text()).error.type, "internal_error");
      },
    );
  } finally {
    console.error = originalError;
  }
});

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
