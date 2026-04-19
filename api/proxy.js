/**
 * MiniMax Token Plan API Proxy
 * Vercel Serverless Function 适配器
 */

import { handleProxyRequest } from '../src/core.js';

const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const options = {
    apiBase: API_BASE,
    apiBaseWww: API_BASE_WWW,
    apiKey: process.env.MINIMAX_API_KEY
  };

  try {
    const response = await handleProxyRequest(req, options);
    const data = await response.text();
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    return res.status(response.status).send(data);
  } catch (error) {
    console.error('MiniMax Proxy Error:', error);
    return res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message || 'An error occurred while processing your request.'
      }
    });
  }
}
