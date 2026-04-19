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

  try {
    const path = req.url.replace('/api/proxy', '').split('?')[0] || '/v1/chat/completions';

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

    let targetUrl;
    let headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    if (path.includes('/token_plan') || path.includes('/coding_plan')) {
      targetUrl = `${API_BASE_WWW}${path}`;
    } else if (path.includes('/anthropic')) {
      targetUrl = `${API_BASE}${path}`;
      headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    } else if (path.startsWith('/v1')) {
      targetUrl = `${API_BASE}${path}`;
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
