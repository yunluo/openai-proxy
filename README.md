# MiniMax Token Plan API Proxy

一个支持 Vercel 和 Cloudflare Workers 的 MiniMax Token Plan API 反向代理服务。

## 项目背景

在企业内网环境中，部分 AI 服务商的接口可能受到限制。本项目通过将 MiniMax API 请求代理到企业内网可访问的 Vercel/Cloudflare Workers 域名，实现曲线访问 MiniMax AI 服务。

## 功能特点

- 支持 **MiniMax-M2.7** 最新模型
- 支持 **中国区** (`api.minimaxi.com`)
- OpenAI 兼容接口 (`/v1/*`)
- 支持 Claude Code、Cursor、TRAE 等 AI 编程工具
- API Key 由客户端提供（安全可靠）
- 全球边缘加速

## API 端点

| 平台 | 端点 URL |
|------|----------|
| **Vercel** | `https://maxapi.vercel.app/v1/chat/completions` |
| **Cloudflare Workers** | `https://maxapi.yunluo.workers.dev/v1/chat/completions` |

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

如需自定义 API 基础地址，可配置以下环境变量：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MINIMAX_API_BASE` | `https://api.minimaxi.com` | API 调用地址 |
| `MINIMAX_API_BASE_WWW` | `https://www.minimaxi.com` | 额度查询地址 |

## 使用方法

### 1. 获取 Token Plan API Key

1. 访问 [Token Plan 订阅页面](https://platform.minimaxi.com/subscribe/token-plan)
2. 订阅成功后，前往 [接口密钥页面](https://platform.minimaxi.com/user-center/basic-information/interface-key) 获取 API Key

**重要提示：**
- 此 API Key 为 Token Plan 专属，和按量计费 API Key 不可互换
- 此 API Key 仅在 Token Plan 订阅有效期内有效

### 2. 配置 AI 编程工具

#### Claude Code

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://maxapi.vercel.app",
    "ANTHROPIC_AUTH_TOKEN": "your-token-plan-api-key",
    "ANTHROPIC_MODEL": "MiniMax-M2.7",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2.7",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M2.7",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2.7",
    "API_TIMEOUT_MS": "300000"
  }
}
```

#### Cursor

1. Settings → Models
2. Override Anthropic Base URL: `https://maxapi.vercel.app`
3. 输入 API Key
4. 选择模型: `MiniMax-M2.7`

#### Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://maxapi.vercel.app",
    api_key="your-token-plan-api-key"
)

message = client.messages.create(
    model="MiniMax-M2.7",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)
print(message.content)
```

## 项目结构

```
minimax-proxy/
├── vercel/
│   └── index.js      # Vercel Serverless Function 适配器
├── workers/
│   └── index.js      # Cloudflare Workers 适配器
├── src/
│   ├── core.js       # 共享核心代理逻辑
│   └── config.js     # API 配置（支持环境变量）
├── public/
│   └── index.html    # 配置页面
├── vercel.json       # Vercel 配置
├── wrangler.toml     # Cloudflare Workers 配置
└── package.json      # 项目依赖
```

## 技术栈

- Vercel Serverless Functions / Cloudflare Workers
- Node.js
- API Proxy

## 注意事项

- 请妥善保管您的 API Key
- 遵守 [MiniMax API 使用条款](https://platform.minimaxi.com/docs/terms)
- Vercel 免费计划每月提供 100GB 带宽
- Cloudflare Workers 免费计划每天 100,000 请求

## 相关链接

- [MiniMax 开放平台](https://platform.minimaxi.com)
- [Token Plan 文档](https://platform.minimaxi.com/docs/token-plan/intro)
- [Vercel 文档](https://vercel.com/docs)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)

## License

MIT License
