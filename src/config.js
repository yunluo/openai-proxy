const API_BASE = 'https://api.minimaxi.com';
const API_BASE_WWW = 'https://www.minimaxi.com';

export const PROVIDERS = {
  minimax:  { envVar: 'MINIMAX_API_BASE',  default: 'https://api.minimaxi.com' },
  glm:      { envVar: 'GLM_API_BASE',       default: 'https://open.bigmodel.cn' },
  kim:      { envVar: 'KIMI_API_BASE',      default: 'https://api.moonshot.cn' },
  deepseek: { envVar: 'DEEPSEEK_API_BASE',  default: 'https://api.deepseek.com' },
  gpt:      { envVar: 'GPT_API_BASE',       default: 'https://api.openai.com' },
  xiaomi:   { envVar: 'XIAOMI_API_BASE',    default: 'https://api.xiaomimimo.com' },
  qwen:     { envVar: 'QWEN_API_BASE',      default: 'https://dashscope.aliyuncs.com/compatible-mode' },
  opencode:    { envVar: 'OPENCODE_API_BASE',       default: 'https://opencode.ai/zen/go' },
  siliconflow: { envVar: 'SILICONFLOW_API_BASE',    default: 'https://api.siliconflow.cn' },
};

export { API_BASE, API_BASE_WWW };
