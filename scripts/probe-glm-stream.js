// GLM 流式断流探测：直连上游（glm_cp 通道）与线上网关各跑 N 轮 chat 流式请求，
// 记录每轮的结束形态（finish_reason / [DONE] / error 帧 / 裸断流），量化断流频率。
//
// 背景：严格客户端（opencode、ZCode 等）在 SSE 流没有以 finish_reason 终止时会报
// 「provider stream ended before completion」；智谱上游断流频率异常偏高，先摸清
// 上游真实行为，再决定网关侧的修复策略。
//
// 用法（Node >= 18 或 Bun 均可，无第三方依赖）：
//   bun scripts/probe-glm-stream.js            # direct + gateway 各 3 轮
//   bun scripts/probe-glm-stream.js direct 5   # 只测直连上游，5 轮
//   bun scripts/probe-glm-stream.js gateway 3  # 只测线上网关，3 轮
//
// 环境变量：
//   GLM_KEY      必需，编程套餐 key（额度在 glm_cp 通道）
//   GLM_MODEL    模型覆盖，默认 glm-5.3-flash（断流报错里的模型）
//   GATEWAY_BASE 网关地址，默认 https://max.gitcafe.ink
//   PROBE_PROMPT 诱导长输出的提示词覆盖
//
// 异常轮的原始 SSE 会写到 os.tmpdir()/glm-stream-probe-<target>-<n>.log 供离线分析。

const GLM_UPSTREAM_BASE = "https://open.bigmodel.cn/api/coding/paas/v4";
const GATEWAY_BASE = (process.env.GATEWAY_BASE || "https://max.gitcafe.ink").replace(
  /\/+$/,
  "",
);
const KEY = process.env.GLM_KEY;
const MODEL = process.env.GLM_MODEL || "glm-5.3-flash";
const PROMPT =
  process.env.PROBE_PROMPT ||
  "请写一篇不少于 1200 字的散文，主题是山中的四季，要求一直连贯地写到结尾，中途不要停下来。";
const REQUEST_TIMEOUT_MS = 180000;

const TARGETS = {
  direct: {
    label: "直连上游 glm_cp",
    url: `${GLM_UPSTREAM_BASE}/chat/completions`,
  },
  gateway: {
    label: "线上网关 /glm_cp",
    url: `${GATEWAY_BASE}/glm_cp/v1/chat/completions`,
  },
};

// 单轮探测：发起流式请求并逐行记录原始 SSE，返回结束形态分类
async function probeRound(url, round) {
  const started = Date.now();
  const outcome = {
    target: url,
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
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: PROMPT }],
        stream: true,
        max_tokens: 4096,
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
    const tag = url.includes("bigmodel.cn") ? "direct" : "gateway";
    const logPath = `${tmpDir()}\\glm-stream-probe-${tag}-${round}.log`;
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
  if (!KEY) {
    console.error("[FATAL] GLM_KEY 未设置");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const which = ["direct", "gateway", "both"].includes(args[0]) ? args[0] : "both";
  const rounds = Math.max(1, Math.min(10, parseInt(args[1], 10) || 3));

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
  if (proxy) console.log(`[WARN] 检测到本地代理 ${proxy}，若 401/连不上请把目标域名加入 NO_PROXY`);
  console.log(`[MODEL] ${MODEL}`);
  console.log(`[ROUNDS] ${rounds} per target\n`);

  const targets = which === "both" ? ["direct", "gateway"] : [which];
  const all = [];
  for (const name of targets) {
    const target = TARGETS[name];
    console.log(`=== ${target.label} === ${target.url}`);
    for (let i = 1; i <= rounds; i++) {
      const outcome = await probeRound(target.url, i);
      outcome.target = name;
      all.push(outcome);
      console.log(summarize(outcome));
    }
    console.log("");
  }

  const cuts = all.filter((o) => !["done", "http-error"].includes(o.closeType) || !o.sawFinishReason);
  console.log(
    `=== SUMMARY: ${all.length} 轮，健康 ${all.length - cuts.length}，异常 ${cuts.length} ===`,
  );
  for (const o of cuts) {
    console.log(`  异常: [${o.target}] #${o.round} closeType=${o.closeType} ${o.detail || o.rawLog || ""}`);
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error?.stack || error}`);
  process.exit(1);
});
