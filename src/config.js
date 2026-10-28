// MiniMax 官网 API 地址（套餐/额度相关接口）
const API_BASE_WWW = "https://www.minimaxi.com";

// 所有支持的 LLM 服务商配置
// 每个服务商可通过 envVar 环境变量覆盖默认地址
export const PROVIDERS = {
  minimax: {
    envVar: "MINIMAX_API_BASE",
    default: "https://api.minimaxi.com/v1",
    // Responses API 使用独立基址（官方文档：https://api.minimax.cn/v1/responses）
    responsesEnvVar: "MINIMAX_RESPONSES_API_BASE",
    responsesDefault: "https://api.minimax.cn/v1",
  },
  glm: {
    envVar: "GLM_API_BASE",
    default: "https://open.bigmodel.cn/api/paas/v4",
    // Responses API 基址与对话补全不同（/api/v1/responses）
    responsesEnvVar: "GLM_RESPONSES_API_BASE",
    responsesDefault: "https://open.bigmodel.cn/api/v1",
  },
  glm_cp: {
    envVar: "GLM_CP_API_BASE",
    default: "https://open.bigmodel.cn/api/coding/paas/v4",
    // 编程套餐的 Chat 走 coding/paas/v4，Responses 仍走标准 /api/v1
    responsesEnvVar: "GLM_CP_RESPONSES_API_BASE",
    responsesDefault: "https://open.bigmodel.cn/api/v1",
  },
  kim: {
    envVar: "KIMI_API_BASE",
    default: "https://api.moonshot.cn/v1",
  },
  deepseek: {
    envVar: "DEEPSEEK_API_BASE",
    default: "https://api.deepseek.com/v1",
    // Responses API 是 https://api.deepseek.com/responses（无 /v1）
    responsesEnvVar: "DEEPSEEK_RESPONSES_API_BASE",
    responsesDefault: "https://api.deepseek.com",
  },
  gpt: {
    envVar: "GPT_API_BASE",
    default: "https://api.openai.com/v1",
    // 裸 /v1/responses、/v1/chat/completions（不带 provider 前缀）的默认上游
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
    // 编程套餐的 OpenAI 兼容入口同时承载 Chat 与 Responses；
    // 如需切到通用方舟 /api/v3，可用该变量单独覆盖 Responses 基址
    responsesEnvVar: "VOLCENGINE_RESPONSES_API_BASE",
  },
  openrouter: {
    envVar: "OPENROUTER_API_BASE",
    default: "https://openrouter.ai/api/v1",
  },
  kilo: {
    envVar: "KILO_API_BASE",
    default: "https://api.kilo.ai/api/gateway",
  },
  opencode_zen: {
    envVar: "OPENCODE_ZEN_API_BASE",
    default: "https://opencode.ai/zen/v1",
  },
};

export { API_BASE_WWW };
