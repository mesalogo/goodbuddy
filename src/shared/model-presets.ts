import type {
  ModelAuthentication,
  ModelProtocol
} from './contracts'

export type ModelProfilePreset = {
  id: string
  name: string
  description: string
  baseUrl: string
  modelName: string
  protocol: ModelProtocol
  authentication: ModelAuthentication
  requiresDeploymentUrl?: boolean
}

export const modelProfilePresets = [
  {
    id: 'bigtoken-gpt-image-2',
    name: 'BigToken GPT Image 2',
    description: 'BigToken 图像生成接口，生成结果直接显示在会话中',
    baseUrl: 'https://bigtoken.ai/v1',
    modelName: 'gpt-image-2',
    protocol: 'openai-images-generations',
    authentication: 'api-key'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 官方 OpenAI 兼容接口',
    baseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'qwen',
    name: 'Qwen（DashScope）',
    description: '阿里云百炼 DashScope OpenAI 兼容接口',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelName: 'qwen-plus',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'glm',
    name: 'GLM（智谱）',
    description: '智谱 AI OpenAI 兼容接口',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelName: 'glm-4.5',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    description: 'Moonshot OpenAI 兼容接口',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelName: 'moonshot-v1-8k',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax 国内 OpenAI 兼容接口',
    baseUrl: 'https://api.minimaxi.com/v1',
    modelName: 'MiniMax-M2.1',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow（硅基流动）',
    description: 'SiliconFlow OpenAI 兼容接口',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelName: 'deepseek-ai/DeepSeek-V3.2',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'volcengine-ark',
    name: '火山引擎方舟',
    description: '方舟 OpenAI 兼容接口；模型填写推理接入点 ID',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelName: 'ep-your-endpoint-id',
    protocol: 'openai-chat-completions',
    authentication: 'api-key'
  },
  {
    id: 'hunyuan-deployment',
    name: '腾讯混元（自定义部署）',
    description: '填写部署文档提供的专属 API Root 和模型或部署 ID',
    baseUrl: '',
    modelName: 'deployment-id',
    protocol: 'openai-chat-completions',
    authentication: 'api-key',
    requiresDeploymentUrl: true
  },
  {
    id: 'huawei-deployment',
    name: '华为云模型（自定义部署）',
    description: '填写部署所在区域提供的专属 API Root 和部署 ID',
    baseUrl: '',
    modelName: 'deployment-id',
    protocol: 'openai-chat-completions',
    authentication: 'api-key',
    requiresDeploymentUrl: true
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    description: '本机 Ollama OpenAI 兼容接口，无需 API Key',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'llama3.2',
    protocol: 'openai-chat-completions',
    authentication: 'none'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI Responses API',
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4.1',
    protocol: 'openai-responses',
    authentication: 'api-key'
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容（自定义）',
    description: '填写服务商提供的 API Root 和模型名称',
    baseUrl: '',
    modelName: 'model-name',
    protocol: 'openai-chat-completions',
    authentication: 'api-key',
    requiresDeploymentUrl: true
  },
  {
    id: 'anthropic-compatible',
    name: 'Anthropic Messages 兼容（自定义）',
    description: '填写服务商提供的 API Root 和模型名称',
    baseUrl: '',
    modelName: 'model-name',
    protocol: 'anthropic-messages',
    authentication: 'api-key',
    requiresDeploymentUrl: true
  }
] as const satisfies readonly ModelProfilePreset[]
