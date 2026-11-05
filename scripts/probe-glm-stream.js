// GLM 流式断流探测：直连上游与线上网关各通道跑 N 轮 chat 流式请求，
// 记录每轮的结束形态（finish_reason / [DONE] / error 帧 / 裸断流），量化断流频率。
//
// 背景：严格客户端（opencode、ZCode 等）在 SSE 流没有以 finish_reason 终止时会报
// 「provider stream ended before completion」；智谱/火山上游经 Cloudflare 出口断流
// 频率异常偏高，先摸清各通道真实行为，再决定网关侧的修复策略。
// 断流轮的 closeType 同时能反映部署状态：clean-close（裸断）= 线上是旧代码；
// error-frame（带错误事件）= 已部署终止兜底。
//
// 用法（Node >= 18 或 Bun 均可，无第三方依赖）：
//   bun scripts/probe-glm-stream.js              # 三个通道各 3 轮
//   bun scripts/probe-glm-stream.js direct 5     # 只测直连上游，5 轮
//   bun scripts/probe-glm-stream.js glm_cp 3     # 只测网关 glm_cp（GLM 官方）
//   bun scripts/probe-glm-stream.js volcengine 3 # 只测网关 volcengine（火山）
//
// 环境变量：
//   GLM_KEY         GLM 通道 key（直连与 glm_cp），必需
//   BYTEDANCE_KEY   火山通道 key，测 volcengine 时必需
//   GLM_MODEL       GLM 通道模型覆盖，默认 glm-5.3-flash
//   BYTEDANCE_MODEL 火山通道模型覆盖，默认 glm-5.3-flash
//   GATEWAY_BASE    网关地址，默认 https://max.gitcafe.ink
//   PROBE_PROMPT    诱导长输出的提示词覆盖
//
// 异常轮的原始 SSE 会写到 os.tmpdir()/glm-stream-probe-<target>-<n>.log 供离线分析。

const GLM_UPSTREAM_BASE = "https://open.bigmodel.cn/api/coding/paas/v4";
const ARK_UPSTREAM_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";
const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(
  /\/+$/,
  "",
);
const PROMPT =
  process.env.PROBE_PROMPT ||
  "请写一篇不少于 1200 字的散文，主题是山中的四季，要求一直连贯地写到结尾，中途不要停下来。";
const REQUEST_TIMEOUT_MS = 180000;
// 追加到请求体的自定义参数（JSON 字符串），例如关闭思考：
//   PROBE_EXTRA_BODY={"thinking":{"type":"disabled"}}
let EXTRA_BODY = null;
try {
  if (process.env.PROBE_EXTRA_BODY) EXTRA_BODY = JSON.parse(process.env.PROBE_EXTRA_BODY);
} catch (error) {
  console.error(`[FATAL] PROBE_EXTRA_BODY 不是合法 JSON: ${error.message}`);
  process.exit(1);
}

const TARGETS = {
  direct: {
    label: "直连上游 glm_cp（GLM 官方）",
    url: `${GLM_UPSTREAM_BASE}/chat/completions`,
    keyEnv: "GLM_KEY",
    model: process.env.GLM_MODEL || "glm-5.3-flash",
  },
  glm_cp: {
    label: "线上网关 /glm_cp（GLM 官方）",
    url: `${GATEWAY_BASE}/glm_cp/v1/chat/completions`,
    keyEnv: "GLM_KEY",
    model: process.env.GLM_MODEL || "glm-5.3-flash",
  },
  volcengine: {
    label: "线上网关 /volcengine（火山）",
    url: `${GATEWAY_BASE}/volcengine/v1/chat/completions`,
    keyEnv: "BYTEDANCE_KEY",
    model: process.env.BYTEDANCE_MODEL || "glm-5.3-flash",
  },
  volcengine_direct: {
    label: "直连上游 volcengine（火山）",
    url: `${ARK_UPSTREAM_BASE}/chat/completions`,
    keyEnv: "BYTEDANCE_KEY",
    model: process.env.BYTEDANCE_MODEL || "glm-5.3-flash",
  },
};

// 单轮探测：发起流式请求并逐行记录原始 SSE，返回结束形态分类
async function probeRound(target, name, round, key) {
  const url = target.url;
  const started = Date.now();
  const outcome = {
    target: name,
    round,
    status: null,
    durationMs: 0,
    bytes: 0,
    events: 0,
    contentChars: 0,
    sawFinishReason: false,
    finishReason: "",
    sawDone: false,
    errorFrames: [],
    nonJsonLines: [],
    closeType: "unknown", // done | clean-close | error-frame | http-error | timeout | connection-reset
    detail: "",
    rawLog: "",
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: PROMPT }],
        stream: true,
        max_tokens: 4096,
        ...(EXTRA_BODY || {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    outcome.durationMs = Date.now() - started;
    outcome.closeType = error?.name === "TimeoutError" ? "timeout" : "connection-reset";
    outcome.detail = String(error?.message || error).slice(0, 200);
    return outcome;
  }

  outcome.status = response.status;
  if (!response.ok) {
    outcome.durationMs = Date.now() - started;
    outcome.closeType = "http-error";
    const text = await response.text().catch(() => "");
    outcome.detail = text.slice(0, 300);
    outcome.rawLog = `[HTTP ${response.status}] ${text}`;
    return outcome;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const rawLines = [];

  const classifyLine = (line) => {
    rawLines.push(line);
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      outcome.sawDone = true;
      return;
    }
    if (!data) return;
    outcome.events++;
    try {
      const chunk = JSON.parse(data);
      if (chunk.error) {
        outcome.errorFrames.push(JSON.stringify(chunk.error).slice(0, 300));
      }
      const choice = chunk.choices?.[0];
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        outcome.sawFinishReason = true;
        outcome.finishReason = choice.finish_reason;
      }
      const delta = choice?.delta || choice?.message;
      if (typeof delta?.content === "string") outcome.contentChars += delta.content.length;
    } catch (_) {
      outcome.nonJsonLines.push(data.slice(0, 200));
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outcome.bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) classifyLine(line);
    }
    if (buffer) classifyLine(buffer);
    outcome.durationMs = Date.now() - started;
    outcome.closeType =
      outcome.errorFrames.length > 0
        ? "error-frame"
        : outcome.sawDone
          ? "done"
          : "clean-close"; // 上游 EOF 但没发 [DONE]
  } catch (error) {
    if (buffer) classifyLine(buffer);
    outcome.durationMs = Date.now() - started;
    outcome.closeType =
      error?.name === "TimeoutError" ? "timeout" : "connection-reset";
    outcome.detail = String(error?.message || error).slice(0, 200);
  }

  // 异常形态落盘原始 SSE，供离线分析
  const healthy =
    outcome.closeType === "done" &&
    outcome.sawFinishReason &&
    outcome.errorFrames.length === 0;
  if (!healthy) {
    const logPath = `${tmpDir()}\\glm-stream-probe-${name}-${round}.log`;
    try {
      await import("node:fs").then((fs) =>
        fs.promises.writeFile(logPath, rawLines.join("\n"), "utf8"),
      );
      outcome.rawLog = logPath;
    } catch (_) {
      outcome.rawLog = `(落盘失败，保留前 800 字节) ${rawLines.slice(-8).join("\n").slice(0, 800)}`;
    }
  }
  return outcome;
}

function tmpDir() {
  return process.env.TEMP || process.env.TMP || "/tmp";
}

function summarize(outcome) {
  const flags = [
    outcome.sawFinishReason ? `finish=${outcome.finishReason}` : "finish=缺失",
    outcome.sawDone ? "[DONE]" : "[DONE]缺失",
  ];
  if (outcome.errorFrames.length > 0) {
    flags.push(`error帧×${outcome.errorFrames.length}: ${outcome.errorFrames[0].slice(0, 120)}`);
  }
  if (outcome.nonJsonLines.length > 0) {
    flags.push(`非JSON行×${outcome.nonJsonLines.length}`);
  }
  const label =
    outcome.closeType === "done" && outcome.sawFinishReason && !outcome.errorFrames.length
      ? "OK"
      : outcome.closeType.toUpperCase();
  return [
    `[${label}]`,
    `#${outcome.round}`,
    `HTTP ${outcome.status ?? "-"}`,
    `${(outcome.durationMs / 1000).toFixed(1)}s`,
    `${outcome.bytes}B/${outcome.events}evt/${outcome.contentChars}字`,
    flags.join(" "),
    outcome.detail ? `detail=${outcome.detail}` : "",
    outcome.rawLog && !outcome.rawLog.startsWith("(") ? `log=${outcome.rawLog}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function main() {
  const args = process.argv.slice(2);
  const which = TARGETS[args[0]] ? args[0] : "all";
  const rounds = Math.max(1, Math.min(10, parseInt(args[1], 10) || 3));

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
  if (proxy) console.log(`[WARN] 检测到本地代理 ${proxy}，若 401/连不上请把目标域名加入 NO_PROXY`);
  console.log(`[ROUNDS] ${rounds} per target\n`);

  const targets = which === "all" ? Object.keys(TARGETS) : [which];
  const all = [];
  for (const name of targets) {
    const target = TARGETS[name];
    const key = process.env[target.keyEnv];
    console.log(`=== ${target.label} === ${target.url} (model: ${target.model})`);
    if (!key) {
      console.log(`[SKIP] ${target.keyEnv} 未设置\n`);
      continue;
    }
    for (let i = 1; i <= rounds; i++) {
      const outcome = await probeRound(target, name, i, key);
      all.push(outcome);
      console.log(summarize(outcome));
    }
    console.log("");
  }

  const isHealthy = (o) =>
    o.closeType === "done" && o.sawFinishReason && o.errorFrames.length === 0;
  console.log(`=== SUMMARY ===`);
  for (const name of [...new Set(all.map((o) => o.target))]) {
    const rows = all.filter((o) => o.target === name);
    const bad = rows.filter((o) => !isHealthy(o));
    console.log(
      `  ${TARGETS[name]?.label || name}: ${rows.length - bad.length}/${rows.length} 健康` +
        (bad.length
          ? `，异常 ${bad.map((o) => `#${o.round}:${o.closeType}`).join(" ")}`
          : ""),
    );
  }
  for (const o of all.filter((o) => !isHealthy(o))) {
    console.log(
      `  异常: [${o.target}] #${o.round} closeType=${o.closeType} HTTP ${o.status ?? "-"} ${o.detail || o.rawLog || ""}`,
    );
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error?.stack || error}`);
  process.exit(1);
});
