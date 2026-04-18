/**
 * MiniMax Coding Plan API Proxy
 * Vercel Serverless Function
 */

const API_BASE = 'https://api.minimax.io';

export default async function handler(req, res) {
  // CORS headers
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
          message: 'API key is required. Provide via Authorization header or X-API-Key header.'
        }
      });
    }

    // Determine target API
    let targetUrl;
    let headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    if (path.includes('/anthropic')) {
      targetUrl = `https://api.minimax.io${path}`;
      if (req.headers['anthropic-version']) {
        headers['anthropic-version'] = req.headers['anthropic-version'];
      }
    } else if (path.startsWith('/v1')) {
      targetUrl = `${API_BASE}${path}`;
    } else {
      targetUrl = `${API_BASE}/v1${path}`;
    }

    // Make request
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
    console.error('Proxy error:', error);
    return res.status(500).json({
      error: {
        type: 'internal_error',
        message: 'An error occurred while processing your request.'
      }
    });
  }
}
