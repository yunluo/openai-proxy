# Cloudflare Workers 支持设计方案

## 概述

为 MiniMax Token Plan API 代理服务增加 Cloudflare Workers 部署支持，同时保留现有的 Vercel 部署。

## 目标

- 支持同时部署到 Vercel 和 Cloudflare Workers
- 共享核心代理逻辑，减少重复代码
- 两个平台可独立工作、互不干扰

## 项目结构

```
├── api/
│   └── proxy.js          # Vercel Serverless Function 适配器
├── workers/
│   └── index.js          # Cloudflare Workers 适配器
├── src/
│   └── core.js            # 共享核心代理逻辑
├── package.json          # Node 依赖
├── vercel.json           # Vercel 配置
├── wrangler.toml         # Cloudflare Workers 配置
└── README.md
```

## 组件设计

### 1. 核心代理逻辑 (`src/core.js`)

环境无关的核心代理功能：

```javascript
export async function handleProxyRequest(request, options) {
  // options: { apiBase, apiBaseWww }
}
```

职责：
- 解析请求路径和 API Key
- 判断请求类型（OpenAI / Anthropic / Token Plan）
- 转发请求到 MiniMax API
- 处理流式响应
- 返回标准化响应

### 2. Vercel 适配器 (`api/proxy.js`)

调用核心逻辑，适配 Vercel Serverless Function 格式：

```javascript
import { handleProxyRequest } from '../src/core.js';

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default function handler(req, res) {
  return handleProxyRequest(req, {
    apiBase: API_BASE,
    apiBaseWww: API_BASE_WWW
  });
}
```

### 3. Cloudflare Workers 适配器 (`workers/index.js`)

调用核心逻辑，适配 Cloudflare Workers Fetch 格式：

```javascript
import { handleProxyRequest } from '../src/core.js';

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default {
  async fetch(request, env, ctx) {
    return handleProxyRequest(request, {
      apiBase: API_BASE,
      apiBaseWww: API_BASE_WWW
    });
  }
};
```

## 部署配置

### Vercel (`vercel.json`)

保持现有配置不变。

### Cloudflare Workers (`wrangler.toml`)

```toml
name = "minimax-proxy"
main = "workers/index.js"
compatibility_date = "2024-01-01"

[vars]
# 环境变量通过 Cloudflare Dashboard 配置
```

## 环境变量

| 变量名 | 描述 | 平台 |
|--------|------|------|
| `MINIMAX_API_KEY` | Token Plan API Key | Vercel / Cloudflare |

## 限制考虑

### Cloudflare 免费计划限制
- 100,000 请求/天
- CPU 时间：10ms（预请求可延长）
- 无持久 KV 存储

## 部署步骤

### Vercel 部署
```bash
vercel --prod
```

### Cloudflare Workers 部署
```bash
npm run deploy:cf
# 或
wrangler deploy
```

## 测试验证

部署后验证：
1. OpenAI 兼容端点：`/{domain}/v1/chat/completions`
2. Anthropic 兼容端点：`/{domain}/anthropic/v1/messages`

---

创建时间：2026-04-19
