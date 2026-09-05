import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prototypeSnapshot } from '../shared/prototype-data'
import App from './App'

describe('ShareServer console', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => prototypeSnapshot
      })
    )
    window.history.replaceState({}, '', '/')
  })

  it('renders the organization overview from the API snapshot', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: '运行概览' })).toBeInTheDocument()
    expect(screen.getByText('Nebula ShareServer')).toBeInTheDocument()
    expect(screen.getByText('在线设备')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '管理控制台' })).toBeInTheDocument()
  })

  it('opens global search with the keyboard shortcut', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: '运行概览' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    expect(await screen.findByRole('dialog', { name: '全局搜索' })).toBeInTheDocument()
  })
})
