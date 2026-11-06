// 流结束诊断（按隔离实例常驻内存的环形缓冲，经 /v1/debug/stream-ends 读取）：
// 归因断流发生在哪条腿——client-cancel=客户端侧断开；upstream-eof-no-finish=
// 上游优雅 EOF 且未给出终止原因；upstream-interrupted=读上游时抛错；
// complete=上游流自带终止原因正常走完。隔离实例回收后记录清零。
const STREAM_DIAG = {
  isolateId: `i-${Math.random().toString(36).slice(2, 10)}`,
  started: 0,
  records: [],
};

function recordStreamEnd(kind, detail) {
  STREAM_DIAG.records.push({ ts: new Date().toISOString(), kind, detail });
  if (STREAM_DIAG.records.length > 80) STREAM_DIAG.records.shift();
  console.warn(`[maxapi] stream ${kind} ${detail}`);
}

export function getStreamDiagnostics() {
  return { ...STREAM_DIAG, records: [...STREAM_DIAG.records] };
}

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

// 把 JSON 字符串内部的裸控制字符（U+0000–U+001F）重新转义。
// 有些模型/上游会产出「字符串里带原始制表符或换行」的 JSON，标准 JSON.parse
// 会直接抛 "Bad control character in string literal in JSON at position N"。
// 网关无法要求上游修正，只能在转发前修好；其余字节保持原样。
function escapeJsonControlChar(code) {
  switch (code) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    default:
      return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

// 逐字符扫描并把字符串字面量内的裸控制字符转义。
// state 保存「是否在字符串内 / 上一个字符是否是反斜杠」，供流式分块复用。
function sanitizeJsonFragment(text, state) {
  if (typeof text !== "string" || text === "") return text;
  let { inString, escaped } = state;
  let out = "";
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      escaped = false;
      if (code < 0x20) {
        out += escapeJsonControlChar(code);
        changed = true;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (code < 0x20) {
      out += escapeJsonControlChar(code);
      changed = true;
      continue;
    }
    out += ch;
  }
  state.inString = inString;
  state.escaped = escaped;
  return changed ? out : text;
}

function escapeControlCharsInJsonStrings(text) {
  return sanitizeJsonFragment(text, { inString: false, escaped: false });
}

// 先按标准 JSON 解析；失败时修复字符串内的裸控制字符再试一次。
// 返回 { ok, value, repaired? }，repaired 表示确实修复过、调用方应转发修复后的文本。
function parseJsonLenient(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const repaired = escapeControlCharsInJsonStrings(text);
    if (repaired !== text) {
      try {
        return { ok: true, value: JSON.parse(repaired), repaired };
      } catch (_) {
        // 修复后仍不合法，按原始解析错误处理
      }
    }
    return { ok: false, error };
  }
}

// tool_calls[].function.arguments 是「JSON 字符串里再套一层 JSON」。
// 参数 JSON 内部的裸控制字符必须在网关里转义，否则客户端二次 JSON.parse 时
// 仍会报 Bad control character。流式参数按块到达，用 argStates 保存跨块状态。
function repairToolCallArguments(container, argStates) {
  const toolCalls = Array.isArray(container?.tool_calls)
    ? container.tool_calls
    : null;
  if (!toolCalls) return false;
  let changed = false;
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const fn = toolCall?.function;
    if (!fn || typeof fn.arguments !== "string" || fn.arguments === "") {
      continue;
    }
    const key = Number.isInteger(toolCall?.index) ? toolCall.index : i;
    const id =
      typeof toolCall?.id === "string" && toolCall.id ? toolCall.id : null;
    let state = argStates.get(key);
    // 新 tool call（id 出现且与该分片上次记录的不同）从字符串外的干净状态
    // 重新开始扫描。部分上游会在每个分块重复携带同一个 id，只凭「有 id」
    // 就重置会丢掉跨块字符串状态，导致后续分片里的裸控制字符漏修。
    if (!state || (id && id !== state.lastId)) {
      state = { inString: false, escaped: false, lastId: id };
      argStates.set(key, state);
    }
    const fixed = sanitizeJsonFragment(fn.arguments, state);
    if (fixed !== fn.arguments) {
      fn.arguments = fixed;
      changed = true;
    }
  }
  return changed;
}

// 流式分片修复：obj[field] 是参数 JSON 文本的一个分片，按 key 续扫，
// argStates 保存跨块字符串状态（是否在字符串内 / 上个字符是否是反斜杠）
function repairFragmentWithState(obj, field, key, argStates) {
  if (!obj || typeof obj[field] !== "string" || obj[field] === "") return false;
  let state = argStates.get(key);
  if (!state) {
    state = { inString: false, escaped: false };
    argStates.set(key, state);
  }
  const fixed = sanitizeJsonFragment(obj[field], state);
  if (fixed === obj[field]) return false;
  obj[field] = fixed;
  return true;
}

// 完整 JSON 文本修复：obj[field] 是完整参数文本，从字符串外的干净状态扫描
function repairCompleteJsonTextField(obj, field) {
  if (!obj || typeof obj[field] !== "string" || obj[field] === "") return false;
  const fixed = sanitizeJsonFragment(obj[field], {
    inString: false,
    escaped: false,
  });
  if (fixed === obj[field]) return false;
  obj[field] = fixed;
  return true;
}

// Responses 的工具调用项：function_call / mcp_call 的 arguments 同样是
// 「JSON 字符串里再套一层 JSON」，与 Chat 的 tool_calls 需要相同的内层转义。
// custom_tool_call 的 input 是任意文本而非 JSON，不在此列。
function repairResponsesItemArguments(item) {
  if (!item || (item.type !== "function_call" && item.type !== "mcp_call")) {
    return false;
  }
  return repairCompleteJsonTextField(item, "arguments");
}

// 请求历史里的 tool 参数是完整 JSON 文本：Chat 的 assistant.tool_calls、
// 旧版 assistant.function_call，以及 Responses input[] 里的工具调用项，
// 逐条从干净状态修复即可
function repairRequestToolArguments(body) {
  let changed = false;
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (messages) {
    for (const message of messages) {
      if (!message) continue;
      if (repairToolCallArguments(message, new Map())) changed = true;
      if (repairCompleteJsonTextField(message.function_call, "arguments")) {
        changed = true;
      }
    }
  }
  const input = Array.isArray(body?.input) ? body.input : null;
  if (input) {
    for (const item of input) {
      if (repairResponsesItemArguments(item)) changed = true;
    }
  }
  return changed;
}

// 非流式完成响应：Chat 的 choices[].message/delta 与 Responses 的
// output[]（GET /responses/{id}/input_items 则是 data[]）都会出现参数文本
function repairCompletionToolArguments(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  let changed = false;
  for (const choice of choices) {
    if (repairToolCallArguments(choice?.message, new Map())) changed = true;
    if (repairToolCallArguments(choice?.delta, new Map())) changed = true;
    if (repairCompleteJsonTextField(choice?.message?.function_call, "arguments")) {
      changed = true;
    }
    if (repairCompleteJsonTextField(choice?.delta?.function_call, "arguments")) {
      changed = true;
    }
  }
  return changed;
}

function repairResponsesToolArguments(data) {
  let changed = false;
  for (const field of ["output", "data"]) {
    const items = Array.isArray(data?.[field]) ? data[field] : null;
    if (!items) continue;
    for (const item of items) {
      if (repairResponsesItemArguments(item)) changed = true;
    }
  }
  return changed;
}

// 用修复后的 JSON 文本重建 SSE 的 data 行（保留 data: 前缀与缩进）
function replaceSseDataLine(line, data) {
  const position = line.indexOf("data:");
  if (position === -1) return line;
  return `${line.slice(0, position + 5)} ${data}`;
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

    const parsed = parseJsonLenient(text);
    if (parsed.ok) {
      // 修复过才需要重新序列化；没修复就转发原始字节（省掉一次全量 stringify）
      const repaired = repairRequestToolArguments(parsed.value);
      return {
        isJson: true,
        parsed: parsed.value,
        raw: bytes,
        repaired,
      };
    }
  return { isJson: true, parsed: null, raw: bytes, invalidJson: true };
}

// 请求体是否被修复器改动过（决定能否直接转发原始字节）
function requestBodyNeedsRewrite(parsedBody) {
  return parsedBody?.repaired === true;
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
  headers.delete("connection");
  // 上游的 Set-Cookie 对 API 客户端没有意义，且会把厂商域的 cookie 带到客户端
  // （例如 OpenAI 的 __cf_bm），造成 cookie 域混淆；代理不转发。
  headers.delete("set-cookie");
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
  if (first) {
    const { content } = first;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (part) =>
            part && part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
    }
    return "";
  }

  // Responses API：input 可以是字符串，也可以是带 role/content 的 input item 数组
  const input = payload?.input;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (typeof item === "string") return item;
      if (item.role !== "user") continue;
      if (typeof item.content === "string") return item.content;
      if (Array.isArray(item.content)) {
        return item.content
          .filter(
            (part) =>
              part &&
              part.type === "input_text" &&
              typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n");
      }
    }
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
        } else if (Array.isArray(message.content) && message.content.length > 0) {
          // content part 数组（如带图片的多模态完成体）原样保留，不能静默丢弃
          delta.content = message.content;
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          delta.tool_calls = message.tool_calls.map((tool, position) => ({
            ...tool,
            index: Number.isInteger(tool?.index) ? tool.index : position,
          }));
        }
        // 旧版 function_call 同样不能在 JSON→SSE 转换时被静默丢弃
        if (message.function_call && typeof message.function_call === "object") {
          delta.function_call = message.function_call;
        }
        const finishReason = isValidFinishReason(choice?.finish_reason)
          ? choice.finish_reason
          : delta.tool_calls
            ? "tool_calls"
            : delta.function_call
              ? "function_call"
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

// 快路径判别：这个 SSE data 行是否需要完整 JSON 解析？
//
// Workers free 套餐每请求只有 10ms CPU 限额，而长流会有数千个 chunk。若每个
// chunk 都做一次完整 JSON.parse，CPU 会被自己的解析开销打满，运行时直接终止
// Worker（表现为流中途消失、没有任何终止事件、Worker 侧也没有终局记录）。
//
// 绝大多数 chunk 只是纯文本增量（content / reasoning_content），不含工具调用
// 与终止信息，对它们只做字符串级判断即可，跳过 JSON.parse。
// 需要完整解析的情况：含 tool_calls / function_call / error / finish_reason /
// usage，或含裸控制字符（外层 JSON 非法，需要修复路径）。
const NEEDS_FULL_PARSE_RE =
  /"tool_calls"|"function_call"|"error"|"finish_reason"|"usage"/;
// 裸控制字符会让外层 JSON 非法，必须走完整解析（修复路径）
const HAS_CONTROL_CHAR_RE = /[\u0000-\u001f]/;
const HAS_ERROR_RE = /"error"\s*:/;
const HAS_TOOL_CALLS_RE = /"tool_calls"\s*:/;
const HAS_FUNCTION_CALL_RE = /"function_call"\s*:/;
const HAS_USAGE_RE = /"usage"\s*:/;
// delta 里是否有非空 content（字符串形式）
const HAS_CONTENT_RE = /"content"\s*:\s*"[^"]+/;
const HAS_REASONING_RE = /"reasoning_content"\s*:\s*"[^"]+/;
// finish_reason 是非空字符串才算有效（空串是上游占位值，须忽略）
const HAS_FINISH_REASON_RE = /"finish_reason"\s*:\s*"[^"]+/;

function normalizeOpenAIChatSSE(body, idleMs, fallbackModel) {
  STREAM_DIAG.started++;
  const source = withIdleTimeout(body, idleMs);
  if (!source) return body;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawChoice = false;
  let sawFinishReason = false;
  let sawToolCalls = false;
  let sawContent = false;
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
  // 流式 tool_calls.arguments 分块到达，跨块记录字符串状态以便修复裸控制字符
  const toolArgStates = new Map();

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
  // - 已输出正文或 tool_calls 但没有 finish_reason → 补合成终止块
  // - 只收到 reasoning（思考中途被上游掐断）或什么都没收到 → 明确报错，
  //   不伪造成功：agent 客户端会看到正文为空的「成功」回答，错误事件才能
  //   触发它的重试逻辑
  const finishTerminal = (controller, isDone) => {
    if (!sawFinishReason && !terminalEmitted) {
      if (upstreamErrorMessage || upstreamErrorStructured) {
        if (!upstreamErrorStructured) {
          emit(controller, buildErrorChunk(upstreamErrorMessage));
        }
      } else if (sawChoice && (sawContent || sawToolCalls)) {
        emit(controller, buildFinishChunk());
        sawFinishReason = true;
      } else if (sawChoice) {
        emit(
          controller,
          buildErrorChunk(
            "Upstream stream ended during reasoning before any content was produced.",
          ),
        );
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
      // 快路径：绝大多数 chunk 只是纯文本增量（content / reasoning_content），
      // 不含工具调用、终止原因与错误信息。对它们只做字符串级判断，跳过
      // JSON.parse —— Workers free 套餐每请求 10ms CPU 限额，长流的解析
      // 开销足以让运行时终止 Worker（流中途消失且无终止事件）。
      const needsFullParse =
        NEEDS_FULL_PARSE_RE.test(eventData) ||
        HAS_CONTROL_CHAR_RE.test(eventData) ||
        // 快路径的前提是「这行确实是 JSON 对象」：非 JSON 的 data 行通常是
        // 上游报错文本（如 "upstream overloaded"），必须走完整解析来识别
        !eventData.startsWith("{");
      if (!needsFullParse) {
        // 快路径状态更新（与完整解析等价，但不做 JSON.parse）
        if (HAS_CONTENT_RE.test(eventData)) sawContent = true;
        if (HAS_FINISH_REASON_RE.test(eventData)) sawFinishReason = true;
        if (HAS_TOOL_CALLS_RE.test(eventData)) sawToolCalls = true;
        if (HAS_ERROR_RE.test(eventData) && !upstreamErrorMessage) {
          upstreamErrorMessage = "Upstream reported an error.";
        }
        if (eventData.includes('"choices"')) sawChoice = true;
        const idx = /"index"\s*:\s*(\d+)/.exec(eventData);
        if (idx) lastChoiceIndex = Number(idx[1]);
        if (!lastId) {
          const m = /"id"\s*:\s*"([^"]+)"/.exec(eventData);
          if (m) lastId = m[1];
        }
        if (!lastModel) {
          const m = /"model"\s*:\s*"([^"]+)"/.exec(eventData);
          if (m) lastModel = m[1];
        }
      }
      const parsed = needsFullParse
        ? parseJsonLenient(eventData)
        : { ok: false, skipped: true };
      if (parsed.ok) {
        chunk = parsed.value;
        let repaired = parsed.repaired !== undefined;
        const chunkChoices = Array.isArray(chunk?.choices) ? chunk.choices : [];
        for (const choice of chunkChoices) {
          if (repairToolCallArguments(choice?.delta, toolArgStates)) {
            repaired = true;
          }
          if (repairToolCallArguments(choice?.message, toolArgStates)) {
            repaired = true;
          }
          // 旧版 function_call：delta 分片按固定 key 续扫，完整 message 从
          // 干净状态扫；一条响应至多一个 function_call
          if (
            repairFragmentWithState(
              choice?.delta?.function_call,
              "arguments",
              "legacy_function_call",
              toolArgStates,
            )
          ) {
            repaired = true;
          }
          if (
            repairCompleteJsonTextField(
              choice?.message?.function_call,
              "arguments",
            )
          ) {
            repaired = true;
          }
        }
        // 修复过就重新序列化这一行；否则保持原始字节透传
        if (repaired) {
          line = replaceSseDataLine(line, JSON.stringify(chunk));
        }
      } else if (!parsed.skipped) {
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
          if (
            (typeof delta?.content === "string" && delta.content) ||
            (Array.isArray(delta?.content) && delta.content.length > 0)
          ) {
            sawContent = true;
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

  // 用 pull 循环而不是 pipeThrough：pipeThrough 遇到上游错误（连接中断、空闲
  // 超时）会把错误原样传给客户端，flush 不会执行，客户端只看到一条没有任何
  // 终止事件的断流（表现为 "provider stream ended before completion"，
  // reason=unknown）。pull 循环里错误也会走 finishTerminal，补出可识别的
  // error 事件 + [DONE]。pull 只在消费者要数据时触发，背压语义不变。
  const reader = source.getReader();
  // 客户端断开后，挂起的 reader.read() 会以 done:true 完成；此时绝不能再向
  // 已取消的 controller enqueue/close（会抛 TypeError 落进 catch 造成噪音）
  let clientCancelled = false;
  // 诊断断流用：区分「客户端腿断」与「上游腿断」全靠这三类日志的互斥出现
  let upstreamBytes = 0;
  // 我方 JS 处理累计耗时（不含等待上游的 I/O 时间）。free 套餐每请求 10ms CPU
  // 限额，若这里的累计值逼近上限，说明 Worker 是被运行时因 CPU 超限杀掉的。
  // 必须用 performance.now()（浮点毫秒）；Date.now() 的整数毫秒会把每批
  // 不足 1ms 的处理截断成 0，导致严重低估。
  let procMs = 0;
  let procStart = 0;
  let chunkCount = 0;
  let heartbeatCount = 0;
  const now = () => performance.now();
  const markStart = () => {
    procStart = now();
  };
  const markEnd = () => {
    procMs += now() - procStart;
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (clientCancelled) return;
        if (value) upstreamBytes += value.byteLength;
        if (done) {
          // 上游正常结束但可能没发 [DONE]：flush 剩余缓冲并补终止事件
          buffer += decoder.decode();
          if (buffer) handleLine(controller, buffer, true);
          const upstreamFinishedCleanly = sawFinishReason;
          finishTerminal(controller, false);
          recordStreamEnd(
            upstreamFinishedCleanly ? "complete" : "upstream-eof-no-finish",
            `bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount} id=${lastId || "-"}`,
          );
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        markStart();
        for (const line of lines) handleLine(controller, line, false);
        markEnd();
        chunkCount += lines.length;
        // 心跳：长流每 128 个 chunk 记录一次累计 CPU 耗时。若流被 CPU 超限杀掉，
        // 最后一条心跳会显示 procMs 逼近套餐限额；若被杀时连心跳都没有，说明
        // 不是 CPU 问题（进程被外部终止）
        heartbeatCount += lines.length;
        if (heartbeatCount >= 128) {
          heartbeatCount = 0;
          recordStreamEnd(
            "heartbeat",
            `bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount} id=${lastId || "-"}`,
          );
        }
      } catch (error) {
        if (clientCancelled) return;
        // 上游中途断流/空闲超时：同样补 error 事件 + [DONE]，并把真实原因
        // 带给客户端，而不是让它猜「流为什么断了」
        if (!upstreamErrorMessage) {
          upstreamErrorMessage =
            error?.message === "Upstream stream idle timeout"
              ? `Upstream idle timeout: no data for ${Math.ceil(idleMs / 1000)}s; connection aborted.`
              : `Upstream stream interrupted: ${
                  errorMessageOf(error) || "unknown error"
                }`;
        }
        recordStreamEnd(
          "upstream-interrupted",
          `bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount} msg=${upstreamErrorMessage.slice(0, 120)}`,
        );
        finishTerminal(controller, false);
        controller.close();
      }
    },
    cancel() {
      clientCancelled = true;
      recordStreamEnd(
        "client-cancel",
        `bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount} id=${lastId || "-"}`,
      );
      return reader.cancel().catch(() => {});
    },
  });
}

// Responses 流事件里的工具调用参数（同样可能在内层带裸控制字符）：
// - function_call_arguments.delta 的 delta 是参数文本分片，按 item_id 跨块续扫
// - function_call_arguments.done 的 arguments 是完整文本，从干净状态扫
// - output_item.added/in_progress 的 item 可能带部分参数文本，与后续 delta 续接
// - output_item.done 的 item 携带完整参数文本
// 只匹配这些确定的事件形状；output_text.delta 等普通文本事件绝不能碰，
// 否则正文里的控制字符会被当成 JSON 字符串内容错误转义。
function repairResponsesStreamEvent(value, argStates) {
  const type = typeof value?.type === "string" ? value.type : "";
  if (type === "response.function_call_arguments.delta") {
    return repairFragmentWithState(
      value,
      "delta",
      `resp:${typeof value.item_id === "string" ? value.item_id : ""}`,
      argStates,
    );
  }
  if (type === "response.function_call_arguments.done") {
    return repairCompleteJsonTextField(value, "arguments");
  }
  if (
    type === "response.output_item.added" ||
    type === "response.output_item.in_progress"
  ) {
    const item = value?.item;
    if (!item || (item.type !== "function_call" && item.type !== "mcp_call")) {
      return false;
    }
    return repairFragmentWithState(
      item,
      "arguments",
      `resp:${typeof item.id === "string" ? item.id : ""}`,
      argStates,
    );
  }
  if (type === "response.output_item.done") {
    return repairResponsesItemArguments(value?.item);
  }
  return false;
}

// 非 Chat 修复路径的 SSE（Responses、非 200 响应、其它协议）：
// 默认逐字节透传，但 data 行 JSON 若因裸控制字符解析失败，则只重写该行。
// 此外 Responses 事件里 function_call 参数的内层控制字符在此修复（外层解析
// 通过、内层二次解析会失败的场景），其余合法行保持原字节，透传语义不变。
function repairSseControlChars(body, idleMs) {
  const source = withIdleTimeout(body, idleMs);
  if (!source) return body;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const reader = source.getReader();
  let clientCancelled = false;
  // Responses 工具参数分片按 item_id 跨块续扫的状态
  const toolArgStates = new Map();
  // 与 Chat 路径同样的 CPU 计量（诊断断流归因用）
  let procMs = 0;
  let procStart = 0;
  let upstreamBytes = 0;
  let chunkCount = 0;
  const markStart = () => {
    procStart = performance.now();
  };
  const markEnd = () => {
    procMs += performance.now() - procStart;
  };

  const handleLine = (controller, line, isFinal) => {
    const position = line.indexOf("data:");
    if (position !== -1) {
      let payload = line.slice(position + 5);
      if (payload.endsWith("\r")) payload = payload.slice(0, -1);
      payload = payload.trim();
      if (payload && payload !== "[DONE]") {
        const parsed = parseJsonLenient(payload);
        if (parsed.ok) {
          let repaired = parsed.repaired !== undefined;
          if (repairResponsesStreamEvent(parsed.value, toolArgStates)) {
            repaired = true;
          }
          if (repaired) {
            line = replaceSseDataLine(line, JSON.stringify(parsed.value));
          }
        }
      }
    }
    controller.enqueue(encoder.encode(isFinal ? `${line}\n\n` : `${line}\n`));
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (clientCancelled) return;
        if (value) upstreamBytes += value.byteLength;
        if (done) {
          buffer += decoder.decode();
          markStart();
          if (buffer) handleLine(controller, buffer, true);
          markEnd();
          recordStreamEnd(
            "complete",
            `resp bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount}`,
          );
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        markStart();
        for (const line of lines) handleLine(controller, line, false);
        markEnd();
        chunkCount += lines.length;
      } catch (error) {
        // 透传路径不合成终止事件：流错误保持原有裸错误语义
        if (clientCancelled) return;
        recordStreamEnd(
          "upstream-interrupted",
          `resp bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount}`,
        );
        controller.error(error);
      }
    },
    cancel() {
      clientCancelled = true;
      recordStreamEnd(
        "client-cancel",
        `resp bytes=${upstreamBytes} procMs=${procMs.toFixed(1)} chunks=${chunkCount}`,
      );
      return reader.cancel().catch(() => {});
    },
  });
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
    const parseStart = performance.now();
    const parsedBody = await readRequestBody(request);
    const parseMs = performance.now() - parseStart;

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
      // 重新序列化整份请求体是大头（agent 请求带长对话历史，几百 KB），
      // 但绝大多数请求一个字节都不需要改——没改过就直接转发原始字节，
      // 省掉一次全量 JSON.stringify；只有修复过的才重新序列化
      const stringifyStart = performance.now();
      const needsRewrite = requestBodyNeedsRewrite(parsedBody);
      body = needsRewrite
        ? JSON.stringify(requestBodyObj)
        : parsedBody.raw || new TextEncoder().encode(JSON.stringify(requestBodyObj));
      const stringifyMs = performance.now() - stringifyStart;
      recordStreamEnd(
        "request-cpu",
        `bytes=${parsedBody.raw?.byteLength ?? -1} parseMs=${parseMs.toFixed(1)} stringifyMs=${stringifyMs.toFixed(1)} rewritten=${needsRewrite}`,
      );
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
  const lowerContentType = (contentType || "").toLowerCase();
  // 以上游返回的 Content-Type 为准：只看请求体的 stream 字段会漏掉由 query 参数
  // 或 Accept 头触发的 SSE（那样会被错误地整体缓冲）
  const isSSE = !!response.body && lowerContentType.includes("text/event-stream");

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
      : repairSseControlChars(response.body, idleTimeoutMs);

    return new Response(streamBody, {
      status: response.status,
      headers: streamHeaders,
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

  // ──── JSON 响应处理 ────
  if (lowerContentType.includes("application/json")) {
    const rawText = await readUpstreamText(response.body, idleTimeoutMs);
    let data;
    const parsed = parseJsonLenient(rawText);
    if (parsed.ok) {
      data = parsed.value;
      repairCompletionToolArguments(data);
      repairResponsesToolArguments(data);
    } else {
      // 上游声明 JSON 但 body 不是合法 JSON（空 body、截断、HTML 错误页等）。
      // 流式 Chat 请求仍返回 SSE 错误流；其它情况原样透传，保留上游状态码，
      // 避免把上游的 4xx/5xx 变成代理自己的 500。
      if (wantsChatStream && response.ok) {
        const snippet = rawText.trim().slice(0, 500);
        return new Response(
          buildChatSSEError(
            `Upstream returned invalid JSON (${contentType || "unknown content type"})` +
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
      return new Response(rawText, {
        status: response.status,
        headers: copyResponseHeaders(
          response,
          contentType || "application/json",
        ),
      });
    }

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
    if (resolved.provider === "deepseek" && data?.choices?.[0]?.message) {
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
