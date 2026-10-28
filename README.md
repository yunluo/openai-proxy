# Multi-Provider API Proxy

一个部署在 Cloudflare Workers 上的多厂商 AI API 反向代理服务，通过 URL 路径前缀将请求路由到不同的 AI 服务商。

<p align="center">我❤️Cloudflare</p>

## 项目背景

在企业内网环境中，部分 AI 服务商的接口可能受到限制。本项目通过将 AI API 请求代理到企业内网可访问的 Cloudflare Workers 域名，实现曲线访问多个 AI 服务商。

## 功能特点

- 多厂商路由: `/{provider}/v1/*` 路径前缀自动映射到对应厂商
- 内置支持 **MiniMax**、**GLM (智谱)**、**GLM CP (智谱编程)**、**Kimi (月之暗面)**、**DeepSeek**、**OpenAI (GPT)**、**小米 MiMo**、**小米 MiMo CP**、**通义千问**、**OpenCode Go**、**硅基流动**、**阿里云**、**火山方舟**、**OpenRouter**、**Kilo**、**OpenCode Zen**
- 支持通过环境变量自定义任意厂商（自定义 Provider）
- **原生支持 OpenAI Responses API（优先）**：`/{provider}/v1/responses`，非流式、SSE 流式、`GET /responses/{id}` 等均原样透传；裸 `/v1/responses` 默认走 OpenAI（`gpt`）
- **原生支持 OpenAI Chat Completions API**：`/{provider}/v1/chat/completions`，兼容现有 Chat 客户端；裸 `/v1/chat/completions` 默认走 OpenAI（`gpt`）
- 两种协议共用同一个 provider 基址，代理不做协议转换
- `Bearer` / `X-API-Key` 认证方式
- API Key 由客户端提供（安全可靠）
- Cloudflare 全球边缘网络加速
- OpenAI Chat Completions 流式响应自动补齐上游缺失的 `finish_reason` 终止块与 `data: [DONE]`
- `GET /v1/models` 返回代理内置的厂商列表

## 协议支持

同一个 provider 基址（例如 `https://<部署域名>/gpt/v1`）直接支持两套协议，代理只做透明转发，**不做 Responses ↔ Chat 转换**：

| 协议 | 路径 | 说明 |
|------|------|------|
| **Responses API（优先）** | `POST /{provider}/v1/responses` | 创建响应；`stream: true` 时按上游 `text/event-stream` 原样透传；各厂商基址见下表 |
| **Responses API 默认入口** | `POST /v1/responses` | 不带 provider 前缀时默认走 OpenAI（`gpt`） |
| Responses API | `GET /{provider}/v1/responses/{id}` | 获取响应（部分厂商支持，如 GLM、火山） |
| Responses API | `POST /{provider}/v1/responses/{id}/cancel` | 取消响应（部分厂商支持；GLM 当前无 cancel） |
| Responses API | `GET/POST /{provider}/v1/responses/{id}/input_items` | 读取 / 追加输入项（部分厂商支持） |
| **Chat Completions API** | `POST /{provider}/v1/chat/completions` | 兼容现有 Chat 客户端 |
| **Chat Completions 默认入口** | `POST /v1/chat/completions` | 不带 provider 前缀时默认走 OpenAI（`gpt`） |
| 模型列表 | `GET /v1/models` | 由代理本地返回厂商列表 |

- 裸 `/v1/responses` 与 `/v1/chat/completions` 默认走 OpenAI（`gpt`）；其它裸 `/v1/*`（如 `/v1/embeddings`）返回 400 `invalid_request_error`；`GET /v1/models` 是代理本地端点，不需要前缀
- `previous_response_id`、`store`、`background`、内置工具等能力由上游原生实现，代理不保存状态
- Responses 的 `response.*` SSE 事件逐字节原样返回；Chat Completions 的 `finish_reason` / `[DONE]` 终止块修复只作用于 `/chat/completions`，不会改写 Responses 事件

### 各厂商 Responses 基址（已核对）

Responses API 与 Chat Completions 的基址并不总是相同，代理会按请求路径自动选择：

| 厂商 | Chat 基址 | Responses 基址 | 官方文档 |
|------|-----------|----------------|----------|
| MiniMax | `https://api.minimaxi.com/v1` | `https://api.minimax.cn/v1` | [创建 Response](https://platform.minimax.cn/docs/api-reference/responses-create) |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `https://open.bigmodel.cn/api/v1` | [创建 Response](https://docs.bigmodel.cn/api-reference/response/%E5%88%9B%E5%BB%BA-response) |
| 智谱 GLM CP（编程） | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://open.bigmodel.cn/api/v1` | [创建 Response](https://docs.bigmodel.cn/api-reference/response/%E5%88%9B%E5%BB%BA-response) |
| DeepSeek | `https://api.deepseek.com/v1` | `https://api.deepseek.com` | [Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api) |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/coding/v3` | 同左（编程套餐） | [Responses API](https://console.volcengine.com/ark/region:cn-beijing/docs/responses-api-text-generation) |
| OpenAI | `https://api.openai.com/v1` | 同左 | [Responses API](https://platform.openai.com/docs/api-reference/responses) |
| OpenRouter | `https://openrouter.ai/api/v1` | 同左 | [Responses API](https://openrouter.ai/docs/api_reference/responses/overview) |

代理实际请求示例：

- `/minimax/v1/responses` → `https://api.minimax.cn/v1/responses`
- `/glm/v1/responses` → `https://open.bigmodel.cn/api/v1/responses`
- `/glm_cp/v1/responses` → `https://open.bigmodel.cn/api/v1/responses`
- `/deepseek/v1/responses` → `https://api.deepseek.com/responses`
- `/volcengine/v1/responses` → `https://ark.cn-beijing.volces.com/api/coding/v3/responses`
- 对应的 `/chat/completions` 仍走各自的 Chat 基址

如果只覆盖了 `*_API_BASE`（且值不同于默认值）而没有设置 `*_RESPONSES_API_BASE`，Responses 会复用该自定义网关；两者不同时请显式设置 Responses 基址。

> - MiniMax：Responses 文档站点是 `api.minimax.cn`，与本项目默认的 Chat 地址 `api.minimaxi.com` 不同；如果账号/密钥分属不同站点，请分别配置两个基址。
> - 火山方舟：官方 Responses 文档示例使用通用 `/api/v3`；本项目默认按 OpenAI 兼容编程套餐入口 `https://ark.cn-beijing.volces.com/api/coding/v3`。`volcengine` 的 Chat 与 Responses 默认都走编程套餐；如果要切到通用方舟 `/api/v3`，把 `VOLCENGINE_API_BASE` 设为 `https://ark.cn-beijing.volces.com/api/v3`；只想让 Responses 走通用方舟时，改用 `VOLCENGINE_RESPONSES_API_BASE`。
> - 智谱编程套餐：`glm_cp` 的 Responses 默认使用标准 Responses 基址 `https://open.bigmodel.cn/api/v1`（与 `glm` 相同），Chat 仍走 `https://open.bigmodel.cn/api/coding/paas/v4`；如编程套餐提供独立的 Responses 端点，可用 `GLM_CP_RESPONSES_API_BASE` 覆盖。
> - 智谱 Responses 官方建议超时 7200 秒；代理默认等上游响应头 300 秒（`UPSTREAM_TIMEOUT_MS`），长任务请调大。流式思考阶段长时间无新事件时，`STREAM_IDLE_TIMEOUT_MS`（默认 120 秒）会中断，按需调大或设为 `0`。

### Responses 能力差异（以各厂商文档为准）

| 厂商 | 多轮 / 状态 | 查询 / 删除 | 备注 |
|------|-------------|-------------|------|
| MiniMax | 以官方文档为准 | 以官方文档为准 | Responses 使用 `api.minimax.cn`；支持 reasoning、图片/视频输入 |
| 智谱 GLM | `store` + `previous_response_id`（7 天） | GET / DELETE / input_items；无 cancel | 基址是 `/api/v1`，不是 Chat 的 `/api/paas/v4` |
| DeepSeek | 无状态；`previous_response_id` / `store` 不支持 | 无 GET / DELETE | 仅 `POST /responses`；不支持的字段会被静默忽略 |
| 火山方舟 | `previous_response_id` / `store` 支持 | 文档示例包含 DELETE | 默认基址是编程套餐 `/api/coding/v3`；`thinking` / `caching` 等为方舟扩展字段 |

## API 端点

> 下表中的「目标 API」是 Chat Completions 基址；每个路径前缀都可以接收 `/responses` 与 `/chat/completions`，Responses 使用上方已核对的基址表。上游是否实现某个协议由厂商决定。

| 厂商 | 路径前缀 | 目标 API |
|------|----------|----------|
| MiniMax | `/minimax/v1/` | `https://api.minimaxi.com/v1` |
| 智谱 GLM | `/glm/v1/` | `https://open.bigmodel.cn/api/paas/v4` |
| 智谱 GLM CP (编程) | `/glm_cp/v1/` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| Kimi 月之暗面 | `/kim/v1/` | `https://api.moonshot.cn/v1` |
| DeepSeek | `/deepseek/v1/` | `https://api.deepseek.com/v1` |
| OpenAI GPT | `/gpt/v1/` | `https://api.openai.com/v1` |
| 小米 MiMo | `/xiaomi/v1/` | `https://api.xiaomimimo.com/v1` |
| 小米 MiMo CP | `/xiaomi_cp/v1/` | `https://token-plan-cn.xiaomimimo.com/v1` |
| 通义千问 | `/qwen/v1/` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenCode Go | `/opencode/v1/` | `https://opencode.ai/zen/go/v1` |
| 硅基流动 | `/siliconflow/v1/` | `https://api.siliconflow.cn/v1` |
| 阿里云 | `/aliyun/v1/` | `https://coding.dashscope.aliyuncs.com/v1` |
| 火山方舟 | `/volcengine/v1/` | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| OpenRouter | `/openrouter/v1/` | `https://openrouter.ai/api/v1` |
| Kilo | `/kilo/v1/` | `https://api.kilo.ai/api/gateway` |
| OpenCode Zen | `/opencode_zen/v1/` | `https://opencode.ai/zen/v1` |
| 自定义 | `/{自定义名称}/v1/` | 由环境变量配置 |
| 额度 / 套餐查询 | `/token_plan/*`、`/coding_plan/*` | `https://www.minimaxi.com`（**保留路径前缀**） |
| 模型列表 | `GET /v1/models` | 由代理本地返回，不转发上游 |
| OpenCode Zen / Go 的 `x-opencode-session` | 任意 | 代理会自动补一个格式合法的会话 id，并透传 `x-opencode-session`、`x-session-id`、`x-session-affinity`、`x-opencode-client`、`HTTP-Referer`、`X-Title` |

| 平台 | 部署地址示例 |
|------|-------------|
| **Cloudflare Workers** | `https://maxapi.yunluo.workers.dev` |

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?to=:github)

## 手动部署

### Cloudflare Workers (GitHub 集成)

1. 访问 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Workers & Pages → 创建 Worker → 选择从 GitHub 导入
3. 连接您的 GitHub 仓库并部署

`wrangler.toml` 中的要点：

- `name` 必须与 Cloudflare 上已有的 Worker 名一致，否则会新建一个 Worker
- `[placement]` 只写 `mode = "smart"`：四种 placement 选项（`mode` / `region` / `host` / `hostname`）互斥，本代理要访问多个上游，交给 Cloudflare 自动挑选离上游最近的位置
- `[observability] enabled = true` 打开 Workers Logs（免费计划含 20 万条日志/天，可在 dashboard 的 Observability 查看）
- `compatibility_date` 建议改为当前日期后再部署（本项目代码只用到标准 Web API）

## 环境变量配置（可选）

### 内置厂商 API 地址

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MINIMAX_API_BASE` | `https://api.minimaxi.com/v1` | MiniMax Chat API 地址 |
| `MINIMAX_RESPONSES_API_BASE` | `https://api.minimax.cn/v1` | MiniMax Responses API 地址 |
| `MINIMAX_API_BASE_WWW` | `https://www.minimaxi.com` | MiniMax 额度查询地址 |
| `GLM_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | 智谱 Chat API 地址 |
| `GLM_RESPONSES_API_BASE` | `https://open.bigmodel.cn/api/v1` | 智谱 Responses API 地址 |
| `GLM_CP_API_BASE` | `https://open.bigmodel.cn/api/coding/paas/v4` | 智谱编程 Chat API 地址 |
| `GLM_CP_RESPONSES_API_BASE` | `https://open.bigmodel.cn/api/v1` | 智谱编程 Responses 基址（与 Chat 基址不同） |
| `KIMI_API_BASE` | `https://api.moonshot.cn/v1` | Kimi API 地址 |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com/v1` | DeepSeek Chat API 地址 |
| `DEEPSEEK_RESPONSES_API_BASE` | `https://api.deepseek.com` | DeepSeek Responses API 地址 |
| `GPT_API_BASE` | `https://api.openai.com/v1` | OpenAI API 地址（也是裸 `/v1/responses` 与 `/v1/chat/completions` 的默认上游） |
| `XIAOMI_API_BASE` | `https://api.xiaomimimo.com/v1` | 小米 MiMo API 地址 |
| `XIAOMI_CP_API_BASE` | `https://token-plan-cn.xiaomimimo.com/v1` | 小米 MiMo CP API 地址 |
| `QWEN_API_BASE` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 通义千问 API 地址 |
| `OPENCODE_API_BASE` | `https://opencode.ai/zen/go/v1` | OpenCode Go API 地址 |
| `SILICONFLOW_API_BASE` | `https://api.siliconflow.cn/v1` | 硅基流动 API 地址 |
| `ALIYUN_API_BASE` | `https://coding.dashscope.aliyuncs.com/v1` | 阿里云 API 地址 |
| `VOLCENGINE_API_BASE` | `https://ark.cn-beijing.volces.com/api/coding/v3` | 火山方舟 Chat API 地址（编程套餐） |
| `VOLCENGINE_RESPONSES_API_BASE` | 未设置（复用 `VOLCENGINE_API_BASE`） | 火山方舟 Responses API 地址覆盖 |
| `OPENROUTER_API_BASE` | `https://openrouter.ai/api/v1` | OpenRouter API 地址 |
| `KILO_API_BASE` | `https://api.kilo.ai/api/gateway` | Kilo API 地址 |
| `OPENCODE_ZEN_API_BASE` | `https://opencode.ai/zen/v1` | OpenCode Zen API 地址 |

### 代理自身配置（可选）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PROXY_ACCESS_TOKEN` | 未设置（不校验） | 设置后所有请求必须带 `x-proxy-token: <口令>`，否则返回 401。用于避免域名被他人当中继滥用 |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 等上游响应头的超时（毫秒）。非流式请求要等上游生成完才有响应头，所以默认给得宽；超时返回 504 `upstream_timeout` |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | 读上游 body 的空闲超时（毫秒）：超过这么久没有任何新数据即判定上游卡死，中断并报错；`0` 表示不限制 |

OpenAI 兼容客户端一般在自定义 header 里加一项 `x-proxy-token: <口令>` 即可。

### 自定义 Provider

支持通过编号环境变量添加任意数量的自定义厂商：

| 变量名 | 说明 |
|--------|------|
| `CUSTOM_PROVIDER_1_NAME` | 自定义厂商名称（用作 URL 路径前缀） |
| `CUSTOM_PROVIDER_1_API_BASE` | 自定义厂商 Chat API 地址 |
| `CUSTOM_PROVIDER_1_RESPONSES_API_BASE` | 可选；自定义厂商 Responses API 地址（未设置时复用 `API_BASE`） |
| `CUSTOM_PROVIDER_2_NAME` | 第二个自定义厂商名称 |
| `CUSTOM_PROVIDER_2_API_BASE` | 第二个自定义厂商 Chat API 地址 |
| ... | 以此类推 |

例如配置 `CUSTOM_PROVIDER_1_NAME=mole` + `CUSTOM_PROVIDER_1_API_BASE=https://api.mole.ai` 后，即可通过 `/mole/v1/chat/completions` 访问；如需独立的 Responses 端点，再配置 `CUSTOM_PROVIDER_1_RESPONSES_API_BASE`，然后使用 `/mole/v1/responses`。

### 认证方式

- **OpenAI 兼容端点**（MiniMax、GLM、DeepSeek、OpenCode Go 等）：通过 `Authorization: Bearer <your-api-key>` 传递 API Key；也兼容 `X-API-Key` 头

## 使用示例

所有请求地址格式均为 `https://<部署域名>/<provider>/v1/<path>`；裸 `/v1/responses` 与 `/v1/chat/completions` 默认走 OpenAI，其它路径必须带 provider 前缀（代理本地的 `GET /v1/models` 除外）。

```bash
# OpenAI Responses（优先；其他厂商把 /gpt 换成对应前缀）
curl --request POST 'https://maxapi.yunluo.workers.dev/gpt/v1/responses' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"gpt-5.1","input":"Hello"}'

# 裸 /v1/responses（默认走 OpenAI）
curl --request POST 'https://maxapi.yunluo.workers.dev/v1/responses' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"gpt-5.1","input":"Hello"}'

# MiniMax Responses
curl --request POST 'https://maxapi.yunluo.workers.dev/minimax/v1/responses' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiniMax-M3.1-Flash","input":"Hello"}'

# 智谱 GLM Responses
curl --request POST 'https://maxapi.yunluo.workers.dev/glm/v1/responses' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-5.3","input":"Hello"}'

# DeepSeek Responses
curl --request POST 'https://maxapi.yunluo.workers.dev/deepseek/v1/responses' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"deepseek-flash","input":"Hello"}'

# 火山方舟 Responses
curl --request POST 'https://maxapi.yunluo.workers.dev/volcengine/v1/responses' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"doubao-seed-2-1-pro-260915","input":"Hello"}'

# MiniMax Chat Completions
curl --request POST 'https://maxapi.yunluo.workers.dev/minimax/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"Hello"}]}'

# 裸 /v1/chat/completions（默认走 OpenAI）
curl --request POST 'https://maxapi.yunluo.workers.dev/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"gpt-5.1","messages":[{"role":"user","content":"Hello"}]}'

# 智谱 GLM
curl --request POST 'https://maxapi.yunluo.workers.dev/glm/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-4","messages":[{"role":"user","content":"Hello"}]}'

# Kimi 月之暗面
curl --request POST 'https://maxapi.yunluo.workers.dev/kim/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"moonshot-v1-8k","messages":[{"role":"user","content":"Hello"}]}'

# DeepSeek
curl --request POST 'https://maxapi.yunluo.workers.dev/deepseek/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'

# OpenAI GPT
curl --request POST 'https://maxapi.yunluo.workers.dev/gpt/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'

# 小米 MiMo
curl --request POST 'https://maxapi.yunluo.workers.dev/xiaomi/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiMo-8B","messages":[{"role":"user","content":"Hello"}]}'

# 通义千问
curl --request POST 'https://maxapi.yunluo.workers.dev/qwen/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"qwen-turbo","messages":[{"role":"user","content":"Hello"}]}'

# OpenCode Go
curl --request POST 'https://maxapi.yunluo.workers.dev/opencode/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-4-plus","messages":[{"role":"user","content":"Hello"}]}'

# 硅基流动
curl --request POST 'https://maxapi.yunluo.workers.dev/siliconflow/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"Hello"}]}'

# 阿里云
curl --request POST 'https://maxapi.yunluo.workers.dev/aliyun/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"qwen-turbo","messages":[{"role":"user","content":"Hello"}]}'

# 火山方舟
curl --request POST 'https://maxapi.yunluo.workers.dev/volcengine/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"doubao-1.5-pro-32k","messages":[{"role":"user","content":"Hello"}]}'

# 智谱 GLM CP (编程)
curl --request POST 'https://maxapi.yunluo.workers.dev/glm_cp/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-4","messages":[{"role":"user","content":"Hello"}]}'

# 小米 MiMo CP
curl --request POST 'https://maxapi.yunluo.workers.dev/xiaomi_cp/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiMo-8B","messages":[{"role":"user","content":"Hello"}]}'

# 自定义 Provider（需配置 CUSTOM_PROVIDER_1_NAME=mole + CUSTOM_PROVIDER_1_API_BASE）
curl --request POST 'https://maxapi.yunluo.workers.dev/mole/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

### Python SDK (OpenAI 兼容)

```python
from openai import OpenAI

# Responses API（优先，GPT）
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/gpt/v1",
    api_key="your-gpt-key"
)
response = client.responses.create(
    model="gpt-5.1",
    input="Hello!"
)
print(response.output_text)

# Chat Completions（GPT）
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/gpt/v1",
    api_key="your-gpt-key"
)
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 小米 MiMo
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/xiaomi/v1",
    api_key="your-xiaomi-key"
)
response = client.chat.completions.create(
    model="MiMo-8B",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 通义千问
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/qwen/v1",
    api_key="your-qianwen-key"
)
response = client.chat.completions.create(
    model="qwen-turbo",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# OpenCode Go
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/opencode/v1",
    api_key="your-opencode-key"
)
response = client.chat.completions.create(
    model="glm-4-plus",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 硅基流动
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/siliconflow/v1",
    api_key="your-siliconflow-key"
)
response = client.chat.completions.create(
    model="Qwen/Qwen2.5-7B-Instruct",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 阿里云
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/aliyun/v1",
    api_key="your-aliyun-key"
)
response = client.chat.completions.create(
    model="qwen-turbo",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 火山方舟
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/volcengine/v1",
    api_key="your-volcengine-key"
)
response = client.chat.completions.create(
    model="doubao-1.5-pro-32k",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 智谱 GLM CP (编程)
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/glm_cp/v1",
    api_key="your-glm-key"
)
response = client.chat.completions.create(
    model="glm-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 小米 MiMo CP
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/xiaomi_cp/v1",
    api_key="your-xiaomi-key"
)
response = client.chat.completions.create(
    model="MiMo-8B",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 自定义 Provider（需配置 CUSTOM_PROVIDER_1_NAME=mole + CUSTOM_PROVIDER_1_API_BASE）
client = OpenAI(
    base_url="https://maxapi.yunluo.workers.dev/mole/v1",
    api_key="your-mole-key"
)
response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "hi"}]
)
print(response.choices[0].message.content)
```

### OpenCode 自定义 Provider（推荐）

OpenCode 内置的 `opencode` provider 会直连 OpenCode Zen，不经过本代理，因此代理的 SSE 终止块修复不会生效。要让 DeepSeek V4.1 Flash Free 等模型走代理，请在 `~/.config/opencode/opencode.jsonc` 中增加一个自定义 provider：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "maxapi-zen": {
      "name": "MaxAPI Zen",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        // 末尾不要带 /chat/completions，OpenCode 会自己拼接
        "baseURL": "https://maxapi.yunluo.workers.dev/opencode_zen/v1"
      },
      "models": {
        "deepseek-v4.1-flash-free": {
          "name": "DeepSeek V4.1 Flash Free"
        }
      }
    }
  },
  // 可选：新会话默认使用代理 provider
  "model": "maxapi-zen/deepseek-v4.1-flash-free"
}
```

然后使用 `maxapi-zen/deepseek-v4.1-flash-free`：

```bash
opencode run -m maxapi-zen/deepseek-v4.1-flash-free "你好"
```

免费 Zen 模型不需要填写 `apiKey`：上游免费层只校验 OpenCode 客户端身份头，带任意占位 key 反而会返回 `Invalid credential`，所以代理对 `-free` 模型（以及 `big-pickle`）会自动去掉 `Authorization`。付费 Zen 模型仍会透传客户端提供的真实 key。

### Token Plan 额度查询

```bash
curl https://maxapi.yunluo.workers.dev/token_plan/billing/query \
  -H "Authorization: Bearer $YOUR_TOKEN_PLAN_KEY"
```

## 项目结构

```
openai-proxy/
├── workers/
│   └── index.js      # Cloudflare Workers 适配器
├── src/
│   ├── core.js       # 共享核心代理逻辑（多厂商路由 + 流式修复）
│   └── config.js     # API 配置（内置厂商 + 环境变量）
├── test/
│   ├── core.test.js     # 路由 / 流式转换测试
│   └── adapters.test.js # Cloudflare Workers 适配器测试
├── wrangler.toml     # Cloudflare Workers 配置
└── package.json      # 项目依赖
```

## 开发与测试

```bash
# 运行测试（Node 18+ 内置测试运行器，或使用 bun）
npm test
bun test

# 本地开发
npm run dev      # Cloudflare Workers（wrangler dev）
```

测试覆盖：缺失/空 API Key、OpenCode Zen 免费模型匿名请求与 key 透传、provider 路由与查询串、`/token_plan` 前缀保留、未知 provider 与 `__proto__`、
multipart 原样透传、非法 JSON 返回 400、上游错误码/响应头保留、流式事件序列与中途出错处理、
Responses 原生透传（POST / GET / DELETE、裸 `/v1/responses` 与 `/v1/chat/completions` 默认 OpenAI、MiniMax/GLM/DeepSeek/火山的 Responses 基址分离、`*_RESPONSES_API_BASE` 覆盖、`response.*` SSE 事件、`openai-*` / `idempotency-key` 请求头、不做 Chat 转换）、
OpenAI SSE 缺失 `finish_reason` / `[DONE]` 时的终止块补齐（含 CRLF、跨 chunk 拆行、实时转发、错误流不伪造成功）。

## 技术栈

- Cloudflare Workers
- Node.js 18+（本地运行测试需要）
- API Proxy

## 注意事项

- 请妥善保管您的 API Key
- 本代理原生透传 Responses API 与 Chat Completions API，两者共用同一 provider 基址，不做协议互转；`previous_response_id`、`store`、`background` 等状态化能力由上游决定
- 本代理只代理 OpenAI 兼容接口；Anthropic Messages 协议及其厂商端点（`minimax_anthropic` / `deepseek_anthropic` / `opencode_anthropic`）已移除，这些路径会返回 404。`x-api-key` 仍可作为通用 API Key 头使用
- 严格遵守各厂商的 API 使用条款（含 OpenAI 等）
- 代理会按白名单透传少量头（`x-opencode-session`、`x-opencode-session-id`、`x-opencode-parent-session-id`、`x-opencode-client`、`x-opencode-project`、`x-opencode-request`、`x-session-id`、`x-session-affinity`、`x-parent-session-id`、`user-agent`、`HTTP-Referer`、`X-Title`、`openai-beta`、`openai-organization`、`openai-project`、`idempotency-key`），不会转发 `host`/`cookie` 等敏感头
- `/opencode`（Go 网关 `zen/go/v1`）与 `/opencode_zen`（`zen/v1`）都要求会话头：Go 缺失时返回 400 `MissingSessionID`，Zen 免费模型还会校验 `x-opencode-session` 的格式（`ses_` + 12 位十六进制 + 14 位 base62）。客户端自带的会话值格式合法就沿用，否则（包括 opencode 接自定义 provider 时只发 `x-session-id`、或旧版派生出的 `ses_<8位十六进制>`）由代理重新补一个合法值：按 `apiKey + model + 首条用户消息` 派生，同一对话的每一轮都得到同一个 id（保留上游路由与提示缓存亲和）
- `/opencode_zen`（`zen/v1`）的免费模型还有客户端校验：`User-Agent` 必须是 `opencode/<版本>`，且请求要是正常的编码代理请求（带工具）。opencode 自己发出的请求满足这些条件，代理原样透传 `user-agent` 并补齐会话头即可；但若代理链路外层的运行时会改写 `User-Agent`（例如某些边缘平台），或客户端用了禁用 `bash`/`read` 的受限 agent，上游仍会返回 403 `FreeTierError`，这属于上游策略，代理无法绕过
- `/opencode_zen` 的免费模型允许匿名请求：上游免费层不需要 API Key，带上任意占位 key 反而会返回 `Invalid credential`，因此代理对 `-free` 模型（以及 `big-pickle`）不会发送 `Authorization`；付费 Zen 模型仍要求并透传真实 key
- 非 JSON 请求体（如 `multipart/form-data` 文件上传）按字节原样透传；声明为 JSON 但解析失败会返回 400
- 代理默认是开放中继（CORS `*`、无内置限流）。生产环境建议至少设置 `PROXY_ACCESS_TOKEN`（见上），并在 Cloudflare 侧配置 Rate Limiting，避免域名/免费额度被滥用
- 上游连接有超时保护：等响应头默认 300 秒（`UPSTREAM_TIMEOUT_MS`），流式空闲默认 120 秒（`STREAM_IDLE_TIMEOUT_MS`）。响应头阶段超时返回 504，网络不可达返回 502；两者都不会把上游的原始错误细节回显给客户端
- OpenAI 兼容的 Chat Completions SSE 会做一次终止检查：若上游发完内容后始终没有有效的 `finish_reason`（缺失、`null` 或空字符串占位；OpenCode Zen 的 muse 系列模型已知如此），代理会在 `[DONE]` 前补一个终止块（出现过 tool_calls 时为 `tool_calls`，否则为 `stop`），并在缺少 `[DONE]` 时补上；已有终止块的流原样转发。Responses 的 `response.*` SSE 事件不经过这条修复，始终原样透传。上游在流内明确报错（`data: {"error":…}` 或非 JSON 的 data 行）时不会补成功终止块，而是补一个 OpenAI 格式的 error 事件并补上 `[DONE]`；上游只返回空流/仅 `[DONE]` 时同样会补 error 事件，客户端不会再把它误报成 `Stream ended without finish_reason`。客户端请求了 `stream:true` 但上游返回普通 JSON 时，代理会把完整响应包成一条 SSE 终止流（含 `finish_reason` 与 `[DONE]`），返回 HTML、纯文本或空响应时则包成 SSE error 事件 + `[DONE]`，避免流式客户端收到零个事件。
- OpenCode V2 的内置 `opencode` provider 不会应用 `providers.opencode.settings.baseURL` 覆盖（实测 2.0.32），因此它的请求无法经过本代理；如果必须使用内置 provider，可在对应模型上设置 `"compatibility": { "requireFinishReason": false }`，让客户端在缺少 `finish_reason` 时按 `stop` 收尾而不是报错并反复重试（代价：上游真的被截断时不会自动重试）。推荐做法仍是使用自定义 provider（如上面的 `maxapi-zen`）走代理
- 上游 gzip 响应由运行时（Workers / undici）透明解压，因此转发时已剔除 `content-length` / `content-encoding`，避免客户端按错误的长度或编码解析
- Cloudflare Workers 免费计划每天 100,000 请求、每次请求 10ms CPU（等待上游的 I/O 不计入 CPU）、同时等待响应头的连接上限 6；HTTP 触发的 Worker 没有总时长上限，流式响应可持续传输（实测 SSE 逐块转发，不会整体缓冲）。超大上下文（几百 KB JSON）的解析与重新序列化会吃 CPU，接近 10ms 时需付费计划并显式配置 `[limits] cpu_ms`（该配置仅付费计划支持）
- **OpenCode Go** 端点在代理层完成 OpenAI Chat Completions 转发，客户端使用 OpenAI SDK 即可调用 OpenCode Go 的任意模型（DeepSeek V4 Pro、GLM-5、Kimi K2.6 等）

## 故障排查

### 客户端报 `Get "https://<域名>/...": Unauthorized`

这是 **Go 客户端经过 HTTP(S) 代理时 CONNECT 被代理拒绝** 的错误，不是本代理返回的 401。

Go 的 `net/http` 在通过代理建立 HTTPS 隧道时，如果代理对 `CONNECT <域名>:443` 返回非 200，会把响应的 reason phrase 直接作为错误返回；401 就变成 `Unauthorized`。典型日志：

```
provider request failed provider=deepseek endpoint=/models
error="Get \"https://max.gitcafe.ink/deepseek/v1/models\": Unauthorized"
```

本代理不实现 CONNECT，Cloudflare 对 CONNECT 直接返回 `400 Bad Request`；本代理自己的 401 是 JSON（`API key is required...` 或 `Missing or invalid x-proxy-token header.`），不会是这种 transport error。

排查：

```powershell
Get-ChildItem Env: | Where-Object Name -match 'PROXY'
curl.exe --noproxy "*" -i https://max.gitcafe.ink/deepseek/v1/models -H "Authorization: Bearer <key>"
```

如果 `--noproxy "*"` 返回 200，说明是客户端代理的问题。处理方式：

- 设置 `NO_PROXY=max.gitcafe.ink,localhost,127.0.0.1`（Windows 用户/系统环境变量，或 gomodel/OpenCode 的启动环境），重启客户端；
- 或给 `HTTPS_PROXY` 补上代理认证：`http://user:pass@host:port`；
- Docker 运行 gomodel 时，Docker Desktop 会把宿主代理注入容器，需要显式加 `-e NO_PROXY=max.gitcafe.ink`；
- 检查 gomodel provider 的 `proxy_url` 是否指向了一个会返回 401 的代理。

gomodel 的 `circuit breaker is open - provider ... temporarily unavailable` 是上述 transport 失败累积后打开的熔断器；代理修好后重启 gomodel（或等待冷却）即可恢复。

## 相关链接

- [OpenCode Go API 文档](https://opencode.ai/docs/zh-cn/go/)
- [MiniMax 开放平台](https://platform.minimaxi.com)
- [Token Plan 文档](https://platform.minimaxi.com/docs/token-plan/intro)
- [智谱 GLM 开放平台](https://open.bigmodel.cn)
- [月之暗面 Kimi 开放平台](https://platform.moonshot.cn)
- [DeepSeek 开放平台](https://platform.deepseek.com)
- [OpenAI API 文档](https://platform.openai.com/docs)
- [小米 MiMo 开放平台](https://platform.xiaomimimo.com)
- [通义千问百炼平台](https://bailian.console.aliyun.com)
- [OpenCode AI](https://opencode.ai)
- [硅基流动](https://siliconflow.cn)
- [阿里云百炼](https://bailian.console.aliyun.com)
- [火山方舟](https://www.volcengine.com/product/ark)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)

## License

MIT License