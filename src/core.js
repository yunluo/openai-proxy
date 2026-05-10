// 从 headers 对象中安全地获取指定字段（兼容 Headers 对象和普通对象）
function getHeader(headers, name) {
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
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

// 将 Anthropic Content Block 数组提取为纯文本
function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ──────────────────────────────────────────────
// Anthropic Messages API → OpenAI Chat Completions API 格式转换
// ──────────────────────────────────────────────
function anthropicToOpenAI(anthropicBody) {
  const openaiBody = {
    model: anthropicBody.model,
    messages: [],
  };

  // 基础参数映射
  if (anthropicBody.max_tokens != null)
    openaiBody.max_tokens = anthropicBody.max_tokens;
  if (anthropicBody.temperature != null)
    openaiBody.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p != null) openaiBody.top_p = anthropicBody.top_p;
  if (anthropicBody.stop_sequences != null)
    openaiBody.stop = anthropicBody.stop_sequences;
  if (anthropicBody.stream != null) openaiBody.stream = anthropicBody.stream;

  // System prompt: Anthropic 顶层 → OpenAI system message
  if (anthropicBody.system) {
    const systemContent =
      typeof anthropicBody.system === "string"
        ? anthropicBody.system
        : anthropicBody.system
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (systemContent) {
      openaiBody.messages.push({ role: "system", content: systemContent });
    }
  }

  // 消息转换
  for (const msg of anthropicBody.messages || []) {
    if (typeof msg.content === "string") {
      openaiBody.messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      openaiBody.messages.push({
        role: msg.role,
        content: msg.content || "",
      });
      continue;
    }

    // 分类 content blocks
    const textParts = [];
    const imageParts = [];
    const toolResults = [];
    const toolUses = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block);
      } else if (block.type === "image" && block.source) {
        imageParts.push(block);
      } else if (block.type === "tool_result") {
        toolResults.push(block);
      } else if (block.type === "tool_use") {
        toolUses.push(block);
      }
      // 忽略 thinking / redacted_thinking / cache_control 等不支持的类型
    }

    if (msg.role === "user") {
      // 用户消息：文本+图片 → user 消息；tool_result → tool 消息（多条）

      // 构造 user 消息（文本 + 图片）
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          // 包含图片时使用 OpenAI 多模态格式
          const content = [];
          for (const tp of textParts)
            content.push({ type: "text", text: tp.text });
          for (const img of imageParts) {
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${img.source.media_type};base64,${img.source.data}`,
              },
            });
          }
          openaiBody.messages.push({ role: "user", content });
        } else {
          openaiBody.messages.push({
            role: "user",
            content: textParts.map((b) => b.text).join("\n"),
          });
        }
      }

      // 每个 tool_result 生成一条独立的 tool 消息
      for (const tr of toolResults) {
        openaiBody.messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: extractTextFromContent(tr.content),
        });
      }
    } else if (msg.role === "assistant") {
      // 助手消息：文本 + tool_use → assistant 消息
      const openaiMsg = { role: "assistant" };

      if (toolUses.length > 0) {
        openaiMsg.content = textParts.map((b) => b.text).join("\n") || null;
        openaiMsg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }));
      } else if (textParts.length > 0) {
        openaiMsg.content = textParts.map((b) => b.text).join("\n");
      } else {
        openaiMsg.content = null;
      }

      openaiBody.messages.push(openaiMsg);
    } else {
      // 其他角色（system 等）直接透传
      const content = textParts.map((b) => b.text).join("\n") || "";
      openaiBody.messages.push({ role: msg.role, content });
    }
  }

  // Tools 转换
  if (anthropicBody.tools) {
    openaiBody.tools = anthropicBody.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Tool choice 转换
  if (anthropicBody.tool_choice) {
    const tc = anthropicBody.tool_choice;
    if (tc.type === "auto") {
      openaiBody.tool_choice = "auto";
    } else if (tc.type === "any") {
      openaiBody.tool_choice = "required";
    } else if (tc.type === "tool") {
      openaiBody.tool_choice = {
        type: "function",
        function: { name: tc.name },
      };
    }
    // tc.type === "none" → OpenAI 不需要显式设置（默认行为）
  }

  return openaiBody;
}

// ──────────────────────────────────────────────
// OpenAI Chat Completions 响应 → Anthropic Messages 响应 格式转换
// ──────────────────────────────────────────────
function openAIToAnthropic(data, requestModel) {
  const choice = data.choices?.[0];
  const message = choice?.message || {};

  const content = [];

  // 文本内容 → text block
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  // Tool calls → tool_use blocks
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch (_) {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: input,
      });
    }
  }

  // 保证至少一个内容块（Anthropic API 要求）
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  // 确定 stop_reason
  let stopReason = "end_turn";
  if (choice?.finish_reason === "tool_calls") {
    stopReason = "tool_use";
  } else if (choice?.finish_reason === "length") {
    stopReason = "max_tokens";
  } else if (
    choice?.finish_reason === "stop" ||
    choice?.finish_reason == null
  ) {
    stopReason = "end_turn";
  }

  return {
    id: data.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    content: content,
    model: data.model || requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// ──────────────────────────────────────────────
// OpenAI SSE 流 → Anthropic SSE 流式转换（异步生成器）
// 支持 text content 和 tool_calls 的流式输出
//
// 架构设计：
// - try/catch 负责 SSE 数据解析的错误容忍
// - 流结束事件在 try 块末尾自然发出（不依赖 finally 中的 yield）
// - ReadableStream 消费端用 try/finally 确保 reader.releaseLock()
// ──────────────────────────────────────────────
async function* openAIStreamToAnthropicSSE(reader, requestModel) {
  const decoder = new TextDecoder();
  let buffer = "";
  let messageId = "msg_" + Date.now();
  let model = requestModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;
  let hasStarted = false;

  // 文本块追踪
  let textBlockOpen = false;
  let textBlockIndex = -1;

  // 内容块索引分配器
  let nextBlockIndex = 0;

  // Tool call 状态追踪：OpenAI tool_call index → Anthropic 内容块索引
  const toolCallBlockMap = new Map();

  // ──── 阶段一：读取并转换 SSE 数据 ────

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (_) {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        // 事件：message_start（首个有效 chunk 时发出）
        if (!hasStarted) {
          if (chunk.model) model = chunk.model;
          if (chunk.usage?.prompt_tokens)
            inputTokens = chunk.usage.prompt_tokens;
          messageId = chunk.id || messageId;

          yield `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          })}\n\n`;

          hasStarted = true;
        }

        // 事件：文本内容增量
        if (delta.content != null && delta.content !== "") {
          // 打开文本块（如果尚未打开）
          if (!textBlockOpen) {
            textBlockOpen = true;
            textBlockIndex = nextBlockIndex;
            nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: textBlockIndex,
              content_block: { type: "text", text: "" },
            })}\n\n`;
          }

          yield `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: delta.content },
          })}\n\n`;
        }

        // 事件：Tool call 增量
        if (delta.tool_calls) {
          // 关闭文本块（如果有），因为接下来要发 tool_use 块
          if (textBlockOpen) {
            textBlockOpen = false;
            yield `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: textBlockIndex,
            })}\n\n`;
          }

          for (const tc of delta.tool_calls) {
            const tcIndex = tc.index ?? toolCallBlockMap.size;

            if (!toolCallBlockMap.has(tcIndex)) {
              // 新的 tool call → 打开新的 tool_use 内容块
              const blockIndex = nextBlockIndex;
              const id = tc.id || `toolu_${Date.now()}_${tcIndex}`;
              const name = tc.function?.name || "";
              toolCallBlockMap.set(tcIndex, {
                blockIndex,
                id,
                name,
              });
              nextBlockIndex++;

              yield `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIndex,
                content_block: {
                  type: "tool_use",
                  id: id,
                  name: name,
                },
              })}\n\n`;

              // 首个 chunk 可能包含部分 arguments
              if (tc.function?.arguments) {
                yield `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: tc.function.arguments,
                  },
                })}\n\n`;
              }
            } else {
              // 续传 tool call arguments
              const state = toolCallBlockMap.get(tcIndex);
              if (tc.function?.arguments) {
                yield `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: state.blockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: tc.function.arguments,
                  },
                })}\n\n`;
              }
            }
          }
        }

        // Usage 追踪
        if (chunk.usage?.completion_tokens)
          outputTokens = chunk.usage.completion_tokens;
        if (chunk.usage?.prompt_tokens && inputTokens === 0)
          inputTokens = chunk.usage.prompt_tokens;

        // Finish reason 追踪
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }
  } catch (error) {
    // 流式处理中的异常：不做 yield，仅记录错误信息
    // 清理事件将由 finally 之后的阶段二发出
    // 异常情况下 stopReason 保持默认 "end_turn"，finishReason 保持已记录值
  }

  // ──── 阶段二：发出 Anthropic 协议要求的结束事件 ────
  // 注意：这些 yield 代码在 try 块之外，不属于 try/finally 范围，
  // 因此在生成器被正常消费时会可靠执行。

  if (!hasStarted) {
    // 极端情况：未收到任何有效的 SSE 数据，发出一条最小化响应
    yield `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`;

    yield `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`;

    yield `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "" },
    })}\n\n`;

    yield `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`;

    yield `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    })}\n\n`;

    yield `event: message_stop\ndata: ${JSON.stringify({
      type: "message_stop",
    })}\n\n`;
    return;
  }

  // 关闭文本块（如果仍打开）
  if (textBlockOpen) {
    textBlockOpen = false;
    yield `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: textBlockIndex,
    })}\n\n`;
  }

  // 关闭所有 tool_use 内容块
  for (const [, state] of toolCallBlockMap) {
    yield `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: state.blockIndex,
    })}\n\n`;
  }

  // 确定 stop_reason（异常时视为 end_turn）
  let stopReason = "end_turn";
  if (finishReason === "tool_calls") stopReason = "tool_use";
  else if (finishReason === "length") stopReason = "max_tokens";

  // 事件：message_delta（最终 stop_reason + output token 数）
  yield `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })}\n\n`;

  // 事件：message_stop
  yield `event: message_stop\ndata: ${JSON.stringify({
    type: "message_stop",
  })}\n\n`;
}

// ──────────────────────────────────────────────
// 根据请求路径解析出目标 provider 和实际请求路径
// ──────────────────────────────────────────────
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

    // 路径以 /v{数字} 开头（如 /v1/chat/completions）→ 默认走 MiniMax
    if (/^v\d+$/.test(providerName)) {
      return {
        provider: "minimax",
        targetBase: options.providers?.minimax?.apiBase,
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

// ──────────────────────────────────────────────
// 主代理请求处理函数
// ──────────────────────────────────────────────
export async function handleProxyRequest(request, options = {}) {
  // 统一处理相对路径（Vercel）和完整 URL（Cloudflare Workers）
  const parsedUrl = new URL(request.url, "http://localhost");
  const originalPath = parsedUrl.pathname;
  const search = parsedUrl.search; // preserve query string

  // 从请求头中提取 API Key（兼容 OpenAI Bearer 和 Anthropic x-api-key）
  const authHeader = getHeader(request.headers, "authorization");
  const apiKey =
    authHeader?.replace(/^Bearer\s+/i, "") ||
    authHeader ||
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

  // 是否为需要 Anthropic → OpenAI 格式互转的 opencode_anthropic
  const isOpenCodeAnthropic = resolved.provider === "opencode_anthropic";

  // 构建转发请求头（根据目标 provider 类型选择认证方式）
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenCodeAnthropic) {
    // OpenCode Go Anthropic：转换为 OpenAI 格式后使用 Bearer 认证
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (resolved.provider.endsWith("_anthropic")) {
    // 其他 Anthropic 原生端点（minimax_anthropic, deepseek_anthropic）：透传 x-api-key
    headers["x-api-key"] = apiKey;
    const anthropicVersion = getHeader(request.headers, "anthropic-version");
    if (anthropicVersion) {
      headers["anthropic-version"] = anthropicVersion;
    }
    const anthropicBeta = getHeader(request.headers, "anthropic-beta");
    if (anthropicBeta) {
      headers["anthropic-beta"] = anthropicBeta;
    }
    const anthropicDangerous = getHeader(
      request.headers,
      "anthropic-dangerous-direct-browser-access",
    );
    if (anthropicDangerous) {
      headers["anthropic-dangerous-direct-browser-access"] = anthropicDangerous;
    }
  } else {
    // OpenAI 兼容端点：使用 Authorization Bearer 认证
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // 读取请求体（非 GET/HEAD 方法）
  let body = null;
  let requestBodyObj = {};
  if (!["GET", "HEAD"].includes(request.method)) {
    requestBodyObj = await getRequestBody(request);
    body = JSON.stringify(requestBodyObj);
  }

  // opencode_anthropic：Anthropic → OpenAI 格式转换
  if (isOpenCodeAnthropic && body) {
    requestBodyObj = anthropicToOpenAI(requestBodyObj);
    body = JSON.stringify(requestBodyObj);
  }

  // opencode_anthropic：路径转换 /messages → /chat/completions
  let targetPath = resolved.strippedPath;
  if (isOpenCodeAnthropic) {
    targetPath = targetPath.replace(/\/messages$/, "/chat/completions");
  }

  // 拼接目标 URL = provider 的基础地址 + 实际请求路径
  const targetUrl = `${resolved.targetBase}${targetPath}${search}`;

  // 转发请求到目标 API
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: headers,
    body: body,
  });

  const contentType = response.headers.get("content-type");
  const isStreaming = requestBodyObj.stream === true;

  // ──── 流式响应处理 ────
  if (
    isStreaming &&
    contentType?.includes("text/event-stream") &&
    response.body
  ) {
    if (isOpenCodeAnthropic) {
      // OpenCode Anthropic：OpenAI SSE → Anthropic SSE 流式转换
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of openAIStreamToAnthropicSSE(
              reader,
              requestBodyObj.model,
            )) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          } catch (error) {
            // 尝试发送 Anthropic 格式错误事件
            try {
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({
                    type: "error",
                    error: {
                      type: "api_error",
                      message: "Stream processing error",
                    },
                  })}\n\n`,
                ),
              );
            } catch (_) {
              // 无法写入，跳过
            }
            try {
              controller.error(error);
            } catch (_) {
              // controller 可能已关闭
            }
          } finally {
            reader.releaseLock();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 其他 provider：直接透传 SSE 流
    const streamHeaders = new Headers(response.headers);
    streamHeaders.set("Content-Type", "text/event-stream");
    streamHeaders.set("Cache-Control", "no-cache");
    streamHeaders.delete("Connection");
    return new Response(response.body, {
      status: response.status,
      headers: streamHeaders,
    });
  }

  // ──── JSON 响应处理 ────
  if (contentType && contentType.includes("application/json")) {
    const data = await response.json();

    // OpenCode Anthropic：OpenAI 响应 → Anthropic 格式
    if (isOpenCodeAnthropic) {
      const anthropicData = openAIToAnthropic(data, requestBodyObj.model);
      return new Response(JSON.stringify(anthropicData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

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
