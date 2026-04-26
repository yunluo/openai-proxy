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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const options = {
    providers: {
      ...Object.fromEntries(
        Object.entries(PROVIDERS).map(([name, cfg]) => [
          name,
          { apiBase: process.env[cfg.envVar] || cfg.default }
        ])
      ),
      ...loadCustomProviders(process.env),
    },
    apiBaseWww: process.env.MINIMAX_API_BASE_WWW || API_BASE_WWW
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
