function getHeader(headers, name) {
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  return headers[name] || headers[name.toLowerCase()];
}

async function getRequestBody(request) {
  if (request.body && typeof request.json === 'function') {
    return await request.json().catch(() => ({}));
  }
  if (request.body && typeof request.body === 'object') {
    return request.body;
  }
  return {};
}

function resolveProvider(originalPath, options) {
  if (originalPath.startsWith('/token_plan')) {
    const strippedPath = originalPath.replace(/^\/token_plan/, '');
    return { provider: 'minimax', targetBase: options.apiBaseWww, strippedPath };
  }

  const match = originalPath.match(/^\/([^/]+)\/v1(\/.*)?$/);
  if (match) {
    const providerName = match[1].toLowerCase();
    const strippedPath = match[2] || '';

    if (providerName === 'minimax') {
      return { provider: 'minimax', targetBase: options.providers?.minimax?.apiBase, strippedPath: '/v1' + strippedPath };
    }

    const provider = options.providers?.[providerName];
    if (provider) {
      return { provider: providerName, targetBase: provider.apiBase, strippedPath: '/v1' + strippedPath };
    }

    return { error: true, message: `Unknown provider: ${providerName}` };
  }

  if (originalPath.startsWith('/v1')) {
    return { provider: 'minimax', targetBase: options.providers?.minimax?.apiBase, strippedPath: originalPath };
  }

  return { provider: 'minimax', targetBase: options.providers?.minimax?.apiBase, strippedPath: originalPath };
}

export async function handleProxyRequest(request, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };

  const urlPath = request.url.startsWith('/')
    ? request.url.split('?')[0]
    : new URL(request.url).pathname.split('?')[0];
  const originalPath = urlPath || '/v1/chat/completions';
  const apiKey = getHeader(request.headers, 'authorization')?.replace('Bearer ', '') ||
                 getHeader(request.headers, 'x-api-key');

  if (!apiKey) {
    return new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'API key is required. Please provide via Authorization header or X-API-Key header.'
      }
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  headers['Authorization'] = `Bearer ${apiKey}`;

  const resolved = resolveProvider(originalPath, options);

  if (resolved.error) {
    return new Response(JSON.stringify({
      error: {
        type: 'not_found',
        message: resolved.message
      }
    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  if (!resolved.targetBase) {
    return new Response(JSON.stringify({
      error: {
        type: 'not_found',
        message: `Provider base URL not configured`
      }
    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const targetUrl = `${resolved.targetBase}${resolved.strippedPath}`;

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
    if (resolved.provider === 'deepseek' && data.choices?.[0]?.message) {
      const msg = data.choices[0].message;
      if (!('reasoning_content' in msg)) {
        Object.defineProperty(msg, 'reasoning_content', {
          value: null,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
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
