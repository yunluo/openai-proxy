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

// 允许透传给上游的额外请求头白名单（不含认证头，认证头单独处理）
const PASSTHROUGH_HEADERS = [
  "x-opencode-session", // OpenCode Zen Go 必需（会话路由/缓存亲和）
  "x-opencode-session-id", // OpenCode 原生会话 id
  "x-opencode-parent-session-id", // OpenCode 父会话（子代理）
  "x-opencode-client", // OpenCode 客户端标识（cli/desktop…）
  "x-opencode-project", // OpenCode 项目标识（上游归因）
  "x-opencode-request", // OpenCode 单次请求标识（上游归因）
  "x-session-id", // OpenCode Go 同样识别客户端原生会话头
  "x-session-affinity", // 同上
  "x-parent-session-id", // 父会话（通用）
  "user-agent", // 上游要求客户端自我标识（勿用通用 SDK 名）
  "http-referer", // OpenRouter 排行/归因
  "x-title", // OpenRouter 排行/归因
  "openai-beta", // Responses API 旧版 beta 头（部分客户端仍会发送）
  "openai-organization", // OpenAI 组织隔离
  "openai-project", // OpenAI 项目隔离
  "idempotency-key", // POST /responses 等请求的幂等键
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

// OpenCode Zen / Go / inference 网关都要求客户端提供会话 id：
// - Go（/zen/go/…、/inference/go/…）缺失时直接返回 400 MissingSessionID
// - Zen 免费模型还会校验 x-opencode-session 的格式（ses_ + 12 位十六进制 +
//   14 位 base62）以及 User-Agent 是否为 opencode/<版本>
const OPENCODE_GATEWAY_BASE_RE = /\/(?:zen|inference)(?:\/|$)/i;

// OpenCode 原生会话 id 的形状（ses_ + 12 位十六进制时间片 + 14 位 base62 随机片）
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_SESSION_TAIL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 上游接受的会话头名（按优先级排列）
const SESSION_HEADER_NAMES = [
  "x-opencode-session",
  "x-session-id",
  "x-session-affinity",
];

// 客户端是否自带了格式合法的 OpenCode 会话头：opencode 把代理当自定义 provider
// 时只发 x-session-id / x-session-affinity，且值本身就是合法的 ses_… 形式
function getClientOpenCodeSession(headers) {
  for (const name of SESSION_HEADER_NAMES) {
    const value = getHeader(headers, name);
    if (typeof value === "string" && isOpenCodeSessionId(value)) {
      return value.trim();
    }
  }
  return null;
}

function isOpenCodeSessionId(value) {
  return typeof value === "string" && OPENCODE_SESSION_RE.test(value.trim());
}

// OpenCode Zen 免费模型：上游免费层不需要 API Key，只校验 OpenCode 客户端身份头。
// 若客户端带了任意无效 key，上游反而会返回 Invalid credential / FreeTierError。
// 免费模型以 -free 结尾（另有 big-pickle）；#variant 后缀由客户端自己处理。
function isOpenCodeZenFreeModel(model) {
  if (typeof model !== "string") return false;
  const id = model.trim().toLowerCase().split("#")[0];
  return id === "big-pickle" || id.endsWith("-free");
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

// 从种子派生格式合法的 OpenCode 会话 id：同一对话的每一轮都得到同一个 id，
// 新对话得到不同的 id，保留上游路由与提示缓存亲和
function deriveOpenCodeSessionId(seed) {
  const head = (fnv1a32(seed) + fnv1a32(`${seed}#head`)).slice(0, 12);
  let tail = "";
  for (let i = 0; i < 14; i++) {
    const hash = fnv1a32(`${seed}#tail${i}`);
    tail +=
      OPENCODE_SESSION_TAIL_ALPHABET[
        parseInt(hash, 16) % OPENCODE_SESSION_TAIL_ALPHABET.length
      ];
  }
  return `ses_${head}${tail}`;
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

// 超时相关的默认值（毫秒，0 表示不限制），可由环境变量覆盖
// - 响应头超时：非流式请求要等上游生成完毕才会返回响应头，所以默认给得较宽，
//   只用来兜住「连上了但永远不回」的情况
// - 空闲超时：只在读上游 body 时生效，这么久没有任何新数据就判定上游卡死
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 300000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;

function toTimeoutMs(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// 给上游 body 叠加空闲超时：超时就取消上游连接并让流报错（而不是永远挂住）
function withIdleTimeout(body, idleMs) {
  if (!body || !idleMs) return body;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      let timer;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Upstream stream idle timeout")),
              idleMs,
            );
          }),
        ]);
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        try {
          await reader.cancel();
        } catch (_) {
          // 上游已经结束
        }
        controller.error(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch (_) {
        // 上游已经结束
      }
    },
  });
}

// 把上游 body 读成文本（叠加空闲超时）
async function readUpstreamText(body, idleMs) {
  const stream = withIdleTimeout(body, idleMs);
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// 可选的访问口令（PROXY_ACCESS_TOKEN）：设置后所有请求都要带 x-proxy-token，
// 避免域名被当作开放中继滥用；不设置则完全跳过
function checkAccessToken(request, options) {
  const expected = options.accessToken;
  if (expected === undefined || expected === null || expected === "") return null;
  const provided = getHeader(request.headers, "x-proxy-token");
  if (typeof provided === "string" && provided.trim() === String(expected)) {
    return null;
  }
  return new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Missing or invalid x-proxy-token header.",
      },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

// OpenAI 兼容 SSE 的终止块修复
//
// 部分上游（例如 OpenCode Zen 的 muse 模型）在内容发完后直接关闭流：既没有带
// finish_reason 的终止 chunk，也可能没有 data: [DONE]。OpenAI 官方规范要求两者
// 至少要有终止 chunk，严格校验的客户端（opencode、Pi、Hermes 等）会因此把正常
// 结束当成流中断，报 "Stream ended without finish_reason" 并反复重试。
//
// 这里只在「确实收到了 choices 却始终没有 finish_reason」时补一个合成终止块，
// 并补上缺失的 [DONE]；内容块与其余字段原样逐行转发，不改写已有事件。
// ──────────────────────────────────────────────
const OPENAI_CHAT_COMPLETIONS_PATH_RE = /(?:^|\/)chat\/completions\/?$/;

// OpenAI Responses API 路径：/responses、/responses/{id}、/responses/{id}/cancel、
// /responses/{id}/input_items 等。Responses 的 SSE 事件（response.*）与 Chat 的
// 终止块修复互不兼容，必须原样透传，不能被 Chat 逻辑改写。
const OPENAI_RESPONSES_PATH_RE = /(?:^|\/)responses(?:\/|$)/;

// finish_reason 只有在是「非空字符串」时才算有效。null / undefined 表示流尚未结束，
// 空字符串则是一些上游的占位值；这两种情况都必须继续等待或由代理补终止块。
function isValidFinishReason(value) {
  return typeof value === "string" && value.trim() !== "";
}

// 从上游错误字段里取出可读文本；对象/字符串/未知结构都尽量给出信息
function errorMessageOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return "";
  }
}

// 客户端请求了 stream:true，但上游返回普通 JSON（有的网关会忽略 stream 参数）。
// 直接透传 JSON 会让流式客户端认为「一个事件都没收到」，严格校验时正好报
// "stream ended without finish_reason"。这里把完整响应包成一条 SSE 终止流。
function buildChatSSEFromCompletion(data, fallbackModel) {
  const id =
    typeof data?.id === "string" && data.id
      ? data.id
      : `chatcmpl-proxy-${Date.now()}`;
  const created = Number.isFinite(data?.created)
    ? data.created
    : Math.floor(Date.now() / 1000);
  const model =
    typeof data?.model === "string" && data.model
      ? data.model
      : fallbackModel || "";
  const frames = [];

  if (data?.error) {
    frames.push(
      `data: ${JSON.stringify({
        error: {
          type: "upstream_error",
          message:
            errorMessageOf(data.error) || "Upstream returned an error.",
        },
      })}\n\n`,
    );
  } else {
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    if (choices.length === 0) {
      frames.push(
        `data: ${JSON.stringify({
          error: {
            type: "upstream_empty_stream",
            message: "Upstream returned no choices.",
          },
        })}\n\n`,
      );
    } else {
      for (const choice of choices) {
        const message = choice?.message ?? choice?.delta ?? {};
        const delta = { role: message.role || "assistant" };
        if (
          typeof message.reasoning_content === "string" &&
          message.reasoning_content
        ) {
          delta.reasoning_content = message.reasoning_content;
        }
        if (typeof message.content === "string" && message.content) {
          delta.content = message.content;
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          delta.tool_calls = message.tool_calls.map((tool, position) => ({
            ...tool,
            index: Number.isInteger(tool?.index) ? tool.index : position,
          }));
        }
        const finishReason = isValidFinishReason(choice?.finish_reason)
          ? choice.finish_reason
          : delta.tool_calls
            ? "tool_calls"
            : "stop";
        frames.push(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: Number.isInteger(choice?.index) ? choice.index : 0,
                delta,
                finish_reason: finishReason,
              },
            ],
            ...(data.usage ? { usage: data.usage } : {}),
          })}\n\n`,
        );
      }
    }
  }

  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

// 把上游的异常/非流式响应包装成一条客户端能识别的 SSE 错误流
function buildChatSSEError(message, type = "upstream_error") {
  return (
    `data: ${JSON.stringify({
      error: { type, message: String(message).slice(0, 2000) },
    })}\n\n` + "data: [DONE]\n\n"
  );
}

function normalizeOpenAIChatSSE(body, idleMs, fallbackModel) {
  const source = withIdleTimeout(body, idleMs);
  if (!source) return body;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawChoice = false;
  let sawFinishReason = false;
  let sawToolCalls = false;
  let sawDone = false;
  // 上游在流内报错（data: {"error":…} 或非 JSON 的 data 行）：此时不能补成功终止块，
  // 否则会把失败伪装成正常结束；但也不能让流静默结束，必须给客户端一个它能识别的
  // 错误事件，否则严格客户端只会看到 “stream ended without finish_reason”。
  let upstreamErrorMessage = "";
  let upstreamErrorStructured = false;
  // 是否已经补过终止事件（finish 块或 error 事件），避免 flush 重复补
  let terminalEmitted = false;
  let lastId = "";
  let lastModel = fallbackModel || "";
  let lastChoiceIndex = 0;

  const emit = (controller, text) => controller.enqueue(encoder.encode(text));

  const buildFinishChunk = () => {
    const finishReason = sawToolCalls ? "tool_calls" : "stop";
    return `data: ${JSON.stringify({
      id: lastId || `chatcmpl-proxy-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: lastModel,
      choices: [
        { index: lastChoiceIndex, delta: {}, finish_reason: finishReason },
      ],
    })}\n\n`;
  };

  const buildErrorChunk = (message) => {
    const text = String(
      message || "Upstream stream ended without a usable result.",
    ).slice(0, 2000);
    return `data: ${JSON.stringify({
      error: {
        type: "upstream_stream_error",
        message: text,
        code: 502,
      },
    })}\n\n`;
  };

  // 流结束时必须给客户端一个它能识别的终止事件：
  // - 已有 finish_reason → 只补 [DONE]
  // - 上游报错（且客户端无法从原始事件里读到 error）→ 补 OpenAI 格式的 error 事件
  // - 收到过内容但没有 finish_reason → 补合成终止块
  // - 什么都没收到 → 明确报「空流」，而不是静默结束
  const finishTerminal = (controller, isDone) => {
    if (!sawFinishReason && !terminalEmitted) {
      if (upstreamErrorMessage || upstreamErrorStructured) {
        if (!upstreamErrorStructured) {
          emit(controller, buildErrorChunk(upstreamErrorMessage));
        }
      } else if (sawChoice) {
        emit(controller, buildFinishChunk());
        sawFinishReason = true;
      } else {
        emit(
          controller,
          buildErrorChunk("Upstream SSE stream ended without any content."),
        );
      }
      terminalEmitted = true;
    }
    if (!isDone && !sawDone) {
      emit(controller, "data: [DONE]\n\n");
      sawDone = true;
    }
  };

  const handleLine = (controller, line, isFinal) => {
    const trimmed = line.trim();
    let eventData = null;
    let isDone = false;

    if (trimmed.startsWith("data:")) {
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        isDone = true;
      } else if (data) {
        eventData = data;
      }
    }

    if (eventData) {
      let chunk = null;
      try {
        chunk = JSON.parse(eventData);
      } catch (_) {
        // 非 JSON 的 data 行原样透传；内容流里出现这种行通常意味着上游报错
        if (!upstreamErrorMessage) {
          upstreamErrorMessage = `Upstream sent a non-JSON SSE data line: ${eventData.slice(0, 500)}`;
        }
      }
      if (chunk) {
        if (chunk.error && typeof chunk.error === "object") {
          // 客户端能直接读 event.error.message，原始事件已经足够
          upstreamErrorStructured = true;
          if (!upstreamErrorMessage) {
            upstreamErrorMessage = errorMessageOf(chunk.error);
          }
        } else if (chunk.error || chunk.type === "error") {
          if (!upstreamErrorMessage) {
            upstreamErrorMessage =
              errorMessageOf(chunk.error) ||
              (typeof chunk.message === "string" ? chunk.message : "") ||
              "Upstream reported an error.";
          }
        }
        if (typeof chunk.id === "string" && chunk.id) lastId = chunk.id;
        if (typeof chunk.model === "string" && chunk.model) {
          lastModel = chunk.model;
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        if (choices.length > 0) sawChoice = true;
        for (const choice of choices) {
          if (!choice) continue;
          if (Number.isInteger(choice.index)) lastChoiceIndex = choice.index;
          // 少数上游会用空字符串表示「尚未结束」（如 finish_reason:""）。
          // 严格客户端会忽略它，若把它当成有效终止原因，就不会再补终止块，
          // 最终报 "Stream ended without finish_reason"。
          if (isValidFinishReason(choice.finish_reason)) {
            sawFinishReason = true;
          }
          const delta = choice.delta || choice.message;
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            sawToolCalls = true;
          }
        }
      }
    }

    // [DONE] 之前补终止事件：保证终止事件出现在所有内容块之后
    if (isDone) {
      finishTerminal(controller, true);
    }

    emit(controller, isFinal ? `${line}\n\n` : `${line}\n`);
    if (isDone) sawDone = true;
  };

  return source.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) handleLine(controller, line, false);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) handleLine(controller, buffer, true);
        // 上游连 [DONE] 都没发：补终止事件 + [DONE]，绝不让流静默结束
        finishTerminal(controller, false);
      },
    }),
  );
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

// 是否为 Responses API 路径（/responses、/responses/{id}、/responses/{id}/input_items 等）
function isResponsesApiPath(path) {
  return path === "/responses" || path.startsWith("/responses/");
}

// 缺少 provider 前缀时的统一错误：/v1/... 不再隐式回退到 MiniMax
function missingProviderPrefix(path) {
  return {
    error: true,
    status: 400,
    type: "invalid_request_error",
    message: `Provider prefix is required. Use /{provider}${path} (e.g. /minimax${path}).`,
  };
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

    // 裸 /v1/responses 与 /v1/chat/completions 是 OpenAI 默认协议入口：
    // 不带 provider 前缀时直接走 gpt；其它裸 /v1/* 仍需显式前缀。
    const isBareOpenAIPath =
      /^v\d+$/.test(providerName) &&
      (strippedPath === "/responses" ||
        strippedPath.startsWith("/responses/") ||
        strippedPath === "/chat/completions" ||
        strippedPath === "/chat/completions/");

    if (isBareOpenAIPath) {
      const gpt = options.providers?.gpt;
      const bareResponses = strippedPath === "/responses" || strippedPath.startsWith("/responses/");
      const gptBase = bareResponses
        ? gpt?.responsesApiBase || gpt?.apiBase
        : gpt?.apiBase;
      if (!gptBase) {
        return {
          error: true,
          message: "Default OpenAI provider (gpt) is not configured",
        };
      }
      return {
        provider: "gpt",
        targetBase: gptBase,
        strippedPath,
      };
    }

    // 用 hasOwn 判断，避免 /__proto__/v1/... 之类的路径命中 Object.prototype
    const provider =
      options.providers && Object.hasOwn(options.providers, providerName)
        ? options.providers[providerName]
        : undefined;
    if (provider) {
      return {
        provider: providerName,
        targetBase: isResponsesApiPath(strippedPath)
          ? provider.responsesApiBase || provider.apiBase
          : provider.apiBase,
        strippedPath,
      };
    }

    // 其它 /v1/... 路径没有 provider 前缀：直接报错
    if (/^v\d+$/.test(providerName)) {
      return missingProviderPrefix(originalPath);
    }

    return { error: true, message: `Unknown provider: ${providerName}` };
  }

  // 其它无法识别出 provider 的路径（包括 /）同样要求显式前缀
  return missingProviderPrefix(originalPath);
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
  // 统一处理相对路径（测试/Node）和完整 URL（Cloudflare Workers）
  const parsedUrl = new URL(request.url, "http://localhost");
  const originalPath = parsedUrl.pathname;
  const search = parsedUrl.search; // preserve query string

  // 可选访问口令：先于一切路由与认证检查
  const denied = checkAccessToken(request, options);
  if (denied) return denied;

  // 从请求头中提取 API Key（兼容 OpenAI Bearer 和通用 x-api-key）
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

  // 解析目标 provider 和实际路径
  const resolved = resolveProvider(originalPath, options);

  // OpenCode Zen 允许匿名请求：免费模型不需要上游 API Key，免费层只校验
  // OpenCode 客户端身份头。其他 provider 仍要求客户端提供 key；付费 Zen 模型
  // 若没带 key，由上游返回 401，代理原样透出。
  const allowsAnonymous = resolved.provider === "opencode_zen";
  if (!apiKey && !allowsAnonymous) {
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
          type: resolved.type || "not_found",
          message: resolved.message,
        },
      }),
      {
        status: resolved.status || 404,
        headers: { "Content-Type": "application/json" },
      },
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

  // 构建转发请求头：OpenAI 兼容端点使用 Bearer 认证
  const headers = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
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

  // OpenCode Zen 免费模型：免费层不需要 API Key，带上任意无效 key 反而会被
  // 上游拒绝（Invalid credential / FreeTierError）。付费模型仍使用客户端 key。
  if (
    resolved.provider === "opencode_zen" &&
    isOpenCodeZenFreeModel(requestBodyObj?.model)
  ) {
    delete headers["Authorization"];
    delete headers["x-api-key"];
  }

  // 目标 URL = provider 基础地址（去掉尾部斜杠）+ 实际路径 + 查询串
  const base = String(resolved.targetBase).replace(/\/+$/, "");

  const targetPath = resolved.strippedPath;

  // OpenCode Zen / Go 网关的会话头：Go 缺了直接 400 MissingSessionID，Zen 免费
  // 模型还会校验格式。opencode 把代理当自定义 provider 时只发 x-session-id /
  // x-session-affinity，不发 x-opencode-session，所以这里统一补一个格式合法的
  // x-opencode-session；客户端自带的值只要格式合法就沿用，保留原本的会话亲和
  if (OPENCODE_GATEWAY_BASE_RE.test(base) && isJsonBody) {
    const clientSession = getClientOpenCodeSession(request.headers);
    if (clientSession) {
      headers["x-opencode-session"] = clientSession;
    } else {
      const seed = `${apiKey ?? ""}\n${requestBodyObj?.model ?? ""}\n${firstUserMessageText(
        requestBodyObj,
      )}`;
      headers["x-opencode-session"] = deriveOpenCodeSessionId(seed);
    }
  }

  const targetUrl = `${base}${targetPath}${search}`;

  // 超时与空闲检测（可由环境变量 / 调用方覆盖，0 表示不限制）
  const headersTimeoutMs = toTimeoutMs(
    options.upstreamTimeoutMs,
    DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS,
  );
  const idleTimeoutMs = toTimeoutMs(
    options.streamIdleTimeoutMs,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );

  // 转发请求到目标 API：只在「等响应头」阶段计时，拿到响应头后立即解除，
  // 这样不会掐断正常的流式长回答，但能兜住永远不回的连接
  const timeoutController = headersTimeoutMs > 0 ? new AbortController() : null;
  const headerTimer = timeoutController
    ? setTimeout(() => timeoutController.abort(), headersTimeoutMs)
    : null;

  let response;
  try {
    response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: body,
      ...(timeoutController ? { signal: timeoutController.signal } : {}),
    });
  } catch (error) {
    const timedOut = !!timeoutController?.signal.aborted;
    // 原始错误只进日志，返回给客户端的消息里不含内部细节
    console.error(`Upstream fetch failed (${targetUrl}):`, error);
    return new Response(
      JSON.stringify({
        error: {
          type: timedOut ? "upstream_timeout" : "upstream_unreachable",
          message: timedOut
            ? `Upstream ${resolved.provider} did not respond within ${Math.round(
                headersTimeoutMs / 1000,
              )}s.`
            : `Unable to reach upstream ${resolved.provider}.`,
        },
      }),
      {
        status: timedOut ? 504 : 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
  }

  const contentType = response.headers.get("content-type");
  // 以上游返回的 Content-Type 为准：只看请求体的 stream 字段会漏掉由 query 参数
  // 或 Accept 头触发的 SSE（那样会被错误地整体缓冲）
  const isSSE = !!response.body && !!contentType?.includes("text/event-stream");

  // Responses API 与 Chat Completions 都是原生协议：Responses 的 SSE 逐事件原样
  // 透传，只有 Chat Completions 才做终止块修复。
  const isResponsesPath = OPENAI_RESPONSES_PATH_RE.test(targetPath);

  // 客户端明确要求流式 Chat Completions：无论上游实际返回什么，最终都要给
  // 客户端一条带终止事件的 SSE，绝不能让它收到「零个事件」的 200 响应。
  const wantsChatStream =
    isJsonBody &&
    requestBodyObj?.stream === true &&
    !isResponsesPath &&
    OPENAI_CHAT_COMPLETIONS_PATH_RE.test(targetPath);

  // ──── 流式响应处理 ────
  if (isSSE) {
    // 直接透传 SSE 流
    // 运行时（Workers/undici）会自动解压上游的 gzip，上游的 content-length /
    // content-encoding 因此不再匹配实际字节数，必须剔除后再转发
    const streamHeaders = copyResponseHeaders(response, "text/event-stream");
    streamHeaders.set("Cache-Control", "no-cache");
    streamHeaders.delete("Connection");

    // OpenAI Chat Completions 流：修复上游缺失的 finish_reason / [DONE]，
    // 否则严格客户端会把正常结束当成中断。Responses 事件不做任何改写。
    const needsChatStreamFix =
      response.ok &&
      !isResponsesPath &&
      OPENAI_CHAT_COMPLETIONS_PATH_RE.test(targetPath);
    const streamBody = needsChatStreamFix
      ? normalizeOpenAIChatSSE(
          response.body,
          idleTimeoutMs,
          requestBodyObj?.model,
        )
      : withIdleTimeout(response.body, idleTimeoutMs);

    return new Response(streamBody, {
      status: response.status,
      headers: streamHeaders,
    });
  }

  // ──── JSON 响应处理 ────
  if (contentType && contentType.includes("application/json")) {
    const data = JSON.parse(await readUpstreamText(response.body, idleTimeoutMs));

    // 客户端请求了 stream:true，上游却返回 JSON：包成 SSE 终止流，避免客户端
    // 因「零个事件」而报 stream ended without finish_reason。错误响应保留原
    // 状态码，让客户端走正常的 HTTP 错误处理。
    if (wantsChatStream && response.ok) {
      const jsonStreamHeaders = copyResponseHeaders(
        response,
        "text/event-stream",
      );
      jsonStreamHeaders.set("Cache-Control", "no-cache");
      jsonStreamHeaders.delete("Connection");
      return new Response(
        buildChatSSEFromCompletion(data, requestBodyObj?.model),
        { status: 200, headers: jsonStreamHeaders },
      );
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

  // DELETE /responses/{id} 等端点可能返回 204/205/304；这些状态不允许 body
  if (
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    return new Response(null, {
      status: response.status,
      headers: copyResponseHeaders(response, null),
    });
  }

  // 其他类型（如纯文本 / HTML / 空响应）→ 原样透传；但流式 Chat 请求必须
  // 返回 SSE 终止事件，否则严格客户端会误报 stream ended without finish_reason
  const text = await readUpstreamText(response.body, idleTimeoutMs);
  if (wantsChatStream && response.ok) {
    const snippet = text.trim().slice(0, 500);
    return new Response(
      buildChatSSEError(
        `Upstream returned a non-SSE response (${contentType || "unknown content type"})` +
          (snippet ? `: ${snippet}` : " with an empty body."),
        "upstream_unexpected_response",
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      },
    );
  }
  return new Response(text, {
    status: response.status,
    headers: copyResponseHeaders(response, contentType || "text/plain"),
  });
}
