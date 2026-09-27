import type { BrowserWindow, ipcMain } from 'electron'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  terminalAckRequestSchema,
  terminalCloseRequestSchema,
  terminalCreateRequestSchema,
  terminalResizeRequestSchema,
  terminalSnapshotRequestSchema,
  terminalWriteRequestSchema
} from '../../shared/terminal-contracts'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { TerminalSessionManager } from './terminal-session-manager'

export function registerTerminalIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  terminalSessionManager?: TerminalSessionManager
): void {
  const requireTerminalSessionManager = (): TerminalSessionManager => {
    if (!terminalSessionManager) {
      throw new Error('终端服务不可用')
    }
    return terminalSessionManager
  }

  registerHandler(
    ipcChannels.terminalCreate,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const manager = requireTerminalSessionManager()
      const snapshot = await manager.create(
        event.sender.id,
        terminalCreateRequestSchema.parse(input)
      )
      setImmediate(() => {
        if (
          !window.isDestroyed() &&
          event.sender === window.webContents &&
          !event.sender.isDestroyed()
        ) {
          manager.enableEventDelivery(
            event.sender.id,
            snapshot.sessionId
          )
        }
      })
      return snapshot
    }
  )

  registerHandler(ipcChannels.terminalWrite, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const manager = requireTerminalSessionManager()
    const request = terminalWriteRequestSchema.parse(input)
    manager.write(
      event.sender.id,
      request.sessionId,
      request.data
    )
  })

  registerHandler(ipcChannels.terminalResize, (event, input: unknown) => {
    assertTrustedSender(event, window)
    const manager = requireTerminalSessionManager()
    const request = terminalResizeRequestSchema.parse(input)
    manager.resize(event.sender.id, request.sessionId, {
      cols: request.cols,
      rows: request.rows
    })
  })

  registerHandler(
    ipcChannels.terminalSnapshot,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const manager = requireTerminalSessionManager()
      const request = terminalSnapshotRequestSchema.parse(input)
      return manager.snapshot(
        event.sender.id,
        request.sessionId
      )
    }
  )

  registerHandler(
    ipcChannels.terminalAck,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const manager = requireTerminalSessionManager()
      const request = terminalAckRequestSchema.parse(input)
      manager.acknowledge(
        event.sender.id,
        request.sessionId,
        request.sequence
      )
    }
  )

  registerHandler(
    ipcChannels.terminalClose,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const manager = requireTerminalSessionManager()
      const request = terminalCloseRequestSchema.parse(input)
      return manager.close(
        event.sender.id,
        request.sessionId
      )
    }
  )
}
