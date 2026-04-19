/**
 * MiniMax Token Plan API Proxy
 * Vercel Serverless Function
 *
 * 中国区 API: api.minimaxi.com
 * 中国区网站: www.minimaxi.com
 */

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let targetUrl = '';
  let headers = {};

  try {
    const originalPath = req.url.split('?')[0] || '/v1/chat/completions';
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

    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    // 判断请求类型并构建目标路径
    if (originalPath.includes('/token_plan') || originalPath.includes('/coding_plan')) {
      // 去掉 /token_plan 或 /coding_plan 前缀
      const targetPath = originalPath.replace(/^\/token_plan/, '').replace(/^\/coding_plan/, '');
      targetUrl = `${API_BASE_WWW}${targetPath}`;
    } else if (originalPath.includes('/anthropic')) {
      targetUrl = `${API_BASE}${originalPath}`;
      headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    } else if (originalPath.startsWith('/v1')) {
      targetUrl = `${API_BASE}${originalPath}`;
    } else {
      targetUrl = `${API_BASE}/anthropic/v1/messages`;
    }

    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
    });

    // Check if streaming is requested (default to true if not specified)
    const isStreaming = req.body?.stream !== false;
    const contentType = response.headers.get('content-type');

    if (isStreaming && contentType?.includes('text/event-stream')) {
      // Stream the response directly
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
        res.end();
      } catch (streamError) {
        console.error('Stream error:', streamError);
        res.end();
      }
      return;
    }

    // Non-streaming response
    let data;
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return res.status(response.status).json(data);

  } catch (error) {
    console.error('MiniMax Proxy Error:', error);
    console.error('Target URL:', targetUrl);
    console.error('Request headers:', headers);
    return res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message || 'An error occurred while processing your request.'
      }
    });
  }
}
