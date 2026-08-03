import { describe, expect, it } from 'vitest'
import { modelProfilePresets } from './model-presets'

describe('modelProfilePresets', () => {
  it('includes domestic, local, and generic protocol presets', () => {
    expect(modelProfilePresets.map((preset) => preset.id)).toEqual(
      expect.arrayContaining([
        'bigtoken-gpt-image-2',
        'deepseek',
        'qwen',
        'glm',
        'kimi',
        'minimax',
        'siliconflow',
        'volcengine-ark',
        'hunyuan-deployment',
        'huawei-deployment',
        'ollama',
        'openai',
        'openai-compatible',
        'anthropic-compatible'
      ])
    )
    expect(
      modelProfilePresets.find((preset) => preset.id === 'ollama')
    ).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434/v1',
      protocol: 'openai-chat-completions',
      authentication: 'none'
    })
    expect(
      modelProfilePresets.find(
        (preset) => preset.id === 'bigtoken-gpt-image-2'
      )
    ).toMatchObject({
      baseUrl: 'https://bigtoken.ai/v1',
      modelName: 'gpt-image-2',
      protocol: 'openai-images-generations',
      authentication: 'api-key'
    })
    expect(
      modelProfilePresets.find((preset) => preset.id === 'openai')
    ).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      authentication: 'api-key'
    })
  })

  it('does not invent universal Hunyuan or Huawei endpoints', () => {
    for (const id of ['hunyuan-deployment', 'huawei-deployment']) {
      expect(
        modelProfilePresets.find((preset) => preset.id === id)
      ).toMatchObject({
        baseUrl: '',
        requiresDeploymentUrl: true
      })
    }
  })
})
