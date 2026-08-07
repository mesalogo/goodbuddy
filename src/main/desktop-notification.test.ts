import { beforeEach, describe, expect, it, vi } from 'vitest'
import { showDesktopNotificationWhenUnfocused } from './desktop-notification'

const notificationMocks = vi.hoisted(() => ({
  isSupported: vi.fn(() => true),
  show: vi.fn()
}))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported = notificationMocks.isSupported

    show = notificationMocks.show
  }
}))

describe('showDesktopNotificationWhenUnfocused', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationMocks.isSupported.mockReturnValue(true)
  })

  it('suppresses desktop notifications while GoodBuddy is focused', () => {
    const shown = showDesktopNotificationWhenUnfocused(
      {
        isDestroyed: vi.fn(() => false),
        isFocused: vi.fn(() => true)
      } as never,
      { title: '任务已完成' }
    )

    expect(shown).toBe(false)
    expect(notificationMocks.show).not.toHaveBeenCalled()
  })

  it('shows desktop notifications while GoodBuddy is unfocused', () => {
    const shown = showDesktopNotificationWhenUnfocused(
      {
        isDestroyed: vi.fn(() => false),
        isFocused: vi.fn(() => false)
      } as never,
      { title: '任务已完成' }
    )

    expect(shown).toBe(true)
    expect(notificationMocks.show).toHaveBeenCalledOnce()
  })
})
