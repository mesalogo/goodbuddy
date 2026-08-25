import { describe, expect, it } from 'vitest'
import {
  feedbackCategories,
  feedbackLimits,
  feedbackPublicPayloadSchema,
  feedbackPublicResponseSchema,
  feedbackSubmitInputSchema
} from './feedback-contracts'

const clientRequestId = '00000000-0000-4000-8000-000000000101'
const installationId = '00000000-0000-4000-8000-000000000102'

describe('feedback contracts', () => {
  it.each(feedbackCategories)('accepts the %s category', (category) => {
    expect(
      feedbackSubmitInputSchema.parse({
        category,
        title: '  Feedback title  ',
        description: '  A useful feedback description.  ',
        locale: 'zh-CN',
        clientRequestId
      })
    ).toMatchObject({
      category,
      title: 'Feedback title',
      description: 'A useful feedback description.'
    })
  })

  it('rejects unknown fields, invalid contact details, and oversized screenshots', () => {
    expect(() =>
      feedbackSubmitInputSchema.parse({
        category: 'bug',
        title: 'Feedback title',
        description: 'A useful feedback description.',
        locale: 'zh-CN',
        clientRequestId,
        endpoint: 'https://attacker.example'
      })
    ).toThrow()
    expect(() =>
      feedbackSubmitInputSchema.parse({
        category: 'bug',
        title: 'Feedback title',
        description: 'A useful feedback description.',
        contactEmail: 'not-an-email',
        locale: 'zh-CN',
        clientRequestId
      })
    ).toThrow()
    expect(() =>
      feedbackSubmitInputSchema.parse({
        category: 'bug',
        title: 'Feedback title',
        description: 'A useful feedback description.',
        locale: 'zh-CN',
        clientRequestId,
        screenshot: {
          data: new Uint8Array(
            feedbackLimits.maximumScreenshotBytes + 1
          ),
          mimeType: 'image/png'
        }
      })
    ).toThrow()
  })

  it('matches the deployed version 1 public payload and response', () => {
    expect(
      feedbackPublicPayloadSchema.parse({
        schemaVersion: 1,
        productKey: 'goodbuddy',
        category: 'experience',
        title: 'Feedback title',
        description: 'A useful feedback description.',
        contactEmail: 'user@example.com',
        environment: {
          appVersion: '0.11.0',
          platform: 'windows',
          architecture: 'x64',
          locale: 'en-US'
        },
        installationId,
        clientRequestId
      })
    ).toMatchObject({
      schemaVersion: 1,
      productKey: 'goodbuddy'
    })
    expect(
      feedbackPublicResponseSchema.parse({
        reference: 'GOODBUDDY-1000000',
        duplicate: false
      })
    ).toEqual({
      reference: 'GOODBUDDY-1000000',
      duplicate: false
    })
  })
})
