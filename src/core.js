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

// 读取并解析请求体
// 返回 { isJson, parsed, raw, invalidJson }：
// - isJson=true  使用 parsed（已解析的 JSON 对象/数组）
// - isJson=false 使用 raw（Uint8Array，原样透传：multipart、音频上传等）
// - invalidJson=true 表示声明为 JSON 但解析失败（应返回 400，而不是静默转发 {}）
async function readRequestBody(request) {
  const contentType = getHeader(request.headers, "content-type") || "";
  // 未声明 Content-Type 时按 JSON 处理（保持与旧行为一致）
  const isJson = contentType === "" || /json/i.test(contentType);

  if (!request.body) {
    return { isJson, parsed: {}, raw: null };
  }

  // 兼容已预先解析好的 body 对象（非标准 Request）
  if (typeof request.arrayBuffer !== "function") {
    return { isJson, parsed: request.body, raw: null };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!isJson) {
    return { isJson: false, parsed: null, raw: bytes };
  }

  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) {
    return { isJson: true, parsed: {}, raw: bytes };
  }

  try {
    return { isJson: true, parsed: JSON.parse(text), raw: bytes };
  } catch (_) {
    return { isJson: true, parsed: null, raw: bytes, invalidJson: true };
  }
}

// 将 Anthropic 图片来源转换为 OpenAI image_url
// 支持 base64 与 url 两种 source；其它类型（file 等）返回 null 表示跳过
function imageSourceToUrl(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "url" && source.url) return source.url;
  if (source.data && source.media_type) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

// 允许透传给上游的额外请求头白名单（不含认证头，认证头单独处理）
const PASSTHROUGH_HEADERS = [
  "x-opencode-session", // OpenCode Zen Go 必需（会话路由/缓存亲和）
  "x-session-id", // OpenCode Go 同样识别客户端原生会话头
  "x-session-affinity", // 同上
  "user-agent", // 上游要求客户端自我标识（勿用通用 SDK 名）
  "http-referer", // OpenRouter 排行/归因
  "x-title", // OpenRouter 排行/归因
];

// 复制上游响应头，剔除因重新序列化 body 而不再匹配的字段
function copyResponseHeaders(response, contentType) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

// OpenCode Go 网关（/zen/go/...、/inference/go/...）要求客户端提供会话 id 用于
// 路由与提示缓存亲和，缺失时上游直接返回 400 MissingSessionID
const OPENCODE_GO_BASE_RE = /\/(?:zen|inference)\/go(?:\/|$)/i;

// 上游接受的会话头名，任一存在即可
const SESSION_HEADER_NAMES = [
  "x-opencode-session",
  "x-session-id",
  "x-session-affinity",
];

// 客户端是否自带了有效的会话头（空白值视为未提供）
function getClientSessionHeader(headers) {
  for (const name of SESSION_HEADER_NAMES) {
    const value = getHeader(headers, name);
    if (typeof value === "string" && value.trim()) return { name, value };
  }
  return null;
}

// FNV-1a 32 位哈希：纯同步实现，Workers 与 Node 结果一致
function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// 取首条 user 消息的文本。同一次对话的每一轮都会重发完整历史，首条 user 消息
// 因此保持不变，可据此派生「每个对话稳定」的会话 id
function firstUserMessageText(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const first = messages.find((m) => m && m.role === "user");
  if (!first) return "";
  const { content } = first;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part) => part && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

// 将上游错误映射为 Anthropic 风格的错误响应，并保留原始状态码
function anthropicErrorResponse(status, error) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "Upstream request failed";
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: anthropicErrorType(status), message },
    }),
    {
      status: typeof status === "number" && status >= 400 ? status : 502,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function anthropicErrorType(status) {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
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
      // 用户消息：tool_result → tool 消息；文本+图片 → user 消息
      //
      // 顺序很关键：OpenAI 要求 role=tool 的消息必须紧跟带 tool_calls 的 assistant
      // 消息。若把文本 user 消息插在中间，上游会直接报 400。因此先发全部 tool 消息。

      // 每个 tool_result 生成一条独立的 tool 消息
      for (const tr of toolResults) {
        openaiBody.messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: extractTextFromContent(tr.content),
        });
      }

      // 构造 user 消息（文本 + 图片）
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          // 包含图片时使用 OpenAI 多模态格式
          const content = [];
          for (const tp of textParts)
            content.push({ type: "text", text: tp.text });
          for (const img of imageParts) {
            const url = imageSourceToUrl(img.source);
            if (url) {
              content.push({ type: "image_url", image_url: { url } });
            }
          }
          openaiBody.messages.push({ role: "user", content });
        } else {
          openaiBody.messages.push({
            role: "user",
            content: textParts.map((b) => b.text).join("\n"),
          });
        }
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
    } else if (tc.type === "none") {
      // Anthropic 的 none = 禁止调用工具；OpenAI 有 tools 时默认是 auto，必须显式指定
      openaiBody.tool_choice = "none";
    }
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
  // 流处理过程中的异常：不为空时在阶段二发出 Anthropic error 事件，
  // 而不是把中断的流伪装成正常结束
  let streamError = null;

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
                  input: {},
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
    // 流式处理中的异常：记录后在阶段二发出 error 事件，
    // 让客户端知道这是失败而不是正常结束
    streamError = error;
  }

  // ──── 阶段二：发出 Anthropic 协议要求的结束事件 ────
  // 注意：这些 yield 代码在 try 块之外，不属于 try/finally 范围，
  // 因此在生成器被正常消费时会可靠执行。

  // 上游/解析异常 → 发 error 事件并终止（Anthropic 协议中 error 事件即流终止）
  if (streamError) {
    yield `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message:
          streamError instanceof Error
            ? streamError.message
            : "Stream processing error",
      },
    })}\n\n`;
    return;
  }

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

  // 事件：message_delta（最终 stop_reason + token 数）
  // message_start 先于 usage 到达，input_tokens 只有在已知时才补报
  const finalUsage = { output_tokens: outputTokens };
  if (inputTokens > 0) finalUsage.input_tokens = inputTokens;

  yield `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })}\n\n`;

  // 事件：message_stop
  yield `event: message_stop\ndata: ${JSON.stringify({
    type: "message_stop",
  })}\n\n`;
}

// 是否为 MiniMax 官网套餐/额度接口路径（/token_plan/*、/coding_plan/*）
// 这类路径必须保留前缀转发给 www.minimaxi.com，不能像 provider 那样剥掉首段
function isMiniMaxPlanPath(path) {
  return (
    path === "/token_plan" ||
    path.startsWith("/token_plan/") ||
    path === "/coding_plan" ||
    path.startsWith("/coding_plan/")
  );
}

// ──────────────────────────────────────────────
// 根据请求路径解析出目标 provider 和实际请求路径
// ──────────────────────────────────────────────
function resolveProvider(originalPath, options) {
  // /token_plan/*、/coding_plan/* → 走 MiniMax 官网套餐接口（保留原路径前缀）
  if (isMiniMaxPlanPath(originalPath)) {
    return {
      provider: "minimax",
      targetBase: options.apiBaseWww,
      strippedPath: originalPath,
    };
  }

  // 匹配 /{provider}/{version}/{path} 格式，如 /deepseek/v1/chat/completions
  const match = originalPath.match(/^\/([^/]+)(\/v\d+)?(\/.*)?$/);
  if (match) {
    const providerName = match[1].toLowerCase();
    const strippedPath = match[3] || ""; // 去掉 provider 前缀后的实际路径

    // 用 hasOwn 判断，避免 /__proto__/v1/... 之类的路径命中 Object.prototype
    const provider =
      options.providers && Object.hasOwn(options.providers, providerName)
        ? options.providers[providerName]
        : undefined;
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

// 构建模型列表响应（OpenAI /v1/models 格式）
function buildModelsResponse(options) {
  const models = [];
  for (const [name, cfg] of Object.entries(options.providers || {})) {
    if (!cfg.apiBase) continue;
    models.push({
      id: name,
      object: "model",
      created: 1683728000,
      owned_by: name,
      permission: [],
      root: name,
      parent: null,
    });
  }
  return {
    object: "list",
    data: models,
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
  let apiKey = null;
  if (authHeader) {
    const value = authHeader.trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (bearer) {
      apiKey = bearer[1].trim() || null;
    } else if (!/^Bearer$/i.test(value)) {
      // 非 Bearer 形式的 Authorization 原样作为 key 转发；
      // 只有 scheme 没有值的 "Bearer"（空 key）视为未提供
      apiKey = value || null;
    }
  }
  if (!apiKey) {
    const xApiKey = getHeader(request.headers, "x-api-key");
    apiKey = xApiKey ? xApiKey.trim() || null : null;
  }

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

  // /v1/models 端点：返回代理支持的模型列表（需要认证）
  // 仅匹配裸路径 /v1/models，带 provider 前缀的路径（如 /deepseek/v1/models）应代理到上游
  if (originalPath === "/v1/models") {
    return new Response(JSON.stringify(buildModelsResponse(options)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  // 透传部分客户端头：某些上游必需（如 OpenCode Zen Go 的 x-opencode-session，
  // OpenRouter 的 HTTP-Referer / X-Title），只放行白名单，避免泄漏 host/cookie 等
  for (const name of PASSTHROUGH_HEADERS) {
    const value = getHeader(request.headers, name);
    if (value) headers[name] = value;
  }

  // 读取请求体（非 GET/HEAD 方法）
  let body = null;
  let requestBodyObj = {};
  let isJsonBody = false;
  if (!["GET", "HEAD"].includes(request.method)) {
    const parsedBody = await readRequestBody(request);

    if (parsedBody.invalidJson) {
      // 声明为 JSON 却解析失败：明确报错，不要把 {} 转发给上游
      return new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Request body is not valid JSON.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (parsedBody.isJson) {
      isJsonBody = true;
      requestBodyObj = parsedBody.parsed || {};
      body = JSON.stringify(requestBodyObj);
    } else {
      // multipart / 音频上传等非 JSON 请求：原样透传字节流与原始 Content-Type
      body = parsedBody.raw;
      const requestContentType = getHeader(request.headers, "content-type");
      if (requestContentType) headers["Content-Type"] = requestContentType;
    }
  }

  // 目标 URL = provider 基础地址（去掉尾部斜杠）+ 实际路径 + 查询串
  const base = String(resolved.targetBase).replace(/\/+$/, "");

  // opencode_anthropic：Anthropic → OpenAI 格式转换
  if (isOpenCodeAnthropic && isJsonBody) {
    requestBodyObj = anthropicToOpenAI(requestBodyObj);
    body = JSON.stringify(requestBodyObj);
  }

  // opencode_anthropic：路径转换 /messages → /chat/completions
  let targetPath = resolved.strippedPath;
  if (isOpenCodeAnthropic) {
    targetPath = targetPath.replace(/\/messages\/?$/, "/chat/completions");
  }

  // OpenCode Go 网关缺会话头会直接返回 400 MissingSessionID，而 Claude Code 等
  // 客户端不认识这个头，因此客户端未提供时由代理补一个：用「apiKey + model +
  // 首条用户消息」派生，同一对话的每一轮都得到同一个 id，保留上游缓存亲和性
  if (OPENCODE_GO_BASE_RE.test(base) && isJsonBody) {
    const clientSession = getClientSessionHeader(request.headers);
    if (!clientSession) {
      const seed = `${apiKey}\n${requestBodyObj?.model ?? ""}\n${firstUserMessageText(
        requestBodyObj,
      )}`;
      headers["x-opencode-session"] = `ses_${fnv1a32(seed)}`;
    }
  }

  const targetUrl = `${base}${targetPath}${search}`;

  // 转发请求到目标 API
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: headers,
    body: body,
  });

  const contentType = response.headers.get("content-type");
  // 以上游返回的 Content-Type 为准：只看请求体的 stream 字段会漏掉由 query 参数
  // 或 Accept 头触发的 SSE（那样会被错误地整体缓冲）
  const isSSE = !!response.body && !!contentType?.includes("text/event-stream");

  // ──── 流式响应处理 ────
  if (isSSE) {
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
        // 客户端断开时取消上游读取，避免上游连接继续烧 token
        async cancel() {
          try {
            await reader.cancel();
          } catch (_) {
            // 上游已结束
          }
        },
      });
      return new Response(stream, {
        status: response.ok ? 200 : response.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 其他 provider：直接透传 SSE 流
    // 运行时（Workers/undici）会自动解压上游的 gzip，上游的 content-length /
    // content-encoding 因此不再匹配实际字节数，必须剔除后再转发
    const streamHeaders = copyResponseHeaders(response, "text/event-stream");
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
      // 上游错误（401/429/400/500…）必须原样透出状态码与信息，
      // 否则会被 openAIToAnthropic 伪造成「内容为空的成功响应」
      if (!response.ok || data?.error) {
        return anthropicErrorResponse(response.status, data?.error);
      }
      const anthropicData = openAIToAnthropic(data, requestBodyObj.model);
      return new Response(JSON.stringify(anthropicData), {
        status: response.status,
        headers: copyResponseHeaders(response, "application/json"),
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

    // 保留上游响应头（Retry-After、x-ratelimit-*、x-request-id 等）
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: copyResponseHeaders(response, "application/json"),
    });
  }

  // 其他类型（如纯文本）→ 直接透传
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: copyResponseHeaders(response, contentType || "text/plain"),
  });
}
