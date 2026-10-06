import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolOutputReader } from './ToolOutputReader'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('loads saved output on demand, replaces bounded pages, copies the visible page, and retries errors', async () => {
  const readOutput = vi.fn().mockResolvedValueOnce({ content: 'first', cursor: 0, nextCursor: 5, totalBytes: 9, eof: false })
    .mockRejectedValueOnce(new Error('Storage unavailable'))
    .mockResolvedValueOnce({ content: 'tail', cursor: 5, nextCursor: 9, totalBytes: 9, eof: true })
  vi.stubGlobal('goodbuddy', undefined)
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { context: { readOutput } } })
  const onCopy = vi.fn(async () => true)
  render(<ToolOutputReader conversationId="conversation" reference={{ handle: 'process:handle', totalBytes: 9, nextCursor: 3 }} index={1} onCopy={onCopy} />)
  expect(readOutput).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.tools.fullOutput' })))
  expect(readOutput).toHaveBeenCalledWith({ conversationId: 'conversation', handle: 'process:handle', cursor: 0 })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.tools.nextOutputPage' })))
  expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable')
  expect(screen.getByText('first')).toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.tools.nextOutputPage' })))
  expect(screen.queryByText('first')).not.toBeInTheDocument()
  expect(screen.getByText('tail')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'chat.tools.nextOutputPage' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'chat.tools.copyOutputPage' }))
  expect(onCopy).toHaveBeenCalledWith('tail', 'tool')
})
