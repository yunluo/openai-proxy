/**
 * MiniMax Token Plan API Proxy
 * Vercel Serverless Function
 *
 * 支持中国区和国际区 API
 * 中国区: api.minimaxi.com
 * 国际区: api.minimax.io
 */

const API_BASE_CN = 'https://api.minimaxi.com';
const API_BASE_INT = 'https://api.minimax.io';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 获取区域参数，默认为中国区（兼容国内用户）
    const region = req.query.region || 'cn';
    const API_BASE = region === 'int' ? API_BASE_INT : API_BASE_CN;

    // 解析路径
    const path = req.url.replace('/api/proxy', '').split('?')[0] || '/v1/chat/completions';

    // 获取 API Key
    const apiKey = req.headers['authorization']?.replace('Bearer ', '') ||
                   req.headers['x-api-key'] ||
                   process.env.MINIMAX_API_KEY;

    if (!apiKey) {
      return res.status(401).json({
        error: {
          type: 'invalid_request_error',
          message: 'API key is required. Please provide via Authorization header or X-API-Key header.'
        }
      });
    }

    // 确定目标 URL
    let targetUrl;
    let headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    if (path.includes('/anthropic')) {
      // Anthropic 兼容接口
      targetUrl = `${API_BASE}${path}`;
      headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    } else if (path.startsWith('/v1')) {
      // OpenAI 兼容接口
      targetUrl = `${API_BASE}${path}`;
    } else {
      // 默认使用 Anthropic 兼容接口
      targetUrl = `${API_BASE}/anthropic/v1/messages`;
    }

    // 构建请求体
    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = JSON.stringify(req.body);
    }

    // 发起请求
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
    });

    // 获取响应数据
    const data = await response.json();

    return res.status(response.status).json(data);

  } catch (error) {
    console.error('MiniMax Proxy Error:', error);
    return res.status(500).json({
      error: {
        type: 'internal_error',
        message: 'An error occurred while processing your request.'
      }
    });
  }
}
