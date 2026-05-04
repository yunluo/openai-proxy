import { handleProxyRequest } from "../src/core.js";
import { API_BASE, API_BASE_WWW, PROVIDERS } from "../src/config.js";

// 从环境变量中加载自定义服务商配置（最多 100 个）
function loadCustomProviders(envSource) {
  const providers = {};
  let i = 1;
  while (i <= 100) {
    const name = envSource[`CUSTOM_PROVIDER_${i}_NAME`];
    const apiBase = envSource[`CUSTOM_PROVIDER_${i}_API_BASE`];
    if (!name || !apiBase) break;
    providers[name.toLowerCase()] = { apiBase };
    i++;
  }
  return providers;
}

// 组装 provider 配置（环境变量优先，否则使用默认值）
function buildOptions(envSource) {
  return {
    providers: {
      ...Object.fromEntries(
        Object.entries(PROVIDERS).map(([name, cfg]) => [
          name,
          { apiBase: envSource[cfg.envVar] || cfg.default },
        ]),
      ),
      ...loadCustomProviders(envSource),
    },
    apiBaseWww: envSource.MINIMAX_API_BASE_WWW || API_BASE_WWW,
  };
}

// Vercel Serverless Function 入口
// 接收 Node.js 的 IncomingMessage，转换为 Web Request 后调用 core.js
export default async function handler(req, res) {
  // 设置 CORS 跨域头
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key",
  );

  // OPTIONS 预检请求直接返回
  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const options = buildOptions(process.env);

  try {
    const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");

    // 读取 Node.js 原始请求体（仅 POST/PUT/PATCH）
    const body = hasBody
      ? await new Promise((resolve) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks)));
        })
      : undefined;

    // 转换 Node.js headers 为标准格式（兼容数组值）
    const headerEntries = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headerEntries[key] = Array.isArray(value)
          ? value.join(", ")
          : String(value);
      }
    }

    // 构建 Web Standard Request，使 core.js 在不同平台行为一致
    const webRequest = new Request(
      new URL(req.url ?? "/", "http://localhost").href,
      {
        method: req.method,
        headers: headerEntries,
        body,
      },
    );

    const response = await handleProxyRequest(webRequest, options);

    // 将 Response 的状态和头信息写回 Node.js 响应
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const data = await response.text();
    res.end(data);
  } catch (error) {
    console.error("LLM Proxy Error:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          type: "internal_error",
          message:
            error instanceof Error
              ? error.message
              : "An error occurred while processing your request.",
        },
      }),
    );
  }
}
