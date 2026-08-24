import { describe, expect, it } from 'vitest'
import {
  MainModelBridgeDispatchError,
  dispatchFailureCode,
  dispatchFailureIsUncertain,
  validateMainModelBridgeDispatchResponse
} from './main-model-bridge-dispatcher'

describe('Main model bridge dispatcher boundary', () => {
  it('treats unclassified dispatch failures as outcome-unknown', () => {
    expect(dispatchFailureIsUncertain(new Error('secret'))).toBe(true)
    expect(dispatchFailureCode(new Error('secret'))).toBe(
      'dispatch-failed'
    )
  })

  it('permits only an explicit pre-dispatch failure to stay definitive', () => {
    const error = new MainModelBridgeDispatchError(
      'policy-rejected',
      { outcomeUnknown: false, postDispatch: false }
    )
    expect(dispatchFailureIsUncertain(error)).toBe(false)
    expect(dispatchFailureCode(error)).toBe('policy-rejected')
    expect(
      dispatchFailureIsUncertain(
        new MainModelBridgeDispatchError('network-failed', {
          outcomeUnknown: true,
          postDispatch: true
        })
      )
    ).toBe(true)
  })

  it('strictly validates gateway responses', () => {
    expect(
      validateMainModelBridgeDispatchResponse({
        status: 200,
        headers: {},
        bodyBase64: ''
      })
    ).toEqual({
      status: 200,
      headers: {},
      bodyBase64: ''
    })
    expect(() =>
      validateMainModelBridgeDispatchResponse({
        status: 99,
        headers: {},
        bodyBase64: ''
      })
    ).toThrow()
  })
})
