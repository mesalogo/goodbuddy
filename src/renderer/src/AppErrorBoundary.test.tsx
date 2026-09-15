import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from './AppErrorBoundary'

function Broken(): never {
  throw new Error('test render failure')
}

afterEach(() => {
  cleanup()
  localStorage.removeItem('goodbuddy.ui-locale')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AppErrorBoundary', () => {
  it('leaves healthy children visible', () => {
    render(<AppErrorBoundary><p>Working application</p></AppErrorBoundary>)
    expect(screen.getByText('Working application')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['zh-CN', '重新加载'],
    ['en-US', 'Reload']
  ])('recovers a failed tree without providers in %s and reloads only on click', (locale, label) => {
    localStorage.setItem('goodbuddy.ui-locale', locale)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>)
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.getByRole('main')).toHaveAttribute('lang', locale)
    expect(log).toHaveBeenCalledWith('GoodBuddy UI failed', expect.any(Error), expect.stringContaining('Broken'))
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('still displays recovery when locale storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>)
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })
})
