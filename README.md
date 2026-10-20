# Multi-Provider API Proxy

一个支持 Vercel 和 Cloudflare Workers 的多厂商 AI API 反向代理服务，通过 URL 路径前缀将请求路由到不同的 AI 服务商。

## 项目背景

在企业内网环境中，部分 AI 服务商的接口可能受到限制。本项目通过将 AI API 请求代理到企业内网可访问的 Vercel/Cloudflare Workers 域名，实现曲线访问多个 AI 服务商。

## 功能特点

- 多厂商路由: `/{provider}/v1/*` 路径前缀自动映射到对应厂商
- 内置支持 **MiniMax**、**MiniMax Anthropic**、**GLM (智谱)**、**GLM CP (智谱编程)**、**Kimi (月之暗面)**、**DeepSeek**、**DeepSeek Anthropic**、**OpenAI (GPT)**、**小米 MiMo**、**小米 MiMo CP**、**通义千问**、**OpenCode Go**、**OpenCode Go Anthropic**、**硅基流动**、**阿里云**、**火山方舟**、**OpenRouter**、**Kilo**、**OpenCode Zen**
- 支持通过环境变量自定义任意厂商（自定义 Provider）
- 兼容 OpenAI 格式接口 (`/v1/*`) — 默认路由到 MiniMax
- `Bearer` / `X-API-Key` 认证方式
- API Key 由客户端提供（安全可靠）
- 全球边缘加速（Vercel / Cloudflare Workers）
- **OpenCode Go Anthropic** 自动完成 Anthropic ↔ OpenAI 格式互转
- OpenAI Chat Completions 流式响应自动补齐上游缺失的 `finish_reason` 终止块与 `data: [DONE]`
- `GET /v1/models` 返回代理内置的厂商列表

## API 端点

| 厂商 | 路径前缀 | 目标 API |
|------|----------|----------|
| MiniMax | `/minimax/v1/` 或 `/v1/` (默认) | `https://api.minimaxi.com/v1` |
| MiniMax Anthropic | `/minimax_anthropic/v1/` | `https://api.minimaxi.com/anthropic/v1` |
| 智谱 GLM | `/glm/v1/` | `https://open.bigmodel.cn/api/paas/v4` |
| 智谱 GLM CP (编程) | `/glm_cp/v1/` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| Kimi 月之暗面 | `/kim/v1/` | `https://api.moonshot.cn/v1` |
| DeepSeek | `/deepseek/v1/` | `https://api.deepseek.com/v1` |
| DeepSeek Anthropic | `/deepseek_anthropic/v1/` | `https://api.deepseek.com/anthropic` |
| OpenAI GPT | `/gpt/v1/` | `https://api.openai.com/v1` |
| 小米 MiMo | `/xiaomi/v1/` | `https://api.xiaomimimo.com/v1` |
| 小米 MiMo CP | `/xiaomi_cp/v1/` | `https://token-plan-cn.xiaomimimo.com/v1` |
| 通义千问 | `/qwen/v1/` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenCode Go | `/opencode/v1/` | `https://opencode.ai/zen/go/v1` |
| OpenCode Go Anthropic | `/opencode_anthropic/v1/` | `https://opencode.ai/zen/go/v1`（自动格式互转） |
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
| **Vercel** | `https://maxapi.vercel.app` |
| **Cloudflare Workers** | `https://maxapi.yunluo.workers.dev` |

## 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/import)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?to=:github)

## 手动部署

### Vercel (GitHub 导入)

1. 访问 [vercel.com/new](https://vercel.com/new)
2. 导入您的 GitHub 仓库
3. 点击 Deploy

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
| `MINIMAX_API_BASE` | `https://api.minimaxi.com/v1` | MiniMax API 地址 |
| `MINIMAX_ANTHROPIC_API_BASE` | `https://api.minimaxi.com/anthropic/v1` | MiniMax Anthropic 兼容端点地址 |
| `MINIMAX_API_BASE_WWW` | `https://www.minimaxi.com` | MiniMax 额度查询地址 |
| `GLM_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | 智谱 API 地址 |
| `GLM_CP_API_BASE` | `https://open.bigmodel.cn/api/coding/paas/v4` | 智谱编程 API 地址 |
| `KIMI_API_BASE` | `https://api.moonshot.cn/v1` | Kimi API 地址 |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com/v1` | DeepSeek API 地址 |
| `DEEPSEEK_ANTHROPIC_API_BASE` | `https://api.deepseek.com/anthropic/v1` | DeepSeek Anthropic 兼容端点地址 |
| `GPT_API_BASE` | `https://api.openai.com/v1` | OpenAI API 地址 |
| `XIAOMI_API_BASE` | `https://api.xiaomimimo.com/v1` | 小米 MiMo API 地址 |
| `XIAOMI_CP_API_BASE` | `https://token-plan-cn.xiaomimimo.com/v1` | 小米 MiMo CP API 地址 |
| `QWEN_API_BASE` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 通义千问 API 地址 |
| `OPENCODE_API_BASE` | `https://opencode.ai/zen/go/v1` | OpenCode Go API 地址 |
| `OPENCODE_ANTHROPIC_API_BASE` | `https://opencode.ai/zen/go/v1` | OpenCode Go Anthropic 兼容端点地址 |
| `SILICONFLOW_API_BASE` | `https://api.siliconflow.cn/v1` | 硅基流动 API 地址 |
| `ALIYUN_API_BASE` | `https://coding.dashscope.aliyuncs.com/v1` | 阿里云 API 地址 |
| `VOLCENGINE_API_BASE` | `https://ark.cn-beijing.volces.com/api/coding/v3` | 火山方舟 API 地址 |
| `OPENROUTER_API_BASE` | `https://openrouter.ai/api/v1` | OpenRouter API 地址 |
| `KILO_API_BASE` | `https://api.kilo.ai/api/gateway` | Kilo API 地址 |
| `OPENCODE_ZEN_API_BASE` | `https://opencode.ai/zen/v1` | OpenCode Zen API 地址 |

### 代理自身配置（可选）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PROXY_ACCESS_TOKEN` | 未设置（不校验） | 设置后所有请求必须带 `x-proxy-token: <口令>`，否则返回 401。用于避免域名被他人当中继滥用 |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 等上游响应头的超时（毫秒）。非流式请求要等上游生成完才有响应头，所以默认给得宽；超时返回 504 `upstream_timeout` |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | 读上游 body 的空闲超时（毫秒）：超过这么久没有任何新数据即判定上游卡死，中断并报错；`0` 表示不限制 |

Claude Code 可通过 `ANTHROPIC_CUSTOM_HEADERS="x-proxy-token: <口令>"` 附带访问口令；OpenAI 兼容客户端一般在自定义 header 里加一项即可。

### 自定义 Provider

支持通过编号环境变量添加任意数量的自定义厂商：

| 变量名 | 说明 |
|--------|------|
| `CUSTOM_PROVIDER_1_NAME` | 自定义厂商名称（用作 URL 路径前缀） |
| `CUSTOM_PROVIDER_1_API_BASE` | 自定义厂商 API 地址 |
| `CUSTOM_PROVIDER_2_NAME` | 第二个自定义厂商名称 |
| `CUSTOM_PROVIDER_2_API_BASE` | 第二个自定义厂商 API 地址 |
| ... | 以此类推 |

例如配置 `CUSTOM_PROVIDER_1_NAME=mole` + `CUSTOM_PROVIDER_1_API_BASE=https://api.mole.ai` 后，即可通过 `/mole/v1/chat/completions` 访问。

### 认证方式

- **OpenAI 兼容端点**（MiniMax、GLM、DeepSeek、OpenCode Go 等）：通过 `Authorization: Bearer <your-api-key>` 传递 API Key
- **Anthropic 原生端点**（MiniMax Anthropic、DeepSeek Anthropic）：通过 `X-API-Key: <your-api-key>` 传递 API Key，代理透传 `x-api-key` 头及 `anthropic-version` 等 Anthropic 专用头
- **OpenCode Go Anthropic**（格式互转）：客户端通过 `X-API-Key: <your-api-key>` 认证，代理自动将 Anthropic Messages 格式转换为 OpenAI Chat Completions 格式后以 `Bearer` 方式转发至 OpenCode Go，响应再转换回 Anthropic 格式返回

## 使用示例

所有请求地址格式均为 `https://<部署域名>/<provider>/v1/<path>`:

```bash
# MiniMax (默认，兼容旧版)
curl --request POST 'https://maxapi.vercel.app/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"Hello"}]}'

# MiniMax Anthropic 兼容端点（使用 x-api-key 认证）
curl --request POST 'https://maxapi.vercel.app/minimax_anthropic/v1/messages' \
  --header 'content-type: application/json' \
  --header 'x-api-key: xxxxxxxxxx' \
  --header 'anthropic-version: 2023-06-01' \
  --data '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

# 智谱 GLM
curl --request POST 'https://maxapi.vercel.app/glm/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-4","messages":[{"role":"user","content":"Hello"}]}'

# Kimi 月之暗面
curl --request POST 'https://maxapi.vercel.app/kim/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"moonshot-v1-8k","messages":[{"role":"user","content":"Hello"}]}'

# DeepSeek
curl --request POST 'https://maxapi.vercel.app/deepseek/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'

# DeepSeek Anthropic 兼容端点（使用 x-api-key 认证）
curl --request POST 'https://maxapi.vercel.app/deepseek_anthropic/v1/messages' \
  --header 'content-type: application/json' \
  --header 'x-api-key: xxxxxxxxxx' \
  --header 'anthropic-version: 2023-06-01' \
  --data '{"model":"deepseek-v4-pro","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

# OpenAI GPT
curl --request POST 'https://maxapi.vercel.app/gpt/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'

# 小米 MiMo
curl --request POST 'https://maxapi.vercel.app/xiaomi/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiMo-8B","messages":[{"role":"user","content":"Hello"}]}'

# 通义千问
curl --request POST 'https://maxapi.vercel.app/qwen/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"qwen-turbo","messages":[{"role":"user","content":"Hello"}]}'

# OpenCode Go
curl --request POST 'https://maxapi.vercel.app/opencode/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-4-plus","messages":[{"role":"user","content":"Hello"}]}'

# OpenCode Go Anthropic（自动格式互转，可用任意 OpenCode Go 支持的模型）
curl --request POST 'https://maxapi.vercel.app/opencode_anthropic/v1/messages' \
  --header 'content-type: application/json' \
  --header 'x-api-key: xxxxxxxxxx' \
  --header 'anthropic-version: 2023-06-01' \
  --data '{"model":"deepseek-v4-pro","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

# 硅基流动
curl --request POST 'https://maxapi.vercel.app/siliconflow/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"Hello"}]}'

# 阿里云
curl --request POST 'https://maxapi.vercel.app/aliyun/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"qwen-turbo","messages":[{"role":"user","content":"Hello"}]}'

# 火山方舟
curl --request POST 'https://maxapi.vercel.app/volcengine/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"doubao-1.5-pro-32k","messages":[{"role":"user","content":"Hello"}]}'

# 智谱 GLM CP (编程)
curl --request POST 'https://maxapi.vercel.app/glm_cp/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"glm-4","messages":[{"role":"user","content":"Hello"}]}'

# 小米 MiMo CP
curl --request POST 'https://maxapi.vercel.app/xiaomi_cp/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"MiMo-8B","messages":[{"role":"user","content":"Hello"}]}'

# 自定义 Provider（需配置 CUSTOM_PROVIDER_1_NAME=mole + CUSTOM_PROVIDER_1_API_BASE）
curl --request POST 'https://maxapi.vercel.app/mole/v1/chat/completions' \
  --header 'content-type: application/json' \
  --header 'authorization: Bearer xxxxxxxxxx' \
  --data '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

### Python SDK (OpenAI 兼容)

```python
from openai import OpenAI

# GPT
client = OpenAI(
    base_url="https://maxapi.vercel.app/gpt/v1",
    api_key="your-gpt-key"
)
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 小米 MiMo
client = OpenAI(
    base_url="https://maxapi.vercel.app/xiaomi/v1",
    api_key="your-xiaomi-key"
)
response = client.chat.completions.create(
    model="MiMo-8B",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 通义千问
client = OpenAI(
    base_url="https://maxapi.vercel.app/qwen/v1",
    api_key="your-qianwen-key"
)
response = client.chat.completions.create(
    model="qwen-turbo",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# OpenCode Go
client = OpenAI(
    base_url="https://maxapi.vercel.app/opencode/v1",
    api_key="your-opencode-key"
)
response = client.chat.completions.create(
    model="glm-4-plus",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 硅基流动
client = OpenAI(
    base_url="https://maxapi.vercel.app/siliconflow/v1",
    api_key="your-siliconflow-key"
)
response = client.chat.completions.create(
    model="Qwen/Qwen2.5-7B-Instruct",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 阿里云
client = OpenAI(
    base_url="https://maxapi.vercel.app/aliyun/v1",
    api_key="your-aliyun-key"
)
response = client.chat.completions.create(
    model="qwen-turbo",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 火山方舟
client = OpenAI(
    base_url="https://maxapi.vercel.app/volcengine/v1",
    api_key="your-volcengine-key"
)
response = client.chat.completions.create(
    model="doubao-1.5-pro-32k",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# MiniMax Anthropic 兼容端点（使用 Anthropic Python SDK）
from anthropic import Anthropic
client = Anthropic(
    base_url="https://maxapi.vercel.app/minimax_anthropic/v1",
    api_key="your-minimax-key"
)
message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)

# DeepSeek Anthropic 兼容端点（使用 Anthropic Python SDK）
from anthropic import Anthropic
client = Anthropic(
    base_url="https://maxapi.vercel.app/deepseek_anthropic/v1",
    api_key="your-deepseek-key"
)
message = client.messages.create(
    model="deepseek-v4-pro",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)

# OpenCode Go Anthropic（自动格式互转，可用任意 OpenCode Go 支持的模型）
from anthropic import Anthropic
client = Anthropic(
    base_url="https://maxapi.vercel.app/opencode_anthropic/v1",
    api_key="your-opencode-go-key"
)
message = client.messages.create(
    model="deepseek-v4-pro",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)

# 智谱 GLM CP (编程)
client = OpenAI(
    base_url="https://maxapi.vercel.app/glm_cp/v1",
    api_key="your-glm-key"
)
response = client.chat.completions.create(
    model="glm-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 小米 MiMo CP
client = OpenAI(
    base_url="https://maxapi.vercel.app/xiaomi_cp/v1",
    api_key="your-xiaomi-key"
)
response = client.chat.completions.create(
    model="MiMo-8B",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# 自定义 Provider（需配置 CUSTOM_PROVIDER_1_NAME=mole + CUSTOM_PROVIDER_1_API_BASE）
client = OpenAI(
    base_url="https://maxapi.vercel.app/mole/v1",
    api_key="your-mole-key"
)
response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "hi"}]
)
print(response.choices[0].message.content)
```

### Token Plan 额度查询

```bash
curl https://maxapi.vercel.app/token_plan/billing/query \
  -H "Authorization: Bearer $YOUR_TOKEN_PLAN_KEY"
```

## 项目结构

```
openai-proxy/
├── vercel/
│   └── index.js      # Vercel Serverless Function 适配器
├── workers/
│   └── index.js      # Cloudflare Workers 适配器
├── src/
│   ├── core.js       # 共享核心代理逻辑（多厂商路由 + Anthropic↔OpenAI 格式互转）
│   └── config.js     # API 配置（内置厂商 + 环境变量）
├── test/
│   └── core.test.js  # 路由 / 格式互转 / 流式转换测试
├── vercel.json       # Vercel 配置（含通用 Provider 路由）
├── wrangler.toml     # Cloudflare Workers 配置
└── package.json      # 项目依赖
```

## 开发与测试

```bash
# 运行测试（Node 18+ 内置测试运行器，或使用 bun）
npm test
bun test

# 本地开发
npm run dev      # Vercel（npx vercel dev）
npm run dev:cf   # Cloudflare Workers（wrangler dev）
```

测试覆盖：缺失/空 API Key、provider 路由与查询串、`/token_plan` 前缀保留、未知 provider 与 `__proto__`、
multipart 原样透传、非法 JSON 返回 400、上游错误码/响应头保留、Anthropic ↔ OpenAI 双向转换
（tool_result 顺序、`tool_choice: none`、图片 url、system/stop 映射）、流式事件序列与中途出错处理、
OpenAI SSE 缺失 `finish_reason` / `[DONE]` 时的终止块补齐。

## 技术栈

- Vercel Serverless Functions / Cloudflare Workers
- Node.js 18+（本地开发 / Vercel 部署需要）
- API Proxy

## 注意事项

- 请妥善保管您的 API Key
- 严格遵守各厂商的 API 使用条款（含 Anthropic、OpenAI 等）
- 代理会按白名单透传少量头（`x-opencode-session`、`x-opencode-session-id`、`x-opencode-parent-session-id`、`x-opencode-client`、`x-opencode-project`、`x-opencode-request`、`x-session-id`、`x-session-affinity`、`x-parent-session-id`、`user-agent`、`HTTP-Referer`、`X-Title`），不会转发 `host`/`cookie` 等敏感头
- `/opencode`、`/opencode_anthropic`（Go 网关 `zen/go/v1`）与 `/opencode_zen`（`zen/v1`）都要求会话头：Go 缺失时返回 400 `MissingSessionID`，Zen 免费模型还会校验 `x-opencode-session` 的格式（`ses_` + 12 位十六进制 + 14 位 base62）。客户端自带的会话值格式合法就沿用，否则（包括 opencode 接自定义 provider 时只发 `x-session-id`、或旧版派生出的 `ses_<8位十六进制>`）由代理重新补一个合法值：按 `apiKey + model + 首条用户消息` 派生，同一对话的每一轮都得到同一个 id（保留上游路由与提示缓存亲和）
- `/opencode_zen`（`zen/v1`）的免费模型还有客户端校验：`User-Agent` 必须是 `opencode/<版本>`，且请求要是正常的编码代理请求（带工具）。opencode 自己发出的请求满足这些条件，代理原样透传 `user-agent` 并补齐会话头即可；但若代理链路外层的运行时会改写 `User-Agent`（例如某些边缘平台），或客户端用了禁用 `bash`/`read` 的受限 agent，上游仍会返回 403 `FreeTierError`，这属于上游策略，代理无法绕过
- 非 JSON 请求体（如 `multipart/form-data` 文件上传）按字节原样透传；声明为 JSON 但解析失败会返回 400
- 代理默认是开放中继（CORS `*`、无内置限流）。生产环境建议至少设置 `PROXY_ACCESS_TOKEN`（见上），并在 Cloudflare 侧配置 Rate Limiting，避免域名/免费额度被滥用
- 上游连接有超时保护：等响应头默认 300 秒（`UPSTREAM_TIMEOUT_MS`），流式空闲默认 120 秒（`STREAM_IDLE_TIMEOUT_MS`）。响应头阶段超时返回 504，网络不可达返回 502；两者都不会把上游的原始错误细节回显给客户端
- OpenAI 兼容的 Chat Completions SSE 会做一次终止检查：若上游发完内容后始终没有 `finish_reason`（OpenCode Zen 的 muse 系列模型已知如此），代理会在 `[DONE]` 前补一个终止块（出现过 tool_calls 时为 `tool_calls`，否则为 `stop`），并在缺少 `[DONE]` 时补上；已有终止块的流原样转发，Anthropic 原生 SSE 不受影响。这样 opencode、Pi、Hermes 等严格校验结束标记的客户端不会再报 `Stream ended without finish_reason` 并重复重试
- 上游 gzip 响应由运行时（Workers / undici）透明解压，因此转发时已剔除 `content-length` / `content-encoding`，避免客户端按错误的长度或编码解析
- Vercel 免费计划每月提供 100GB 带宽（`vercel.json` 中已配置 `maxDuration: 60`，长流式对话请留意套餐上限）
- Cloudflare Workers 免费计划每天 100,000 请求、每次请求 10ms CPU（等待上游的 I/O 不计入 CPU）、同时等待响应头的连接上限 6；HTTP 触发的 Worker 没有总时长上限，流式响应可持续传输（实测 SSE 逐块转发，不会整体缓冲）。超大上下文（几百 KB JSON）的解析与重新序列化会吃 CPU，接近 10ms 时需付费计划并显式配置 `[limits] cpu_ms`（该配置仅付费计划支持）
- **OpenCode Go Anthropic** 端点在代理层完成 Anthropic ↔ OpenAI 格式互转，客户端使用 Anthropic SDK 即可调用 OpenCode Go 的任意模型（DeepSeek V4 Pro、GLM-5、Kimi K2.6 等）

## 相关链接

- [Anthropic API 文档](https://docs.anthropic.com)
- [DeepSeek Anthropic API 文档](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)
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
- [Vercel 文档](https://vercel.com/docs)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)

## License

MIT License