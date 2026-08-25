import { ipcMain, type BrowserWindow } from 'electron'
import { feedbackSubmitInputSchema } from '../../shared/feedback-contracts'
import { ipcChannels } from '../../shared/ipc-channels'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { FeedbackService } from './feedback-service'

export function registerFeedbackIpcHandler(
  window: BrowserWindow,
  feedbackService: Pick<FeedbackService, 'submit'>
): () => void {
  ipcMain.removeHandler(ipcChannels.feedbackSubmit)
  ipcMain.handle(
    ipcChannels.feedbackSubmit,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      return feedbackService.submit(
        feedbackSubmitInputSchema.parse(input)
      )
    }
  )
  return () => {
    ipcMain.removeHandler(ipcChannels.feedbackSubmit)
  }
}
