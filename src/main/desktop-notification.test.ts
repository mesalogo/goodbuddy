import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerDesktopNotificationActivation,
  showDesktopNotificationWhenUnfocused
} from './desktop-notification'

const notificationMocks = vi.hoisted(() => ({
  activationHandler: undefined as (() => void) | undefined,
  handleActivation: vi.fn((callback: () => void) => {
    notificationMocks.activationHandler = callback
  }),
  close: vi.fn(),
  isSupported: vi.fn(() => true),
  show: vi.fn(),
  instances: [] as Array<{
    emit: (event: string, ...args: unknown[]) => boolean
    listenerCount: (event: string) => number
  }>
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')

  return {
    Notification: class extends EventEmitter {
      static handleActivation = notificationMocks.handleActivation
      static isSupported = notificationMocks.isSupported

      close = notificationMocks.close
      show = notificationMocks.show

      constructor() {
        super()
        notificationMocks.instances.push(this)
      }
    }
  }
})

describe('showDesktopNotificationWhenUnfocused', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationMocks.activationHandler = undefined
    notificationMocks.isSupported.mockReturnValue(true)
    notificationMocks.instances.length = 0
  })

  afterEach(() => {
    for (const notification of notificationMocks.instances) {
      notification.emit('close', {})
    }
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

  it('registers Windows notification activation to restore GoodBuddy', () => {
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }

    registerDesktopNotificationActivation(window as never, 'win32')
    notificationMocks.activationHandler?.()

    expect(notificationMocks.handleActivation).toHaveBeenCalledOnce()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('waits for the renderer before showing a cold-start activation', () => {
    const webContents = new EventEmitter() as EventEmitter & {
      getURL: ReturnType<typeof vi.fn>
      isLoadingMainFrame: ReturnType<typeof vi.fn>
    }
    webContents.getURL = vi.fn(() => '')
    webContents.isLoadingMainFrame = vi.fn(() => true)
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents
    }

    registerDesktopNotificationActivation(window as never, 'win32')
    notificationMocks.activationHandler?.()

    expect(window.show).not.toHaveBeenCalled()

    webContents.getURL.mockReturnValue(
      'file:///D:/goodbuddy/out/renderer/index.html'
    )
    webContents.isLoadingMainFrame.mockReturnValue(false)
    webContents.emit('did-finish-load')

    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('does not register native activation outside Windows', () => {
    registerDesktopNotificationActivation(
      {
        isDestroyed: vi.fn(() => false)
      } as never,
      'linux'
    )

    expect(notificationMocks.handleActivation).not.toHaveBeenCalled()
  })

  it('restores, shows, and focuses GoodBuddy when a notification is clicked', () => {
    const window = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }

    showDesktopNotificationWhenUnfocused(window as never, {
      title: '任务已完成'
    })

    notificationMocks.instances[0]!.emit('click', {})

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(
      notificationMocks.instances[0]!.listenerCount('click')
    ).toBe(0)
  })

  it('does not operate on a window destroyed before the click', () => {
    const window = {
      isDestroyed: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      isFocused: vi.fn(() => false),
      isMinimized: vi.fn(),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }

    showDesktopNotificationWhenUnfocused(window as never, {
      title: '任务已完成'
    })
    notificationMocks.instances[0]!.emit('click', {})

    expect(window.isMinimized).not.toHaveBeenCalled()
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('does not let window activation errors escape the native callback', () => {
    const window = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(() => {
        throw new Error('window closed')
      }),
      focus: vi.fn()
    }

    showDesktopNotificationWhenUnfocused(window as never, {
      title: '任务已完成'
    })

    expect(() =>
      notificationMocks.instances[0]!.emit('click', {})
    ).not.toThrow()
    expect(
      notificationMocks.instances[0]!.listenerCount('click')
    ).toBe(0)
  })

  it.each(['close', 'failed'])(
    'releases retained notifications after %s',
    (event) => {
      showDesktopNotificationWhenUnfocused(
        {
          isDestroyed: vi.fn(() => false),
          isFocused: vi.fn(() => false)
        } as never,
        { title: '任务已完成' }
      )
      const notification = notificationMocks.instances[0]!

      notification.emit(event, {})

      expect(notification.listenerCount('click')).toBe(0)
    }
  )

  it('releases an unhandled notification after a bounded retention period', () => {
    vi.useFakeTimers()
    try {
      showDesktopNotificationWhenUnfocused(
        {
          isDestroyed: vi.fn(() => false),
          isFocused: vi.fn(() => false)
        } as never,
        { title: '任务已完成' }
      )
      const notification = notificationMocks.instances[0]!

      expect(notification.listenerCount('click')).toBe(1)
      vi.advanceTimersByTime(15 * 60_000)
      expect(notificationMocks.close).toHaveBeenCalledOnce()
      expect(notification.listenerCount('click')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds retained notification instances during long-running sessions', () => {
    for (let index = 0; index < 65; index += 1) {
      showDesktopNotificationWhenUnfocused(
        {
          isDestroyed: vi.fn(() => false),
          isFocused: vi.fn(() => false)
        } as never,
        { title: `任务已完成 ${index}` }
      )
    }

    expect(notificationMocks.close).toHaveBeenCalledOnce()
    expect(notificationMocks.instances[0]!.listenerCount('click')).toBe(0)
    expect(notificationMocks.instances[64]!.listenerCount('click')).toBe(1)
  })
})
