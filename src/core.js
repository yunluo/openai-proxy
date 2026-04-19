/**
 * MiniMax Token Plan API Proxy - Core Logic
 * 环境无关的核心代理功能
 */

const DEFAULT_API_BASE = 'https://api.minimaxi.com';
const DEFAULT_API_BASE_WWW = 'https://www.minimaxi.com';

function getHeader(headers, name) {
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  return headers[name] || headers[name.toLowerCase()];
}

async function getRequestBody(request) {
  if (request.body && typeof request.body === 'object') {
    return request.body;
  }
  if (typeof request.json === 'function') {
    return await request.json().catch(() => ({}));
  }
  return {};
}

export async function handleProxyRequest(request, options = {}) {
  const apiBase = options.apiBase || DEFAULT_API_BASE;
  const apiBaseWww = options.apiBaseWww || DEFAULT_API_BASE_WWW;

  const headers = {
    'Content-Type': 'application/json',
  };

  let targetUrl = '';
  const urlPath = request.url.startsWith('/') 
    ? request.url.split('?')[0]
    : new URL(request.url).pathname.split('?')[0];
  const originalPath = urlPath || '/v1/chat/completions';
  const apiKey = getHeader(request.headers, 'authorization')?.replace('Bearer ', '') ||
                 getHeader(request.headers, 'x-api-key') ||
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
    const anthropicVersion = getHeader(request.headers, 'anthropic-version');
    if (anthropicVersion) headers['anthropic-version'] = anthropicVersion;
  } else if (originalPath.startsWith('/v1')) {
    targetUrl = `${apiBase}${originalPath}`;
  } else {
    targetUrl = `${apiBase}/anthropic/v1/messages`;
  }

  let body = null;
  let requestBodyObj = {};
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    requestBodyObj = await getRequestBody(request);
    body = JSON.stringify(requestBodyObj);
  }

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: headers,
    body: body,
  });

  const contentType = response.headers.get('content-type');
  const isStreaming = requestBodyObj.stream !== false;

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
