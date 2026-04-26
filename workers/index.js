import { handleProxyRequest } from '../src/core.js';
import { API_BASE, API_BASE_WWW, PROVIDERS } from '../src/config.js';

function loadCustomProviders(envSource) {
  const providers = {};
  let i = 1;
  while (i <= 100) {
    const name = envSource[`CUSTOM_PROVIDER_${i}_NAME`];
    const apiBase = envSource[`CUSTOM_PROVIDER_${i}_API_BASE`];
    if (!name || !apiBase) break;
    providers[name.toLowerCase()] = { apiBase };
    i++;
  }
  return providers;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        }
      });
    }

    const options = {
      providers: {
        ...Object.fromEntries(
          Object.entries(PROVIDERS).map(([name, cfg]) => [
            name,
            { apiBase: env[cfg.envVar] || cfg.default }
          ])
        ),
        ...loadCustomProviders(env),
      },
      apiBaseWww: env.MINIMAX_API_BASE_WWW || API_BASE_WWW
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
