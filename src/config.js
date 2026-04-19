/**
 * MiniMax Token Plan API Proxy - Configuration
 * API 基础 URL 配置
 * 支持环境变量覆盖，默认使用代码中定义的值
 */

const API_BASE = process.env.MINIMAX_API_BASE || 'https://api.minimaxi.com';
const API_BASE_WWW = process.env.MINIMAX_API_BASE_WWW || 'https://www.minimaxi.com';

export { API_BASE, API_BASE_WWW };
