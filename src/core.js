// 从 headers 对象中安全地获取指定字段（兼容 Headers 对象和普通对象）
function getHeader(headers, name) {
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  return headers[name] || headers[name.toLowerCase()];
}

// 从请求中解析 JSON 请求体（兼容 Web Request 和普通对象）
async function getRequestBody(request) {
  if (request.body && typeof request.json === "function") {
    return await request.json().catch(() => ({}));
  }
  if (request.body && typeof request.body === "object") {
    return request.body;
  }
  return {};
}

// 根据请求路径解析出目标 provider 和实际请求路径
function resolveProvider(originalPath, options) {
  // /token_plan/* → 走 MiniMax 官网套餐接口
  if (originalPath.startsWith("/token_plan")) {
    const strippedPath = originalPath.replace(/^\/token_plan/, "");
    return {
      provider: "minimax",
      targetBase: options.apiBaseWww,
      strippedPath,
    };
  }

  // 匹配 /{provider}/{version}/{path} 格式，如 /deepseek/v1/chat/completions
  const match = originalPath.match(/^\/([^/]+)(\/v\d+)?(\/.*)?$/);
  if (match) {
    const providerName = match[1].toLowerCase();
    const strippedPath = match[3] || ""; // 去掉 provider 前缀后的实际路径

    const provider = options.providers?.[providerName];
    if (provider) {
      return {
        provider: providerName,
        targetBase: provider.apiBase,
        strippedPath,
      };
    }

    return { error: true, message: `Unknown provider: ${providerName}` };
  }

  // 无 provider 前缀时，默认走 MiniMax
  return {
    provider: "minimax",
    targetBase: options.providers?.minimax?.apiBase,
    strippedPath: originalPath,
  };
}

export async function handleProxyRequest(request, options = {}) {
  const headers = {
    "Content-Type": "application/json",
  };

  // 统一处理相对路径（Vercel）和完整 URL（Cloudflare Workers）
  const urlPath = new URL(request.url, "http://localhost").pathname;
  const originalPath = urlPath || "/chat/completions";

  // 从请求头中提取 API Key
  const apiKey =
    getHeader(request.headers, "authorization")?.replace("Bearer ", "") ||
    getHeader(request.headers, "x-api-key");

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message:
            "API key is required. Please provide via Authorization header or X-API-Key header.",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  headers["Authorization"] = `Bearer ${apiKey}`;

  // 解析目标 provider 和实际路径
  const resolved = resolveProvider(originalPath, options);

  if (resolved.error) {
    return new Response(
      JSON.stringify({
        error: {
          type: "not_found",
          message: resolved.message,
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!resolved.targetBase) {
    return new Response(
      JSON.stringify({
        error: {
          type: "not_found",
          message: "Provider base URL not configured",
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // 拼接目标 URL = provider 的基础地址 + 实际请求路径
  const targetUrl = `${resolved.targetBase}${resolved.strippedPath}`;

  // 读取请求体（仅 POST/PUT/PATCH）
  let body = null;
  let requestBodyObj = {};
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    requestBodyObj = await getRequestBody(request);
    body = JSON.stringify(requestBodyObj);
  }

  // 转发请求到目标 API
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: headers,
    body: body,
  });

  const contentType = response.headers.get("content-type");
  const isStreaming = requestBodyObj.stream !== false;

  // SSE 流式响应 → 直接透传
  if (isStreaming && contentType?.includes("text/event-stream")) {
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // JSON 响应 → 处理后再返回
  if (contentType && contentType.includes("application/json")) {
    const data = await response.json();

    // DeepSeek 特殊处理：补全缺失的 reasoning_content 字段
    if (resolved.provider === "deepseek" && data.choices?.[0]?.message) {
      const msg = data.choices[0].message;
      if (!("reasoning_content" in msg)) {
        Object.defineProperty(msg, "reasoning_content", {
          value: null,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 其他类型（如纯文本）→ 直接透传
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: { "Content-Type": contentType || "text/plain" },
  });
}
