/**
 * MiniMax Token Plan API Proxy
 * Cloudflare Workers 适配器
 */

import { handleProxyRequest } from '../src/core.js';
import { API_BASE, API_BASE_WWW } from '../src/config.js';

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
      apiBase: env.MINIMAX_API_BASE || API_BASE,
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
