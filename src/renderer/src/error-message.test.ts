import { describe, expect, it } from 'vitest'
import {
  displayErrorMessage,
  displayNetworkAwareErrorMessage
} from './error-message'

describe('error message formatting', () => {
  it('replaces fetch failures with localized network guidance', () => {
    expect(
      displayNetworkAwareErrorMessage(
        new Error(
          "Error invoking remote method 'application:update:check': TypeError: fetch failed"
        ),
        'Version check failed',
        'Check your network and try again'
      )
    ).toBe('Check your network and try again')
  })

  it('preserves bounded HTTP and provider details', () => {
    expect(
      displayNetworkAwareErrorMessage(
        new Error('HTTP 503: release manifest unavailable'),
        'Version check failed',
        'Check your network and try again'
      )
    ).toBe('HTTP 503: release manifest unavailable')
    expect(
      displayErrorMessage(
        new Error(
          "Error invoking remote method 'application:update:check': Error: provider rejected request"
        ),
        'Version check failed'
      )
    ).toBe('provider rejected request')
  })
})
