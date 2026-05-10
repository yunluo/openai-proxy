// MiniMax 官网 API 地址（套餐/额度相关接口）
const API_BASE_WWW = "https://www.minimaxi.com";

// 所有支持的 LLM 服务商配置
// 每个服务商可通过 envVar 环境变量覆盖默认地址
export const PROVIDERS = {
  minimax: {
    envVar: "MINIMAX_API_BASE",
    default: "https://api.minimaxi.com/v1",
  },
  minimax_anthropic: {
    envVar: "MINIMAX_ANTHROPIC_API_BASE",
    default: "https://api.minimaxi.com/anthropic/v1",
  },
  glm: {
    envVar: "GLM_API_BASE",
    default: "https://open.bigmodel.cn/api/paas/v4",
  },
  glm_cp: {
    envVar: "GLM_CP_API_BASE",
    default: "https://open.bigmodel.cn/api/coding/paas/v4",
  },
  kim: {
    envVar: "KIMI_API_BASE",
    default: "https://api.moonshot.cn/v1",
  },
  deepseek: {
    envVar: "DEEPSEEK_API_BASE",
    default: "https://api.deepseek.com/v1",
  },
  deepseek_anthropic: {
    envVar: "DEEPSEEK_ANTHROPIC_API_BASE",
    default: "https://api.deepseek.com/anthropic",
  },
  gpt: {
    envVar: "GPT_API_BASE",
    default: "https://api.openai.com/v1",
  },
  xiaomi: {
    envVar: "XIAOMI_API_BASE",
    default: "https://api.xiaomimimo.com/v1",
  },
  xiaomi_cp: {
    envVar: "XIAOMI_CP_API_BASE",
    default: "https://token-plan-cn.xiaomimimo.com/v1",
  },
  qwen: {
    envVar: "QWEN_API_BASE",
    default: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  opencode: {
    envVar: "OPENCODE_API_BASE",
    default: "https://opencode.ai/zen/go/v1",
  },
  opencode_anthropic: {
    envVar: "OPENCODE_ANTHROPIC_API_BASE",
    default: "https://opencode.ai/zen/go/v1",
  },
  siliconflow: {
    envVar: "SILICONFLOW_API_BASE",
    default: "https://api.siliconflow.cn/v1",
  },
  aliyun: {
    envVar: "ALIYUN_API_BASE",
    default: "https://coding.dashscope.aliyuncs.com/v1",
  },
  volcengine: {
    envVar: "VOLCENGINE_API_BASE",
    default: "https://ark.cn-beijing.volces.com/api/coding/v3",
  },
};

export { API_BASE_WWW };
