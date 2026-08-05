import type {
  ComputerControlError,
  ComputerControlErrorCode
} from '../../shared/computer-control-contracts'

export class ComputerControlFailure extends Error {
  readonly code: ComputerControlErrorCode
  readonly retryable: boolean

  constructor(
    code: ComputerControlErrorCode,
    message: string,
    retryable = false
  ) {
    super(message)
    this.name = 'ComputerControlFailure'
    this.code = code
    this.retryable = retryable
  }

  toContract(): ComputerControlError {
    return {
      code: this.code,
      message: this.message.slice(0, 256) || 'Computer control failed',
      retryable: this.retryable
    }
  }
}

export const cancellationFailure = (): ComputerControlFailure =>
  new ComputerControlFailure('cancelled', 'Computer control was cancelled')
