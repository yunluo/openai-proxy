---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3045022006c9ee3223e28dc0c00c571354c57f3161f4f9c3c6b6aaad376eac1be0926cbb0221009b01abcaf1fdd8e0b3c4fa814c17994383062e35b702e3f18cf03b8b4f63ef41
    ReservedCode2: 3044022011810c17412549381c6acedf8fe8af428f411f3399a922341fb771439b0efec802201c8364854fa88b0892c87985539dbd1e2322589785fd8f75b7fc4039d793a17c
---

# Vercel 部署指南

## 快速部署步骤

### 方法一：通过 Vercel CLI 部署

1. **安装 Vercel CLI**
   ```bash
   npm i -g vercel
   ```

2. **登录 Vercel**
   ```bash
   vercel login
   ```

3. **进入项目目录并部署**
   ```bash
   cd minimax-proxy
   vercel
   ```

4. **设置环境变量**
   - 在 Vercel Dashboard 中进入项目设置
   - 找到 Environment Variables
   - 添加 `MINIMAX_API_KEY` 变量，值为您的 MiniMax API Key

5. **生产环境部署**
   ```bash
   vercel --prod
   ```

### 方法二：通过 GitHub 部署

1. **将代码推送到 GitHub**
   ```bash
   cd minimax-proxy
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/minimax-proxy.git
   git push -u origin main
   ```

2. **在 Vercel 导入项目**
   - 访问 https://vercel.com/new
   - 选择 "Import Git Repository"
   - 选择您的 GitHub 仓库
   - 点击 "Deploy"

3. **配置环境变量**
   - 进入项目设置 → Environment Variables
   - 添加 `MINIMAX_API_KEY` = 您的 API Key

### 方法三：一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/MiniMax-AI/MiniMax-Coding-Plan-Proxy)

## 获取 MiniMax API Key

1. 访问 [MiniMax Developer Platform](https://platform.minimax.io)
2. 登录您的账户
3. 进入 Account → Basic Information → Interface Key
4. 复制 API Key

### Token Plan 用户
如果您订阅了 MiniMax Token Plan / Coding Plan，请从 Token Plan 页面获取专用的 Token Plan API Key。

## 部署后配置

部署完成后，您将获得一个 Vercel 域名，例如：
`https://minimax-proxy-xxx.vercel.app`

### API 端点

**OpenAI 兼容接口：**
```
https://your-domain.vercel.app/v1/chat/completions
```

**Anthropic 兼容接口：**
```
https://your-domain.vercel.app/anthropic/v1/messages
```

## 常见问题

### Q: 如何使用代理？

在您的 AI 工具中，将 API Base URL 设置为代理地址即可。

**Claude Code 示例：**
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-domain.vercel.app/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key"
  }
}
```

**Cursor 示例：**
- Settings → Models → Override OpenAI Base URL: `https://your-domain.vercel.app/v1`

### Q: 如何避免 API Key 泄露？

**推荐方法：**
1. 在 Vercel 项目中设置环境变量 `MINIMAX_API_KEY`
2. 用户请求时通过 `X-API-Key` header 传递 API Key
3. 不要在前端页面暴露您的 API Key

### Q: 代理有流量限制吗？

Vercel 免费计划每月提供 100GB 带宽，对于个人使用通常足够。

### Q: 如何绑定自定义域名？

1. 在 Vercel Dashboard 中进入项目设置
2. 点击 "Domains"
3. 添加您的自定义域名
4. 按照指示配置 DNS 记录

## 项目结构说明

```
minimax-proxy/
├── api/                    # API 代理函数
│   ├── proxy.js           # 通用代理
│   ├── v1/[...path].js    # OpenAI 兼容接口
│   └── anthropic/[...path].js  # Anthropic 兼容接口
├── public/                # 静态文件
│   ├── index.html         # 配置页面
│   └── config-guide.html  # 配置指南
├── vercel.json            # Vercel 配置
├── package.json           # 项目依赖
└── README.md              # 项目说明
```

## 技术支持

- MiniMax API: api@minimax.io
- Vercel 文档: https://vercel.com/docs
