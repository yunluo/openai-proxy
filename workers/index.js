import { handleProxyRequest } from "../src/core.js";
import { API_BASE, API_BASE_WWW, PROVIDERS } from "../src/config.js";

// 从环境变量中加载自定义服务商配置（最多 100 个）
function loadCustomProviders(env) {
  const providers = {};
  let i = 1;
  while (i <= 100) {
    const name = env[`CUSTOM_PROVIDER_${i}_NAME`];
    const apiBase = env[`CUSTOM_PROVIDER_${i}_API_BASE`];
    if (!name || !apiBase) break;
    providers[name.toLowerCase()] = { apiBase };
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

// Cloudflare Workers 入口
// 原生 Web Standard API，request 直接传入 core.js
export default {
  async fetch(request, env) {
    // 设置 CORS 跨域头
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-api-key",
        },
      });
    }

    const options = buildOptions(env);

    try {
      // 直接返回 Web Response，Cloudflare Workers 原生支持
      return await handleProxyRequest(request, options);
    } catch (error) {
      console.error("LLM Proxy Error:", error);
      return new Response(
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
      );
    }
  },
};
