---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3046022100bbc057b67cc15ac7ad42b61a1743b683952237e89a1514b7f637d2d5070b2aae022100e8e7a7d315ea682b712be2eafa0d237eeaede5d5e0da9aa8dd41a11c77b7cbc1
    ReservedCode2: 3044022033a3c334477781d8d3d26b85412751b6e942479371fe32d17393b7a91a0e681002206dd9faea0ca12f7ad6e4f34a8e78c41e1b85530e58b48ca72e3d30a912ed450d
---

# MiniMax Token Plan API Proxy

一个基于 Vercel 的 MiniMax Token Plan API 反向代理服务，支持中国区和国际区 API。

## 功能特点

- 支持 **MiniMax-M2.7** 最新模型
- 支持 **中国区** (`api.minimaxi.com`) 和 **国际区** (`api.minimax.io`)
- OpenAI 兼容接口 (`/v1/*`)
- Anthropic 兼容接口 (`/anthropic/*`)
- 支持 Claude Code、Cursor、TRAE 等 AI 编程工具
- API Key 安全存储（Vercel 环境变量）
- 全球边缘加速

## API 端点

部署后可用以下端点：

| 接口类型 | 端点 URL |
|----------|----------|
| **OpenAI 兼容** | `https://your-domain.vercel.app/v1/chat/completions` |
| **Anthropic 兼容** | `https://your-domain.vercel.app/anthropic/v1/messages` |

## 快速部署

### 方法一：Vercel CLI

```bash
# 1. 安装 Vercel CLI
npm i -g vercel

# 2. 登录
vercel login

# 3. 部署
cd minimax-proxy
vercel --prod
```

### 方法二：GitHub 导入

1. 将代码推送到 GitHub 仓库
2. 访问 [vercel.com/new](https://vercel.com/new)
3. 导入您的 GitHub 仓库
4. 点击 Deploy

## 配置步骤

### 1. 获取 Token Plan API Key

1. 访问 [Token Plan 订阅页面](https://platform.minimaxi.com/subscribe/token-plan)
2. 订阅成功后，前往 [接口密钥页面](https://platform.minimaxi.com/user-center/basic-information/interface-key) 获取 API Key

**重要提示：**
- 此 API Key 为 Token Plan 专属，和按量计费 API Key 不可互换
- 此 API Key 仅在 Token Plan 订阅有效期内有效

### 2. 配置环境变量

在 Vercel 项目设置中添加：

| 变量名 | 值 |
|--------|-----|
| `MINIMAX_API_KEY` | 您的 Token Plan API Key |

### 3. 配置 AI 编程工具

#### Claude Code

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-domain.vercel.app/anthropic",
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
2. Override Anthropic Base URL: `https://your-domain.vercel.app/anthropic`
3. 输入 API Key
4. 选择模型: `MiniMax-M2.7`

#### Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://your-domain.vercel.app/anthropic",
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
├── api/
│   ├── proxy.js      # 核心代理逻辑
│   ├── v1.js         # OpenAI 兼容端点
│   └── anthropic.js  # Anthropic 兼容端点
├── public/
│   └── index.html    # 配置页面
├── vercel.json       # Vercel 配置
└── package.json      # 项目依赖
```

## 技术栈

- Vercel Serverless Functions
- Node.js
- API Proxy

## 注意事项

- 请妥善保管您的 API Key
- 遵守 [MiniMax API 使用条款](https://platform.minimaxi.com/docs/terms)
- Vercel 免费计划每月提供 100GB 带宽

## 相关链接

- [MiniMax 开放平台](https://platform.minimaxi.com)
- [Token Plan 文档](https://platform.minimaxi.com/docs/token-plan/intro)
- [Vercel 文档](https://vercel.com/docs)

## License

MIT License
