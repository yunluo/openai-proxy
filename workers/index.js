/**
 * MiniMax Token Plan API Proxy
 * Cloudflare Workers 适配器
 */

import { handleProxyRequest } from '../src/core.js';

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
        }
      });
    }

    const options = {
      apiBase: API_BASE,
      apiBaseWww: API_BASE_WWW,
      apiKey: env.MINIMAX_API_KEY
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
