---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3046022100b0c3bbab4fff2f7f301fed6c9c7187a9cd4e911406ea415b7e5bc3792a590486022100e923a2360b4b061e8721888a8426e9b25d106852433f13f4e70df378f68f6b2b
    ReservedCode2: 304402206dafc5e194a086c76e04a0b6b577a361e059ff356c36122dea8be413e87a3782022052a8f47b0ea27afe0005e0413eba9bf5f2257f470392e3708149e2ad36338654
---

# MiniMax Coding Plan API Proxy

一个基于 Vercel 的 MiniMax Coding Plan API 反向代理服务。

## 功能特点

- 🚀 支持 OpenAI 兼容接口
- 🤖 支持 Anthropic 兼容接口
- 🔒 API Key 安全存储
- 🌍 全球边缘加速

## 快速部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/minimax-proxy)

## API 端点

### OpenAI 兼容接口
```
https://your-domain.vercel.app/v1/chat/completions
```

### Anthropic 兼容接口
```
https://your-domain.vercel.app/anthropic/v1/messages
```

## 配置说明

### 1. 获取 MiniMax API Key

访问 [MiniMax Developer Platform](https://platform.minimax.io/user-center/basic-information/interface-key) 获取您的 API Key。

### 2. 配置环境变量

在 Vercel 项目设置中添加环境变量：
- `MINIMAX_API_KEY`: 您的 MiniMax API Key

### 3. 使用示例

#### OpenAI SDK
```python
from openai import OpenAI

client = OpenAI(
    api_key="your-minimax-api-key",
    base_url="https://your-domain.vercel.app/v1"
)

response = client.chat.completions.create(
    model="MiniMax-M2.5",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

#### Claude Code 配置
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-domain.vercel.app/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-minimax-api-key"
  }
}
```

## 本地开发

```bash
npm install
npm run dev
```

## 技术栈

- Vercel Serverless Functions
- Node.js
- API Proxy

## 注意事项

- 请妥善保管您的 API Key
- 遵守 MiniMax API 使用条款
- 监控您的 API 使用量

## License

MIT License
