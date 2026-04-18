---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3044022047b3815fd349541a9e6aad3a9735981797cf451fc9abfe20ab0e2407e0a1a263022012e4e04a55a59ba06566be32b40cc5fa260565e2d0795ec7271acaa878120ccb
    ReservedCode2: 3046022100c159fb78e2ae9cf6348b271da50aac2efff7c9869fd27bdf398a919be01971f202210096b2ab104cb7d7b13ade39a4ec1b89c11b21b595c3305e3d683b6721f55b3eeb
---

# MiniMax Token Plan API Proxy - Vercel 部署指南

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
   - 添加 `MINIMAX_API_KEY` 变量，值为您的 MiniMax Token Plan API Key

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
   - 添加 `MINIMAX_API_KEY` = 您的 Token Plan API Key

## 获取 Token Plan API Key

1. 访问 [Token Plan 订阅页面](https://platform.minimaxi.com/subscribe/token-plan)
2. 订阅成功后，前往 [接口密钥页面](https://platform.minimaxi.com/user-center/basic-information/interface-key)
3. 创建或复制 Token Plan API Key

**重要提示：**
- 此 API Key 为 **Token Plan** 专属，和按量计费 API Key 并不互通
- 此 API Key 仅在您订阅 **Token Plan** 有效期内有效

## 部署后配置

部署完成后，您将获得一个 Vercel 域名，例如：
`https://minimax-proxy-xxx.vercel.app`

### API 端点

| 接口类型 | 端点 URL |
|----------|----------|
| **OpenAI 兼容** | `https://your-domain.vercel.app/v1/chat/completions` |
| **Anthropic 兼容** | `https://your-domain.vercel.app/anthropic/v1/messages` |

## 常见问题

### Q: 如何使用代理？

在您的 AI 工具中，将 API Base URL 设置为代理地址即可。

**Claude Code 示例：**
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-domain.vercel.app/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-token-plan-api-key",
    "ANTHROPIC_MODEL": "MiniMax-M2.7"
  }
}
```

**Cursor 示例：**
1. Settings → Models
2. Override Anthropic Base URL: `https://your-domain.vercel.app/anthropic`
3. 输入 API Key
4. 选择模型: `MiniMax-M2.7`

### Q: 如何避免 API Key 泄露？

**推荐方法：**
1. 在 Vercel 项目中设置环境变量 `MINIMAX_API_KEY`
2. 用户请求时通过 `Authorization: Bearer <API_KEY>` header 传递 API Key
3. 不要在前端页面暴露您的 API Key

### Q: 代理有流量限制吗？

Vercel 免费计划每月提供 100GB 带宽，对于个人使用通常足够。

### Q: 如何绑定自定义域名？

1. 在 Vercel Dashboard 中进入项目设置
2. 点击 "Domains"
3. 添加您的自定义域名
4. 按照指示配置 DNS 记录

### Q: 中国区和国际区有什么区别？

- **中国区**: `api.minimaxi.com` - 适合国内用户
- **国际区**: `api.minimax.io` - 适合海外用户

代理默认使用中国区 API，如需使用国际区，请在请求时添加 `?region=int` 参数。

## 项目结构说明

```
minimax-proxy/
├── api/                    # API 代理函数
│   ├── proxy.js           # 核心代理逻辑
│   ├── v1.js             # OpenAI 兼容端点
│   └── anthropic.js       # Anthropic 兼容端点
├── public/                # 静态文件
│   └── index.html         # 配置页面
├── vercel.json            # Vercel 配置
├── package.json           # 项目依赖
└── README.md              # 项目说明
```

## 技术支持

- MiniMax 平台: https://platform.minimaxi.com
- MiniMax API 文档: https://platform.minimaxi.com/docs
- Vercel 文档: https://vercel.com/docs
