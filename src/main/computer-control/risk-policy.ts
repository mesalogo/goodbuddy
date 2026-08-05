import type {
  ComputerControlAction,
  ComputerControlElementRole,
  ComputerControlRisk
} from '../../shared/computer-control-contracts'
import type {
  ComputerControlTargetKind,
  DriverElement
} from './driver'

const RISK_ORDER: Record<ComputerControlRisk, number> = {
  observe: 0,
  navigate: 1,
  input: 2,
  commit: 3,
  forbidden: 4
}

const FORBIDDEN_TARGETS: ReadonlySet<ComputerControlTargetKind> =
  new Set([
    'protected',
    'password',
    'otp',
    'payment',
    'account_security',
    'privilege',
    'os_permission'
  ])

const activationRisk = (
  role: ComputerControlElementRole
): ComputerControlRisk => {
  switch (role) {
    case 'button':
    case 'checkbox':
    case 'radio':
      return 'commit'
    case 'textbox':
    case 'combobox':
    case 'scrollarea':
      return 'observe'
    default:
      return 'navigate'
  }
}

export const maximumRisk = (
  baseline: ComputerControlRisk,
  classification?: ComputerControlRisk
): ComputerControlRisk =>
  classification &&
  RISK_ORDER[classification] > RISK_ORDER[baseline]
    ? classification
    : baseline

export const classifyComputerControlAction = (
  action: ComputerControlAction,
  element: DriverElement,
  driverClassification?: ComputerControlRisk
): ComputerControlRisk => {
  if (FORBIDDEN_TARGETS.has(element.targetKind)) {
    return 'forbidden'
  }

  let baseline: ComputerControlRisk
  switch (action.kind) {
    case 'replace_text':
    case 'select_option':
      baseline = 'input'
      break
    case 'scroll':
      baseline = 'navigate'
      break
    case 'activate':
      baseline = activationRisk(element.role)
      break
  }
  return maximumRisk(baseline, driverClassification)
}
