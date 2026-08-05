import type {
  ComputerControlAction,
  ComputerControlElementRole
} from '../../shared/computer-control-contracts'

export const COMPUTER_CONTROL_DRIVER_DEADLINE_MS = 2_000

export type NativeElementIdentity = object

export type ComputerControlTargetKind =
  | 'standard'
  | 'protected'
  | 'password'
  | 'otp'
  | 'payment'
  | 'account_security'
  | 'privilege'
  | 'os_permission'

export type DriverWindowIdentity = {
  pid: number
  processStartTime: number
  windowIdentity: string
}

export type DriverElement = {
  nativeIdentity: NativeElementIdentity
  role: ComputerControlElementRole
  name: string
  enabled: boolean
  focused: boolean
  targetKind: ComputerControlTargetKind
}

export type DriverObservation = {
  window: DriverWindowIdentity
  windowTitle: string
  elements: DriverElement[]
}

export interface ComputerControlDriver {
  readonly available: boolean
  observe(signal: AbortSignal): Promise<DriverObservation>
  getForegroundWindow(signal: AbortSignal): Promise<DriverWindowIdentity>
  resolveElement(
    nativeIdentity: NativeElementIdentity,
    signal: AbortSignal
  ): Promise<DriverElement | undefined>
  focusElement(
    nativeIdentity: NativeElementIdentity,
    signal: AbortSignal
  ): Promise<boolean>
  inject(
    nativeIdentity: NativeElementIdentity,
    action: ComputerControlAction,
    signal: AbortSignal
  ): Promise<void>
  releaseInjectedInput(signal: AbortSignal): Promise<void>
}

export class UnavailableComputerControlDriver
  implements ComputerControlDriver
{
  readonly available = false

  async observe(): Promise<DriverObservation> {
    throw new Error('Computer control driver is unavailable')
  }

  async getForegroundWindow(): Promise<DriverWindowIdentity> {
    throw new Error('Computer control driver is unavailable')
  }

  async resolveElement(): Promise<DriverElement | undefined> {
    throw new Error('Computer control driver is unavailable')
  }

  async focusElement(): Promise<boolean> {
    throw new Error('Computer control driver is unavailable')
  }

  async inject(): Promise<void> {
    throw new Error('Computer control driver is unavailable')
  }

  async releaseInjectedInput(): Promise<void> {
    // There cannot be injected input when no driver exists.
  }
}
