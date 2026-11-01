import { describe, expect, it } from 'vitest'
import { selectRoleWithSystemOne } from './system-one-role-selector'

describe('live System One role selection', () => {
  it.runIf(process.env.GOODBUDDY_SYSTEM_ONE_LIVE === '1')(
    'selects a role through the configured Ollama endpoint', async () => {
      const result = await selectRoleWithSystemOne(
        '用户反馈：重复扣费了，请退款。',
        [
          { id: 'customer-service', name: '客户服务', description: '处理退款、订单和客户投诉。', systemInstructions: '', routingKeywords: [], enabled: true, createdAt: '', updatedAt: '' },
          { id: 'programming', name: '编程', description: '编写代码和排查程序错误。', systemInstructions: '', routingKeywords: [], enabled: true, createdAt: '', updatedAt: '' },
          { id: 'research', name: '研究', description: '检索资料并分析研究问题。', systemInstructions: '', routingKeywords: [], enabled: true, createdAt: '', updatedAt: '' }
        ],
        {
          roleSelectionModelProfileId: 'live',
          modelProfiles: [{ id: 'live', name: 'd3', baseUrl: 'http://10.7.0.152:11434', modelName: 'd3', protocol: 'system-one', authentication: 'none' }]
        },
        new AbortController().signal
      )
      expect(result?.expert.id).toBe('customer-service')
      expect(result?.confidence).toBeGreaterThan(0.6)
    }
  )
})
