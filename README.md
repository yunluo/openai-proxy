# Multi-Provider API Proxy

一个支持 Vercel 和 Cloudflare Workers 的多厂商 AI API 反向代理服务，通过 URL 路径前缀将请求路由到不同的 AI 服务商。

## 项目背景

在企业内网环境中，部分 AI 服务商的接口可能受到限制。本项目通过将 AI API 请求代理到企业内网可访问的 Vercel/Cloudflare Workers 域名，实现曲线访问多个 AI 服务商。

## 功能特点

- 多厂商路由: `/{provider}/v1/*` 路径前缀自动映射到对应厂商
- 内置支持 **MiniMax**、**MiniMax Anthropic**、**GLM (智谱)**、**GLM CP (智谱编程)**、**Kimi (月之暗面)**、**DeepSeek**、**DeepSeek Anthropic**、**OpenAI (GPT)**、**小米 MiMo**、**小米 MiMo CP**、**通义千问**、**OpenCode Go**、**OpenCode Go Anthropic**、**硅基流动**、**阿里云**、**火山方舟**
- 支持通过环境变量自定义任意厂商（自定义 Provider）
- 兼容 OpenAI 格式接口 (`/v1/*`) — 默认路由到 MiniMax
- `Bearer` / `X-API-Key` 认证方式
- API Key 由客户端提供（安全可靠）
- 全球边缘加速（Vercel / Cloudflare Workers）
- **OpenCode Go Anthropic** 自动完成 Anthropic ↔ OpenAI 格式互转

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
| `DEEPSEEK_ANTHROPIC_API_BASE` | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic 兼容端点地址 |
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
├── public/
│   └── index.html    # 配置页面
├── vercel.json       # Vercel 配置（含通用 Provider 路由）
├── wrangler.toml     # Cloudflare Workers 配置
└── package.json      # 项目依赖
```

## 技术栈

- Vercel Serverless Functions / Cloudflare Workers
- Node.js 18+（本地开发 / Vercel 部署需要）
- API Proxy

## 注意事项

- 请妥善保管您的 API Key
- 遵守 [MiniMax API 使用条款](https://platform.minimaxi.com/docs/terms)
- Vercel 免费计划每月提供 100GB 带宽
- Cloudflare Workers 免费计划每天 100,000 请求
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