import { handleProxyRequest } from "../src/core.js";
import { API_BASE_WWW, PROVIDERS } from "../src/config.js";

// 从环境变量中加载自定义服务商配置（最多 100 个）
// 名称只允许 [a-z0-9_-]，避免 __proto__ 之类会污染对象原型的名字
const CUSTOM_PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function loadCustomProviders(env) {
  const providers = Object.create(null);
  let i = 1;
  while (i <= 100) {
    const name = env[`CUSTOM_PROVIDER_${i}_NAME`];
    const apiBase = env[`CUSTOM_PROVIDER_${i}_API_BASE`];
    if (!name || !apiBase) break;
    const key = String(name).toLowerCase();
    if (CUSTOM_PROVIDER_NAME_RE.test(key)) {
      providers[key] = { apiBase };
    }
    i++;
  }
  return providers;
}

// 组装 provider 配置
function buildOptions(env) {
  return {
    providers: {
      ...Object.fromEntries(
        Object.entries(PROVIDERS).map(([name, cfg]) => [
          name,
          { apiBase: env[cfg.envVar] || cfg.default },
        ]),
      ),
      ...loadCustomProviders(env),
    },
    apiBaseWww: env.MINIMAX_API_BASE_WWW || API_BASE_WWW,
  };
}

// CORS 头常量
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-opencode-session, x-session-id, x-session-affinity, HTTP-Referer, X-Title",
  "Access-Control-Expose-Headers":
    "x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset",
};

// 安全地为 Response 添加 CORS 头
// 对于 fetch 返回的响应，headers 可能是只读的，需要重建 Response
// 对于我们创建的响应，headers 可直接修改
function withCORS(response) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// Cloudflare Workers 入口
// 原生 Web Standard API，request 直接传入 core.js
export default {
  async fetch(request, env) {
    // OPTIONS 预检请求直接返回
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    const options = buildOptions(env);

    try {
      return withCORS(await handleProxyRequest(request, options));
    } catch (error) {
      console.error("LLM Proxy Error:", error);
      return withCORS(
        new Response(
          JSON.stringify({
            error: {
              type: "internal_error",
              message:
                error instanceof Error
                  ? error.message
                  : "An error occurred while processing your request.",
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
  },
};
