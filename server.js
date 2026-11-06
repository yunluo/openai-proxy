// 境内自建网关入口（Bun）：同一份 src/core.js，跑在境内机器上绕开
// 「客户端 → Cloudflare 境外 PoP → Worker → 大陆上游」的绕行路径。
//
// 背景：Cloudflare 在大陆无执行点，大陆客户端的请求会被调度到境外 PoP
// （实测本机固定落到 AMS 阿姆斯特丹），长流式响应在这段绕行链路上被
// 概率性切断（走 CF 网关成功率约 30-60%，直连上游 100%）。把同一份
// 代理代码跑在境内任意一台机器上，这段绕行即消失。
//
// 用法：
//   bun server.js
//   PORT=9000 bun server.js
//
// 环境变量与 Workers 部署完全一致（key 由客户端 Authorization 透传，
// 这里无需配置）：
//   PROXY_ACCESS_TOKEN      可选访问口令（x-proxy-token 头）
//   UPSTREAM_TIMEOUT_MS     等上游响应头超时（默认 300000）
//   STREAM_IDLE_TIMEOUT_MS  流式空闲超时（默认 120000，0 不限制）
//   MINIMAX_API_BASE / GLM_API_BASE / …  各 provider 基址覆盖
//   CUSTOM_PROVIDER_1_NAME / CUSTOM_PROVIDER_1_API_BASE  自定义 provider
//
// 监听地址默认 0.0.0.0:8787；只用本机可设 BIND=127.0.0.1。

import { handleProxyRequest, getStreamDiagnostics } from "./src/core.js";
import { buildOptions, withCORS } from "./workers/index.js";

const PORT = Number(process.env.PORT || 8787);
const BIND = process.env.BIND || "0.0.0.0";

const options = buildOptions(process.env);

// 预检与调试端点同 Workers 入口
function route(request) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }
  if (request.method === "GET" && url.pathname === "/v1/debug/stream-ends") {
    const diagnostics = getStreamDiagnostics();
    // 自建环境没有 request.cf；报本机进程信息以便区分实例
    diagnostics.executionColo = `local:${process.platform}`;
    return new Response(JSON.stringify(diagnostics), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

Bun.serve({
  port: PORT,
  hostname: BIND,
  idleTimeout: 255, // Bun 的空闲超时上限（秒）：长流式响应不能被服务器提前掐断
  async fetch(request) {
    const preHandled = route(request);
    if (preHandled) return withCORS(preHandled);
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
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
  },
});

console.log(`[maxapi-local] listening on http://${BIND}:${PORT}`);
console.log(
  `[maxapi-local] 用法示例：GET http://127.0.0.1:${PORT}/v1/models  |  POST http://127.0.0.1:${PORT}/glm_cp/v1/chat/completions`,
);
