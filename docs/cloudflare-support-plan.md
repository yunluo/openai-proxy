# Cloudflare Workers 支持实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MiniMax Token Plan API 代理服务增加 Cloudflare Workers 部署支持，同时保留 Vercel 部署

**Architecture:** 采用适配器模式，将核心代理逻辑抽取到 `src/core.js`，Vercel 和 Cloudflare Workers 作为两个适配器调用同一核心

**Tech Stack:** Node.js, Cloudflare Workers, Vercel Serverless Functions

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 创建 | `src/core.js` | 共享核心代理逻辑，环境无关 |
| 修改 | `api/proxy.js` | 适配 Vercel Serverless Function |
| 创建 | `workers/index.js` | 适配 Cloudflare Workers Fetch |
| 创建 | `wrangler.toml` | Cloudflare Workers 配置 |
| 修改 | `package.json` | 添加 Cloudflare 部署脚本 |
| 修改 | `README.md` | 添加 Cloudflare 部署说明 |

---

## Task 1: 创建核心代理逻辑

**Files:**
- Create: `src/core.js`
- Test: 手动测试（流式响应难以单元测试）

- [ ] **Step 1: 创建 src 目录并编写核心代理逻辑**

```javascript
/**
 * MiniMax Token Plan API Proxy - Core Logic
 * 环境无关的核心代理功能
 */

const DEFAULT_API_BASE = 'https://api.minimaxi.com';
const DEFAULT_API_BASE_WWW = 'https://www.minimaxi.com';

export async function handleProxyRequest(request, options = {}) {
  const apiBase = options.apiBase || DEFAULT_API_BASE;
  const apiBaseWww = options.apiBaseWww || DEFAULT_API_BASE_WWW;

  const headers = {
    'Content-Type': 'application/json',
  };

  let targetUrl = '';
  const originalPath = new URL(request.url).pathname.split('?')[0] || '/v1/chat/completions';
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '') ||
                 request.headers.get('x-api-key') ||
                 options.apiKey;

  if (!apiKey) {
    return new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'API key is required. Please provide via Authorization header or X-API-Key header.'
      }
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  headers['Authorization'] = `Bearer ${apiKey}`;

  if (originalPath.includes('/token_plan') || originalPath.includes('/coding_plan')) {
    const targetPath = originalPath.replace(/^\/token_plan/, '').replace(/^\/coding_plan/, '');
    targetUrl = `${apiBaseWww}${targetPath}`;
  } else if (originalPath.includes('/anthropic')) {
    targetUrl = `${apiBase}${originalPath}`;
    const anthropicVersion = request.headers.get('anthropic-version');
    if (anthropicVersion) headers['anthropic-version'] = anthropicVersion;
  } else if (originalPath.startsWith('/v1')) {
    targetUrl = `${apiBase}${originalPath}`;
  } else {
    targetUrl = `${apiBase}/anthropic/v1/messages`;
  }

  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    const requestBody = await request.json().catch(() => ({}));
    body = JSON.stringify(requestBody);
  }

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: headers,
    body: body,
  });

  const contentType = response.headers.get('content-type');
  const isStreaming = (await request.json().catch(() => ({}))).stream !== false;

  if (isStreaming && contentType?.includes('text/event-stream')) {
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  }

  if (contentType && contentType.includes('application/json')) {
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: { 'Content-Type': contentType || 'text/plain' }
  });
}
```

- [ ] **Step 2: 提交**

```bash
git add src/core.js
git commit -m "feat: add shared core proxy logic"
```

---

## Task 2: 修改 Vercel 适配器

**Files:**
- Modify: `api/proxy.js:1-117`
- Test: `vercel dev` 本地测试

- [ ] **Step 1: 重写 api/proxy.js 使用核心逻辑**

```javascript
/**
 * MiniMax Token Plan API Proxy
 * Vercel Serverless Function 适配器
 */

import { handleProxyRequest } from '../src/core.js';

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const options = {
    apiBase: API_BASE,
    apiBaseWww: API_BASE_WWW,
    apiKey: process.env.MINIMAX_API_KEY
  };

  try {
    const response = await handleProxyRequest(req, options);
    const data = await response.text();
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    return res.status(response.status).send(data);
  } catch (error) {
    console.error('MiniMax Proxy Error:', error);
    return res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message || 'An error occurred while processing your request.'
      }
    });
  }
}
```

- [ ] **Step 2: 本地测试（如果环境支持）**

```bash
npm run dev
```

- [ ] **Step 3: 提交**

```bash
git add api/proxy.js
git commit -m "refactor: adapt Vercel adapter to use core.js"
```

---

## Task 3: 创建 Cloudflare Workers 适配器

**Files:**
- Create: `workers/index.js`
- Create: `wrangler.toml`
- Test: `wrangler dev` 本地测试

- [ ] **Step 1: 创建 workers 目录和 Cloudflare Workers 适配器**

```javascript
/**
 * MiniMax Token Plan API Proxy
 * Cloudflare Workers 适配器
 */

import { handleProxyRequest } from '../src/core.js';

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
        }
      });
    }

    const options = {
      apiBase: API_BASE,
      apiBaseWww: API_BASE_WWW,
      apiKey: env.MINIMAX_API_KEY
    };

    try {
      return await handleProxyRequest(request, options);
    } catch (error) {
      console.error('MiniMax Proxy Error:', error);
      return new Response(JSON.stringify({
        error: {
          type: 'internal_error',
          message: error.message || 'An error occurred while processing your request.'
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
```

- [ ] **Step 2: 创建 wrangler.toml 配置文件**

```toml
name = "minimax-proxy"
main = "workers/index.js"
compatibility_date = "2024-01-01"

[vars]
# MINIMAX_API_KEY 通过 Cloudflare Dashboard 配置
```

- [ ] **Step 3: 本地测试**

```bash
npx wrangler dev
```

- [ ] **Step 4: 提交**

```bash
git add workers/index.js wrangler.toml
git commit -m "feat: add Cloudflare Workers adapter"
```

---

## Task 4: 更新 package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 添加 Cloudflare 部署脚本**

```json
{
  "name": "minimax-coding-plan-proxy",
  "version": "1.0.0",
  "description": "Proxy for MiniMax Coding Plan API - supports Vercel and Cloudflare Workers",
  "private": true,
  "scripts": {
    "dev": "vercel dev",
    "dev:cf": "wrangler dev",
    "build": "vercel build",
    "deploy": "vercel --prod",
    "deploy:cf": "wrangler deploy"
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add package.json
git commit -m "chore: add Cloudflare deployment scripts"
```

---

## Task 5: 更新 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 添加 Cloudflare Workers 部署说明**

在现有文档基础上添加 Cloudflare 部署部分：

```markdown
## Cloudflare Workers 部署

### 前置要求

- 安装 Wrangler CLI: `npm install -g wrangler`
- 登录 Cloudflare: `wrangler login`

### 部署步骤

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/) 创建一个新的 Worker
2. 设置环境变量 `MINIMAX_API_KEY`
3. 运行部署：

```bash
npm run deploy:cf
```

### 本地开发

```bash
npm run dev:cf
```
```

- [ ] **Step 2: 更新项目结构图**

将项目结构更新为包含新文件：

```
├── api/
│   └── proxy.js      # Vercel Serverless Function 适配器
├── workers/
│   └── index.js      # Cloudflare Workers 适配器
├── src/
│   └── core.js       # 共享核心代理逻辑
├── public/
│   └── index.html    # 配置页面
├── vercel.json       # Vercel 配置
├── wrangler.toml     # Cloudflare Workers 配置
├── package.json      # 项目依赖
└── README.md
```

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: add Cloudflare Workers deployment guide"
```

---

## 验证清单

- [ ] Vercel 部署仍能正常工作 (`vercel --prod`)
- [ ] Cloudflare Workers 部署成功 (`wrangler deploy`)
- [ ] OpenAI 兼容端点测试通过 (`/v1/chat/completions`)
- [ ] Anthropic 兼容端点测试通过 (`/anthropic/v1/messages`)
- [ ] 流式响应正常工作

---

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
